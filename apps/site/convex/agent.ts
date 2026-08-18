"use node";

import { openai } from "@ai-sdk/openai";
import { AiSdkExecutor, type AiSdkStreamUpdate } from "@projectors/aisdk-executor";
import {
  ROOT_GENERATOR_ID,
  createMachine,
  runMachine,
  type Frame,
  type FrameMessage,
} from "@projectors/core";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { action, type ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { hydrateSiteInstance, siteCharter } from "../src/agent/charter";
import { escapeConvexJson } from "./convexJson";

const MODEL_ID = process.env.OPENAI_MODEL ?? "gpt-5.6-sol";

export const sendMessage = action({
  args: {
    sessionId: v.id("sessions"),
    text: v.string(),
  },
  returns: v.object({ success: v.literal(true) }),
  handler: async (ctx, { sessionId, text }): Promise<{ success: true }> => {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Message requires text");
    }

    const session = await ctx.runQuery(internal.sessions.getForAction, { sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const instance = hydrateSiteInstance(session.instance, sessionId);
    const contextFrames = await ctx.runQuery(api.sessions.listMachineContextFrames, {
      sessionId,
    }) as Frame[];
    const streamWrites: Promise<void>[] = [];
    const executor = createExecutor(ctx, sessionId, streamWrites);
    const machine = createMachine({
      id: sessionId,
      instance,
      charter: siteCharter,
      executor,
      frames: contextFrames,
    });

    // The user row is written before the run so it sorts ahead of the
    // assistant's streaming rows (createdAt is the thread order). The frame
    // persistence pass later finds it by the same idempotency key — derived
    // from this messageId — and patches on the real frameId.
    const userMessageId = crypto.randomUUID();
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "user",
      content: trimmed,
      idempotencyKey: `user:${userMessageId}`,
    });

    machine.enqueueFrame({
      messages: [{ type: "user", text: trimmed, messageId: userMessageId }],
    });

    const producedFrames: Frame[] = [];
    for await (const frame of runMachine(machine)) {
      producedFrames.push(frame);
    }
    await Promise.resolve();
    await Promise.allSettled(streamWrites);

    const frameIds = await ctx.runMutation(api.sessions.appendMachineFrameSequence, {
      sessionId,
      referenceFrameId: session.frameId,
      frames: escapeConvexJson(producedFrames),
    });

    for (const [index, frame] of producedFrames.entries()) {
      const frameId = frameIds[index];
      if (!frameId) continue;
      await persistFrameMessages(ctx, {
        sessionId,
        frame,
        frameId,
      });
    }

    return { success: true };
  },
});

function createExecutor(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  streamWrites: Promise<void>[],
) {
  return new AiSdkExecutor({
    model: openai(MODEL_ID),
    maxOutputTokens: 4096,
    stream: true,
    onStreamUpdate: (update) => {
      const write = persistStreamUpdate(ctx, sessionId, update);
      streamWrites.push(write);
      return write;
    },
  });
}

async function persistStreamUpdate(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  update: AiSdkStreamUpdate,
): Promise<void> {
  if (update.streamState !== "streaming") return;
  await ctx.runMutation(api.messages.add, {
    sessionId,
    role: "assistant",
    content: update.text,
    idempotencyKey: assistantStreamKey(update.messageId),
    streamState: "streaming",
    streamSeq: update.streamSeq,
  });
}

async function persistFrameMessages(
  ctx: ActionCtx,
  {
    sessionId,
    frame,
    frameId,
  }: {
    sessionId: Id<"sessions">;
    frame: Frame;
    frameId: Id<"frames">;
  },
): Promise<void> {
  for (const [messageIndex, message] of frame.messages.entries()) {
    const text = typeof message.text === "string" ? message.text : "";
    if (message.type === "user" && text.trim()) {
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "user",
        content: text,
        frameId,
        idempotencyKey: frameMessageKey("user", frame, message, messageIndex),
      });
    }

    if (
      message.type === "assistant" &&
      shouldPersistAssistantMessage(frame, message) &&
      text.trim()
    ) {
      const streamSeq = readNumberField(message, "streamSeq");
      await ctx.runMutation(api.messages.add, {
        sessionId,
        role: "assistant",
        content: text,
        frameId,
        idempotencyKey: frameMessageKey("assistant", frame, message, messageIndex),
        // The durable write settles any in-flight stream row for this message:
        // frame messages never carry streamState, so it must be set here or a
        // streamed message stays "streaming" forever.
        streamState: "complete",
        ...(streamSeq !== undefined ? { streamSeq } : {}),
      });
    }
  }
}

function shouldPersistAssistantMessage(frame: Frame, message: FrameMessage): boolean {
  if (message.audience === "self") return false;
  return frame.generatorId === undefined || frame.generatorId === ROOT_GENERATOR_ID;
}

function frameMessageKey(
  prefix: "user" | "assistant",
  frame: Frame,
  message: FrameMessage,
  messageIndex: number,
): string {
  const messageId = readStringField(message, "messageId");
  if (messageId && prefix === "assistant") return assistantStreamKey(messageId);
  if (messageId) return `${prefix}:${messageId}`;
  return `${prefix}:${frame.id}:${messageIndex}`;
}

function assistantStreamKey(messageId: string): string {
  return `assistant:${messageId}`;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function readNumberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
