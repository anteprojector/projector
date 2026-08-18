// The conversation: chat column + inspector. Same paper and ink as the
// marketing page — the visitor should feel like the page folded into an app,
// not like they navigated somewhere else.

import { ConvexProvider, ConvexReactClient, useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { EXPLAINERS } from "./explainers";
import { Inspector } from "./Inspector";

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

function AppNav({ sessionId }: { sessionId?: string }) {
  const exit = (e: React.MouseEvent) => {
    e.preventDefault();
    if (history.state?.app) history.back();
    else location.assign("/");
  };
  return (
    <header className="app-nav">
      <a className="app-brand" href="/" onClick={exit}>projector</a>
      {sessionId && <span className="app-nav-session">s/{sessionId.slice(0, 12)}</span>}
      <span className="app-nav-spacer" />
      <a className="app-brand" style={{ viewTransitionName: "none" }} href="https://github.com/markov-machines/markov-machines" aria-label="GitHub">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.53 15.6c.4.07.55-.18.55-.39v-1.36c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.88.5-1.08-1.77-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.66 7.66 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.39A8 8 0 0 0 8 0Z"/></svg>
      </a>
    </header>
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
            <p className="app-composer-hint">
              every turn is a frame in a durable log — refresh and nothing is lost
            </p>
          </form>
        </div>
        <Inspector sessionId={sessionId} />
      </div>
    </div>
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
