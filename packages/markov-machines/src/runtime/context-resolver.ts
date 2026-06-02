import type { Charter } from "../types/charter";
import type { Context, ContextRef } from "../types/context";
import type { Instance } from "../types/instance";
import type { Pack } from "../types/pack";
import { isRef } from "../types/refs";

/**
 * Resolve an inline context or a charter context ref.
 */
export function resolveContextRef<S>(
  charter: Charter,
  contextRef: ContextRef<S>,
): Context<S> {
  if (isRef(contextRef)) {
    const context = charter.contexts.find((c) => c.name === contextRef.ref);
    if (!context) {
      throw new Error(`Context not found in charter: ${contextRef.ref}`);
    }
    return context as Context<S>;
  }
  return contextRef;
}

/**
 * Resolve the context that owns a pack's state.
 */
export function resolvePackContext<S>(
  charter: Charter,
  pack: Pack<S>,
): Context<S> {
  return resolveContextRef(charter, pack.context);
}

/**
 * Get context state from the root record, lazily initializing if missing.
 * Mutates contextStates by adding the initialized state.
 */
export function getOrInitContextState<S>(
  contextStates: Record<string, unknown>,
  context: Context<S>,
): S {
  if (!(context.name in contextStates)) {
    contextStates[context.name] = context.initialState ?? {};
  }
  return contextStates[context.name] as S;
}

/**
 * Collect all packs attached to nodes in an instance tree.
 */
export function getAllNodePacks(root: Instance): Pack[] {
  const packs: Pack[] = [];
  const seen = new Set<string>();

  const visit = (instance: Instance): void => {
    for (const pack of instance.node.packs ?? []) {
      if (!seen.has(pack.name)) {
        seen.add(pack.name);
        packs.push(pack);
      }
    }
    for (const child of instance.children ?? []) {
      visit(child);
    }
  };

  visit(root);
  return packs;
}

/**
 * Initialize root context state for any supplied packs.
 */
export function initPackContexts(
  charter: Charter,
  rootContext: Record<string, unknown>,
  packs: Pack[] | undefined,
): void {
  for (const pack of packs ?? []) {
    const context = resolvePackContext(charter, pack);
    getOrInitContextState(rootContext, context);
  }
}
