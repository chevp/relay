/**
 * Spawn / shutdown helpers for iris-player in `--daemon` mode.
 *
 * Both `nuna story` and `nuna test` (ADR-0008) drive the same Storybook
 * WebSocket protocol against the same player binary, so the lifecycle is
 * centralised here to keep the two callers from drifting.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, sendCmd, waitForEngineRunning } from './ipc.js';

export interface SpawnPlayerOptions {
  playerPath: string;
  port: number;
  cwd: string;
  /** Time to wait for the daemon to reach engineRunning before failing. */
  engineReadyTimeoutMs?: number;
}

export interface PlayerHandle {
  process: ChildProcess;
  port: number;
}

export async function spawnPlayerDaemon(opts: SpawnPlayerOptions): Promise<PlayerHandle> {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  };
  const proc = spawn(opts.playerPath, ['--daemon', '--port', String(opts.port)], spawnOpts);
  try {
    await waitForEngineRunning(opts.port, opts.engineReadyTimeoutMs ?? 30_000);
  } catch (err) {
    if (!proc.killed) proc.kill();
    throw err;
  }
  return { process: proc, port: opts.port };
}

/**
 * Best-effort graceful shutdown: send `shutdown` over WS, wait briefly for the
 * process to exit, then force-kill if it hasn't. Safe to call repeatedly.
 */
export async function shutdownPlayerDaemon(
  handle: PlayerHandle,
  shutdownTimeoutMs = 5_000,
): Promise<void> {
  const { process: proc, port } = handle;
  if (proc.killed) return;
  try {
    const ws = await connect(`ws://127.0.0.1:${port}`, 2_000);
    try {
      await sendCmd(ws, 'shutdown', {}, shutdownTimeoutMs);
    } finally {
      ws.close();
    }
    await Promise.race([
      new Promise<void>((res) => proc.once('exit', () => res())),
      delay(shutdownTimeoutMs),
    ]);
  } catch {
    // fall through to force-kill
  }
  if (!proc.killed) proc.kill();
}
