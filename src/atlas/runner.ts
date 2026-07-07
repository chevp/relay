/**
 * `.atlas` sheet runner — headless, in relay.
 *
 * Ported from the kosmos container (container/src/atlas.ts). Renders each view
 * through irisd, then packs the frames into one `atlas.png` sprite-sheet.
 * The container composited with Electron's `nativeImage`; relay has no Electron,
 * so compositing uses jimp (pure JS — decode JPEG, resize, blit, encode PNG).
 * Output layout: `.kosmos/atlas/<key>/` with one `<base62-id>.jpg` per view
 * (the id is random, not the view name — cached output, so no name conflicts
 * across `.atlas` files or across regenerations), `atlas.png`, and run.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { Jimp } from 'jimp';
import type { ChildProcess } from 'node:child_process';
import { spawnPreview } from '../preview/launcher.js';
import { PreviewClient } from '../preview/client.js';
import type {
  AtlasDescriptor, AtlasLayout, AtlasOutput, AtlasRun, AtlasSubImage, AtlasView,
  ModelAtlasEntry, ShotCamera, ShotResult,
} from '../workflows/types.js';

/** irisd setBackground payload derived from a descriptor's `render.background`. */
interface BackgroundRequest {
  transparent: boolean;
  r: number; g: number; b: number; // 0..1, used only when !transparent
}

/**
 * Resolve `render.background` to an irisd setBackground request, or null to
 * leave the engine default (gray). "transparent" ⇒ RGBA/PNG capture with alpha 0;
 * "#rgb"/"#rrggbb" ⇒ opaque solid clear color.
 */
function resolveBackground(bg?: string): BackgroundRequest | null {
  if (!bg) return null;
  const s = bg.trim().toLowerCase();
  if (s === 'transparent') return { transparent: true, r: 0, g: 0, b: 0 };
  let h = s.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) {
    const n = Number.parseInt(h, 16);
    if (!Number.isNaN(n)) {
      return { transparent: false, r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }
  }
  return null; // unparseable ⇒ leave engine default
}

const ATLAS_PORT = 9700;
const MODEL_ATLAS_PORT = 9710; // distinct from ATLAS_PORT — one irisd per model
const SETTLE_MS = 600;
// IBL cubemap convolution (irradiance + prefiltered mip chain) runs on the GPU
// after the WebSocket connects. Capturing before it completes produces a dark,
// IBL-free frame. This one-time warmup fires after connection, before any view.
const IBL_WARMUP_MS = 1200;
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

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A short random base62 id for a per-view frame filename — collision-safe
 *  across `.atlas` files without encoding the view name (it's cached output). */
function base62Id(len = 10): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[bytes[i] % 62];
  return s;
}

/** True for a multi-source `model-atlas/1` (different model per cell). */
function isModelAtlas(d: AtlasDescriptor): boolean {
  return d.kind === 'model-atlas/1' || Array.isArray(d.models);
}

