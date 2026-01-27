import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Agent Watchdog Mutations
 * ========================
 *
 * Database operations for the agent watchdog system.
 * Separated from the action file because actions require "use node".
 */

/**
 * Update agent heartbeat - only advances timestamp (ignores stale updates)
 */
export const updateHeartbeat = internalMutation({
  args: {
    roomName: v.string(),
    jobId: v.string(),
    agentIdentity: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, { roomName, jobId, agentIdentity, timestamp }) => {
    const room = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!room) {
      console.log(`[Heartbeat] Room ${roomName} not found`);
      return { success: false, reason: "room_not_found" };
    }

    // Only advance timestamp (ignore stale heartbeats)
    if (room.lastHeartbeatAt && timestamp <= room.lastHeartbeatAt) {
      return { success: false, reason: "stale_heartbeat" };
    }

    await ctx.db.patch(room._id, {
      lastHeartbeatAt: timestamp,
      lastAgentIdentity: agentIdentity,
      lastAgentJobId: jobId,
    });

    return { success: true };
  },
});

/**
 * Clear heartbeat on graceful shutdown
 */
export const clearHeartbeat = internalMutation({
  args: {
    roomName: v.string(),
    jobId: v.string(),
  },
  handler: async (ctx, { roomName, jobId }) => {
    const room = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!room) {
      return { success: false, reason: "room_not_found" };
    }

    // Only clear if this is the current agent
    if (room.lastAgentJobId !== jobId) {
      return { success: false, reason: "job_mismatch" };
    }

    await ctx.db.patch(room._id, {
      lastHeartbeatAt: undefined,
      lastAgentIdentity: undefined,
      lastAgentJobId: undefined,
    });

    return { success: true };
  },
});

/**
 * Update user connected timestamp
 */
export const updateUserConnected = internalMutation({
  args: {
    roomName: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, { roomName, timestamp }) => {
    const room = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!room) {
      return { success: false, reason: "room_not_found" };
    }

    await ctx.db.patch(room._id, {
      lastUserConnectedAt: timestamp,
    });

    return { success: true };
  },
});

/**
 * Get active rooms that may need agent dispatch
 * Returns rooms where user has connected recently or heartbeat is stale
 */
export const getActiveRooms = internalQuery({
  args: {
    staleThreshold: v.number(),
  },
  handler: async (ctx, { staleThreshold }) => {
    const rooms = await ctx.db.query("voiceRooms").collect();

    // Filter to rooms that:
    // 1. Have had user activity in the last hour, AND
    // 2. Have stale or missing heartbeat
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    return rooms.filter((room) => {
      // Must have recent user activity
      const hasRecentUser = room.lastUserConnectedAt && room.lastUserConnectedAt > oneHourAgo;
      if (!hasRecentUser) return false;

      // Check if heartbeat is stale
      const isStale = !room.lastHeartbeatAt || room.lastHeartbeatAt < staleThreshold;
      return isStale;
    });
  },
});

/**
 * Try to acquire a dispatch lease (prevents duplicate dispatches)
 */
export const tryAcquireLease = internalMutation({
  args: {
    roomName: v.string(),
    leaseToken: v.string(),
    expiresAt: v.number(),
    now: v.number(),
  },
  handler: async (ctx, { roomName, leaseToken, expiresAt, now }) => {
    const room = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!room) {
      return false;
    }

    // Check if existing lease is still valid
    if (room.dispatchLeaseExpiresAt && room.dispatchLeaseExpiresAt > now) {
      return false;
    }

    // Acquire lease
    await ctx.db.patch(room._id, {
      dispatchLeaseToken: leaseToken,
      dispatchLeaseExpiresAt: expiresAt,
    });

    return true;
  },
});

/**
 * Record a dispatch attempt
 */
export const recordDispatch = internalMutation({
  args: {
    roomName: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, { roomName, timestamp }) => {
    const room = await ctx.db
      .query("voiceRooms")
      .withIndex("by_room", (q) => q.eq("roomName", roomName))
      .first();

    if (!room) {
      return { success: false };
    }

    await ctx.db.patch(room._id, {
      lastDispatchAt: timestamp,
      // Clear lease after dispatch
      dispatchLeaseToken: undefined,
      dispatchLeaseExpiresAt: undefined,
    });

    return { success: true };
  },
});
