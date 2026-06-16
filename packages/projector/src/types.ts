import type { z } from "zod";

export type ProjectionMode = "hidden" | "augment" | "replace";

export type StaticProjection = {
  mode?: ProjectionMode;
  instructions?: "system" | "dynamic" | "hidden";
  tools?: "provider-static" | "hidden";
};

export type Ref = string;
export type ProjectionFunctionRef = Ref;
export type StateDescriptorRef = Ref;

export type ProjectionContext<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  runtimeInstanceId: RuntimeInstanceId;
  instanceId: InstanceId;
  node: Node<TActorMessage>;
};

export type ProjectionFunction<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = (ctx: ProjectionContext<TActorMessage>) => StaticProjection;

export type Projection<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | StaticProjection
  | ProjectionFunctionRef
  | ProjectionFunction<TActorMessage>;

export type HistoryProjectionFunctionRef = Ref;

export type HistoryProjectionContext<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  target: Generator;
  runtimeInstanceId: RuntimeInstanceId;
  activationId: string;
  trigger: RuntimeTrigger;
  history: Frame<TActorMessage>[];
  states: Record<StateKey, unknown>;
};

export type HistoryProjectionFunction<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  bivarianceHack(
    ctx: HistoryProjectionContext<TActorMessage>,
  ): FrameMessage<TActorMessage>[];
}["bivarianceHack"];

export type ActorHistoryProjection = { type: "actor" };
export type MessageHistoryProjection = { type: "messages" };
export type HistoryProjection<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | ActorHistoryProjection
  | MessageHistoryProjection
  | HistoryProjectionFunctionRef
  | HistoryProjectionFunction<TActorMessage>;

export type GeneratorId = string;
export type RuntimeInstanceId = string;
export type InstanceId = string;
export type StateKey = string;

export type StateAddress = {
  instanceId: InstanceId;
  stateKey: StateKey;
};

export type InferenceStateAddress = string;

export type RetrievableState = {
  address: InferenceStateAddress;
  target: StateAddress;
};

export type AudienceTarget = RuntimeAddress;

export type Audience = "self" | "broadcast" | AudienceTarget | AudienceTarget[];

export type MessageDelivery = "immediate" | "queued";

export type UserMessage<TContent = string> = {
  type: "user";
  content?: TContent;
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type AssistantMessage<TContent = string> = {
  type: "assistant";
  content?: TContent;
  text?: string;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ToolMessage = {
  type: "tool";
  name: string;
  text?: string;
  value?: unknown;
  audience?: Audience;
  delivery?: MessageDelivery;
};

export type ActorMessage<
  TAssistantContent = string,
  TUserContent = string,
> = UserMessage<TUserContent> | AssistantMessage<TAssistantContent> | ToolMessage;

export type AnyActorMessage = ActorMessage<any, any>;

export type DefaultActorMessage = ActorMessage<string>;

export type AssistantMessageOf<TActorMessage> =
  Extract<TActorMessage, { type: "assistant" }>;

export type UserMessageOf<TActorMessage> =
  Extract<TActorMessage, { type: "user" }>;

export type AssistantContentOf<TActorMessage> =
  AssistantMessageOf<TActorMessage> extends { content?: infer C } ? C : never;

export type UserContentOf<TActorMessage> =
  UserMessageOf<TActorMessage> extends { content?: infer C } ? C : never;

export type RuntimeTrigger =
  | { type: "spawn" }
  | { type: "actor-frame" }
  | { type: "parent-activation" }
  | { type: "parent-completion" };

export type RuntimeConcurrency = "serial" | "parallel";
export type ActivationHistory = "live" | "snapshot";

export type TriggeredRuntimeOptions<
  TActorMessage extends AnyActorMessage = DefaultActorMessage,
> = {
  trigger: RuntimeTrigger;
  concurrency?: RuntimeConcurrency;
  activationHistory?: ActivationHistory;
  historyProjection?: HistoryProjection<TActorMessage>;
};

export type ComponentRuntime = { type: "component" };
export type PrimaryRuntime<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  type: "primary";
  boundaryProjection: Projection<TActorMessage>;
} & TriggeredRuntimeOptions<TActorMessage>;
export type WorkerRuntime<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  type: "worker";
  boundaryProjection: Projection<TActorMessage>;
} & TriggeredRuntimeOptions<TActorMessage>;

export type Runtime<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: Projection<TActorMessage>;
    } & TriggeredRuntimeOptions<TActorMessage>)
  | ({
      type: "worker";
      boundaryProjection?: Projection<TActorMessage>;
    } & TriggeredRuntimeOptions<TActorMessage>);

export type NormalizedRuntime<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | ComponentRuntime
  | PrimaryRuntime<TActorMessage>
  | WorkerRuntime<TActorMessage>;

type DryTriggeredRuntimeOptions = Omit<
  TriggeredRuntimeOptions,
  "historyProjection"
> & {
  historyProjection?: DryHistoryProjection;
};

