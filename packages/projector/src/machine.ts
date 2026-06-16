import { assertNodeActionStateCompatibility, getActionBinding } from "./actions.ts";
import { findFrameByRuntimeId, traversalFrames, type ProjectionFrame, type SyntheticRoot } from "./frames.ts";
import {
  createActivationFrame,
  createCompletionFrame,
  isWorkActivationMessage,
  isWorkCompletionMessage,
} from "./history.ts";
import { encodeRuntimeAddress, SYNTHETIC_ROOT_RUNTIME_ID } from "./runtime-address.ts";
import { resolveFrameCommands, resolveFrameTools } from "./scoped-actions.ts";
import { hydrateInstance, hydrateNode, serializeInstance, serializeNode } from "./serialization.ts";
import { resolveStates } from "./state.ts";
import { actorMessageVisibleToRuntime, isActorMessage } from "./visibility.ts";
import type {
  ActionContext,
  ActorMessage,
  AnyActorMessage,
  AnyAction,
  AssistantMessage,
  Charter,
  CompiledInference,
  DefaultActorMessage,
  CommandMessage,
  ExecutorRunRequest,
  ExecutorRunResult,
  Frame,
  FrameDraft,
  FrameMessage,
  Generator,
  GeneratorId,
  Instance,
  InstanceMessage,
  NormalizedRuntime,
  AnyOutputConfig,
  OutputConfig,
  PrimaryRuntime,
  RetrievableState,
  RuntimeConcurrency,
  RuntimeInstanceId,
  RuntimeTrigger,
  SerializedInstance,
  SerializedNodeRef,
  SpawnChild,
  StateAddress,
  StateKey,
  WorkerRuntime,
  WorkActivationMessage,
  WorkCompletionMessage,
  WorkCompletionReason,
} from "./types.ts";
import { compileProjection } from "./compile.ts";

export type Machine<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: string;
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>;
  charter: Charter<TActorMessage>;
  frames: Frame<TActorMessage>[];
  enqueueFrame(frame: FrameDraft<TActorMessage> | Frame<TActorMessage>): Frame<TActorMessage>;
  ingestInertFrame(frame: Frame<TActorMessage>): void;
  subscribe(listener: (frame: Frame<TActorMessage>) => void): () => void;
};

export type MachineOptions<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id?: string;
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>;
  charter: Charter<TActorMessage>;
  frames?: Frame<TActorMessage>[];
};

export type Activation = WorkActivationMessage & {
  kind: "activation";
  generatorKind: "primary" | "worker";
  frameId: string;
  frameIndex: number;
};

export type RunMachineOptions = {
  scheduleWork?: boolean;
};

export type ExecuteCommandResult<T = unknown> =
  | { success: true; value?: T; clientId?: string }
  | { success: false; error: string; clientId?: string };

export type MachineRun<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
AsyncIterable<Frame<TActorMessage>> & {
  stopSchedulingWork(): void;
  hasStarted(): boolean;
  isDraining(): boolean;
};

export type RuntimeSyncContext<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  machine: Machine<TActorMessage>;
  runtimeInstanceId: RuntimeInstanceId;
  generator: Generator;
  inference: CompiledInference<TActorMessage>;
  visibleFrames: Frame<TActorMessage>[];
  createActionContext(action: AnyAction): ActionContext<unknown>;
  enqueueFrame(frame: FrameDraft<TActorMessage> | Frame<TActorMessage>): Frame<TActorMessage>;
};

export type SyncableExecutor<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  syncRuntime?: (context: RuntimeSyncContext<TActorMessage>) => unknown | Promise<unknown>;
};

export type SyncMachineRuntimeOptions<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  runtimeInstanceId: RuntimeInstanceId;
  generatorId?: GeneratorId;
  visibleFrames?: Frame<TActorMessage>[];
};

type ProjectorMachine<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
Machine<TActorMessage> & {
  pendingFrames: Frame<TActorMessage>[];
  nextFrameIndex: number;
  listeners: Set<(frame: Frame<TActorMessage>) => void>;
};

type WorkState = {
  activations: Map<string, Activation>;
  completions: Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>;
  generatorRuntimeIds: Map<GeneratorId, RuntimeInstanceId>;
};

type RuntimeCandidate = {
  runtimeInstanceId: RuntimeInstanceId;
  generatorKind: "primary" | "worker";
  trigger: RuntimeTrigger;
  concurrency: RuntimeConcurrency;
  concurrencyKey: string;
  generatorId: GeneratorId;
};

type HydratableNodeRef = SerializedNodeRef<any> | Instance<any>["node"];

export function createMachine<TActorMessage extends AnyActorMessage = DefaultActorMessage>({
  id = "machine",
  root,
  charter,
  frames = [],
}: MachineOptions<TActorMessage>): Machine<TActorMessage> {
  const machine: ProjectorMachine<TActorMessage> = {
    id,
    root,
    charter,
    frames: [...frames],
    pendingFrames: [],
    nextFrameIndex: nextFrameIndex(frames),
    listeners: new Set(),
    enqueueFrame(frame) {
      const canonical = canonicalizeFrameDraft(frame, this.charter);
      const enqueued = "id" in canonical && typeof canonical.id === "string"
        ? { ...canonical }
        : { id: `frame-${this.nextFrameIndex++}`, ...canonical };
      foldFrameIntoMachine(this, enqueued);
      this.frames.push(enqueued);
      this.pendingFrames.push(enqueued);
      notifyFrame(this, enqueued);
      return enqueued;
    },
    ingestInertFrame(frame) {
      if (frame.inert !== true) {
        throw new Error("ingestInertFrame requires frame.inert === true");
      }
      if (this.frames.some((existing) => existing.id === frame.id)) {
        return;
      }
      const canonical = canonicalizeFrameDraft(frame, this.charter) as Frame<TActorMessage>;
      foldFrameIntoMachine(this, canonical);
      this.frames.push(canonical);
    },
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  };
  validateMachineActionStateCompatibility(machine.root, machine.charter);
  return machine;
}

