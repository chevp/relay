/**
 * `relay dev` — ng-serve-style dev loop.
 *
 * Idiom: `cd` into a game folder (one containing `iris.xml` or `runtime.xml`)
 * and run `relay dev`. No positional needed. Relay serves cwd in-process via
 * the default config, spawns iris-player on `cwd/iris.xml`, forwards stdout,
 * and tears the server down when the player exits.
 *
 * Convenience: if cwd isn't a game folder but contains an `examples/`
 * subdirectory (or one is reachable upward), `relay dev` with no arg lists
 * the available games. `relay dev <name>` then runs that named example.
 *
 * Player binary resolution (first hit wins):
 *   1. --player <path>
 *   2. $RELAY_PLAYER
 *   3. kosmos convention — walk up from cwd looking for
 *      `runtime/iris/build/bin/Release/iris-player`
 *
 * Pass extra args through to iris-player after `--`:
 *   relay dev -- --validation --log-level DEBUG --width 1920
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runServe, type ServeOptions } from './serve.js';
import { DEFAULT_PORT, DEFAULT_HOST } from '../config/ServeConfig.js';

interface DevOptions {
  port: string;
  host: string;
  player?: string;
  watch: boolean;
  color: boolean;
}

export function registerDev(program: Command): void {
  program
    .command('dev')
    .description('ng-serve-style dev loop: serve cwd + launch iris-player on cwd/iris.xml')
    .argument('[example]', 'Optional: name of an examples/<name> subfolder (escape hatch when cwd is not a game folder)')
    .option('-p, --port <n>', 'Relay port', String(DEFAULT_PORT))
    .option('-h, --host <addr>', 'Relay bind host', DEFAULT_HOST)
    .option('--player <path>', 'Path to iris-player binary (overrides $RELAY_PLAYER and auto-discovery)')
    .option('--no-watch', 'Disable manifest regeneration on file change')
    .option('--no-color', 'Disable ANSI color output')
    .allowUnknownOption(true)
    .action(async (example: string | undefined, opts: DevOptions) => {
      const code = await runDev(example, opts);
      process.exit(code);
    });
}

async function runDev(example: string | undefined, opts: DevOptions): Promise<number> {
  if (!opts.color) process.env.NO_COLOR = '1';

  const gameDir = await resolveGameDir(example);
  if (!gameDir) return 2;  // resolveGameDir already printed the error / listing

  const xmlPath = pickEntryXml(gameDir);
  if (!xmlPath) {
    fail(`no iris.xml or runtime.xml in ${gameDir}`);
    return 2;
  }

  const playerPath = await resolvePlayer(opts.player, gameDir);
  if (!playerPath) {
    fail(`iris-player not found — pass --player <path> or set RELAY_PLAYER`);
    return 2;
  }

  // Extra args after `--` get forwarded to iris-player. commander hands them
  // back via process.argv (it doesn't strip the separator), so we slice here.
  const sepIdx = process.argv.indexOf('--');
  const playerExtraArgs = sepIdx >= 0 ? process.argv.slice(sepIdx + 1) : [];

  // Start serve in-process pointing at the game folder via the default
  // config (mounts cwd as /games/current/v-dev/ plus optional assets/configs).
  const originalCwd = process.cwd();
  process.chdir(gameDir);
  let serveResult;
  try {
    const serveOpts: ServeOptions = {
      port: opts.port,
      host: opts.host,
      // Pass a sentinel that resolveConfig will treat as "no file" and fall
      // back to defaultConfig(cwd) — avoids writing a nuna-serve.xml into
      // every game folder we touch.
      config: 'nuna-serve.xml',
      verbose: false,
      color: opts.color,
      watch: opts.watch,
    };
    serveResult = await runServe(serveOpts);
  } finally {
    process.chdir(originalCwd);
  }
  const { server, publicHost, config: serveConfig } = serveResult;

  const base = `http://${publicHost}:${serveConfig.port}`;
  console.log();
  console.log(pc.bold(pc.cyan('  relay dev')));
  console.log(`  ${pc.dim('relay:')}    ${base}`);
  console.log(`  ${pc.dim('game:')}     ${gameDir}`);
  console.log(`  ${pc.dim('player:')}   ${playerPath}`);
  console.log(`  ${pc.dim('entry:')}    ${path.relative(gameDir, xmlPath) || path.basename(xmlPath)}`);
  if (playerExtraArgs.length) {
    console.log(`  ${pc.dim('args:')}     ${playerExtraArgs.join(' ')}`);
  }
  console.log();

  const child = spawn(playerPath, [xmlPath, ...playerExtraArgs], {
    stdio: 'inherit',
  });

  const shutdown = async (signal: NodeJS.Signals | null) => {
    if (signal && child.exitCode === null && !child.killed) {
      child.kill(signal);
    }
    try { await server.close(); } catch { /* already closed */ }
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const exitCode: number = await new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve(code ?? (sig ? 128 : 1)));
    child.once('error', (err) => {
      console.error(pc.red(`[relay dev] failed to launch player: ${err.message}`));
      resolve(127);
    });
  });

  await shutdown(null);
  return exitCode;
}

