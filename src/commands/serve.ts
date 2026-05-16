/**
 * `nuna serve` — start the dev HTTP server.
 *
 * Reads nuna-serve.xml from CWD (or --config path), starts a Fastify HTTP
 * server that mounts static roots, exposes /discover.json + /health, and
 * serves per-root SHA-256 manifests.
 *
 * Extracted from the former `nuna-serve` standalone bin (§1.2.14) into a
 * subcommand of the unified `nuna` CLI (§1.2.19). The `--open` flag is
 * intentionally NOT carried over — use `nuna open` instead.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  loadServeConfig,
  defaultConfig,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type ServeConfig,
} from '../config/ServeConfig.js';
import { createServer } from '../server.js';
import { checkRequiredServers } from '../discovery/connectivity.js';
import { warnAuthoringFormats } from '../config/authoringCheck.js';
import { createFileWatcher } from '../watch/fileWatcher.js';
import type { Manifest } from '../manifest/ManifestBuilder.js';
import { VERSION } from '../version.js';

const DEFAULT_CONFIG_FILENAME = 'nuna-serve.xml';

export interface ServeOptions {
  port?: string;
  host?: string;
  config: string;
  assets?: string;
  configs?: string;
  verbose: boolean;
  color: boolean;
  watch: boolean;
}

export interface ServeResult {
  server: FastifyInstance;
  config: ServeConfig;
  publicHost: string;
  address: string;
}

/**
 * Register `nuna serve` on the given Commander program.
 */
export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start the Nuna dev HTTP server for the current game repo')
    .option('-p, --port <n>', 'Port to bind', String(DEFAULT_PORT))
    .option('-h, --host <addr>', 'Host to bind', DEFAULT_HOST)
    .option('-c, --config <path>', 'Path to nuna-serve.xml', DEFAULT_CONFIG_FILENAME)
    .option('-a, --assets <path>', 'Path to exported assets (default: ./assets-export)')
    .option('--configs <path>', 'Path to game configs (default: ./configs)')
    .option('--watch', 'Regenerate manifest on file change', false)
    .option('--verbose', 'Enable request logging', false)
    .option('--no-color', 'Disable ANSI color output')
    .action(async (opts: ServeOptions) => {
      const result = await runServe(opts);
      printBanner(result.config, result.publicHost, result.address);
    });
}

/**
 * Start the dev server programmatically. Used by both `nuna serve` and
 * `nuna open` (which wraps this and then launches the OS URL handler).
 *
 * Returns the listening Fastify instance + resolved context. Caller is
 * responsible for keeping the process alive (Fastify keeps the event loop
 * busy automatically) and for shutdown via `server.close()`.
 */
export async function runServe(opts: ServeOptions): Promise<ServeResult> {
  if (!opts.color) {
    process.env.NO_COLOR = '1';
  }

  const cwd = process.cwd();
  const config = await resolveConfig(opts.config, cwd);

  if (opts.port !== undefined) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      fail(`Invalid port: ${opts.port}`);
    }
    config.port = p;
  }
  if (opts.host !== undefined) {
    config.host = opts.host;
  }

  applyAssetConfigOverrides(config, opts, cwd);

  // G8: warn if authoring formats (.blend, .psd) found in asset paths
  await warnAuthoringFormats(config.staticRoots.map((r) => r.path));

  await verifyRequiredServers(config);

  const manifests = new Map<string, Manifest>();
  const publicHost = derivePublicHost(config.host);
  const server = await createServer({
    config,
    version: VERSION,
    verbose: opts.verbose,
    manifests,
    publicHost,
  });

  let address: string;
  try {
    address = await server.listen({ host: config.host, port: config.port });
  } catch (err) {
    fail(`Failed to bind ${config.host}:${config.port}: ${(err as Error).message}`);
  }

  if (opts.watch) {
    createFileWatcher(config.staticRoots, manifests);
    console.log(pc.dim('  [watch] watching static roots for changes'));
  }

  return { server, config, publicHost, address };
}

