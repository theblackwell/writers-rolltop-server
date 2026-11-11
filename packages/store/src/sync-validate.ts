// Request validation for sync protocol v1 (Spec/docs/sync-protocol-v1.md, schemas/sync-v1.schema.json). A port of
// the reference model's validatePush (Spec/tools/sync-model.mjs); the sync scenario runner exercises both.

import { RECORD_KINDS } from "@writers-rolltop/archive";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FIELD = new RegExp(`^([A-Za-z][A-Za-z0-9]*|values/${UUID_SRC}|overrides/${UUID_SRC})$`);

const KINDS = new Set<string>(RECORD_KINDS);

export const RESERVED_FIELDS = new Set(["id", "createdAt", "updatedAt", "deletedAt"]);
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

type Json = unknown;
export type SyncOp =
  | { opId: string; op: "create"; recordKind: string; recordId: string; value: Record<string, Json> }
  | { opId: string; op: "set"; recordKind: string; recordId: string; field: string; baseSeq: number; value: Json }
  | { opId: string; op: "unset"; recordKind: string; recordId: string; field: string; baseSeq: number }
  | { opId: string; op: "tombstone"; recordKind: string; recordId: string; baseSeq: number }
  | { opId: string; op: "restore"; recordKind: string; recordId: string }
  | { opId: string; op: "document"; recordKind: "document"; recordId: string; baseRevision: number; value: Record<string, Json> }
  | { opId: string; op: "resolve"; conflictId: string };
export interface PushBody { epoch: string; deviceId: string; ops: SyncOp[] }

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isSeq = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_SAFE;
const isUuid = (v: unknown): boolean => typeof v === "string" && UUID.test(v);
const anyKind = (v: unknown): boolean => (typeof v === "string" && KINDS.has(v)) || v === "document";
const isField = (v: unknown): boolean => typeof v === "string" && [...v].length <= 128 && FIELD.test(v);

const SHAPES: Record<string, Record<string, (v: unknown) => boolean>> = {
  create: { recordKind: anyKind, recordId: isUuid, value: isObj },
  set: { recordKind: anyKind, recordId: isUuid, field: isField, baseSeq: isSeq, value: () => true },
  unset: { recordKind: anyKind, recordId: isUuid, field: isField, baseSeq: isSeq },
  tombstone: { recordKind: anyKind, recordId: isUuid, baseSeq: isSeq },
  restore: { recordKind: anyKind, recordId: isUuid },
  document: { recordKind: (v) => v === "document", recordId: isUuid, baseRevision: isSeq, value: isObj },
  resolve: { conflictId: (v) => typeof v === "string" && [...v].length >= 1 && [...v].length <= 64 },
};

/** True when the body is a valid push request (the closed shapes of the schema). Reads no state. */
export function isValidPush(body: unknown): body is PushBody {
  if (!isObj(body)) return false;
  const top = Object.keys(body);
  if (top.length !== 3 || !top.every((k) => k === "epoch" || k === "deviceId" || k === "ops")) return false;
  if (!isUuid(body.epoch) || !isUuid(body.deviceId) || !Array.isArray(body.ops) || body.ops.length < 1 || body.ops.length > 200) return false;
  for (const op of body.ops) {
    if (!isObj(op) || !isUuid(op.opId)) return false;
    const shape = typeof op.op === "string" && Object.hasOwn(SHAPES, op.op) ? SHAPES[op.op] : undefined;
    if (!shape) return false;
    if (!Object.keys(op).every((k) => k === "opId" || k === "op" || Object.hasOwn(shape, k))) return false;
    for (const [k, check] of Object.entries(shape)) if (!Object.hasOwn(op, k) || !check(op[k])) return false;
  }
  return true;
}

/** Canonical decimal `after` (0 to 2^53-1) and `limit` (1 to 1000), as the reference model checks them. */
export const isAfter = (s: string): boolean => /^(0|[1-9]\d{0,15})$/.test(s) && Number.isSafeInteger(Number(s));
export const isLimit = (s: string): boolean => /^[1-9]\d{0,3}$/.test(s) && Number(s) <= 1000;

const MAX_DEPTH = 64;

/**
 * True when a protocol value cannot be stored as jsonb or sent back unchanged: a lone surrogate or U+0000 in a string
 * or key (jsonb refuses both), a number that is not finite (it would become null), or nesting deeper than 64 levels.
 * Iterative, so a deeply nested value cannot overflow the stack.
 */
export function unstorableValue(root: unknown): boolean {
  const stack: { v: unknown; depth: number }[] = [{ v: root, depth: 1 }];
  const badString = (s: string): boolean => !s.isWellFormed() || s.includes("\u0000");
  while (stack.length > 0) {
    const { v, depth } = stack.pop()!;
    if (typeof v === "string") { if (badString(v)) return true; }
    else if (typeof v === "number") { if (!Number.isFinite(v)) return true; }
    else if (Array.isArray(v) || isObj(v)) {
      if (depth > MAX_DEPTH) return true;
      if (Array.isArray(v)) for (const x of v) stack.push({ v: x, depth: depth + 1 });
      else for (const [k, x] of Object.entries(v)) {
        if (badString(k)) return true;
        stack.push({ v: x, depth: depth + 1 });
      }
    }
  }
  return false;
}