export function runMachine<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
  options: RunMachineOptions = {},
): MachineRun<TActorMessage> {
  return new MachineRunImpl<TActorMessage>(machine as ProjectorMachine<TActorMessage>, {
    scheduleWork: options.scheduleWork ?? true,
  });
}

export function reconcileWork<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
): Frame<TActorMessage>[] {
  const projectorMachine = machine as ProjectorMachine<TActorMessage>;
  const before = projectorMachine.frames.length;

  while (true) {
    const appended = reconcileWorkOnce(projectorMachine);
    if (appended.length === 0) break;
  }

  return projectorMachine.frames.slice(before);
}

export async function syncMachineRuntime<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
  options: SyncMachineRuntimeOptions<TActorMessage>,
): Promise<RuntimeSyncContext<TActorMessage> | undefined> {
  const syncRuntime = (machine.charter.executor as SyncableExecutor<TActorMessage>).syncRuntime;
  if (!syncRuntime) return undefined;

  const generator = generatorForRuntime(machine.root, options.runtimeInstanceId, options.generatorId);
  const inference = compileProjection(machine.root, {
    charter: machine.charter,
    targetGenerator: generator,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const frameDefaults = {
    generatorId: generator.id,
    runtimeInstanceId: generator.runtimeInstanceId,
  };
  const context: RuntimeSyncContext<TActorMessage> = {
    machine,
    runtimeInstanceId: options.runtimeInstanceId,
    generator,
    inference,
    visibleFrames: options.visibleFrames ?? [],
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (frame) =>
      machine.enqueueFrame({
        ...frame,
        generatorId: frame.generatorId ?? frameDefaults.generatorId,
        runtimeInstanceId: frame.runtimeInstanceId ?? frameDefaults.runtimeInstanceId,
      }),
  };

  await syncRuntime.call(machine.charter.executor, context);
  return context;
}

function reconcileYieldedWork<TActorMessage extends AnyActorMessage>(
  machine: ProjectorMachine<TActorMessage>,
): Frame<TActorMessage>[] {
  const before = machine.frames.length;

  while (true) {
    const appended = reconcileWorkOnce(machine, { skipPendingSources: true });
    if (appended.length === 0) break;
  }

  return machine.frames.slice(before);
}

function notifyFrame<TActorMessage extends AnyActorMessage>(
  machine: ProjectorMachine<TActorMessage>,
  frame: Frame<TActorMessage>,
): void {
  for (const listener of machine.listeners) {
    listener(frame);
  }
}

function generatorForRuntime<TActorMessage extends AnyActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
  runtimeInstanceId: RuntimeInstanceId,
  generatorId: GeneratorId | undefined,
): Generator {
  if (runtimeInstanceId === SYNTHETIC_ROOT_RUNTIME_ID) {
    return {
      id: generatorId ?? SYNTHETIC_ROOT_RUNTIME_ID,
      kind: "primary",
      runtimeInstanceId,
    };
  }

  const frame = findFrameByRuntimeId(root, runtimeInstanceId);
  if (!frame || (frame.node.runtime.type !== "primary" && frame.node.runtime.type !== "worker")) {
    throw new Error(`Unknown runtime "${runtimeInstanceId}"`);
  }

  return {
    id: generatorId ?? runtimeInstanceId,
    kind: frame.node.runtime.type,
    runtimeInstanceId,
  };
}

export function collectRunnableActivations<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
): Activation[] {
  const state = foldWork(machine);
  const candidates = [...state.activations.values()]
    .filter((activation) => !state.completions.has(activation.activationId))
    .filter((activation) =>
      activation.runtimeInstanceId === SYNTHETIC_ROOT_RUNTIME_ID ||
      findFrameByRuntimeId(machine.root, activation.runtimeInstanceId),
    );

  const serialByKey = new Map<string, Activation>();
  const runnable: Activation[] = [];
  for (const activation of candidates) {
    if (activation.concurrency === "parallel") {
      runnable.push(activation);
      continue;
    }

    const existing = serialByKey.get(activation.concurrencyKey);
    if (!existing || activation.frameIndex < existing.frameIndex) {
      serialByKey.set(activation.concurrencyKey, activation);
    }
  }
  runnable.push(...serialByKey.values());
  return runnable.sort((a, b) => a.frameIndex - b.frameIndex);
}

