/**
 * `nuna test` — STUB.
 *
 * Will host the MCP test mode (running scripted scenarios against the engine
 * without a GUI). Full implementation tracked under §1.3.4 (Frost Engine
 * CLI-Tooling - MCP-Server + Renderer-Client).
 */

import { Command } from 'commander';

export function registerTest(program: Command): void {
  program
    .command('test')
    .description('(not yet implemented) Run game tests / MCP test mode — see plan §1.3.4')
    .action(() => {
      console.error('nuna test: not yet implemented (see plan §1.3.4)');
      process.exit(2);
    });
}
