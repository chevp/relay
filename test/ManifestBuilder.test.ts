import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildManifest } from '../src/manifest/ManifestBuilder.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nuna-serve-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('buildManifest', () => {
  it('returns empty files for empty dir', async () => {
    const m = await buildManifest(tmp);
    expect(m.version).toBe(1);
    expect(m.files).toEqual({});
  });

  it('hashes a single file', async () => {
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'hello');
    const m = await buildManifest(tmp);
    expect(Object.keys(m.files)).toEqual(['hello.txt']);
    // sha256("hello")
    expect(m.files['hello.txt'].sha256).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
    expect(m.files['hello.txt'].size).toBe(5);
  });

  it('walks subdirectories and uses forward slashes', async () => {
    await fs.mkdir(path.join(tmp, 'worlds'));
    await fs.writeFile(path.join(tmp, 'worlds', 'main.world.xml'), '<w/>');
    const m = await buildManifest(tmp);
    expect(Object.keys(m.files)).toContain('worlds/main.world.xml');
  });

  it('skips the root-level manifest.json', async () => {
    await fs.writeFile(path.join(tmp, 'manifest.json'), '{}');
    await fs.writeFile(path.join(tmp, 'keep.txt'), 'x');
    const m = await buildManifest(tmp);
    expect(Object.keys(m.files)).toEqual(['keep.txt']);
  });

  it('skips dotfiles', async () => {
    await fs.writeFile(path.join(tmp, '.hidden'), 'x');
    await fs.writeFile(path.join(tmp, 'visible.txt'), 'y');
    const m = await buildManifest(tmp);
    expect(Object.keys(m.files)).toEqual(['visible.txt']);
  });
});
