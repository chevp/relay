/**
 * ManifestBuilder — walks a static root and produces a SHA-256 manifest.
 *
 * Output format (per §1.2.3):
 *   {
 *     "version": 1,
 *     "generated": "<ISO-8601>",
 *     "files": {
 *       "worlds/main.world.xml": { "sha256": "...", "size": 1234 }
 *     }
 *   }
 *
 * Accepts a ContentProvider so the same logic works for local filesystem,
 * Firebase Storage, S3, etc.
 */

import path from 'node:path';
import { hashBuffer } from './sha256.js';
import type { ContentProvider } from '../provider/ContentProvider.js';
import { LocalContentProvider } from '../provider/LocalContentProvider.js';

export interface ManifestEntry {
  sha256: string;
  size: number;
}

export interface Manifest {
  version: 1;
  generated: string;
  files: Record<string, ManifestEntry>;
}

const MANIFEST_FILENAME = 'manifest.json';

const defaultProvider = new LocalContentProvider();

/**
 * Build a manifest for every file under rootPath (recursive).
 * Skips the manifest.json file itself and anything named starting with ".".
 */
export async function buildManifest(
  rootPath: string,
  provider: ContentProvider = defaultProvider,
): Promise<Manifest> {
  const files: Record<string, ManifestEntry> = {};
  await walk(rootPath, rootPath, files, provider);
  return {
    version: 1,
    generated: new Date().toISOString(),
    files,
  };
}

async function walk(
  absDir: string,
  rootAbs: string,
  out: Record<string, ManifestEntry>,
  provider: ContentProvider,
): Promise<void> {
  const entries = await provider.list(absDir);
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.isDirectory) {
      await walk(ent.path, rootAbs, out, provider);
    } else if (ent.isFile) {
      if (ent.name === MANIFEST_FILENAME && path.dirname(ent.path) === rootAbs) continue;
      const rel = path.relative(rootAbs, ent.path).split(path.sep).join('/');
      const buf = await provider.readFile(ent.path);
      out[rel] = { sha256: hashBuffer(buf), size: buf.byteLength };
    }
  }
}
