/**
 * `.gtest` runner — end-to-end game-state tests, headless, in relay.
 *
 * Ported from the kosmos container (container/src/gtest.ts) so test runs no
 * longer require the Electron shell. Each stage boots irisd headlessly,
 * runs server setup, executes the stage `init` snippet, positions the camera,
 * settles, captures a JPEG, then checks DB (SQLite) and server (HTTP)
 * assertions. relay setup/assertions need a live connected player and are
 * reported "deferred" in V1 — identical to the container's behaviour.
 *
 * DB assertions use better-sqlite3 (a relay dependency) instead of the
 * container's sql.js. Output layout is unchanged: `.kosmos/gtest/<key>/run.json`
 * + per-stage JPEG frames, so the container UI reads relay-produced runs as-is.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { spawnPreview } from '../preview/launcher.js';
import { PreviewClient } from '../preview/client.js';
import { loadDescriptorSync, type GtestDescriptor, type GtestStage, type Camera } from './schema.js';
import {
  applyOp, getNestedField,
  type GtestAssertResult, type GtestRun, type GtestStageResult,
} from './verdict.js';

const GTEST_PREVIEW_PORT = 9500;
const SETTLE_MS = 600;
const FRAME_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 40_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let runningKey: string | null = null;
let activeClient: PreviewClient | null = null;
const activeChildren = new Set<import('node:child_process').ChildProcess>();

/** A stable cache key from the descriptor path relative to the workspace. */
export function gtestKey(descriptorPath: string, workspaceRoot: string): string {
  let rel = path.relative(workspaceRoot, descriptorPath);
  if (!rel || rel.startsWith('..')) rel = path.basename(descriptorPath);
  return rel
    .replace(/\.gtest$/i, '')
    .replace(/[\\/]/g, '__')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function gtestCacheDir(descriptorPath: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, '.kosmos', 'gtest', gtestKey(descriptorPath, workspaceRoot));
}

// ── Assertions ───────────────────────────────────────────────────────────────

