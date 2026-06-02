"use node";

import { action } from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  createInstance,
  createMachine,
  serializeInstance,
  type Instance,
  type Node,
} from "markov-machines";
import { nameGateNode, fooNode } from "../../../apps/demo-agent/src/agent/nodes.js";
import { createDemoCharter } from "../../../apps/demo-agent/src/agent/charter.js";
import { serializeInstanceForDisplay } from "markov-machines";

// Charter for serialization only — executor is unused
const demoCharter = createDemoCharter({ executor: { run: async () => ({ response: [] }) } as any });

export const createSession = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const instance: Instance = createMachine(demoCharter, {
      instance: createInstance(nameGateNode as Node<unknown>, {}),
    }).instance;

    const serializedInstance = serializeInstance(instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(instance, demoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    return sessionId;
  },
});

export const createSessionAtFoo = action({
  args: {},
  handler: async (ctx): Promise<Id<"sessions">> => {
    const instance: Instance = createMachine(demoCharter, {
      instance: createInstance(fooNode as Node<unknown>, { name: "Foo" }),
    }).instance;

    const serializedInstance = serializeInstance(instance, demoCharter);
    const displayInstance = serializeInstanceForDisplay(instance, demoCharter);

    const sessionId = await ctx.runMutation(api.sessions.create, {
      instanceId: instance.id,
      instance: serializedInstance,
      displayInstance,
    });

    return sessionId;
  },
});
