// The site agent: projector introducing itself, built with itself.
// Deliberately small for the first pass — one node, one state, one tool —
// but every piece is real: the conversation is a frame log, the audience
// read is durable state, and the client renders a projection of the same
// machine the executor runs.

import {
  action,
  createAction,
  createCharter,
  createNode,
  createRoot,
  createSourceInstance,
  createState,
  hydrateInstance,
  patchState,
  recencyRegion,
  resolveStates,
  serializeInstance,
  type Instance,
  type SerializedInstance,
} from "@projectors/core";
import {
  createMachineClientSnapshot,
  realizeClientInstances,
} from "@projectors/core/client";
import { z } from "zod";

export const SITE_SOURCE_INSTANCE_ID = "guide";

const siteParamsSchema = z.object({
  sessionId: z.string(),
});

// The agent's read of who it's talking to. Inferred from conversation, never
// asked. Durable so the adaptation survives refresh — and so it can later be
// revealed in the inspector as a worked example of state.
const audienceSchema = z.object({
  mode: z.enum(["unknown", "object-level", "vision"]),
  note: z.string(),
});

export const audienceState = createState({
  key: "audience",
  schema: audienceSchema,
  init: { mode: "unknown", note: "" } satisfies z.infer<typeof audienceSchema>,
  projection: { slot: recencyRegion },
});

const noteAudience = createAction({
  state: audienceState,
  name: "noteAudience",
  description:
    "Record your evolving read of this visitor: are they thinking at the object level (implementation, how it works) or at the vision level (what evolutionary software means)? Update whenever your read firms up or changes. This is durable state — it survives refresh and shows up in the frame log.",
  inputSchema: audienceSchema.partial(),
  run: (input, ctx) => {
    ctx.updateState?.(patchState(input));
    return "noted";
  },
});

// The shell's chrome as machine state: which side panes are open. One action,
// caller "any", so it is simultaneously the agent's tool and the client's
// command — the minimize buttons and the model manipulate the same durable
// state, and the inspector shows both doing it.
const panesSchema = z.object({
  // Left pane: the app surface, where agent-authored UI will render.
  app: z.boolean(),
  // Right pane: the machine inspector (frame log + projected state).
  inspector: z.boolean(),
});

export const panesState = createState({
  key: "panes",
  schema: panesSchema,
  init: { app: false, inspector: true } satisfies z.infer<typeof panesSchema>,
  projection: { slot: recencyRegion },
});

const setPanes = createAction({
  state: panesState,
  name: "setPanes",
  description:
    "Open or close the shell's side panes. The right pane is the machine inspector; open it when you point the visitor at the frame log or your state. The left pane is the app surface where your dynamic UI will render — it is empty scaffolding today, so only open it when asked. Partial input: pass just the pane you're changing.",
  inputSchema: panesSchema.partial(),
  run: (input, ctx) => {
    ctx.updateState?.(patchState(input));
    return "ok";
  },
});

const uiNode = createNode({
  key: "ui",
  name: "site ui",
  states: [panesState],
  parts: [action(setPanes, "any")],
  instructions:
    "The conversation shell has two side panes whose visibility lives in the panes state: an inspector on the right and an (empty for now) app surface on the left. The visitor toggles them with buttons and cmd+j; you can too, with setPanes. Both routes write the same durable state.",
});

const guideNode = createNode({
  key: "guide",
  name: "projector guide",
  params: siteParamsSchema,
  states: [audienceState],
  tools: [noteAudience],
  instructions: `You are projector's introduction agent — and you are yourself a projector machine. The conversation you're having is a durable frame log; this prompt is a compiled projection of registered state and parts; the tool you hold writes state that the visitor can watch change. When you talk about projector you are also talking about yourself, and you should use that honestly and lightly — never cute, never labored.

What projector is: an agent framework for state-complete agents. The core claims:
- State complete: the agent is described entirely by recoverable application state. No hidden context living only in a transcript.
- Durable frame log: every meaningful transition is a frame. Replay the log and you are back exactly where you were — inspectable, auditable, time-travelable.
- Projections: agents are multiplayer apps. The user and the LLM are the first two actors; each sees the slice of state, tools, and instructions meant for them. Same world, different views.
- Client/server unified: client and server are typesafe representations of the same machine, so UI, optimistic updates, and the model's context can never quietly drift apart.

Who you're talking to: visitors arrive from the marketing page. Some think at the object level (how does it work — frames, projections, compile, executors); some think at the vision level (what it means for software to be grown and evolved by agents at runtime). Do not ask which they are — infer it from how they talk, adapt your register, and record your read with the noteAudience tool as it firms up. The two tracks converge: every vision claim should have a concrete "here's how that actually works" behind it, and every mechanism should ladder up to why it matters.

How to behave:
- Be quietly competent. Explain concepts plainly and concretely; reveal depth on demand rather than performing it.
- Ground claims in what the visitor can see: there is an inspector beside this conversation showing the frame log and your state. When you change state (like noting your audience read), you may point at it.
- This demo is early. Today you can converse, hold durable state, and be inspected. Growing new capabilities live (spawning child machines with their own state, commands, and UI — "can you be my todo app?") is coming; if asked, describe how it will work rather than pretending to do it.
- Some conversations open with a prebuilt rich explainer (a diagram card) persisted into the frame log as an assistant turn of yours. Treat it as something you genuinely said and build on it — don't re-explain what it already covered.
- Voice is coming soon; the mic button is a stub.
- Keep responses tight. Short paragraphs, no headers unless genuinely structural, no bullet-point avalanches.`,
});

export const siteCharter = createCharter({
  key: "site",
  version: "0.0.1",
  params: siteParamsSchema,
  nodes: [guideNode, uiNode],
  tools: [noteAudience],
  actions: [setPanes],
  states: [audienceState, panesState],
});

// --- Instance lifecycle. The durable artifact is the serialized SOURCE
// instance; the machine root is rebuilt from (source, params) on every load.

export const createInitialSourceInstance = (): Instance => {
  const instance = createSourceInstance({
    id: SITE_SOURCE_INSTANCE_ID,
    node: guideNode,
    children: [{ id: "ui", node: uiNode }],
  });
  resolveStates(instance);
  return instance;
};

export const createInitialSerializedInstance = (): SerializedInstance =>
  serializeInstance(createInitialSourceInstance(), siteCharter);

export const hydrateSourceInstance = (serialized: SerializedInstance): Instance => {
  const instance = hydrateInstance(serialized, siteCharter);
  resolveStates(instance);
  return instance;
};

export const serializeSourceInstance = (instance: Instance): SerializedInstance => {
  resolveStates(instance);
  return serializeInstance(instance, siteCharter);
};

export const createSiteMachineRoot = (source: Instance, sessionId: string): Instance => {
  const root = createRoot(siteCharter, [source], { sessionId });
  resolveStates(root);
  return root;
};

export const hydrateSiteInstance = (
  serialized: SerializedInstance,
  sessionId: string,
): Instance => createSiteMachineRoot(hydrateSourceInstance(serialized), sessionId);

export const createSiteClientSnapshot = (
  serialized: SerializedInstance,
  syncState?: unknown,
) =>
  createMachineClientSnapshot(
    realizeClientInstances(hydrateSourceInstance(serialized), { charter: siteCharter }),
    syncState as never,
  );
