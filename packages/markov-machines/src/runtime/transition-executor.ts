import { v4 as uuid } from "uuid";
import type { Charter } from "../types/charter";
import { fromSafeJsonSchema } from "../helpers/json-schema";
import type { Node } from "../types/node";
import type {
  Transition,
  TransitionContext,
  TransitionResult,
} from "../types/transitions";
import { transitionTo } from "../types/transitions";
import type { SerialContext, SerialNode, Ref, SerialPack } from "../types/refs";
import {
  isCodeTransition,
  isGeneralTransition,
} from "../types/transitions";
import { isRef, isSerialTransition } from "../types/refs";
import { resolveTransitionRef } from "./ref-resolver";
import type { AnyToolDefinition } from "../types/tools";
import type { AnyPackCommandDefinition, AnyPackToolDefinition } from "../types/pack";
import type { Pack } from "../types/pack";
import type { AnyCommandDefinition } from "../types/commands";
import type { ContextRef } from "../types/context";

/**
 * Resolve a node command ref (dotted: charter.nodes[source].commands[name]).
 */
function resolveNodeCommandRef(charter: Charter<any>, ref: string): AnyCommandDefinition<unknown> {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    throw new Error(`Command ref must be dotted (node.command): ${ref}`);
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const node = charter.nodes[source];
  if (!node) throw new Error(`Unknown node in command ref: ${ref}`);
  const command = node.commands?.[name];
  if (!command) throw new Error(`Unknown command on node ${source}: ${name}`);
  return command as AnyCommandDefinition<unknown>;
}

/**
 * Resolve a node tool ref (flat or dotted).
 * Flat: charter.tools[ref]. Dotted: charter.nodes[source].tools[name].
 * Does NOT search pack tools — use resolvePackToolRef for those.
 */
function resolveNodeToolRef(charter: Charter<any>, ref: string): AnyToolDefinition {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    const tool = charter.tools[ref];
    if (!tool) throw new Error(`Unknown tool ref: ${ref}`);
    return tool;
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const node = charter.nodes[source];
  if (!node) throw new Error(`Unknown node in tool ref: ${ref}`);
  const tool = node.tools[name];
  if (!tool) throw new Error(`Unknown tool on node ${source}: ${name}`);
  return tool as AnyToolDefinition;
}

/**
 * Resolve a pack tool ref (flat or dotted).
 * Flat: charter.tools[ref] (charter tools are shared). Dotted: charter.packs by name.
 * Does NOT search node tools.
 */
function resolvePackToolRef(
  charter: Charter<any>,
  ref: string,
): AnyToolDefinition | AnyPackToolDefinition {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    const tool = charter.tools[ref];
    if (!tool) throw new Error(`Unknown tool ref: ${ref}`);
    return tool;
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const pack = charter.packs.find((p) => p.name === source);
  if (!pack) throw new Error(`Unknown pack in tool ref: ${ref}`);
  const tool = pack.tools[name];
  if (!tool) throw new Error(`Unknown tool on pack ${source}: ${name}`);
  return tool;
}

function resolvePackCommandRef(charter: Charter<any>, ref: string): AnyPackCommandDefinition<unknown> {
  const dotIdx = ref.indexOf(".");
  if (dotIdx === -1) {
    throw new Error(`Pack command ref must be dotted (pack.command): ${ref}`);
  }
  const source = ref.slice(0, dotIdx);
  const name = ref.slice(dotIdx + 1);
  const pack = charter.packs.find((p) => p.name === source);
  if (!pack) throw new Error(`Unknown pack in command ref: ${ref}`);
  const command = pack.commands?.[name];
  if (!command) throw new Error(`Unknown command on pack ${source}: ${name}`);
  return command as AnyPackCommandDefinition<unknown>;
}

function deserializeContextRef(context: Ref | SerialContext): ContextRef {
  if (isRef(context)) return context;

  return {
    name: context.name,
    schema: fromSafeJsonSchema(context.schema),
    initialState: context.initialState,
  };
}

function deserializePack(charter: Charter<any>, serialPack: Ref | SerialPack): Pack {
  if (isRef(serialPack)) {
    const pack = charter.packs.find((p) => p.name === serialPack.ref);
    if (!pack) {
      throw new Error(`Pack not found in charter: ${serialPack.ref}`);
    }
    return pack;
  }

  const charterPack = charter.packs.find((p) => p.name === serialPack.name);

  const tools: Record<string, AnyPackToolDefinition> = {};
  if (serialPack.tools) {
    for (const [name, toolRef] of Object.entries(serialPack.tools)) {
      tools[name] = resolvePackToolRef(charter, toolRef.ref) as AnyPackToolDefinition;
    }
  } else if (charterPack) {
    Object.assign(tools, charterPack.tools);
  }

  const commands: Record<string, AnyPackCommandDefinition> = {};
  if (serialPack.commands) {
    for (const [name, commandRef] of Object.entries(serialPack.commands)) {
      commands[name] = resolvePackCommandRef(charter, commandRef.ref);
    }
  } else if (charterPack?.commands) {
    Object.assign(commands, charterPack.commands);
  }

  return {
    name: serialPack.name,
    description: serialPack.description,
    context: deserializeContextRef(serialPack.context),
    instructions: serialPack.instructions,
    tools,
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
  };
}

