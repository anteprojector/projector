import { z } from "zod";
import { createNode, createTransition, spawn, cede } from "markov-machines";
import { demoMemoryNode } from "./demo-memory";
import { demoPingNode } from "./demo-ping";
import { demoFavoritesNode } from "./demo-favorites";
import { themePack } from "../packs/theme";

export const fooStateValidator = z.object({
  name: z.string(),
});

export type FooState = z.infer<typeof fooStateValidator>;

export const fooNode = createNode({
  instructions: `You are a friendly guide for the markov-machines demo.
Your name is stored in your state - greet the user with it!

You can demonstrate three key features by spawning child nodes:
1. Memory Demo - Shows the Pack system with persistent key-value storage
2. Ping Demo - Shows Commands that bypass the LLM for instant responses
3. Favorites Demo - Shows Node State with real-time state updates

Explain what each demo will show, then use the appropriate spawn transition.
When a child node cedes back to you, you'll receive their summary message.

The user can watch the Instance Tree tab to see nodes spawn and cede.
Encourage them to explore the right panel as you navigate!

When the user is done, you can use cedeToParent to say goodbye.`,

  validator: fooStateValidator,
  packs: [themePack],
  transitions: {
    spawnMemoryDemo: createTransition<FooState>({
      description: "Spawn the Memory Demo node to showcase the Pack system",
      execute: () => spawn(demoMemoryNode, {}),
    }),
    spawnPingDemo: createTransition<FooState>({
      description: "Spawn the Ping Demo node to showcase Commands",
      execute: () => spawn(demoPingNode, {}),
    }),
    spawnFavoritesDemo: createTransition<FooState>({
      description: "Spawn the Favorites Demo node to showcase Node State",
      execute: () =>
        spawn(demoFavoritesNode, {
          airplane: undefined,
          ungulate: undefined,
          mathematician: undefined,
        }),
    }),
    cedeToParent: createTransition<FooState>({
      description: "Say goodbye and cede back to the root node",
      execute: (state) => cede(`${state.name} says goodbye!`),
    }),
  },
  initialState: { name: "" },
});
