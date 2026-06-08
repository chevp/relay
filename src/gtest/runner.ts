/**
 * `.gtest` runner — drives iris-player headless and evaluates asserts.
 *
 * Thin orchestrator (mirrors scenario/runner.ts): spawn iris-player in daemon
 * mode, connect to its Storybook WS, run each stage (init → camera → wait →
 * capture → asserts), aggregate a pass/fail verdict, write result.json, exit
 * non-zero on any failed/errored assert. No Electron, no display.
 *
 * Daemon cmds used: `loadScene`, `setCamera`, `capture`, `shutdown` (exist
 * today) plus `eval` (stage init), `status` and `getEntity` (engine-state
 * asserts) — the latter three are NEW handlers required in iris-player's
 * StorybookDaemon (see PRD-001 cross-repo dependency). When the daemon does not
 * support a cmd, the dependent assert reports `error` (not a silent pass).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pc from 'picocolors';
import WebSocket from 'ws';
import { connect, sendCmd } from '../daemon/ipc.js';
import { spawnPlayerDaemon, shutdownPlayerDaemon, type PlayerHandle } from '../daemon/lifecycle.js';
import { loadGTest, type Stage, type StageAssert, type Camera } from './schema.js';
import {
  comparePixels, getPath, valuesEqual,
  type AssertResult, type StageResult, type GTestResult,
} from './verdict.js';

export interface RunGTestOptions {
  gtestPath: string;
  playerPath: string;
  port: number;
  /** Artefact root. Default `<gtest-dir>/_results/<name>/`. */
  outDir?: string;
  /** Baseline root for pixel asserts. Default: the .gtest file's directory. */
  baselineDir?: string;
  /** Per-WS-command timeout (ms). */
  commandTimeoutMs?: number;
  /** Copy each captured frame over its baseline instead of comparing. */
  updateBaselines?: boolean;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export async function runGTest(opts: RunGTestOptions): Promise<GTestResult> {
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const suite = await loadGTest(opts.gtestPath);

  const gtestDir = path.dirname(suite.source);
  const outDir = path.resolve(opts.outDir ?? path.join(gtestDir, '_results', slug(suite.name)));
  const baselineDir = path.resolve(opts.baselineDir ?? gtestDir);
  await fs.mkdir(outDir, { recursive: true });

  const sceneInput = suite.scene ? path.resolve(gtestDir, suite.scene) : undefined;

  console.log(pc.cyan(`[gtest] suite:    ${suite.source}`));
  console.log(pc.cyan(`[gtest] name:     ${suite.name}`));
  if (sceneInput) console.log(pc.cyan(`[gtest] scene:    ${sceneInput}`));
  console.log(pc.cyan(`[gtest] player:   ${opts.playerPath}`));
  console.log(pc.cyan(`[gtest] out:      ${outDir}`));
  console.log(pc.cyan(`[gtest] stages:   ${suite.stages.length}`));

  const startedAt = new Date();
  const stageResults: StageResult[] = [];

  const daemon: PlayerHandle = await spawnPlayerDaemon({
    playerPath: opts.playerPath,
    port: opts.port,
    cwd: path.dirname(opts.playerPath),
    extraArgs: sceneInput ? [sceneInput] : undefined,
  });

  let ws: WebSocket | null = null;
  try {
    ws = await connect(`ws://127.0.0.1:${opts.port}`, 5_000);
    const call = (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> =>
      sendCmd(ws!, cmd, args, commandTimeoutMs).then((r) => {
        if (!r.ok) throw new Error(r.error ?? `daemon error (${cmd})`);
        return r.result;
      });

    for (const stage of suite.stages) {
      stageResults.push(await runStage(stage, { call, outDir, baselineDir, updateBaselines: !!opts.updateBaselines }));
    }
  } finally {
    if (ws) { try { ws.close(); } catch { /* ignore */ } }
    await shutdownPlayerDaemon(daemon);
  }

  const status: GTestResult['status'] = stageResults.every((s) => s.status === 'pass') ? 'pass' : 'fail';
  const result: GTestResult = {
    gtest: suite.source,
    name: suite.name,
    status,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    outDir,
    stages: stageResults,
  };

  await fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf-8');

  const passed = stageResults.filter((s) => s.status === 'pass').length;
  console.log((status === 'pass' ? pc.green : pc.red)(
    `\n[gtest] ${passed}/${stageResults.length} stages passed — ${status.toUpperCase()}`));
  console.log(pc.cyan(`[gtest] result:   ${path.join(outDir, 'result.json')}`));
  return result;
}

interface StageCtx {
  call: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  outDir: string;
  baselineDir: string;
  updateBaselines: boolean;
}

async function runStage(stage: Stage, ctx: StageCtx): Promise<StageResult> {
  const started = Date.now();
  const label = stage.name;
  const asserts: AssertResult[] = [];

  try {
    if (stage.init) await ctx.call('eval', { code: stage.init });

    if (stage.screenshot) {
      await ctx.call('setCamera', cameraArgs(stage.screenshot.camera));
    }
    if (stage.wait) await delay(stage.wait);

    // Capture (if a screenshot is declared), then the pixel assert if a baseline is set.
    if (stage.screenshot) {
      const outName = stage.screenshot.out ?? `${slug(stage.name)}.png`;
      const absOut = path.resolve(ctx.outDir, outName);
      await fs.mkdir(path.dirname(absOut), { recursive: true });
      await ctx.call('capture', { out: absOut });
      if (!await waitForFile(absOut, 15_000)) {
        throw new Error(`capture timeout: PNG not written at ${absOut}`);
      }
      if (stage.screenshot.baseline) {
        asserts.push(await pixelAssert(stage.screenshot.baseline, absOut, stage.screenshot.tolerance ?? 0, ctx));
      }
    }

    if (stage.assert) asserts.push(...await stateAsserts(stage.assert, ctx));
  } catch (err) {
    const result: StageResult = {
      name: label, status: 'error', asserts,
      durationMs: Date.now() - started, error: (err as Error).message,
    };
    console.log(pc.red(`[gtest] ✗ ${label}: ${result.error}`));
    return result;
  }

  const status: StageResult['status'] =
    asserts.some((a) => a.status === 'error') ? 'error'
    : asserts.some((a) => a.status === 'fail') ? 'fail'
    : 'pass';
  const glyph = status === 'pass' ? pc.green('✓') : pc.red('✗');
  console.log(`[gtest] ${glyph} ${label}${asserts.length ? ` (${asserts.filter((a) => a.status === 'pass').length}/${asserts.length} asserts)` : ''}`);
  return { name: label, status, asserts, durationMs: Date.now() - started };
}

async function pixelAssert(baselineRel: string, actualAbs: string, tolerance: number, ctx: StageCtx): Promise<AssertResult> {
  const baselineAbs = path.resolve(ctx.baselineDir, baselineRel);
  const label = `pixel ${baselineRel}`;
  if (ctx.updateBaselines) {
    await fs.mkdir(path.dirname(baselineAbs), { recursive: true });
    await fs.copyFile(actualAbs, baselineAbs);
    return { label, status: 'pass', detail: 'baseline updated' };
  }
  const outcome = await comparePixels(actualAbs, baselineAbs, tolerance);
  return { label, status: outcome.pass ? 'pass' : 'fail', detail: outcome.detail };
}

async function stateAsserts(a: StageAssert, ctx: StageCtx): Promise<AssertResult[]> {
  const out: AssertResult[] = [];

  if (a.sceneLoaded !== undefined) {
    out.push(await stateCheck(`sceneLoaded == ${a.sceneLoaded}`, ctx, 'status', {}, 'sceneLoaded', a.sceneLoaded));
  }
  if (a.entityCount !== undefined) {
    out.push(await stateCheck(`entityCount == ${a.entityCount}`, ctx, 'status', {}, 'entityCount', a.entityCount));
  }
  for (const id of a.entities ?? []) {
    out.push(await existsCheck(`entity ${id} exists`, ctx, 'getEntity', { id }, undefined, true));
  }
  for (const s of a.state ?? []) {
    const label = `${s.query}${s.path ? `.${s.path}` : ''} ${'equals' in s ? `== ${JSON.stringify(s.equals)}` : `exists ${s.exists}`}`;
    if ('exists' in s && s.exists !== undefined) {
      out.push(await existsCheck(label, ctx, s.query, s.args ?? {}, s.path, s.exists));
    } else {
      out.push(await stateCheck(label, ctx, s.query, s.args ?? {}, s.path, s.equals));
    }
  }
  return out;
}

async function stateCheck(
  label: string, ctx: StageCtx, cmd: string, args: Record<string, unknown>,
  jsonPath: string | undefined, expected: unknown,
): Promise<AssertResult> {
  try {
    const actual = getPath(await ctx.call(cmd, args), jsonPath);
    return valuesEqual(actual, expected)
      ? { label, status: 'pass', expected, actual }
      : { label, status: 'fail', expected, actual, detail: 'value mismatch' };
  } catch (err) {
    return { label, status: 'error', detail: daemonCmdError(cmd, err) };
  }
}

async function existsCheck(
  label: string, ctx: StageCtx, cmd: string, args: Record<string, unknown>,
  jsonPath: string | undefined, wantExists: boolean,
): Promise<AssertResult> {
  try {
    const value = getPath(await ctx.call(cmd, args), jsonPath);
    const present = value !== null && value !== undefined;
    return present === wantExists
      ? { label, status: 'pass', actual: present }
      : { label, status: 'fail', expected: wantExists, actual: present, detail: 'presence mismatch' };
  } catch (err) {
    return { label, status: 'error', detail: daemonCmdError(cmd, err) };
  }
}

function daemonCmdError(cmd: string, err: unknown): string {
  const msg = (err as Error).message;
  return `daemon cmd "${cmd}" failed: ${msg} (the iris StorybookDaemon may not yet implement it — see PRD-001)`;
}

/** Map the .gtest camera (posX/rotX/fov) to the StorybookDaemon setCamera (x/rx/fov). */
function cameraArgs(c: Camera): Record<string, unknown> {
  const args: Record<string, unknown> = { x: c.posX, y: c.posY, z: c.posZ };
  if (c.rotX !== undefined) args.rx = c.rotX;
  if (c.rotY !== undefined) args.ry = c.rotY;
  if (c.rotZ !== undefined) args.rz = c.rotZ;
  if (c.fov !== undefined) args.fov = c.fov;
  return args;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
}

async function waitForFile(absPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > 0) return true;
    } catch { /* not yet */ }
    await delay(200);
  }
  return false;
}
