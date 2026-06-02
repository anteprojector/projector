import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createCharter } from "../core/charter";
import { createNode } from "../core/node";
import { createContext } from "../core/context";
import { createPack } from "../core/pack";
import { buildSystemPrompt } from "../runtime/system-prompt";
import { StandardExecutor } from "../executor/standard";

describe("pack instructions", () => {
  it("includes string instructions for active packs", () => {
    const context = createContext({
      name: "p",
      schema: z.object({ enabled: z.boolean() }),
      initialState: { enabled: true },
    });
    const pack = createPack(context, {
      name: "p",
      description: "desc",
      instructions: "PACK INSTRUCTIONS",
    });

    const node = createNode({
      instructions: "node",
      validator: z.object({}),
      initialState: {},
      packs: [pack],
    });

    const charter = createCharter({
      name: "c",
      executor: new StandardExecutor(),
    });

    const prompt = buildSystemPrompt(charter, node, {}, [], { [context.name]: { enabled: true } });
    expect(prompt).toContain("## Active Packs");
    expect(prompt).toContain("Instructions:");
    expect(prompt).toContain("PACK INSTRUCTIONS");
  });

  it("evaluates function instructions and omits empty results", () => {
    const context = createContext({
      name: "p2",
      schema: z.object({ enabled: z.boolean() }),
      initialState: { enabled: false },
    });
    const pack = createPack(context, {
      name: "p2",
      description: "desc",
      instructions: (state: { enabled: boolean }) => (state.enabled ? "ENABLED" : ""),
    });

    const node = createNode({
      instructions: "node",
      validator: z.object({}),
      initialState: {},
      packs: [pack],
    });

    const charter = createCharter({
      name: "c",
      executor: new StandardExecutor(),
    });

    const promptDisabled = buildSystemPrompt(charter, node, {}, [], { [context.name]: { enabled: false } });
    expect(promptDisabled).toContain("## Active Packs");
    expect(promptDisabled).not.toContain("ENABLED");

    const promptEnabled = buildSystemPrompt(charter, node, {}, [], { [context.name]: { enabled: true } });
    expect(promptEnabled).toContain("ENABLED");
  });

  it("does not throw when pack state is missing (uses initialState fallback)", () => {
    const context = createContext({
      name: "p3",
      schema: z.object({ enabled: z.boolean() }),
      initialState: { enabled: true },
    });
    const pack = createPack(context, {
      name: "p3",
      description: "desc",
      instructions: (state: { enabled: boolean }) => (state.enabled ? "ENABLED" : "DISABLED"),
    });

    const node = createNode({
      instructions: "node",
      validator: z.object({}),
      initialState: {},
      packs: [pack],
    });

    const charter = createCharter({
      name: "c",
      executor: new StandardExecutor(),
    });

    const prompt = buildSystemPrompt(charter, node, {}, [], {});
    expect(prompt).toContain("ENABLED");
  });
});
