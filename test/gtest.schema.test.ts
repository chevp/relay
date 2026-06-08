import { describe, it, expect } from 'vitest';
import { parseGTest, GTestParseError } from '../src/gtest/schema.js';

const MINIMAL = `
kind: "gtest/1"
name: smoke
stages:
  - name: Start
    wait: 100
    screenshot:
      camera: { posX: 0, posY: 4, posZ: 0.01, rotX: -90, fov: 55 }
`;

const WITH_ASSERTS = `
kind: "gtest/1"
name: asserted
scene: "../iris.xml"
stages:
  - name: Board
    init: "App.dispatch('start')"
    wait: 500
    screenshot:
      out: board.png
      camera: { posX: 0, posY: 6, posZ: 0.01, rotX: -90 }
      baseline: baselines/board.png
      tolerance: 0.02
    assert:
      sceneLoaded: true
      entityCount: 12
      entities: [PlayerSpawn, Board]
      state:
        - { query: getEntity, args: { id: Snake }, path: transform.position.x, equals: 0 }
`;

describe('parseGTest', () => {
  it('parses a minimal screenshot-only suite (the in-the-wild shape)', () => {
    const g = parseGTest(MINIMAL, '/tmp/smoke.gtest');
    expect(g.kind).toBe('gtest/1');
    expect(g.name).toBe('smoke');
    expect(g.stages).toHaveLength(1);
    expect(g.stages[0].wait).toBe(100);
    expect(g.stages[0].screenshot?.camera).toMatchObject({ posX: 0, posY: 4, rotX: -90, fov: 55 });
    expect(g.stages[0].assert).toBeUndefined();
  });

  it('parses engine-state + pixel asserts', () => {
    const g = parseGTest(WITH_ASSERTS, '/tmp/a.gtest');
    expect(g.scene).toBe('../iris.xml');
    const s = g.stages[0];
    expect(s.init).toBe("App.dispatch('start')");
    expect(s.screenshot?.baseline).toBe('baselines/board.png');
    expect(s.screenshot?.tolerance).toBe(0.02);
    expect(s.assert?.sceneLoaded).toBe(true);
    expect(s.assert?.entityCount).toBe(12);
    expect(s.assert?.entities).toEqual(['PlayerSpawn', 'Board']);
    expect(s.assert?.state?.[0]).toMatchObject({ query: 'getEntity', path: 'transform.position.x', equals: 0 });
  });

  it('rejects a non-gtest kind', () => {
    expect(() => parseGTest('kind: "flow/1"\nname: x\nstages: [{name: a}]', '/tmp/x.gtest'))
      .toThrowError(GTestParseError);
  });

  it('rejects an empty stages list', () => {
    expect(() => parseGTest('kind: "gtest/1"\nname: x\nstages: []', '/tmp/x.gtest'))
      .toThrowError(/non-empty/);
  });

  it('rejects a stage without a name', () => {
    expect(() => parseGTest('kind: "gtest/1"\nname: x\nstages:\n  - wait: 1', '/tmp/x.gtest'))
      .toThrowError(/stage.name/);
  });

  it('rejects an out-of-range tolerance', () => {
    const bad = 'kind: "gtest/1"\nname: x\nstages:\n  - name: a\n    screenshot:\n      camera: { posX: 0, posY: 0, posZ: 0 }\n      baseline: b.png\n      tolerance: 5';
    expect(() => parseGTest(bad, '/tmp/x.gtest')).toThrowError(/tolerance/);
  });

  it('requires equals or exists on a state assert', () => {
    const bad = 'kind: "gtest/1"\nname: x\nstages:\n  - name: a\n    assert:\n      state:\n        - { query: getEntity }';
    expect(() => parseGTest(bad, '/tmp/x.gtest')).toThrowError(/equals.*exists|exists.*equals/);
  });

  it('reports the source line on error', () => {
    try {
      parseGTest('kind: "gtest/1"\nname: x\nstages:\n  - name: a\n    wait: -5', '/tmp/x.gtest');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GTestParseError);
      expect((e as GTestParseError).line).toBe(4);
    }
  });
});
