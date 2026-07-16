/**
 * Keep an example's `<shader-dir>` GLSL sources compiled before irisd loads
 * them.
 *
 * Custom per-example fragment shaders (fire.frag, iridescent.frag, …) are
 * NOT recompiled by the engine at runtime — irisd loads a precompiled
 * `<name>.frag.spv` sitting next to the `.frag` source (see
 * PbrMaterialAtlas's fixed shader→pipeline table). Editing the `.frag` alone
 * silently does nothing until that `.spv` is regenerated, which used to be a
 * manual `glslc` step. This runs it automatically, once per stale source,
 * right before irisd is spawned.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const SHADER_EXTENSIONS = ['.vert', '.frag', '.comp', '.geom', '.tesc', '.tese'];

function stripFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

/**
 * Reads an entry XML (iris.xml/cryo.xml) for `<paths><shader-dir uri="..."/>`
 * and resolves it to an absolute directory. Returns null if the scene has no
 * override (the engine then uses its own built-in `<exeDir>/shaders`, which
 * is compiled by the main CMake build, not by this helper).
 */
export function resolveShaderDir(entryXmlPath: string): string | null {
  let xml: string;
  try {
    xml = readFileSync(entryXmlPath, 'utf8');
  } catch {
    return null;
  }
  if (!xml.includes('<shader-dir')) return null;

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const uri = doc?.synth?.['runtime-renderer']?.paths?.['shader-dir']?.['@_uri'];
  if (!uri || typeof uri !== 'string') return null;
  return path.resolve(path.dirname(entryXmlPath), stripFileUri(uri));
}

/**
 * Compiles every `.frag`/`.vert`/… in `shaderDir` whose source is newer than
 * its sibling `.spv` (or has none yet). Returns the filenames it compiled.
 * Throws on a glslc failure — silently rendering a stale `.spv` is exactly
 * the bug this exists to prevent, so a compile error must not be swallowed.
 */
export function recompileStaleShaders(shaderDir: string, glslcPath?: string): string[] {
  if (!existsSync(shaderDir)) return [];
  const glslc = glslcPath ?? process.env.IRIS_GLSLC ?? 'glslc';
  const compiled: string[] = [];

  for (const entry of readdirSync(shaderDir)) {
    if (!SHADER_EXTENSIONS.includes(path.extname(entry))) continue;
    const srcPath = path.join(shaderDir, entry);
    const spvPath = `${srcPath}.spv`;
    const srcMtime = statSync(srcPath).mtimeMs;
    const spvMtime = existsSync(spvPath) ? statSync(spvPath).mtimeMs : -Infinity;
    if (srcMtime <= spvMtime) continue;

    const result = spawnSync(glslc, [srcPath, '-o', spvPath], { stdio: 'pipe' });
    if (result.status !== 0) {
      const detail = result.error?.message ?? result.stderr?.toString().trim() ?? `exit code ${result.status}`;
      throw new Error(`glslc failed compiling ${entry} (from ${shaderDir}): ${detail}`);
    }
    compiled.push(entry);
  }
  return compiled;
}

/** Convenience: resolve + recompile in one call. No-op if the scene declares no `<shader-dir>`. */
export function ensureShadersFresh(entryXmlPath: string): string[] {
  const shaderDir = resolveShaderDir(entryXmlPath);
  if (!shaderDir) return [];
  return recompileStaleShaders(shaderDir);
}
