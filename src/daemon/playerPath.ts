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
 * Resolve an iris binary by base name (e.g. `iris-player`, `irisdaemon`).
 * `envVar` overrides the default `$IRIS_<NAME>` lookup.
 *
 * `name` may be a list of candidate base names, tried in order within each
 * probed directory. The reported miss uses the first name, which should be the
 * current one — later entries are legacy spellings kept only so an older build
 * tree still resolves.
 */
export function resolveIrisBinary(
  name: string | string[],
  explicit?: string,
  envVar?: string,
): string {
  const names = Array.isArray(name) ? name : [name];
  if (explicit) return path.resolve(explicit);

  const env = process.env[envVar ?? `IRIS_${names[0].replace(/-/g, '_').toUpperCase()}`];
  if (env) return path.resolve(env);

  let dir = process.cwd();
  while (true) {
    for (const parts of BUILD_DIRS) {
      for (const n of names) {
        const candidate = path.join(dir, ...parts, `${n}${EXE}`);
        if (existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to a conventional location so the caller can report a clear miss.
  return path.join(process.cwd(), ...BUILD_DIRS[0], `${names[0]}${EXE}`);
}

/** Convenience for the iris-player daemon (scenario runner, etc.). */
export function resolvePlayerPath(explicit?: string): string {
  return resolveIrisBinary('iris-player', explicit, 'IRIS_PLAYER');
}

/** Convenience for the daemon in preview/stream mode (gtest / shots / atlas
 *  render pipelines) — it replaced the standalone iris-preview binary; the wire
 *  protocol (PreviewDaemon) and CLI flags it accepts are unchanged.
 *
 *  The CMake target is `irisdaemon` (apps/irisdaemon/CMakeLists.txt) and has
 *  been for as long as it has existed; this resolved only `irisd`, which never
 *  matched, so every shots/atlas/gtest run failed with a spawn ENOENT naming a
 *  binary the build does not produce. `irisd` is kept as a trailing fallback in
 *  case a build tree somewhere still carries that spelling. */
export function resolvePreviewPath(explicit?: string): string {
  return resolveIrisBinary(['irisdaemon', 'irisd'], explicit, 'IRIS_PREVIEW');
}
