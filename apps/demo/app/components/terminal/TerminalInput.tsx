"use client";

import { useCallback, KeyboardEvent } from "react";

interface TerminalInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
  isScrolledUp: boolean;
}

export function TerminalInput({
  value,
  onChange,
  onSend,
  isLoading,
  isScrolledUp,
}: TerminalInputProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend]
  );

  const baseClasses = `
    w-full bg-terminal-bg border border-terminal-green-dimmer
    rounded px-4 py-3 text-terminal-green font-mono
    focus:border-terminal-green focus:outline-none
    terminal-glow resize-none
  `;

  const positionClasses = isScrolledUp
    ? "fixed bottom-4 left-4 right-[calc(50%+1rem)] z-20"
    : "sticky bottom-0";

  return (
    <div className={`${positionClasses} bg-terminal-bg`}>
      <div className="flex items-start gap-2">
        <span className="text-terminal-green-dim py-3">&gt;</span>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          placeholder={isLoading ? "Thinking..." : "Type a message..."}
          rows={1}
          className={`${baseClasses} flex-1 min-h-[44px] max-h-[200px]`}
          style={{
            height: "auto",
            minHeight: "44px",
          }}
        />
      </div>
      {isLoading && (
        <div className="absolute right-4 top-1/2 -translate-y-1/2">
          <span className="terminal-cursor text-terminal-green">_</span>
        </div>
      )}
    </div>
  );
}
