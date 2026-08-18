import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
} from "./frameHistory";

type DbCtx = MutationCtx | QueryCtx;
type MessageDoc = Doc<"messages">;

const MAX_SESSION_MESSAGES = 2000;

export const add = mutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    frameId: v.optional(v.id("frames")),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.string()),
    streamSeq: v.optional(v.number()),
    widget: v.optional(v.string()),
  },
  returns: v.id("messages"),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session not found");

    const latestFrame = await getLatestSessionFrameDoc(ctx, args.sessionId);
    const frameId = args.frameId ?? latestFrame?._id;
    if (!frameId) throw new Error("Session has no frames");
    const frameIndex = await getFrameIndexForSession(ctx, args.sessionId, frameId);
    if (!frameIndex) throw new Error("Message frame is not indexed for session");

    if (args.idempotencyKey) {
      const existingIndex = await ctx.db
        .query("messageIndex")
        .withIndex("by_session_idempotency_key", (q) =>
          q.eq("sessionId", args.sessionId).eq("idempotencyKey", args.idempotencyKey),
        )
        .first();
      const existing = existingIndex ? await ctx.db.get(existingIndex.messageId) : null;

      if (existing) {
        const existingSeq = typeof existing.streamSeq === "number" ? existing.streamSeq : -1;
        const nextSeq = typeof args.streamSeq === "number" ? args.streamSeq : existingSeq;
        if (nextSeq < existingSeq) {
          return existing._id;
        }

        const patch: Partial<MessageDoc> = {
          content: args.content,
          frameId,
        };
        if (args.streamState !== undefined) patch.streamState = args.streamState;
        if (args.streamSeq !== undefined) patch.streamSeq = args.streamSeq;
        await ctx.db.patch(existing._id, patch);
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      role: args.role,
      content: args.content,
      frameId,
      ...(args.widget !== undefined ? { widget: args.widget } : {}),
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      ...(args.streamState !== undefined ? { streamState: args.streamState } : {}),
      ...(args.streamSeq !== undefined ? { streamSeq: args.streamSeq } : {}),
      createdAt: Date.now(),
    });
    await ctx.db.insert("messageIndex", {
      sessionId: args.sessionId,
      messageId,
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    });

    return messageId;
  },
});

export const list = query({
  args: { sessionId: v.id("sessions") },
  returns: v.array(
    v.object({
      id: v.id("messages"),
      role: v.union(v.literal("user"), v.literal("assistant")),
      content: v.string(),
      createdAt: v.number(),
      streamState: v.optional(v.string()),
      widget: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const messages = await listMessagesForSession(ctx, sessionId);
    return messages.map((message) => ({
      id: message._id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      ...(message.streamState !== undefined ? { streamState: message.streamState } : {}),
      ...(message.widget !== undefined ? { widget: message.widget } : {}),
    }));
  },
});

export async function listMessagesForSession(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<MessageDoc[]> {
  const rows = await ctx.db
    .query("messageIndex")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(MAX_SESSION_MESSAGES);
  const messages = await Promise.all(rows.map((row) => ctx.db.get(row.messageId)));
  return messages
    .filter((message): message is MessageDoc => message !== null)
    .sort((a, b) => a.createdAt - b.createdAt || a._id.localeCompare(b._id));
}
