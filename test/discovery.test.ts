import { describe, it, expect } from 'vitest';
import { buildDiscovery } from '../src/discovery/discover.js';
import type { ServeConfig } from '../src/config/ServeConfig.js';

const config: ServeConfig = {
  host: '0.0.0.0',
  port: 3001,
  staticRoots: [
    { alias: 'game', path: '/games/x', mount: '/games/current/v-dev/', optional: false },
    { alias: 'kit', path: '/kit', mount: '/kit/v-dev/', optional: false },
  ],
  servers: [
    { alias: 'gs', url: 'ws://localhost:8080/ws', kind: 'gameplay', required: true },
  ],
  sources: [
    { alias: 'first-party', ref: 'static:kit' },
    { alias: 'game', ref: 'static:game' },
  ],
  configPath: '/tmp/nuna-serve.xml',
};

describe('buildDiscovery', () => {
  it('emits all sections', () => {
    const d = buildDiscovery(config, '0.1.0', 'localhost');
    expect(d.nunaServe).toEqual({ version: '0.1.0', host: 'localhost', port: 3001 });
    expect(d.static.game.url).toBe('http://localhost:3001/games/current/v-dev/');
    expect(d.static.kit.url).toBe('http://localhost:3001/kit/v-dev/');
    expect(d.servers.gs).toEqual({
      url: 'ws://localhost:8080/ws',
      kind: 'gameplay',
      required: true,
    });
    expect(d.sources).toEqual({
      'first-party': 'static:kit',
      game: 'static:game',
    });
  });
});
