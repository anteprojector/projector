import type {
  ActorMessage,
  AnyActorMessage,
  CompletionReason,
  DefaultActorMessage,
  Frame,
  FrameDraft,
  FrameMessage,
  GeneratorId,
  HistoryProjectionContext,
  UserContentOf,
  UserMessage,
  UserMessageOf,
  AssistantContentOf,
  AssistantMessage,
  AssistantMessageOf,
  Audience,
  MessageDelivery,
  RuntimeConcurrency,
  RuntimeInstanceId,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
  WorkMessage,
} from "./types.ts";

export type RuntimeCompletionFrameMetadata = {
  type: "projector.runtime-completion";
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  completionReason: CompletionReason;
};

export function createRuntimeCompletionFrame({
  generatorId,
  runtimeInstanceId,
  activationId,
  completionReason,
  metadata,
}: {
  generatorId: GeneratorId;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  completionReason: CompletionReason;
  metadata?: Record<string, unknown>;
}): FrameDraft {
  return {
    generatorId,
    runtimeInstanceId,
    activationId,
    messages: [],
    metadata: {
      ...metadata,
      type: "projector.runtime-completion",
      runtimeInstanceId,
      activationId,
      completionReason,
    } satisfies RuntimeCompletionFrameMetadata & Record<string, unknown>,
  };
}

export function isRuntimeCompletionFrame(
  frame: Pick<Frame, "metadata"> & Partial<Pick<Frame, "messages">>,
): boolean {
  return readCompletionMetadata(frame, undefined) !== undefined;
}

export function createActivationFrame({
  activationId,
  runtimeInstanceId,
  generatorId,
  sourceFrameId,
  concurrencyKey,
  concurrency,
}: {
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  generatorId: GeneratorId;
  sourceFrameId: string;
  concurrencyKey: string;
  concurrency: RuntimeConcurrency;
}): FrameDraft {
  return {
    messages: [
      {
        type: "work",
        kind: "activation",
        activationId,
        runtimeInstanceId,
        generatorId,
        sourceFrameId,
        concurrencyKey,
        concurrency,
      } satisfies WorkActivationMessage,
    ],
  };
}

export function createCompletionFrame({
  activationId,
  sourceFrameId,
  reason,
}: {
  activationId: string;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
}): FrameDraft {
  return {
    messages: [
      {
        type: "work",
        kind: "completion",
        activationId,
        ...(sourceFrameId !== undefined ? { sourceFrameId } : {}),
        reason,
      } satisfies WorkCompletionMessage,
    ],
  };
}

export function isWorkMessage(message: unknown): message is WorkMessage {
  return isWorkActivationMessage(message) || isWorkCompletionMessage(message);
}

export function isWorkActivationMessage(message: unknown): message is WorkActivationMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return (
    record.type === "work" &&
    record.kind === "activation" &&
    typeof record.activationId === "string" &&
    typeof record.runtimeInstanceId === "string" &&
    typeof record.generatorId === "string" &&
    typeof record.sourceFrameId === "string" &&
    typeof record.concurrencyKey === "string" &&
    (record.concurrency === "serial" || record.concurrency === "parallel")
  );
}

export function isWorkCompletionMessage(message: unknown): message is WorkCompletionMessage {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return (
    record.type === "work" &&
    record.kind === "completion" &&
    typeof record.activationId === "string" &&
    (record.sourceFrameId === undefined || typeof record.sourceFrameId === "string") &&
    isWorkCompletionReason(record.reason)
  );
}

export function userMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  content: UserContentOf<TActorMessage>,
  options: {
    text?: string;
    audience?: Audience;
    delivery?: MessageDelivery;
  } = {},
): UserMessageOf<TActorMessage> {
  return {
    type: "user",
    content,
    ...options,
  } as UserMessageOf<TActorMessage>;
}

export function assistantMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  content: AssistantContentOf<TActorMessage>,
  options: {
    text?: string;
    audience?: Audience;
    delivery?: MessageDelivery;
  } = {},
): AssistantMessageOf<TActorMessage> {
  return {
    type: "assistant",
    content,
    ...options,
  } as AssistantMessageOf<TActorMessage>;
}

