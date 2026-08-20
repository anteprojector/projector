import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";

export type MessageActor = {
  id: string;
  kind: "anonymous" | "github";
  label: string;
};

export const messageActorValidator = v.object({
  id: v.string(),
  kind: v.union(v.literal("anonymous"), v.literal("github")),
  label: v.string(),
});

export function anonymousActor(sessionId: Id<"sessions">): MessageActor {
  return {
    id: `anonymous:${sessionId}`,
    kind: "anonymous",
    label: "ANON",
  };
}

export function githubActor(user: Doc<"users">): MessageActor {
  const fallback = user.name?.trim() || "user";
  return {
    id: `github:${user._id}`,
    kind: "github",
    label: `@github/${user.githubHandle?.trim() || fallback}`,
  };
}

export const current = internalQuery({
  args: {},
  returns: v.union(v.null(), messageActorValidator),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user ? githubActor(user) : null;
  },
});
