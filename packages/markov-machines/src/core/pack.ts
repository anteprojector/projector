import type { Pack, PackConfig } from "../types/pack";
import type { ContextRef } from "../types/context";

/**
 * Create a new pack definition.
 *
 * @example
 * const planContext = createContext({
 *   name: "plan",
 *   schema: z.object({
 *     steps: z.array(z.object({ id: z.string(), status: z.string() })),
 *   }),
 *   initialState: { steps: [] },
 * });
 *
 * const planPack = createPack(planContext, {
 *   name: "plan",
 *   description: "Track a multi-step plan",
 *   tools: {
 *     addStep: {
 *       name: "addStep",
 *       description: "Add a step to the plan",
 *       inputSchema: z.object({ description: z.string() }),
 *       execute: (input, ctx) => {
 *         ctx.updateState({ steps: [...ctx.state.steps, { id: "...", status: "pending" }] });
 *         return "Step added";
 *       },
 *     },
 *   },
 * });
 */
export function createPack<S>(context: ContextRef<S>, config: PackConfig<S>): Pack<S> {
  return {
    name: config.name,
    description: config.description,
    context,
    instructions: config.instructions,
    tools: config.tools ?? {},
    commands: config.commands,
  };
}
