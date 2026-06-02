import type { Context, ContextConfig } from "../types/context";

/**
 * Create a new shared root-hoisted context definition.
 */
export function createContext<S>(config: ContextConfig<S>): Context<S> {
  return {
    name: config.name,
    schema: config.schema,
    initialState: config.initialState,
    externalize: config.externalize,
  };
}
