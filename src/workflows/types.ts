/**
 * Workflow descriptor + run-record types for the relay-hosted runners
 * (.shots / .atlas / .flow), mirrored verbatim from the kosmos container
 * (container/src/types.ts) so the run.json relay writes is read unchanged by
 * the container UI. Keep these in sync with the container definitions.
 */

// ─── camera / views (shared by .shots and .atlas) ───────────────────────────

export interface ShotCamera {
  posX: number; posY: number; posZ: number;
  rotX?: number; rotY?: number; rotZ?: number;
  fov?: number;
}

export interface ViewSpec {
  name: string;
  label?: string;
  description?: string;
  camera: ShotCamera;
}

export type ShotStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ShotResult {
  name: string;
  status: ShotStatus;
  ms?: number;
  file?: string;
  error?: string;
  playerLog?: string[];
}

// ─── .shots ──────────────────────────────────────────────────────────────────

export interface ShotsDescriptor {
  kind?: string;
  scene: string;
  size?: { width: number; height: number };
  views: ViewSpec[];
}

export interface ShotsRun {
  descriptor: string;
  scene: string;
  size?: { width: number; height: number };
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  views: ShotResult[];
}

export interface ShotsView {
  descriptorPath: string;
  descriptor: ShotsDescriptor;
  run: ShotsRun | null;
  cacheDir: string;
}

// ─── .atlas ──────────────────────────────────────────────────────────────────

export interface AtlasLayout {
  columns?: number;
  cell?: { width: number; height: number };
  padding?: number;
  // Sheet/gutter fill behind the packed cells. Defaults to the render
  // background when transparent, else the viewer gray. "transparent" | "#rrggbb".
  background?: string;
}

// Per-view RENDER background — what irisd clears the scene to before capture.
// "transparent" renders onto alpha 0 and streams RGBA/PNG (ADR-0014 alpha path);
// "#rrggbb" clears to that opaque color. Omitted ⇒ the engine's default gray.
export interface AtlasRender {
  background?: string;
}

export interface AtlasDescriptor {
  kind?: string;
  scene?: string;
  size?: { width: number; height: number };
  render?: AtlasRender;
  layout?: AtlasLayout;
  views?: ViewSpec[];
  // ─ model-atlas/1 (multi-source): each cell is a DIFFERENT model instead of a
  //   camera angle. `camera` is the shared framing pose; `models` list the cells.
  camera?: ShotCamera;
  models?: ModelAtlasEntry[];
}

/** One cell of a `model-atlas/1`: a model from an absolute source, auto-framed. */
export interface ModelAtlasEntry {
  id: string;
  /** Absolute path to a .gltf/.glb (never copied; sibling files resolved beside it). */
  source: string;
  /** Optional per-model camera override (merged over the shared `camera`). */
  camera?: ShotCamera;
  /** Explicit uniform scale (disables auto-normalize). */
  scale?: number;
  /** Set false to keep the model's native scale/pivot (skip auto-normalize). */
  normalize?: boolean;
}

/** A sub-image in the packed sheet — id → pixel rect + UV rect + source. */
export interface AtlasSubImage {
  id: string;
  index: number;
  col: number;
  row: number;
  rect: { x: number; y: number; w: number; h: number };
  uv: { u0: number; v0: number; u1: number; v1: number };
  source: string;
  status: ShotStatus;
  ms?: number;
  error?: string;
}

export interface AtlasOutput {
  file: string;
  width: number;
  height: number;
  columns: number;
  rows: number;
  cell: { width: number; height: number };
}

export interface AtlasRun {
  descriptor: string;
  scene: string;
  size?: { width: number; height: number };
  render?: AtlasRender;
  layout?: AtlasLayout;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  views: ShotResult[];
  atlas?: AtlasOutput;
  /** model-atlas/1 only: the sub-image manifest packed into the sheet. */
  subImages?: AtlasSubImage[];
  error?: string;
}

export interface AtlasView {
  descriptorPath: string;
  descriptor: AtlasDescriptor;
  run: AtlasRun | null;
  cacheDir: string;
}

// ─── .flow ─────────────────────────────────────────────────────────────────

export type FlowRunner = 'iris-preview' | 'docker' | 'ollama' | 'shell';

export interface FlowStep {
  name?: string;
  uses: FlowRunner;
  with?: Record<string, unknown>;
}

export interface FlowJob {
  id: string;
  name?: string;
  needs?: string[];
  steps: FlowStep[];
}

export interface FlowDescriptor {
  kind?: string;
  name?: string;
  jobs: FlowJob[];
}

export type FlowStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepResult {
  name: string;
  uses: FlowRunner;
  status: FlowStatus;
  ms?: number;
  log: string[];
  outputs?: Record<string, string>;
  error?: string;
}

export interface JobResult {
  id: string;
  name: string;
  status: FlowStatus;
  ms?: number;
  steps: StepResult[];
}

export interface FlowRun {
  descriptor: string;
  name: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  jobs: JobResult[];
}
