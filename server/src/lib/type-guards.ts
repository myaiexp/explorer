// Runtime type guards for request-body validation — shared across route modules.

export type AnyRecord = Record<string, unknown>;

export function isObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
