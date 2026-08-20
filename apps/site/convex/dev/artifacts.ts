import { v } from "convex/values";
import type { ClientMachineMessage } from "@projectors/core/client";
import { SITE_SOURCE_INSTANCE_ID } from "../../src/agent/charter";
import { getSurfaceArtifact, readAppSurfaceSelection } from "../artifacts";
import { githubActor } from "../actors";
import { restoreConvexJson } from "../convexJson";
import { mutation, query } from "../_generated/server";
import { executeAuthorizedSessionCommand } from "../sessions";
import { requireAdmin } from "./access";

const historyEntryValidator = v.object({
  version: v.number(),
  title: v.string(),
  createdAt: v.number(),
  frameId: v.optional(v.id("frames")),
});

export const history = query({
  args: { sessionId: v.id("sessions") },
  returns: v.union(
    v.null(),
    v.object({
      activeVersion: v.union(v.null(), v.number()),
      latestVersion: v.union(v.null(), v.number()),
      artifacts: v.array(historyEntryValidator),
    }),
  ),
  handler: async (ctx, { sessionId }) => {
    await requireAdmin(ctx);
    if (!(await ctx.db.get(sessionId))) return null;

    const [latestInstance, artifacts] = await Promise.all([
      ctx.db
        .query("projectorInstanceLog")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .order("desc")
        .first(),
      ctx.db
        .query("artifacts")
        .withIndex("by_session_kind_version", (q) =>
          q.eq("sessionId", sessionId).eq("kind", "surface"),
        )
        .order("desc")
        .take(50),
    ]);
    const selection = latestInstance
      ? readAppSurfaceSelection(restoreConvexJson(latestInstance.instance))
      : null;

    return {
      activeVersion: selection?.activeVersion ?? null,
      latestVersion: selection?.latestVersion ?? artifacts[0]?.version ?? null,
      artifacts: artifacts.map((artifact) => ({
        version: artifact.version,
        title: artifact.title,
        createdAt: artifact.createdAt,
        ...(artifact.frameId !== undefined ? { frameId: artifact.frameId } : {}),
      })),
    };
  },
});

export const activate = mutation({
  args: { sessionId: v.id("sessions"), version: v.number() },
  returns: v.null(),
  handler: async (ctx, { sessionId, version }) => {
    const user = await requireAdmin(ctx);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("Artifact version must be a positive integer");
    }
    if (!(await getSurfaceArtifact(ctx, sessionId, version))) {
      throw new Error(`Surface artifact v${version} not found`);
    }

    const message: ClientMachineMessage = {
      type: "action",
      kind: "request",
      action: "command",
      name: "updateState",
      callId: crypto.randomUUID(),
      input: {
        address: { instanceId: SITE_SOURCE_INSTANCE_ID, stateKey: "appSurface" },
        op: "patch",
        value: { activeVersion: version, lastError: null },
      },
    };
    await executeAuthorizedSessionCommand(ctx, {
      sessionId,
      message,
      actor: githubActor(user),
    });
    return null;
  },
});
