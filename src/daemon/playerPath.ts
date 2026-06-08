/**
 * Resolve the iris-player binary path for daemon-driven runs (gtest, scenarios).
 *
 * Order: explicit arg → $IRIS_PLAYER / $NUNA_PLAYER → common build locations
 * walked up from the cwd. The returned path is not existence-checked here — the
 * caller decides how to report a miss (so it can print the resolved path).
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

const BIN = process.platform === 'win32' ? 'iris-player.exe' : 'iris-player';

/** Build-output subpaths to probe under each ancestor directory. */
const CANDIDATES = [
  ['runtime', 'iris', 'build', 'bin', 'Release', BIN],
  ['runtime', 'iris', 'build', 'bin', BIN],
  ['build', 'bin', 'Release', BIN],
  ['build', 'bin', BIN],
];

export function resolvePlayerPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);

  const env = process.env.IRIS_PLAYER ?? process.env.NUNA_PLAYER;
  if (env) return path.resolve(env);

  let dir = process.cwd();
  while (true) {
    for (const parts of CANDIDATES) {
      const candidate = path.join(dir, ...parts);
      if (existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to a conventional location so the caller can report a clear miss.
  return path.join(process.cwd(), ...CANDIDATES[0]);
}
