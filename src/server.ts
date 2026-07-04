/**
 * Fastify app — mounts static roots, serves manifests, exposes /discover.json
 * and /health.
 */

import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import type { ServeConfig, StaticRoot } from './config/ServeConfig.js';
import { buildManifest, type Manifest } from './manifest/ManifestBuilder.js';
import { buildDiscovery } from './discovery/discover.js';
import type { ContentProvider } from './provider/ContentProvider.js';
import { LocalContentProvider } from './provider/LocalContentProvider.js';

const localProvider = new LocalContentProvider();

// Resolve a UI file path once at import time (dev: src/server.ts, prod: dist/server.js).
function resolveUiPath(filename: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'ui', filename),       // dist/server.js → ../ui
    path.resolve(here, '..', '..', 'ui', filename), // src/server.ts → ../../ui
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

// scene-explorer.html is the primary entry point (full-screen preview + overlay nav).
// overview.html is still accessible at /overview for backward compat.
const SCENE_EXPLORER_PATH = resolveUiPath('scene-explorer.html');
const OVERVIEW_PATH        = resolveUiPath('overview.html');

export interface ServerContext {
  config: ServeConfig;
  version: string;
  verbose: boolean;
  /** Manifest cache keyed by root alias */
  manifests: Map<string, Manifest>;
  /** Hostname used when publishing URLs (e.g. localhost) */
  publicHost: string;
  /** Content backend — defaults to local filesystem */
  provider?: ContentProvider;
}

export async function createServer(ctx: ServerContext): Promise<FastifyInstance> {
  const provider = ctx.provider ?? localProvider;
  const app = Fastify({
    logger: ctx.verbose
      ? { level: 'info', transport: { target: 'pino-pretty' } }
      : false,
  });

  await app.register(fastifyCors, { origin: '*' });

  // Per-request access log, json-server style: METHOD /path STATUS Xms
  app.addHook('onResponse', async (req, reply) => {
    logRequest(req, reply);
  });

  // Register each static root as its own prefix.
  for (const root of ctx.config.staticRoots) {
    await registerStaticRoot(app, root, ctx, provider);
  }

  // Root → scene-explorer: full-screen iris-preview canvas + overlay scene navigator.
  app.get('/', async (_req, reply) => {
    try {
      const html = await fs.readFile(SCENE_EXPLORER_PATH, 'utf8');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache');
      return html;
    } catch {
      return reply.code(500).send({ error: 'scene_explorer_unavailable', path: SCENE_EXPLORER_PATH });
    }
  });

  // /overview — legacy relay explorer (file manifest browser, backward compat).
  app.get('/overview', async (_req, reply) => {
    try {
      const html = await fs.readFile(OVERVIEW_PATH, 'utf8');
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('Cache-Control', 'no-cache');
      return html;
    } catch {
      return reply.code(500).send({ error: 'overview_unavailable', path: OVERVIEW_PATH });
    }
  });

  app.get('/health', async () => ({ status: 'ok', version: ctx.version }));

  app.get('/discover.json', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return buildDiscovery(ctx.config, ctx.version, ctx.publicHost);
  });

  // Machine-readable hint for AI agents (Claude etc.). Tells the agent what
  // relay is, where the game files live, and that it should traverse those
  // files directly — no extra parsing endpoints needed because iris-player
  // loads from the same paths. Read-only.
  app.get('/api/agent.json', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return buildAgentManifest(ctx);
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  return app;
}

async function registerStaticRoot(
  app: FastifyInstance,
  root: StaticRoot,
  ctx: ServerContext,
  provider: ContentProvider,
): Promise<void> {
  const exists = await provider.exists(root.path);
  if (!exists) {
    if (root.optional) {
      app.log?.warn?.(`[nuna serve] optional static root "${root.alias}" missing: ${root.path}`);
      return;
    }
    throw new Error(`Static root "${root.alias}" does not exist: ${root.path}`);
  }

  // Manifest endpoint under this mount
  const manifestUrl = path.posix.join(root.mount, 'manifest.json');
  app.get(manifestUrl, async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    const cached = ctx.manifests.get(root.alias);
    if (cached) return cached;
    const fresh = await buildManifest(root.path, provider);
    ctx.manifests.set(root.alias, fresh);
    return fresh;
  });

  // Static-file delivery — configs get no-cache, assets get long-term cache
  const isConfigMount = root.alias === 'configs';
  await app.register(fastifyStatic, {
    root: root.path,
    prefix: root.mount,
    decorateReply: false,
    index: false,
    cacheControl: true,
    maxAge: isConfigMount ? 0 : '365d',
    setHeaders: isConfigMount
      ? (res) => { res.setHeader('Cache-Control', 'no-cache'); }
      : undefined,
  });
}

