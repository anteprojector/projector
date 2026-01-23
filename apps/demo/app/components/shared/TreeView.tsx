"use client";

import { useState } from "react";

interface SerializedSuspendInfo {
  suspendId: string;
  reason: string;
  suspendedAt: string;
  metadata?: Record<string, unknown>;
}

// Display format node (from serializeInstanceForDisplay)
interface DisplayCommand {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DisplayNode {
  name: string;
  instructions: string;
  validator: Record<string, unknown>;
  tools: string[]; // Just tool names
  transitions: Record<string, string>; // name -> target
  commands: Record<string, DisplayCommand>;
  initialState?: unknown;
  packs?: string[];
  worker?: boolean;
}

// Standard serialized format node
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

type NodeType = DisplayNode | SerialNode | Ref;

interface DisplayInstance {
  id: string;
  node: NodeType;
  state: unknown;
  children?: DisplayInstance[];
  packStates?: Record<string, unknown>;
  executorConfig?: Record<string, unknown>;
  suspended?: SerializedSuspendInfo;
}

interface TreeViewProps {
  instance: DisplayInstance;
  depth?: number;
  isLast?: boolean;
}

function isRef(value: unknown): value is Ref {
  return (
    typeof value === "object" &&
    value !== null &&
    "ref" in value &&
    typeof (value as Ref).ref === "string" &&
    Object.keys(value).length === 1
  );
}

function isDisplayNode(node: NodeType): node is DisplayNode {
  return (
    !isRef(node) &&
    "tools" in node &&
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

function NodeSection({ node }: { node: NodeType }) {
  if (isRef(node)) {
    return (
      <div className="text-xs text-terminal-green-dim italic">
        ref: {node.ref}
      </div>
    );
  }

  const instructionPreview = truncate(node.instructions.replace(/\n/g, " "), 100);

  // Handle display format (tools is string[], transitions is Record<string, string>)
  if (isDisplayNode(node)) {
    const toolNames = node.tools;
    const transitions = node.transitions;
    const transitionNames = Object.keys(transitions);

    return (
      <div className="space-y-1">
        <KeyValue
          k="instructions"
          v={<span className="italic">"{instructionPreview}"</span>}
        />

        <Expander label="validator" preview={node.validator}>
          <JsonBlock data={node.validator} />
        </Expander>

        {toolNames.length > 0 && (
          <Expander label="tools" badge={toolNames.length} preview={toolNames}>
            <div className="text-terminal-green-dim space-y-0.5">
              {toolNames.map((name) => (
                <div key={name}>• {name}</div>
              ))}
            </div>
          </Expander>
        )}

        {transitionNames.length > 0 && (
          <Expander label="transitions" badge={transitionNames.length} preview={transitions}>
            <div className="text-terminal-green-dim space-y-0.5">
              {transitionNames.map((name) => (
                <div key={name}>
                  • {name} → <span className="text-terminal-cyan">{transitions[name]}</span>
                </div>
              ))}
            </div>
          </Expander>
        )}

        {Object.keys(node.commands).length > 0 && (
          <Expander label="commands" badge={Object.keys(node.commands).length} preview={node.commands}>
            <div className="text-terminal-green-dim space-y-0.5">
              {Object.entries(node.commands).map(([cmdName, cmd]) => (
                <div key={cmdName}>
                  • {cmdName}: <span className="italic">{cmd.description}</span>
                </div>
              ))}
            </div>
          </Expander>
        )}

        {node.packs && node.packs.length > 0 && (
          <Expander label="packs" badge={node.packs.length} preview={node.packs}>
            <div className="text-terminal-green-dim space-y-0.5">
              {node.packs.map((name) => (
                <div key={name}>• {name}</div>
              ))}
            </div>
          </Expander>
        )}

        {node.worker && (
          <KeyValue k="worker" v="true" />
        )}

        {node.initialState !== undefined && (
          <Expander label="initialState" preview={node.initialState}>
            <JsonBlock data={node.initialState} />
          </Expander>
        )}
      </div>
    );
  }

  // Handle serial format (tools is Record, transitions is Record with complex values)
  const serialNode = node as SerialNode;
  const toolNames = serialNode.tools ? Object.keys(serialNode.tools) : [];
  const transitionNames = Object.keys(serialNode.transitions);

  return (
    <div className="space-y-1">
      <KeyValue
        k="instructions"
        v={<span className="italic">"{instructionPreview}"</span>}
      />

      <Expander label="validator" preview={serialNode.validator}>
        <JsonBlock data={serialNode.validator} />
      </Expander>

      {toolNames.length > 0 && (
        <Expander label="tools" badge={toolNames.length}>
          <div className="text-terminal-green-dim space-y-0.5">
            {toolNames.map((name) => (
              <div key={name}>• {name}</div>
            ))}
          </div>
        </Expander>
      )}

      {transitionNames.length > 0 && (
        <Expander label="transitions" badge={transitionNames.length}>
          <div className="text-terminal-green-dim space-y-0.5">
            {transitionNames.map((name) => {
              const t = serialNode.transitions[name];
              const target = isRef(t)
                ? t.ref
                : typeof t === "object" && t && "node" in t && isRef((t as { node: unknown }).node)
                  ? (((t as { node: Ref }).node) as Ref).ref
                  : "inline";
              return (
                <div key={name}>
                  • {name} → <span className="text-terminal-cyan">{target}</span>
                </div>
              );
            })}
          </div>
        </Expander>
      )}

      {serialNode.initialState !== undefined && (
        <Expander label="initialState" preview={serialNode.initialState}>
          <JsonBlock data={serialNode.initialState} />
        </Expander>
      )}
    </div>
  );
}

export function TreeView({
  instance,
  depth = 0,
  isLast = true,
}: TreeViewProps) {
  // Determine node name - from display format, ref, or inline
  let nodeName = "[inline]";
  if (isRef(instance.node)) {
    nodeName = instance.node.ref;
  } else if ("name" in instance.node && typeof instance.node.name === "string") {
    nodeName = instance.node.name;
  }

  const isSuspended = !!instance.suspended;
  const hasPackStates =
    instance.packStates && Object.keys(instance.packStates).length > 0;
  const hasChildren = instance.children && instance.children.length > 0;

  return (
    <div className={`font-mono ${depth > 0 ? "mt-4" : ""}`}>
      {/* Header row with tree branch */}
      <div className="flex items-center gap-2 text-sm">
        {depth > 0 && (
          <span className="text-terminal-green-dimmer -ml-4 mr-1">
            {isLast ? "└─" : "├─"}
          </span>
        )}
        <span
          className={`font-bold ${isSuspended ? "text-terminal-yellow" : "text-terminal-green"}`}
        >
          {nodeName}
        </span>
        <span className="text-terminal-green-dimmer text-xs">
          {instance.id.slice(0, 8)}
        </span>
        {isSuspended && (
          <span className="text-terminal-yellow text-xs">[SUSPENDED]</span>
        )}
      </div>

      {/* Content sections with vertical line - includes children */}
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

        {/* Node */}
        <Expander label="node" preview={instance.node}>
          <NodeSection node={instance.node} />
        </Expander>

        {/* Executor Config */}
        {instance.executorConfig && (
          <Expander label="executorConfig" preview={instance.executorConfig}>
            <JsonBlock data={instance.executorConfig} />
          </Expander>
        )}

        {/* Suspended */}
        {isSuspended && (
          <Expander label="suspended" defaultOpen preview={instance.suspended}>
            <div className="text-terminal-yellow text-xs space-y-0.5">
              <KeyValue k="reason" v={instance.suspended!.reason} vClass="text-terminal-yellow" />
              <KeyValue k="id" v={instance.suspended!.suspendId} vClass="text-terminal-yellow" />
              <KeyValue k="at" v={instance.suspended!.suspendedAt} vClass="text-terminal-yellow" />
              {instance.suspended!.metadata && (
                <Expander label="metadata" preview={instance.suspended!.metadata}>
                  <JsonBlock data={instance.suspended!.metadata} />
                </Expander>
              )}
            </div>
          </Expander>
        )}

        {/* Children - inside the vertical line container so branches connect */}
        {hasChildren &&
          instance.children!.map((child, i) => (
            <TreeView
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