export async function runActivation<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  machine: Machine<TActorMessage>,
  activationId: string,
): Promise<ExecutorRunResult<TActorMessage> | undefined> {
  const initialState = foldWork(machine);
  const activation = initialState.activations.get(activationId);
  if (!activation) return undefined;
  if (initialState.completions.has(activationId)) return undefined;

  const frame = findFrameByRuntimeId(machine.root, activation.runtimeInstanceId);
  if (!frame) {
    if (activation.runtimeInstanceId === SYNTHETIC_ROOT_RUNTIME_ID) {
      return await runSyntheticRootActivation(machine, activation);
    }
    machine.enqueueFrame(createCompletionFrame({
      activationId,
      sourceFrameId: activation.sourceFrameId,
      reason: "cancelled",
    }));
    return { completionReason: "cancelled" };
  }

  const runtime = frame.node.runtime;
  const frameDefaults = {
    generatorId: activation.generatorId,
    runtimeInstanceId: activation.runtimeInstanceId,
    activationId,
  };
  const inference = compileProjection(machine.root, {
    charter: machine.charter,
    targetGenerator: {
      id: activation.generatorId,
      kind: activation.generatorKind,
      runtimeInstanceId: activation.runtimeInstanceId,
    } satisfies Generator,
    activationId,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const request: ExecutorRunRequest<TActorMessage> = {
    generatorId: activation.generatorId,
    runtimeInstanceId: activation.runtimeInstanceId,
    activationId,
    inference,
    output: frame.node.output,
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (draft) =>
      machine.enqueueFrame({
        ...draft,
        generatorId: draft.generatorId ?? frameDefaults.generatorId,
        runtimeInstanceId: draft.runtimeInstanceId ?? frameDefaults.runtimeInstanceId,
        activationId: draft.activationId ?? frameDefaults.activationId,
      }),
  };

  const result = await machine.charter.executor.run(request);
  enqueueExecutorResult(machine, result, frame.node.output, frameDefaults);
  if (!foldWork(machine).completions.has(activationId)) {
    machine.enqueueFrame(createCompletionFrame({
      activationId,
      sourceFrameId: activation.sourceFrameId,
      reason: completionReasonForRuntime(runtime, result.completionReason),
    }));
  }
  return result;
}

async function runSyntheticRootActivation(
  machine: Machine<any>,
  activation: Activation,
): Promise<ExecutorRunResult<any> | undefined> {
  const inference = compileProjection(machine.root, {
    charter: machine.charter,
    targetGenerator: {
      id: activation.generatorId,
      kind: "primary",
      runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
    } satisfies Generator,
    activationId: activation.activationId,
    frameHistory: machine.frames,
  });
  const getState = inference.retrievableStates.length > 0
    ? createRetrievableStateGetter(machine, inference.retrievableStates)
    : undefined;
  const frameDefaults = {
    generatorId: activation.generatorId,
    runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
    activationId: activation.activationId,
  };
  const request: ExecutorRunRequest<any> = {
    generatorId: activation.generatorId,
    runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
    activationId: activation.activationId,
    inference,
    createActionContext: (action) =>
      createMachineActionContext(machine, action, frameDefaults, getState),
    enqueueFrame: (draft) =>
      machine.enqueueFrame({
        ...draft,
        generatorId: draft.generatorId ?? frameDefaults.generatorId,
        runtimeInstanceId: draft.runtimeInstanceId ?? frameDefaults.runtimeInstanceId,
        activationId: draft.activationId ?? frameDefaults.activationId,
      }),
  };

  const result = await machine.charter.executor.run(request);
  enqueueExecutorResult(machine, result, undefined, frameDefaults);
  if (!foldWork(machine).completions.has(activation.activationId)) {
    machine.enqueueFrame(createCompletionFrame({
      activationId: activation.activationId,
      sourceFrameId: activation.sourceFrameId,
      reason: completionReasonForRuntime(syntheticRootRuntime(), result.completionReason),
    }));
  }
  return result;
}

export async function executeCommand<
  T = unknown,
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
>(
  machine: Machine<TActorMessage>,
  message: CommandMessage,
): Promise<ExecuteCommandResult<T>> {
  const resolved = resolveCommand(machine, message);
  if (!resolved) {
    return {
      success: false,
      error: `Unknown command: ${message.name}`,
      clientId: message.clientId,
    };
  }

  let input = message.input;
  if (resolved.command.inputSchema) {
    const parsed = resolved.command.inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.message,
        clientId: message.clientId,
      };
    }
    input = parsed.data;
  }

  machine.enqueueFrame({ messages: [message] });

  try {
    const context = createFrameActionContext(machine, resolved.frame, {});
    const value = await resolved.command.run?.(input as never, context as never);
    enqueueActionResult(machine, value);
    return { success: true, value: value as T, clientId: message.clientId };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      clientId: message.clientId,
    };
  }
}

function resolveCommand<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  message: CommandMessage,
): { command: AnyAction; frame: ProjectionFrame<TActorMessage> } | undefined {
  const frames = traversalFrames(machine.root);
  if (message.target) {
    const targetRuntimeId = encodeRuntimeAddress(message.target);
    const frame = frames.find((candidate) => candidate.runtimeInstanceId === targetRuntimeId);
    const command = frame
      ? resolveFrameCommands(frame, machine.charter).find((candidate) => candidate.name === message.name)
      : undefined;
    if (frame && command) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
    }
    return frame && command ? { command, frame } : undefined;
  }

  let resolved: { command: AnyAction; frame: ProjectionFrame<TActorMessage> } | undefined;
  for (const frame of frames) {
    const command = resolveFrameCommands(frame, machine.charter).find((candidate) => candidate.name === message.name);
    if (command) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
      resolved = { command, frame };
    }
  }
  return resolved;
}

function validateMachineActionStateCompatibility<TActorMessage extends AnyActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
  charter: Charter<TActorMessage>,
): void {
  for (const frame of traversalFrames(root)) {
    for (const tool of resolveFrameTools(frame, charter)) {
      assertNodeActionStateCompatibility(tool, frame.node, "tool");
    }
    for (const command of resolveFrameCommands(frame, charter)) {
      assertNodeActionStateCompatibility(command, frame.node, "command");
    }
  }
}

function createMachineActionContext<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  action: AnyAction,
  frameDefaults: Partial<Pick<FrameDraft<TActorMessage>, "generatorId" | "runtimeInstanceId" | "activationId">>,
  getState?: ActionContext["getState"],
): ActionContext<unknown> {
  const binding = getActionBinding(action);
  const frame = binding
    ? findFrameByRuntimeId(machine.root, binding.runtimeInstanceId)
    : undefined;
  if (!frame) {
    return getState ? { getState } : {};
  }
  const context = createFrameActionContext(machine, frame, frameDefaults);
  if (getState) {
    context.getState = getState;
  }
  return context;
}

function createRetrievableStateGetter<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  retrievableStates: RetrievableState[],
): NonNullable<ActionContext["getState"]> {
  const retrievalTargets = new Map(
    retrievableStates.map((state) => [state.address, state.target] as const),
  );
  return (address) => {
    const target = retrievalTargets.get(address);
    if (!target) {
      throw new Error(`Unknown retrievable state address "${address}"`);
    }
    return readStateValue(machine.root, target);
  };
}