interface AgentManifest {
  name: string;
  version: string;
  role: string;
  capabilities: string[];
  endpoints: Array<{ method: string; url: string; description: string }>;
  game_roots: Array<{ alias: string; mount: string; manifest: string; description: string }>;
  guidance: string;
}

function buildAgentManifest(ctx: ServerContext): AgentManifest {
  const gameRoots = ctx.config.staticRoots.map((r) => ({
    alias: r.alias,
    mount: r.mount,
    manifest: path.posix.join(r.mount, 'manifest.json'),
    description:
      r.alias === 'game'
        ? 'Active game folder. Contains iris.xml (renderer + scene entry-point), scenes/*.json (entity definitions), assets/ (GLTF + textures), scripts/, kits/ etc. iris-player loads from here.'
        : r.alias === 'assets'
        ? 'Exported assets directory (optional).'
        : r.alias === 'configs'
        ? 'Per-game configs (no-cache).'
        : `Static root '${r.alias}'.`,
  }));

  return {
    name: 'relay',
    version: ctx.version,
    role:
      'HTTP dev server in front of an iris-player game folder. Files served here are the same files the player loads — read them directly to understand or describe the game; there is no parsed-scene API on purpose.',
    capabilities: ['read'],
    endpoints: [
      { method: 'GET', url: '/discover.json', description: 'Static roots + their mount URLs + server version.' },
      { method: 'GET', url: '/health',        description: 'Liveness probe.' },
      { method: 'GET', url: '/api/agent.json', description: 'This document.' },
      ...gameRoots.flatMap((g) => [
        { method: 'GET', url: g.manifest, description: `SHA-256 file manifest for the '${g.alias}' root.` },
        { method: 'GET', url: `${g.mount}<path>`, description: `Any file under the '${g.alias}' root.` },
      ]),
    ],
    game_roots: gameRoots,
    guidance:
      "Start at /discover.json (or game_roots above) to find the game mount — by convention /games/current/v-dev/. " +
      'Read <mount>iris.xml first: it points at the active scene file, declares <asset-root>, <shader-dir>, etc. ' +
      'Then read the scene file referenced by <scene uri="..."/> — typically scenes/main.scene.json — for the entity list. ' +
      "Entity assetRefs use 'asset://<path>' which resolves against the iris.xml <asset-root>. " +
      'GLTF files are the actual 3D models; you can fetch them as binary. No write endpoints exist — edits go through normal filesystem tools.',
  };
}

function logRequest(req: FastifyRequest, reply: FastifyReply): void {
  const method = colorMethod(req.method);
  const status = colorStatus(reply.statusCode);
  const ms = reply.elapsedTime.toFixed(1);
  console.log(`${method} ${req.url} ${status} ${pc.dim(`${ms} ms`)}`);
}

function colorMethod(m: string): string {
  const pad = m.padEnd(6);
  switch (m) {
    case 'GET':    return pc.cyan(pad);
    case 'POST':   return pc.green(pad);
    case 'PUT':    return pc.yellow(pad);
    case 'PATCH':  return pc.yellow(pad);
    case 'DELETE': return pc.red(pad);
    default:       return pc.white(pad);
  }
}

function colorStatus(code: number): string {
  const s = String(code);
  if (code >= 500) return pc.red(s);
  if (code >= 400) return pc.yellow(s);
  if (code >= 300) return pc.cyan(s);
  if (code >= 200) return pc.green(s);
  return pc.white(s);
}
