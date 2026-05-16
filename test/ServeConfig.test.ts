import { describe, it, expect } from 'vitest';
import { parseServeConfigXml, defaultConfig } from '../src/config/ServeConfig.js';
import path from 'node:path';

const CONFIG_PATH = path.resolve('/tmp/nuna-serve.xml');

describe('parseServeConfigXml', () => {
  it('parses full config', () => {
    const xml = `<?xml version="1.0"?>
      <nuna-serve xmlns="https://nuna.dev/schemas/serve/v1" host="localhost" port="3001">
        <static>
          <root alias="game" path="." mount="/games/current/v-dev/"/>
          <root alias="mods" path="./mods" mount="/mods/" optional="true"/>
        </static>
        <servers>
          <server alias="gs" url="ws://localhost:8080/ws" kind="gameplay" required="true"/>
        </servers>
        <sources>
          <source alias="game" ref="static:game"/>
        </sources>
      </nuna-serve>`;
    const cfg = parseServeConfigXml(xml, CONFIG_PATH);
    expect(cfg.host).toBe('localhost');
    expect(cfg.port).toBe(3001);
    expect(cfg.staticRoots).toHaveLength(2);
    expect(cfg.staticRoots[0].alias).toBe('game');
    expect(cfg.staticRoots[0].mount).toBe('/games/current/v-dev/');
    expect(cfg.staticRoots[1].optional).toBe(true);
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].required).toBe(true);
    expect(cfg.sources).toEqual([{ alias: 'game', ref: 'static:game' }]);
  });

  it('normalizes mount paths', () => {
    const xml = `<nuna-serve xmlns="https://nuna.dev/schemas/serve/v1" host="localhost" port="3001">
      <static><root alias="k" path="/k" mount="kit"/></static>
    </nuna-serve>`;
    const cfg = parseServeConfigXml(xml, CONFIG_PATH);
    expect(cfg.staticRoots[0].mount).toBe('/kit/');
  });

  it('rejects invalid source ref', () => {
    const xml = `<nuna-serve xmlns="https://nuna.dev/schemas/serve/v1" host="localhost" port="3001">
      <sources><source alias="bad" ref="bogus:value"/></sources>
    </nuna-serve>`;
    expect(() => parseServeConfigXml(xml, CONFIG_PATH)).toThrow(/must start with/);
  });

  it('rejects missing root element', () => {
    expect(() => parseServeConfigXml('<other/>', CONFIG_PATH)).toThrow(/missing <nuna-serve>/);
  });

  it('rejects invalid port', () => {
    const xml = `<nuna-serve host="x" port="99999"/>`;
    expect(() => parseServeConfigXml(xml, CONFIG_PATH)).toThrow(/Invalid port/);
  });
});

describe('defaultConfig', () => {
  it('mounts cwd as game root plus assets and configs', () => {
    const cfg = defaultConfig('/work/nuna-game-sample');
    expect(cfg.staticRoots).toHaveLength(3);
    expect(cfg.staticRoots[0].alias).toBe('game');
    expect(cfg.staticRoots[0].path).toBe('/work/nuna-game-sample');
    expect(cfg.staticRoots[1].alias).toBe('assets');
    expect(cfg.staticRoots[1].optional).toBe(true);
    expect(cfg.staticRoots[2].alias).toBe('configs');
    expect(cfg.staticRoots[2].optional).toBe(true);
    expect(cfg.sources[0]).toEqual({ alias: 'game', ref: 'static:game' });
  });
});