function createFrameActionContext<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  frame: ProjectionFrame<TActorMessage>,
  frameDefaults: Partial<Pick<FrameDraft<TActorMessage>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): ActionContext<unknown> {
  const stateAddress = stateAddressForFrame(frame);
  if (!stateAddress) {
    return {};
  }

  const readState = () => readStateValue(machine.root, stateAddress);
  const context: ActionContext<unknown> = {
    state: readState(),
    patchState: (patch) => {
      const next = patchObject(readState(), patch);
      validateStateValue(machine.root, stateAddress, next);
      machine.enqueueFrame({
        ...frameDefaults,
        messages: [
          {
            type: "instance",
            kind: "state.patch",
            instanceId: stateAddress.instanceId,
            stateKey: stateAddress.stateKey,
            patch,
          } satisfies InstanceMessage,
        ],
      });
      context.state = readState();
    },
    replaceState: (value) => {
      validateStateValue(machine.root, stateAddress, value);
      machine.enqueueFrame({
        ...frameDefaults,
        messages: [
          {
            type: "instance",
            kind: "state.replace",
            instanceId: stateAddress.instanceId,
            stateKey: stateAddress.stateKey,
            value,
          } satisfies InstanceMessage,
        ],
      });
      context.state = readState();
    },
  };
  return context;
}

function enqueueActionResult<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  value: unknown,
): void {
  const messages = actionResultMessages<TActorMessage>(value);
  if (messages.length > 0) {
    machine.enqueueFrame({ messages });
  }
}

function enqueueExecutorResult<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  result: ExecutorRunResult<TActorMessage>,
  output: OutputConfig<TActorMessage> | undefined,
  frameDefaults: Partial<Pick<FrameDraft<TActorMessage>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): void {
  for (const frame of result.frames ?? []) {
    enqueueFrameWithDefaults(machine, frame, frameDefaults);
  }

  if (result.value !== undefined) {
    enqueueFrameWithDefaults(
      machine,
      { messages: [outputMessageFromText(result.value, output)] },
      frameDefaults,
    );
  }
}

function enqueueFrameWithDefaults<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  frame: FrameDraft<TActorMessage> | Frame<TActorMessage>,
  defaults: Partial<Pick<FrameDraft<TActorMessage>, "generatorId" | "runtimeInstanceId" | "activationId">>,
): Frame<TActorMessage> {
  return machine.enqueueFrame({
    ...frame,
    generatorId: frame.generatorId ?? defaults.generatorId,
    runtimeInstanceId: frame.runtimeInstanceId ?? defaults.runtimeInstanceId,
    activationId: frame.activationId ?? defaults.activationId,
  });
}

function outputMessageFromText<TActorMessage extends AnyActorMessage>(
  text: string,
  output: OutputConfig<TActorMessage> | undefined,
): FrameMessage<TActorMessage> {
  const mappedContent = output?.mapTextBlock
    ? output.mapTextBlock(text)
    : text;
  const content = output?.schema ? output.schema.parse(mappedContent) : mappedContent;
  const message = {
    type: "assistant",
    content,
    text,
  } satisfies AssistantMessage<unknown>;
  const withAudience = applyOutputAudience(message, output?.audience);

  if (!isFrameMessageLike(withAudience)) {
    throw new Error("Output mapper must return a frame message");
  }
  return withAudience as FrameMessage<TActorMessage>;
}

function applyOutputAudience(
  message: unknown,
  audience: AnyOutputConfig["audience"],
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

function actionResultMessages<TActorMessage extends AnyActorMessage>(
  value: unknown,
): FrameMessage<TActorMessage>[] {
  if (Array.isArray(value)) {
    return value.filter(isFrameMessageLike) as FrameMessage<TActorMessage>[];
  }
  return isFrameMessageLike(value) ? [value as FrameMessage<TActorMessage>] : [];
}

function isFrameMessageLike(value: unknown): value is { type: string } {
  return Boolean(value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string");
}

function canonicalizeFrameDraft<
  TActorMessage extends AnyActorMessage,
  TFrame extends FrameDraft<TActorMessage> | Frame<TActorMessage>,
>(
  frame: TFrame,
  charter: Charter<TActorMessage>,
): TFrame {
  return {
    ...frame,
    messages: frame.messages.map((message) => canonicalizeMessage(message, charter)),
  };
}

function canonicalizeMessage<TActorMessage extends AnyActorMessage>(
  message: FrameMessage<TActorMessage>,
  charter: Charter<TActorMessage>,
): FrameMessage<TActorMessage> {
  if (!isInstanceMessage(message)) {
    return message;
  }

  if (message.kind === "transition") {
    return ({
      ...message,
      node: canonicalizeNodeRef(message.node, charter),
    } satisfies InstanceMessage<TActorMessage>) as FrameMessage<TActorMessage>;
  }

  if (message.kind === "spawn") {
    return ({
      ...message,
      children: message.children.map((child) => canonicalizeSpawnChild(child, charter)),
    } satisfies InstanceMessage<TActorMessage>) as FrameMessage<TActorMessage>;
  }

  if (message.kind === "attach") {
    return ({
      ...message,
      children: message.children.map((child) => canonicalizeSerializedInstance(child, charter)),
    } satisfies InstanceMessage<TActorMessage>) as FrameMessage<TActorMessage>;
  }

  return message;
}

function canonicalizeSpawnChild<TActorMessage extends AnyActorMessage>(
  child: SpawnChild<TActorMessage>,
  charter: Charter<TActorMessage>,
): SpawnChild<TActorMessage> {
  return {
    ...child,
    id: child.id ?? crypto.randomUUID(),
    node: canonicalizeNodeRef(child.node, charter),
    children: child.children?.map((nested) => canonicalizeSpawnChild(nested, charter)),
  };
}

function canonicalizeSerializedInstance(
  instance: SerializedInstance<any>,
  charter: Charter<any>,
): SerializedInstance<any> {
  return serializeInstance(hydrateInstance(instance, charter), charter);
}

function canonicalizeNodeRef(
  node: HydratableNodeRef,
  charter: Charter<any>,
): SerializedNodeRef<any> {
  if (typeof node === "string") {
    return node;
  }
  if (containsHydratedNodeData(node)) {
    return serializeNode(node, charter);
  }
  return serializeNode(hydrateNode(node as SerializedNodeRef, charter), charter);
}

function foldFrameIntoMachine<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  frame: Frame<TActorMessage>,
): void {
  for (const message of frame.messages) {
    if (isInstanceMessage(message)) {
      applyInstanceMessage(machine.root, message, machine.charter);
    }
  }
  validateMachineActionStateCompatibility(machine.root, machine.charter);
}

function applyInstanceMessage(
  root: SyntheticRoot<any> | Instance<any>,
  message: InstanceMessage<any>,
  charter: Charter<any>,
): void {
  if (message.kind === "state.patch") {
    const address = { instanceId: message.instanceId, stateKey: message.stateKey };
    const next = patchObject(readStateValue(root, address), message.patch);
    validateStateValue(root, address, next);
    const state = findResolvedState(root, address);
    state.container.value = next;
    return;
  }

  if (message.kind === "state.replace") {
    const address = { instanceId: message.instanceId, stateKey: message.stateKey };
    validateStateValue(root, address, message.value);
    const state = findResolvedState(root, address);
    state.container.value = message.value;
    return;
  }

  if (message.kind === "transition") {
    const instance = findInstance(root, message.instanceId);
    if (!instance) {
      throw new Error(`Unknown instance "${message.instanceId}"`);
    }
    instance.node = hydrateNode(message.node, charter);
    if (message.states) {
      applyStateValueOverrides(root, instance, message.states);
    }
    resolveStates(root);
    return;
  }

  if (message.kind === "spawn") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    parent.children ??= [];
    const spawned = message.children.map((child) => spawnChildToInstance(child, charter));
    parent.children.push(...spawned);
    message.children.forEach((child, index) => {
      const instance = spawned[index];
      if (instance) {
        applySpawnStateOverrides(root, instance, child);
      }
    });
    resolveStates(root);
    return;
  }

  if (message.kind === "attach") {
    const parent = findInstance(root, message.parentInstanceId);
    if (!parent) {
      throw new Error(`Unknown parent instance "${message.parentInstanceId}"`);
    }
    parent.children ??= [];
    parent.children.push(...message.children.map((child) => hydrateInstance(child, charter)));
    resolveStates(root);
    return;
  }

  if (message.kind === "remove") {
    removeInstance(root, message.instanceId);
  }
}

