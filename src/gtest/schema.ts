/**
 * `.gtest` (gtest/1) descriptor types + loader.
 *
 * This mirrors the canonical format owned by the kosmos container
 * (container/src/types.ts `GtestDescriptor` + container/src/gtest.ts), ported so
 * relay can run a `.gtest` headlessly. A `.gtest` is an end-to-end game-state
 * test: a flat list of `stages`, each booting irisd, optionally running
 * setup (server HTTP / relay — relay deferred), capturing a screenshot, then
 * asserting against a SQLite DB and/or an authoritative server.
 *
 * The run.json shape this produces (see verdict.ts `GtestRun`) is identical to
 * the container's, so the container UI reads relay-produced runs unchanged.
 */

import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Comparison operator for gtest assertions. */
export type GtestOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'contains' | 'exists';

export interface Camera {
  posX: number; posY: number; posZ: number;
  rotX?: number; rotY?: number; rotZ?: number;
  fov?: number;
}

/** One relay action applied before the stage screenshot (needs live player). */
export interface GtestRelayAction { cmd: string; id?: string; patch?: Record<string, unknown>; args?: Record<string, unknown>; }
/** One HTTP request sent to the authoritative server before the screenshot. */
export interface GtestServerAction { method?: string; path: string; body?: Record<string, unknown>; }
export interface GtestStageSetup { relay?: GtestRelayAction[]; server?: GtestServerAction[]; }

export interface GtestRelayAssert { entity: string; component: string; field?: string; op: GtestOp; value?: unknown; }
export interface GtestDbAssert { table: string; column: string; where?: string; op: GtestOp; value?: unknown; }
export interface GtestServerAssert { path: string; field?: string; op: GtestOp; value?: unknown; }
export interface GtestStageAssert { relay?: GtestRelayAssert[]; db?: GtestDbAssert[]; server?: GtestServerAssert[]; }

export interface GtestScreenshotSpec { camera: Camera; size?: { width: number; height: number }; }

export interface GtestStage {
  name: string;
  scene?: string;
  init?: string;
  setup?: GtestStageSetup;
  wait?: number;
  screenshot?: GtestScreenshotSpec;
  assert?: GtestStageAssert;
}

export interface GtestDescriptor {
  kind?: string; // "gtest/1"
  name?: string;
  scene?: string;
  server?: string;
  db?: string;
  stages: GtestStage[];
}

export class GtestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GtestParseError';
  }
}

export async function loadDescriptor(descriptorPath: string): Promise<GtestDescriptor> {
  const text = await fs.readFile(path.resolve(descriptorPath), 'utf-8');
  return parseDescriptor(text);
}

export function loadDescriptorSync(descriptorPath: string): GtestDescriptor {
  return parseDescriptor(readFileSync(path.resolve(descriptorPath), 'utf-8'));
}

/** Parse + lightly validate a `.gtest` YAML descriptor. Throws on malformed input. */
export function parseDescriptor(text: string): GtestDescriptor {
  let parsed: GtestDescriptor;
  try {
    parsed = parseYaml(text) as GtestDescriptor;
  } catch (err) {
    throw new GtestParseError(`invalid .gtest: ${(err as Error).message}`);
  }
  if (!parsed || !Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    throw new GtestParseError('.gtest needs a non-empty "stages" list');
  }
  for (const stage of parsed.stages) {
    if (!stage || typeof stage.name !== 'string' || stage.name.length === 0) {
      throw new GtestParseError('.gtest stage is missing "name"');
    }
  }
  return parsed;
}
