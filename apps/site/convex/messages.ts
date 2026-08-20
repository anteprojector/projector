import { v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
} from "./frameHistory";
import {
  githubActor,
  messageActorValidator,
  type MessageActor,
} from "./actors";
import { hashGuestSecret, isValidGuestSecret } from "./access";

type DbCtx = MutationCtx | QueryCtx;
type MessageDoc = Doc<"messages">;

const MAX_SESSION_MESSAGES = 2000;
// At the 250ms writer cadence this covers the full ten-minute action limit.
const MAX_STREAM_DELTAS = 4096;

const agentMessageValidator = v.object({
  id: v.id("messages"),
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
  actor: v.optional(messageActorValidator),
  createdAt: v.number(),
});

const agentMessagePageValidator = v.object({
  session: v.union(
    v.null(),
    v.object({
      id: v.id("sessions"),
      title: v.optional(v.string()),
      createdAt: v.number(),
    }),
  ),
  messages: v.union(v.null(), paginationResultValidator(agentMessageValidator)),
});

export type AddMessageArgs = {
  sessionId: Id<"sessions">;
  role: "user" | "assistant";
  content: string;
  actor?: MessageActor;
  clientMessageId?: string;
  frameId?: Id<"frames">;
  idempotencyKey?: string;
  streamState?: string;
  streamSeq?: number;
  widget?: string;
  card?: { title: string; source: string };
  updatedSurface?: boolean;
};

export const add = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    actor: v.optional(messageActorValidator),
    clientMessageId: v.optional(v.string()),
    frameId: v.optional(v.id("frames")),
    idempotencyKey: v.optional(v.string()),
    streamState: v.optional(v.string()),
    streamSeq: v.optional(v.number()),
    widget: v.optional(v.string()),
    card: v.optional(v.object({ title: v.string(), source: v.string() })),
    updatedSurface: v.optional(v.boolean()),
  },
  returns: v.id("messages"),
  handler: (ctx, args) => addMessageInternal(ctx, args),
});

export const appendStreamDelta = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    messageKey: v.string(),
    text: v.string(),
    streamSeq: v.number(),
  },
  returns: v.id("messages"),
  handler: async (ctx, { sessionId, messageKey, text, streamSeq }) => {
    const existingIndex = await ctx.db
      .query("messageIndex")
      .withIndex("by_session_idempotency_key", (q) =>
        q.eq("sessionId", sessionId).eq("idempotencyKey", messageKey),
      )
      .first();
    const existing = existingIndex ? await ctx.db.get(existingIndex.messageId) : null;
    if (existing && existing.streamState !== "streaming") return existing._id;
    const messageId = existing
      ? existing._id
      : await addMessageInternal(ctx, {
          sessionId,
          role: "assistant",
          content: "",
          idempotencyKey: messageKey,
          streamState: "streaming",
          // The durable message's sequence guard only needs the initial value;
          // delta ordering is guarded by the append-only delta index below.
          streamSeq: 0,
        });
    if (!text) return messageId;

    const latest = await ctx.db
      .query("messageStreamDeltas")
      .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", messageId))
      .order("desc")
      .first();
    if (latest && latest.streamSeq >= streamSeq) return messageId;

    await ctx.db.insert("messageStreamDeltas", {
      messageId,
      streamSeq,
      text,
    });
    return messageId;
  },
});

export const markStreamFailed = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    messageKey: v.string(),
    state: v.union(v.literal("cancelled"), v.literal("error")),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, messageKey, state }) => {
    const index = await ctx.db
      .query("messageIndex")
      .withIndex("by_session_idempotency_key", (q) =>
        q.eq("sessionId", sessionId).eq("idempotencyKey", messageKey),
      )
      .first();
    if (!index) return null;
    const message = await ctx.db.get(index.messageId);
    if (message?.streamState === "streaming") {
      const deltas = await ctx.db
        .query("messageStreamDeltas")
        .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", message._id))
        .order("asc")
        .take(MAX_STREAM_DELTAS);
      await ctx.db.patch(message._id, {
        content: message.content + deltas.map((delta) => delta.text).join(""),
        streamState: state,
      });
      await Promise.all(deltas.map((delta) => ctx.db.delete(delta._id)));
    }
    return null;
  },
});

// Shared by the agent action (via the mutation) and sendCommand (directly):
// idempotent, stream-seq-guarded message upsert.
export async function addMessageInternal(
  ctx: MutationCtx,
  args: AddMessageArgs,
): Promise<Id<"messages">> {
  {
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
        if (args.updatedSurface !== undefined) patch.updatedSurface = args.updatedSurface;
        if (args.widget !== undefined) patch.widget = args.widget;
        if (args.card !== undefined) patch.card = args.card;
        if (args.actor !== undefined) patch.actor = args.actor;
        if (args.clientMessageId !== undefined) patch.clientMessageId = args.clientMessageId;
        await ctx.db.patch(existing._id, patch);
        if (args.streamState === "complete") {
          const deltas = await ctx.db
            .query("messageStreamDeltas")
            .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", existing._id))
            .take(MAX_STREAM_DELTAS);
          await Promise.all(deltas.map((delta) => ctx.db.delete(delta._id)));
        }
        await setDefaultSessionTitle(ctx, session, args.role, args.content);
        return existing._id;
      }
    }

    const messageId = await ctx.db.insert("messages", {
      role: args.role,
      content: args.content,
      frameId,
      ...(args.actor !== undefined ? { actor: args.actor } : {}),
      ...(args.clientMessageId !== undefined
        ? { clientMessageId: args.clientMessageId }
        : {}),
      ...(args.widget !== undefined ? { widget: args.widget } : {}),
      ...(args.card !== undefined ? { card: args.card } : {}),
      ...(args.updatedSurface !== undefined ? { updatedSurface: args.updatedSurface } : {}),
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
    await setDefaultSessionTitle(ctx, session, args.role, args.content);

    return messageId;
  }
}

