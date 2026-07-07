/**
 * Resolve iris binary paths for daemon-driven runs (gtest, scenarios).
 *
 * Order: explicit arg → $IRIS_<NAME> / env → common build locations walked up
 * from the cwd. The returned path is not existence-checked here — the caller
 * decides how to report a miss (so it can print the resolved path).
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** Build-output subdirs to probe under each ancestor directory. */
const BUILD_DIRS = [
  ['runtime', 'iris', 'build', 'bin', 'Release'],
  ['runtime', 'iris', 'build', 'bin'],
  ['build', 'bin', 'Release'],
  ['build', 'bin'],
];

/**
 * Resolve an iris binary by base name (e.g. `iris-player`, `irisd`).
 * `envVar` overrides the default `$IRIS_<NAME>` lookup.
 */
export function resolveIrisBinary(name: string, explicit?: string, envVar?: string): string {
  if (explicit) return path.resolve(explicit);

  const env = process.env[envVar ?? `IRIS_${name.replace(/-/g, '_').toUpperCase()}`];
  if (env) return path.resolve(env);

  const file = `${name}${EXE}`;
  let dir = process.cwd();
  while (true) {
    for (const parts of BUILD_DIRS) {
      const candidate = path.join(dir, ...parts, file);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to a conventional location so the caller can report a clear miss.
  return path.join(process.cwd(), ...BUILD_DIRS[0], file);
}

/** Convenience for the iris-player daemon (scenario runner, etc.). */
export function resolvePlayerPath(explicit?: string): string {
  return resolveIrisBinary('iris-player', explicit, 'IRIS_PLAYER');
}

/** Convenience for irisd in preview/stream mode (gtest / shots / atlas render
 *  pipelines) — irisd replaced the standalone iris-preview binary; the wire
 *  protocol (PreviewDaemon) and CLI flags it accepts are unchanged. */
export function resolvePreviewPath(explicit?: string): string {
  return resolveIrisBinary('irisd', explicit, 'IRIS_PREVIEW');
}
