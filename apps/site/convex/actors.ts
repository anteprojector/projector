import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { MessageActor } from "./messageActor";

export function anonymousActor(sessionId: Id<"sessions">): MessageActor {
  return {
    id: `anonymous:${sessionId}`,
    kind: "anonymous",
    label: "ANON",
  };
}

export function githubActor(user: Doc<"users">): MessageActor {
  const handle = user.name?.trim() || "user";
  return {
    id: `github:${user._id}`,
    kind: "github",
    label: `@github/${handle}`,
  };
}

export async function authenticatedUser(
  ctx: MutationCtx | QueryCtx,
): Promise<{ userId: Id<"users">; actor: MessageActor } | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const user = await ctx.db.get(userId);
  return user ? { userId, actor: githubActor(user) } : null;
}