async function setDefaultSessionTitle(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  role: "user" | "assistant",
  content: string,
): Promise<void> {
  if (role !== "user" || session.title) return;
  const title = content.trim().slice(0, 80);
  if (title) await ctx.db.patch(session._id, { title });
}

export const list = query({
  args: {
    sessionId: v.id("sessions"),
    guestSecret: v.optional(v.string()),
  },
  returns: v.object({
    viewerActorIds: v.array(v.string()),
    messages: v.array(
      v.object({
        id: v.id("messages"),
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
        actor: v.optional(messageActorValidator),
        clientMessageId: v.optional(v.string()),
        createdAt: v.number(),
        activationId: v.optional(v.string()),
        streamState: v.optional(v.string()),
        widget: v.optional(v.string()),
        card: v.optional(v.object({ title: v.string(), source: v.string() })),
        updatedSurface: v.optional(v.boolean()),
      }),
    ),
  }),
  handler: async (ctx, { sessionId, guestSecret }) => {
    const messages = await listMessagesForSession(ctx, sessionId);
    const session = await ctx.db.get(sessionId);
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get(userId) : null;
    const viewerActorIds = user ? [githubActor(user).id] : [];
    const ownsAnonymousActor =
      session !== null &&
      ((userId !== null && session.ownerUserId === userId) ||
        (guestSecret !== undefined &&
          isValidGuestSecret(guestSecret) &&
          session.guestSecretHash !== undefined &&
          (await hashGuestSecret(guestSecret)) === session.guestSecretHash));
    if (ownsAnonymousActor) {
      viewerActorIds.push(`anonymous:${sessionId}`);
    }
    const liveContent = new Map(
      await Promise.all(
        messages
          .filter((message) => message.streamState === "streaming")
          .map(async (message) => {
            const deltas = await ctx.db
              .query("messageStreamDeltas")
              .withIndex("by_message_and_stream_seq", (q) => q.eq("messageId", message._id))
              .order("asc")
              .take(MAX_STREAM_DELTAS);
            return [
              message._id,
              message.content + deltas.map((delta) => delta.text).join(""),
            ] as const;
          }),
      ),
    );
    const frameIds = [
      ...new Set(
        messages.flatMap((message) => (message.frameId ? [message.frameId] : [])),
      ),
    ];
    const frames = await Promise.all(frameIds.map((frameId) => ctx.db.get(frameId)));
    const activationByFrameId = new Map(
      frames
        .filter((frame) => frame !== null)
        .map((frame) => [frame._id, frame.activationId] as const),
    );
    return {
      viewerActorIds,
      messages: messages.map((message) => {
        const activationId = message.frameId
          ? activationByFrameId.get(message.frameId)
          : undefined;
        return {
          id: message._id,
          role: message.role,
          content: liveContent.get(message._id) ?? message.content,
          ...(message.actor !== undefined ? { actor: message.actor } : {}),
          ...(message.clientMessageId !== undefined
            ? { clientMessageId: message.clientMessageId }
            : {}),
          createdAt: message.createdAt,
          ...(activationId !== undefined ? { activationId } : {}),
          ...(message.streamState !== undefined ? { streamState: message.streamState } : {}),
          ...(message.widget !== undefined ? { widget: message.widget } : {}),
          ...(message.card !== undefined ? { card: message.card } : {}),
          ...(message.updatedSurface !== undefined
            ? { updatedSurface: message.updatedSurface }
            : {}),
        };
      }),
    };
  },
});

// Agent-only reader for a public transcript. Deliberately requires a known
// session id: there is no session discovery or text-search surface here.
export const pageForAgent = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    paginationOpts: paginationOptsValidator,
  },
  returns: agentMessagePageValidator,
  handler: async (ctx, { sessionId, paginationOpts }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return { session: null, messages: null };

    const indexPage = await ctx.db
      .query("messageIndex")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .order("asc")
      .paginate(paginationOpts);
    const messageDocs = await Promise.all(
      indexPage.page.map((row) => ctx.db.get(row.messageId)),
    );
    const page = messageDocs
      .filter((message): message is MessageDoc => message !== null)
      .map((message) => ({
        id: message._id,
        role: message.role,
        content: message.content,
        ...(message.actor !== undefined ? { actor: message.actor } : {}),
        createdAt: message.createdAt,
      }));

    return {
      session: {
        id: session._id,
        ...(session.title !== undefined ? { title: session.title } : {}),
        createdAt: session._creationTime,
      },
      messages: { ...indexPage, page },
    };
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
  // The index query provides the authoritative insertion order. Reverse the
  // newest-first bounded page instead of re-sorting by millisecond timestamps,
  // which can collide when multiple clients send together.
  return messages.reverse().filter((message): message is MessageDoc => message !== null);
}
