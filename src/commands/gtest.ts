/**
 * `relay gtest <file.gtest>` — run a .gtest E2E suite headless.
 *
 * The automation entry point: no Electron. Boots iris-preview per stage, runs
 * setup + asserts (DB / server; relay deferred), writes the run to the shared
 * `.kosmos/gtest/<key>/` cache, and exits 0 when every stage passed, 1 otherwise.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import { runGtest } from '../gtest/runner.js';
import { GtestParseError } from '../gtest/schema.js';

interface GtestOptions {
  workspace?: string;
}

export function registerGtest(program: Command): void {
  program
    .command('gtest <file.gtest>')
    .description('Run a .gtest E2E suite headless (iris-preview + DB/server asserts)')
    .option('--workspace <dir>', 'Workspace root for the .kosmos cache (default: cwd)')
    .action(async (gtestPath: string, opts: GtestOptions) => {
      try {
        const descriptorPath = path.resolve(gtestPath);
        const workspaceRoot = path.resolve(opts.workspace ?? process.cwd());
        let lastLogged = '';
        const run = await runGtest(descriptorPath, workspaceRoot, (r) => {
          // Echo the newest log line of the most-recently-active stage.
          for (let i = r.stages.length - 1; i >= 0; i--) {
            const s = r.stages[i];
            if (s.status === 'queued' || s.log.length === 0) continue;
            const line = `${s.name}: ${s.log[s.log.length - 1]}`;
            if (line !== lastLogged) { lastLogged = line; process.stdout.write(pc.dim(`  ${line}\n`)); }
            break;
          }
        });

        const failed = run.stages.filter((s) => s.status === 'failed').length;
        console.log((run.status === 'failed' ? pc.red : pc.green)(
          `\n[gtest] ${run.stages.length - failed}/${run.stages.length} stages passed — ${run.status.toUpperCase()}`));
        process.exit(run.status === 'failed' ? 1 : 0);
      } catch (err) {
        if (err instanceof GtestParseError) {
          console.error(pc.red(`[gtest] ${err.message}`));
          process.exit(1);
        }
        console.error(pc.red(`[gtest] fatal: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
