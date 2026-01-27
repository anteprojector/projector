"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { RoomServiceClient, AgentDispatchClient } from "livekit-server-sdk";

/**
 * Agent Watchdog System
 * =====================
 *
 * Ensures exactly one agent is present in each active voice room.
 *
 * Components:
 * 1. Heartbeat - Agent reports liveness every 10s
 * 2. Watchdog - Scheduled job checks for stale agents and redispatches
 * 3. Dispatch - Explicit agent dispatch via LiveKit Server SDK
 */

const AGENT_NAME = "demo-agent";
const HEARTBEAT_STALE_MS = 30_000; // 30 seconds without heartbeat = stale
const DISPATCH_COOLDOWN_MS = 60_000; // Don't redispatch within 60s of last dispatch
const DISPATCH_LEASE_MS = 30_000; // Lease duration for dispatch lock

function getLiveKitClients() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) {
    throw new Error("LiveKit environment variables not configured");
  }

  // Convert wss:// to https:// for the API
  const httpUrl = url.replace("wss://", "https://").replace("ws://", "http://");

  return {
    roomService: new RoomServiceClient(httpUrl, apiKey, apiSecret),
    agentDispatch: new AgentDispatchClient(httpUrl, apiKey, apiSecret),
  };
}

/**
 * Agent heartbeat - called by agent every ~10 seconds
 */
export const heartbeat = action({
  args: {
    roomName: v.string(),
    jobId: v.string(),
    agentIdentity: v.string(),
  },
  handler: async (ctx, { roomName, jobId, agentIdentity }) => {
    await ctx.runMutation(internal.agentWatchdogMutations.updateHeartbeat, {
      roomName,
      jobId,
      agentIdentity,
      timestamp: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Mark agent as offline (best-effort on shutdown)
 */
export const markOffline = action({
  args: {
    roomName: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, { roomName, jobId }) => {
    await ctx.runMutation(internal.agentWatchdogMutations.clearHeartbeat, {
      roomName,
      jobId,
    });
    return { success: true };
  },
});

/**
 * User connected - update lastUserConnectedAt
 */
export const userConnected = action({
  args: {
    roomName: v.string(),
  },
  handler: async (ctx, { roomName }) => {
    await ctx.runMutation(internal.agentWatchdogMutations.updateUserConnected, {
      roomName,
      timestamp: Date.now(),
    });
    return { success: true };
  },
});

/**
 * Watchdog check - runs on a schedule to ensure agents are present
 */
export const runWatchdog = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Get all active voice rooms
    const rooms = await ctx.runQuery(internal.agentWatchdogMutations.getActiveRooms, {
      staleThreshold: now - HEARTBEAT_STALE_MS,
    });

    console.log(`[Watchdog] Checking ${rooms.length} rooms`);

    for (const room of rooms) {
      try {
        await checkAndDispatchAgent(ctx, room, now);
      } catch (error) {
        console.error(`[Watchdog] Error checking room ${room.roomName}:`, error);
      }
    }
  },
});

async function checkAndDispatchAgent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  room: {
    _id: string;
    roomName: string;
    lastHeartbeatAt?: number;
    lastDispatchAt?: number;
    dispatchLeaseExpiresAt?: number;
  },
  now: number
) {
  const { roomService, agentDispatch } = getLiveKitClients();

  // Check if heartbeat is stale
  const isHeartbeatStale =
    !room.lastHeartbeatAt || now - room.lastHeartbeatAt > HEARTBEAT_STALE_MS;

  if (!isHeartbeatStale) {
    console.log(`[Watchdog] Room ${room.roomName}: heartbeat fresh, skipping`);
    return;
  }

  console.log(`[Watchdog] Room ${room.roomName}: heartbeat stale, checking LiveKit`);

  // Check LiveKit for actual agent presence
  let hasAgent = false;
  let agentCount = 0;

  try {
    const participants = await roomService.listParticipants(room.roomName);
    for (const p of participants) {
      // Check if participant is an agent (identity starts with "agent-" or kind is AGENT)
      if (p.identity?.startsWith("agent-") || p.kind === 1) {
        agentCount++;
        hasAgent = true;
      }
    }
  } catch (error: unknown) {
    // Room might not exist yet in LiveKit
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.includes("not found")) {
      console.error(`[Watchdog] Error listing participants for ${room.roomName}:`, error);
      return;
    }
    console.log(`[Watchdog] Room ${room.roomName} not found in LiveKit`);
  }

  if (hasAgent) {
    console.log(`[Watchdog] Room ${room.roomName}: ${agentCount} agent(s) present in LiveKit`);

    // If more than one agent, we might want to remove extras (optional)
    if (agentCount > 1) {
      console.warn(`[Watchdog] Room ${room.roomName}: multiple agents detected (${agentCount})`);
    }
    return;
  }

  // No agent in room - check dispatch cooldown
  if (room.lastDispatchAt && now - room.lastDispatchAt < DISPATCH_COOLDOWN_MS) {
    console.log(
      `[Watchdog] Room ${room.roomName}: dispatch cooldown active (${Math.round((DISPATCH_COOLDOWN_MS - (now - room.lastDispatchAt)) / 1000)}s remaining)`
    );
    return;
  }

  // Try to acquire dispatch lease
  const leaseToken = crypto.randomUUID();
  const gotLease = await ctx.runMutation(internal.agentWatchdogMutations.tryAcquireLease, {
    roomName: room.roomName,
    leaseToken,
    expiresAt: now + DISPATCH_LEASE_MS,
    now,
  });

  if (!gotLease) {
    console.log(`[Watchdog] Room ${room.roomName}: couldn't acquire lease, another process is handling`);
    return;
  }

  console.log(`[Watchdog] Room ${room.roomName}: dispatching new agent`);

  try {
    // Dispatch agent to the room
    await agentDispatch.createDispatch(room.roomName, AGENT_NAME, {
      metadata: JSON.stringify({
        reason: "watchdog_stale_heartbeat",
        dispatchedAt: now,
      }),
    });

    // Record dispatch
    await ctx.runMutation(internal.agentWatchdogMutations.recordDispatch, {
      roomName: room.roomName,
      timestamp: now,
    });

    console.log(`[Watchdog] Room ${room.roomName}: agent dispatched successfully`);
  } catch (error) {
    console.error(`[Watchdog] Failed to dispatch agent to ${room.roomName}:`, error);
  }
}

/**
 * Force dispatch an agent to a room (can be called from frontend or manually)
 */
export const forceDispatch = action({
  args: {
    roomName: v.string(),
  },
  handler: async (ctx, { roomName }) => {
    const { agentDispatch } = getLiveKitClients();

    try {
      await agentDispatch.createDispatch(roomName, AGENT_NAME, {
        metadata: JSON.stringify({
          reason: "manual_dispatch",
          dispatchedAt: Date.now(),
        }),
      });

      await ctx.runMutation(internal.agentWatchdogMutations.recordDispatch, {
        roomName,
        timestamp: Date.now(),
      });

      return { success: true };
    } catch (error) {
      console.error(`[ForceDispatch] Failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },
});
