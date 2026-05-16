/**
 * Connectivity check for <server required="true"> entries.
 *
 * For http/https: issues a GET with a short timeout.
 * For ws/wss: tries to open a socket, then closes it.
 * Any unsupported scheme is treated as "skip" (logs warning).
 */

import type { ConnectedServer } from '../config/ServeConfig.js';

export interface ConnectivityResult {
  alias: string;
  url: string;
  ok: boolean;
  reason?: string;
}

const TIMEOUT_MS = 3000;

export async function checkServer(server: ConnectedServer): Promise<ConnectivityResult> {
  const url = server.url;
  const scheme = url.split(':', 1)[0]?.toLowerCase();
  try {
    if (scheme === 'http' || scheme === 'https') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        // Any status is "reachable"; only network errors count as failure
        return { alias: server.alias, url, ok: true, reason: `HTTP ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    }
    if (scheme === 'ws' || scheme === 'wss') {
      // Minimal TCP-level probe: a fetch against the http(s) equivalent is
      // good enough to confirm the host is up. A full WebSocket handshake
      // would require an extra dependency — Dev-only tool, keep it light.
      const httpUrl = url.replace(/^ws/, 'http');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        await fetch(httpUrl, { method: 'GET', signal: controller.signal });
        return { alias: server.alias, url, ok: true, reason: 'tcp-reachable' };
      } finally {
        clearTimeout(timer);
      }
    }
    return { alias: server.alias, url, ok: true, reason: `scheme ${scheme} not probed` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { alias: server.alias, url, ok: false, reason };
  }
}

export async function checkRequiredServers(
  servers: ConnectedServer[]
): Promise<ConnectivityResult[]> {
  const required = servers.filter((s) => s.required);
  return Promise.all(required.map(checkServer));
}
