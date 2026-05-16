/**
 * `nuna mcp` — STUB.
 *
 * Will host the MCP server (Model Context Protocol) bridging AI agents to
 * the Nuna engine. Full implementation tracked under §1.3.4.
 */

import { Command } from 'commander';

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('(not yet implemented) Start the Nuna MCP server — see plan §1.3.4')
    .action(() => {
      console.error('nuna mcp: not yet implemented (see plan §1.3.4)');
      process.exit(2);
    });
}
