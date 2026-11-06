import type { ThreadLifecycleRow } from "../lifecycle";
import { pruneLifecycleRows } from "./safe-storage";
import type { StorageCodec } from "./storage-codec";

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function pruneRows(rows: ReadonlyMap<string, ThreadLifecycleRow>): ReadonlyMap<string, ThreadLifecycleRow> {
  return new Map(pruneLifecycleRows([...rows.values()]).map((row) => [row.threadId, row]));
}

export function decodeLifecycleRows(input: unknown): ReadonlyMap<string, ThreadLifecycleRow> | null {
  if (!Array.isArray(input)) return null;
  const rows = new Map<string, ThreadLifecycleRow>();
  for (const value of input) {
    if (typeof value !== "object" || value === null) return null;
    const row = value as Partial<ThreadLifecycleRow>;
    if (
      typeof row.threadId !== "string" ||
      (row.parkedAt !== undefined && !isNullableNumber(row.parkedAt)) ||
      !isNullableNumber(row.settledAt) ||
      !isNullableNumber(row.snoozedUntil) ||
      !isNullableNumber(row.snoozedAt) ||
      (row.snoozePending !== undefined && typeof row.snoozePending !== "boolean") ||
      (row.settledOverride !== undefined &&
        row.settledOverride !== null &&
        row.settledOverride !== "active" &&
        row.settledOverride !== "settled")
    )
      return null;
    rows.set(row.threadId, {
      threadId: row.threadId,
      parkedAt: row.parkedAt ?? null,
      settledAt: row.settledAt,
      settledOverride: row.settledOverride ?? null,
      snoozedUntil: row.snoozedUntil,
      snoozedAt: row.snoozedAt,
      snoozePending: row.snoozePending === true,
    });
  }
  return pruneRows(rows);
}

export const lifecycleRowsCodec: StorageCodec<ReadonlyMap<string, ThreadLifecycleRow>> = {
  decode: (stored) => (stored ? decodeLifecycleRows(JSON.parse(stored)) : null),
  encode: (rows) => JSON.stringify([...rows.values()]),
  prune: pruneRows,
};
