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
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { hashFile } from './sha256.js';

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

/**
 * Build a manifest for every file under rootPath (recursive).
 * Skips the manifest.json file itself and anything named starting with ".".
 */
export async function buildManifest(rootPath: string): Promise<Manifest> {
  const files: Record<string, ManifestEntry> = {};
  await walk(rootPath, rootPath, files);
  return {
    version: 1,
    generated: new Date().toISOString(),
    files,
  };
}

async function walk(
  absDir: string,
  rootAbs: string,
  out: Record<string, ManifestEntry>
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(absDir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, rootAbs, out);
    } else if (ent.isFile()) {
      if (ent.name === MANIFEST_FILENAME && path.dirname(full) === rootAbs) continue;
      const rel = path.relative(rootAbs, full).split(path.sep).join('/');
      const stat = await fs.stat(full);
      const sha256 = await hashFile(full);
      out[rel] = { sha256, size: stat.size };
    }
  }
}