export type DryProjection = StaticProjection | Ref;

export type DryHistoryProjection = ActorHistoryProjection | MessageHistoryProjection | Ref;

export type DryRuntime =
  | { type?: "component" }
  | ({
      type: "primary";
      boundaryProjection?: DryProjection;
    } & DryTriggeredRuntimeOptions)
  | ({
      type: "worker";
      boundaryProjection?: DryProjection;
    } & DryTriggeredRuntimeOptions);

export type StateProjection = "system" | "dynamic" | "retrieval" | "hidden";

export type StateDescriptor<S = unknown> = {
  key: string;
  schema: z.ZodType<S>;
  init?: S | (() => S);
  scope?: "top" | "local";
  onInitConflict?: "error" | "replace";
  projection?: StateProjection;
};

export type NormalizedStateDescriptor<S = unknown> = StateDescriptor<S> & {
  scope: "top" | "local";
  onInitConflict: "error" | "replace";
  projection: StateProjection;
};

export type StateContainer<S = unknown> = {
  value: S;
};

type IsAny<T> = 0 extends (1 & T) ? true : false;

export type StatePatch<S> = IsAny<S> extends true
  ? Record<string, unknown>
  : [unknown] extends [S]
      ? Record<string, unknown>
      : S extends object
        ? Partial<S>
        : never;

type ActionStateContext<S> = IsAny<S> extends true
  ? {
      state?: S;
      patchState?(patch: StatePatch<S>): void;
      replaceState?(value: S): void;
    }
  : [S] extends [undefined]
  ? {
      state?: undefined;
      patchState?: undefined;
      replaceState?: undefined;
    }
  : {
      state?: S;
      patchState?(patch: StatePatch<S>): void;
      replaceState?(value: S): void;
    };

export type ActionContext<S = undefined> = {
  getState?: (address: InferenceStateAddress) => unknown;
} & ActionStateContext<S>;

export type Action<
  S = undefined,
  I = unknown,
  O = unknown,
  TName extends string = string,
> = {
  state: StateDescriptor<S> | null;
  name: TName;
  description?: string;
  inputSchema?: z.ZodType<I>;
  run?: (input: I, ctx: ActionContext<S>) => O | Promise<O>;
};

export type AnyAction = {
  state: StateDescriptor<any> | null;
  name: string;
  description?: string;
  inputSchema?: z.ZodType<any>;
  run?: (input: any, ctx: any) => any | Promise<any>;
};

export type ActionRef = string;
export type ActionConfigEntry = AnyAction | ActionRef;
export type ActionBindings = Record<string, AnyAction>;

export type NodeConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key?: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  tools?: ActionConfigEntry[];
  commands?: ActionConfigEntry[];
  state?: StateDescriptor;
  members?: Node<TActorMessage>[];
  output?: OutputConfig<TActorMessage>;
  projection?: Projection<TActorMessage>;
  runtime?: Runtime<TActorMessage>;
};

export type Node<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  toolBindings: ActionBindings;
  toolRefs: ActionRef[];
  commandBindings: ActionBindings;
  commandRefs: ActionRef[];
  state?: NormalizedStateDescriptor;
  members: Node<TActorMessage>[];
  output?: OutputConfig<TActorMessage>;
  projection: Projection<TActorMessage>;
  runtime: NormalizedRuntime<TActorMessage>;
};

export type Instance<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: string;
  node: Node<TActorMessage>;
  states?: Record<string, StateContainer>;
  children?: Instance<TActorMessage>[];
};

export type CompletionReason = "done" | "cancelled" | "delegated" | "error";

export type WorkCompletionReason = "end-turn" | "done" | "cancelled" | "delegated";

export type WorkActivationMessage = {
  type: "work";
  kind: "activation";
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  generatorId: GeneratorId;
  sourceFrameId: string;
  concurrencyKey: string;
  concurrency: RuntimeConcurrency;
};

export type WorkCompletionMessage = {
  type: "work";
  kind: "completion";
  activationId: string;
  sourceFrameId?: string;
  reason: WorkCompletionReason;
};

export type WorkMessage = WorkActivationMessage | WorkCompletionMessage;

export type SerializedNodeRef<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | DryNode<TActorMessage>
  | Ref;

/**
 * Durable instance messages use serialized node refs. Hydrated Node objects belong
 * in the live machine tree, not in frames that may be persisted and resumed.
 */
export type SpawnChild<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id?: InstanceId;
  node: SerializedNodeRef<TActorMessage>;
  states?: Record<StateKey, unknown>;
  children?: SpawnChild<TActorMessage>[];
};

