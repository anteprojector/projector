import { encodeRuntimeAddress } from "./runtime-address.ts";
import type {
  AnyActorMessage,
  DefaultActorMessage,
  Instance,
  Node,
  RuntimeAddress,
} from "./types.ts";

export type SyntheticRoot<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  type: "synthetic-root";
  instances: Instance<TActorMessage>[];
};

export type ProjectionFrame<TActorMessage extends AnyActorMessage = DefaultActorMessage> = {
  node: Node<TActorMessage>;
  instance: Instance<TActorMessage>;
  concreteInstance: Instance<TActorMessage>;
  topInstance: Instance<TActorMessage>;
  address: RuntimeAddress;
  runtimeInstanceId: string;
  memberPath: string[];
  parent?: ProjectionFrame<TActorMessage>;
  isMember: boolean;
};

export function createRoot<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  instances: Instance<TActorMessage>[],
): SyntheticRoot<TActorMessage> {
  return { type: "synthetic-root", instances };
}

export function traversalFrames<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
): ProjectionFrame<TActorMessage>[] {
  const frames: ProjectionFrame<TActorMessage>[] = [];
  const instances = isSyntheticRoot(root) ? root.instances : [root];

  for (const instance of instances) {
    collectInstanceFrame(frames, instance, undefined, instance);
  }

  return frames;
}

export function collectProjectionFrames<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
): ProjectionFrame<TActorMessage>[] {
  return traversalFrames(root);
}

export function findFrameByRuntimeId<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
  runtimeInstanceId: string,
): ProjectionFrame<TActorMessage> | undefined {
  return traversalFrames(root).find((frame) => frame.runtimeInstanceId === runtimeInstanceId);
}

export function directProjectionChildren<TActorMessage extends AnyActorMessage = DefaultActorMessage>(
  frame: ProjectionFrame<TActorMessage>,
): ProjectionFrame<TActorMessage>[] {
  const children: ProjectionFrame<TActorMessage>[] = [];

  for (const member of frame.node.members) {
    const memberPath = [...frame.memberPath, member.key];
    const address: RuntimeAddress = {
      type: "member",
      ownerInstanceId: frame.concreteInstance.id,
      memberPath,
    };
    const memberFrame: ProjectionFrame<TActorMessage> = {
      node: member,
      instance: frame.concreteInstance,
      concreteInstance: frame.concreteInstance,
      topInstance: frame.topInstance,
      address,
      runtimeInstanceId: encodeRuntimeAddress(address),
      memberPath,
      parent: frame,
      isMember: true,
    };
    children.push(memberFrame);
  }

  if (!frame.isMember) {
    for (const child of frame.instance.children ?? []) {
      const childAddress: RuntimeAddress = { type: "instance", instanceId: child.id };
      children.push({
        node: child.node,
        instance: child,
        concreteInstance: child,
        topInstance: frame.topInstance,
        address: childAddress,
        runtimeInstanceId: encodeRuntimeAddress(childAddress),
        memberPath: [],
        parent: frame,
        isMember: false,
      });
    }
  }

  return children;
}

function collectInstanceFrame<TActorMessage extends AnyActorMessage>(
  frames: ProjectionFrame<TActorMessage>[],
  instance: Instance<TActorMessage>,
  parent: ProjectionFrame<TActorMessage> | undefined,
  topInstance: Instance<TActorMessage>,
): void {
  const address: RuntimeAddress = { type: "instance", instanceId: instance.id };
  const frame: ProjectionFrame<TActorMessage> = {
    node: instance.node,
    instance,
    concreteInstance: instance,
    topInstance,
    address,
    runtimeInstanceId: encodeRuntimeAddress(address),
    memberPath: [],
    parent,
    isMember: false,
  };
  frames.push(frame);
  collectDescendants(frames, frame);
}

function collectDescendants<TActorMessage extends AnyActorMessage>(
  frames: ProjectionFrame<TActorMessage>[],
  frame: ProjectionFrame<TActorMessage>,
): void {
  for (const child of directProjectionChildren(frame)) {
    frames.push(child);
    collectDescendants(frames, child);
  }
}

function isSyntheticRoot<TActorMessage extends AnyActorMessage>(
  root: SyntheticRoot<TActorMessage> | Instance<TActorMessage>,
): root is SyntheticRoot<TActorMessage> {
  return "type" in root && root.type === "synthetic-root";
}
