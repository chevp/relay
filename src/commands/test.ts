/**
 * `nuna test <playbook.yaml>` — run a scripted playbook against iris-player.
 *
 * Per ADR-0008: scripted playbooks live in relay and drive the Storybook
 * daemon WebSocket (cmd/args/id envelope). One playbook, one player
 * invocation, exit non-zero on first failed step.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runPlaybook } from '../playbook/runner.js';
import { PlaybookParseError } from '../playbook/schema.js';

const DEFAULT_PORT = '9876';

interface TestOptions {
  player?: string;
  port: string;
  out?: string;
  repo?: string;
  commandTimeout?: string;
  input?: string;
}

export function registerTest(program: Command): void {
  program
    .command('test <playbook.yaml>')
    .description('Run a scripted playbook against iris-player (ADR-0008)')
    .option('--player <path>', 'Path to iris-player binary (default: <repo>/cpp/build/bin/Release/nuna-player.exe)')
    .option('-p, --port <number>', 'Daemon WebSocket port', DEFAULT_PORT)
    .option('--out <dir>', 'Output directory (default: <playbook-dir>/_results/<playbook-name>/)')
    .option('--repo <path>', 'Repo root (default: cwd auto-detected)')
    .option('--command-timeout <ms>', 'Per-WS-command timeout in ms', '15000')
    .option('--input <path>', 'Positional input file (e.g. runtime.xml) passed to iris-player at spawn')
    .action(async (playbookPath: string, opts: TestOptions) => {
      try {
        let playerPath: string;
        if (opts.player) {
          playerPath = path.resolve(opts.player);
        } else {
          const repoRoot = opts.repo ? path.resolve(opts.repo) : await findRepoRoot(process.cwd());
          playerPath = path.join(repoRoot, 'cpp', 'build', 'bin', 'Release', 'nuna-player.exe');
        }
        if (!existsSync(playerPath)) {
          console.error(pc.red(`[test] iris-player not found at ${playerPath} (use --player)`));
          process.exit(1);
        }

        const result = await runPlaybook({
          playbookPath,
          playerPath,
          port: parseInt(opts.port, 10),
          outDir: opts.out ? path.resolve(opts.out) : undefined,
          commandTimeoutMs: opts.commandTimeout ? parseInt(opts.commandTimeout, 10) : undefined,
          inputFile: opts.input ? path.resolve(opts.input) : undefined,
        });

        process.exit(result.status === 'ok' ? 0 : 1);
      } catch (err) {
        if (err instanceof PlaybookParseError) {
          // Already printed by runner; just exit non-zero.
          process.exit(1);
        }
        console.error(pc.red(`[test] fatal: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

async function findRepoRoot(start: string): Promise<string> {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'games')) && existsSync(path.join(dir, 'cpp'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`could not find repo root from ${start} (looking for games/ + cpp/ siblings)`);
}