function spawnChildToInstance(child: SpawnChild<any>, charter: Charter<any>): Instance<any> {
  if (!child.id) {
    throw new Error("Spawn child must have an id before folding");
  }
  return {
    id: child.id,
    node: hydrateNode(child.node, charter),
    states: undefined,
    children: child.children?.map((nested) => spawnChildToInstance(nested, charter)),
  };
}

function applySpawnStateOverrides(
  root: SyntheticRoot<any> | Instance<any>,
  instance: Instance<any>,
  child: SpawnChild<any>,
): void {
  if (child.states) {
    applyStateValueOverrides(root, instance, child.states);
  }
  child.children?.forEach((nested, index) => {
    const nestedInstance = instance.children?.[index];
    if (nestedInstance) {
      applySpawnStateOverrides(root, nestedInstance, nested);
    }
  });
}

function applyStateValueOverrides(
  root: SyntheticRoot<any> | Instance<any>,
  instance: Instance<any>,
  values: Record<StateKey, unknown>,
): void {
  for (const [stateKey, value] of Object.entries(values)) {
    const target = stateOverrideTarget(root, instance, stateKey);
    target.states ??= {};
    target.states[stateKey] = { value };
  }
}

function stateOverrideTarget(
  root: SyntheticRoot<any> | Instance<any>,
  instance: Instance<any>,
  stateKey: string,
): Instance<any> {
  const frame = traversalFrames(root).find(
    (candidate) => !candidate.isMember && candidate.concreteInstance === instance,
  );
  const descriptor = frame?.node.state;
  if (!frame || !descriptor || descriptor.key !== stateKey) {
    return instance;
  }
  return descriptor.scope === "local" ? frame.concreteInstance : frame.topInstance;
}

function readStateValue(root: SyntheticRoot<any> | Instance<any>, address: StateAddress): unknown {
  return findResolvedState(root, address).container.value;
}

function validateStateValue(
  root: SyntheticRoot<any> | Instance<any>,
  address: StateAddress,
  value: unknown,
): void {
  const state = findResolvedState(root, address);
  state.descriptor.schema.parse(value);
}

function findResolvedState(root: SyntheticRoot<any> | Instance<any>, address: StateAddress) {
  const state = resolveStates(root).find(
    (candidate) =>
      candidate.address.instanceId === address.instanceId &&
      candidate.address.stateKey === address.stateKey,
  );
  if (!state) {
    throw new Error(`Unknown state "${address.instanceId}:${address.stateKey}"`);
  }
  return state;
}

function stateAddressForFrame(
  frame: ProjectionFrame<any>,
): StateAddress | undefined {
  const descriptor = frame.node.state;
  if (!descriptor) {
    return undefined;
  }
  return {
    instanceId:
      descriptor.scope === "local" ? frame.concreteInstance.id : frame.topInstance.id,
    stateKey: descriptor.key,
  };
}

function patchObject(value: unknown, patch: Record<string, unknown>): unknown {
  return {
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
    ...patch,
  };
}

function findInstance(root: SyntheticRoot<any> | Instance<any>, instanceId: string): Instance<any> | undefined {
  for (const instance of rootInstances(root)) {
    const found = findInstanceInTree(instance, instanceId);
    if (found) return found;
  }
  return undefined;
}

function findInstanceInTree(instance: Instance<any>, instanceId: string): Instance<any> | undefined {
  if (instance.id === instanceId) {
    return instance;
  }
  for (const child of instance.children ?? []) {
    const found = findInstanceInTree(child, instanceId);
    if (found) return found;
  }
  return undefined;
}

function removeInstance(root: SyntheticRoot<any> | Instance<any>, instanceId: string): void {
  if (isSyntheticRoot(root)) {
    const index = root.instances.findIndex((instance) => instance.id === instanceId);
    if (index >= 0) {
      root.instances.splice(index, 1);
      return;
    }
  } else if (root.id === instanceId) {
    throw new Error("Cannot remove the root instance from a non-synthetic root");
  }

  for (const instance of rootInstances(root)) {
    if (removeChildInstance(instance, instanceId)) {
      return;
    }
  }
}

