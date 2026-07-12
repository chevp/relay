/**
 * Scripted playbook runner (ADR-0008 V1).
 *
 * Thin orchestrator: spawn iris-player in daemon mode, connect to its
 * Storybook WS, dispatch each step sequentially, write artefacts, exit
 * non-zero on first failure.
 *
 * Lifecycle:
 *   loadPlaybook → spawnPlayerDaemon → for step in steps: dispatch →
 *   shutdown → write result.json → exit 0 or 1.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pc from 'picocolors';
import WebSocket from 'ws';
import { connect, sendCmd, type IpcResponse } from '../daemon/ipc.js';
import { spawnPlayerDaemon, shutdownPlayerDaemon, type PlayerHandle } from '../daemon/lifecycle.js';
import {
  loadPlaybook,
  PlaybookParseError,
  type Playbook,
  type Step,
} from './schema.js';

export interface RunOptions {
  playbookPath: string;
  playerPath: string;
  port: number;
  /** Output dir (artefacts root). Defaults to `<playbook-dir>/_results/<playbook-name>`. */
  outDir?: string;
  /** Per-command WS timeout in ms. */
  commandTimeoutMs?: number;
  /** Optional input file (e.g. runtime.xml) passed as a positional to iris-player. */
  inputFile?: string;
}

export interface StepResult {
  index: number;
  kind: Step['kind'];
  line: number;
  status: 'ok' | 'error' | 'skipped';
  startedAt: string;
  durationMs: number;
  error?: string;
  /** Daemon response result payload, if any. */
  result?: unknown;
}

export interface RunResult {
  playbook: string;
  name: string;
  game?: string;
  status: 'ok' | 'error';
  startedAt: string;
  durationMs: number;
  outDir: string;
  steps: StepResult[];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export async function runPlaybook(opts: RunOptions): Promise<RunResult> {
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  let playbook: Playbook;
  try {
    playbook = await loadPlaybook(opts.playbookPath);
  } catch (err) {
    if (err instanceof PlaybookParseError) {
      console.error(pc.red(`[test] ${err.message}`));
    }
    throw err;
  }

  const playbookDir = path.dirname(playbook.source);
  const outDir = path.resolve(opts.outDir ?? path.join(playbookDir, '_results', playbook.name));
  await fs.mkdir(outDir, { recursive: true });

  const gameRoot = playbook.game ? path.resolve(playbookDir, playbook.game) : undefined;

  console.log(pc.cyan(`[test] playbook:   ${playbook.source}`));
  console.log(pc.cyan(`[test] name:       ${playbook.name}`));
  if (gameRoot) console.log(pc.cyan(`[test] game:       ${gameRoot}`));
  console.log(pc.cyan(`[test] player:     ${opts.playerPath}`));
  console.log(pc.cyan(`[test] port:       ${opts.port}`));
  console.log(pc.cyan(`[test] out:        ${outDir}`));
  console.log(pc.cyan(`[test] steps:      ${playbook.steps.length}`));

  const startedAt = new Date();
  const stepResults: StepResult[] = [];
  let overallStatus: 'ok' | 'error' = 'ok';

  const daemon: PlayerHandle = await spawnPlayerDaemon({
    playerPath: opts.playerPath,
    port: opts.port,
    cwd: path.dirname(opts.playerPath),
    extraArgs: opts.inputFile ? [path.resolve(opts.inputFile)] : undefined,
  });
  daemon.process.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(pc.gray(`[test] daemon exit (code=${code})`));
    }
  });

  let daemonAlive = true;
  let ws: WebSocket | null = null;
  try {
    ws = await connect(`ws://127.0.0.1:${opts.port}`, 5_000);

    for (let i = 0; i < playbook.steps.length; i++) {
      const step = playbook.steps[i];
      const stepStart = Date.now();
      const startedIso = new Date(stepStart).toISOString();
      const label = describeStep(step);

      if (overallStatus === 'error') {
        stepResults.push({
          index: i, kind: step.kind, line: step.line,
          status: 'skipped', startedAt: startedIso, durationMs: 0,
        });
        console.log(pc.gray(`[test] - skipped ${label}`));
        continue;
      }

      try {
        const result = await dispatchStep(ws, step, { commandTimeoutMs, outDir, gameRoot });
        if (step.kind === 'shutdown') daemonAlive = false;
        stepResults.push({
          index: i, kind: step.kind, line: step.line,
          status: 'ok', startedAt: startedIso,
          durationMs: Date.now() - stepStart,
          result,
        });
        console.log(pc.green(`[test] ✓ ${label}`));
      } catch (err) {
        const message = (err as Error).message;
        stepResults.push({
          index: i, kind: step.kind, line: step.line,
          status: 'error', startedAt: startedIso,
          durationMs: Date.now() - stepStart,
          error: message,
        });
        overallStatus = 'error';
        console.error(pc.red(`[test] ✗ ${label}: ${message}`));
      }
    }
  } finally {
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
    }
    if (daemonAlive) await shutdownPlayerDaemon(daemon);
  }

  const result: RunResult = {
    playbook: playbook.source,
    name: playbook.name,
    game: playbook.game,
    status: overallStatus,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    outDir,
    steps: stepResults,
  };

  await fs.writeFile(
    path.join(outDir, 'result.json'),
    JSON.stringify(result, null, 2),
    'utf-8',
  );

  const okCount = stepResults.filter((s) => s.status === 'ok').length;
  console.log(pc.cyan(
    `\n[test] ${okCount}/${stepResults.length} steps ok` +
    (overallStatus === 'error' ? pc.red(' (failed)') : ''),
  ));
  console.log(pc.cyan(`[test] result: ${path.join(outDir, 'result.json')}`));

  return result;
}

