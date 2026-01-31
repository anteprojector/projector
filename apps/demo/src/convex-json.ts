/**
 * Convex doesn't allow field names starting with `$`.
 * JSONSchema uses `$schema`, `$id`, `$ref`, etc.
 * These helpers escape/unescape `$`-prefixed keys for Convex storage
 * using the `__$__` prefix (e.g. `$schema` → `__$__schema`).
 */

const ESCAPE_PREFIX = "__$__";

/**
 * Sanitize an object for Convex storage by replacing `$`-prefixed keys
 * with `__$__`-prefixed equivalents. Recursive for nested objects/arrays.
 */
export function sanitizeForConvex(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForConvex);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const safeKey = key.startsWith("$") ? `${ESCAPE_PREFIX}${key.slice(1)}` : key;
    result[safeKey] = sanitizeForConvex(value);
  }
  return result;
}

/**
 * Reverse sanitization: restore `__$__`-prefixed keys back to `$`-prefixed.
 * Recursive for nested objects/arrays.
 */
export function desanitizeForConvex(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map(desanitizeForConvex);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const restoredKey = key.startsWith(ESCAPE_PREFIX) ? `$${key.slice(ESCAPE_PREFIX.length)}` : key;
    result[restoredKey] = desanitizeForConvex(value);
  }
  return result;
}
