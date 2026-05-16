/**
 * Authoring-format warning — scans static roots for source files
 * (.blend, .psd, .ai, .sketch) that should never be served.
 *
 * Emits warnings but does NOT abort the server.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';

const AUTHORING_EXTENSIONS = new Set(['.blend', '.psd', '.ai', '.sketch', '.blend1']);

/**
 * Walk the top two levels of each root path and warn about authoring files.
 * Shallow scan to keep startup fast.
 */
export async function warnAuthoringFormats(rootPaths: string[]): Promise<string[]> {
  const warnings: string[] = [];

  for (const rootPath of rootPaths) {
    let entries;
    try {
      entries = await fs.readdir(rootPath, { withFileTypes: true, recursive: true });
    } catch {
      continue; // root may not exist (optional mount)
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (AUTHORING_EXTENSIONS.has(ext)) {
        const rel = ent.parentPath
          ? path.relative(rootPath, path.join(ent.parentPath, ent.name))
          : ent.name;
        warnings.push(rel);
      }
    }
  }

  if (warnings.length > 0) {
    console.log(pc.yellow(`\n  [warn] Found ${warnings.length} authoring-format file(s) in static roots:`));
    for (const w of warnings.slice(0, 10)) {
      console.log(pc.yellow(`    - ${w}`));
    }
    if (warnings.length > 10) {
      console.log(pc.yellow(`    ... and ${warnings.length - 10} more`));
    }
    console.log(pc.yellow('  These files (.blend, .psd, ...) should stay in assets-source/, not in served paths.\n'));
  }

  return warnings;
}