interface DispatchContext {
  commandTimeoutMs: number;
  outDir: string;
  gameRoot?: string;
}

async function dispatchStep(
  ws: WebSocket,
  step: Step,
  ctx: DispatchContext,
): Promise<unknown> {
  switch (step.kind) {
    case 'loadScene': {
      const args: Record<string, unknown> = { path: step.path, previewOnly: true };
      if (ctx.gameRoot) args.gameRoot = ctx.gameRoot;
      return assertOk(await sendCmd(ws, 'loadScene', args, ctx.commandTimeoutMs));
    }
    case 'wait': {
      await delay(step.ms);
      return { waitedMs: step.ms };
    }
    case 'capture': {
      const absOut = path.isAbsolute(step.out) ? step.out : path.resolve(ctx.outDir, step.out);
      await fs.mkdir(path.dirname(absOut), { recursive: true });
      const resp = assertOk(await sendCmd(ws, 'capture', { out: absOut }, ctx.commandTimeoutMs));
      // Engine writes PNG a few frames after the command returns.
      if (!await waitForFile(absOut, ctx.commandTimeoutMs)) {
        throw new Error(`capture timeout: PNG not written within ${ctx.commandTimeoutMs}ms at ${absOut}`);
      }
      return resp;
    }
    case 'goto': {
      const args: Record<string, unknown> = {};
      if ('entity' in step) {
        args.entity = step.entity;
      } else {
        args.x = step.x; args.y = step.y; args.z = step.z;
        if (step.rx !== undefined) args.rx = step.rx;
        if (step.ry !== undefined) args.ry = step.ry;
        if (step.rz !== undefined) args.rz = step.rz;
      }
      return assertOk(await sendCmd(ws, 'setCamera', args, ctx.commandTimeoutMs));
    }
    case 'shutdown': {
      return assertOk(await sendCmd(ws, 'shutdown', {}, ctx.commandTimeoutMs));
    }
  }
}

function assertOk(resp: IpcResponse): unknown {
  if (!resp.ok) throw new Error(resp.error ?? 'daemon returned error without message');
  return resp.result;
}

function describeStep(step: Step): string {
  switch (step.kind) {
    case 'loadScene': return `loadScene ${step.path}`;
    case 'wait':      return `wait ${step.ms}ms`;
    case 'capture':   return `capture ${step.out}`;
    case 'goto':      return 'entity' in step
      ? `goto entity=${step.entity}`
      : `goto pose=(${step.x},${step.y},${step.z})`;
    case 'shutdown':  return 'shutdown';
  }
}

async function waitForFile(absPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > 0) return true;
    } catch {
      // not yet
    }
    await delay(200);
  }
  return false;
}
