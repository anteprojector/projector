import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  MessageParam,
  ContentBlock as AnthropicContentBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { Charter } from "../types/charter.js";
import type { Instance } from "../types/instance.js";
import type { Node } from "../types/node.js";
import type {
  MachineMessage,
  MachineItem,
  OutputBlock,
} from "../types/messages.js";
import {
  userMessage,
  assistantMessage,
} from "../types/messages.js";
import { generateToolDefinitions } from "../tools/tool-generator.js";
import { buildSystemPrompt } from "../runtime/system-prompt.js";
import { runToolPipeline } from "../runtime/tool-pipeline.js";
import { getOrInitPackState } from "../core/machine.js";
import { ZOD_JSON_SCHEMA_TARGET_OPENAPI_3 } from "../helpers/json-schema.js";
import type {
  Executor,
  StandardExecutorConfig,
  StandardNodeConfig,
  RunOptions,
  RunResult,
} from "./types.js";

/**
 * Filter out tool_use blocks that don't have corresponding tool_result blocks.
 * This handles race conditions where tool_use is enqueued before tool_result.
 */
function filterUnpairedToolUse(messages: MessageParam[]): MessageParam[] {
  // Collect all tool_result IDs
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && "type" in block && block.type === "tool_result") {
          toolResultIds.add((block as { tool_use_id: string }).tool_use_id);
        }
      }
    }
  }

  // Filter messages, removing unpaired tool_use blocks
  return messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg;
    }

    const filteredContent = msg.content.filter((block) => {
      if (typeof block === "object" && "type" in block && block.type === "tool_use") {
        const hasResult = toolResultIds.has((block as { id: string }).id);
        if (!hasResult) {
          console.warn(`[executor] Filtering unpaired tool_use: ${(block as { id: string }).id}`);
        }
        return hasResult;
      }
      return true;
    });

    // If all content was filtered, return empty text to avoid empty message
    if (filteredContent.length === 0) {
      return { role: msg.role, content: [{ type: "text" as const, text: "" }] };
    }

    return { ...msg, content: filteredContent };
  }).filter((msg) => {
    // Remove messages that are just empty text
    if (Array.isArray(msg.content) && msg.content.length === 1) {
      const block = msg.content[0];
      if (typeof block === "object" && "type" in block && block.type === "text" && "text" in block && block.text === "") {
        return false;
      }
    }
    return true;
  });
}

