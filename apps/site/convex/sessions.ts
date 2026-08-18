import { v } from "convex/values";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyInstanceMessage,
  createMachine,
  executeCommand,
  runMachine,
  type Frame,
  type FrameDraft,
  type Instance,
  type InstanceMessage,
  type SerializedInstance,
} from "@projectors/core";
import {
  recordCommandResidue,
  type ClientMachineMessage,
  type MachineSyncState,
} from "@projectors/core/client";
import {
  createInitialSerializedInstance,
  createSiteClientSnapshot,
  hydrateSiteInstance,
  hydrateSourceInstance,
  serializeSourceInstance,
  siteCharter,
} from "../src/agent/charter";
import { escapeConvexJson, restoreConvexJson, stripClientSchemas } from "./convexJson";
import {
  getFrameIndexForSession,
  getLatestSessionFrameDoc,
  listSessionContextFrameDocs,
  listSessionFrameDocs,
  restoreFrame,
} from "./frameHistory";

type DbCtx = MutationCtx | QueryCtx;
type SessionDoc = Doc<"sessions">;

const MAX_INSTANCE_LOGS = 2000;

export const create = mutation({
  args: {},
  returns: v.id("sessions"),
  handler: async (ctx) => {
    const now = Date.now();
    const instance = createInitialSerializedInstance();
    const syncState = createEmptySyncState();
    const sessionId = await ctx.db.insert("sessions", {
      contextEpoch: 0,
      syncState: escapeConvexJson(syncState),
    });

    const frameId = await ctx.db.insert("frames", {
      metadata: escapeConvexJson({ type: "init" }),
      messages: [],
      createdAt: now,
    });
    await ctx.db.insert("frameIndex", {
      sessionId,
      frameId,
      contextEpoch: 0,
    });

    await ctx.db.insert("projectorInstanceLog", {
      sessionId,
      instanceId: instance.id,
      frameId,
      message: escapeConvexJson({ type: "init" }),
      instance: escapeConvexJson(instance),
      createdAt: now,
    });

    return sessionId;
  },
});

export const get = query({
  args: { sessionId: v.id("sessions") },
  returns: v.object({
    sessionId: v.id("sessions"),
    frameId: v.id("frames"),
    clientSnapshot: v.any(),
    syncState: v.any(),
  }),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) throw new Error("Session not found");

    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) throw new Error("Session has no frames");

    const latestInstance = await getLatestSerializedSource(ctx, sessionId);
    if (!latestInstance) throw new Error("Session has no instance snapshot");

    const syncState = restoreSyncState(session.syncState);
    const clientSnapshot = stripClientSchemas(
      createSiteClientSnapshot(latestInstance, syncState),
    );

    return {
      sessionId,
      frameId: latestFrame._id,
      clientSnapshot,
      syncState,
    };
  },
});

export const getForAction = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      sessionId: v.id("sessions"),
      frameId: v.id("frames"),
      instance: v.any(),
      syncState: v.any(),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;

    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) return null;

    const instance = await getLatestSerializedSource(ctx, sessionId);
    if (!instance) return null;

    return {
      sessionId,
      frameId: latestFrame._id,
      instance,
      syncState: restoreSyncState(session.syncState),
    };
  },
});

export const listMachineContextFrames = query({
  args: { sessionId: v.id("sessions") },
  returns: v.array(v.any()),
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return [];
    return await getMachineContextFrames(ctx, session);
  },
});

