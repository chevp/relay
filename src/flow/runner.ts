/**
 * `.flow` job runner — headless DAG executor, in relay.
 *
 * Ported from the kosmos container (container/src/flow.ts). A `.flow` is a
 * GitHub-Actions-style YAML: a DAG of jobs (ordered by `needs`), each a sequence
 * of steps that `uses` a runner — iris-preview / docker / ollama / shell.
 * Artifacts + run.json land in `.kosmos/flows/<key>/`, the layout the container
 * reads via readFlowRun. All runners are process/HTTP based — no Electron.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { spawnPreview } from '../preview/launcher.js';
import { PreviewClient } from '../preview/client.js';
import { kosmosCacheDir } from '../paths.js';
import type { FlowDescriptor, FlowJob, FlowRun, FlowStep, JobResult, StepResult } from '../workflows/types.js';

const OLLAMA_GENERATE_URL = 'http://127.0.0.1:11434/api/generate';
const FLOW_PREVIEW_PORT = 9400;
const SETTLE_MS = 600;
const FRAME_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 40_000;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let runningKey: string | null = null;
const activeChildren = new Set<ChildProcess>();
let activeClient: PreviewClient | null = null;

export function flowKey(descriptorPath: string, workspaceRoot: string): string {
  let rel = path.relative(workspaceRoot, descriptorPath);
  if (!rel || rel.startsWith('..')) rel = path.basename(descriptorPath);
  return rel.replace(/\.flow$/i, '').replace(/[\\/]/g, '__').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export function flowCacheDir(descriptorPath: string, workspaceRoot: string): string {
  return kosmosCacheDir(workspaceRoot, 'flows', flowKey(descriptorPath, workspaceRoot));
}

function readDescriptor(descriptorPath: string): FlowDescriptor {
  let parsed: FlowDescriptor;
  try {
    parsed = parseYaml(fs.readFileSync(descriptorPath, 'utf-8')) as FlowDescriptor;
  } catch (err) {
    throw new Error(`invalid .flow YAML: ${(err as Error).message}`);
  }
  if (!parsed || !Array.isArray(parsed.jobs) || parsed.jobs.length === 0) {
    throw new Error('.flow needs a non-empty "jobs" list');
  }
  for (const job of parsed.jobs) {
    if (!job.id) throw new Error('.flow job is missing "id"');
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      throw new Error(`job "${job.id}" needs a non-empty "steps" list`);
    }
    // Normalize a scalar `needs: x` (common in authored flows) to a list, so
    // topoOrder doesn't iterate the string char-by-char.
    if (typeof job.needs === 'string') job.needs = [job.needs];
  }
  return parsed;
}

function readRunRecord(cacheDir: string): FlowRun | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'run.json'), 'utf-8')) as FlowRun;
  } catch {
    return null;
  }
}

export function readFlowRun(descriptorPath: string, workspaceRoot: string): {
  descriptorPath: string; descriptor: FlowDescriptor; run: FlowRun | null; cacheDir: string;
} {
  const cacheDir = flowCacheDir(descriptorPath, workspaceRoot);
  return { descriptorPath, descriptor: readDescriptor(descriptorPath), cacheDir, run: readRunRecord(cacheDir) };
}

// ── DAG ordering ────────────────────────────────────────────────────────────

function topoOrder(jobs: FlowJob[]): FlowJob[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const indeg = new Map(jobs.map((j) => [j.id, 0]));
  for (const j of jobs) {
    for (const need of j.needs ?? []) {
      if (!byId.has(need)) throw new Error(`job "${j.id}" needs unknown job "${need}"`);
      indeg.set(j.id, (indeg.get(j.id) ?? 0) + 1);
    }
  }
  const queue = jobs.filter((j) => (indeg.get(j.id) ?? 0) === 0);
  const order: FlowJob[] = [];
  while (queue.length) {
    const j = queue.shift()!;
    order.push(j);
    for (const other of jobs) {
      if ((other.needs ?? []).includes(j.id)) {
        const n = (indeg.get(other.id) ?? 0) - 1;
        indeg.set(other.id, n);
        if (n === 0) queue.push(other);
      }
    }
  }
  if (order.length !== jobs.length) throw new Error('jobs form a cycle (check "needs")');
  return order;
}

// ── Templating ──────────────────────────────────────────────────────────────

interface Ctx { cache: string; dir: string; workspace: string }

function subst<T>(value: T, ctx: Ctx): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
      if (key === 'cache') return ctx.cache;
      if (key === 'flow.dir') return ctx.dir;
      if (key === 'workspace') return ctx.workspace;
      return _m;
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => subst(v, ctx)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = subst(v, ctx);
    return out as unknown as T;
  }
  return value;
}

// ── Python resolution ──────────────────────────────────────────────────────

let _pythonExe: string | undefined;
async function resolvePython(): Promise<string> {
  if (_pythonExe) return _pythonExe;
  for (const candidate of ['python3', 'python']) {
    const probe = process.platform === 'win32'
      ? await runCommandRaw('cmd', ['/c', `${candidate} --version`])
      : await runCommandRaw('/bin/sh', ['-c', `${candidate} --version`]);
    if (probe === 0) { _pythonExe = candidate; return candidate; }
  }
  throw new Error('Python not found — install Python 3 and ensure it is on PATH');
}

// ── Child-process plumbing ──────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], opts: { cwd?: string }, log: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(' ')}`);
    let child: ChildProcess;
    try { child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { reject(err); return; }
    activeChildren.add(child);
    let tail = '';
    const onChunk = (buf: Buffer): void => {
      tail += buf.toString('utf-8');
      const parts = tail.split('\n');
      tail = parts.pop() ?? '';
      for (const line of parts) log(line);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => { activeChildren.delete(child); reject(err); });
    child.on('exit', (code) => { activeChildren.delete(child); if (tail.trim()) log(tail); resolve(code ?? -1); });
  });
}

function runCommandRaw(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawn(cmd, args, { stdio: 'ignore' }); }
    catch { resolve(1); return; }
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

// ── Runners ─────────────────────────────────────────────────────────────────

async function runIrisPreview(w: Record<string, unknown>, ctx: Ctx, log: (line: string) => void): Promise<Record<string, string>> {
  const scene = path.resolve(ctx.dir, String(w['scene'] ?? 'iris.xml'));
  const size = w['size'] as { width?: number; height?: number } | undefined;
  const views = (w['views'] as { name: string; camera: Record<string, number> }[]) ?? [];
  if (!views.length) throw new Error('iris-preview step needs a non-empty "views" list');

  const outputs: Record<string, string> = {};
  const client = new PreviewClient();
  activeClient = client;
  client.on('connected', () => { client.startStream({ fps: 4 }).catch(() => { /* best-effort */ }); });

  log(`boot irisd · headless · ${path.basename(scene)}`);
  const child = spawnPreview(scene, { port: FLOW_PREVIEW_PORT, fps: 4, width: size?.width, height: size?.height });
  activeChildren.add(child);
  let exited: Error | null = null;
  child.on('exit', (code) => {
    activeChildren.delete(child);
    exited = new Error(`irisd exited before rendering (code ${code ?? '?'}) — check ~/.iris/logs/irisd.log`);
  });

  try {
    client.connect(`ws://127.0.0.1:${FLOW_PREVIEW_PORT}`);
    await waitConnected(client, CONNECT_TIMEOUT_MS, () => exited);
    for (const v of views) {
      const cam = v.camera ?? {};
      log(`setCamera ${v.name} (${Object.entries(cam).map(([k, x]) => `${k} ${x}`).join(' · ')})`);
      await client.call('iris.camera.setTransform', {
        posX: cam['posX'] ?? 0, posY: cam['posY'] ?? 0, posZ: cam['posZ'] ?? 0,
        rotX: cam['rotX'] ?? 0, rotY: cam['rotY'] ?? 0, rotZ: cam['rotZ'] ?? 0,
        ...(cam['fov'] !== undefined ? { fov: cam['fov'] } : {}),
      });
      await wait(SETTLE_MS);
      const frame = await nextFrame(client, FRAME_TIMEOUT_MS);
      const file = `${v.name}.jpg`;
      fs.writeFileSync(path.join(ctx.cache, file), frame);
      outputs[v.name] = file;
      log(`wrote ${file}`);
    }
  } finally {
    try { client.disconnect(); } catch { /* ignore */ }
    activeClient = null;
    try { child.kill(); } catch { /* ignore */ }
    activeChildren.delete(child);
  }
  return outputs;
}

