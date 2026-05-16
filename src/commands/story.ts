/**
 * `nuna story` — generate a Markdown screenshot gallery for a game.
 *
 * Walks `games/<game>/scenes/*.scene.json`, spawns nuna-player.exe in
 * --daemon mode, and for each scene sends loadScene + capture over the
 * Storybook WebSocket IPC. Emits `<out>/index.md` + `<out>/scenes.md`
 * with inline PNG references.
 *
 * Plan: §2.8.1 (exp). Decisions per G1→G2:
 *   1. Node.js orchestrator, 2. WebSocket transport, 3. Manifest-driven
 *   prefab discovery (Glob fallback — prefabs not in V1), 4. Sidecar hints
 *   (not in V1), 5. Central `docs/story/<game>/`, 6. Studio light preset,
 *   7. Subcommand name `nuna story`.
 */

import { Command } from 'commander';
import pc from 'picocolors';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

interface StoryOptions {
  game: string;
  port: string;
  player?: string;
  out?: string;
  repo?: string;
  only: 'scenes' | 'prefabs' | 'all';
  restartEvery: string;
  captureTimeout: string;
}

interface SceneInfo {
  id: string;
  scenePath: string;
  imageRel: string;
  description?: string;
  entityCount?: number;
  status: 'ok' | 'broken' | 'pending';
  error?: string;
}

const DEFAULT_PORT = '9876';
const DEFAULT_RESTART_EVERY = '20';
const DEFAULT_CAPTURE_TIMEOUT_MS = '15000';

