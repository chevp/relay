/**
 * Persistent push-event channel for the Storybook daemon protocol.
 *
 * The daemon (iris-player) normally answers RPC calls `{ id, cmd, args }` →
 * `{ id, ok, ... }`. For the right-click context menu it ALSO pushes unsolicited
 * events that have a `type` and NO `id`:
 *
 *   { "type": "contextmenu.request", x, y, entity }
 *   { "type": "menu.action", action, event, param, entity, x, y }
 *
 * `attachEventListener` installs a long-lived `message` handler that forwards
 * only those push-events. It coexists with `sendCmd` (ipc.ts), whose own
 * per-call listeners filter by `id` — each side ignores the other's frames.
 */

import type WebSocket from 'ws';

export interface ContextMenuRequest {
  type: 'contextmenu.request';
  x: number;
  y: number;
  entity: string;
}

export interface MenuAction {
  type: 'menu.action';
  action: string;
  event: string;
  param?: string;
  entity: string;
  x: number;
  y: number;
}

export type DaemonEvent = ContextMenuRequest | MenuAction;

export type EventHandler = (ev: DaemonEvent, ws: WebSocket) => void | Promise<void>;

/**
 * Attach a persistent listener that forwards daemon push-events (have `type`,
 * no `id`) to `handler`. Returns a detach function.
 */
export function attachEventListener(ws: WebSocket, handler: EventHandler): () => void {
  const onMessage = (data: WebSocket.RawData): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // not JSON — ignore
    }
    if (
      msg !== null &&
      typeof msg === 'object' &&
      typeof (msg as { type?: unknown }).type === 'string' &&
      (msg as { id?: unknown }).id === undefined
    ) {
      void handler(msg as DaemonEvent, ws);
    }
  };
  ws.on('message', onMessage);
  return () => ws.off('message', onMessage);
}
