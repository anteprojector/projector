import { z } from "zod";
import { createNode, createTransition, transitionTo } from "markov-machines";
import { fooNode } from "./foo";

export const rootStateValidator = z.object({});

export type RootState = z.infer<typeof rootStateValidator>;

export const rootNode = createNode({
  instructions: `You are the entry point for the markov-machines demo.

Your only job is to ask the user: "First, who do you want to talk to?"

When they give you a name, use the toFoo transition to hand off to the Foo node with that name.
The Foo node will then guide them through the demo features.

Be brief and welcoming!`,

  validator: rootStateValidator,
  transitions: {
    toFoo: createTransition<RootState>({
      description: "Transition to the Foo node with the given name",
      arguments: z.object({
        name: z.string().describe("The name the user wants to talk to"),
      }),
      execute: (_state, ctx) => {
        const args = ctx.args as { name: string };
        return transitionTo(fooNode, { name: args.name });
      },
    }),
  },
  initialState: {},
});
