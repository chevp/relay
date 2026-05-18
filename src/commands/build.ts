/**
 * `nuna build` — MVP game bundler.
 *
 * Walks a game folder, hashes every file, and writes a single-file SQLite
 * bundle (`.nuna`) containing all bytes plus per-file metadata. Designed so
 * `relay serve --bundle <file>` (future) can mount the bundle read-only with
 * the same HTTP surface as a directory.
 *
 * MVP scope (deliberately small — see plans §1.2.16, §1.2.4 for the full
 * pipeline including asset optimization and authoring-format filtering):
 *   - inputDir defaults to CWD
 *   - recursive walk, skip dotfiles and the output file itself
 *   - schema: files(path, mime, size, sha256, content) + manifest(key, value)
 *   - no asset optimization, no scene-graph traversal — just bytes on disk
 */

import { Command } from 'commander';
import Database from 'better-sqlite3';
import pc from 'picocolors';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VERSION } from '../version.js';

export interface BuildOptions {
  input: string;
  out: string;
  verbose: boolean;
}

export interface BuildResult {
  bundlePath: string;
  fileCount: number;
  totalBytes: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.lua': 'text/x-lua',
  '.glsl': 'text/plain',
  '.spv': 'application/octet-stream',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.basis': 'image/basis',
};

export function registerBuild(program: Command): void {
  program
    .command('build')
    .description('Bundle a game folder into a single-file .nuna SQLite archive')
    .option('-i, --input <path>', 'Game folder to bundle', '.')
    .option('-o, --out <path>', 'Output bundle path', 'dist/game.nuna')
    .option('--verbose', 'Log every included file', false)
    .action(async (opts: BuildOptions) => {
      const result = await runBuild(opts);
      printBanner(result);
    });
}

export async function runBuild(opts: BuildOptions): Promise<BuildResult> {
  const inputAbs = path.resolve(process.cwd(), opts.input);
  const outAbs = path.resolve(process.cwd(), opts.out);

  await assertDir(inputAbs);
  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.rm(outAbs, { force: true });

  const db = new Database(outAbs);
  try {
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.exec(`
      CREATE TABLE files (
        path    TEXT PRIMARY KEY,
        mime    TEXT NOT NULL,
        size    INTEGER NOT NULL,
        sha256  BLOB NOT NULL,
        content BLOB NOT NULL
      );
      CREATE TABLE manifest (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const insertFile = db.prepare(
      'INSERT INTO files (path, mime, size, sha256, content) VALUES (?, ?, ?, ?, ?)'
    );
    const insertMeta = db.prepare('INSERT INTO manifest (key, value) VALUES (?, ?)');

    let fileCount = 0;
    let totalBytes = 0;
    const insertMany = db.transaction((entries: WalkedFile[]) => {
      for (const e of entries) {
        insertFile.run(e.relPath, e.mime, e.size, e.sha256, e.content);
        fileCount += 1;
        totalBytes += e.size;
        if (opts.verbose) {
          console.log(pc.dim(`  + ${e.relPath} (${e.size}B)`));
        }
      }
    });

    const walked = await walk(inputAbs, inputAbs, outAbs);
    insertMany(walked);

    insertMeta.run('version', '1');
    insertMeta.run('relayVersion', VERSION);
    insertMeta.run('builtAt', new Date().toISOString());
    insertMeta.run('source', inputAbs);

    return { bundlePath: outAbs, fileCount, totalBytes };
  } finally {
    db.close();
  }
}

interface WalkedFile {
  relPath: string;
  mime: string;
  size: number;
  sha256: Buffer;
  content: Buffer;
}

async function walk(dir: string, root: string, outAbs: string): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(current, ent.name);
      if (abs === outAbs) continue;
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const content = await fs.readFile(abs);
      const sha256 = createHash('sha256').update(content).digest();
      const relPath = path.relative(root, abs).split(path.sep).join('/');
      out.push({
        relPath,
        mime: mimeFor(ent.name),
        size: content.byteLength,
        sha256,
        content,
      });
    }
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

function mimeFor(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

async function assertDir(abs: string): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    fail(`Input not found: ${abs}`);
  }
  if (!stat.isDirectory()) fail(`Input is not a directory: ${abs}`);
}

function printBanner(result: BuildResult): void {
  console.log();
  console.log(pc.bold(pc.cyan('  nuna build')) + pc.dim(`  v${VERSION}`));
  console.log(pc.dim(`  bundle:   ${result.bundlePath}`));
  console.log(pc.dim(`  files:    ${result.fileCount}`));
  console.log(pc.dim(`  bytes:    ${result.totalBytes}`));
  console.log();
}

function fail(msg: string): never {
  console.error(pc.red(`[nuna build] ${msg}`));
  process.exit(2);
}