function readDescriptor(descriptorPath: string): AtlasDescriptor {
  let parsed: AtlasDescriptor;
  try {
    parsed = parseYaml(fs.readFileSync(descriptorPath, 'utf-8')) as AtlasDescriptor;
  } catch (err) {
    throw new Error(`invalid .atlas.yaml: ${(err as Error).message}`);
  }
  if (isModelAtlas(parsed)) {
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) {
      throw new Error('model-atlas needs a non-empty "models" array');
    }
    const seen = new Set<string>();
    for (const m of parsed.models) {
      if (!m?.id) throw new Error('each model needs an "id"');
      if (!m.source) throw new Error(`model "${m.id}" needs a "source" path`);
      if (seen.has(m.id)) throw new Error(`duplicate model id: ${m.id}`);
      seen.add(m.id);
    }
    return parsed;
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
  sheetBgFallback: Rgba,
): Promise<{ png: Buffer } & Omit<AtlasOutput, 'file'>> {
  const count = frames.length;
  const cols = Math.max(1, layout?.columns ?? Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const pad = Math.max(0, Math.floor(layout?.padding ?? 0));
  const cellW = Math.max(1, Math.floor(layout?.cell?.width ?? fallbackCell.width));
  const cellH = Math.max(1, Math.floor(layout?.cell?.height ?? fallbackCell.height));
  const W = cols * cellW + (cols + 1) * pad;
  const H = rows * cellH + (rows + 1) * pad;

  // Sheet fill: explicit layout.background wins; otherwise inherit the render
  // background (transparent stays transparent so the whole atlas.png has alpha).
  const sheetBg = layout?.background ? parseColor(layout.background) : sheetBgFallback;
  const sheet = new Jimp({ width: W, height: H, color: rgbaInt(sheetBg) });

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
      reject(new Error('irisd did not come up in time'));
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

  // Multi-source model-atlas takes a separate path: a fresh scene (one model,
  // auto-framed) per cell rather than one scene rendered from N cameras.
  if (isModelAtlas(descriptor)) {
    try {
      return await runModelAtlas(descriptorPath, workspaceRoot, descriptor, onProgress);
    } finally {
      runningKey = null;
    }
  }

  const cacheDir = atlasCacheDir(descriptorPath, workspaceRoot);
  fs.mkdirSync(cacheDir, { recursive: true });

  const background = resolveBackground(descriptor.render?.background);
  // Transparent frames are streamed as PNG (alpha); opaque as JPEG — name the
  // per-view frame file to match its actual bytes.
  const frameExt = background?.transparent ? 'png' : 'jpg';

  // Frame filenames are random base62 ids (not the view name), so a re-run
  // never overwrites in place — clear the previous run's frames first. Delete
  // both extensions but never the packed sheet (atlas.png).
  for (const f of fs.readdirSync(cacheDir)) {
    if (f === 'atlas.png') continue;
    if (f.endsWith('.jpg') || f.endsWith('.png')) {
      try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* best-effort */ }
    }
  }
  // Past the model-atlas branch, readDescriptor guarantees scene + views.
  const sceneRel = descriptor.scene as string;
  const views = descriptor.views as NonNullable<AtlasDescriptor['views']>;
  const scene = path.resolve(path.dirname(descriptorPath), sceneRel);

  const run: AtlasRun = {
    descriptor: descriptorPath,
    scene: sceneRel,
    size: descriptor.size,
    render: descriptor.render,
    layout: descriptor.layout,
    startedAt: new Date().toISOString(),
    status: 'running',
    views: views.map<ShotResult>((s) => ({ name: s.name, status: 'queued' })),
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
  const frames: (Buffer | null)[] = views.map(() => null);

  try {
    const child = spawnPreview(scene, { port: ATLAS_PORT, fps: 4, width: descriptor.size?.width, height: descriptor.size?.height });
    activeChild = child;
    child.on('exit', (code) => {
      if (activeChild === child) activeChild = null;
      onExitReject?.(new Error(`irisd exited before rendering (code ${code ?? '?'}) — check ~/.iris/logs/irisd.log`));
    });
    client.connect(`ws://127.0.0.1:${ATLAS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      onExitReject = reject;
      waitConnected(client, CONNECT_TIMEOUT_MS).then(resolve, reject);
    }).finally(() => { onExitReject = null; });

    // Apply the render background before the first capture. Transparent flips
    // irisd to PNG (RGBA) frames; a solid color just changes the clear color.
    if (background) {
      try {
        await client.call('setBackground', {
          transparent: background.transparent,
          r: background.r, g: background.g, b: background.b,
        });
      } catch { /* older irisd without setBackground — fall back to default gray */ }
    }

    // Wait for IBL cubemap convolution to finish before capturing any views.
    await wait(IBL_WARMUP_MS);

    for (let i = 0; i < views.length; i++) {
      const spec = views[i];
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
        const file = path.join(cacheDir, `${base62Id()}.${frameExt}`);
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
        // Transparent render ⇒ transparent sheet by default; else the viewer gray.
        const sheetBgFallback: Rgba = background?.transparent ? { r: 0, g: 0, b: 0, a: 0 } : { ...DEFAULT_BG };
        const { png, ...geom } = await composeAtlas(ok, descriptor.layout, fallbackCell, sheetBgFallback);
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

// ── model-atlas/1 (multi-source) ─────────────────────────────────────────────
// Each cell is a DIFFERENT model, referenced by an absolute source path (never
// copied). Per model we generate a one-entity scene (auto-framed into the unit
// cube from the glTF bounding box), spawn a fresh irisd, capture one frame, then
// pack the frames + write a sub-image manifest (id → rect + uv + source). The
// packed sheet is also published beside the descriptor for the scene to consume.

const MODEL_IBL_WARMUP_MS = 1500;
const MODEL_CONNECT_TIMEOUT_MS = 45_000;
const MODEL_FRAME_TIMEOUT_MS = 12_000;

/** Resolve the shaders dir the generated per-model iris.xml points at. */
function shaderDirFor(descriptorPath: string): string {
  // iris-examples ship shaders at <examples>/../runtime/shaders; the descriptor
  // lives in <examples>/<example>/. Walk up two levels + runtime/shaders.
  return path.resolve(path.dirname(descriptorPath), '../../runtime/shaders');
}
const toFileUri = (p: string): string => 'file://' + p.replace(/\\/g, '/');

// glTF/GLB bounding box from POSITION accessor min/max + node transforms (no .bin).
function readGltfJson(src: string): Record<string, unknown> {
  const buf = fs.readFileSync(src);
  if (src.toLowerCase().endsWith('.glb')) {
    if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('bad glb magic');
    const jsonLen = buf.readUInt32LE(12);
    return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf-8'));
  }
  return JSON.parse(buf.toString('utf-8'));
}
type Mat4 = number[];
const matIdentity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function matMul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0) as Mat4;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function matFromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function xformPoint(m: Mat4, p: number[]): number[] {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
interface Bounds { center: number[]; maxDim: number }
function computeGltfBounds(src: string): Bounds | null {
  const g = readGltfJson(src) as {
    nodes?: { mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] }[];
    meshes?: { primitives?: { attributes?: { POSITION?: number } }[] }[];
    accessors?: { min?: number[]; max?: number[] }[];
    scenes?: { nodes?: number[] }[];
    scene?: number;
  };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  const visit = (idx: number, parent: Mat4): void => {
    const n = g.nodes?.[idx];
    if (!n) return;
    const world = matMul(parent, n.matrix ? n.matrix : matFromTRS(n.translation, n.rotation, n.scale));
    if (n.mesh !== undefined && g.meshes?.[n.mesh]) {
      for (const prim of g.meshes[n.mesh].primitives ?? []) {
        const acc = g.accessors?.[prim.attributes?.POSITION ?? -1];
        if (!acc?.min || !acc?.max) continue;
        const [ax, ay, az] = acc.min, [bx, by, bz] = acc.max;
        for (const corner of [[ax, ay, az], [bx, ay, az], [ax, by, az], [ax, ay, bz],
          [bx, by, az], [bx, ay, bz], [ax, by, bz], [bx, by, bz]]) {
          const wpt = xformPoint(world, corner);
          for (let i = 0; i < 3; i++) { if (wpt[i] < min[i]) min[i] = wpt[i]; if (wpt[i] > max[i]) max[i] = wpt[i]; }
          found = true;
        }
      }
    }
    for (const c of n.children ?? []) visit(c, world);
  };
  const scene = g.scenes?.[g.scene ?? 0];
  for (const r of scene?.nodes ?? []) visit(r, matIdentity());
  if (!found) return null;
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const maxDim = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  return { center, maxDim };
}

/** Generate a one-entity scene (auto-normalized) + a mini iris.xml for a model. */
function writeModelCellScene(
  model: ModelAtlasEntry,
  sharedCamera: ShotCamera | undefined,
  scenesDir: string,
  shaderDir: string,
): { xmlFile: string; camera: ShotCamera } {
  const cam = { ...(sharedCamera ?? {}), ...(model.camera ?? {}) } as ShotCamera;
  const src = path.resolve(model.source);
  const srcDir = path.dirname(src);
  const base = path.basename(src);

  let scale = [model.scale ?? 1, model.scale ?? 1, model.scale ?? 1];
  let position = [0, 0, 0];
  if (model.normalize !== false && model.scale === undefined) {
    try {
      const b = computeGltfBounds(src);
      if (b) {
        const s = 1 / b.maxDim;
        scale = [s, s, s];
        position = b.center.map((c) => -c * s);
      }
    } catch { /* fall back to identity framing */ }
  }

  const scene = {
    version: '1.0',
    scene: {
      id: `cell_${model.id}`,
      metadata: { name: model.id, author: 'chevp', source: src.replace(/\\/g, '/') },
      camera: {
        type: 'perspective', fov: cam.fov ?? 45, znear: 0.01, zfar: 1000.0,
        position: [cam.posX ?? 0, cam.posY ?? 0, cam.posZ ?? 3],
        rotation: [cam.rotX ?? 0, cam.rotY ?? 0, cam.rotZ ?? 0],
      },
      entities: [{ id: model.id, assetRef: `asset://${base}`, position, rotation: [0, 0, 0], scale }],
    },
  };
  const sceneFile = path.join(scenesDir, `${model.id}.scene.json`);
  fs.writeFileSync(sceneFile, JSON.stringify(scene, null, 2));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<synth version="1.0" author="chevp" xmlns="https://chevp.github.io/synth-protocol/schema/synth/1.0">
<runtime-renderer version="1.0">
    <metadata><name>atlas-cell ${model.id}</name><client>iris-examples</client></metadata>
    <paths>
        <asset-root uri="${toFileUri(srcDir)}/"/>
        <shader-dir uri="${toFileUri(shaderDir)}"/>
        <log-dir    uri="${toFileUri(path.join(scenesDir, 'log'))}"/>
    </paths>
    <scene uri="${toFileUri(sceneFile)}"/>
</runtime-renderer>
</synth>`;
  const xmlFile = path.join(scenesDir, `${model.id}.xml`);
  fs.writeFileSync(xmlFile, xml);
  return { xmlFile, camera: cam };
}

/** Spawn one irisd for a single generated scene, capture one frame, tear down. */
async function renderOneModel(
  xmlFile: string,
  camera: ShotCamera,
  size: { width?: number; height?: number } | undefined,
): Promise<Buffer> {
  const client = new PreviewClient();
  activeClient = client;
  client.on('connected', () => { client.startStream({ fps: 4 }).catch(() => { /* best-effort */ }); });

  let onExitReject: ((e: Error) => void) | null = null;
  const child = spawnPreview(xmlFile, { port: MODEL_ATLAS_PORT, fps: 4, width: size?.width, height: size?.height });
  activeChild = child;
  child.on('exit', (code) => {
    if (activeChild === child) activeChild = null;
    onExitReject?.(new Error(`irisd exited before capture (code ${code ?? '?'}) — check ~/.iris/logs/irisd.log`));
  });
  try {
    client.connect(`ws://127.0.0.1:${MODEL_ATLAS_PORT}`);
    await new Promise<void>((resolve, reject) => {
      onExitReject = reject;
      waitConnected(client, MODEL_CONNECT_TIMEOUT_MS).then(resolve, reject);
    }).finally(() => { onExitReject = null; });
    await wait(MODEL_IBL_WARMUP_MS);
    await client.call('setCamera', {
      posX: camera.posX ?? 0, posY: camera.posY ?? 0, posZ: camera.posZ ?? 3,
      rotX: camera.rotX ?? 0, rotY: camera.rotY ?? 0, rotZ: camera.rotZ ?? 0,
      ...(camera.fov !== undefined ? { fov: camera.fov } : {}),
    });
    await wait(SETTLE_MS);
    return await nextFrame(client, MODEL_FRAME_TIMEOUT_MS);
  } finally {
    tearDownPreview();
  }
}

