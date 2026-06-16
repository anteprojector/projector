import { Output, generateText, streamText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import { isActorMessage } from "@projectors/core";
import type {
  ActionContext,
  AnyActorMessage,
  AnyAction,
  CompiledInference,
  DefaultActorMessage,
  ExecutorRunRequest,
  ExecutorRunResult,
  FrameMessage,
  ProjectorExecutor,
  Audience,
} from "@projectors/core";
import { z } from "zod";
import type { AiSdkExecutorConfig, AiSdkStreamUpdate } from "./types.ts";

const DEFAULT_MAX_STEPS = 5;

export class AiSdkExecutor<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> implements ProjectorExecutor<TActorMessage> {
  readonly type = "aisdk";

  constructor(readonly config: AiSdkExecutorConfig<TActorMessage>) {}

  async run(request: ExecutorRunRequest<TActorMessage>): Promise<ExecutorRunResult<TActorMessage>> {
    if (request.signal?.aborted) {
      return { completionReason: "cancelled" };
    }

    const generate = this.config.generateText ?? generateText;
    const stream = this.config.streamText ?? streamText;
    const tools = buildAiSdkTools(request, this.config);
    const hasTools = Object.keys(tools).length > 0;
    const input = {
      model: this.config.model,
      system: buildAiSdkSystem(request.inference),
      messages: buildAiSdkMessages(request.inference, this.config.messageToModelMessage),
      tools: hasTools ? tools : undefined,
      abortSignal: request.signal,
      maxOutputTokens: this.config.maxOutputTokens,
      temperature: this.config.temperature,
      topP: this.config.topP,
      topK: this.config.topK,
      presencePenalty: this.config.presencePenalty,
      frequencyPenalty: this.config.frequencyPenalty,
      seed: this.config.seed,
      experimental_output: request.output?.schema
        ? Output.object({ schema: request.output.schema })
        : undefined,
      providerOptions: this.config.providerOptions as never,
      toolChoice: this.config.toolChoice as never,
      stopWhen: hasTools ? stepCountIs(this.config.maxSteps ?? DEFAULT_MAX_STEPS) : undefined,
    };

    try {
      if (shouldStream(this.config.stream, request)) {
        return await this.runStreaming(request, stream, input as never);
      }

      const result = await generate(input);

      const text = typeof result.text === "string" ? result.text : "";
      return {
        completionReason: "done",
        ...(text.trim() ? { value: text } : {}),
      };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) {
        return { completionReason: "cancelled" };
      }
      throw error;
    }
  }

  private async runStreaming(
    request: ExecutorRunRequest<TActorMessage>,
    stream: NonNullable<AiSdkExecutorConfig<TActorMessage>["streamText"]>,
    input: Parameters<NonNullable<AiSdkExecutorConfig<TActorMessage>["streamText"]>>[0],
  ): Promise<ExecutorRunResult<TActorMessage>> {
    const messageId = crypto.randomUUID();
    let seq = 0;
    let text = "";

    emitStreamUpdate(this.config, {
      request,
      messageId,
      text,
      streamState: "streaming",
      streamSeq: seq,
    });

    const result = stream(input);
    try {
      for await (const delta of result.textStream) {
        if (!delta) continue;
        text += delta;
        seq += 1;
        emitStreamUpdate(this.config, {
          request,
          messageId,
          text,
          delta,
          streamState: "streaming",
          streamSeq: seq,
        });
      }
    } catch (error) {
      seq += 1;
      emitStreamUpdate(this.config, {
        request,
        messageId,
        text,
        streamState: "error",
        streamSeq: seq,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const finalText = text || await result.text;
    const finalSeq = seq + 1;

    return {
      completionReason: "done",
      ...(finalText.trim()
        ? {
            frames: [
              {
                messages: [
                  outputMessageFromText<TActorMessage>(finalText, request.output, {
                    messageId,
                    streamState: "complete",
                    streamSeq: finalSeq,
                  }),
                ],
              },
            ],
          }
        : {}),
    };
  }
}

function emitStreamUpdate<TActorMessage extends AnyActorMessage>(
  config: AiSdkExecutorConfig<TActorMessage>,
  update: AiSdkStreamUpdate<TActorMessage>,
): void {
  if (!config.onStreamUpdate) return;
  void Promise.resolve()
    .then(() => config.onStreamUpdate?.(update))
    .catch((error) => {
      if (config.debug) {
        console.warn("[aisdk-executor] stream update failed", error);
      }
    });
}

function shouldStream<TActorMessage extends AnyActorMessage>(
  stream: AiSdkExecutorConfig<TActorMessage>["stream"],
  request: ExecutorRunRequest<TActorMessage>,
): boolean {
  if (typeof stream === "function") return stream(request);
  return stream === true;
}

export function buildAiSdkSystem(inference: CompiledInference<any>): string {
  return [
    renderSection("System", inference.systemParts),
    renderSection("Dynamic Context", inference.dynamicParts),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildAiSdkMessages<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  inference: CompiledInference<TActorMessage>,
  messageToModelMessage?: (message: TActorMessage) => ModelMessage | undefined,
): ModelMessage[] {
  return inference.history
    .filter(isActorMessage<TActorMessage>)
    .flatMap((message) => {
      const rendered = messageToModelMessage?.(message);
      return rendered ? [rendered] : [actorMessageToModelMessage(message)];
    });
}

export function buildAiSdkTools<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  request: ExecutorRunRequest<TActorMessage>,
  config: AiSdkExecutorConfig<TActorMessage>,
): ToolSet {
  const tools: ToolSet = {};

  for (const action of request.inference.tools) {
    tools[action.name] = tool({
      description: action.description ?? "",
      inputSchema: action.inputSchema ?? z.object({}),
      strict: config.toolStrict ?? false,
      execute: (input, aiSdkContext) =>
        executeAction(action, input, request, config, aiSdkContext),
    });
  }

  return tools;
}

async function executeAction<TActorMessage extends AnyActorMessage>(
  action: AnyAction,
  input: unknown,
  request: ExecutorRunRequest<TActorMessage>,
  config: AiSdkExecutorConfig<TActorMessage>,
  aiSdkContext: unknown,
): Promise<unknown> {
  const context: ActionContext<unknown> = request.createActionContext?.(action) ?? {};
  let output: unknown;
  if (config.runAction) {
    output = await config.runAction({ action, input, context, request, aiSdkContext });
  } else {
    output = await action.run?.(input as never, context as never);
  }
  const messages = actionResultMessages<TActorMessage>(output);
  if (messages.length > 0) {
    await request.enqueueFrame({
      generatorId: request.generatorId,
      runtimeInstanceId: request.runtimeInstanceId,
      activationId: request.activationId,
      messages,
    });
  }
  return output;
}

function actionResultMessages<TActorMessage extends AnyActorMessage>(
  value: unknown,
): FrameMessage<TActorMessage>[] {
  if (Array.isArray(value)) {
    return value.filter(isFrameMessageLike) as FrameMessage<TActorMessage>[];
  }
  return isFrameMessageLike(value) ? [value as FrameMessage<TActorMessage>] : [];
}

function isFrameMessageLike(value: unknown): value is { type: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string",
  );
}

function actorMessageToModelMessage(message: AnyActorMessage): ModelMessage {
  if (message.type === "user") {
    return { role: "user", content: renderActorContent(message) };
  }
  if (message.type === "assistant") {
    return { role: "assistant", content: renderActorContent(message) };
  }
  return { role: "user", content: renderToolMessage(message) };
}

function renderActorContent(
  message: Extract<AnyActorMessage, { type: "user" | "assistant" }>,
): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (message.text !== undefined) {
    return message.text;
  }
  throw new Error(
    `Cannot render ${message.type} message with non-string content. Provide messageToModelMessage or text.`,
  );
}

function outputMessageFromText<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  text: string,
  output: ExecutorRunRequest<TActorMessage>["output"],
  metadata: Record<string, unknown>,
): FrameMessage<TActorMessage> {
  const mappedContent = output?.mapTextBlock
    ? output.mapTextBlock(text)
    : text;
  const content = output?.schema ? output.schema.parse(mappedContent) : mappedContent;
  const withAudience = applyOutputAudience({
    type: "assistant",
    content,
    text,
  }, output?.audience);
  if (!isFrameMessageLike(withAudience)) {
    throw new Error("Output mapper must return a frame message");
  }

  return {
    ...withAudience,
    ...metadata,
  } as FrameMessage<TActorMessage>;
}

function applyOutputAudience(
  message: unknown,
  audience: Audience | undefined,
): unknown {
  if (!audience || !message || typeof message !== "object") {
    return message;
  }

  const record = message as Record<string, unknown>;
  if (record.audience !== undefined) {
    return message;
  }

  if (record.type === "user" || record.type === "assistant" || record.type === "tool") {
    return { ...record, audience };
  }

  return message;
}

function renderToolMessage(message: Extract<AnyActorMessage, { type: "tool" }>): string {
  const value = message.text ?? stringifyValue(message.value);
  return value ? `Tool ${message.name}: ${value}` : `Tool ${message.name}`;
}

function renderSection(title: string, parts: string[]): string {
  const body = parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return body ? `## ${title}\n\n${body}` : "";
}

function stringifyValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return record.name === "AbortError" || record.name === "TimeoutError";
}