export const listFrames = query({
  args: { sessionId: v.id("sessions") },
  returns: v.array(
    v.object({
      id: v.string(),
      createdAt: v.number(),
      generatorId: v.optional(v.string()),
      messages: v.array(v.any()),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    const frames = await listSessionFrameDocs(ctx, sessionId);
    return frames.map((frame) => {
      const restored = restoreFrame(frame);
      return {
        id: restored.id,
        createdAt: restored.createdAt,
        ...(restored.generatorId !== undefined ? { generatorId: restored.generatorId } : {}),
        messages: stripClientSchemas(restored.messages),
      };
    });
  },
});

export const appendMachineFrameSequence = mutation({
  args: {
    sessionId: v.id("sessions"),
    referenceFrameId: v.optional(v.id("frames")),
    frames: v.array(v.any()),
  },
  returns: v.array(v.id("frames")),
  handler: async (ctx, { sessionId, referenceFrameId, frames }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    return await appendMachineFrameSequenceInternal(ctx, {
      sessionId,
      session,
      referenceFrameId,
      frames: restoreConvexJson(frames) as Frame[],
    });
  },
});

// Client-issued commands (e.g. the pane toggles) run against the same machine
// the executor runs, in a transaction: execute the command, drain the frames
// it produced (scheduleWork: false — a UI command must never wake the model),
// and append them to the durable log, which also folds any state.update
// messages into the instance snapshot. No model call anywhere in the path.
export const sendCommand = mutation({
  args: {
    sessionId: v.id("sessions"),
    message: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, { sessionId, message }) => {
    const session = await getSessionOrThrow(ctx, sessionId);
    const latestFrame = await getLatestSessionFrameDoc(ctx, sessionId);
    if (!latestFrame) throw new Error("Session has no frames");
    const serialized = await getLatestSerializedSource(ctx, sessionId);
    if (!serialized) throw new Error("Session has no instance snapshot");

    const machine = createMachine({
      id: sessionId,
      instance: hydrateSiteInstance(serialized, sessionId),
      charter: siteCharter,
      frames: await getMachineContextFrames(ctx, session),
    });
    await executeCommand(machine, restoreConvexJson(message) as ClientMachineMessage);

    const produced: Frame[] = [];
    for await (const frame of runMachine(machine, { scheduleWork: false })) {
      produced.push(frame);
    }
    if (produced.length > 0) {
      await appendMachineFrameSequenceInternal(ctx, {
        sessionId,
        session,
        referenceFrameId: latestFrame._id,
        frames: produced,
      });
    }
    return null;
  },
});

async function getSessionOrThrow(ctx: MutationCtx, sessionId: Id<"sessions">) {
  const session = await ctx.db.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  return session;
}

export async function appendMachineFrameInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    frame,
    referenceFrameId,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    frame: (FrameDraft | Frame) & { metadata?: Record<string, unknown> };
    referenceFrameId?: Id<"frames">;
  },
) {
  const effectiveReferenceFrameId =
    referenceFrameId ?? (await getLatestSessionFrameDoc(ctx, sessionId))?._id;
  if (
    effectiveReferenceFrameId &&
    !(await getFrameIndexForSession(ctx, sessionId, effectiveReferenceFrameId))
  ) {
    throw new Error("Reference frame is not indexed for session");
  }

  const metadata =
    "id" in frame && typeof frame.id === "string"
      ? { ...(frame.metadata ?? {}), projectorFrameId: frame.id }
      : frame.metadata;
  const frameId = await ctx.db.insert("frames", {
    ...(effectiveReferenceFrameId !== undefined
      ? { referenceFrameId: effectiveReferenceFrameId }
      : {}),
    ...(frame.generatorId !== undefined ? { generatorId: frame.generatorId } : {}),
    ...(frame.activationId !== undefined ? { activationId: frame.activationId } : {}),
    ...(frame.inert !== undefined ? { inert: frame.inert } : {}),
    ...(metadata !== undefined ? { metadata: escapeConvexJson(metadata) } : {}),
    ...(frame.provenance !== undefined
      ? { provenance: escapeConvexJson(frame.provenance) }
      : {}),
    messages: escapeConvexJson(frame.messages),
    createdAt: Date.now(),
  });
  await ctx.db.insert("frameIndex", {
    sessionId,
    frameId,
    contextEpoch: session.contextEpoch,
  });
  await applyFrameInstanceMessages(ctx, sessionId, frameId, frame.messages);
  await recordFrameCommandResidue(ctx, sessionId, frame.messages);
  return frameId;
}

async function appendMachineFrameSequenceInternal(
  ctx: MutationCtx,
  {
    sessionId,
    session,
    referenceFrameId,
    frames,
  }: {
    sessionId: Id<"sessions">;
    session: SessionDoc;
    referenceFrameId?: Id<"frames">;
    frames: Frame[];
  },
) {
  const frameIds: Id<"frames">[] = [];
  let currentReferenceFrameId = referenceFrameId;

  for (const frame of frames) {
    const frameId = await appendMachineFrameInternal(ctx, {
      sessionId,
      session,
      referenceFrameId: currentReferenceFrameId,
      frame,
    });
    frameIds.push(frameId);
    currentReferenceFrameId = frameId;
  }

  return frameIds;
}

async function applyFrameInstanceMessages(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
  messages: Frame["messages"],
): Promise<void> {
  for (const message of messages) {
    if (!isInstanceMessage(message)) continue;
    await applyFrameInstanceMessage(ctx, sessionId, frameId, message);
  }
}

