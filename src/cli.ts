#!/usr/bin/env node
/**
 * nuna CLI — entry point.
 *
 * Unified Nuna CLI router. Registers subcommands and dispatches.
 *
 *   nuna serve [options]      — start dev HTTP server (replaces nuna-serve)
 *   nuna open [path-or-url]   — open game in player (combo: serve + nuna://play)
 *   nuna test                 — (stub) MCP test mode
 *   nuna build                — (stub) game build pipeline
 *   nuna validate             — (stub) game validation
 *   nuna mcp                  — (stub) MCP server
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { VERSION } from './version.js';
import { registerServe } from './commands/serve.js';
import { registerOpen } from './commands/open.js';
import { registerTest } from './commands/test.js';
import { registerBuild } from './commands/build.js';
import { registerValidate } from './commands/validate.js';
import { registerMcp } from './commands/mcp.js';
import { registerStory } from './commands/story.js';

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('nuna')
    .description('Unified Nuna CLI — serve, open, test, build, validate, mcp')
    .version(VERSION);

  registerServe(program);
  registerOpen(program);
  registerTest(program);
  registerBuild(program);
  registerValidate(program);
  registerMcp(program);
  registerStory(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(pc.red(`[nuna] fatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
