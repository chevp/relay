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
  background?: string;
}

export interface AtlasDescriptor {
  kind?: string;
  scene: string;
  size?: { width: number; height: number };
  layout?: AtlasLayout;
  views: ViewSpec[];
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
  layout?: AtlasLayout;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed';
  views: ShotResult[];
  atlas?: AtlasOutput;
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
