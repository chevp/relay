/**
 * Playbook YAML types + runtime validator (ADR-0008 V1).
 *
 * Vocabulary is intentionally five verbs: loadScene, wait, capture, goto,
 * shutdown. Unknown step kinds are a hard error (fail-fast — a typo'd verb
 * must not be silently skipped). Unknown *fields* on a known step are
 * ignored, mirroring the overlay policy from ADR-0007.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseDocument, LineCounter, isMap, type Node } from 'yaml';

export type StepKind = 'loadScene' | 'wait' | 'capture' | 'goto' | 'shutdown';

export interface StepLoadScene { kind: 'loadScene'; path: string; line: number; }
export interface StepWait      { kind: 'wait';      ms: number;   line: number; }
export interface StepCapture   { kind: 'capture';   out: string;  line: number; }
export interface StepGotoEntity { kind: 'goto'; entity: string; line: number; }
export interface StepGotoPose   {
  kind: 'goto';
  x: number; y: number; z: number;
  rx?: number; ry?: number; rz?: number;
  line: number;
}
export type StepGoto = StepGotoEntity | StepGotoPose;
export interface StepShutdown  { kind: 'shutdown'; line: number; }

export type Step =
  | StepLoadScene
  | StepWait
  | StepCapture
  | StepGoto
  | StepShutdown;

export interface Playbook {
  name: string;
  game?: string;       // optional: resolved relative to the playbook file
  steps: Step[];
  /** Absolute path of the playbook file (resolved). */
  source: string;
}

export class PlaybookParseError extends Error {
  constructor(public readonly file: string, public readonly line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = 'PlaybookParseError';
  }
}

export async function loadPlaybook(playbookPath: string): Promise<Playbook> {
  const absPath = path.resolve(playbookPath);
  const text = await fs.readFile(absPath, 'utf-8');
  return parsePlaybook(text, absPath);
}

export function parsePlaybook(text: string, sourcePath: string): Playbook {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const pos = e.pos?.[0] ?? 0;
    const line = lineCounter.linePos(pos).line;
    throw new PlaybookParseError(sourcePath, line, e.message);
  }
  const root = doc.contents;
  if (!root || !isMap(root)) {
    throw new PlaybookParseError(sourcePath, 1, 'playbook must be a YAML map at top level');
  }
  const lineOf = (node: Node | null | undefined): number => {
    if (!node?.range) return 1;
    return lineCounter.linePos(node.range[0]).line;
  };

  const obj = root.toJSON() as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PlaybookParseError(sourcePath, lineOf(root.get('name', true) as Node) || 1,
      'playbook.name must be a non-empty string');
  }
  const game = obj.game;
  if (game !== undefined && typeof game !== 'string') {
    throw new PlaybookParseError(sourcePath, lineOf(root.get('game', true) as Node) || 1,
      'playbook.game must be a string (or omitted)');
  }

  const stepsNode = root.get('steps', true) as Node | undefined;
  const stepsJson = obj.steps;
  if (!Array.isArray(stepsJson)) {
    throw new PlaybookParseError(sourcePath, lineOf(stepsNode) || 1,
      'playbook.steps must be a YAML list');
  }
  if (stepsJson.length === 0) {
    throw new PlaybookParseError(sourcePath, lineOf(stepsNode) || 1,
      'playbook.steps is empty (V1 requires at least one step)');
  }

  // Walk the AST so each step keeps an accurate source line.
  const stepsSeq = (stepsNode && 'items' in stepsNode)
    ? (stepsNode as { items: Node[] }).items
    : [];

  const steps: Step[] = stepsJson.map((stepJson, idx) => {
    const stepNode = stepsSeq[idx];
    const line = lineOf(stepNode);
    return parseStep(stepJson, line, sourcePath);
  });

  return { name, game, steps, source: path.resolve(sourcePath) };
}

function parseStep(raw: unknown, line: number, source: string): Step {
  // Bare string form: `- shutdown`
  if (typeof raw === 'string') {
    if (raw === 'shutdown') return { kind: 'shutdown', line };
    throw new PlaybookParseError(source, line,
      `unknown step kind: "${raw}" (V1 verbs: loadScene, wait, capture, goto, shutdown)`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlaybookParseError(source, line,
      'step must be a verb name or a single-key map (verb: args)');
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (keys.length !== 1) {
    throw new PlaybookParseError(source, line,
      `step must have exactly one verb key, got ${keys.length}: [${keys.join(', ')}]`);
  }
  const verb = keys[0];
  const value = (raw as Record<string, unknown>)[verb];

  switch (verb) {
    case 'loadScene': {
      if (typeof value !== 'string' || value.length === 0) {
        throw new PlaybookParseError(source, line,
          'loadScene requires a non-empty scene URI string (e.g. "nuna://scenes/hub.scene.json")');
      }
      return { kind: 'loadScene', path: value, line };
    }
    case 'wait': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new PlaybookParseError(source, line,
          'wait requires a non-negative number of milliseconds');
      }
      return { kind: 'wait', ms: value, line };
    }
    case 'capture': {
      const out = readStringField(value, 'out', source, line, 'capture');
      return { kind: 'capture', out, line };
    }
    case 'goto': {
      return parseGoto(value, line, source);
    }
    case 'shutdown': {
      // Allow `shutdown: {}` or `shutdown:` (null).
      if (value !== null && value !== undefined && !(typeof value === 'object' && !Array.isArray(value))) {
        throw new PlaybookParseError(source, line,
          'shutdown takes no arguments (use "- shutdown" or "shutdown: {}")');
      }
      return { kind: 'shutdown', line };
    }
    default:
      throw new PlaybookParseError(source, line,
        `unknown step kind: "${verb}" (V1 verbs: loadScene, wait, capture, goto, shutdown)`);
  }
}

function parseGoto(value: unknown, line: number, source: string): StepGoto {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlaybookParseError(source, line,
      'goto requires either { entity: <id> } or { x, y, z[, rx, ry, rz] }');
  }
  const v = value as Record<string, unknown>;
  if ('entity' in v) {
    if (typeof v.entity !== 'string' || v.entity.length === 0) {
      throw new PlaybookParseError(source, line,
        'goto.entity must be a non-empty entity id');
    }
    return { kind: 'goto', entity: v.entity, line };
  }
  const x = numberField(v, 'x', source, line, 'goto');
  const y = numberField(v, 'y', source, line, 'goto');
  const z = numberField(v, 'z', source, line, 'goto');
  const out: StepGotoPose = { kind: 'goto', x, y, z, line };
  if ('rx' in v) out.rx = numberField(v, 'rx', source, line, 'goto');
  if ('ry' in v) out.ry = numberField(v, 'ry', source, line, 'goto');
  if ('rz' in v) out.rz = numberField(v, 'rz', source, line, 'goto');
  return out;
}

function readStringField(
  value: unknown,
  field: string,
  source: string,
  line: number,
  verb: string,
): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlaybookParseError(source, line,
      `${verb} requires an object with .${field}`);
  }
  const v = (value as Record<string, unknown>)[field];
  if (typeof v !== 'string' || v.length === 0) {
    throw new PlaybookParseError(source, line,
      `${verb}.${field} must be a non-empty string`);
  }
  return v;
}

function numberField(
  obj: Record<string, unknown>,
  field: string,
  source: string,
  line: number,
  verb: string,
): number {
  const v = obj[field];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new PlaybookParseError(source, line,
      `${verb}.${field} must be a finite number`);
  }
  return v;
}