export function registerStory(program: Command): void {
  program
    .command('story')
    .description('Generate a Markdown screenshot gallery for a game (Storybook §2.8.1)')
    .requiredOption('-g, --game <name>', 'Game folder under games/ (e.g. _showcases/engine-showcase)')
    .option('-p, --port <number>', 'Daemon WebSocket port', DEFAULT_PORT)
    .option('--player <path>', 'Path to nuna-player.exe (default: <repo>/cpp/build/bin/Release/nuna-player.exe)')
    .option('--out <dir>', 'Output directory (default: <repo>/docs/story/<game>/)')
    .option('--repo <path>', 'Repo root (default: cwd auto-detected)')
    .option('--only <kind>', 'Limit to "scenes" | "prefabs" | "all"', 'scenes')
    .option('--restart-every <n>', 'Restart daemon every N captures', DEFAULT_RESTART_EVERY)
    .option('--capture-timeout <ms>', 'Per-capture timeout in ms', DEFAULT_CAPTURE_TIMEOUT_MS)
    .action(async (opts: StoryOptions) => {
      try {
        await runStory(opts);
      } catch (err) {
        console.error(pc.red(`[story] fatal: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}

async function runStory(opts: StoryOptions): Promise<void> {
  const repoRoot = opts.repo ? path.resolve(opts.repo) : await findRepoRoot(process.cwd());
  const gameRoot = path.resolve(repoRoot, 'games', opts.game);
  if (!existsSync(gameRoot)) {
    throw new Error(`game folder not found: ${gameRoot}`);
  }
  const playerPath = opts.player
    ? path.resolve(opts.player)
    : path.join(repoRoot, 'cpp', 'build', 'bin', 'Release', 'nuna-player.exe');
  if (!existsSync(playerPath)) {
    throw new Error(`nuna-player.exe not found at ${playerPath} (use --player)`);
  }
  const daemonCwd = path.join(repoRoot, 'cpp');
  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.join(repoRoot, 'docs', 'story', opts.game);
  const port = parseInt(opts.port, 10);
  const restartEvery = parseInt(opts.restartEvery, 10);
  const captureTimeoutMs = parseInt(opts.captureTimeout, 10);

  const onlyScenes = opts.only === 'scenes' || opts.only === 'all';
  const onlyPrefabs = opts.only === 'prefabs' || opts.only === 'all';

  console.log(pc.cyan(`[story] repo:        ${repoRoot}`));
  console.log(pc.cyan(`[story] game:        ${opts.game}`));
  console.log(pc.cyan(`[story] player:      ${playerPath}`));
  console.log(pc.cyan(`[story] out:         ${outDir}`));
  console.log(pc.cyan(`[story] port:        ${port}`));

  const scenes = onlyScenes ? await scanScenes(gameRoot) : [];
  if (onlyPrefabs) {
    console.log(pc.yellow('[story] note: prefab capture is out-of-scope in V1 (§2.8.1)'));
  }
  if (scenes.length === 0) {
    console.log(pc.yellow(`[story] no scenes found in ${path.join(gameRoot, 'scenes')}`));
    return;
  }
  console.log(pc.cyan(`[story] scenes found: ${scenes.length}`));

  await fs.mkdir(path.join(outDir, 'images', 'scenes'), { recursive: true });

  const results: SceneInfo[] = [];
  let daemon: ChildProcess | null = null;
  let captureCount = 0;
  let cycle = 0;

  async function ensureDaemon(): Promise<void> {
    if (daemon && !daemon.killed) return;
    cycle += 1;
    console.log(pc.gray(`[story] daemon cycle #${cycle} starting...`));
    daemon = spawn(playerPath, ['--daemon', '--port', String(port)], {
      cwd: daemonCwd,
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    daemon.on('exit', (code) => {
      console.log(pc.gray(`[story] daemon exit (code=${code})`));
    });
    await waitForEngineRunning(port, 30_000);
  }

  async function killDaemon(): Promise<void> {
    if (!daemon || daemon.killed) return;
    try {
      const ws = await connect(`ws://127.0.0.1:${port}`, 2_000);
      try {
        await sendCmd(ws, 'shutdown', {}, 5_000);
      } finally {
        ws.close();
      }
      // Wait briefly for graceful exit
      await Promise.race([
        new Promise<void>((res) => daemon!.once('exit', () => res())),
        delay(5_000),
      ]);
    } catch {
      // Fall through to force-kill
    }
    if (!daemon.killed) {
      daemon.kill();
    }
    daemon = null;
  }

  try {
    for (const scene of scenes) {
      await ensureDaemon();

      try {
        const ws = await connect(`ws://127.0.0.1:${port}`, 5_000);
        try {
          const loadResp = await sendCmd(ws, 'loadScene', {
            path: scene.scenePath,
            gameRoot: gameRoot,
            previewOnly: true,
          }, captureTimeoutMs);
          if (!loadResp.ok) {
            scene.status = 'broken';
            scene.error = `loadScene: ${loadResp.error}`;
            results.push(scene);
            console.log(pc.red(`[story] ✗ ${scene.id}: ${scene.error}`));
            continue;
          }

          // Allow GLTF assets to finish loading + a few render frames before capture.
          await delay(2_000);

          const absImage = path.join(outDir, scene.imageRel);
          const capResp = await sendCmd(ws, 'capture', { out: absImage }, captureTimeoutMs);
          if (!capResp.ok) {
            scene.status = 'broken';
            scene.error = `capture: ${capResp.error}`;
            results.push(scene);
            console.log(pc.red(`[story] ✗ ${scene.id}: ${scene.error}`));
            continue;
          }

          // Engine writes the PNG asynchronously a few frames after the command.
          if (!await waitForFile(absImage, captureTimeoutMs)) {
            scene.status = 'broken';
            scene.error = `capture timeout: PNG not written within ${captureTimeoutMs}ms`;
            results.push(scene);
            console.log(pc.red(`[story] ✗ ${scene.id}: ${scene.error}`));
            continue;
          }

          scene.status = 'ok';
          results.push(scene);
          console.log(pc.green(`[story] ✓ ${scene.id} (${(await fs.stat(absImage)).size} bytes)`));
        } finally {
          ws.close();
        }
      } catch (err) {
        scene.status = 'broken';
        scene.error = (err as Error).message;
        results.push(scene);
        console.log(pc.red(`[story] ✗ ${scene.id}: ${scene.error}`));
        // Daemon may be hung — kill so the next iteration spawns a fresh one.
        await killDaemon();
      }

      captureCount += 1;
      if (captureCount >= restartEvery) {
        await killDaemon();
        captureCount = 0;
      }
    }
  } finally {
    await killDaemon();
  }

  await emitGallery(outDir, opts.game, results);

  const okCount = results.filter((r) => r.status === 'ok').length;
  const broken = results.filter((r) => r.status === 'broken');
  console.log(pc.cyan(`\n[story] ${okCount}/${results.length} captured ok`));
  if (broken.length > 0) {
    console.log(pc.yellow(`[story] ${broken.length} broken:`));
    for (const b of broken) console.log(pc.yellow(`  - ${b.id}: ${b.error}`));
  }
  console.log(pc.cyan(`[story] gallery: ${path.join(outDir, 'index.md')}`));
}

async function findRepoRoot(start: string): Promise<string> {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'games')) && existsSync(path.join(dir, 'cpp'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`could not find repo root from ${start} (looking for games/ + cpp/ siblings)`);
}

async function scanScenes(gameRoot: string): Promise<SceneInfo[]> {
  const scenesDir = path.join(gameRoot, 'scenes');
  if (!existsSync(scenesDir)) return [];
  const entries = await fs.readdir(scenesDir, { withFileTypes: true });
  const out: SceneInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.scene.json')) continue;
    const id = entry.name.replace(/\.scene\.json$/, '');
    const scenePath = path.join(scenesDir, entry.name);
    let description: string | undefined;
    let entityCount: number | undefined;
    try {
      const json = JSON.parse(await fs.readFile(scenePath, 'utf-8'));
      description = json?.scene?.metadata?.description;
      entityCount = Array.isArray(json?.scene?.entities) ? json.scene.entities.length : undefined;
    } catch {
      // ignore parse errors — still attempt capture
    }
    out.push({
      id,
      scenePath,
      imageRel: path.posix.join('images', 'scenes', `${id}.png`),
      description,
      entityCount,
      status: 'pending',
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

interface IpcResponse { id: string; ok: boolean; result?: any; error?: string; }

async function connect(uri: string, timeoutMs: number): Promise<WebSocket> {
  const ws = new WebSocket(uri);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`ws connect timeout: ${uri}`));
    }, timeoutMs);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return ws;
}

async function sendCmd(ws: WebSocket, cmd: string, args: Record<string, unknown>, timeoutMs: number): Promise<IpcResponse> {
  const id = `${cmd}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const message: Record<string, unknown> = { id, cmd };
  if (Object.keys(args).length > 0) message.args = args;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ws cmd timeout (${cmd}, ${timeoutMs}ms)`)), timeoutMs);
    const onMessage = (data: WebSocket.RawData): void => {
      try {
        const msg = JSON.parse(data.toString()) as IpcResponse;
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      } catch (err) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        reject(err);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

async function waitForEngineRunning(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const ws = await connect(`ws://127.0.0.1:${port}`, 1_500);
      try {
        const r = await sendCmd(ws, 'ping', {}, 3_000);
        if (r.ok && r.result?.engineRunning) return;
      } finally {
        ws.close();
      }
    } catch (err) {
      lastErr = err as Error;
    }
    await delay(500);
  }
  throw new Error(`daemon never reached engineRunning state${lastErr ? ` (last: ${lastErr.message})` : ''}`);
}

async function waitForFile(absPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > 0) return true;
    } catch {
      // not yet
    }
    await delay(200);
  }
  return false;
}

