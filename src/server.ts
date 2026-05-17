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

// ui/overview.html sits next to dist/ when published, and next to src/ during
// dev (tsx). Resolve once at import time so the route handler is cheap.
const OVERVIEW_PATH = resolveOverviewPath();
function resolveOverviewPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', 'ui', 'overview.html'),       // dist/server.js → ../ui
    path.resolve(here, '..', '..', 'ui', 'overview.html'), // src/server.ts → ../../ui
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export interface ServerContext {
  config: ServeConfig;
  version: string;
  verbose: boolean;
  /** Manifest cache keyed by root alias */
  manifests: Map<string, Manifest>;
  /** Hostname used when publishing URLs (e.g. localhost) */
  publicHost: string;
}

export async function createServer(ctx: ServerContext): Promise<FastifyInstance> {
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
    await registerStaticRoot(app, root, ctx);
  }

  // Root → overview SPA (vanilla HTML, hits /discover.json + per-root
  // manifest.json to render an explorer). Single-file, no build step.
  app.get('/', async (_req, reply) => {
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

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  return app;
}

async function registerStaticRoot(
  app: FastifyInstance,
  root: StaticRoot,
  ctx: ServerContext
): Promise<void> {
  const exists = await pathExists(root.path);
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
    const fresh = await buildManifest(root.path);
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
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