export function textUserMessage(text: string): UserMessage<string> {
  return { type: "user", content: text, text };
}

export function textAssistantMessage(text: string): AssistantMessage<string> {
  return { type: "assistant", content: text, text };
}

export function actorMessages<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  ctx: HistoryProjectionContext<TActorMessage>,
): TActorMessage[] {
  return actorMessagesFromFrames<TActorMessage>(ctx.history);
}

export function messages<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  ctx: HistoryProjectionContext<TActorMessage>,
): FrameMessage<TActorMessage>[] {
  return messagesFromFrames<TActorMessage>(ctx.history);
}

export function messagesSinceLastCompletion<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
>(
  ctx: HistoryProjectionContext<TActorMessage>,
): TActorMessage[] {
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
  return actorMessagesFromFrames<TActorMessage>(index === -1 ? ctx.history : ctx.history.slice(index + 1));
}

export function messagesBeforeLastCompletion<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
>(
  ctx: HistoryProjectionContext<TActorMessage>,
): TActorMessage[] {
  const index = lastCompletionIndex(ctx.history, ctx.runtimeInstanceId);
  return index === -1 ? [] : actorMessagesFromFrames<TActorMessage>(ctx.history.slice(0, index));
}

export function actorMessagesFromFrames<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
>(frames: readonly Frame<TActorMessage>[]): TActorMessage[] {
  return frames.flatMap((frame) =>
    frame.messages.flatMap((message) => actorMessageFromUnknown<TActorMessage>(message))
  );
}

export function messagesFromFrames<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  frames: readonly Frame<TActorMessage>[],
): FrameMessage<TActorMessage>[] {
  return frames.flatMap((frame) => frame.messages);
}

function lastCompletionIndex<TActorMessage extends AnyActorMessage>(
  frames: readonly Frame<TActorMessage>[],
  runtimeInstanceId: RuntimeInstanceId,
): number {
  const activationRuntimeIds = new Map<string, RuntimeInstanceId>();
  let lastIndex = -1;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    if (readCompletionMetadata(frame, runtimeInstanceId)) {
      lastIndex = index;
    }
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message)) {
        activationRuntimeIds.set(message.activationId, message.runtimeInstanceId);
      }
      if (
        isWorkCompletionMessage(message) &&
        activationRuntimeIds.get(message.activationId) === runtimeInstanceId
      ) {
        lastIndex = index;
      }
    }
  }
  return lastIndex;
}

function readCompletionMetadata(
  frame: Pick<Frame<any>, "metadata"> | undefined,
  runtimeInstanceId: RuntimeInstanceId | undefined,
): RuntimeCompletionFrameMetadata | undefined {
  const metadata = frame?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  if (record.type !== "projector.runtime-completion") {
    return undefined;
  }
  if (
    runtimeInstanceId !== undefined &&
    record.runtimeInstanceId !== runtimeInstanceId
  ) {
    return undefined;
  }
  if (
    typeof record.runtimeInstanceId !== "string" ||
    typeof record.activationId !== "string" ||
    !isCompletionReason(record.completionReason)
  ) {
    return undefined;
  }

  return {
    type: "projector.runtime-completion",
    runtimeInstanceId: record.runtimeInstanceId,
    activationId: record.activationId,
    completionReason: record.completionReason,
  };
}

function actorMessageFromUnknown<TActorMessage extends AnyActorMessage>(
  value: unknown,
): TActorMessage[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (record.type === "user") {
    return [{ ...record, type: "user" } as TActorMessage];
  }
  if (record.type === "assistant") {
    return [{ ...record, type: "assistant" } as TActorMessage];
  }
  if (record.type === "tool" && typeof record.name === "string") {
    return [{ ...record, type: "tool", name: record.name } as TActorMessage];
  }

  return [];
}

function isCompletionReason(value: unknown): value is CompletionReason {
  return value === "done" || value === "cancelled" || value === "delegated" || value === "error";
}

function isWorkCompletionReason(value: unknown): value is WorkCompletionReason {
  return value === "end-turn" || value === "done" || value === "cancelled" || value === "delegated";
}
