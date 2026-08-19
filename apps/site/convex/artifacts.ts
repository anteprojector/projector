// Generative UI artifacts: immutable, versioned rows holding agent-authored
// TSX. writeAppSurface's source never enters machine state — the action
// request in the frame log carries it, and recordSurfaceArtifacts (called
// from the frame-persist mutation, so both the agent path and sendCommand hit
// it) folds each successful write into a row here. State-schema evolution can
// therefore never lose a surface, and an LLM-led migration only has to walk
// this table.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { restoreConvexJson } from "./convexJson";
import { siteCharter } from "../src/agent/charter";

type DbCtx = MutationCtx | QueryCtx;

export type SurfaceArtifact = { version: number; title: string; source: string };

const surfaceValidator = v.object({
  version: v.number(),
  title: v.string(),
  source: v.string(),
});

export async function getLatestSurfaceArtifact(
  ctx: DbCtx,
  sessionId: Id<"sessions">,
): Promise<Doc<"artifacts"> | null> {
  return await ctx.db
    .query("artifacts")
    .withIndex("by_session_kind_version", (q) =>
      q.eq("sessionId", sessionId).eq("kind", "surface"),
    )
    .order("desc")
    .first();
}

export const latestSurfaceSource = internalQuery({
  args: { sessionId: v.id("sessions") },
  returns: v.union(v.null(), surfaceValidator),
  handler: async (ctx, { sessionId }) => {
    const artifact = await getLatestSurfaceArtifact(ctx, sessionId);
    return artifact
      ? { version: artifact.version, title: artifact.title, source: artifact.source }
      : null;
  },
});

// Frame messages are already restored (plain JSON) when this runs. Each
// successful writeAppSurface pairs its request (title + source) with the
// version its state.update stamped on appSurface, in frame order.
export async function recordSurfaceArtifacts(
  ctx: MutationCtx,
  {
    sessionId,
    frameId,
    messages,
  }: {
    sessionId: Id<"sessions">;
    frameId: Id<"frames">;
    messages: readonly unknown[];
  },
): Promise<void> {
  const requests = new Map<string, { title: string; source: string }>();
  const writes: Array<{ title: string; source: string }> = [];
  const versions: number[] = [];

  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    if (message.type === "action" && message.name === "writeAppSurface") {
      if (message.kind === "request" && typeof message.callId === "string") {
        const input = message.input as { title?: unknown; source?: unknown } | undefined;
        if (typeof input?.title === "string" && typeof input?.source === "string") {
          requests.set(message.callId, { title: input.title, source: input.source });
        }
      }
      if (
        message.kind === "result" &&
        message.success === true &&
        typeof message.callId === "string"
      ) {
        const request = requests.get(message.callId);
        if (request) writes.push(request);
      }
    }
    if (message.type === "instance" && message.kind === "state.update" && message.stateKey === "appSurface") {
      const update = message.update as { value?: { version?: unknown } } | undefined;
      if (typeof update?.value?.version === "number") versions.push(update.value.version);
    }
  }

  if (writes.length === 0) return;

  const latest = await getLatestSurfaceArtifact(ctx, sessionId);
  let fallbackVersion = latest?.version ?? 0;
  for (const [index, write] of writes.entries()) {
    const version = versions[index] ?? ++fallbackVersion;
    const existing = await ctx.db
      .query("artifacts")
      .withIndex("by_session_kind_version", (q) =>
        q.eq("sessionId", sessionId).eq("kind", "surface").eq("version", version),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("artifacts", {
      sessionId,
      kind: "surface",
      version,
      title: write.title,
      source: write.source,
      frameId,
      charterVersion: siteCharter.version,
      createdAt: Date.now(),
    });
  }
}

// Sessions written before the artifacts table kept the source in the (now
// removed) appSurfaceSource machine state. Their latest instance snapshots
// still carry that container as raw JSON; read it straight off the serialized
// tree so old surfaces keep rendering without a backfill.
export function readLegacySurface(serialized: unknown): SurfaceArtifact | null {
  const instance = serialized as {
    states?: Record<string, { value?: unknown }>;
    children?: unknown[];
  } | null;
  if (!instance || typeof instance !== "object") return null;

  const sourceValue = instance.states?.appSurfaceSource?.value as
    | { source?: unknown }
    | undefined;
  if (typeof sourceValue?.source === "string" && sourceValue.source) {
    const meta = instance.states?.appSurface?.value as
      | { version?: unknown; title?: unknown }
      | undefined;
    return {
      version: typeof meta?.version === "number" ? meta.version : 1,
      title: typeof meta?.title === "string" ? meta.title : "",
      source: sourceValue.source,
    };
  }

  for (const child of instance.children ?? []) {
    const found = readLegacySurface(child);
    if (found) return found;
  }
  return null;
}

// One-shot: copy every legacy in-state surface into the artifacts table.
// Idempotent — sessions that already have artifact rows are skipped. Run with
// `npx convex run artifacts:backfillSurfaceArtifacts`.
export const backfillSurfaceArtifacts = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const sessions = await ctx.db.query("sessions").take(1000);
    let created = 0;
    for (const session of sessions) {
      if (await getLatestSurfaceArtifact(ctx, session._id)) continue;
      const logs = await ctx.db
        .query("projectorInstanceLog")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(20);
      const legacy = logs
        .map((log) => readLegacySurface(restoreConvexJson(log.instance)))
        .find((surface) => surface !== null);
      if (!legacy) continue;
      await ctx.db.insert("artifacts", {
        sessionId: session._id,
        kind: "surface",
        version: legacy.version,
        title: legacy.title,
        source: legacy.source,
        createdAt: Date.now(),
      });
      created += 1;
    }
    return created;
  },
});
