import { v4 as uuid } from "uuid";
import type { Charter } from "../types/charter";
import type { Machine, MachineConfig } from "../types/machine";
import { type Instance } from "../types/instance";
import type { MachineMessage } from "../types/messages";
import { isEphemeralMessage } from "../types/messages";
import { createExternalizeRuntime } from "../runtime/externalize-manager";
import { getAllNodePacks, initPackContexts } from "../runtime/context-resolver";

/**
 * Validate a node instance tree recursively.
 * Ensures all states are valid according to their node validators.
 * Also ensures all instances have IDs (returns a new instance if ID was missing).
 */
function validateInstance(instance: Instance): Instance {
  // Ensure instance has ID (immutably)
  const withId = instance.id ? instance : { ...instance, id: uuid() };

  // Validate this instance's state
  const stateResult = withId.node.validator.safeParse(withId.state);
  if (!stateResult.success) {
    throw new Error(
      `Invalid state for node "${withId.node.id}": ${stateResult.error.message}`,
    );
  }

  // Recursively validate children
  if (withId.children) {
    const validatedChildren = withId.children.map(child => validateInstance(child));
    // Only create new object if children changed
    const childrenChanged = validatedChildren.some((c, i) => c !== withId.children![i]);
    if (childrenChanged) {
      return { ...withId, children: validatedChildren };
    }
  }

  return withId;
}

/**
 * Walk all instances in the tree, collect node-level packs,
 * and initialize their contexts on the root instance.
 */
function initAllNodePackContextsOnRoot(charter: Charter, root: Instance): Instance {
  const packs = getAllNodePacks(root);
  if (packs.length === 0) return root;

  const context = { ...(root.context ?? {}) };
  initPackContexts(charter, context, packs);

  return {
    ...root,
    context,
  };
}

/**
 * Create a new machine instance.
 * Validates all states in the instance tree.
 * Initializes pack contexts on root instance if not present.
 */
export function createMachine<AppMessage = unknown>(
  charter: Charter<AppMessage>,
  config: MachineConfig<AppMessage>,
): Machine<AppMessage> {
  const { instance: inputInstance, history = [], onMessageEnqueue } = config;

  const instance = initAllNodePackContextsOnRoot(charter, inputInstance);

  // Validate the entire instance tree (may return new instance with generated IDs)
  const validatedInstance = validateInstance(instance);

  // Create mutable queue for enqueuing messages
  const queue: MachineMessage<AppMessage>[] = [];

  // Queue notification system for waitForQueue
  let queueResolvers: Array<() => void> = [];

  const notifyQueue = () => {
    const resolvers = queueResolvers;
    queueResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  };

  const waitForQueue = (): Promise<void> => {
    if (queue.some((m) => !isEphemeralMessage(m))) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queueResolvers.push(resolve);
    });
  };

  const machine: Machine<AppMessage> = {
    charter,
    instance: validatedInstance,
    history,
    queue,
    enqueue: (messages: MachineMessage<AppMessage>[]) => {
      for (const message of messages) {
        const messageId = message.metadata?.messageId;
        if (messageId) {
          const existingIndex = queue.findIndex((m) => m.metadata?.messageId === messageId);
          if (existingIndex !== -1) {
            queue[existingIndex] = message;
          } else {
            queue.push(message);
          }
        } else {
          queue.push(message);
        }

        if (onMessageEnqueue && !isEphemeralMessage(message)) {
          onMessageEnqueue(message);
        }
      }
      if (messages.some((m) => !isEphemeralMessage(m))) {
        notifyQueue();
      }
    },
    waitForQueue,
    notifyQueue,
  };

  machine.externalize = createExternalizeRuntime(machine);
  machine.externalize.syncRegistrations();

  return machine;
}