/** Center-crop a frame to a square (avoids 16:9 → cell squash), then it's packed. */
async function centerSquare(buf: Buffer): Promise<Buffer> {
  const img = await Jimp.read(buf);
  const side = Math.min(img.width, img.height);
  img.crop({ x: Math.floor((img.width - side) / 2), y: Math.floor((img.height - side) / 2), w: side, h: side });
  return img.getBuffer('image/png');
}

async function runModelAtlas(
  descriptorPath: string,
  workspaceRoot: string,
  descriptor: AtlasDescriptor,
  onProgress?: (run: AtlasRun) => void,
): Promise<AtlasRun> {
  const models = descriptor.models ?? [];
  const cacheDir = atlasCacheDir(descriptorPath, workspaceRoot);
  const scenesDir = path.join(cacheDir, 'scenes');
  fs.rmSync(scenesDir, { recursive: true, force: true });
  fs.mkdirSync(scenesDir, { recursive: true });
  for (const f of fs.readdirSync(cacheDir)) {
    if (f === 'atlas.png') continue;
    if (f.endsWith('.jpg') || f.endsWith('.png')) { try { fs.unlinkSync(path.join(cacheDir, f)); } catch { /* best-effort */ } }
  }
  const shaderDir = shaderDirFor(descriptorPath);
  const size = descriptor.size ?? { width: DEFAULT_CELL, height: DEFAULT_CELL };

  const run: AtlasRun = {
    descriptor: descriptorPath,
    scene: `${models.length} models`,
    size: descriptor.size,
    layout: descriptor.layout,
    startedAt: new Date().toISOString(),
    status: 'running',
    views: models.map<ShotResult>((m) => ({ name: m.id, status: 'queued' })),
  };
  const persist = (): void => {
    try { fs.writeFileSync(path.join(cacheDir, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* best-effort */ }
    onProgress?.(run);
  };
  persist();

  const frames: (Buffer | null)[] = models.map(() => null);
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const result = run.views[i];
    result.status = 'running';
    persist();
    const startedAt = Date.now();
    try {
      if (!fs.existsSync(path.resolve(model.source))) throw new Error('source not found');
      const { xmlFile, camera } = writeModelCellScene(model, descriptor.camera, scenesDir, shaderDir);
      const frame = await renderOneModel(xmlFile, camera, size);
      const file = path.join(cacheDir, `${model.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.jpg`);
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
    await wait(400); // let the port free up before the next irisd
  }

  // Compose the sheet + build the sub-image manifest.
  const ok = frames.filter((f): f is Buffer => f !== null);
  if (ok.length === 0) {
    run.status = 'failed';
    run.error = 'no models rendered — nothing to pack into an atlas';
  } else {
    try {
      const squared = await Promise.all(ok.map((f) => centerSquare(f)));
      const fallbackCell = { width: size.width ?? DEFAULT_CELL, height: size.height ?? DEFAULT_CELL };
      const { png, ...geom } = await composeAtlas(squared, descriptor.layout, fallbackCell, { ...DEFAULT_BG });
      const file = path.join(cacheDir, 'atlas.png');
      fs.writeFileSync(file, png);
      run.atlas = { file, ...geom };
      run.subImages = buildManifest(models, run.views, geom, descriptor.layout);
      writeAndPublishManifest(descriptorPath, cacheDir, run, geom, descriptor.layout);
      run.status = run.views.some((v) => v.status === 'failed') ? 'failed' : 'done';
    } catch (err) {
      run.status = 'failed';
      run.error = `atlas compositing failed: ${(err as Error).message}`;
    }
  }

  run.finishedAt = new Date().toISOString();
  persist();
  return run;
}

/** id → pixel rect + normalized UV rect + source, in packed (grid) order. */
function buildManifest(
  models: ModelAtlasEntry[],
  views: ShotResult[],
  geom: Omit<AtlasOutput, 'file'>,
  layout: AtlasLayout | undefined,
): AtlasSubImage[] {
  const pad = Math.max(0, Math.floor(layout?.padding ?? 0));
  const { columns: cols, cell, width: W, height: H } = geom;
  return models.map((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cell.width + pad);
    const y = pad + row * (cell.height + pad);
    return {
      id: m.id, index: i, col, row,
      rect: { x, y, w: cell.width, h: cell.height },
      uv: { u0: x / W, v0: y / H, u1: (x + cell.width) / W, v1: (y + cell.height) / H },
      source: path.resolve(m.source).replace(/\\/g, '/'),
      status: views[i]?.status ?? 'failed',
      ms: views[i]?.ms,
      error: views[i]?.error,
    };
  });
}

/** Write atlas.json into the cache AND publish atlas.png + atlas.json beside the
 *  descriptor (assets/atlas/objects/) — the shipped pair the scene consumes. */
function writeAndPublishManifest(
  descriptorPath: string,
  cacheDir: string,
  run: AtlasRun,
  geom: Omit<AtlasOutput, 'file'>,
  layout: AtlasLayout | undefined,
): void {
  const manifest = {
    kind: 'model-atlas-manifest/1',
    generatedFrom: path.basename(descriptorPath),
    atlas: {
      file: 'atlas.png',
      width: geom.width, height: geom.height, columns: geom.columns, rows: geom.rows,
      cell: geom.cell, padding: Math.max(0, Math.floor(layout?.padding ?? 0)),
      background: layout?.background ?? '#0b0d10',
    },
    subImages: run.subImages ?? [],
  };
  try { fs.writeFileSync(path.join(cacheDir, 'atlas.json'), JSON.stringify(manifest, null, 2)); } catch { /* best-effort */ }
  try {
    const publishDir = path.join(path.dirname(descriptorPath), 'assets', 'atlas', 'objects');
    fs.mkdirSync(publishDir, { recursive: true });
    if (run.atlas?.file) fs.copyFileSync(run.atlas.file, path.join(publishDir, 'atlas.png'));
    fs.writeFileSync(path.join(publishDir, 'atlas.json'), JSON.stringify(manifest, null, 2));
  } catch { /* publishing is best-effort — the cache copy is the source of truth */ }
}
