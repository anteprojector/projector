import type { Command, Resume } from "./commands.js";

/**
 * Text content block (simplified for storage).
 */
export interface TextBlock {
  type: "text";
  text: string;
}

/**
 * Tool use content block (from assistant).
 */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/**
 * Thinking content block (simplified for storage).
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

/**
 * Tool result content block (in user message).
 */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Output block from structured output.
 * Contains the mapped application message.
 * @typeParam M - The application message type (defaults to unknown).
 */
export interface OutputBlock<M = unknown> {
  type: "output";
  data: M;
}

/**
 * Union of all machine item types.
 * @typeParam M - The application message type for OutputBlock (defaults to unknown).
 */
export type MachineItem<M = unknown> =
  | TextBlock
  | ToolUseBlock
  | ThinkingBlock
  | ToolResultBlock
  | OutputBlock<M>
  | Command
  | Resume;

/**
 * Check if a machine item is an OutputBlock.
 */
export function isOutputBlock<M>(
  block: MachineItem<M>,
): block is OutputBlock<M> {
  return block.type === "output";
}

/**
 * Source attribution for a message.
 * - instanceId: ID of the instance that generated this message
 * - external: true if message came from outside the machine (user transcript, LiveKit STT, etc.)
 */
export interface MessageSource {
  /** ID of the instance that generated this message */
  instanceId?: string;
  /** True if message originated from outside the machine (e.g., user speech, external system) */
  external?: boolean;
}

/**
 * @deprecated Use MessageSource instead
 */
export type SourceInstanceId = string | "user";

/**
 * Metadata attached to messages for attribution and tracking.
 */
export interface MessageMetadata {
  /** Source attribution for this message */
  source?: MessageSource;
  /** @deprecated Use source.instanceId instead */
  sourceInstanceId?: SourceInstanceId;
}

/**
 * Message in the conversation history.
 * Matches Anthropic SDK format with optional metadata.
 * @typeParam M - The application message type for OutputBlock (defaults to unknown).
 */
export interface MachineMessage<M = unknown> {
  role: "user" | "assistant" | "system" | "command";
  items: string | MachineItem<M>[];
  /** Optional metadata for message attribution */
  metadata?: MessageMetadata;
}

/**
 * Create a user message.
 * @param items - Message items (string or machine items)
 * @param source - Optional source attribution for this message
 */
export function userMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "user",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create an assistant message.
 * @param items - Message items (string or machine items)
 * @param source - Optional source attribution for this message
 */
export function assistantMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "assistant",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create a system message.
 * System messages are filtered from history before sending to the model.
 * Used for internal control flow like Resume.
 * @param items - Message items (string or machine items)
 * @param source - Optional source attribution for this message
 */
export function systemMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "system",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create a command message.
 * Command messages are processed with higher precedence than regular messages.
 * They are drained from the queue first and their results are yielded before
 * normal execution continues.
 * @param items - Message items (typically a Command object)
 * @param source - Optional source attribution for this message
 */
export function commandMessage<M = unknown>(
  items: string | MachineItem<M>[],
  source?: MessageSource,
): MachineMessage<M> {
  return {
    role: "command",
    items,
    ...(source && { metadata: { source } }),
  };
}

/**
 * Create a tool result block.
 */
export function toolResult(
  toolUseId: string,
  content: string,
  isError?: boolean
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError !== undefined && { is_error: isError }),
  };
}

/**
 * Extract text from a message's items.
 */
export function getMessageText<M = unknown>(message: MachineMessage<M>): string {
  if (typeof message.items === "string") {
    return message.items;
  }
  return message.items
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