async function runDocker(w: Record<string, unknown>, ctx: Ctx, log: (line: string) => void): Promise<Record<string, string>> {
  const args = ((w['args'] as unknown[]) ?? []).map(String);
  let cmd: string[];
  let cwd = ctx.cache;
  if (w['compose']) {
    const composeFile = path.resolve(ctx.dir, String(w['compose']));
    const service = String(w['service'] ?? '');
    if (!service) throw new Error('docker compose step needs a "service"');
    cwd = path.dirname(composeFile);
    cmd = ['compose', '-f', composeFile, 'run', '--rm', service, ...args];
  } else if (w['image']) {
    const entry = w['entrypoint'] ? ['--entrypoint', String(w['entrypoint'])] : [];
    cmd = ['run', '--rm', '-v', `${ctx.cache}:/work`, '-w', '/work', ...entry, String(w['image']), ...args];
  } else {
    throw new Error('docker step needs an "image" or a "compose" + "service"');
  }
  const code = await runCommand('docker', cmd, { cwd }, log);
  if (code !== 0) throw new Error(`docker exited with code ${code}`);
  return (w['outputs'] as Record<string, string>) ?? {};
}

async function runOllama(w: Record<string, unknown>, ctx: Ctx, log: (line: string) => void): Promise<Record<string, string>> {
  const model = String(w['model'] ?? '');
  if (!model) throw new Error('ollama step needs a "model"');
  let prompt = String(w['prompt'] ?? '');
  for (const f of (w['context_files'] as string[]) ?? []) {
    const p = resolveInput(f, ctx);
    try { prompt += `\n\n--- ${path.basename(p)} ---\n${fs.readFileSync(p, 'utf-8')}`; }
    catch { log(`warn: context file not found: ${f}`); }
  }
  const images: string[] = [];
  for (const f of (w['images'] as string[]) ?? []) {
    const p = resolveInput(f, ctx);
    try { images.push(fs.readFileSync(p).toString('base64')); }
    catch { log(`warn: image not found: ${f}`); }
  }
  log(`POST ${OLLAMA_GENERATE_URL} · model ${model}${images.length ? ` · ${images.length} image(s)` : ''}`);
  const res = await fetch(OLLAMA_GENERATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, prompt, stream: false,
      ...(w['system'] ? { system: String(w['system']) } : {}),
      ...(images.length ? { images } : {}),
    }),
  }).catch((err: Error) => { throw new Error(`could not reach Ollama at ${OLLAMA_GENERATE_URL} (is \`ollama serve\` running?): ${err.message}`); });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { response?: string };
  const text = (body.response ?? '').trim();
  for (const line of text.split('\n')) log(line);
  const outputs: Record<string, string> = {};
  if (w['out']) {
    const file = String(w['out']);
    fs.writeFileSync(path.join(ctx.cache, file), text);
    outputs['out'] = file;
    log(`wrote ${file}`);
  }
  return outputs;
}

