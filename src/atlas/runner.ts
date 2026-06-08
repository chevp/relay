/**
 * `.atlas` sheet runner — headless, in relay.
 *
 * Ported from the kosmos container (container/src/atlas.ts). Renders each view
 * through iris-preview, then packs the frames into one `atlas.png` sprite-sheet.
 * The container composited with Electron's `nativeImage`; relay has no Electron,
 * so compositing uses jimp (pure JS — decode JPEG, resize, blit, encode PNG).
 * Output layout is unchanged: `.kosmos/atlas/<key>/` with `<view>.jpg`,
 * `atlas.png`, and run.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Jimp } from 'jimp';
import type { ChildProcess } from 'node:child_process';
import { spawnPreview } from '../preview/launcher.js';
import { PreviewClient } from '../preview/client.js';
import type { AtlasDescriptor, AtlasLayout, AtlasOutput, AtlasRun, AtlasView, ShotResult } from '../workflows/types.js';

const ATLAS_PORT = 9700;
const SETTLE_MS = 600;
const FRAME_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 40_000;
const DEFAULT_CELL = 256;
const DEFAULT_BG = { r: 11, g: 13, b: 16, a: 255 };

let activeChild: ChildProcess | null = null;
let activeClient: PreviewClient | null = null;
let runningKey: string | null = null;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function atlasKey(descriptorPath: string, workspaceRoot: string): string {
  let rel = path.relative(workspaceRoot, descriptorPath);
  if (!rel || rel.startsWith('..')) rel = path.basename(descriptorPath);
  return rel
    .replace(/\.atlas\.yaml$|\.atlas$/i, '')
    .replace(/[\\/]/g, '__')
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function atlasCacheDir(descriptorPath: string, workspaceRoot: string): string {
  return path.join(workspaceRoot, '.kosmos', 'atlas', atlasKey(descriptorPath, workspaceRoot));
}

function readDescriptor(descriptorPath: string): AtlasDescriptor {
  let parsed: AtlasDescriptor;
  try {
    parsed = parseYaml(fs.readFileSync(descriptorPath, 'utf-8')) as AtlasDescriptor;
  } catch (err) {
    throw new Error(`invalid .atlas.yaml: ${(err as Error).message}`);
  }
  if (!parsed.scene) throw new Error('.atlas is missing "scene"');
  if (!Array.isArray(parsed.views) || parsed.views.length === 0) {
    throw new Error('.atlas needs a non-empty "views" array');
  }
  return parsed;
}

function readRunRecord(cacheDir: string): AtlasRun | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'run.json'), 'utf-8')) as AtlasRun;
  } catch {
    return null;
  }
}

export function readAtlasRun(descriptorPath: string, workspaceRoot: string): AtlasView {
  const cacheDir = atlasCacheDir(descriptorPath, workspaceRoot);
  return { descriptorPath, descriptor: readDescriptor(descriptorPath), cacheDir, run: readRunRecord(cacheDir) };
}

// ── Compositing (jimp) ─────────────────────────────────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }

function parseColor(s?: string): Rgba {
  if (!s) return { ...DEFAULT_BG };
  if (s.trim().toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let h = s.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) {
    const n = Number.parseInt(h, 16);
    if (!Number.isNaN(n)) return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
  }
  return { ...DEFAULT_BG };
}

/** jimp colours are 0xRRGGBBAA integers. */
function rgbaInt(c: Rgba): number {
  return ((c.r << 24) | (c.g << 16) | (c.b << 8) | c.a) >>> 0;
}