async function emitGallery(outDir: string, gameName: string, results: SceneInfo[]): Promise<void> {
  const ok = results.filter((r) => r.status === 'ok');
  const broken = results.filter((r) => r.status === 'broken');

  const scenesMd: string[] = [
    `# ${gameName} — Scenes`,
    '',
    `Generated: ${new Date().toISOString()}`,
    `Total: ${results.length} (ok: ${ok.length}, broken: ${broken.length})`,
    '',
  ];
  for (const r of results) {
    scenesMd.push(`### ${r.id}`);
    if (r.status === 'ok') {
      scenesMd.push(`![${r.id}](./${r.imageRel})`);
    } else {
      scenesMd.push(`> ⚠ broken: \`${r.error ?? 'unknown error'}\``);
    }
    scenesMd.push('');
    scenesMd.push(`- Scene: \`${path.relative(path.dirname(outDir), r.scenePath).replace(/\\/g, '/')}\``);
    if (typeof r.entityCount === 'number') scenesMd.push(`- Entities: ${r.entityCount}`);
    if (r.description) scenesMd.push(`- ${r.description}`);
    scenesMd.push('');
  }
  await fs.writeFile(path.join(outDir, 'scenes.md'), scenesMd.join('\n'), 'utf-8');

  const indexMd: string[] = [
    `# ${gameName} — Storybook`,
    '',
    `Auto-generated screenshot gallery (§2.8.1).`,
    `Last run: ${new Date().toISOString()}`,
    '',
    '## Sections',
    '',
    `- [Scenes](./scenes.md) — ${results.length} entries (${ok.length} ok, ${broken.length} broken)`,
    '',
    '## Quick Preview',
    '',
  ];
  for (const r of ok.slice(0, 8)) {
    indexMd.push(`### ${r.id}`);
    indexMd.push(`![${r.id}](./${r.imageRel})`);
    indexMd.push('');
  }
  if (ok.length > 8) {
    indexMd.push(`_…and ${ok.length - 8} more — see [scenes.md](./scenes.md)_`);
    indexMd.push('');
  }
  await fs.writeFile(path.join(outDir, 'index.md'), indexMd.join('\n'), 'utf-8');
}
