/**
 * `.gtest` assert evaluation: result model, value comparison, and the pixel
 * comparator.
 *
 * Engine-state asserts are evaluated by the runner (it owns the daemon WS); the
 * *pure* comparison helpers (`getPath`, `valuesEqual`) live here so they are
 * unit-testable without a daemon. Pixel asserts compare a captured PNG to a
 * baseline: exact (SHA-256 byte equality, zero extra deps) by default, or within
 * a pixel tolerance via the optional `pixelmatch` + `pngjs` extra.
 */

import { promises as fs } from 'node:fs';
import { hashFile } from '../manifest/sha256.js';

export type AssertStatus = 'pass' | 'fail' | 'error';

export interface AssertResult {
  /** Human label, e.g. `entityCount == 12` or `pixel start.png`. */
  label: string;
  status: AssertStatus;
  expected?: unknown;
  actual?: unknown;
  /** Failure / error explanation. */
  detail?: string;
}

export interface StageResult {
  name: string;
  status: AssertStatus;
  /** Per-assert outcomes (empty for a screenshot-only stage). */
  asserts: AssertResult[];
  durationMs: number;
  /** A stage-level error (init / capture / daemon failure) short-circuits asserts. */
  error?: string;
}

export interface GTestResult {
  gtest: string;        // source path
  name: string;
  status: 'pass' | 'fail';
  startedAt: string;
  durationMs: number;
  outDir: string;
  stages: StageResult[];
}

// ─── pure value comparison (unit-tested) ─────────────────────────────────────

/** Resolve a dotted path into a value; returns `undefined` if any hop is absent. */
export function getPath(obj: unknown, dotted: string | undefined): unknown {
  if (!dotted) return obj;
  let cur: unknown = obj;
  for (const key of dotted.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Structural equality for the JSON-ish values asserts deal in. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && valuesEqual(ao[k], bo[k]));
}

// ─── pixel comparison ─────────────────────────────────────────────────────────

export interface PixelOutcome {
  pass: boolean;
  detail: string;
}

/**
 * Compare `actualPath` against `baselinePath`. `tolerance` is the max fraction
 * of differing pixels (0 = exact). Exact compares SHA-256 byte equality with no
 * extra dependency; a non-zero tolerance dynamically loads the optional
 * `pixelmatch` + `pngjs` extra and fails with an install hint if it is absent.
 */
export async function comparePixels(
  actualPath: string,
  baselinePath: string,
  tolerance = 0,
): Promise<PixelOutcome> {
  try {
    await fs.access(baselinePath);
  } catch {
    return { pass: false, detail: `baseline not found: ${baselinePath}` };
  }

  if (tolerance <= 0) {
    const [a, b] = await Promise.all([hashFile(actualPath), hashFile(baselinePath)]);
    return a === b
      ? { pass: true, detail: 'exact match' }
      : { pass: false, detail: `sha256 mismatch (actual ${a.slice(0, 12)}… vs baseline ${b.slice(0, 12)}…)` };
  }

  const tools = await loadPixelTools();
  if (!tools) {
    return {
      pass: false,
      detail: 'tolerance compare needs the pixel extra — `npm i pixelmatch pngjs` (or run with tolerance: 0 for exact)',
    };
  }
  const { pixelmatch, PNG } = tools;
  const [aBuf, bBuf] = await Promise.all([fs.readFile(actualPath), fs.readFile(baselinePath)]);
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { pass: false, detail: `size mismatch (actual ${a.width}x${a.height} vs baseline ${b.width}x${b.height})` };
  }
  const diff = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 });
  const total = a.width * a.height;
  const frac = total === 0 ? 0 : diff / total;
  return frac <= tolerance
    ? { pass: true, detail: `${(frac * 100).toFixed(3)}% differing pixels (≤ ${(tolerance * 100).toFixed(3)}%)` }
    : { pass: false, detail: `${(frac * 100).toFixed(3)}% differing pixels (> ${(tolerance * 100).toFixed(3)}%)` };
}

interface PixelTools {
  pixelmatch: (
    a: Uint8Array, b: Uint8Array, out: Uint8Array | null,
    w: number, h: number, opts?: { threshold?: number },
  ) => number;
  PNG: { sync: { read: (buf: Buffer) => { width: number; height: number; data: Uint8Array } } };
}

async function loadPixelTools(): Promise<PixelTools | null> {
  try {
    const pm = await import('pixelmatch' as string);
    const png = await import('pngjs' as string);
    return {
      pixelmatch: (pm.default ?? pm) as PixelTools['pixelmatch'],
      PNG: (png.PNG ?? png.default?.PNG ?? png.default) as PixelTools['PNG'],
    };
  } catch {
    return null;
  }
}
