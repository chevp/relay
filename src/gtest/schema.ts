/**
 * `.gtest` (gtest/1) types + runtime validator.
 *
 * A `.gtest` is a flat list of named `stages` (NOT a DAG). The format already
 * exists in the wild — see runtime/iris-examples/examples/{14-snake-2d,18-ng-snake}/
 * tests/snake.gtest — where it was screenshot-only for manual visual checks.
 * This parser is the canonical relay-side reader and adds the assert vocabulary
 * (engine-state + pixel) on top of the existing fields.
 *
 * Parsing mirrors scenario/schema.ts: the `yaml` lib with line-accurate errors.
 * Unknown *fields* on a known stage are ignored (overlay policy, ADR-0007);
 * an unknown top-level shape is a hard error (fail-fast on a malformed file).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument, LineCounter, isMap, type Node } from 'yaml';

// ─── camera ──────────────────────────────────────────────────────────────────

export interface Camera {
  posX: number; posY: number; posZ: number;
  rotX?: number; rotY?: number; rotZ?: number;
  fov?: number;
}

// ─── asserts ──────────────────────────────────────────────────────────────────

/** A generic engine-state query: send `query`(`args`), pull `path`, compare. */
export interface StateAssert {
  query: string;
  args?: Record<string, unknown>;
  /** Dotted path into the daemon result (e.g. "transform.position.x"). */
  path?: string;
  /** Deep-equality expectation. Mutually informative with `exists`. */
  equals?: unknown;
  /** When set, asserts the (path-resolved) value is present / absent. */
  exists?: boolean;
}

export interface StageAssert {
  sceneLoaded?: boolean;
  entityCount?: number;
  /** Each id must resolve to a non-null entity via the daemon `getEntity` cmd. */
  entities?: string[];
  /** Generic engine-state escape hatch. */
  state?: StateAssert[];
}

// ─── screenshot ────────────────────────────────────────────────────────────────

export interface Screenshot {
  camera: Camera;
  /** Output PNG name (relative to the run cache). Default: slug(stage.name).png */
  out?: string;
  /** Baseline PNG (relative to the .gtest file). Presence enables the pixel assert. */
  baseline?: string;
  /** Max fraction of differing pixels (0..1). 0 (default) = exact byte match. */
  tolerance?: number;
}

// ─── stage / suite ──────────────────────────────────────────────────────────────

export interface Stage {
  name: string;
  /** App expression evaluated before the stage (sent as the `eval` daemon cmd). */
  init?: string;
  /** Settle delay in ms before capture/asserts. */
  wait?: number;
  screenshot?: Screenshot;
  assert?: StageAssert;
  /** 1-based source line, for diagnostics. */
  line: number;
}

export interface GTest {
  kind: string;          // "gtest/1"
  name: string;
  description?: string;
  version?: string;
  /** Optional scene/bundle, resolved relative to the .gtest file. */
  scene?: string;
  stages: Stage[];
  /** Absolute path of the .gtest file (resolved). */
  source: string;
}

export class GTestParseError extends Error {
  constructor(public readonly file: string, public readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = 'GTestParseError';
  }
}

export async function loadGTest(gtestPath: string): Promise<GTest> {
  const absPath = path.resolve(gtestPath);
  const text = await fs.readFile(absPath, 'utf-8');
  return parseGTest(text, absPath);
}

export function parseGTest(text: string, sourcePath: string): GTest {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const line = lineCounter.linePos(e.pos?.[0] ?? 0).line;
    throw new GTestParseError(sourcePath, line, e.message);
  }
  const root = doc.contents;
  if (!root || !isMap(root)) {
    throw new GTestParseError(sourcePath, 1, '.gtest must be a YAML map at top level');
  }
  const lineOf = (node: Node | null | undefined): number =>
    node?.range ? lineCounter.linePos(node.range[0]).line : 1;

  const obj = root.toJSON() as Record<string, unknown>;

  const kind = obj.kind;
  if (typeof kind !== 'string' || !/^gtest\/\d+$/.test(kind)) {
    throw new GTestParseError(sourcePath, lineOf(root.get('kind', true) as Node),
      'kind must be "gtest/1" (or another gtest/<n>)');
  }
  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new GTestParseError(sourcePath, lineOf(root.get('name', true) as Node),
      'name must be a non-empty string');
  }
  const optString = (key: string): string | undefined => {
    const v = obj[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string') {
      throw new GTestParseError(sourcePath, lineOf(root.get(key, true) as Node),
        `${key} must be a string (or omitted)`);
    }
    return v;
  };

  const stagesNode = root.get('stages', true) as Node | undefined;
  const stagesJson = obj.stages;
  if (!Array.isArray(stagesJson) || stagesJson.length === 0) {
    throw new GTestParseError(sourcePath, lineOf(stagesNode),
      'stages must be a non-empty YAML list');
  }
  const stageSeq = (stagesNode && 'items' in stagesNode)
    ? (stagesNode as { items: Node[] }).items
    : [];

  const stages = stagesJson.map((raw, i) =>
    parseStage(raw, lineOf(stageSeq[i]), sourcePath));

  return {
    kind,
    name,
    description: optString('description'),
    version: optString('version'),
    scene: optString('scene'),
    stages,
    source: path.resolve(sourcePath),
  };
}

