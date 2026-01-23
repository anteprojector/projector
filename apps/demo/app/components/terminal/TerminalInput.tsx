"use client";

import { forwardRef, useCallback, KeyboardEvent } from "react";

interface TerminalInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export const TerminalInput = forwardRef<HTMLTextAreaElement, TerminalInputProps>(
  function TerminalInput({ value, onChange, onSend, isLoading }, ref) {
    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Escape") {
          e.currentTarget.blur();
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend();
        }
      },
      [onSend]
    );

    return (
      <div className="sticky bottom-0 mt-4 pt-4 pb-4 bg-terminal-bg border-t border-terminal-green-dimmer">
        <div className="flex items-start gap-2">
          <span className="text-terminal-green-dim py-1">&gt;</span>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            placeholder={isLoading ? "Thinking..." : "Type a message..."}
            rows={1}
            className="flex-1 bg-transparent text-terminal-green font-mono focus:outline-none terminal-glow resize-none min-h-[24px] max-h-[200px]"
            style={{
              height: "auto",
              minHeight: "24px",
            }}
          />
        </div>
      </div>
    );
  }
);
