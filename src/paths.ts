import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// ─── run-output cache ────────────────────────────────────────────────────────
// Runner output (atlas sheets, gtest screenshots, flow artifacts, shots
// renders, …) is NOT project-local — it lands in the OS-native cache dir,
// namespaced per project. The container reads these artifacts back, so this
// derivation must stay bit-for-bit identical to its cheCacheDir()
// (apps/container/src/che.ts). The container publishes its own root as
// KOS_CACHE_ROOT, which always wins; the fallback below only applies to
// standalone CLI runs.

function cacheRoot(): string {
  const fromEnv = process.env['KOS_CACHE_ROOT'];
  if (fromEnv) return fromEnv;
  const appName = process.env['KOS_APP_NAME'] || 'Kosmos';
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      // Mirrors Electron's getPath('cache') on Windows, which is %APPDATA%.
      ? (process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Caches')
        : (process.env['XDG_CACHE_HOME'] || path.join(home, '.cache'));
  // NOT "Cache": that subfolder is Chromium's own disk cache, which it evicts
  // and purges on its own schedule. See cheCacheRoot() in the container.
  return path.join(base, appName, 'RunArtifacts');
}

/** Stable, collision-free folder name for one workspace. */
function projectSlug(workspaceRoot: string): string {
  const abs = path.resolve(workspaceRoot);
  const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 12);
  const name = (path.basename(abs) || 'project').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${name}-${hash}`;
}

/**
 * Absolute path to a location inside this project's slice of the cache tree,
 * keyed by descriptor. Safe to delete at any time — it is all regenerable.
 */
export function kosmosCacheDir(workspaceRoot: string, ...segments: string[]): string {
  return path.join(cacheRoot(), 'projects', projectSlug(workspaceRoot), ...segments);
}
