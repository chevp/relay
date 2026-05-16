/**
 * Discovery payload builder — produces the /discover.json response body.
 *
 * The renderer receives a single discovery URL and reads this document to
 * learn about (a) statically mounted content roots and (b) connected domain
 * servers (game-server, persistence, marketplace, ...).
 */

import type { ServeConfig } from '../config/ServeConfig.js';

export interface DiscoveryStaticEntry {
  url: string;
  alias: string;
}

export interface DiscoveryServerEntry {
  url: string;
  kind: string;
  required: boolean;
}

export interface DiscoveryDocument {
  nunaServe: { version: string; host: string; port: number };
  static: Record<string, DiscoveryStaticEntry>;
  servers: Record<string, DiscoveryServerEntry>;
  sources: Record<string, string>;
}

export function buildDiscovery(
  config: ServeConfig,
  version: string,
  publicHost: string
): DiscoveryDocument {
  const staticEntries: Record<string, DiscoveryStaticEntry> = {};
  for (const r of config.staticRoots) {
    staticEntries[r.alias] = {
      url: `http://${publicHost}:${config.port}${r.mount}`,
      alias: r.alias,
    };
  }
  const servers: Record<string, DiscoveryServerEntry> = {};
  for (const s of config.servers) {
    servers[s.alias] = { url: s.url, kind: s.kind, required: s.required };
  }
  const sources: Record<string, string> = {};
  for (const m of config.sources) {
    sources[m.alias] = m.ref;
  }
  return {
    nunaServe: { version, host: publicHost, port: config.port },
    static: staticEntries,
    servers,
    sources,
  };
}
