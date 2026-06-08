import { describe, it, expect } from 'vitest';
import { parseDescriptor, GtestParseError } from '../src/gtest/schema.js';

const FULL = `
kind: "gtest/1"
name: snake-e2e
scene: "../iris.xml"
server: "http://127.0.0.1:8080"
db: "./world.db"
stages:
  - name: Start
    init: "App.dispatch('start')"
    wait: 500
    screenshot:
      camera: { posX: 0, posY: 6, posZ: 0.01, rotX: -90, fov: 45 }
      size: { width: 640, height: 480 }
    setup:
      server:
        - { method: POST, path: /reset }
    assert:
      db:
        - { table: score, column: value, where: "id=1", op: eq, value: 0 }
      server:
        - { path: /state, field: phase, op: eq, value: playing }
`;

describe('parseDescriptor', () => {
  it('parses a full E2E descriptor', () => {
    const d = parseDescriptor(FULL);
    expect(d.kind).toBe('gtest/1');
    expect(d.server).toBe('http://127.0.0.1:8080');
    expect(d.db).toBe('./world.db');
    expect(d.stages).toHaveLength(1);
    const s = d.stages[0];
    expect(s.init).toBe("App.dispatch('start')");
    expect(s.screenshot?.camera.posY).toBe(6);
    expect(s.setup?.server?.[0]).toMatchObject({ method: 'POST', path: '/reset' });
    expect(s.assert?.db?.[0]).toMatchObject({ table: 'score', column: 'value', op: 'eq', value: 0 });
    expect(s.assert?.server?.[0]).toMatchObject({ path: '/state', field: 'phase', op: 'eq', value: 'playing' });
  });

  it('parses a minimal screenshot-only stage (the snake.gtest shape)', () => {
    const d = parseDescriptor(`kind: "gtest/1"\nname: smoke\nstages:\n  - name: s\n    wait: 100\n    screenshot:\n      camera: { posX: 0, posY: 4, posZ: 0.01, rotX: -90, fov: 55 }`);
    expect(d.stages[0].assert).toBeUndefined();
    expect(d.stages[0].screenshot?.camera.fov).toBe(55);
  });

  it('rejects an empty stages list', () => {
    expect(() => parseDescriptor('kind: "gtest/1"\nname: x\nstages: []')).toThrowError(GtestParseError);
  });

  it('rejects a stage without a name', () => {
    expect(() => parseDescriptor('kind: "gtest/1"\nname: x\nstages:\n  - wait: 1')).toThrowError(/missing "name"/);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseDescriptor('kind: "gtest/1"\n  : : :')).toThrowError(GtestParseError);
  });
});
