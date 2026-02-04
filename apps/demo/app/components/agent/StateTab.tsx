"use client";

import { useAtomValue } from "jotai";
import { isPreviewingAtom, stepPreviewInstanceAtom } from "@/src/atoms";
import { JsonViewer } from "../shared/JsonViewer";
import type { DisplayInstance } from "@/src/types/display";

interface StateTabProps {
  instance: DisplayInstance | null;
}

function flattenInstances(instance: DisplayInstance): DisplayInstance[] {
  const result: DisplayInstance[] = [instance];
  if (instance.children) {
    for (const child of instance.children) {
      result.push(...flattenInstances(child));
    }
  }
  return result;
}

// Collect all unique packs from the full instance tree (packs are defined on
// individual nodes, not necessarily on the root).
function collectPacks(instance: DisplayInstance) {
  const seen = new Map<string, NonNullable<DisplayInstance["node"]["packs"]>[number]>();
  function visit(inst: DisplayInstance) {
    for (const p of inst.node.packs || []) {
      if (!seen.has(p.name)) seen.set(p.name, p);
    }
    for (const c of inst.children || []) visit(c);
  }
  visit(instance);
  return Array.from(seen.values());
}

function getActiveInstance(instance: DisplayInstance): DisplayInstance {
  if (!instance.children || instance.children.length === 0) {
    return instance;
  }
  const lastChild = instance.children[instance.children.length - 1];
  return lastChild ? getActiveInstance(lastChild) : instance;
}

export function StateTab({ instance }: StateTabProps) {
  const isPreviewing = useAtomValue(isPreviewingAtom);
  const previewInstance = useAtomValue(stepPreviewInstanceAtom) as DisplayInstance | null;

  const displayInstance = isPreviewing && previewInstance ? previewInstance : instance;

  if (!displayInstance) {
    return (
      <div className="text-terminal-green-dimmer italic">
        No instance loaded
      </div>
    );
  }

  const allInstances = flattenInstances(displayInstance);
  const activeInstance = getActiveInstance(displayInstance);
  const packStates = displayInstance.packStates || {};
  const packs = collectPacks(displayInstance);

  return (
    <div className="space-y-4">
      {/* Preview indicator */}
      {isPreviewing && (
        <div className="text-terminal-yellow text-sm border border-terminal-yellow px-2 py-1 inline-block">
          [PREVIEW]
        </div>
      )}

      {/* Instance States */}
      {allInstances.map((inst) => {
        const isActive = inst.id === activeInstance.id;
        return (
          <div key={inst.id}>
            <h3 className={`text-sm mb-2 ${isActive ? "text-terminal-green terminal-glow" : "text-terminal-green-dim"}`}>
              {inst.node.name} state {isActive && "[active]"}
            </h3>
            <div className={`p-3 rounded border ${isActive ? "border-terminal-green bg-terminal-bg-lighter" : "border-terminal-green-dimmer"}`}>
              <JsonViewer data={inst.state} />
            </div>
          </div>
        );
      })}

      {/* Pack States */}
      {packs.map((pack) => {
        const isActive = activeInstance.node.packNames?.includes(pack.name) ?? false;
        const packState = packStates[pack.name];
        return (
          <div key={pack.name}>
            <h3 className={`text-sm mb-2 ${isActive ? "text-terminal-green terminal-glow" : "text-terminal-green-dim"}`}>
              {pack.name} pack state {isActive && "[active]"}
            </h3>
            <div className={`p-3 rounded border ${isActive ? "border-terminal-green bg-terminal-bg-lighter" : "border-terminal-green-dimmer"}`}>
              <JsonViewer data={packState} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
