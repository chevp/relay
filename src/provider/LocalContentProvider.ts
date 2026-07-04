/**
 * LocalContentProvider — ContentProvider backed by the local filesystem.
 *
 * Uses node:fs for reads/stats/listing and chokidar for watching.
 * This is the default provider; other providers (Firebase, S3, …) implement
 * the same interface.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { ContentProvider, DirEntry, FileStat, Unwatch } from './ContentProvider.js';

const DEBOUNCE_MS = 500;

export class LocalContentProvider implements ContentProvider {
  readonly isLocal = true;

  async exists(absPath: string): Promise<boolean> {
    try {
      await fs.access(absPath);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(absPath: string): Promise<Buffer> {
    return fs.readFile(absPath);
  }

  async readText(absPath: string): Promise<string> {
    return fs.readFile(absPath, 'utf-8');
  }

  async list(absPath: string): Promise<DirEntry[]> {
    let entries;
    try {
      entries = await fs.readdir(absPath, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.map((e) => ({
      name: e.name,
      path: path.join(absPath, e.name),
      isFile: e.isFile(),
      isDirectory: e.isDirectory(),
    }));
  }

  async stat(absPath: string): Promise<FileStat> {
    const s = await fs.stat(absPath);
    return { size: s.size };
  }

  watch(absPath: string, onChange: () => void): Unwatch {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
    };

    const watcher = chokidar.watch(absPath, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\../,
      persistent: true,
    });

    watcher.on('add', trigger);
    watcher.on('change', trigger);
    watcher.on('unlink', trigger);

    return () => { watcher.close(); };
  }
}