async function runShell(w: Record<string, unknown>, ctx: Ctx, log: (line: string) => void): Promise<Record<string, string>> {
  let script = String(w['run'] ?? '');
  if (!script) throw new Error('shell step needs a "run" command');
  if (/^python3?\s/.test(script)) {
    const exe = await resolvePython();
    script = script.replace(/^python3?\s/, `${exe} `);
  }
  const cwd = w['cwd'] ? path.resolve(ctx.dir, String(w['cwd'])) : ctx.cache;
  const code = process.platform === 'win32'
    ? await runCommand('cmd', ['/c', script], { cwd }, log)
    : await runCommand('/bin/sh', ['-c', script], { cwd }, log);
  if (code !== 0) throw new Error(`command exited with code ${code}`);
  return (w['outputs'] as Record<string, string>) ?? {};
}

function resolveInput(f: string, ctx: Ctx): string {
  if (path.isAbsolute(f)) return f;
  const inCache = path.join(ctx.cache, f);
  return fs.existsSync(inCache) ? inCache : path.resolve(ctx.dir, f);
}

const RUNNERS: Record<string, (w: Record<string, unknown>, ctx: Ctx, log: (l: string) => void) => Promise<Record<string, string>>> = {
  'iris-preview': runIrisPreview,
  docker: runDocker,
  ollama: runOllama,
  shell: runShell,
};

