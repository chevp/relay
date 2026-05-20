/**
 * ServeConfig — typed representation of nuna-serve.xml
 *
 * Parses the XML config that declares static-file roots, connected domain
 * servers, and kit-source aliases. Corresponds to §1.2.2 "Deklarative
 * Server-Config".
 *
 * Namespace: https://nuna.dev/schemas/serve/v1
 */

import { XMLParser } from 'fast-xml-parser';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface StaticRoot {
  /** Alias used in <sources> (e.g. "game", "kit") */
  alias: string;
  /** Filesystem path (relative to config file or absolute) */
  path: string;
  /** HTTP mount prefix (must start and end with "/") */
  mount: string;
  /** If true, missing path is not an error */
  optional: boolean;
}

export interface ConnectedServer {
  /** Alias used in <sources> */
  alias: string;
  /** Full URL (http/https/ws/wss) */
  url: string;
  /** Free-form role tag (e.g. "gameplay", "save-load", "kit-registry") */
  kind: string;
  /** If true, nuna-serve pings on startup and aborts on failure */
  required: boolean;
}

export interface SourceMapping {
  /** Logical source alias (e.g. "first-party") */
  alias: string;
  /** "static:<root-alias>" or "server:<server-alias>" */
  ref: string;
}

export interface ServeConfig {
  host: string;
  port: number;
  staticRoots: StaticRoot[];
  servers: ConnectedServer[];
  sources: SourceMapping[];
  /** Absolute path of the config file (for resolving relative static paths) */
  configPath: string;
}

export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 3001;

/**
 * Parse a nuna-serve.xml file into a typed ServeConfig.
 * Paths inside <static> are resolved relative to the config file's directory.
 */
export async function loadServeConfig(configPath: string): Promise<ServeConfig> {
  const absConfigPath = path.resolve(configPath);
  const xml = await fs.readFile(absConfigPath, 'utf8');
  return parseServeConfigXml(xml, absConfigPath);
}

export function parseServeConfigXml(xml: string, absConfigPath: string): ServeConfig {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    allowBooleanAttributes: true,
    parseAttributeValue: false, // we coerce explicitly
  });
  const doc = parser.parse(xml);
  const root = doc['nuna-serve'];
  if (!root) {
    throw new Error(`Invalid nuna-serve.xml: missing <nuna-serve> root element (${absConfigPath})`);
  }

  const host = String(root['@_host'] ?? DEFAULT_HOST);
  const port = Number(root['@_port'] ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${root['@_port']}" in ${absConfigPath}`);
  }

  const configDir = path.dirname(absConfigPath);
  const staticRoots = parseStaticRoots(root.static, configDir);
  const servers = parseServers(root.servers);
  const sources = parseSources(root.sources);

  return { host, port, staticRoots, servers, sources, configPath: absConfigPath };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null) return def;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function normalizeMount(mount: string): string {
  let m = mount.trim();
  if (!m.startsWith('/')) m = '/' + m;
  if (!m.endsWith('/')) m = m + '/';
  return m;
}

function parseStaticRoots(staticNode: unknown, configDir: string): StaticRoot[] {
  if (!staticNode || typeof staticNode !== 'object') return [];
  const rootsRaw = asArray((staticNode as Record<string, unknown>).root) as Record<string, unknown>[];
  return rootsRaw.map((r, i) => {
    const alias = String(r['@_alias'] ?? '');
    const rawPath = String(r['@_path'] ?? '');
    const mount = String(r['@_mount'] ?? '');
    if (!alias) throw new Error(`<static><root> #${i}: missing alias`);
    if (!rawPath) throw new Error(`<static><root alias="${alias}">: missing path`);
    if (!mount) throw new Error(`<static><root alias="${alias}">: missing mount`);
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(configDir, rawPath);
    return {
      alias,
      path: resolved,
      mount: normalizeMount(mount),
      optional: parseBool(r['@_optional'], false),
    };
  });
}

function parseServers(serversNode: unknown): ConnectedServer[] {
  if (!serversNode || typeof serversNode !== 'object') return [];
  const raw = asArray((serversNode as Record<string, unknown>).server) as Record<string, unknown>[];
  return raw.map((s, i) => {
    const alias = String(s['@_alias'] ?? '');
    const url = String(s['@_url'] ?? '');
    const kind = String(s['@_kind'] ?? '');
    if (!alias) throw new Error(`<servers><server> #${i}: missing alias`);
    if (!url) throw new Error(`<servers><server alias="${alias}">: missing url`);
    return {
      alias,
      url,
      kind,
      required: parseBool(s['@_required'], false),
    };
  });
}

function parseSources(sourcesNode: unknown): SourceMapping[] {
  if (!sourcesNode || typeof sourcesNode !== 'object') return [];
  const raw = asArray((sourcesNode as Record<string, unknown>).source) as Record<string, unknown>[];
  return raw.map((s, i) => {
    const alias = String(s['@_alias'] ?? '');
    const ref = String(s['@_ref'] ?? '');
    if (!alias) throw new Error(`<sources><source> #${i}: missing alias`);
    if (!ref) throw new Error(`<sources><source alias="${alias}">: missing ref`);
    if (!ref.startsWith('static:') && !ref.startsWith('server:')) {
      throw new Error(
        `<sources><source alias="${alias}">: ref "${ref}" must start with "static:" or "server:"`
      );
    }
    return { alias, ref };
  });
}

/**
 * Auto-generate a minimal config when no nuna-serve.xml exists.
 * Mounts the current directory as "game" root plus default assets-export/
 * and configs/ directories — but only when those directories actually
 * exist, so the overview UI doesn't show dangling roots that 404 on
 * /manifest.json.
 */
export function defaultConfig(cwd: string): ServeConfig {
  const candidates: StaticRoot[] = [
    {
      alias: 'game',
      path: cwd,
      mount: '/games/current/v-dev/',
      optional: false,
    },
    {
      alias: 'assets',
      path: path.join(cwd, 'assets-export'),
      mount: '/assets/',
      optional: true,
    },
    {
      alias: 'configs',
      path: path.join(cwd, 'configs'),
      mount: '/configs/',
      optional: true,
    },
  ];
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    // Drop optional roots whose paths are missing — keeps the overview
    // clean. Required roots stay regardless; their non-existence is meant
    // to fail loudly at server startup.
    staticRoots: candidates.filter((r) => !r.optional || existsSync(r.path)),
    servers: [],
    sources: [{ alias: 'game', ref: 'static:game' }],
    configPath: path.join(cwd, '<auto-generated>'),
  };
}
