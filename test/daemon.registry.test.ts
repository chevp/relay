import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ProcessRegistry } from '../src/daemon/registry.js';

/** Minimal ChildProcess stand-in: an emitter with pid + a kill spy. */
function fakeChild(pid: number): ChildProcess & { killed: boolean } {
  const ee = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: () => boolean };
  ee.pid = pid;
  ee.killed = false;
  ee.kill = (): boolean => { ee.killed = true; return true; };
  return ee as unknown as ChildProcess & { killed: boolean };
}

const NOW = '2026-06-08T00:00:00.000Z';

describe('ProcessRegistry', () => {
  it('registers and lists children', () => {
    const r = new ProcessRegistry();
    const info = r.register(fakeChild(101), 'player', { port: 9876, now: NOW });
    expect(info.kind).toBe('player');
    expect(info.pid).toBe(101);
    expect(info.status).toBe('running');
    expect(r.list()).toHaveLength(1);
    expect(r.running()).toHaveLength(1);
  });

  it('flips status to exited on the child exit event', () => {
    const r = new ProcessRegistry();
    const child = fakeChild(102);
    const info = r.register(child, 'preview', { port: 9200, now: NOW });
    (child as unknown as EventEmitter).emit('exit', 0);
    expect(r.get(info.id)?.status).toBe('exited');
    expect(r.get(info.id)?.exitCode).toBe(0);
    expect(r.running()).toHaveLength(0);
  });

  it('kills a running child and reports it', () => {
    const r = new ProcessRegistry();
    const child = fakeChild(103);
    const info = r.register(child, 'player', { now: NOW });
    expect(r.kill(info.id)).toBe(true);
    expect((child as unknown as { killed: boolean }).killed).toBe(true);
    expect(r.kill('does-not-exist')).toBe(false);
  });

  it('killAll reaps every running child', () => {
    const r = new ProcessRegistry();
    const a = fakeChild(1); const b = fakeChild(2);
    r.register(a, 'player', { now: NOW });
    r.register(b, 'irisproc', { now: NOW });
    r.killAll();
    expect((a as unknown as { killed: boolean }).killed).toBe(true);
    expect((b as unknown as { killed: boolean }).killed).toBe(true);
  });
});
