import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPath, valuesEqual, comparePixels } from '../src/gtest/verdict.js';

describe('getPath', () => {
  it('resolves a dotted path', () => {
    expect(getPath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns the whole object for an empty path', () => {
    const o = { x: 1 };
    expect(getPath(o, undefined)).toBe(o);
  });
  it('returns undefined when a hop is missing', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
});

describe('valuesEqual', () => {
  it('compares primitives', () => {
    expect(valuesEqual(12, 12)).toBe(true);
    expect(valuesEqual(12, 13)).toBe(false);
    expect(valuesEqual(true, true)).toBe(true);
  });
  it('compares nested structures', () => {
    expect(valuesEqual({ p: { x: 0, y: 5 } }, { p: { x: 0, y: 5 } })).toBe(true);
    expect(valuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(valuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe('comparePixels (exact)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtest-px-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('passes on identical bytes', async () => {
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    await fs.writeFile(a, Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(b, Buffer.from([1, 2, 3, 4]));
    const r = await comparePixels(a, b, 0);
    expect(r.pass).toBe(true);
  });

  it('fails on differing bytes', async () => {
    const a = path.join(dir, 'a2.png');
    const b = path.join(dir, 'b2.png');
    await fs.writeFile(a, Buffer.from([1, 2, 3, 4]));
    await fs.writeFile(b, Buffer.from([9, 9, 9, 9]));
    const r = await comparePixels(a, b, 0);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/mismatch/);
  });

  it('fails clearly when the baseline is missing', async () => {
    const a = path.join(dir, 'a3.png');
    await fs.writeFile(a, Buffer.from([1]));
    const r = await comparePixels(a, path.join(dir, 'nope.png'), 0);
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/baseline not found/);
  });
});
