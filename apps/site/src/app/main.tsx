// Lazy app entry. boot.ts imports this module on intent; nothing here loads
// with the marketing page. launch() mounts synchronously (flushSync) so a view
// transition's "new" snapshot already contains the conversation.

import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";

let client: ConvexReactClient | null = null;
let root: Root | null = null;

export function warm(): void {
  const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!client && url) client = new ConvexReactClient(url);
}

export function launch(opts: { initialMessage?: string; sessionId?: string }): void {
  warm();
  const container = document.getElementById("app");
  if (!container) return;
  root?.unmount();
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <StrictMode>
        <App
          client={client}
          initialMessage={opts.initialMessage}
          sessionId={opts.sessionId}
        />
      </StrictMode>,
    );
  });
}

export function unmount(): void {
  root?.unmount();
  root = null;
}