function runDbAssertions(
  asserts: NonNullable<GtestStage['assert']>['db'],
  dbPath: string,
  log: (l: string) => void,
): GtestAssertResult[] {
  const results: GtestAssertResult[] = [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    for (const a of asserts ?? []) {
      const label = `db: ${a.table}.${a.column}${a.where ? ` WHERE ${a.where}` : ''} ${a.op} ${a.value ?? ''}`.trim();
      try {
        const where = a.where ? ` WHERE ${a.where}` : '';
        const actual = db.prepare(`SELECT ${a.column} FROM ${a.table}${where} LIMIT 1`).pluck().get() ?? null;
        const passed = applyOp(a.op, actual, a.value);
        log(`  ${passed ? 'PASS' : 'FAIL'} ${label} → got ${JSON.stringify(actual)}`);
        results.push({ label, passed, actual, expected: a.value });
      } catch (err) {
        log(`  ERROR ${label}: ${(err as Error).message}`);
        results.push({ label, passed: false, error: (err as Error).message });
      }
    }
  } catch (err) {
    log(`  DB open failed: ${(err as Error).message}`);
    for (const a of asserts ?? []) {
      results.push({ label: `db: ${a.table}.${a.column}`, passed: false, error: (err as Error).message });
    }
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  return results;
}

async function runServerAssertions(
  asserts: NonNullable<GtestStage['assert']>['server'],
  serverBase: string,
  log: (l: string) => void,
): Promise<GtestAssertResult[]> {
  const results: GtestAssertResult[] = [];
  for (const a of asserts ?? []) {
    const url = `${serverBase.replace(/\/$/, '')}${a.path}`;
    const label = `server: GET ${a.path}${a.field ? ` → ${a.field}` : ''} ${a.op} ${a.value ?? ''}`.trim();
    try {
      log(`  GET ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: unknown = await res.json();
      const actual = a.field ? getNestedField(json, a.field) : json;
      const passed = applyOp(a.op, actual, a.value);
      log(`  ${passed ? 'PASS' : 'FAIL'} ${label} → got ${JSON.stringify(actual)}`);
      results.push({ label, passed, actual, expected: a.value });
    } catch (err) {
      log(`  ERROR ${label}: ${(err as Error).message}`);
      results.push({ label, passed: false, error: (err as Error).message });
    }
  }
  return results;
}

async function runServerSetup(
  actions: NonNullable<NonNullable<GtestStage['setup']>['server']>,
  serverBase: string,
  log: (l: string) => void,
): Promise<void> {
  for (const a of actions) {
    const url = `${serverBase.replace(/\/$/, '')}${a.path}`;
    const method = (a.method ?? 'POST').toUpperCase();
    log(`  ${method} ${url}`);
    const res = await fetch(url, {
      method,
      headers: a.body ? { 'content-type': 'application/json' } : {},
      body: a.body ? JSON.stringify(a.body) : undefined,
    }).catch((err: Error) => { throw new Error(`server setup ${method} ${a.path} failed: ${err.message}`); });
    if (!res.ok) throw new Error(`server setup ${method} ${a.path}: HTTP ${res.status}`);
    log(`  ${res.status} OK`);
  }
}

// ── irisd helpers ──────────────────────────────────────────────────────

function nextFrame(client: PreviewClient, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onFrame = (buf: Buffer): void => { clearTimeout(timer); client.off('frame', onFrame); resolve(buf); };
    const timer = setTimeout(() => {
      client.off('frame', onFrame);
      reject(new Error(`frame did not arrive within ${timeoutMs}ms`));
    }, timeoutMs);
    client.on('frame', onFrame);
  });
}

function waitConnected(client: PreviewClient, timeoutMs: number, exited: () => Error | null): Promise<void> {
  if (client.isConnected()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnected = (): void => { clearTimeout(timer); clearInterval(poll); client.off('connected', onConnected); resolve(); };
    const fail = (e: Error): void => { clearTimeout(timer); clearInterval(poll); client.off('connected', onConnected); reject(e); };
    const timer = setTimeout(() => fail(new Error('irisd did not come up in time')), timeoutMs);
    const poll = setInterval(() => { const e = exited(); if (e) fail(e); }, 250);
    client.on('connected', onConnected);
  });
}

// ── Stage execution ──────────────────────────────────────────────────────────

async function runStage(
  stage: GtestStage,
  stageIndex: number,
  descriptor: GtestDescriptor,
  cacheDir: string,
  descriptorDir: string,
  log: (l: string) => void,
): Promise<{ screenshot?: string; asserts: GtestAssertResult[] }> {
  const scenePath = path.resolve(descriptorDir, stage.scene ?? descriptor.scene ?? 'iris.xml');
  const asserts: GtestAssertResult[] = [];

  // ── relay setup (deferred — needs live player) ──
  for (const a of stage.setup?.relay ?? []) {
    asserts.push({
      label: `relay setup: ${a.cmd}${a.id ? ` ${a.id}` : ''}`,
      passed: false,
      error: 'relay setup requires a live connected iris-player (not supported in headless run)',
    });
  }

  // ── server setup ──
  const serverActions = stage.setup?.server ?? [];
  if (serverActions.length && descriptor.server) {
    log('  server setup…');
    await runServerSetup(serverActions, descriptor.server, log);
  } else if (serverActions.length) {
    log('  server setup: no "server" base URL in descriptor — skipped');
  }

  // ── screenshot ──
  let screenshot: string | undefined;
  if (stage.screenshot) {
    log(`  boot irisd headless · ${path.basename(scenePath)}`);
    const size = stage.screenshot.size;
    const child = spawnPreview(scenePath, { port: GTEST_PREVIEW_PORT, fps: 4, width: size?.width, height: size?.height });
    activeChildren.add(child);
    let exited: Error | null = null;
    child.on('exit', (code) => {
      activeChildren.delete(child);
      exited = new Error(`irisd exited (code ${code ?? '?'}) — check ~/.iris/logs/irisd.log`);
    });

    const client = new PreviewClient();
    activeClient = client;
    client.on('connected', () => {
      client.call('disableOverlay').catch(() => { /* best-effort */ });
      client.startStream({ fps: 4 }).catch(() => { /* best-effort */ });
    });

    try {
      client.connect(`ws://127.0.0.1:${GTEST_PREVIEW_PORT}`);
      await waitConnected(client, CONNECT_TIMEOUT_MS, () => exited);

      if (stage.init) {
        log(`  execScript: ${stage.init}`);
        await client.call('execScript', { snippet: stage.init, chunkName: stage.name });
      }

      const cam: Camera = stage.screenshot.camera;
      log(`  setCamera ${Object.entries(cam).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
      await client.call('setCamera', {
        posX: cam.posX, posY: cam.posY, posZ: cam.posZ,
        rotX: cam.rotX ?? 0, rotY: cam.rotY ?? 0, rotZ: cam.rotZ ?? 0,
        ...(cam.fov !== undefined ? { fov: cam.fov } : {}),
      });

      const waitMs = stage.wait ?? 0;
      if (waitMs > 0) { log(`  wait ${waitMs}ms`); await wait(waitMs); }
      await wait(SETTLE_MS);

      const frame = await nextFrame(client, FRAME_TIMEOUT_MS);
      const file = `stage_${String(stageIndex).padStart(2, '0')}_${stage.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`;
      fs.writeFileSync(path.join(cacheDir, file), frame);
      screenshot = file;
      log(`  wrote ${file}`);
    } finally {
      try { client.disconnect(); } catch { /* ignore */ }
      activeClient = null;
      try { child.kill(); } catch { /* ignore */ }
      activeChildren.delete(child);
    }
  }

  // ── DB assertions ──
  const dbAsserts = stage.assert?.db ?? [];
  if (dbAsserts.length) {
    const dbPath = descriptor.db ? path.resolve(descriptorDir, descriptor.db) : null;
    if (dbPath && fs.existsSync(dbPath)) {
      log(`  DB assertions on ${path.basename(dbPath)}:`);
      asserts.push(...runDbAssertions(dbAsserts, dbPath, log));
    } else {
      const msg = dbPath ? `DB not found: ${dbPath}` : 'no "db" path in descriptor';
      log(`  DB assertions: ${msg}`);
      for (const a of dbAsserts) asserts.push({ label: `db: ${a.table}.${a.column}`, passed: false, error: msg });
    }
  }

  // ── server assertions ──
  const serverAsserts = stage.assert?.server ?? [];
  if (serverAsserts.length) {
    if (descriptor.server) {
      log(`  server assertions on ${descriptor.server}:`);
      asserts.push(...await runServerAssertions(serverAsserts, descriptor.server, log));
    } else {
      log('  server assertions: no "server" base URL in descriptor — skipped');
      for (const a of serverAsserts) asserts.push({ label: `server: ${a.path}`, passed: false, error: 'no "server" base URL in descriptor' });
    }
  }

  // ── relay assertions (deferred) ──
  for (const a of stage.assert?.relay ?? []) {
    asserts.push({
      label: `relay: ${a.entity}.${a.component}${a.field ? `.${a.field}` : ''} ${a.op} ${a.value}`,
      passed: false,
      error: 'relay assertions require a live connected iris-player (not supported in headless run)',
    });
  }

  return { screenshot, asserts };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function runGtest(
  descriptorPath: string,
  workspaceRoot: string,
  onProgress?: (run: GtestRun) => void,
): Promise<GtestRun> {
  const key = gtestKey(descriptorPath, workspaceRoot);
  if (runningKey) throw new Error('a gtest run is already in progress');
  runningKey = key;

  const descriptor = loadDescriptorSync(descriptorPath);
  const cacheDir = gtestCacheDir(descriptorPath, workspaceRoot);
  fs.mkdirSync(cacheDir, { recursive: true });
  const descriptorDir = path.dirname(descriptorPath);

  const run: GtestRun = {
    descriptor: descriptorPath,
    name: descriptor.name ?? path.basename(descriptorPath).replace(/\.(scenario|gtest)$/i, ''),
    startedAt: new Date().toISOString(),
    status: 'running',
    stages: descriptor.stages.map<GtestStageResult>((s) => ({ name: s.name, status: 'queued', asserts: [], log: [] })),
  };

  const persist = (): void => {
    try { fs.writeFileSync(path.join(cacheDir, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* best-effort */ }
    onProgress?.(run);
  };
  persist();

  try {
    for (let i = 0; i < descriptor.stages.length; i++) {
      const stage = descriptor.stages[i];
      const sr = run.stages[i];
      sr.status = 'running';
      persist();
      const stageStart = Date.now();
      const log = (line: string): void => { sr.log.push(line); persist(); };
      try {
        log(`stage: ${stage.name}`);
        const { screenshot, asserts } = await runStage(stage, i, descriptor, cacheDir, descriptorDir, log);
        sr.screenshot = screenshot;
        sr.asserts = asserts;
        sr.status = asserts.some((a) => !a.passed) ? 'failed' : 'done';
        sr.ms = Date.now() - stageStart;
      } catch (err) {
        sr.status = 'failed';
        sr.ms = Date.now() - stageStart;
        sr.error = (err as Error).message;
        sr.log.push(`ERROR ${sr.error}`);
      }
      persist();
    }
    run.status = run.stages.some((s) => s.status === 'failed') ? 'failed' : 'done';
  } catch (err) {
    run.status = 'failed';
    for (const sr of run.stages) {
      if (sr.status === 'queued' || sr.status === 'running') {
        sr.status = 'failed';
        if (!sr.log.length) sr.log.push((err as Error).message);
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    persist();
    teardown();
  }

  return run;
}

/** Kill any in-flight gtest children (called on daemon shutdown). */
export function killActiveGtest(): void {
  teardown();
}

function teardown(): void {
  if (activeClient) { try { activeClient.disconnect(); } catch { /* ignore */ } activeClient = null; }
  for (const child of activeChildren) { try { child.kill(); } catch { /* ignore */ } }
  activeChildren.clear();
  runningKey = null;
}