function removeChildInstance(parent: Instance<any>, instanceId: string): boolean {
  const children = parent.children ?? [];
  const index = children.findIndex((child) => child.id === instanceId);
  if (index >= 0) {
    children.splice(index, 1);
    return true;
  }
  return children.some((child) => removeChildInstance(child, instanceId));
}

function rootInstances(root: SyntheticRoot<any> | Instance<any>): Instance<any>[] {
  return isSyntheticRoot(root) ? root.instances : [root];
}

function isSyntheticRoot(root: SyntheticRoot<any> | Instance<any>): root is SyntheticRoot<any> {
  return "type" in root && root.type === "synthetic-root";
}

function containsHydratedNodeData(value: unknown): value is Instance<any>["node"] {
  if (!value || typeof value !== "object") return false;
  const record = value as {
    toolBindings?: unknown;
    commandBindings?: unknown;
    state?: unknown;
    output?: unknown;
    projection?: unknown;
    runtime?: unknown;
    members?: unknown;
  };
  return (
    containsHydratedActions(record.toolBindings) ||
    containsHydratedActions(record.commandBindings) ||
    containsHydratedState(record.state) ||
    containsHydratedOutput(record.output) ||
    typeof record.projection === "function" ||
    containsHydratedRuntime(record.runtime) ||
    containsHydratedMembers(record.members)
  );
}

function containsHydratedActions(actions: unknown): boolean {
  if (!actions || typeof actions !== "object") {
    return false;
  }
  if (Array.isArray(actions)) {
    return actions.some((action) => Boolean(action && typeof action === "object"));
  }
  return Object.values(actions).some((action) =>
    Boolean(action && typeof action === "object")
  );
}

function containsHydratedState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return typeof (state as { schema?: { parse?: unknown } }).schema?.parse === "function";
}

function containsHydratedOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as { mapTextBlock?: unknown; schema?: { parse?: unknown } };
  return typeof record.mapTextBlock === "function" || typeof record.schema?.parse === "function";
}

function containsHydratedRuntime(runtime: unknown): boolean {
  if (!runtime || typeof runtime !== "object") return false;
  const record = runtime as { boundaryProjection?: unknown; historyProjection?: unknown };
  return (
    typeof record.boundaryProjection === "function" ||
    typeof record.historyProjection === "function"
  );
}

function containsHydratedMembers(members: unknown): boolean {
  return Array.isArray(members) &&
    members.some((member) =>
      containsHydratedNodeData(member)
    );
}

function isInstanceMessage(message: unknown): message is InstanceMessage<any> {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type !== "instance" || typeof record.kind !== "string") return false;
  return (
    record.kind === "state.patch" ||
    record.kind === "state.replace" ||
    record.kind === "transition" ||
    record.kind === "spawn" ||
    record.kind === "attach" ||
    record.kind === "remove"
  );
}

class MachineRunImpl<TActorMessage extends AnyActorMessage> implements MachineRun<TActorMessage> {
  private started = false;
  private draining = false;
  private schedulingStopped = false;
  private activeActivations = new Map<string, Promise<void>>();
  private activationErrors: unknown[] = [];

  constructor(
    private readonly machine: ProjectorMachine<TActorMessage>,
    private readonly options: Required<RunMachineOptions>,
  ) {}

  hasStarted(): boolean {
    return this.started;
  }

  isDraining(): boolean {
    return this.draining;
  }

