/**
 * `.gtest` assert primitives + run/result types.
 *
 * `applyOp` and `getNestedField` are pure (unit-tested); the run/result shapes
 * are byte-for-byte the container's `GtestRun` so a relay-produced run.json is
 * read unchanged by the container UI.
 */

import type { GtestOp } from './schema.js';

export type GtestStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface GtestAssertResult {
  label: string;
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  error?: string;
}

export interface GtestStageResult {
  name: string;
  status: GtestStatus;
  ms?: number;
  screenshot?: string;
  asserts: GtestAssertResult[];
  log: string[];
  error?: string;
}

export interface GtestRun {
  descriptor: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  stages: GtestStageResult[];
}

/** Evaluate one comparison. Numeric ops coerce; eq/ne/contains compare as strings. */
export function applyOp(op: GtestOp, actual: unknown, expected: unknown): boolean {
  if (op === 'exists') return actual !== null && actual !== undefined;
  if (op === 'eq') return String(actual) === String(expected);
  if (op === 'ne') return String(actual) !== String(expected);
  if (op === 'contains') return String(actual).includes(String(expected));
  const a = Number(actual);
  const e = Number(expected);
  if (op === 'lt') return a < e;
  if (op === 'lte') return a <= e;
  if (op === 'gt') return a > e;
  if (op === 'gte') return a >= e;
  return false;
}

/** Resolve a dotted field path into a nested object; undefined if any hop misses. */
export function getNestedField(obj: unknown, field: string): unknown {
  let cur: unknown = obj;
  for (const p of field.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
