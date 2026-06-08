/**
 * Process registry / supervisor for the relay daemon.
 *
 * The daemon (dockerd analogue) does not run engine work itself — it spawns and
 * tracks child processes (iris-player / iris-preview / irisproc) and can reap
 * them all on shutdown. This is the lightweight "shim table": one entry per
 * supervised child, with enough to report `ps` and tear down on exit.
 *
 * Pure bookkeeping + lifecycle — no WS, no spawning policy — so it is
 * unit-testable in isolation.
 */

import type { ChildProcess } from 'node:child_process';

export type ChildKind = 'player' | 'preview' | 'irisproc' | 'other';
export type ChildStatus = 'running' | 'exited';

export interface ChildInfo {
  id: string;
  kind: ChildKind;
  port?: number;
  pid?: number;
  status: ChildStatus;
  exitCode?: number | null;
  startedAt: string;
}

interface Entry {
  info: ChildInfo;
  process: ChildProcess;
}

export class ProcessRegistry {
  private entries = new Map<string, Entry>();
  private seq = 0;

  /** Register a spawned child. `now` is injected so callers stay deterministic. */
  register(proc: ChildProcess, kind: ChildKind, opts: { port?: number; now: string; id?: string }): ChildInfo {
    const id = opts.id ?? `${kind}-${++this.seq}`;
    const info: ChildInfo = {
      id, kind, port: opts.port, pid: proc.pid,
      status: 'running', startedAt: opts.now,
    };
    this.entries.set(id, { info, process: proc });
    proc.once('exit', (code) => {
      const e = this.entries.get(id);
      if (e) { e.info.status = 'exited'; e.info.exitCode = code; }
    });
    return info;
  }

  get(id: string): ChildInfo | undefined {
    return this.entries.get(id)?.info;
  }

  /** Snapshot of every tracked child (running + recently exited). */
  list(): ChildInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  running(): ChildInfo[] {
    return this.list().filter((c) => c.status === 'running');
  }

  /** Kill one child; returns whether it was found + still running. */
  kill(id: string): boolean {
    const e = this.entries.get(id);
    if (!e || e.info.status !== 'running') return false;
    try { e.process.kill(); } catch { /* ignore */ }
    return true;
  }

  /** Reap every running child (called on daemon shutdown). */
  killAll(): void {
    for (const e of this.entries.values()) {
      if (e.info.status === 'running') {
        try { e.process.kill(); } catch { /* ignore */ }
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
