import { z } from "zod";
import { createContext, createPack, type PackToolContext } from "markov-machines";

export const memoryStateValidator = z.object({
  memories: z.record(z.string(), z.string()),
});

export type MemoryState = z.infer<typeof memoryStateValidator>;

export const memoryContext = createContext({
  name: "memory",
  schema: memoryStateValidator,
  initialState: { memories: {} },
});

export const memoryPack = createPack(memoryContext, {
  name: "memory",
  description: "Simple key-value memory store for persisting information across conversations",
  tools: {
    setMemory: {
      name: "setMemory",
      description: "Store a memory with the given key and value",
      inputSchema: z.object({
        key: z.string().describe("A short identifier for this memory"),
        value: z.string().describe("The content to remember"),
      }),
      execute: (input: { key: string; value: string }, ctx: PackToolContext<MemoryState>) => {
        ctx.updateState({
          memories: { ...ctx.state.memories, [input.key]: input.value },
        });
        return `Memory stored: "${input.key}" = "${input.value}"`;
      },
    },
    getMemory: {
      name: "getMemory",
      description: "Retrieve a memory by its key",
      inputSchema: z.object({
        key: z.string().describe("The key of the memory to retrieve"),
      }),
      execute: (input: { key: string }, ctx: PackToolContext<MemoryState>) => {
        const value = ctx.state.memories[input.key];
        if (value === undefined) {
          return `No memory found for key: "${input.key}"`;
        }
        return `Memory "${input.key}": ${value}`;
      },
    },
    listMemories: {
      name: "listMemories",
      description: "List all stored memories",
      inputSchema: z.object({}),
      execute: (_input: {}, ctx: PackToolContext<MemoryState>) => {
        const entries = Object.entries(ctx.state.memories);
        if (entries.length === 0) {
          return "No memories stored yet.";
        }
        return entries.map(([key, value]) => `- ${key}: ${value}`).join("\n");
      },
    },
  },
});
