/**
 * `nuna validate` — STUB.
 *
 * Will host game validation (folder structure, manifest, scene schema, Lua
 * script headers, naming, asset references). Today this is provided by the
 * `nuna-validate-game` skill in tools/nuna-ai-framework/.
 */

import { Command } from 'commander';

export function registerValidate(program: Command): void {
  program
    .command('validate')
    .description('(not yet implemented) Validate a Nuna game against production rules')
    .action(() => {
      console.error('nuna validate: not yet implemented (use the nuna-validate-game skill for now)');
      process.exit(2);
    });
}
