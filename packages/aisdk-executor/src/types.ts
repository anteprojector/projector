import type { generateText, streamText, LanguageModel } from "ai";
import type {
  ActionContext,
  AnyActorMessage,
  AnyAction,
  DefaultActorMessage,
  ExecutorRunRequest,
} from "@projectors/core";

export type AiSdkGenerateText = typeof generateText;
export type AiSdkStreamText = typeof streamText;

export type AiSdkRunActionInput<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  action: AnyAction;
  input: unknown;
  context: ActionContext<unknown>;
  request: ExecutorRunRequest<TActorMessage>;
  aiSdkContext?: unknown;
};

export type AiSdkStreamUpdate<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  request: ExecutorRunRequest<TActorMessage>;
  messageId: string;
  text: string;
  delta?: string;
  streamState: "streaming" | "complete" | "error";
  streamSeq: number;
  error?: string;
};

export type AiSdkExecutorConfig<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  model: LanguageModel;
  generateText?: AiSdkGenerateText;
  streamText?: AiSdkStreamText;
  debug?: boolean;
  stream?: boolean | ((request: ExecutorRunRequest<TActorMessage>) => boolean);
  onStreamUpdate?: (update: AiSdkStreamUpdate<TActorMessage>) => unknown | Promise<unknown>;
  messageToModelMessage?: (message: TActorMessage) => import("ai").ModelMessage | undefined;

  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  providerOptions?: Record<string, unknown>;

  maxSteps?: number;
  toolChoice?: unknown;
  toolStrict?: boolean;

  runAction?: (input: AiSdkRunActionInput<TActorMessage>) => unknown | Promise<unknown>;
};
