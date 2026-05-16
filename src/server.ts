/**
 * Fastify app — mounts static roots, serves manifests, exposes /discover.json
 * and /health.
 */

import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ServeConfig, StaticRoot } from './config/ServeConfig.js';
import { buildManifest, type Manifest } from './manifest/ManifestBuilder.js';
import { buildDiscovery } from './discovery/discover.js';

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

  // Register each static root as its own prefix.
  for (const root of ctx.config.staticRoots) {
    await registerStaticRoot(app, root, ctx);
  }

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