  stopSchedulingWork(): void {
    this.schedulingStopped = true;
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame<TActorMessage>> {
    return this.drain();
  }

  private async *drain(): AsyncGenerator<Frame<TActorMessage>> {
    this.started = true;
    this.draining = true;
    try {
      while (true) {
        if (this.activationErrors.length > 0) {
          throw this.activationErrors.shift();
        }

        const pending = this.machine.pendingFrames.shift();
        if (pending) {
          yield pending;
          continue;
        }

        const reconciled = reconcileYieldedWork(this.machine);
        if (reconciled.length > 0) {
          continue;
        }

        if (this.shouldScheduleWork()) {
          this.startRunnableActivations();
        }

        if (this.machine.pendingFrames.length > 0) {
          continue;
        }
        if (this.activeActivations.size > 0) {
          await Promise.race(this.activeActivations.values());
          continue;
        }

        if (this.activationErrors.length > 0) {
          throw this.activationErrors.shift();
        }

        if (!this.shouldScheduleWork()) {
          return;
        }

        if (collectRunnableActivations(this.machine).length === 0) {
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private startRunnableActivations(): void {
    for (const activation of collectRunnableActivations(this.machine)) {
      if (this.activeActivations.has(activation.activationId)) {
        continue;
      }
      this.startRunnableActivation(activation);
    }
  }

  private startRunnableActivation(activation: Activation): void {
    if (!this.shouldScheduleWork()) return;

    const run = (async () => {
      try {
        await runActivation(this.machine, activation.activationId);
      } catch (error) {
        this.activationErrors.push(error);
      } finally {
        this.activeActivations.delete(activation.activationId);
      }
    })();

    this.activeActivations.set(activation.activationId, run);
  }

  private shouldScheduleWork(): boolean {
    return this.options.scheduleWork && !this.schedulingStopped;
  }
}

function reconcileWorkOnce<TActorMessage extends AnyActorMessage>(
  machine: ProjectorMachine<TActorMessage>,
  options: { skipPendingSources?: boolean } = {},
): Frame<TActorMessage>[] {
  const state = foldWork(machine);
  const appended: Frame<TActorMessage>[] = [];
  const pendingFrameIds = options.skipPendingSources
    ? new Set(machine.pendingFrames.map((frame) => frame.id))
    : undefined;

  for (const activation of state.activations.values()) {
    if (
      !state.completions.has(activation.activationId) &&
      activation.runtimeInstanceId !== SYNTHETIC_ROOT_RUNTIME_ID &&
      !findFrameByRuntimeId(machine.root, activation.runtimeInstanceId)
    ) {
      const frame = machine.enqueueFrame(createCompletionFrame({
        activationId: activation.activationId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
      }));
      appended.push(frame);
      state.completions.set(activation.activationId, {
        type: "work",
        kind: "completion",
        activationId: activation.activationId,
        sourceFrameId: activation.sourceFrameId,
        reason: "cancelled",
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
    }
  }

  for (const sourceFrame of machine.frames.slice()) {
    if (sourceFrame.inert) continue;
    if (pendingFrameIds?.has(sourceFrame.id)) continue;

    const candidates = runtimeCandidatesForSource(machine, sourceFrame, state);
    for (const candidate of candidates) {
      const activationId = activationIdFor({
        machineId: machine.id,
        runtimeInstanceId: candidate.runtimeInstanceId,
        trigger: candidate.trigger,
        sourceFrameId: sourceFrame.id,
      });
      if (state.activations.has(activationId)) continue;

      const frame = machine.enqueueFrame(createActivationFrame({
        activationId,
        runtimeInstanceId: candidate.runtimeInstanceId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
      }));
      appended.push(frame);
      state.activations.set(activationId, {
        type: "work",
        kind: "activation",
        activationId,
        runtimeInstanceId: candidate.runtimeInstanceId,
        generatorId: candidate.generatorId,
        sourceFrameId: sourceFrame.id,
        concurrencyKey: candidate.concurrencyKey,
        concurrency: candidate.concurrency,
        generatorKind: candidate.generatorKind,
        frameId: frame.id,
        frameIndex: machine.frames.length - 1,
      });
      state.generatorRuntimeIds.set(candidate.generatorId, candidate.runtimeInstanceId);
    }
  }

  return appended;
}

function runtimeCandidatesForSource<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  sourceFrame: Frame<TActorMessage>,
  state: WorkState,
): RuntimeCandidate[] {
  const candidates: RuntimeCandidate[] = [];
  const syntheticTrigger = { type: "actor-frame" } satisfies RuntimeTrigger;
  if (
    isSyntheticRoot(machine.root) &&
    !sourceFrameProducedByRuntime(sourceFrame, SYNTHETIC_ROOT_RUNTIME_ID, state) &&
    triggerMatches(
      machine,
      SYNTHETIC_ROOT_RUNTIME_ID,
      syntheticTrigger,
      sourceFrame,
      state,
    )
  ) {
    candidates.push({
      runtimeInstanceId: SYNTHETIC_ROOT_RUNTIME_ID,
      generatorKind: "primary",
      trigger: syntheticTrigger,
      concurrency: "serial",
      concurrencyKey: SYNTHETIC_ROOT_RUNTIME_ID,
      generatorId: SYNTHETIC_ROOT_RUNTIME_ID,
    });
  }

  for (const frame of traversalFrames(machine.root)) {
    if (frame.node.runtime.type !== "primary" && frame.node.runtime.type !== "worker") {
      continue;
    }
    if (
      isSyntheticRoot(machine.root) &&
      machine.root.instances.length === 1 &&
      frame.parent === undefined &&
      frame.node.runtime.type === "primary"
    ) {
      continue;
    }

    const runtime = frame.node.runtime as PrimaryRuntime<TActorMessage> | WorkerRuntime<TActorMessage>;
    if (sourceFrameProducedByRuntime(sourceFrame, frame.runtimeInstanceId, state)) {
      continue;
    }
    const concurrency = runtime.concurrency ?? "serial";
    const generatorId = generatorIdFor(
      frame.runtimeInstanceId,
      runtime.type,
      concurrency,
      sourceFrame.id,
      machine.id,
      runtime.trigger,
    );
    if (!triggerMatches(machine, frame.runtimeInstanceId, runtime.trigger, sourceFrame, state)) {
      continue;
    }

    candidates.push({
      runtimeInstanceId: frame.runtimeInstanceId,
      generatorKind: runtime.type,
      trigger: runtime.trigger,
      concurrency,
      concurrencyKey: concurrency === "parallel"
        ? activationIdFor({
            machineId: machine.id,
            runtimeInstanceId: frame.runtimeInstanceId,
            trigger: runtime.trigger,
            sourceFrameId: sourceFrame.id,
          })
        : frame.runtimeInstanceId,
      generatorId,
    });
  }
  return candidates;
}

function triggerMatches<TActorMessage extends AnyActorMessage>(
  machine: Machine<TActorMessage>,
  runtimeInstanceId: RuntimeInstanceId,
  trigger: RuntimeTrigger,
  sourceFrame: Frame<TActorMessage>,
  state: WorkState,
): boolean {
  if (trigger.type === "actor-frame") {
    const resolveGeneratorRuntimeId = (id: GeneratorId) =>
      state.generatorRuntimeIds.get(id) ?? serialRuntimeIdFromGeneratorId(id);
    return sourceFrame.messages.some((message) =>
      isActorMessage(message) &&
        actorMessageVisibleToRuntime(
          message,
          sourceFrame,
          { runtimeInstanceId },
          resolveGeneratorRuntimeId,
        )
    );
  }

  if (trigger.type === "parent-activation") {
    return sourceFrame.messages.some((message) =>
      isWorkActivationMessage(message) &&
      message.runtimeInstanceId === nearestAncestorRuntimeId(machine.root, runtimeInstanceId)
    );
  }

  if (trigger.type === "parent-completion") {
    return sourceFrame.messages.some((message) => {
      if (!isWorkCompletionMessage(message)) return false;
      const completed = state.activations.get(message.activationId);
      return completed?.runtimeInstanceId === nearestAncestorRuntimeId(machine.root, runtimeInstanceId);
    });
  }

  if (trigger.type === "spawn") {
    return runtimeCreatedByFrame(sourceFrame, runtimeInstanceId);
  }

  return false;
}

function foldWork<TActorMessage extends AnyActorMessage>(machine: Machine<TActorMessage>): WorkState {
  const activations = new Map<string, Activation>();
  const completions = new Map<string, WorkCompletionMessage & { frameId: string; frameIndex: number }>();
  const generatorRuntimeIds = new Map<GeneratorId, RuntimeInstanceId>();

  machine.frames.forEach((frame, frameIndex) => {
    for (const message of frame.messages) {
      if (isWorkActivationMessage(message) && !activations.has(message.activationId)) {
        const projectionFrame = findFrameByRuntimeId(machine.root, message.runtimeInstanceId);
        const runtimeType =
          message.runtimeInstanceId === SYNTHETIC_ROOT_RUNTIME_ID
            ? "primary"
            : projectionFrame?.node.runtime.type;
        if (runtimeType !== "primary" && runtimeType !== "worker") continue;
        activations.set(message.activationId, {
          ...message,
          generatorKind: runtimeType,
          frameId: frame.id,
          frameIndex,
        });
        generatorRuntimeIds.set(message.generatorId, message.runtimeInstanceId);
      }

      if (isWorkCompletionMessage(message) && !completions.has(message.activationId)) {
        completions.set(message.activationId, { ...message, frameId: frame.id, frameIndex });
      }
    }
  });

  return { activations, completions, generatorRuntimeIds };
}

function runtimeCreatedByFrame(
  frame: Frame<any>,
  runtimeInstanceId: RuntimeInstanceId,
): boolean {
  const createdInstanceIds = new Set<string>();
  for (const message of frame.messages) {
    if (!isInstanceMessage(message)) {
      continue;
    }
    if (message.kind === "spawn") {
      collectSpawnedIds(message.children, createdInstanceIds);
    }
    if (message.kind === "attach") {
      collectAttachedIds(message.children, createdInstanceIds);
    }
  }

  if (createdInstanceIds.size === 0) {
    return false;
  }

  const address = runtimeInstanceId.startsWith("member:")
    ? runtimeInstanceId.slice("member:".length).split("/")[0]
    : runtimeInstanceId.startsWith("instance:")
      ? runtimeInstanceId.slice("instance:".length)
      : undefined;
  return Boolean(address && createdInstanceIds.has(address));
}

function collectSpawnedIds(children: readonly SpawnChild<any>[], ids: Set<string>): void {
  for (const child of children) {
    if (child.id) {
      ids.add(child.id);
    }
    collectSpawnedIds(child.children ?? [], ids);
  }
}

function collectAttachedIds(children: readonly SerializedInstance<any>[], ids: Set<string>): void {
  for (const child of children) {
    ids.add(child.id);
    collectAttachedIds(child.children ?? [], ids);
  }
}

function sourceFrameProducedByRuntime(
  frame: Frame<any>,
  runtimeInstanceId: RuntimeInstanceId,
  state: WorkState,
): boolean {
  if (!frame.generatorId) return false;
  const owner = state.generatorRuntimeIds.get(frame.generatorId) ?? serialRuntimeIdFromGeneratorId(frame.generatorId);
  return owner === runtimeInstanceId;
}

function serialRuntimeIdFromGeneratorId(generatorId: GeneratorId): RuntimeInstanceId | undefined {
  if (
    generatorId === SYNTHETIC_ROOT_RUNTIME_ID ||
    generatorId.startsWith("instance:") ||
    generatorId.startsWith("member:")
  ) {
    return generatorId;
  }
  return undefined;
}

function nearestAncestorRuntimeId(
  root: SyntheticRoot<any> | Instance<any>,
  runtimeInstanceId: RuntimeInstanceId,
): RuntimeInstanceId | undefined {
  const frame = findFrameByRuntimeId(root, runtimeInstanceId);
  if (!frame) return undefined;

  let parent = frame.parent;
  while (parent) {
    if (parent.node.runtime.type === "primary" || parent.node.runtime.type === "worker") {
      if (isSyntheticRoot(root) && parent.parent === undefined && parent.node.runtime.type === "primary") {
        return SYNTHETIC_ROOT_RUNTIME_ID;
      }
      return parent.runtimeInstanceId;
    }
    parent = parent.parent;
  }
  return undefined;
}

function generatorIdFor(
  runtimeInstanceId: RuntimeInstanceId,
  kind: "primary" | "worker",
  concurrency: RuntimeConcurrency,
  sourceFrameId: string,
  machineId: string,
  trigger: RuntimeTrigger,
): GeneratorId {
  if (concurrency === "serial") return runtimeInstanceId;
  return `${kind}:${runtimeInstanceId}:${activationIdFor({ machineId, runtimeInstanceId, trigger, sourceFrameId })}`;
}

function activationIdFor({
  machineId,
  runtimeInstanceId,
  trigger,
  sourceFrameId,
}: {
  machineId: string;
  runtimeInstanceId: RuntimeInstanceId;
  trigger: RuntimeTrigger;
  sourceFrameId: string;
}): string {
  return `activation:${hashString(`${machineId}\0${runtimeInstanceId}\0${triggerKey(trigger)}\0${sourceFrameId}`)}`;
}

function triggerKey(trigger: RuntimeTrigger): string {
  return trigger.type;
}

function completionReasonForRuntime(
  runtime: NormalizedRuntime<any>,
  reason: ExecutorRunResult["completionReason"],
): WorkCompletionReason {
  if (reason === "cancelled" || reason === "delegated") return reason;
  if (reason === "error") return "cancelled";
  return runtime.type === "primary" ? "end-turn" : "done";
}

function syntheticRootRuntime(): PrimaryRuntime<any> {
  return {
    type: "primary",
    trigger: { type: "actor-frame" },
    concurrency: "serial",
    activationHistory: "live",
    historyProjection: { type: "messages" },
    boundaryProjection: { mode: "hidden" },
  };
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function nextFrameIndex(frames: Frame<any>[]): number {
  let max = -1;
  for (const frame of frames) {
    const match = /^frame-(\d+)$/.exec(frame.id);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}
