import type { z } from "zod";
import type { Ref } from "./refs";
import type { ExternalizeStateConfig } from "./externalize";

/**
 * Shared root-hoisted state definition.
 * Context state is stored on the root instance under instance.context[context.name].
 */
export interface Context<S = unknown> {
  /** Context name (used as the state key and for refs) */
  name: string;
  /** Zod schema for context state validation */
  schema: z.ZodType<S>;
  /** Optional initial state */
  initialState?: S;
  /** Optional externalized state ownership hooks */
  externalize?: ExternalizeStateConfig<S>;
}

/**
 * Configuration for creating a context.
 */
export interface ContextConfig<S = unknown> {
  name: string;
  schema: z.ZodType<S>;
  initialState?: S;
  externalize?: ExternalizeStateConfig<S>;
}

/**
 * A context definition or a ref to one registered on the charter.
 */
export type ContextRef<S = unknown> = Context<S> | Ref;

/**
 * Type guard for Context.
 */
export function isContext(value: unknown): value is Context {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "schema" in value &&
    typeof (value as Context).name === "string"
  );
}
