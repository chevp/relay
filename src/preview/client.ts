/**
 * WebSocket client to irisd's preview/stream daemon (PreviewDaemon.cpp).
 *
 * Ported from the container's preview client so relay can drive irisd
 * headlessly (gtest screenshots, render pipelines) without the Electron shell.
 *
 * JSON-RPC 2.0 (apps/irisdaemon/protocol/iris-api.md):
 *   - TEXT   → `{ jsonrpc, id, result }` / `{ jsonrpc, id, error: {code, message} }` responses to call()
 *   - BINARY → a complete JPEG of one rendered frame (emitted on `'frame'`)
 * Unsolicited JSON events (a `type` field, no `id`) are emitted on `'event'`.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

interface DaemonResponse { id: string; result?: unknown; error?: { code: number; message: string }; }
interface PendingCall { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

export interface StreamOptions { fps?: number; quality?: number; }

export class PreviewClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private uri: string | null = null;
  private pending = new Map<string, PendingCall>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionallyClosed = false;

  connect(uri: string): void {
    if (this.uri === uri && this.isConnected()) return;
    this.disconnect();
    this.uri = uri;
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch { /* ignore */ }
    }
    this.failPending(new Error('preview disconnected'));
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async startStream(opts: StreamOptions = {}): Promise<unknown> {
    return this.call('iris.stream.start', { ...opts });
  }

  async call(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`preview daemon not connected (uri=${this.uri ?? 'none'})`);
    }
    const id = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`preview call timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = { jsonrpc: '2.0', id, method, params: params ?? {} };
      ws.send(JSON.stringify(payload));
    });
  }

  private openSocket(): void {
    if (!this.uri) return;
    const ws = new WebSocket(this.uri);
    this.ws = ws;

    ws.on('open', () => { this.emit('connected'); });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
        this.emit('frame', buf);
        return;
      }
      let msg: unknown;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const m = msg as Record<string, unknown>;
      if (typeof m.id === 'string' && this.pending.has(m.id)) {
        this.completeCall(m as unknown as DaemonResponse);
        return;
      }
      if (typeof m.type === 'string') this.emit('event', m);
    });

    ws.on('close', () => {
      const wasIntentional = this.intentionallyClosed;
      this.ws = null;
      this.failPending(new Error('preview connection closed'));
      if (!wasIntentional) { this.emit('disconnected'); this.scheduleReconnect(); }
    });

    ws.on('error', (err) => { this.emit('disconnected', err.message); });
  }

  private completeCall(msg: DaemonResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? 'preview call failed'));
    else p.resolve(msg.result);
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.intentionallyClosed) return;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.openSocket(); }, 1_000);
  }
}
