// The conversation: chat column + inspector. Same paper and ink as the
// marketing page — the visitor should feel like the page folded into an app,
// not like they navigated somewhere else.

import { ConvexProvider, ConvexReactClient, useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EXPLAINERS } from "./explainers";
import { Inspector, PaneIcon } from "./Inspector";

// The side panes' visibility is machine state (the ui node's panes state in
// the charter): the client keeps a local mirror for instant toggles, sends a
// setPanes command so the change lands in the durable log, and reconciles to
// whatever the machine says — the agent holds the same action as a tool.
type Panes = { app: boolean; inspector: boolean };
const DEFAULT_PANES: Panes = { app: false, inspector: true };

function findPanesState(value: unknown): Panes | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as {
    states?: Array<{ key?: string; value?: unknown }>;
    children?: unknown[];
  };
  const entry = Array.isArray(record.states)
    ? record.states.find((s) => s?.key === "panes")
    : undefined;
  const v = entry?.value as Partial<Panes> | undefined;
  if (v && typeof v.app === "boolean" && typeof v.inspector === "boolean") {
    return { app: v.app, inspector: v.inspector };
  }
  for (const child of record.children ?? []) {
    const found = findPanesState(child);
    if (found) return found;
  }
  return undefined;
}

type AppProps = {
  client: ConvexReactClient | null;
  initialMessage?: string;
  initialTopic?: string;
  sessionId?: string;
};

export function App({ client, initialMessage, initialTopic, sessionId }: AppProps) {
  if (!client) {
    return (
      <div className="app">
        <AppNav />
        <div className="app-body">
          <div className="app-chat">
            <div className="app-scroll">
              <div className="app-thread">
                <div className="msg">
                  <span className="msg-role">setup</span>
                  <p className="msg-body">
                    The conversation backend isn't configured yet. Set{" "}
                    <code>VITE_CONVEX_URL</code> in <code>apps/site/.env.local</code> and run{" "}
                    <code>npx convex dev</code> — see apps/site/README.md.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <ConvexProvider client={client}>
      <Conversation
        initialMessage={initialMessage}
        initialTopic={initialTopic}
        sessionId={sessionId}
      />
    </ConvexProvider>
  );
}

// The marketing header, continued: same brand, same two CTA steps centered,
// same Why/Docs/theme cluster on the right — the page folded into an app, so
// the chrome shouldn't change vocabulary.
function AppNav({ sessionId }: { sessionId?: string }) {
  const exit = (e: React.MouseEvent) => {
    e.preventDefault();
    if (history.state?.app) history.back();
    else location.assign("/");
  };
  return (
    <header className="app-nav">
      <div className="app-nav-left">
        <a className="app-brand" href="/" onClick={exit}>projector</a>
        {sessionId && <span className="app-nav-session">s/{sessionId.slice(0, 12)}</span>}
      </div>
      <div className="start" aria-label="Project actions">
        <div className="steps">
          <InstallStep />
          <a className="step" href="https://github.com/markov-machines/markov-machines">
            <span className="step-body"><span className="step-label">GitHub</span><code>Star</code></span>
            <span className="step-act step-stars"><svg className="i-star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.9 6 6.5.9-4.7 4.6 1.1 6.5L12 17.9 6.2 21l1.1-6.5L2.6 9.9 9.1 9z"/></svg><span className="count">1</span><span className="vh">stars</span></span>
          </a>
        </div>
      </div>
      <nav className="nav-links app-nav-links">
        <a href="/#why">Why</a>
        <a href="/#docs">Docs</a>
        <ThemeToggle />
      </nav>
    </header>
  );
}

function InstallStep() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("npm i @projectors/core");
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {}
  };
  return (
    <button className="step" type="button" data-copied={copied ? "" : undefined} onClick={() => void copy()}>
      <span className="step-body"><span className="step-label">Install</span><code>npm i @projectors/core</code></span>
      <span className="step-act"><span className="vh">Copy</span><svg className="i-copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><svg className="i-done" viewBox="0 0 24 24" aria-hidden="true"><path d="m4.5 12.5 5 5 10-11"/></svg></span>
    </button>
  );
}

