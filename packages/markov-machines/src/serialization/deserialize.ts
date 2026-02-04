import type { Charter } from "../types/charter";
import type {
  Machine,
  OnMessageEnqueue,
  SerializedMachine,
  SerializedInstance,
} from "../types/machine";
import type { Instance } from "../types/instance";
import type { MachineMessage } from "../types/messages";
import { isEphemeralMessage } from "../types/messages";
import { resolveNodeRef } from "../runtime/transition-executor";
export { deserializeNode } from "../runtime/transition-executor";

/**
 * Deserialize a node instance from persisted state.
 */
export function deserializeInstance(
  charter: Charter<any>,
  serialized: SerializedInstance,
): Instance {
  // Resolve node
  const node = resolveNodeRef(charter, serialized.node);

  // Validate state against the node's validator
  const stateResult = node.validator.safeParse(serialized.state);
  if (!stateResult.success) {
    throw new Error(`Invalid state: ${stateResult.error.message}`);
  }

  // Recursively deserialize children
  let children: Instance[] | undefined;
  if (serialized.children && serialized.children.length > 0) {
    children = serialized.children.map((c) => deserializeInstance(charter, c));
  }

  return {
    id: serialized.id,
    node,
    state: stateResult.data,
    children,
    ...(serialized.packStates ? { packStates: serialized.packStates } : {}),
    ...(serialized.executorConfig ? { executorConfig: serialized.executorConfig } : {}),
    ...(serialized.suspended ? {
      suspended: {
        suspendId: serialized.suspended.suspendId,
        reason: serialized.suspended.reason,
        suspendedAt: new Date(serialized.suspended.suspendedAt),
        metadata: serialized.suspended.metadata,
      }
    } : {}),
  };
}

/**
 * Deserialize a machine from persisted state.
 * The charter must be the same (or compatible) as when serialized.
 */
export function deserializeMachine<AppMessage = unknown>(
  charter: Charter<AppMessage>,
  serialized: SerializedMachine<AppMessage>,
  options?: {
    onMessageEnqueue?: OnMessageEnqueue<AppMessage>;
  },
): Machine<AppMessage> {
  const queue: MachineMessage<AppMessage>[] = [];
  const onMessageEnqueue = options?.onMessageEnqueue;

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

  return {
    charter,
    instance: deserializeInstance(charter, serialized.instance),
    history: serialized.history,
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
}