async function applyFrameInstanceMessage(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  frameId: Id<"frames">,
  message: InstanceMessage,
): Promise<void> {
  const targetInstanceId = instanceMessageTargetId(message);
  const source = await getLatestSourceForInstanceMessage(
    ctx,
    sessionId,
    message,
    targetInstanceId,
  );
  if (!source) {
    throw new Error(`No source instance contains target instance "${targetInstanceId}"`);
  }

  applyInstanceMessage(source, message, siteCharter);

  await ctx.db.insert("projectorInstanceLog", {
    sessionId,
    instanceId: source.id,
    frameId,
    message: escapeConvexJson(message),
    instance: escapeConvexJson(serializeSourceInstance(source)),
    createdAt: Date.now(),
  });
}

function instanceMessageTargetId(message: InstanceMessage): string {
  if (message.kind === "spawn" || message.kind === "attach") {
    return message.parentInstanceId;
  }
  return message.instanceId;
}

async function getLatestSourceForInstanceMessage(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  message: InstanceMessage,
  targetInstanceId: string,
) {
  const source = await getLatestSourceContainingInstance(ctx, sessionId, targetInstanceId);
  if (source || message.kind !== "remove") {
    return source;
  }

  return await getLatestSource(ctx, sessionId);
}

function isInstanceMessage(message: unknown): message is InstanceMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.type === "instance" &&
    (record.kind === "state.update" ||
      record.kind === "transition" ||
      record.kind === "spawn" ||
      record.kind === "attach" ||
      record.kind === "remove");
}

async function getLatestSourceContainingInstance(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
  targetInstanceId: string,
): Promise<Instance | null> {
  const latestLogs = await getLatestSourceLogs(ctx, sessionId);
  for (const log of latestLogs) {
    const source = hydrateSourceInstance(restoreConvexJson(log.instance) as SerializedInstance);
    if (containsInstance(source, targetInstanceId)) {
      return source;
    }
  }
  return null;
}

async function getLatestSource(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<Instance | null> {
  const [latestLog] = await getLatestSourceLogs(ctx, sessionId);
  return latestLog
    ? hydrateSourceInstance(restoreConvexJson(latestLog.instance) as SerializedInstance)
    : null;
}

async function getLatestSerializedSource(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<SerializedInstance | null> {
  const [latestLog] = await getLatestSourceLogs(ctx, sessionId);
  return latestLog
    ? (restoreConvexJson(latestLog.instance) as SerializedInstance)
    : null;
}

async function getLatestSourceLogs(ctx: DbCtx, sessionId: Id<"sessions">) {
  const logs = await ctx.db
    .query("projectorInstanceLog")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .take(MAX_INSTANCE_LOGS);
  const latestByInstance = new Map<string, Doc<"projectorInstanceLog">>();
  for (const log of logs.sort(compareLogAsc)) {
    latestByInstance.set(log.instanceId, log);
  }
  return [...latestByInstance.values()].sort(compareLogDesc);
}

function containsInstance(instance: Instance, targetInstanceId: string): boolean {
  if (instance.id === targetInstanceId) return true;
  return (instance.children ?? []).some((child) => containsInstance(child, targetInstanceId));
}

async function getMachineContextFrames(ctx: DbCtx, session: SessionDoc): Promise<Frame[]> {
  return (await listSessionContextFrameDocs(ctx, session)).map(restoreFrame) as Frame[];
}

async function recordFrameCommandResidue(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  messages: readonly FrameDraft["messages"][number][],
): Promise<void> {
  const callIds = messages
    .filter(
      (message) =>
        message.type === "action" &&
        message.kind === "result" &&
        message.action === "command" &&
        typeof message.callId === "string" &&
        message.callId.length > 0,
    )
    .map((message) => message.callId as string);
  if (callIds.length === 0) return;

  const session = await ctx.db.get(sessionId);
  if (!session) return;

  const nextSyncState = callIds.reduce(
    (state, callId) => recordCommandResidue(state, callId, { limit: 20 }),
    restoreSyncState(session.syncState),
  );
  await ctx.db.patch(sessionId, {
    syncState: escapeConvexJson(nextSyncState),
  });
}

function restoreSyncState(value: unknown): MachineSyncState {
  const restored = restoreConvexJson(value ?? createEmptySyncState()) as Partial<MachineSyncState>;
  return {
    recentCommandResidue: Array.isArray(restored.recentCommandResidue)
      ? restored.recentCommandResidue.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function createEmptySyncState(): MachineSyncState {
  return { recentCommandResidue: [] };
}

function compareLogAsc(
  a: Doc<"projectorInstanceLog">,
  b: Doc<"projectorInstanceLog">,
): number {
  return a.createdAt - b.createdAt || a._id.localeCompare(b._id);
}

function compareLogDesc(
  a: Doc<"projectorInstanceLog">,
  b: Doc<"projectorInstanceLog">,
): number {
  return b.createdAt - a.createdAt || b._id.localeCompare(a._id);
}
