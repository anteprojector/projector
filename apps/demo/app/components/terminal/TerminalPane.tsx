"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalMessage } from "./TerminalMessage";
import { TerminalInput } from "./TerminalInput";
import { ScanlinesToggle } from "./Scanlines";

interface Message {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

interface TerminalPaneProps {
  messages: Message[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export function TerminalPane({
  messages,
  input,
  onInputChange,
  onSend,
  isLoading,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      setIsScrolledUp(scrollHeight - scrollTop - clientHeight > 50);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!isScrolledUp && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, isScrolledUp]);

  return (
    <div className="h-full flex flex-col bg-terminal-bg relative z-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-green-dimmer">
        <h1 className="text-terminal-green terminal-glow text-sm font-bold">
          MARKOV-MACHINES DEMO
        </h1>
        <ScanlinesToggle />
      </div>

      {/* Messages area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 terminal-scrollbar"
      >
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
            />
          ))
        )}
        {isLoading && (
          <div className="text-terminal-green-dim animate-pulse">
            Processing<span className="terminal-cursor">_</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="p-4 border-t border-terminal-green-dimmer">
        <TerminalInput
          value={input}
          onChange={onInputChange}
          onSend={onSend}
          isLoading={isLoading}
          isScrolledUp={isScrolledUp}
        />
      </div>
    </div>
  );
}
