"use client";

import { useState } from "react";

/**
 * Client-side representation of the instance tree.
 * This shows what a client would receive via createDryClientInstance.
 * We use the display format which includes all the relevant client info.
 */

interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayNode {
  name: string;
  instructions: string;
  validator: Record<string, unknown>;
  tools: string[];
  transitions: Record<string, string>;
  commands: Record<string, DisplayCommand>;
  initialState?: unknown;
  packs?: string[];
  worker?: boolean;
}

interface DisplayInstance {
  id: string;
  node: DisplayNode;
  state: unknown;
  children?: DisplayInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: unknown;
}

// Fallback types for when displayInstance isn't available
interface SerialNode {
  instructions: string;
  validator: Record<string, unknown>;
  transitions: Record<string, unknown>;
  tools?: Record<string, unknown>;
  initialState?: unknown;
}

interface Ref {
  ref: string;
}

interface SerializedInstance {
  id: string;
  node: SerialNode | Ref | DisplayNode;
  state: unknown;
  children?: SerializedInstance[];
  packStates?: Record<string, unknown>;
}

function isDisplayNode(node: unknown): node is DisplayNode {
  return (
    typeof node === "object" &&
    node !== null &&
    "commands" in node &&
    "name" in node &&
    Array.isArray((node as DisplayNode).tools)
  );
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function jsonPreview(data: unknown, maxLen: number = 40): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function Expander({
  label,
  badge,
  preview,
  defaultOpen = false,
  children,
}: {
  label: string;
  badge?: string | number;
  preview?: unknown;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-terminal-cyan hover:text-terminal-green text-left"
      >
        <span className="w-2.5 text-terminal-green-dimmer shrink-0">
          {open ? "▾" : "▸"}
        </span>
        <span className="shrink-0">{label}</span>
        {badge !== undefined && (
          <span className="text-terminal-yellow shrink-0">({badge})</span>
        )}
        {!open && preview !== undefined && (
          <span className="text-terminal-green-dimmer truncate">
            {jsonPreview(preview)}
          </span>
        )}
      </button>
      {open && <div className="pl-2.5 pt-0.5">{children}</div>}
    </div>
  );
}

function KeyValue({
  k,
  v,
  vClass = "text-terminal-green-dim",
}: {
  k: string;
  v: React.ReactNode;
  vClass?: string;
}) {
  return (
    <div className="flex gap-1 text-xs">
      <span className="text-terminal-cyan shrink-0">{k}:</span>
      <span className={vClass}>{v}</span>
    </div>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  return (
    <pre className="text-terminal-green-dim text-xs whitespace-pre-wrap break-all max-h-40 overflow-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function ClientNodeSection({ node }: { node: DisplayNode }) {
  const instructionPreview = truncate(node.instructions.replace(/\n/g, " "), 100);
  const commandNames = Object.keys(node.commands);

  return (
    <div className="space-y-1">
      <KeyValue
        k="instructions"
        v={<span className="italic">"{instructionPreview}"</span>}
      />

      <Expander label="validator" preview={node.validator}>
        <JsonBlock data={node.validator} />
      </Expander>

      {commandNames.length > 0 && (
        <Expander label="commands" badge={commandNames.length} preview={node.commands}>
          <div className="text-terminal-green-dim space-y-0.5">
            {commandNames.map((name) => {
              const cmd = node.commands[name];
              return (
                <div key={name}>
                  • {name}: <span className="italic">{cmd.description}</span>
                </div>
              );
            })}
          </div>
        </Expander>
      )}
    </div>
  );
}

interface ClientInstanceViewProps {
  instance: SerializedInstance;
  depth?: number;
  isLast?: boolean;
}

function ClientInstanceView({
  instance,
  depth = 0,
  isLast = true,
}: ClientInstanceViewProps) {
  const hasPackStates =
    instance.packStates && Object.keys(instance.packStates).length > 0;
  const hasChildren = instance.children && instance.children.length > 0;

  // Get node name from display format
  const nodeName = isDisplayNode(instance.node) ? instance.node.name : "client";

  return (
    <div className={`font-mono ${depth > 0 ? "mt-4" : ""}`}>
      {/* Header row with tree branch */}
      <div className="flex items-center gap-2 text-sm">
        {depth > 0 && (
          <span className="text-terminal-green-dimmer -ml-4 mr-1">
            {isLast ? "└─" : "├─"}
          </span>
        )}
        <span className="font-bold text-terminal-green">
          {nodeName}
        </span>
        <span className="text-terminal-green-dimmer text-xs">
          {instance.id.slice(0, 8)}
        </span>
      </div>

      {/* Content sections with vertical line */}
      <div className="border-l border-terminal-green-dimmer ml-[3px] pl-3 space-y-1 py-1">
        {/* State - always show */}
        <Expander label="state" defaultOpen preview={instance.state}>
          <JsonBlock data={instance.state} />
        </Expander>

        {/* Pack States */}
        {hasPackStates && (
          <Expander
            label="packStates"
            badge={Object.keys(instance.packStates!).length}
            preview={instance.packStates}
          >
            <div className="space-y-1">
              {Object.entries(instance.packStates!).map(([name, state]) => (
                <Expander key={name} label={name} preview={state}>
                  <JsonBlock data={state} />
                </Expander>
              ))}
            </div>
          </Expander>
        )}

        {/* Node - only show if display format */}
        {isDisplayNode(instance.node) && (
          <Expander label="node" preview={instance.node}>
            <ClientNodeSection node={instance.node} />
          </Expander>
        )}

        {/* Children - inside the vertical line container */}
        {hasChildren &&
          instance.children!.map((child, i) => (
            <ClientInstanceView
              key={child.id}
              instance={child}
              depth={depth + 1}
              isLast={i === instance.children!.length - 1}
            />
          ))}
      </div>
    </div>
  );
}

interface ClientTreeViewProps {
  instance: SerializedInstance;
}

export function ClientTreeView({ instance }: ClientTreeViewProps) {
  return (
    <div className="font-mono text-sm">
      <div className="text-terminal-green-dimmer text-xs mb-2 border-b border-terminal-green-dimmer pb-2">
        DryClientInstance representation (what clients receive)
      </div>
      <ClientInstanceView instance={instance} />
    </div>
  );
}
