/**
 * Spawn iris-preview headless for relay-driven render/test pipelines.
 *
 * Mirrors the container's preview launcher but resolves the binary via relay's
 * own iris-binary resolver (no Electron `app`). Not detached — the caller owns
 * the lifecycle and kills the child when done.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolvePreviewPath } from '../daemon/playerPath.js';

const ENTRY_CANDIDATES = ['iris.xml', 'cryo.xml'];

export interface PreviewSpawnOptions {
  port: number;
  fps?: number;
  width?: number;
  height?: number;
  editMode?: boolean;
  /** Explicit iris-preview binary path (else resolved from build dirs / env). */
  previewPath?: string;
  /** Pipe stdout/stderr so the caller can capture log lines. */
  captureOutput?: boolean;
}

/** Resolve a folder to its entry XML, or pass a file path through unchanged. */
export function resolveSceneInput(scenePath: string): string {
  let st;
  try { st = statSync(scenePath); }
  catch { throw new Error(`iris-preview scene not found: ${scenePath}`); }
  if (st.isFile()) return scenePath;
  for (const candidate of ENTRY_CANDIDATES) {
    const full = path.join(scenePath, candidate);
    if (existsSync(full)) return full;
  }
  throw new Error(`no entry file in ${scenePath} — expected one of ${ENTRY_CANDIDATES.join(', ')}`);
}

export function spawnPreview(scenePath: string, opts: PreviewSpawnOptions): ChildProcess {
  const input = resolveSceneInput(scenePath);
  // --hidden: render off-screen (no OS window) for headless capture.
  const args = [`--scene=${input}`, `--port=${opts.port}`, '--hidden'];
  if (opts.fps) args.push(`--fps=${opts.fps}`);
  if (opts.width) args.push(`--width=${opts.width}`);
  if (opts.height) args.push(`--height=${opts.height}`);
  if (opts.editMode) args.push('--edit-mode');

  const child = spawn(resolvePreviewPath(opts.previewPath), args,
    { stdio: opts.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
  child.on('error', (err) => { console.error('failed to spawn iris-preview:', err); });
  return child;
}
