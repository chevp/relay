import path from 'node:path';

/**
 * Absolute path to a location inside a project's gitignored `.kosmos/cache`
 * dir — the only part of `.kosmos/` that isn't committed to git. Runners
 * write reproducible run output (atlas sheets, gtest screenshots, flow
 * artifacts, shots renders, …) here, keyed by descriptor.
 */
export function kosmosCacheDir(workspaceRoot: string, ...segments: string[]): string {
  return path.join(workspaceRoot, '.kosmos', 'cache', ...segments);
}