/**
 * Resolve a transition ref (flat or dotted).
 * Delegates to resolveTransitionRef from ref-resolver.
 */
function resolveNestedTransitionRef(
  charter: Charter<any>,
  ref: string,
): Transition<unknown> {
  // Create a Ref object and delegate to the canonical resolver
  return resolveTransitionRef(charter, { ref } as unknown as Transition<unknown>);
}

/**
 * Execute a transition and return the result.
 * S is the source state type.
 */
export async function executeTransition<S>(
  charter: Charter<any>,
  transition: Transition<S>,
  state: S,
  reason: string,
  args: unknown,
): Promise<TransitionResult> {
  const ctx: TransitionContext = { args, reason };

  // Resolve ref to actual transition
  const resolved = resolveTransitionRef(charter, transition);

  // Code transition - execute
  if (isCodeTransition<S>(resolved)) {
    return resolved.execute(state, ctx);
  }

  // General transition - deserialize inline node
  if (isGeneralTransition(resolved)) {
    const nodeArg = args as { node?: SerialNode<unknown> };
    if (!nodeArg?.node) {
      throw new Error("General transition requires a node argument");
    }
    return transitionTo(deserializeNode(charter, nodeArg.node));
  }

  // Serial transition - resolve node ref or deserialize inline
  if (isSerialTransition(resolved)) {
    if (isRef(resolved.node)) {
      const node = charter.nodes[resolved.node.ref];
      if (!node) {
        throw new Error(`Unknown node ref: ${resolved.node.ref}`);
      }
      // charter.nodes uses `any` for state, so no cast needed
      return transitionTo(node);
    }
    return transitionTo(deserializeNode(charter, resolved.node));
  }

  const typeInfo =
    typeof resolved === "object" && resolved !== null
      ? `object with keys: ${Object.keys(resolved).join(", ")}`
      : typeof resolved;
  throw new Error(`Unknown transition type: ${typeInfo}`);
}

/**
 * Deserialize a SerialNode into a Node.
 * Resolves transition refs from the charter.
 * Note: Inline node tools cannot be serialized and will be empty on deserialization.
 */
export function deserializeNode<S>(
  charter: Charter<any>,
  serialNode: SerialNode<S>,
): Node<never, S> {
  // Deserialize the JSON Schema validator back to a Zod schema.
  const validator = fromSafeJsonSchema<S>(serialNode.validator as Record<string, unknown>);

  // Resolve transition refs (supports dotted nested refs)
  const transitions: Record<string, Transition<S>> = {};
  for (const [name, trans] of Object.entries(serialNode.transitions)) {
    if (isRef(trans)) {
      transitions[name] = resolveNestedTransitionRef(charter, trans.ref) as unknown as Transition<S>;
    } else {
      transitions[name] = trans as Transition<S>;
    }
  }

  // Resolve tool refs (supports dotted nested refs — node tools only)
  const tools: Record<string, AnyToolDefinition<S>> = {};
  if (serialNode.tools) {
    for (const [name, toolRef] of Object.entries(serialNode.tools)) {
      tools[name] = resolveNodeToolRef(charter, toolRef.ref) as AnyToolDefinition<S>;
    }
  }

  // Resolve command refs (supports dotted nested refs — node commands only)
  const commands: Record<string, AnyCommandDefinition<S>> = {};
  if (serialNode.commands) {
    for (const [name, cmdRef] of Object.entries(serialNode.commands)) {
      commands[name] = resolveNodeCommandRef(charter, cmdRef.ref) as AnyCommandDefinition<S>;
    }
  }

  const packs = serialNode.packs?.map((pack) => deserializePack(charter, pack));

  return {
    id: uuid(),
    instructions: serialNode.instructions,
    tools,
    validator,
    transitions,
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
    ...(packs && packs.length > 0 ? { packs } : {}),
    initialState: serialNode.initialState,
    ...(serialNode.executorConfig ? { executorConfig: serialNode.executorConfig } : {}),
    ...(serialNode.name ? { name: serialNode.name } : {}),
  };
}

/**
 * Resolve a node reference or return the inline node.
 */
export function resolveNodeRef<S>(
  charter: Charter<any>,
  nodeRef: Ref | SerialNode<S>,
): Node<any, S> {
  if (isRef(nodeRef)) {
    const node = charter.nodes[nodeRef.ref];
    if (!node) {
      throw new Error(`Unknown node ref: ${nodeRef.ref}`);
    }
    return node as Node<any, S>;
  }
  return deserializeNode(charter, nodeRef);
}
