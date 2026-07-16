import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveShaderDir, recompileStaleShaders } from '../src/preview/shaderCompile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Stands in for glslc so these tests don't need a Vulkan SDK install.
const FAKE_GLSLC = path.join(HERE, 'fixtures', 'fake-glslc.cjs');

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shader-compile-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveShaderDir', () => {
  it('resolves a <shader-dir> relative to the entry XML', async () => {
    const xmlPath = path.join(tmp, 'iris.xml');
    await fs.writeFile(
      xmlPath,
      `<synth><runtime-renderer><paths><shader-dir uri="file://../runtime/shaders"/></paths></runtime-renderer></synth>`
    );
    const resolved = resolveShaderDir(xmlPath);
    expect(resolved).toBe(path.resolve(tmp, '..', 'runtime', 'shaders'));
  });

  it('returns null when the scene has no <shader-dir>', async () => {
    const xmlPath = path.join(tmp, 'iris.xml');
    await fs.writeFile(xmlPath, `<synth><runtime-renderer><paths/></runtime-renderer></synth>`);
    expect(resolveShaderDir(xmlPath)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(resolveShaderDir(path.join(tmp, 'nope.xml'))).toBeNull();
  });
});

describe('recompileStaleShaders', () => {
  it('compiles a .frag with no .spv yet', () => {
    const src = path.join(tmp, 'iridescent.frag');
    writeFileSync(src, '// v1');
    const compiled = recompileStaleShaders(tmp, FAKE_GLSLC);
    expect(compiled).toEqual(['iridescent.frag']);
    expect(existsSync(`${src}.spv`)).toBe(true);
  });

  it('skips a shader whose .spv is already newer', () => {
    const src = path.join(tmp, 'iridescent.frag');
    const spv = `${src}.spv`;
    writeFileSync(src, '// v1');
    writeFileSync(spv, 'already compiled');
    const future = new Date(Date.now() + 60_000);
    utimesSync(spv, future, future);
    const compiled = recompileStaleShaders(tmp, FAKE_GLSLC);
    expect(compiled).toEqual([]);
    expect(readFileSync(spv, 'utf8')).toBe('already compiled');
  });

  it('recompiles once the .frag is edited after the .spv exists', () => {
    const src = path.join(tmp, 'iridescent.frag');
    const spv = `${src}.spv`;
    writeFileSync(spv, 'stale');
    const past = new Date(Date.now() - 60_000);
    utimesSync(spv, past, past);
    writeFileSync(src, '// v2');
    const compiled = recompileStaleShaders(tmp, FAKE_GLSLC);
    expect(compiled).toEqual(['iridescent.frag']);
    expect(readFileSync(spv, 'utf8')).toContain('v2');
  });

  it('throws when glslc fails, instead of leaving a stale .spv', () => {
    const src = path.join(tmp, 'iridescent.frag');
    writeFileSync(src, '// v1');
    process.env.FAKE_GLSLC_FAIL = '1';
    try {
      expect(() => recompileStaleShaders(tmp, FAKE_GLSLC)).toThrow(/glslc failed/);
    } finally {
      delete process.env.FAKE_GLSLC_FAIL;
    }
  });

  it('ignores non-shader files and missing directories', () => {
    expect(recompileStaleShaders(path.join(tmp, 'does-not-exist'), FAKE_GLSLC)).toEqual([]);
  });
});