// Mirrors the marketing page's toggle: flip from whatever is in effect,
// persist the choice, and keep the (hidden) marketing button's icon in sync
// so nothing is stale when the visitor goes back.
function ThemeToggle() {
  const effective = () =>
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [mode, setMode] = useState(effective);
  useEffect(() => {
    const sysDark = matchMedia("(prefers-color-scheme: dark)");
    const paint = () => setMode(effective());
    sysDark.addEventListener("change", paint);
    return () => sysDark.removeEventListener("change", paint);
  }, []);
  const toggle = () => {
    const next = effective() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    const pageButton = document.querySelector(".page .theme");
    pageButton?.setAttribute("data-mode", next);
    pageButton?.setAttribute("aria-label", `Theme: ${next}`);
    setMode(next);
  };
  return (
    <button className="theme" type="button" data-mode={mode} aria-label={`Theme: ${mode}`} onClick={toggle}>
      <svg className="i-light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3.1"/><path d="M8 .9v1.8M8 13.3v1.8M15.1 8h-1.8M2.7 8H.9M13 3l-1.3 1.3M4.3 11.7 3 13M13 13l-1.3-1.3M4.3 4.3 3 3"/></svg>
      <svg className="i-dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A6 6 0 1 1 6.4 2.5a4.8 4.8 0 0 0 7.1 7.1Z"/></svg>
      <svg className="i-drop" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6c2.7 3 4.4 5.2 4.4 7.1a4.4 4.4 0 0 1-8.8 0c0-1.9 1.7-4.1 4.4-7.1Z"/></svg>
    </button>
  );
}

type LocalMessage = {
  key: string;
  role: "user" | "assistant";
  content: string;
  pending?: boolean;
};

