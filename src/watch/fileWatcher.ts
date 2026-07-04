/**
 * File watcher — delegates to ContentProvider.watch().
 *
 * On file changes, invalidates the in-memory manifest cache so the next
 * GET /<mount>/manifest.json rebuilds it fresh.
 */

import pc from 'picocolors';
import type { StaticRoot } from '../config/ServeConfig.js';
import type { Manifest } from '../manifest/ManifestBuilder.js';
import type { ContentProvider, Unwatch } from '../provider/ContentProvider.js';

/**
 * Start watching all static root paths via the given provider.
 * Returns unwatch functions — call each to stop watching.
 */
export function createFileWatcher(
  staticRoots: StaticRoot[],
  manifests: Map<string, Manifest>,
  provider: ContentProvider,
): Unwatch[] {
  if (!provider.watch) return [];

  return staticRoots.map((root) =>
    provider.watch!(root.path, () => {
      manifests.delete(root.alias);
      console.log(pc.dim(`  [watch] manifest invalidated for "${root.alias}"`));
    }),
  );
}