// ── Orchestration ───────────────────────────────────────────────────────────

export async function runFlow(
  descriptorPath: string,
  workspaceRoot: string,
  onProgress?: (run: FlowRun) => void,
): Promise<FlowRun> {
  const key = flowKey(descriptorPath, workspaceRoot);
  if (runningKey) throw new Error('a flow is already running');
  runningKey = key;

  const descriptor = readDescriptor(descriptorPath);
  const cacheDir = flowCacheDir(descriptorPath, workspaceRoot);
  fs.mkdirSync(cacheDir, { recursive: true });
  const ctx: Ctx = { cache: cacheDir, dir: path.dirname(descriptorPath), workspace: workspaceRoot };

  const run: FlowRun = {
    descriptor: descriptorPath,
    name: descriptor.name ?? path.basename(descriptorPath),
    startedAt: new Date().toISOString(),
    status: 'running',
    jobs: descriptor.jobs.map<JobResult>((j) => ({
      id: j.id, name: j.name ?? j.id, status: 'queued',
      steps: j.steps.map<StepResult>((s) => ({ name: s.name ?? s.uses, uses: s.uses, status: 'queued', log: [] })),
    })),
  };
  const jobResultOf = (id: string): JobResult => run.jobs.find((j) => j.id === id)!;

  const persist = (): void => {
    try { fs.writeFileSync(path.join(cacheDir, 'run.json'), JSON.stringify(run, null, 2)); } catch { /* best-effort */ }
    onProgress?.(run);
  };
  persist();

  try {
    const ordered = topoOrder(descriptor.jobs);
    const failed = new Set<string>();

    for (const job of ordered) {
      const jr = jobResultOf(job.id);
      const blocked = (job.needs ?? []).find((n) => failed.has(n));
      if (blocked) {
        jr.status = 'skipped';
        for (const st of jr.steps) st.status = 'skipped';
        failed.add(job.id);
        persist();
        continue;
      }
      jr.status = 'running';
      persist();
      const jobStart = Date.now();
      let jobFailed = false;

      for (let i = 0; i < job.steps.length; i++) {
        const step: FlowStep = job.steps[i];
        const sr = jr.steps[i];
        if (jobFailed) { sr.status = 'skipped'; persist(); continue; }
        sr.status = 'running';
        persist();
        const stepStart = Date.now();
        const log = (line: string): void => { sr.log.push(line); persist(); };
        try {
          const runner = RUNNERS[step.uses];
          if (!runner) throw new Error(`unknown runner "${step.uses}"`);
          const w = subst(step.with ?? {}, ctx);
          sr.outputs = await runner(w, ctx, log);
          sr.status = 'done';
          sr.ms = Date.now() - stepStart;
        } catch (err) {
          sr.status = 'failed';
          sr.ms = Date.now() - stepStart;
          sr.error = (err as Error).message;
          log(`ERROR ${sr.error}`);
          jobFailed = true;
        }
        persist();
      }

      jr.ms = Date.now() - jobStart;
      jr.status = jobFailed ? 'failed' : 'done';
      if (jobFailed) failed.add(job.id);
      persist();
    }

    run.status = run.jobs.some((j) => j.status === 'failed' || j.status === 'skipped') ? 'failed' : 'done';
  } catch (err) {
    run.status = 'failed';
    for (const jr of run.jobs) {
      if (jr.status === 'queued' || jr.status === 'running') {
        jr.status = 'failed';
        for (const st of jr.steps) if (st.status === 'queued' || st.status === 'running') st.status = 'failed';
        if (jr.steps.length && !jr.steps[0].error) jr.steps[0].error = (err as Error).message;
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    persist();
    teardown();
  }

  return run;
}

export function killActiveFlows(): void {
  teardown();
}

function teardown(): void {
  if (activeClient) { try { activeClient.disconnect(); } catch { /* ignore */ } activeClient = null; }
  for (const child of activeChildren) { try { child.kill(); } catch { /* ignore */ } }
  activeChildren.clear();
  runningKey = null;
}

// ── preview helpers ──────────────────────────────────────────────────────────

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