function applyAssetConfigOverrides(config: ServeConfig, opts: ServeOptions, cwd: string): void {
  if (opts.assets) {
    const absAssets = path.isAbsolute(opts.assets) ? opts.assets : path.resolve(cwd, opts.assets);
    const existing = config.staticRoots.find((r) => r.alias === 'assets');
    if (existing) {
      existing.path = absAssets;
    } else {
      config.staticRoots.push({
        alias: 'assets',
        path: absAssets,
        mount: '/assets/',
        optional: false,
      });
    }
  }
  if (opts.configs) {
    const absConfigs = path.isAbsolute(opts.configs) ? opts.configs : path.resolve(cwd, opts.configs);
    const existing = config.staticRoots.find((r) => r.alias === 'configs');
    if (existing) {
      existing.path = absConfigs;
    } else {
      config.staticRoots.push({
        alias: 'configs',
        path: absConfigs,
        mount: '/configs/',
        optional: false,
      });
    }
  }
}

async function resolveConfig(configOpt: string, cwd: string): Promise<ServeConfig> {
  const configPath = path.isAbsolute(configOpt) ? configOpt : path.resolve(cwd, configOpt);
  const explicit = configOpt !== DEFAULT_CONFIG_FILENAME;
  try {
    await fs.access(configPath);
  } catch {
    if (explicit) fail(`Config file not found: ${configPath}`);
    console.log(pc.yellow(`[nuna serve] no ${DEFAULT_CONFIG_FILENAME} found — using default config for ${cwd}`));
    return defaultConfig(cwd);
  }
  try {
    return await loadServeConfig(configPath);
  } catch (err) {
    fail(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }
}

async function verifyRequiredServers(config: ServeConfig): Promise<void> {
  const required = config.servers.filter((s) => s.required);
  if (required.length === 0) return;
  console.log(pc.dim(`[nuna serve] checking ${required.length} required server(s)...`));
  const results = await checkRequiredServers(config.servers);
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const label = r.ok ? pc.green('OK') : pc.red('FAIL');
    console.log(`  ${label}  ${r.alias}  ${r.url}  ${pc.dim(r.reason ?? '')}`);
  }
  if (failed.length > 0) {
    fail(`${failed.length} required server(s) unreachable — aborting.`);
  }
}

function derivePublicHost(bindHost: string): string {
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') {
    return 'localhost';
  }
  return bindHost;
}

export function printBanner(config: ServeConfig, publicHost: string, address: string): void {
  const base = `http://${publicHost}:${config.port}`;
  console.log();
  console.log(pc.bold(pc.cyan('  nuna serve')) + pc.dim(`  v${VERSION}`));
  console.log(pc.dim(`  bound:    ${address}`));
  console.log(pc.dim(`  config:   ${config.configPath}`));
  console.log();
  console.log('  Static roots:');
  if (config.staticRoots.length === 0) {
    console.log(pc.dim('    (none)'));
  } else {
    for (const r of config.staticRoots) {
      console.log(`    ${pc.green(r.alias.padEnd(12))} ${base}${r.mount}  ${pc.dim(`(${r.path})`)}`);
    }
  }
  if (config.servers.length > 0) {
    console.log();
    console.log('  Connected servers:');
    for (const s of config.servers) {
      const tag = s.required ? pc.yellow('[required]') : pc.dim('[optional]');
      console.log(`    ${pc.green(s.alias.padEnd(12))} ${s.url}  ${tag}  ${pc.dim(s.kind)}`);
    }
  }
  console.log();
  console.log(`  Discovery: ${pc.cyan(`${base}/discover.json`)}`);
  console.log(`  Health:    ${pc.cyan(`${base}/health`)}`);
  console.log();
}

function fail(msg: string): never {
  console.error(pc.red(`[nuna serve] ${msg}`));
  process.exit(2);
}
