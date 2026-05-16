/**
 * `nuna build` — STUB.
 *
 * Will host the game build pipeline (asset filtering, optimization, deploy
 * artifact creation). Full implementation tracked under §1.2.16
 * (Asset-Build-Pipeline) and §1.2.4 (Game Deployment Pipeline).
 */

import { Command } from 'commander';

export function registerBuild(program: Command): void {
  program
    .command('build')
    .description('(not yet implemented) Build / package a game — see plans §1.2.16, §1.2.4')
    .action(() => {
      console.error('nuna build: not yet implemented (see plans §1.2.16, §1.2.4)');
      process.exit(2);
    });
}
