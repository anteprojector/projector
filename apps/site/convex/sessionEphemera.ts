import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

export async function initializeSessionEphemera(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  createdAt: number,
): Promise<void> {
  await ctx.db.insert("sessionEphemera", {
    sessionId,
    lastActivityAt: createdAt,
    messageCount: 0,
    artifactCount: 0,
  });
}

export async function recordSessionMessage(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  createdAt: number,
): Promise<void> {
  const ephemera = await getSessionEphemera(ctx, sessionId);
  if (!ephemera) throw new Error("Session ephemera not found");
  await ctx.db.patch(ephemera._id, {
    lastActivityAt: createdAt,
    messageCount: ephemera.messageCount + 1,
  });
}

export async function recordSessionArtifacts(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
  count: number,
): Promise<void> {
  if (count === 0) return;
  const ephemera = await getSessionEphemera(ctx, sessionId);
  if (!ephemera) throw new Error("Session ephemera not found");
  await ctx.db.patch(ephemera._id, {
    artifactCount: ephemera.artifactCount + count,
  });
}

async function getSessionEphemera(ctx: MutationCtx, sessionId: Id<"sessions">) {
  return await ctx.db
    .query("sessionEphemera")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}
