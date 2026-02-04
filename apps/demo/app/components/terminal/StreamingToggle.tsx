"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { liveClientAtom, packStateOverridesAtom } from "@/src/atoms";
import type { DisplayInstance } from "@/src/types/display";
import { findCommand } from "markov-machines/client";
import { demoContract } from "demo-agent/src/agent/contract";

const setStreamingEnabled = demoContract.commands.agentControls.setStreamingEnabled;

export function StreamingToggle({ displayInstance }: { displayInstance?: DisplayInstance | null }) {
  const liveClient = useAtomValue(liveClientAtom);
  const setOverrides = useSetAtom(packStateOverridesAtom);

  if (!displayInstance) return null;

  // Only show toggle if the setStreamingEnabled command is available
  const cmd = findCommand(displayInstance, setStreamingEnabled);
  if (!cmd) return null;

  // Read current streaming state from root pack states
  const packStates = displayInstance.packStates as Record<string, any> | undefined;
  const agentControls = packStates?.agentControls;
  const enabled = agentControls?.enableStreaming ?? true;

  const handleToggle = () => {
    const next = !enabled;
    setOverrides((prev) => ({
      ...prev,
      agentControls: { ...(prev.agentControls ?? {}), enableStreaming: next },
    }));
    liveClient?.executeCommand(cmd.name, { enabled: next }).then((r) => {
      if (!r.success) setOverrides((prev) => {
        const { enableStreaming: _, ...rest } = (prev.agentControls ?? {}) as any;
        return { ...prev, agentControls: rest };
      });
    });
  };

  return (
    <button
      onClick={handleToggle}
      className="text-xs text-terminal-green-dim hover:text-terminal-green transition-colors"
    >
      [{enabled ? "x" : " "}] Streaming
    </button>
  );
}