function parseStage(raw: unknown, line: number, source: string): Stage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GTestParseError(source, line, 'stage must be a map with at least a "name"');
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.length === 0) {
    throw new GTestParseError(source, line, 'stage.name must be a non-empty string');
  }
  const stage: Stage = { name: v.name, line };

  if (v.init !== undefined) {
    if (typeof v.init !== 'string' || v.init.length === 0) {
      throw new GTestParseError(source, line, `stage "${v.name}": init must be a non-empty string`);
    }
    stage.init = v.init;
  }
  if (v.wait !== undefined) {
    if (typeof v.wait !== 'number' || !Number.isFinite(v.wait) || v.wait < 0) {
      throw new GTestParseError(source, line, `stage "${v.name}": wait must be a non-negative number of ms`);
    }
    stage.wait = v.wait;
  }
  if (v.screenshot !== undefined) stage.screenshot = parseScreenshot(v.screenshot, v.name, line, source);
  if (v.assert !== undefined) stage.assert = parseAssert(v.assert, v.name, line, source);

  return stage;
}

function parseScreenshot(raw: unknown, stageName: string, line: number, source: string): Screenshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GTestParseError(source, line, `stage "${stageName}": screenshot must be a map`);
  }
  const v = raw as Record<string, unknown>;
  const shot: Screenshot = { camera: parseCamera(v.camera, stageName, line, source) };

  if (v.out !== undefined) {
    if (typeof v.out !== 'string' || v.out.length === 0) {
      throw new GTestParseError(source, line, `stage "${stageName}": screenshot.out must be a non-empty string`);
    }
    shot.out = v.out;
  }
  if (v.baseline !== undefined) {
    if (typeof v.baseline !== 'string' || v.baseline.length === 0) {
      throw new GTestParseError(source, line, `stage "${stageName}": screenshot.baseline must be a non-empty string`);
    }
    shot.baseline = v.baseline;
  }
  if (v.tolerance !== undefined) {
    if (typeof v.tolerance !== 'number' || !Number.isFinite(v.tolerance) || v.tolerance < 0 || v.tolerance > 1) {
      throw new GTestParseError(source, line, `stage "${stageName}": screenshot.tolerance must be a number in [0,1]`);
    }
    shot.tolerance = v.tolerance;
  }
  return shot;
}

function parseCamera(raw: unknown, stageName: string, line: number, source: string): Camera {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GTestParseError(source, line, `stage "${stageName}": screenshot.camera must be a map`);
  }
  const v = raw as Record<string, unknown>;
  const num = (key: string, required: boolean): number | undefined => {
    const n = v[key];
    if (n === undefined) {
      if (required) throw new GTestParseError(source, line, `stage "${stageName}": camera.${key} is required`);
      return undefined;
    }
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new GTestParseError(source, line, `stage "${stageName}": camera.${key} must be a finite number`);
    }
    return n;
  };
  const cam: Camera = {
    posX: num('posX', true)!,
    posY: num('posY', true)!,
    posZ: num('posZ', true)!,
  };
  const rotX = num('rotX', false); if (rotX !== undefined) cam.rotX = rotX;
  const rotY = num('rotY', false); if (rotY !== undefined) cam.rotY = rotY;
  const rotZ = num('rotZ', false); if (rotZ !== undefined) cam.rotZ = rotZ;
  const fov = num('fov', false); if (fov !== undefined) cam.fov = fov;
  return cam;
}

function parseAssert(raw: unknown, stageName: string, line: number, source: string): StageAssert {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GTestParseError(source, line, `stage "${stageName}": assert must be a map`);
  }
  const v = raw as Record<string, unknown>;
  const out: StageAssert = {};

  if (v.sceneLoaded !== undefined) {
    if (typeof v.sceneLoaded !== 'boolean') {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.sceneLoaded must be a boolean`);
    }
    out.sceneLoaded = v.sceneLoaded;
  }
  if (v.entityCount !== undefined) {
    if (typeof v.entityCount !== 'number' || !Number.isInteger(v.entityCount) || v.entityCount < 0) {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.entityCount must be a non-negative integer`);
    }
    out.entityCount = v.entityCount;
  }
  if (v.entities !== undefined) {
    if (!Array.isArray(v.entities) || v.entities.some((e) => typeof e !== 'string' || e.length === 0)) {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.entities must be a list of non-empty strings`);
    }
    out.entities = v.entities as string[];
  }
  if (v.state !== undefined) {
    if (!Array.isArray(v.state)) {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.state must be a list`);
    }
    out.state = v.state.map((s) => parseStateAssert(s, stageName, line, source));
  }
  return out;
}

function parseStateAssert(raw: unknown, stageName: string, line: number, source: string): StateAssert {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GTestParseError(source, line, `stage "${stageName}": assert.state[] must be a map`);
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.query !== 'string' || v.query.length === 0) {
    throw new GTestParseError(source, line, `stage "${stageName}": assert.state[].query must be a non-empty string`);
  }
  if ('equals' in v === false && 'exists' in v === false) {
    throw new GTestParseError(source, line, `stage "${stageName}": assert.state[] needs "equals" or "exists"`);
  }
  const s: StateAssert = { query: v.query };
  if (v.args !== undefined) {
    if (typeof v.args !== 'object' || v.args === null || Array.isArray(v.args)) {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.state[].args must be a map`);
    }
    s.args = v.args as Record<string, unknown>;
  }
  if (v.path !== undefined) {
    if (typeof v.path !== 'string' || v.path.length === 0) {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.state[].path must be a non-empty string`);
    }
    s.path = v.path;
  }
  if ('equals' in v) s.equals = v.equals;
  if ('exists' in v) {
    if (typeof v.exists !== 'boolean') {
      throw new GTestParseError(source, line, `stage "${stageName}": assert.state[].exists must be a boolean`);
    }
    s.exists = v.exists;
  }
  return s;
}
