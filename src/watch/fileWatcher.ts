/**
 * File watcher — chokidar-based watch on static roots.
 *
 * On file changes, invalidates the in-memory manifest cache so the next
 * GET /<mount>/manifest.json rebuilds it fresh.
 */

import chokidar from 'chokidar';
import pc from 'picocolors';
import type { StaticRoot } from '../config/ServeConfig.js';
import type { Manifest } from '../manifest/ManifestBuilder.js';

const DEBOUNCE_MS = 500;

/**
 * Start watching all static root paths. On any file change, the cached
 * manifest for that root is invalidated (deleted from the map).
 */
export function createFileWatcher(
  staticRoots: StaticRoot[],
  manifests: Map<string, Manifest>
): chokidar.FSWatcher[] {
  const watchers: chokidar.FSWatcher[] = [];

  for (const root of staticRoots) {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = chokidar.watch(root.path, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\../, // ignore dotfiles
      persistent: true,
    });

    const invalidate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        manifests.delete(root.alias);
        console.log(pc.dim(`  [watch] manifest invalidated for "${root.alias}"`));
      }, DEBOUNCE_MS);
    };

    watcher.on('add', invalidate);
    watcher.on('change', invalidate);
    watcher.on('unlink', invalidate);

    watchers.push(watcher);
  }

  return watchers;
}
