/**
 * `relay shots|atlas|flow <file>` — run a workload headless, no Electron.
 *
 * Each writes to the same `.kosmos/<...>/run.json` cache the container reads and
 * exits 0 when the run succeeded, 1 otherwise — the CI contract.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import path from 'node:path';
import { runShots } from '../shots/runner.js';
import { runAtlas } from '../atlas/runner.js';
import { runFlow } from '../flow/runner.js';

interface Opts { workspace?: string }

type RunFn = (descriptor: string, workspace: string, onProgress?: (run: { status: string }) => void) => Promise<{ status: string }>;

function register(program: Command, name: string, arg: string, desc: string, run: RunFn): void {
  program
    .command(`${name} <${arg}>`)
    .description(desc)
    .option('--workspace <dir>', 'Workspace root for the .kosmos cache (default: cwd)')
    .action(async (file: string, opts: Opts) => {
      try {
        const descriptorPath = path.resolve(file);
        const workspaceRoot = path.resolve(opts.workspace ?? process.cwd());
        const result = await run(descriptorPath, workspaceRoot);
        const failed = result.status === 'failed';
        console.log((failed ? pc.red : pc.green)(`[${name}] ${result.status.toUpperCase()}`));
        process.exit(failed ? 1 : 0);
      } catch (err) {
        console.error(pc.red(`[${name}] fatal: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

export function registerWorkflows(program: Command): void {
  register(program, 'shots', 'file.shots', 'Render a .shots descriptor headless (iris-preview)', runShots);
  register(program, 'atlas', 'file.atlas', 'Render a .atlas descriptor + pack the sprite sheet headless', runAtlas);
  register(program, 'flow', 'file.flow', 'Run a .flow job DAG headless (iris-preview/docker/ollama/shell)', runFlow);
}
