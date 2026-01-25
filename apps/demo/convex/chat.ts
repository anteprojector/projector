"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  runMachine,
  createMachine,
  serializeInstance,
  deserializeInstance,
  createInstance,
  getMessageText,
  type Instance,
  type Node,
  type ModelMessage,
  type MachineStep,
} from "markov-machines";
import { demoCharter, nameGateNode } from "../src/agent/charter";
import { serializeInstanceForDisplay } from "../src/serializeForDisplay";

function getActiveNodeInstructions(instance: Instance): string {
  const instructions = instance.node.instructions || "";
  return instructions.slice(0, 10000);
}

// Filter out messages with empty items (Anthropic API requires non-empty content)
function filterValidMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((msg) => {
    if (!msg.items) return false;
    if (Array.isArray(msg.items)) {
      return msg.items.length > 0;
    }
    if (typeof msg.items === "string") {
      return msg.items.length > 0;
    }
    return true;
  });
}

function getStepResponse(step: MachineStep<unknown>): string {
  for (let i = step.history.length - 1; i >= 0; i--) {
    const msg = step.history[i];
    if (msg && msg.role === "assistant") {
      return getMessageText(msg);
    }
  }
  return "";
}

export const send = action({
  args: {
    sessionId: v.id("sessions"),
    message: v.string(),
  },
  handler: async (ctx, { sessionId, message }): Promise<string> => {
    const session = await ctx.runQuery(api.sessions.get, { id: sessionId });
    if (!session) {
      throw new Error("Session not found");
    }

    const history = await ctx.runQuery(api.sessions.getFullHistory, { sessionId });

    const instance = deserializeInstance(demoCharter, session.instance);

    const machine = createMachine(demoCharter, {
      instance,
      history: filterValidMessages(history as ModelMessage[]),
    });

    // Create turn first so user message can be associated with it
    const turnId = await ctx.runMutation(api.machineTurns.create, {
      sessionId,
      parentId: session.turnId,
      instanceId: machine.instance.id,
      instance: serializeInstance(machine.instance, demoCharter),
      displayInstance: serializeInstanceForDisplay(machine.instance, demoCharter),
    });

    // Add user message with turnId for proper time travel filtering
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "user",
      content: message,
      turnId,
    });

    let stepNumber = 0;
    let lastStep: MachineStep | null = null;
    const allMessages: ModelMessage[] = [];

    for await (const step of runMachine(machine, message, { maxSteps: 10 })) {
      stepNumber++;
      allMessages.push(...step.history);

      await ctx.runMutation(api.machineSteps.add, {
        sessionId,
        turnId,
        stepNumber,
        yieldReason: step.yieldReason,
        response: getStepResponse(step),
        done: step.done,
        messages: step.history,
        instance: serializeInstance(step.instance, demoCharter),
        displayInstance: serializeInstanceForDisplay(step.instance, demoCharter),
        activeNodeInstructions: getActiveNodeInstructions(step.instance),
      });

      lastStep = step;
    }

    if (!lastStep) {
      throw new Error("No steps executed");
    }

    await ctx.runMutation(api.sessions.finalizeTurn, {
      turnId,
      instance: serializeInstance(lastStep.instance, demoCharter),
      displayInstance: serializeInstanceForDisplay(lastStep.instance, demoCharter),
      messages: allMessages,
    });

    const responseText = getStepResponse(lastStep);
    await ctx.runMutation(api.messages.add, {
      sessionId,
      role: "assistant",
      content: responseText,
      turnId,
    });

    return responseText;
  },
});

// Initialize pack states from a node's packs
function initPackStates(node: Node<unknown>): Record<string, unknown> {
  const packStates: Record<string, unknown> = {};
  for (const pack of node.packs ?? []) {
    if (pack.initialState !== undefined) {
      packStates[pack.name] = pack.initialState;
    }
  }
  return packStates;
}

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const packStates = initPackStates(nameGateNode as Node<unknown>);
    const instance: Instance = createInstance(nameGateNode as Node<unknown>, {}, undefined, packStates);

    const serializedInstance = serializeInstance(instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(instance, demoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    // Trigger initial agent response
    const machine = createMachine(demoCharter, {
      instance,
      history: [],
    });

    const turnId = await ctx.runMutation(api.machineTurns.create, {
      sessionId,
      parentId: undefined,
      instanceId: machine.instance.id,
      instance: serializeInstance(machine.instance, demoCharter),
      displayInstance: serializeInstanceForDisplay(machine.instance, demoCharter),
    });

    let stepNumber = 0;
    let lastStep: MachineStep | null = null;
    const allMessages: ModelMessage[] = [];

    // Run with empty input to trigger initial greeting
    for await (const step of runMachine(machine, "[session started]", { maxSteps: 10 })) {
      stepNumber++;
      allMessages.push(...step.history);

      await ctx.runMutation(api.machineSteps.add, {
        sessionId,
        turnId,
        stepNumber,
        yieldReason: step.yieldReason,
        response: getStepResponse(step),
        done: step.done,
        messages: step.history,
        instance: serializeInstance(step.instance, demoCharter),
        displayInstance: serializeInstanceForDisplay(step.instance, demoCharter),
        activeNodeInstructions: getActiveNodeInstructions(step.instance),
      });

      lastStep = step;
    }

    if (lastStep) {
      await ctx.runMutation(api.sessions.finalizeTurn, {
        turnId,
        instance: serializeInstance(lastStep.instance, demoCharter),
        displayInstance: serializeInstanceForDisplay(lastStep.instance, demoCharter),
        messages: allMessages,
      });

      const responseText = getStepResponse(lastStep);
      if (responseText) {
        await ctx.runMutation(api.messages.add, {
          sessionId,
          role: "assistant",
          content: responseText,
          turnId,
        });
      }
    }

    return sessionId;
  },
});