/**
 * Standard executor implementation using Anthropic SDK.
 * Makes exactly ONE API call per run(), processes tools, and returns.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export class StandardExecutor<AppMessage = unknown> implements Executor<AppMessage> {
  type = "standard" as const;
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private debug: boolean;

  constructor(config: StandardExecutorConfig = {}) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      logLevel: config.debug ? "debug" : undefined,
    });


    this.model = config.model ?? "claude-sonnet-4-5";
    this.maxTokens = config.maxTokens ?? 4096;
    this.debug = config.debug ?? false;

  }

  async test() {
    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: "user", content: "ping" }],
      });
      console.log('$$$$ msg.content', msg.content);
    } catch (err: any) {
      console.error("Anthropic error name:", err?.name);
      console.error("Anthropic error status:", err?.status);
      console.error("Anthropic error message:", err?.message);
      console.error("Anthropic error:", err);
      throw err;
    }
  }

  /**
   * Execute a single API call for the given instance.
   * Processes tool calls and returns the result.
   */
  async run(
    charter: Charter<AppMessage>,
    instance: Instance,
    ancestors: Instance[],
    input: string,
    options?: RunOptions<AppMessage>,
  ): Promise<RunResult<AppMessage>> {
    let currentState = instance.state;
    let currentNode: Node<any, unknown> = instance.node;
    let currentChildren = instance.children;
    let currentExecutorConfig = instance.executorConfig;
    const newMessages: MachineMessage<AppMessage>[] = [];
    const isWorker = instance.node.worker === true;

    // Get pack states from root instance (first ancestor or current instance)
    const rootInstance = ancestors[0] ?? instance;
    let packStates: Record<string, unknown> = { ...(rootInstance.packStates ?? {}) };

    // Lazy init packs from current node (for node-level packs not in charter)
    if (!currentNode.worker && currentNode.packs) {
      for (const pack of currentNode.packs) {
        getOrInitPackState(packStates, pack);
      }
    }

    // Build conversation history for API, including previous history
    const conversationHistory: MessageParam[] = [];

    // Add previous history if provided
    if (options?.history) {
      for (const msg of options.history) {
        // Skip system and command messages - they are for internal control flow only
        if (msg.role === "system" || msg.role === "command") continue;
        conversationHistory.push(this.convertMessageToParam(msg));
      }
    }

    // Add current user input (only if non-empty)
    if (input) {
      newMessages.push(userMessage(input, { instanceId: instance.id }));
      conversationHistory.push({ role: "user", content: input });
    }

    // Validate that we have at least one message
    if (conversationHistory.length === 0) {
      throw new Error(
        "Cannot call API with empty messages. This typically happens when runMachine is called " +
        "before any user messages have been enqueued and there is no prior conversation history."
      );
    }

    // Filter out unpaired tool_use blocks (handles race conditions)
    const validatedHistory = filterUnpairedToolUse(conversationHistory);

    // Generate tools for current node (includes ancestor tools)
    const tools = generateToolDefinitions(
      charter,
      currentNode,
      ancestors.map((a) => a.node),
    );

    // Build system prompt (delegated)
    const systemPrompt = buildSystemPrompt(
      charter,
      currentNode,
      currentState,
      ancestors,
      packStates,
      options,
    );

    // Prepare Anthropic tools
    const anthropicTools = tools.map((t) => {
      // Built-in tools (like web_search) have a 'type' field but no 'input_schema'.
      // Anthropic's SDK Tool type doesn't properly model these, requiring a cast.
      if ("type" in t && !("input_schema" in t)) {
        return t as unknown as Anthropic.Messages.Tool;
      }
      // Custom tools need the standard format
      return {
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool["input_schema"],
      };
    });

    // Resolve effective executor config (instance > node > executor defaults)
    const execConfig = instance.executorConfig ?? instance.node.executorConfig ?? {};

    // Runtime validation of known executorConfig fields
    if (execConfig.model !== undefined && typeof execConfig.model !== "string") {
      throw new Error(`executorConfig.model must be a string, got ${typeof execConfig.model}`);
    }
    if (execConfig.maxTokens !== undefined && typeof execConfig.maxTokens !== "number") {
      throw new Error(`executorConfig.maxTokens must be a number, got ${typeof execConfig.maxTokens}`);
    }
    if (execConfig.temperature !== undefined && typeof execConfig.temperature !== "number") {
      throw new Error(`executorConfig.temperature must be a number, got ${typeof execConfig.temperature}`);
    }

    // Use validated values with defaults
    const effectiveModel = (execConfig.model as string | undefined) ?? this.model;
    const effectiveMaxTokens = (execConfig.maxTokens as number | undefined) ?? this.maxTokens;
    const effectiveTemperature = execConfig.temperature as number | undefined; // undefined = use API default

    // Build structured output format if node has output config (beta feature)
    let outputFormat: { type: "json_schema"; schema: unknown } | undefined;
    if (currentNode.output?.schema) {
      const jsonSchema: Record<string, unknown> = z.toJSONSchema(currentNode.output.schema, {
        target: ZOD_JSON_SCHEMA_TARGET_OPENAPI_3,
      }) as Record<string, unknown>;
      outputFormat = {
        type: "json_schema",
        schema: jsonSchema,
      };
    }

    // Make ONE API call (use beta endpoint for structured outputs if needed)
    const apiParams = {
      model: effectiveModel,
      max_tokens: effectiveMaxTokens,
      ...(effectiveTemperature !== undefined && { temperature: effectiveTemperature }),
      system: systemPrompt,
      messages: validatedHistory,
      tools: anthropicTools,
    };

    console.log('$$ messages.create', validatedHistory[validatedHistory.length - 1])
    const response = outputFormat
      ? await this.client.beta.messages.create({
        ...apiParams,
        // Type cast needed as SDK types may not match API exactly for beta features
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        output_format: outputFormat as any,
        betas: ["structured-outputs-2025-11-13"],
      })
      : await this.client.messages.create(apiParams);

    // Debug: log the response
    if (this.debug) {
      console.log(`[executor] stop_reason: ${response.stop_reason}`);
      console.log(`[executor] content:`, JSON.stringify(response.content, null, 2));
    }

    // Convert response content to our format
    // Cast needed because beta and non-beta responses have different content block types
    let assistantContent = this.convertContentBlocks(response.content as AnthropicContentBlock[]);

    // If node has structured output, transform text blocks to OutputBlocks
    if (currentNode.output?.mapTextBlock) {
      assistantContent = assistantContent.map((block) => {
        if (block.type === "text") {
          const mapped = currentNode.output!.mapTextBlock(block.text);
          return { type: "output", data: mapped } as OutputBlock<AppMessage>;
        }
        return block;
      });
    }

    const assistantMsg = assistantMessage(assistantContent, { instanceId: instance.id });
    newMessages.push(assistantMsg);

    // Determine yield reason and process accordingly
    let yieldReason: "end_turn" | "tool_use" | "max_tokens" | "cede" | "suspend" = "end_turn";
    let cedeContent: string | MachineMessage<AppMessage>[] | undefined = undefined;
    let suspendInfo: import("../types/instance.js").SuspendInfo | undefined = undefined;

    if (response.stop_reason === "max_tokens") {
      yieldReason = "max_tokens";
    } else if (response.stop_reason === "tool_use") {
      // Extract tool calls from response
      const toolCalls = response.content
        .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } =>
          block.type === "tool_use"
        )
        .map(({ id, name, input }) => ({ id, name, input }));

      // Run the tool pipeline (delegated to reusable runtime function)
      const pipelineResult = await runToolPipeline<AppMessage>(
        {
          charter,
          instance,
          ancestors,
          packStates,
          history: options?.history,
        },
        toolCalls,
      );

      // Append pipeline messages to our messages
      newMessages.push(...pipelineResult.history);

      // Use pipeline result for return values
      yieldReason = pipelineResult.yieldReason;
      cedeContent = pipelineResult.cedeContent;
      packStates = pipelineResult.packStates;

      // Extract updated values from pipeline result instance
      currentNode = pipelineResult.instance.node;
      currentState = pipelineResult.instance.state;
      currentChildren = pipelineResult.instance.children;
      currentExecutorConfig = pipelineResult.instance.executorConfig;
      suspendInfo = pipelineResult.instance.suspended;
    }
    // else: end_turn - yieldReason already set to "end_turn"

    // Build updated instance
    const updatedInstance = this.buildUpdatedInstance(
      instance,
      currentNode,
      currentState,
      currentChildren,
      ancestors,
      packStates,
      currentExecutorConfig,
      suspendInfo,
    );

    return {
      instance: updatedInstance,
      history: newMessages,
      yieldReason,
      cedeContent,
      // Worker instances don't update pack states
      packStates: !isWorker && Object.keys(packStates).length > 0 ? packStates : undefined,
    };
  }

  /**
   * Build updated instance, propagating ancestor state changes.
   */
  private buildUpdatedInstance(
    originalInstance: Instance,
    currentNode: Node<any, unknown>,
    currentState: unknown,
    currentChildren: Instance[] | undefined,
    ancestors: Instance[],
    packStates: Record<string, unknown>,
    executorConfig?: StandardNodeConfig,
    suspendInfo?: import("../types/instance.js").SuspendInfo,
  ): Instance {
    // Build the updated leaf instance
    // Include packStates only if this is the root instance (no ancestors)
    const isRoot = ancestors.length === 0;
    return {
      id: originalInstance.id,
      node: currentNode,
      state: currentState,
      children: currentChildren,
      ...(isRoot && Object.keys(packStates).length > 0 ? { packStates } : {}),
      executorConfig,
      ...(suspendInfo ? { suspended: suspendInfo } : {}),
    };
  }

  /**
   * Convert Anthropic content blocks to our format.
   * Returns MachineItem<AppMessage>[] - though the blocks returned here (text, tool_use, thinking)
   * don't use the M parameter, this typing allows proper inference when used with OutputBlocks later.
   */
  private convertContentBlocks(
    blocks: AnthropicContentBlock[],
  ): MachineItem<AppMessage>[] {
    return blocks.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      // Handle thinking blocks if present
      if (
        "thinking" in block &&
        typeof (block as { thinking?: string }).thinking === "string"
      ) {
        return {
          type: "thinking",
          thinking: (block as { thinking: string }).thinking,
        };
      }
      // Fallback
      return { type: "text", text: JSON.stringify(block) };
    });
  }

  /**
   * Convert our MachineMessage format to Anthropic MessageParam format.
   * Only user and assistant messages should be passed here (system/command are filtered before).
   */
  private convertMessageToParam(msg: MachineMessage<AppMessage>): MessageParam {
    const role = msg.role as "user" | "assistant";
    if (typeof msg.items === "string") {
      return { role, content: msg.items };
    }

    // Convert our MachineItem[] to Anthropic's format
    const content = msg.items.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      if (block.type === "tool_result") {
        return {
          type: "tool_result" as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error !== undefined && { is_error: block.is_error }),
        };
      }
      // OutputBlock - convert back to text for history
      if (block.type === "output") {
        return {
          type: "text" as const,
          text: JSON.stringify(block.data, null, 2),
        };
      }
      // Thinking blocks - skip or convert
      return { type: "text" as const, text: "" };
    }).filter((b) => b.type !== "text" || b.text !== "");

    return { role, content };
  }
}

/**
 * Create a standard executor instance.
 * @typeParam AppMessage - The application message type for structured outputs (defaults to unknown).
 */
export function createStandardExecutor<AppMessage = unknown>(
  config?: StandardExecutorConfig,
): StandardExecutor<AppMessage> {
  return new StandardExecutor<AppMessage>(config);
}
