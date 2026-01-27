"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";

const AGENT_NAME = "demo-agent";

/**
 * Voice Mode Actions (Node.js Runtime)
 * =====================================
 *
 * Actions that require Node.js APIs (like livekit-server-sdk).
 */

// Token generation for frontend to join LiveKit room
export const getToken = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }): Promise<{ token: string; url: string; room: string }> => {
    // Verify session exists
    const session = await ctx.runQuery(internal.livekitAgent.getSession, { sessionId });
    if (!session) {
      throw new Error("Invalid session");
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const url = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !url) {
      throw new Error("LiveKit environment variables not configured");
    }

    const roomName = `voice-${sessionId}`;
    const identity = `user-${sessionId}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "15m",
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    // Track the voice room
    await ctx.runMutation(internal.livekitAgent.upsertVoiceRoom, {
      sessionId,
      roomName,
    });

    // Update user connected timestamp for watchdog
    await ctx.runMutation(internal.agentWatchdogMutations.updateUserConnected, {
      roomName,
      timestamp: Date.now(),
    });

    // Dispatch agent to the room (idempotent - agent will only join if not already present)
    try {
      const httpUrl = url.replace("wss://", "https://").replace("ws://", "http://");
      const agentDispatch = new AgentDispatchClient(httpUrl, apiKey, apiSecret);
      
      await agentDispatch.createDispatch(roomName, AGENT_NAME, {
        metadata: JSON.stringify({
          reason: "user_token_request",
          sessionId,
          dispatchedAt: Date.now(),
        }),
      });
      console.log(`[getToken] Dispatched agent to room ${roomName}`);
    } catch (error) {
      // Log but don't fail - watchdog will dispatch if needed
      console.error(`[getToken] Failed to dispatch agent:`, error);
    }

    return {
      token: await at.toJwt(),
      url,
      room: roomName,
    };
  },
});