// ── resolution ────────────────────────────────────────────────────────

/**
 * ng-serve-style resolution:
 *   1. --positional <name> given → look for examples/<name>/ walking up
 *   2. cwd itself has iris.xml/runtime.xml → use cwd (the common case)
 *   3. cwd has (or is under) an examples/ dir → list and exit (helper)
 *   4. neither → error
 */
async function resolveGameDir(example: string | undefined): Promise<string | null> {
  const cwd = process.cwd();

  if (example) {
    const examplesDir = await findExamplesDir(cwd);
    if (!examplesDir) {
      fail(`'${example}' given but no examples/ folder found from ${cwd} upward`);
      return null;
    }
    const candidate = path.isAbsolute(example) ? example : path.join(examplesDir, example);
    if (!existsSync(candidate)) {
      fail(`example folder not found: ${candidate}`);
      return null;
    }
    return candidate;
  }

  if (pickEntryXml(cwd)) {
    return cwd;
  }

  const examplesDir = await findExamplesDir(cwd);
  if (examplesDir) {
    console.log(`${pc.yellow('cwd has no iris.xml')} — available examples in ${pc.dim(examplesDir)}:`);
    for (const e of await listExamples(examplesDir)) {
      console.log(`  ${e}`);
    }
    console.log();
    console.log(`cd into one of those, or run: ${pc.cyan('relay dev <name>')}`);
    return null;
  }

  fail(`cwd has no iris.xml/runtime.xml and no examples/ folder is reachable`);
  return null;
}

async function findExamplesDir(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  while (true) {
    const candidate = path.join(dir, 'examples');
    if (existsSync(candidate) && (await fs.stat(candidate)).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function listExamples(examplesDir: string): Promise<string[]> {
  const entries = await fs.readdir(examplesDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function pickEntryXml(gameDir: string): string | null {
  const iris = path.join(gameDir, 'iris.xml');
  if (existsSync(iris)) return iris;
  const runtime = path.join(gameDir, 'runtime.xml');
  if (existsSync(runtime)) return runtime;
  return null;
}

async function resolvePlayer(flag: string | undefined, gameDir: string): Promise<string | null> {
  const tried: string[] = [];
  for (const cand of [flag, process.env.RELAY_PLAYER]) {
    if (!cand) continue;
    const abs = path.isAbsolute(cand) ? cand : path.resolve(process.cwd(), cand);
    if (existsSync(abs)) return abs;
    tried.push(abs);
  }
  // kosmos convention: walk up from gameDir looking for runtime/iris/build/...
  let dir = path.resolve(gameDir);
  while (true) {
    const cand = path.join(dir, 'runtime', 'iris', 'build', 'bin', 'Release', 'iris-player');
    if (existsSync(cand)) return cand;
    tried.push(cand);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.error(pc.red(`[relay dev] tried:`));
  for (const t of tried) console.error(pc.dim(`             ${t}`));
  return null;
}

function fail(msg: string): void {
  console.error(pc.red(`[relay dev] ${msg}`));
}
