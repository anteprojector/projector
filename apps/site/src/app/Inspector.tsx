// The machine, visible: frame log + projected state beside the conversation.
// Deliberately spare for the first pass — mono rows in the terminal box's
// vocabulary. The agent references this panel when it talks about itself.

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type Tab = "frames" | "state";

// The t3-style sidebar glyph: a panel outline with the divider on the side
// the pane lives on. Shared by the nav toggles and the pane minimize buttons.
export function PaneIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={side === "left" ? "M9 3v18" : "M15 3v18"} />
    </svg>
  );
}

export function Inspector({ sessionId, width, onResizeStart }: {
  sessionId: Id<"sessions"> | null;
  width?: number;
  onResizeStart?: (e: React.PointerEvent) => void;
}) {
  const [tab, setTab] = useState<Tab>("frames");
  const frames = useQuery(api.sessions.listFrames, sessionId ? { sessionId } : "skip");
  const session = useQuery(api.sessions.get, sessionId ? { sessionId } : "skip");

  return (
    <aside
      className="app-inspector"
      aria-label="Machine inspector"
      style={width !== undefined ? { width: `min(${width}rem, 42vw)` } : undefined}
    >
      {onResizeStart && <div className="pane-resize pane-resize-inspector" onPointerDown={onResizeStart} />}
      <div className="app-inspector-head">
        <button type="button" data-active={tab === "frames" ? "" : undefined} onClick={() => setTab("frames")}>
          frames
        </button>
        <button type="button" data-active={tab === "state" ? "" : undefined} onClick={() => setTab("state")}>
          state
        </button>
      </div>
      <div className="app-inspector-body">
        {tab === "frames" ? <FrameLog frames={frames} /> : <StateView session={session} />}
      </div>
    </aside>
  );
}

type FrameDoc = {
  id: string;
  createdAt: number;
  generatorId?: string | null;
  messages: unknown[];
};

function describeMessage(message: unknown): { kind: string; cls: string; detail: string } {
  const m = message as Record<string, unknown>;
  const type = typeof m?.type === "string" ? (m.type as string) : "frame";
  if (type === "user") return { kind: "user.message", cls: "m", detail: String(m.text ?? "") };
  if (type === "assistant") return { kind: "agent.say", cls: "m", detail: String(m.text ?? "") };
  if (type === "action" && m.kind === "request") {
    return { kind: `agent.${m.action ?? "action"}`, cls: "m", detail: String(m.name ?? "") };
  }
  if (type === "action" && m.kind === "result") {
    return { kind: "action.result", cls: "g", detail: String(m.name ?? "") };
  }
  if (type === "instance") return { kind: "state.update", cls: "b", detail: String((m as any).stateKey ?? "") };
  if (type === "work") return { kind: "work", cls: "l", detail: String((m as any).kind ?? "") };
  return { kind: type, cls: "l", detail: "" };
}

function FrameLog({ frames }: { frames: FrameDoc[] | undefined }) {
  if (!frames) return <p className="inspector-empty">…</p>;
  if (frames.length === 0) return <p className="inspector-empty">no frames yet</p>;
  const rows: Array<{ key: string; seq: string; kind: string; cls: string; detail: string }> = [];
  frames.forEach((frame, fi) => {
    if (frame.messages.length === 0) {
      rows.push({ key: frame.id, seq: pad(fi, 0), kind: "init", cls: "l", detail: "" });
      return;
    }
    frame.messages.forEach((message, mi) => {
      const d = describeMessage(message);
      rows.push({ key: `${frame.id}:${mi}`, seq: pad(fi, mi), ...d });
    });
  });
  return (
    <div>
      {rows.map((r) => (
        <div className="frame-row" key={r.key}>
          <span className="l">{r.seq}</span>
          <span className={r.cls}>{r.kind}</span>
          <span className="frame-detail">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

const pad = (frame: number, message: number) =>
  `${String(frame).padStart(4, "0")}${message > 0 ? `.${message}` : ""}`;

function StateView({ session }: { session: { clientSnapshot?: unknown } | undefined }) {
  if (!session) return <p className="inspector-empty">…</p>;
  const snapshot = session.clientSnapshot as
    | { instance?: { states?: Record<string, unknown> } }
    | undefined;
  const states = snapshot?.instance?.states;
  if (!states || Object.keys(states).length === 0) {
    return <p className="inspector-empty">no projected state yet</p>;
  }
  return <pre className="state-json">{JSON.stringify(states, null, 2)}</pre>;
}
