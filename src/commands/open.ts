/**
 * `nuna open` — open a game in the Nuna player.
 *
 * Three modes:
 *   1. `nuna open`               → CWD as game path; starts server in-process,
 *                                   then launches `nuna://play?discovery=...`,
 *                                   blocks until SIGINT.
 *   2. `nuna open ./games/foo`   → same as (1) but with explicit path.
 *   3. `nuna open http://...`    → URL-mode: no server; just hands the URL to
 *                                   the OS `nuna://` handler and exits.
 *
 * Mode is detected by the optional positional arg: anything starting with
 * `http://` or `https://` is treated as a discovery URL; otherwise it's a
 * filesystem path (default: CWD).
 */

import { Command } from 'commander';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import { runServe, printBanner, type ServeOptions } from './serve.js';
import { openDiscoveryUrl } from '../open/openUrl.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../config/ServeConfig.js';

const URL_RE = /^https?:\/\//i;

interface OpenOptions extends ServeOptions {}

export function registerOpen(program: Command): void {
  program
    .command('open')
    .description('Open a game in the Nuna player (combo: serve + nuna://play)')
    .argument('[path-or-url]', 'Game path (default: CWD) or http(s) discovery URL')
    .option('-p, --port <n>', 'Port to bind (path mode only)', String(DEFAULT_PORT))
    .option('-h, --host <addr>', 'Host to bind (path mode only)', DEFAULT_HOST)
    .option('-c, --config <path>', 'Path to nuna-serve.xml (path mode only)', 'nuna-serve.xml')
    .option('-a, --assets <path>', 'Path to exported assets (path mode only)')
    .option('--configs <path>', 'Path to game configs (path mode only)')
    .option('--watch', 'Regenerate manifest on file change (path mode only)', false)
    .option('--verbose', 'Enable request logging (path mode only)', false)
    .option('--no-color', 'Disable ANSI color output')
    .action(async (target: string | undefined, opts: OpenOptions) => {
      if (target && URL_RE.test(target)) {
        await openUrlMode(target);
        return;
      }
      await openPathMode(target, opts);
    });
}

/**
 * URL mode: no server, just hand the discovery URL to the OS handler.
 */
async function openUrlMode(discoveryUrl: string): Promise<void> {
  console.log(pc.dim(`[nuna open] URL mode: ${discoveryUrl}`));
  await openDiscoveryUrl(discoveryUrl);
}

/**
 * Path mode: chdir to the target path, start the dev server in-process,
 * launch the OS URL handler with the resulting discovery URL, and block
 * on SIGINT for graceful shutdown.
 */
async function openPathMode(target: string | undefined, opts: OpenOptions): Promise<void> {
  const cwd = process.cwd();
  const gamePath = target
    ? path.isAbsolute(target)
      ? target
      : path.resolve(cwd, target)
    : cwd;

  if (gamePath !== cwd) {
    console.log(pc.dim(`[nuna open] entering ${gamePath}`));
    try {
      process.chdir(gamePath);
    } catch (err) {
      console.error(pc.red(`[nuna open] cannot chdir to ${gamePath}: ${(err as Error).message}`));
      process.exit(2);
    }
  }

  const result = await runServe(opts);
  printBanner(result.config, result.publicHost, result.address);

  const discoveryUrl = `http://${result.publicHost}:${result.config.port}/discover.json`;
  await openDiscoveryUrl(discoveryUrl);

  console.log(pc.dim('[nuna open] press Ctrl+C to stop the server.'));

  // Block until SIGINT/SIGTERM, then close the server cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      console.log(pc.dim(`\n[nuna open] received ${signal}, shutting down...`));
      try {
        await result.server.close();
      } catch (err) {
        console.error(pc.yellow(`[nuna open] error during close: ${(err as Error).message}`));
      }
      resolve();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  });

  process.exit(0);
}
