import { type Infer, v } from "convex/values";

export const messageActorValidator = v.object({
  id: v.string(),
  kind: v.union(v.literal("anonymous"), v.literal("github")),
  label: v.string(),
});

export type MessageActor = Infer<typeof messageActorValidator>;
