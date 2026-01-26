/**
 * Tool Pipeline - Reusable tool call → state update → transition → messages flow.
 *
 * This module extracts the complete tool processing pipeline from StandardExecutor
 * so it can be reused by other executors (e.g., LiveKitExecutor) that receive
 * tool calls from external sources (not from their own LLM inference).
 */

import type { Charter } from "../types/charter.js";
import type { Instance, SuspendInfo } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type { MachineMessage, ToolResultBlock, TextBlock, OutputBlock } from "../types/messages.js";
import type { StandardNodeConfig } from "../executor/types.js";
import { userMessage, assistantMessage } from "../types/messages.js";
import { processToolCalls, type ToolCall, type ToolCallContext } from "./tool-call-processor.js";
import { executeTransition } from "./transition-executor.js";
import { handleTransitionResult } from "./transition-handler.js";

/**
 * Context for running the tool pipeline.
 */
export interface ToolPipelineContext<AppMessage = unknown> {
  /** The charter (for ref resolution) */
  charter: Charter<AppMessage>;
  /** The current node instance */
  instance: Instance;
  /** Parent instances for ref resolution (from root to parent) */
  ancestors: Instance[];
  /** Current pack states (from root instance) */
  packStates: Record<string, unknown>;
  /** Conversation history (for getInstanceMessages in tools) */
  history?: MachineMessage<AppMessage>[];
}

/**
 * Result of running the tool pipeline.
 * Contains all updates needed to advance machine state.
 */
export interface ToolPipelineResult<AppMessage = unknown> {
  /** Updated instance (with new node/state/children if transition occurred) */
  instance: Instance;
  /** Messages generated (tool results as user message, any assistant content) */
  history: MachineMessage<AppMessage>[];
  /** Why the pipeline yielded */
  yieldReason: "tool_use" | "end_turn" | "cede" | "suspend";
  /** Updated pack states */
  packStates: Record<string, unknown>;
  /** Content from cede (string or MachineMessage[]) - only set when yieldReason is "cede" */
  cedeContent?: string | MachineMessage<AppMessage>[];
}

/**
 * Run the tool pipeline: process tool calls → update state → execute transitions → build messages.
 *
 * This is the core logic extracted from StandardExecutor.run() that handles:
 * 1. Processing each tool call (updateState, transitions, regular tools)
 * 2. Executing any queued transition
 * 3. Building the updated instance with new node/state/children
 * 4. Generating history messages (tool results + assistant content)
 *
 * @param ctx - The pipeline context (charter, instance, ancestors, etc.)
 * @param toolCalls - Array of tool calls to process
 * @returns The pipeline result with updated instance, history, and yield reason
 */
export async function runToolPipeline<AppMessage = unknown>(
  ctx: ToolPipelineContext<AppMessage>,
  toolCalls: ToolCall[],
): Promise<ToolPipelineResult<AppMessage>> {
  const { charter, instance, ancestors, history } = ctx;
  let currentState = instance.state;
  let currentNode: Node<any, unknown> = instance.node;
  let currentChildren = instance.children;
  let currentExecutorConfig = instance.executorConfig;
  let packStates = { ...ctx.packStates };

  const newMessages: MachineMessage<AppMessage>[] = [];

  // Process tool calls
  const toolCallCtx: ToolCallContext = {
    charter,
    instance,
    ancestors,
    packStates,
    currentState,
    currentNode,
    history,
  };

  const toolResult = await processToolCalls<AppMessage>(toolCallCtx, toolCalls);

  // Update state from tool processing
  currentState = toolResult.currentState;
  packStates = toolResult.packStates;

  // Add tool results to messages (role: user)
  if (toolResult.toolResults.length > 0) {
    const toolResultMsg = userMessage<AppMessage>(toolResult.toolResults, { instanceId: instance.id });
    newMessages.push(toolResultMsg);
  }

  // Add assistant messages from toolReply (role: assistant)
  if (toolResult.assistantMessages.length > 0) {
    const assistantMsg = assistantMessage<AppMessage>(toolResult.assistantMessages, { instanceId: instance.id });
    newMessages.push(assistantMsg);
  }

  // Determine yield reason
  let yieldReason: "tool_use" | "end_turn" | "cede" | "suspend" = "tool_use";
  let cedeContent: string | MachineMessage<AppMessage>[] | undefined = undefined;
  let suspendInfo: SuspendInfo | undefined = undefined;

  // Handle terminal tools - force end turn immediately
  if (toolResult.terminal) {
    yieldReason = "end_turn";
  } else if (toolResult.queuedTransition) {
    // Execute the queued transition
    const transition = currentNode.transitions[toolResult.queuedTransition.name];
    if (!transition) {
      throw new Error(`Unknown transition: ${toolResult.queuedTransition.name}`);
    }

    const result = await executeTransition(
      charter,
      transition,
      currentState,
      toolResult.queuedTransition.reason,
      toolResult.queuedTransition.args,
    );

    // Handle transition result
    const outcome = handleTransitionResult(
      result,
      currentNode,
      currentState,
      currentChildren,
    );

    // Apply outcome
    currentNode = outcome.node;
    currentState = outcome.state;
    currentChildren = outcome.children;
    yieldReason = outcome.yieldReason;
    cedeContent = outcome.cedeContent as typeof cedeContent;
    suspendInfo = outcome.suspendInfo;
    if (outcome.executorConfig !== undefined) {
      currentExecutorConfig = outcome.executorConfig;
    }
  }

  // Build updated instance
  const isRoot = ancestors.length === 0;
  const updatedInstance: Instance = {
    id: instance.id,
    node: currentNode,
    state: currentState,
    children: currentChildren,
    ...(isRoot && Object.keys(packStates).length > 0 ? { packStates } : {}),
    executorConfig: currentExecutorConfig,
    ...(suspendInfo ? { suspended: suspendInfo } : {}),
  };

  return {
    instance: updatedInstance,
    history: newMessages,
    yieldReason,
    packStates,
    cedeContent,
  };
}