async function composeAtlas(
  frames: Buffer[],
  layout: AtlasLayout | undefined,
  fallbackCell: { width: number; height: number },
): Promise<{ png: Buffer } & Omit<AtlasOutput, 'file'>> {
  const count = frames.length;
  const cols = Math.max(1, layout?.columns ?? Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const pad = Math.max(0, Math.floor(layout?.padding ?? 0));
  const cellW = Math.max(1, Math.floor(layout?.cell?.width ?? fallbackCell.width));
  const cellH = Math.max(1, Math.floor(layout?.cell?.height ?? fallbackCell.height));
  const W = cols * cellW + (cols + 1) * pad;
  const H = rows * cellH + (rows + 1) * pad;

  const sheet = new Jimp({ width: W, height: H, color: rgbaInt(parseColor(layout?.background)) });

  for (let idx = 0; idx < frames.length; idx++) {
    let img;
    try { img = await Jimp.read(frames[idx]); } catch { continue; } // a bad frame leaves its cell as background
    img.resize({ w: cellW, h: cellH });
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x0 = pad + col * (cellW + pad);
    const y0 = pad + row * (cellH + pad);
    sheet.composite(img, x0, y0);
  }

  const png = await sheet.getBuffer('image/png');
  return { png, width: W, height: H, columns: cols, rows, cell: { width: cellW, height: cellH } };
}

// ── preview helpers ────────────────────────────────────────────────────────

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

function tearDownPreview(): void {
  if (activeClient) { try { activeClient.disconnect(); } catch { /* ignore */ } activeClient = null; }
  if (activeChild) { try { activeChild.kill(); } catch { /* ignore */ } activeChild = null; }
}

export function killActiveAtlas(): void {
  tearDownPreview();
  runningKey = null;
}

export async function runAtlas(
  descriptorPath: string,
  workspaceRoot: string,
  onProgress?: (run: AtlasRun) => void,
): Promise<AtlasRun> {
  const key = atlasKey(descriptorPath, workspaceRoot);
  if (runningKey) throw new Error('a render is already running');
  runningKey = key;

  const descriptor = readDescriptor(descriptorPath);
  const cacheDir = atlasCacheDir(descriptorPath, workspaceRoot);
  fs.mkdirSync(cacheDir, { recursive: true });
  const scene = path.resolve(path.dirname(descriptorPath), descriptor.scene);

  const run: AtlasRun = {
    descriptor: descriptorPath,
    scene: descriptor.scene,
    size: descriptor.size,
    layout: descriptor.layout,
    startedAt: new Date().toISOString(),
    status: 'running',
    views: descriptor.views.map<ShotResult>((s) => ({ name: s.name, status: 'queued' })),
  };

  const persist = (): void => {
    try { fs.writeFileSync(path.join(cacheDir, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* best-effort */ }
    onProgress?.(run);
  };
  persist();

  const client = new PreviewClient();
  activeClient = client;
  client.on('connected', () => { client.startStream({ fps: 4 }).catch(() => { /* best-effort */ }); });

  let onExitReject: ((e: Error) => void) | null = null;
  const frames: (Buffer | null)[] = descriptor.views.map(() => null);

  try {
    const child = spawnPreview(scene, { port: ATLAS_PORT, fps: 4, width: descriptor.size?.width, height: descriptor.size?.height });
    activeChild = child;
    child.on('exit', (code) => {
      if (activeChild === child) activeChild = null;
      onExitReject?.(new Error(`iris-preview exited before rendering (code ${code ?? '?'}) — see iris-preview.log`));
    });
    client.connect(`ws://127.0.0.1:${ATLAS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      onExitReject = reject;
      waitConnected(client, CONNECT_TIMEOUT_MS).then(resolve, reject);
    }).finally(() => { onExitReject = null; });

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
        frames[i] = frame;
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
  } catch (err) {
    run.status = 'failed';
    run.error = (err as Error).message;
    for (const v of run.views) {
      if (v.status === 'queued' || v.status === 'running') {
        v.status = 'failed';
        v.error = v.error ?? (err as Error).message;
      }
    }
  } finally {
    tearDownPreview();
  }

  if (run.status !== 'failed') {
    const ok = frames.filter((f): f is Buffer => f !== null);
    if (ok.length === 0) {
      run.status = 'failed';
      run.error = 'no views rendered — nothing to pack into an atlas';
    } else {
      try {
        const fallbackCell = { width: descriptor.size?.width ?? DEFAULT_CELL, height: descriptor.size?.height ?? DEFAULT_CELL };
        const { png, ...geom } = await composeAtlas(ok, descriptor.layout, fallbackCell);
        const file = path.join(cacheDir, 'atlas.png');
        fs.writeFileSync(file, png);
        run.atlas = { file, ...geom };
        run.status = run.views.some((v) => v.status === 'failed') ? 'failed' : 'done';
      } catch (err) {
        run.status = 'failed';
        run.error = `atlas compositing failed: ${(err as Error).message}`;
      }
    }
  }

  run.finishedAt = new Date().toISOString();
  persist();
  runningKey = null;
  return run;
}
