import { describe, it, expect } from 'vitest';
import { applyOp, getNestedField } from '../src/gtest/verdict.js';

describe('applyOp', () => {
  it('eq / ne compare as strings', () => {
    expect(applyOp('eq', 5, 5)).toBe(true);
    expect(applyOp('eq', '5', 5)).toBe(true);
    expect(applyOp('ne', 5, 6)).toBe(true);
  });
  it('numeric comparators coerce', () => {
    expect(applyOp('lt', 3, 5)).toBe(true);
    expect(applyOp('lte', 5, 5)).toBe(true);
    expect(applyOp('gt', 9, 5)).toBe(true);
    expect(applyOp('gte', 5, 9)).toBe(false);
  });
  it('contains does substring', () => {
    expect(applyOp('contains', 'playing now', 'play')).toBe(true);
    expect(applyOp('contains', 'idle', 'play')).toBe(false);
  });
  it('exists checks presence', () => {
    expect(applyOp('exists', 0, undefined)).toBe(true);
    expect(applyOp('exists', null, undefined)).toBe(false);
    expect(applyOp('exists', undefined, undefined)).toBe(false);
  });
});

describe('getNestedField', () => {
  it('resolves dotted paths', () => {
    expect(getNestedField({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
  });
  it('returns undefined on a missing hop', () => {
    expect(getNestedField({ a: 1 }, 'a.b')).toBeUndefined();
  });
});
