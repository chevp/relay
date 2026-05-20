/**
 * `relay pack` — build an iris asset pack from a TOML definition.
 *
 * Delegates the actual work to `irisproc pack` (C++ binary shipped via the
 * `@nuna/irisproc-<platform>-<arch>` optionalDependencies, or located on
 * $PATH / in the local iris dev build). relay handles only argument shaping
 * and stream piping; all asset processing happens in irisproc.
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import path from 'node:path';
import pc from 'picocolors';
import { findIrisproc } from '../tools/irisproc.js';

export interface PackOptions {
  out: string;
  verbose: boolean;
}

export function registerPack(program: Command): void {
  program
    .command('pack')
    .description('Build an iris asset pack from a TOML definition (delegates to irisproc)')
    .argument('<pack.toml>', 'path to pack definition (e.g. packs/base.toml)')
    .option('-o, --out <dir>', 'output directory', 'dist')
    .option('--verbose', 'log irisproc resolution and arguments', false)
    .action(async (packToml: string, opts: PackOptions) => {
      const irisproc = findIrisproc();
      if (opts.verbose) {
        console.error(pc.dim(`[relay pack] irisproc (${irisproc.source}): ${irisproc.path}`));
      }

      const args = [
        'pack',
        path.resolve(process.cwd(), packToml),
        '--out',
        path.resolve(process.cwd(), opts.out),
      ];

      const code = await runChild(irisproc.path, args);
      if (code !== 0) {
        console.error(pc.red(`[relay pack] irisproc exited with code ${code}`));
        process.exit(code ?? 1);
      }
    });
}

function runChild(bin: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}
