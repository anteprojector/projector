"use client";

import { forwardRef, useEffect, useRef } from "react";
import { useAtom, useAtomValue } from "jotai";
import { shiftHeldAtom, isLiveModeAtom, voiceConnectionStatusAtom, voiceAgentConnectedAtom } from "@/src/atoms";
import { TerminalMessage } from "./TerminalMessage";
import { TerminalInput } from "./TerminalInput";
import { ScanlinesToggle } from "./Scanlines";
import { ThinkingSpinner } from "./ThinkingSpinner";
import type { Id } from "@/convex/_generated/dataModel";

interface Message {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  mode?: "text" | "voice";
  idempotencyKey?: string;
}

interface TerminalPaneProps {
  sessionId: Id<"sessions">;
  messages: Message[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    { sessionId, messages, input, onInputChange, onSend, isLoading },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const [isLiveMode, setIsLiveMode] = useAtom(isLiveModeAtom);
    const voiceConnectionStatus = useAtomValue(voiceConnectionStatusAtom);
    const voiceAgentConnected = useAtomValue(voiceAgentConnectedAtom);

    const handleToggleLiveMode = () => {
      setIsLiveMode((prev) => !prev);
    };

    // Auto-scroll on any DOM content change (new messages AND streaming deltas),
    // but only if the user was near the bottom before the content changed.
    // We track lastScrollHeight so we can compare against the pre-mutation scroll
    // position — this avoids races between scroll events and MutationObserver.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let lastScrollHeight = container.scrollHeight;
      let userNearBottom = true;

      const handleScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        userNearBottom = scrollHeight - scrollTop - clientHeight <= 50;
        lastScrollHeight = scrollHeight;
      };

      const observer = new MutationObserver(() => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        // If content grew, check whether we were near the bottom BEFORE the growth.
        const wasNearBottom = scrollHeight > lastScrollHeight
          ? lastScrollHeight - scrollTop - clientHeight <= 50
          : userNearBottom;
        lastScrollHeight = scrollHeight;

        if (wasNearBottom) {
          container.scrollTop = scrollHeight;
          userNearBottom = true;
        }
      });

      container.addEventListener("scroll", handleScroll, { passive: true });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      return () => {
        container.removeEventListener("scroll", handleScroll);
        observer.disconnect();
      };
    }, []);

    return (
      <div
        tabIndex={0}
        className="h-full flex flex-col bg-terminal-bg relative z-0 pane-focus"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-green-dimmer">
          <h1 className="text-terminal-green terminal-glow text-sm font-bold">
            {shiftHeld ? <u>M</u> : "M"}ESSAGES
          </h1>
          <ScanlinesToggle />
        </div>

        {/* Messages area with sticky input */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 pb-0 terminal-scrollbar"
        >
          {/* Messages with reserved spinner space */}
          <div className="relative pb-8">
            {messages.length === 0 ? (
              <div className="text-terminal-green-dimmer italic">
                Waiting for input...
              </div>
            ) : (
              messages.map((msg) => (
                <TerminalMessage
                  key={msg._id}
                  role={msg.role}
                  content={msg.content}
                  idempotencyKey={msg.idempotencyKey}
                />
              ))
            )}
            {/* Spinner in reserved space - absolute to avoid layout shift */}
            <div className="absolute bottom-0 left-0">
              <ThinkingSpinner sessionId={sessionId} />
            </div>
          </div>

          {/* Sticky input inside scrollable area */}
          <TerminalInput
            ref={ref}
            value={input}
            onChange={onInputChange}
            onSend={onSend}
            isLoading={isLoading}
            isLiveMode={isLiveMode}
            voiceConnectionStatus={voiceConnectionStatus}
            voiceAgentConnected={voiceAgentConnected}
            onToggleLiveMode={handleToggleLiveMode}
          />
        </div>
      </div>
    );
  }
);
