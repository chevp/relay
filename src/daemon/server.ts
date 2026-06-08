/**
 * The relay daemon's control server — the dockerd-style front door.
 *
 * A persistent WebSocket server speaking the same `{id,cmd,args}` →
 * `{id,ok,result|error}` envelope as the rest of the Storybook protocol. The
 * daemon owns workload execution (it runs .gtest suites) and a process registry
 * for the children it supervises; it does NOT carry hot-path media (preview
 * frames stay on their own direct channel — CTX-002 control/data split).
 *
 * Control cmds:
 *   ping       → { version, uptimeMs, children }
 *   ps         → ChildInfo[]                 (registry snapshot)
 *   kill       → { killed }  args: { id }
 *   gtest.run  → GTestResult args: { file, player?, port?, out?, baselineDir?, updateBaselines? }
 *   shutdown   → { ok }                      (reaps children, closes the server)
 */

import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ProcessRegistry } from './registry.js';
import { runGtest, killActiveGtest } from '../gtest/runner.js';
import { runShots, killActiveShots } from '../shots/runner.js';
import { runAtlas, killActiveAtlas } from '../atlas/runner.js';
import { runFlow, killActiveFlows } from '../flow/runner.js';
import { VERSION } from '../version.js';

export interface DaemonOptions {
  host?: string;
  port: number;
  /** Default WS port handed to gtest runs that don't specify one. */
  defaultGtestPort?: number;
}

export interface DaemonServer {
  port: number;
  registry: ProcessRegistry;
  close: () => Promise<void>;
}

interface Envelope { id?: string; cmd?: string; args?: Record<string, unknown>; }

export async function startDaemonServer(opts: DaemonOptions): Promise<DaemonServer> {
  const startedAtMs = Date.now();
  const registry = new ProcessRegistry();
  const handlers = buildHandlers(registry, startedAtMs);

  const wss = new WebSocketServer({ host: opts.host ?? '127.0.0.1', port: opts.port });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('message', (data) => { void dispatch(ws, data.toString(), handlers); });
  });

  const close = async (): Promise<void> => {
    killActiveGtest();
    killActiveShots();
    killActiveAtlas();
    killActiveFlows();
    registry.killAll();
    for (const client of wss.clients) { try { client.close(); } catch { /* ignore */ } }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  };

  return { port: opts.port, registry, close };
}

/** Handlers may push intermediate `{type,...}` frames (no id) before resolving. */
type Push = (event: Record<string, unknown>) => void;
type Handler = (args: Record<string, unknown>, push: Push) => Promise<unknown> | unknown;

function buildHandlers(registry: ProcessRegistry, startedAtMs: number): Map<string, Handler> {
  const m = new Map<string, Handler>();

  m.set('ping', () => ({
    version: VERSION,
    uptimeMs: Date.now() - startedAtMs,
    children: registry.running().length,
  }));

  m.set('ps', () => registry.list());

  m.set('kill', (args) => {
    const id = String(args.id ?? '');
    if (!id) throw new Error('kill requires args.id');
    return { killed: registry.kill(id) };
  });

  // Workload commands. Each streams live progress (so the container UI updates)
  // then returns the final run. `workspace` defaults to the descriptor's dir.
  const fileAndWorkspace = (args: Record<string, unknown>, cmd: string): [string, string] => {
    const file = args.file;
    if (typeof file !== 'string' || !file) throw new Error(`${cmd} requires args.file`);
    return [file, typeof args.workspace === 'string' ? args.workspace : path.dirname(file)];
  };

  m.set('gtest.run', async (args, push) => {
    const [file, workspace] = fileAndWorkspace(args, 'gtest.run');
    return runGtest(file, workspace, (run) => push({ type: 'gtest.progress', run }));
  });
  m.set('shots.run', async (args, push) => {
    const [file, workspace] = fileAndWorkspace(args, 'shots.run');
    return runShots(file, workspace, (run) => push({ type: 'shots.progress', run }));
  });
  m.set('atlas.run', async (args, push) => {
    const [file, workspace] = fileAndWorkspace(args, 'atlas.run');
    return runAtlas(file, workspace, (run) => push({ type: 'atlas.progress', run }));
  });
  m.set('flow.run', async (args, push) => {
    const [file, workspace] = fileAndWorkspace(args, 'flow.run');
    return runFlow(file, workspace, (run) => push({ type: 'flow.progress', run }));
  });

  // `shutdown` is handled in dispatch (it must reply before tearing down).
  return m;
}

async function dispatch(ws: WebSocket, raw: string, handlers: Map<string, Handler>): Promise<void> {
  let msg: Envelope;
  try {
    msg = JSON.parse(raw) as Envelope;
  } catch {
    return; // ignore non-JSON frames
  }
  const id = msg.id;
  const cmd = msg.cmd;
  const reply = (body: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id, ...body }));
  };
  if (!cmd) { reply({ ok: false, error: 'missing cmd' }); return; }

  if (cmd === 'shutdown') {
    reply({ ok: true, result: { ok: true } });
    // Let the reply flush, then exit the process (the command runner keeps the
    // event loop alive otherwise).
    setTimeout(() => process.exit(0), 50);
    return;
  }

  const handler = handlers.get(cmd);
  if (!handler) { reply({ ok: false, error: `unknown cmd: ${cmd}` }); return; }
  const push: Push = (event) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  };
  try {
    const result = await handler(msg.args ?? {}, push);
    reply({ ok: true, result });
  } catch (err) {
    reply({ ok: false, error: (err as Error).message });
  }
}
