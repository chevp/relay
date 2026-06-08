/**
 * `relay daemon` — start the long-running relay control daemon.
 *
 * The dockerd-style front door: a persistent process that supervises engine
 * children and runs workloads (.gtest today). Stays alive until `shutdown` is
 * received over the control socket or the process is signalled.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { startDaemonServer } from '../daemon/server.js';
import { VERSION } from '../version.js';

// Control-plane port. Distinct from the container's child-daemon ports:
// iris-player sidecar 9100, preview 9200, shots 9300, flow 9400, gtest-preview 9500.
const DEFAULT_PORT = '9099';

interface DaemonOptions {
  host: string;
  port: string;
  gtestPort?: string;
}

export function registerDaemon(program: Command): void {
  program
    .command('daemon')
    .description('Start the long-running relay control daemon (supervises children, runs workloads)')
    .option('-h, --host <addr>', 'Host to bind', '127.0.0.1')
    .option('-p, --port <number>', 'Control WebSocket port', DEFAULT_PORT)
    .option('--gtest-port <number>', 'Default daemon port for gtest runs', '9876')
    .action(async (opts: DaemonOptions) => {
      const port = parseInt(opts.port, 10);
      const server = await startDaemonServer({
        host: opts.host,
        port,
        defaultGtestPort: opts.gtestPort ? parseInt(opts.gtestPort, 10) : undefined,
      });

      console.log();
      console.log(pc.bold(pc.cyan('  relay daemon')) + pc.dim(`  v${VERSION}`));
      console.log(pc.dim(`  control:  ws://${opts.host}:${server.port}`));
      console.log(pc.dim('  cmds:     ping · ps · kill · gtest.run · shutdown'));
      console.log(pc.dim('  Ctrl-C or send `shutdown` to stop.'));
      console.log();

      const stop = (): void => {
        console.log(pc.dim('\n[daemon] shutting down — reaping children...'));
        void server.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
}
