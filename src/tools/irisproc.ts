/**
 * irisproc binary resolver.
 *
 * Locates the irisproc executable shipped alongside relay. Tries, in order:
 *   1. Bundled npm platform package (production install via `optionalDependencies`)
 *      e.g. `@nuna/irisproc-darwin-arm64/bin/irisproc`
 *   2. $PATH (binary installed manually or via the `irisproc-download` GH action)
 *   3. Local dev build inside the kosmos monorepo
 *      e.g. `runtime/iris/build-irisproc/irisproc`
 *
 * Throws a single error with all three fallback paths in the message if no
 * binary is found, so users know exactly which install steps are missing.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export type IrisprocSource = 'bundled-npm' | 'path' | 'dev-build';

export interface IrisprocLocation {
  /** Absolute path to the irisproc executable. */
  path: string;
  /** Which resolution strategy succeeded. */
  source: IrisprocSource;
}

const EXE_EXT = process.platform === 'win32' ? '.exe' : '';

export function findIrisproc(): IrisprocLocation {
  const bundled = tryBundled();
  if (bundled) return { path: bundled, source: 'bundled-npm' };

  const onPath = tryPath();
  if (onPath) return { path: onPath, source: 'path' };

  const dev = tryDevBuild();
  if (dev) return { path: dev, source: 'dev-build' };

  throw new Error(
    'irisproc binary not found. Tried:\n' +
      `  - npm platform package: ${platformPackageName()}\n` +
      `  - $PATH lookup: ${exeName()}\n` +
      '  - dev build: runtime/iris/build-irisproc/\n\n' +
      'Install one of:\n' +
      '  - `npm i -g @nuna/relay` (bundles platform binary via optionalDependencies)\n' +
      '  - Download from https://github.com/chevp/iris/releases (latest irisproc-* tag)\n' +
      '  - Build locally: `cmake -B build-irisproc -S apps/irisproc && cmake --build build-irisproc`'
  );
}

function platformPackageName(): string {
  return `@nuna/irisproc-${process.platform}-${process.arch}`;
}

function exeName(): string {
  return `irisproc${EXE_EXT}`;
}

function tryBundled(): string | null {
  try {
    return require.resolve(`${platformPackageName()}/bin/${exeName()}`);
  } catch {
    return null;
  }
}

function tryPath(): string | null {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${which} ${exeName()}`, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return result.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function tryDevBuild(): string | null {
  // Walk from this module's directory up to the kosmos workspace and look for
  // a locally-built irisproc. Covers the in-monorepo dev loop where you build
  // irisproc once and have `relay pack` pick it up without npm-installing.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  // src/tools/irisproc.ts (run via tsx)  -> ../../  = tools/relay
  // dist/tools/irisproc.js (compiled)    -> ../../  = tools/relay
  // tools/relay -> ../../runtime/iris/
  const relayRoot = path.resolve(here, '..', '..');
  const irisRoot = path.resolve(relayRoot, '..', '..', 'runtime', 'iris');
  for (const sub of [
    'build-irisproc',
    'build-irisproc/Release',
    'build/bin/Release',
    'build/bin',
  ]) {
    candidates.push(path.join(irisRoot, sub, exeName()));
  }
  return candidates.find(existsSync) ?? null;
}
