/**
 * `.shots` render runner — headless, in relay.
 *
 * Ported from the kosmos container (container/src/preview/shots.ts) so render
 * runs no longer require the Electron shell. A `.shots` descriptor names a scene
 * + a list of named camera views; each is rendered headlessly through
 * iris-preview and written as `<view>.jpg` to the project-local
 * `.kosmos/renders/<key>/` cache, alongside a run.json — the same layout the
 * container reads via readShotsRun.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChildProcess } from 'node:child_process';
import { spawnPreview } from '../preview/launcher.js';
import { PreviewClient } from '../preview/client.js';
import type { ShotsDescriptor, ShotsRun, ShotResult, ShotsView, ViewSpec } from '../workflows/types.js';

const SHOTS_PORT = 9300;
const SETTLE_MS = 600;
const IBL_WARMUP_MS = 1200;
const FRAME_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 40_000;

let activeChild: ChildProcess | null = null;
let activeClient: PreviewClient | null = null;
let runningKey: string | null = null;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function shotsKey(descriptorPath: string, workspaceRoot: string): string {
  let rel = path.relative(workspaceRoot, descriptorPath);
  if (!rel || rel.startsWith('..')) rel = path.basename(descriptorPath);
  return rel
    .replace(/\.shots\.yaml$/i, '')
    .replace(/\.shots$/i, '')
    .replace(/[\\/]/g, '__')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function shotsCacheDir(descriptorPath: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, '.kosmos', 'renders', shotsKey(descriptorPath, workspaceRoot));
}

function readDescriptor(descriptorPath: string): ShotsDescriptor {
  const raw = fs.readFileSync(descriptorPath, 'utf-8');
  const lower = descriptorPath.toLowerCase();
  const isYaml = lower.endsWith('.shots.yaml') || lower.endsWith('.shots');
  let parsed: Record<string, unknown>;
  try {
    parsed = (isYaml ? parseYaml(raw) : JSON.parse(raw)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid .shots descriptor: ${(err as Error).message}`);
  }
  if (!parsed.scene) throw new Error('.shots descriptor is missing "scene"');
  const views = (parsed.views ?? parsed.shots) as ViewSpec[] | undefined;
  if (!Array.isArray(views) || views.length === 0) {
    throw new Error('.shots descriptor needs a non-empty "views" array');
  }
  return { ...parsed, views } as ShotsDescriptor;
}

function readRunRecord(cacheDir: string): ShotsRun | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'run.json'), 'utf-8')) as ShotsRun;
  } catch {
    return null;
  }
}

export function readShotsRun(descriptorPath: string, workspaceRoot: string): ShotsView {
  return {
    descriptorPath,
    descriptor: readDescriptor(descriptorPath),
    cacheDir: shotsCacheDir(descriptorPath, workspaceRoot),
    run: readRunRecord(shotsCacheDir(descriptorPath, workspaceRoot)),
  };
}

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

function waitConnected(client: PreviewClient, timeoutMs: number): Promise<void> {
  if (client.isConnected()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnected = (): void => { clearTimeout(timer); client.off('connected', onConnected); resolve(); };
    const timer = setTimeout(() => {
      client.off('connected', onConnected);
      reject(new Error('iris-preview did not come up in time'));
    }, timeoutMs);
    client.on('connected', onConnected);
  });
}

function tearDown(): void {
  if (activeClient) { try { activeClient.disconnect(); } catch { /* ignore */ } activeClient = null; }
  if (activeChild) { try { activeChild.kill(); } catch { /* ignore */ } activeChild = null; }
  runningKey = null;
}

export function killActiveShots(): void {
  tearDown();
}

export async function runShots(
  descriptorPath: string,
  workspaceRoot: string,
  onProgress?: (run: ShotsRun) => void,
): Promise<ShotsRun> {
  const key = shotsKey(descriptorPath, workspaceRoot);
  if (runningKey) throw new Error('a render is already running');
  runningKey = key;

  const descriptor = readDescriptor(descriptorPath);
  const cacheDir = shotsCacheDir(descriptorPath, workspaceRoot);
  fs.mkdirSync(cacheDir, { recursive: true });
  const scene = path.resolve(path.dirname(descriptorPath), descriptor.scene);

  const run: ShotsRun = {
    descriptor: descriptorPath,
    scene: descriptor.scene,
    size: descriptor.size,
    startedAt: new Date().toISOString(),
    status: 'running',
    views: descriptor.views.map<ShotResult>((v) => ({ name: v.name, status: 'queued' })),
  };

  const persist = (): void => {
    try { fs.writeFileSync(path.join(cacheDir, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* best-effort */ }
    onProgress?.(run);
  };
  persist();

  const client = new PreviewClient();
  activeClient = client;
  client.on('connected', () => {
    client.call('disableOverlay').catch(() => { /* best-effort */ });
    client.startStream({ fps: 4 }).catch(() => { /* best-effort */ });
  });

  let onExitReject: ((e: Error) => void) | null = null;

  try {
    const child = spawnPreview(scene, { port: SHOTS_PORT, fps: 4, width: descriptor.size?.width, height: descriptor.size?.height });
    activeChild = child;
    child.on('exit', (code) => {
      if (activeChild === child) activeChild = null;
      onExitReject?.(new Error(`iris-preview exited before rendering (code ${code ?? '?'}) — see iris-preview.log`));
    });
    client.connect(`ws://127.0.0.1:${SHOTS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      onExitReject = reject;
      waitConnected(client, CONNECT_TIMEOUT_MS).then(resolve, reject);
    }).finally(() => { onExitReject = null; });

    await wait(IBL_WARMUP_MS);

    for (let i = 0; i < descriptor.views.length; i++) {
      const spec = descriptor.views[i];
      const result = run.views[i];
      result.status = 'running';
      persist();
      const startedAt = Date.now();
      try {
        await client.call('setCamera', {
          posX: spec.camera.posX, posY: spec.camera.posY, posZ: spec.camera.posZ,
          rotX: spec.camera.rotX ?? 0, rotY: spec.camera.rotY ?? 0, rotZ: spec.camera.rotZ ?? 0,
          ...(spec.camera.fov !== undefined ? { fov: spec.camera.fov } : {}),
        });
        await wait(SETTLE_MS);
        const frame = await nextFrame(client, FRAME_TIMEOUT_MS);
        const file = path.join(cacheDir, `${spec.name}.jpg`);
        fs.writeFileSync(file, frame);
        result.status = 'done';
        result.ms = Date.now() - startedAt;
        result.file = file;
      } catch (err) {
        result.status = 'failed';
        result.ms = Date.now() - startedAt;
        result.error = (err as Error).message;
      }
      persist();
    }

    run.status = run.views.some((v) => v.status === 'failed') ? 'failed' : 'done';
  } catch (err) {
    run.status = 'failed';
    for (const s of run.views) {
      if (s.status === 'queued' || s.status === 'running') {
        s.status = 'failed';
        s.error = s.error ?? (err as Error).message;
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    persist();
    tearDown();
  }

  return run;
}
