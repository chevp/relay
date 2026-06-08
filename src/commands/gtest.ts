/**
 * `relay gtest <file.gtest>` — run a .gtest suite headless against iris-player.
 *
 * The automation entry point: no Electron, no display. Exits 0 on a pass
 * verdict, 1 on any failed/errored assert or a fatal error — the CI contract.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runGTest } from '../gtest/runner.js';
import { GTestParseError } from '../gtest/schema.js';
import { resolvePlayerPath } from '../daemon/playerPath.js';

const DEFAULT_PORT = '9876';

interface GTestOptions {
  player?: string;
  port: string;
  out?: string;
  baselineDir?: string;
  commandTimeout?: string;
  updateBaselines?: boolean;
}

export function registerGtest(program: Command): void {
  program
    .command('gtest <file.gtest>')
    .description('Run a .gtest suite headless against iris-player (engine-state + pixel asserts)')
    .option('--player <path>', 'Path to iris-player binary')
    .option('-p, --port <number>', 'Daemon WebSocket port', DEFAULT_PORT)
    .option('--out <dir>', 'Artefact output dir (default: <gtest-dir>/_results/<name>/)')
    .option('--baseline-dir <dir>', 'Baseline root for pixel asserts (default: the .gtest file dir)')
    .option('--command-timeout <ms>', 'Per-WS-command timeout in ms', '15000')
    .option('--update-baselines', 'Overwrite baselines with the captured frames instead of comparing', false)
    .action(async (gtestPath: string, opts: GTestOptions) => {
      try {
        const playerPath = resolvePlayerPath(opts.player);
        if (!existsSync(playerPath)) {
          console.error(pc.red(`[gtest] iris-player not found at ${playerPath} (use --player)`));
          process.exit(1);
        }
        const result = await runGTest({
          gtestPath,
          playerPath,
          port: parseInt(opts.port, 10),
          outDir: opts.out ? path.resolve(opts.out) : undefined,
          baselineDir: opts.baselineDir ? path.resolve(opts.baselineDir) : undefined,
          commandTimeoutMs: opts.commandTimeout ? parseInt(opts.commandTimeout, 10) : undefined,
          updateBaselines: opts.updateBaselines,
        });
        process.exit(result.status === 'pass' ? 0 : 1);
      } catch (err) {
        if (err instanceof GTestParseError) {
          console.error(pc.red(`[gtest] ${err.message}`));
          process.exit(1);
        }
        console.error(pc.red(`[gtest] fatal: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
