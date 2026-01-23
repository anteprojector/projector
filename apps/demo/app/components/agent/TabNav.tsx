"use client";

import { useAtom } from "jotai";
import { activeAgentTabAtom, type AgentTab } from "@/src/atoms";

const tabs: { id: AgentTab; label: string }[] = [
  { id: "tree", label: "Tree" },
  { id: "state", label: "State" },
  { id: "history", label: "History" },
  { id: "commands", label: "Commands" },
  { id: "dev", label: "Dev" },
];

export function TabNav() {
  const [activeTab, setActiveTab] = useAtom(activeAgentTabAtom);

  return (
    <div className="flex border-b border-terminal-green-dimmer">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`
            px-4 py-2 text-sm font-mono transition-colors
            ${
              activeTab === tab.id
                ? "text-terminal-green border-b-2 border-terminal-green"
                : "text-terminal-green-dim hover:text-terminal-green"
            }
          `}
        >
          [{tab.label}]
        </button>
      ))}
    </div>
  );
}