export type InstanceMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  | {
      type: "instance";
      kind: "state.patch";
      instanceId: InstanceId;
      stateKey: StateKey;
      patch: Record<string, unknown>;
    }
  | {
      type: "instance";
      kind: "state.replace";
      instanceId: InstanceId;
      stateKey: StateKey;
      value: unknown;
    }
  | {
      type: "instance";
      kind: "transition";
      instanceId: InstanceId;
      node: SerializedNodeRef<TActorMessage>;
      states?: Record<StateKey, unknown>;
    }
  | {
      type: "instance";
      kind: "spawn";
      parentInstanceId: InstanceId;
      children: SpawnChild<TActorMessage>[];
    }
  | {
      type: "instance";
      kind: "attach";
      parentInstanceId: InstanceId;
      children: SerializedInstance<TActorMessage>[];
    }
  | {
      type: "instance";
      kind: "remove";
      instanceId: InstanceId;
      reason?: "removed" | "cede" | "cancelled";
    };

export type CommandMessage = {
  type: "command";
  name: string;
  input: unknown;
  target?: RuntimeAddress;
  clientId?: string;
};

export type FrameMessage<TActorMessage extends AnyActorMessage = DefaultActorMessage> = (
  | TActorMessage
  | CommandMessage
  | InstanceMessage<TActorMessage>
  | WorkMessage
) &
  Record<string, unknown>;

export type FrameDraft<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  generatorId?: string;
  runtimeInstanceId?: RuntimeInstanceId;
  activationId?: string;
  inert?: boolean;
  messages: FrameMessage<TActorMessage>[];
  metadata?: Record<string, unknown>;
};

export type Frame<TActorMessage extends AnyActorMessage = DefaultActorMessage> = FrameDraft<TActorMessage> & {
  id: string;
};

/**
 * Output configuration for implicit LLM text responses.
 * @typeParam TActorMessage - The application actor message type this output maps to.
 */
export type OutputConfig<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  audience?: Audience;
  schema?: z.ZodType<AssistantContentOf<TActorMessage>>;
  mapTextBlock?: (text: string) => AssistantContentOf<TActorMessage>;
};

export type AnyOutputConfig = OutputConfig<any>;

export type EnqueueFrame<TActorMessage extends AnyActorMessage = DefaultActorMessage> = (
  frame: FrameDraft<TActorMessage>,
) => Frame<TActorMessage> | Promise<Frame<TActorMessage>>;

export type ExecutorRunRequest<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  generatorId: string;
  activationId: string;
  runtimeInstanceId: RuntimeInstanceId;
  inference: CompiledInference<TActorMessage>;
  enqueueFrame: EnqueueFrame<TActorMessage>;
  createActionContext?: (action: AnyAction) => ActionContext<unknown>;
  output?: OutputConfig<TActorMessage>;
  signal?: AbortSignal;
};

export type ExecutorRunResult<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  completionReason: CompletionReason;
  value?: string;
  frames?: Array<FrameDraft<TActorMessage> | Frame<TActorMessage>>;
};

export type ProjectorExecutor<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  run(
    request: ExecutorRunRequest<TActorMessage>,
  ): ExecutorRunResult<TActorMessage> | Promise<ExecutorRunResult<TActorMessage>>;
};

export type Executor<TActorMessage extends AnyActorMessage = DefaultActorMessage> =
  ProjectorExecutor<TActorMessage>;

export type Charter<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key?: string;
  version?: string;
  executor: ProjectorExecutor<TActorMessage>;
  nodes: Record<string, Node<TActorMessage>>;
  tools: Record<string, AnyAction>;
  commands: Record<string, AnyAction>;
  states: Record<string, NormalizedStateDescriptor>;
  projections: Record<string, ProjectionFunction<TActorMessage>>;
  historyProjections?: Record<string, HistoryProjectionFunction<TActorMessage>>;
};

export type CompiledInference<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  systemParts: string[];
  history: FrameMessage<TActorMessage>[];
  dynamicParts: string[];
  tools: AnyAction[];
  retrievableStates: RetrievableState[];
};

export type RuntimeAddress =
  | { type: "instance"; instanceId: string }
  | { type: "member"; ownerInstanceId: string; memberPath: string[] };

export type GeneratorKind = "primary" | "worker";

export type Generator = {
  id: GeneratorId;
  kind: GeneratorKind;
  runtimeInstanceId: RuntimeInstanceId;
};

export type SerializedStateDescriptor = {
  key: string;
  scope?: "top" | "local";
  onInitConflict?: "error" | "replace";
  projection?: StateProjection;
  init?: unknown;
  schema: unknown;
};

export type DryAction = Ref;

export type DryNode<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  key: string;
  sourceNodeKey?: string;
  name?: string;
  instructions?: string;
  tools?: DryAction[];
  commands?: DryAction[];
  state?: SerializedStateDescriptor | Ref;
  members?: Array<DryNode<TActorMessage> | Ref>;
  output?: SerializedOutputConfig;
  projection?: DryProjection;
  runtime?: DryRuntime;
};

export type SerializedInstance<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  id: InstanceId;
  node: DryNode<TActorMessage> | Ref;
  states?: Record<StateKey, StateContainer>;
  children?: SerializedInstance<TActorMessage>[];
};

export type SerializedOutputConfig = {
  audience?: Audience;
  schema?: unknown;
};
