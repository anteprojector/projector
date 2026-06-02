import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter";
import { createContext } from "../core/context";
import { createMachine } from "../core/machine";
import { createNode } from "../core/node";
import { createPack } from "../core/pack";
import { applyInstanceMessages } from "../core/run";
import { serializeInstance, serializeMachine, serializeNode } from "../serialization/serialize";
import { deserializeMachine } from "../serialization/deserialize";
import { createInstance } from "../types/instance";
import { instanceMessage } from "../types/messages";
import type { Executor, RunOptions, RunResult } from "../executor/types";
import type { Charter } from "../types/charter";
import type { Instance } from "../types/instance";
import { isRef } from "../types/refs";

function createMockExecutor(): Executor {
  return {
    type: "standard",
    run: async (
      _charter: Charter,
      _instance: Instance,
      _ancestors: Instance[],
      _input: string,
      _options?: RunOptions,
    ): Promise<RunResult> => ({ yieldReason: "end_turn" }),
  };
}

describe("root context", () => {
  it("creates contexts and hoists pack context state to root", () => {
    const settingsContext = createContext({
      name: "settings",
      schema: z.object({ voiceEnabled: z.boolean() }),
      initialState: { voiceEnabled: false },
    });
    const settingsPack = createPack(settingsContext, {
      name: "settingsPack",
      description: "Settings",
    });
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
      packs: [settingsPack],
    });
    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        nodes: { node },
      }),
      { instance: createInstance(node, {}) },
    );

    expect(machine.instance.context).toEqual({
      settings: { voiceEnabled: false },
    });
  });

  it("resolves context refs through charter.contexts", () => {
    const settingsContext = createContext({
      name: "settings",
      schema: z.object({ voiceEnabled: z.boolean() }),
      initialState: { voiceEnabled: true },
    });
    const settingsPack = createPack({ ref: "settings" }, {
      name: "settingsPack",
      description: "Settings",
    });
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
      packs: [settingsPack],
    });
    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        contexts: [settingsContext],
        nodes: { node },
      }),
      { instance: createInstance(node, {}) },
    );

    expect(machine.instance.context).toEqual({
      settings: { voiceEnabled: true },
    });
  });

  it("shares one root context entry across multiple packs", () => {
    const sharedContext = createContext({
      name: "shared",
      schema: z.object({ count: z.number() }),
      initialState: { count: 0 },
    });
    const firstPack = createPack(sharedContext, { name: "first", description: "First" });
    const secondPack = createPack(sharedContext, { name: "second", description: "Second" });
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
      packs: [firstPack, secondPack],
    });

    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        nodes: { node },
      }),
      { instance: createInstance(node, {}) },
    );

    expect(Object.keys(machine.instance.context ?? {})).toEqual(["shared"]);
    expect(machine.instance.context?.shared).toEqual({ count: 0 });
  });

  it("initializes contexts from transitioned and spawned node packs", () => {
    const rootNode = createNode({
      instructions: "Root",
      validator: z.object({}),
      initialState: {},
    });
    const childContext = createContext({
      name: "childContext",
      schema: z.object({ value: z.string() }),
      initialState: { value: "child" },
    });
    const spawnedContext = createContext({
      name: "spawnedContext",
      schema: z.object({ value: z.string() }),
      initialState: { value: "spawned" },
    });
    const childNode = createNode({
      instructions: "Child",
      validator: z.object({}),
      initialState: {},
      packs: [createPack(childContext, { name: "childPack", description: "Child" })],
    });
    const spawnedNode = createNode({
      instructions: "Spawned",
      validator: z.object({}),
      initialState: {},
      packs: [createPack(spawnedContext, { name: "spawnedPack", description: "Spawned" })],
    });
    const machine = createMachine(
      createCharter({
        name: "test",
        executor: createMockExecutor(),
        nodes: { rootNode, childNode, spawnedNode },
      }),
      { instance: createInstance(rootNode, {}) },
    );

    applyInstanceMessages(machine, [
      instanceMessage({ kind: "transition", instanceId: machine.instance.id, node: childNode }),
      instanceMessage({
        kind: "spawn",
        parentInstanceId: machine.instance.id,
        children: [{ node: spawnedNode }],
      }),
    ], 1);

    expect(machine.instance.context?.childContext).toEqual({ value: "child" });
    expect(machine.instance.context?.spawnedContext).toEqual({ value: "spawned" });
  });

  it("serializes root context directly and restores it on deserialize", () => {
    const settingsContext = createContext({
      name: "settings",
      schema: z.object({ voiceEnabled: z.boolean() }),
      initialState: { voiceEnabled: false },
    });
    const settingsPack = createPack(settingsContext, {
      name: "settingsPack",
      description: "Settings",
    });
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
      packs: [settingsPack],
    });
    const charter = createCharter({
      name: "test",
      executor: createMockExecutor(),
      nodes: { node },
    });
    const machine = createMachine(charter, {
      instance: createInstance(node, {}, undefined, {
        settings: { voiceEnabled: true },
      }),
    });

    const serialized = serializeMachine(machine);
    expect(serialized.instance.context).toEqual({
      settings: { voiceEnabled: true },
    });
    expect(["pack", "Instances"].join("") in serialized.instance).toBe(false);

    const deserialized = deserializeMachine(charter, serialized);
    expect(deserialized.instance.context).toEqual({
      settings: { voiceEnabled: true },
    });
  });

  it("serializes inline packs with inline context config", () => {
    const settingsContext = createContext({
      name: "settings",
      schema: z.object({ voiceEnabled: z.boolean() }),
      initialState: { voiceEnabled: false },
    });
    const settingsPack = createPack(settingsContext, {
      name: "settingsPack",
      description: "Settings",
    });
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
      packs: [settingsPack],
    });

    const serialized = serializeNode(node, undefined, { noNodeRef: true });
    if (isRef(serialized)) {
      throw new Error("Expected inline node");
    }

    const [serializedPack] = serialized.packs ?? [];
    expect(serializedPack).toBeDefined();
    if (!serializedPack || isRef(serializedPack)) {
      throw new Error("Expected inline pack");
    }
    expect(serializedPack.context).toMatchObject({
      name: "settings",
      initialState: { voiceEnabled: false },
    });
  });

  it("serializes root instance context without contextInstances", () => {
    const node = createNode({
      instructions: "Node",
      validator: z.object({}),
      initialState: {},
    });
    const instance = createInstance(node, {}, undefined, { settings: { voiceEnabled: true } });
    const serialized = serializeInstance(instance);

    expect(serialized.context).toEqual({ settings: { voiceEnabled: true } });
    expect("contextInstances" in serialized).toBe(false);
  });
});