function Conversation({ initialMessage, initialTopic, sessionId: sessionIdProp }: {
  initialMessage?: string;
  initialTopic?: string;
  sessionId?: string;
}) {
  const [sessionId, setSessionId] = useState<Id<"sessions"> | null>(
    (sessionIdProp as Id<"sessions">) ?? null,
  );
  const [optimistic, setOptimistic] = useState<LocalMessage[]>([]);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [input, setInput] = useState("");

  const createSession = useMutation(api.sessions.create);
  const sendMessage = useAction(api.agent.sendMessage);
  const openTopic = useMutation(api.topics.open);
  const sendCommand = useMutation(api.sessions.sendCommand);

  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip");
  const [panes, setPanes] = useState<Panes>(DEFAULT_PANES);
  const serverPanes = findPanesState(
    (session as { clientSnapshot?: { instance?: unknown } } | undefined)?.clientSnapshot?.instance,
  );
  const serverPanesKey = serverPanes ? `${serverPanes.app}:${serverPanes.inspector}` : "";
  useEffect(() => {
    if (serverPanesKey) {
      const [app, inspector] = serverPanesKey.split(":");
      setPanes({ app: app === "true", inspector: inspector === "true" });
    }
  }, [serverPanesKey]);

  const panesRef = useRef(panes);
  panesRef.current = panes;
  const togglePane = useCallback(
    (pane: keyof Panes) => {
      const next = !panesRef.current[pane];
      setPanes((p) => ({ ...p, [pane]: next }));
      if (!sessionId) return;
      void sendCommand({
        sessionId,
        message: {
          type: "action",
          kind: "request",
          action: "command",
          name: "setPanes",
          input: { [pane]: next },
          callId: crypto.randomUUID(),
        },
      });
    },
    [sessionId, sendCommand],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        togglePane("inspector");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [togglePane]);

  const serverMessages = useQuery(
    api.messages.list,
    sessionId ? { sessionId } : "skip",
  );

  const send = useCallback(
    async (text: string, topic?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setOptimistic((prev) => [
        ...prev,
        { key: `opt-${Date.now()}-${prev.length}`, role: "user", content: trimmed },
      ]);
      setWaitingSince(Date.now());
      let id = sessionId;
      if (!id) {
        id = await createSession({});
        setSessionId(id);
        history.replaceState({ app: true }, "", `/s/${id}`);
      }
      try {
        // A topic turn is prebuilt server-side — a rich explainer lands as a
        // real frame with no model call, so the answer is effectively instant.
        if (topic) await openTopic({ sessionId: id, topic, ask: trimmed });
        else await sendMessage({ sessionId: id, text: trimmed });
      } finally {
        setWaitingSince(null);
      }
    },
    [sessionId, createSession, sendMessage, openTopic],
  );

  // The message typed on the marketing page is the first turn. StrictMode
  // double-invokes effects in dev; the ref makes the send once-only.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (initialMessage) void send(initialMessage, initialTopic);
    else if (!sessionId) {
      void createSession({}).then((id) => {
        setSessionId(id);
        history.replaceState({ app: true }, "", `/s/${id}`);
      });
    }
  }, [initialMessage, initialTopic, sessionId, send, createSession]);

  // Server truth replaces optimism as soon as it covers it: any optimistic
  // user message whose text has landed server-side is dropped.
  const server = serverMessages ?? [];
  const visibleOptimistic = optimistic.filter(
    (o) => !server.some((m) => m.role === o.role && m.content === o.content),
  );
  const streaming = server.some((m) => m.streamState === "streaming");
  const thinking = waitingSince !== null && !streaming;

  // One turn at a time: less a chat feed than pages with an input at the
  // bottom. When the speaker changes, the new turn scrolls to the top of the
  // screen and everything before it becomes history above the fold;
  // consecutive messages from the same speaker accumulate below the current
  // page top without re-paging. turnCount only moves on a speaker switch, so
  // optimistic→server row swaps and streaming growth never re-trigger the
  // sync. The thinking placeholder is not a turn — the page flips when the
  // agent actually starts saying something.
  const rendered = [
    ...server.map((m) => ({
      key: m.id,
      role: m.role,
      content: m.content,
      widget: m.widget,
      pending: m.streamState === "streaming",
    })),
    ...visibleOptimistic.map((m) => ({
      key: m.key,
      role: m.role,
      content: m.content,
      widget: undefined as string | undefined,
      pending: false,
    })),
  ];
  let turnCount = 0;
  const items = rendered.map((m, i) => {
    const turnStart = i === 0 || rendered[i - 1].role !== m.role;
    if (turnStart) turnCount += 1;
    return { ...m, turnStart };
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const syncedOnce = useRef(false);
  useEffect(() => {
    if (turnCount === 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const starts = container.querySelectorAll<HTMLElement>("[data-turn-start]");
    const target = starts[starts.length - 1];
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop -
      24; // breathing room above the page top
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollTo({
      top: Math.max(0, top),
      // The first sync (loading an existing session) is a cut, not a scroll.
      behavior: syncedOnce.current && !still ? "smooth" : "instant",
    });
    syncedOnce.current = true;
  }, [turnCount]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(input);
    setInput("");
  };

  return (
    <div className="app">
      <AppNav sessionId={sessionId ?? undefined} />
      <div className="app-body">
        {/* The pane toggles live at the body's top corners, never in the nav.
            Fixed in place: over an open pane's header they read as minimize,
            over the chat they read as open — same button, same spot. */}
        <button
          className="pane-btn pane-toggle pane-toggle-left"
          type="button"
          aria-label="Toggle app pane"
          aria-pressed={panes.app}
          onClick={() => togglePane("app")}
        >
          <PaneIcon side="left" />
        </button>
        <button
          className="pane-btn pane-toggle pane-toggle-right"
          type="button"
          aria-label="Toggle inspector (⌘J)"
          title="⌘J"
          aria-pressed={panes.inspector}
          onClick={() => togglePane("inspector")}
        >
          <PaneIcon side="right" />
        </button>
        {panes.app && <AppPane />}
        <div className="app-chat">
          <div className="app-scroll" ref={scrollRef}>
            <div className="app-thread">
              {items.map((m) => (
                <Message
                  key={m.key}
                  role={m.role}
                  content={m.content}
                  widget={m.widget}
                  pending={m.pending}
                  turnStart={m.turnStart}
                  onAsk={send}
                />
              ))}
              {thinking && <Message role="assistant" content="" pending />}
            </div>
          </div>
          <form className="app-composer" onSubmit={submit} autoComplete="off">
            <div className="talk-card">
              <input
                className="talk-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="ask projector…"
                spellCheck={false}
                enterKeyHint="send"
                aria-label="Message projector"
                autoFocus
              />
              <button className="talk-mic" type="button" disabled title="voice — coming soon" aria-label="Voice input, coming soon">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>
              </button>
              <button className="talk-go" type="submit" aria-label="Send">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>
              </button>
            </div>
          </form>
        </div>
        {panes.inspector && <Inspector sessionId={sessionId} />}
      </div>
    </div>
  );
}

// The left pane: the app surface, where the agent will draw dynamic UI.
// Empty scaffolding for now — the pane exists so its visibility is real
// machine state before anything renders into it.
function AppPane() {
  return (
    <aside className="app-pane" aria-label="App pane">
      <div className="app-pane-head">
        <span className="app-pane-title">app</span>
      </div>
      <div className="app-pane-body">
        <p className="inspector-empty">nothing here yet — the agent draws UI into this pane</p>
      </div>
    </aside>
  );
}

function Message({ role, content, widget, pending, turnStart, onAsk }: {
  role: "user" | "assistant";
  content: string;
  widget?: string;
  pending?: boolean;
  turnStart?: boolean;
  onAsk?: (text: string) => void;
}) {
  // A widget message renders its rich explainer in place of the prose (the
  // prose is the LLM-facing equivalent). Unknown widget ids fall back to it.
  const Explainer = widget ? EXPLAINERS[widget] : undefined;
  return (
    <div
      className={`msg msg-${role}${pending ? " msg-pending" : ""}`}
      data-turn-start={turnStart ? "" : undefined}
    >
      <span className="msg-role">{role === "user" ? "you" : "projector"}</span>
      {Explainer && onAsk
        ? <Explainer onAsk={(text) => void onAsk(text)} />
        : <p className="msg-body">{content}</p>}
    </div>
  );
}
