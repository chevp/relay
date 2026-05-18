/**
 * Shared WebSocket IPC helpers for the Storybook daemon protocol.
 *
 * Envelope: `{ id, cmd, args? }` → `{ id, ok, result?|error? }` — see
 * iris/apps/iris/src/daemon/StorybookDaemon.cpp.
 *
 * Used by both `nuna story` (gallery generator) and `nuna test` (scenario
 * runner) per ADR-0008.
 */

import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}

export async function connect(uri: string, timeoutMs: number): Promise<WebSocket> {
  const ws = new WebSocket(uri);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ws connect timeout: ${uri}`));
    }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return ws;
}

export async function sendCmd(
  ws: WebSocket,
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<IpcResponse> {
  const id = `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const message: Record<string, unknown> = { id, cmd };
  if (Object.keys(args).length > 0) message.args = args;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ws cmd timeout (${cmd}, ${timeoutMs}ms)`)),
      timeoutMs,
    );
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const msg = JSON.parse(data.toString()) as IpcResponse;
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(err);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

export async function waitForEngineRunning(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const ws = await connect(`ws://127.0.0.1:${port}`, 1_500);
      try {
        const r = await sendCmd(ws, 'ping', {}, 3_000);
        if (r.ok && r.result?.engineRunning) return;
      } finally {
        ws.close();
      }
    } catch (err) {
      lastErr = err as Error;
    }
    await delay(500);
  }
  throw new Error(
    `daemon never reached engineRunning state${lastErr ? ` (last: ${lastErr.message})` : ''}`,
  );
}
