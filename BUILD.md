# Building @nuna/relay

TypeScript, Node ≥ 20, pnpm. Compiles to `dist/` via `tsc`. The
TypeScript side has no native deps; the asset-pipeline subcommand
(`relay pack`) shells out to [`irisproc`](#irisproc-dependency), a C++
binary shipped from the iris repo.

## Prerequisites

| Tool      | Version | Notes |
|-----------|---------|-------|
| Node.js   | ≥ 20    | ESM + `import.meta.url` resolution |
| pnpm      | 10.x    | Lockfile (`pnpm-lock.yaml`) and workspace conventions |
| `cmake`   | ≥ 3.24  | Only for the local irisproc dev-build (optional) |
| C++17 compiler | any | Only for the local irisproc dev-build (optional) |

## Install + build

```bash
pnpm install --frozen-lockfile
pnpm build                # tsc → dist/
```

The published tarball contains `dist/`, `schema/`, `ui/`, the `bin/`
launcher, and the READMEs — nothing else. Source files stay in this
repo.

## irisproc dependency

`relay pack` requires the `irisproc` executable. Three sources, resolved
in this order by [`src/tools/irisproc.ts`](src/tools/irisproc.ts):

1. **Bundled npm package** — `@nuna/irisproc-<platform>-<arch>`,
   pulled in automatically via `optionalDependencies` when end users
   run `npm i -g @nuna/relay`. Production path.
2. **`$PATH`** — for users who downloaded the binary manually from
   [chevp/iris releases](https://github.com/chevp/iris/releases).
3. **Local dev build** — when working inside the kosmos monorepo,
   relay walks up to `runtime/iris/build-irisproc/irisproc(.exe)`.

### Building irisproc for local development

From the kosmos workspace root:

```bash
cd runtime/iris
cmake -B build-irisproc -S apps/irisproc -DCMAKE_BUILD_TYPE=Release
cmake --build build-irisproc --parallel
```

The standalone CMake skips Vulkan, frostgfx, and the foundation layer —
build time is < 30s cold and the binary is currently ~33 KB
(workers are stubs).

### Verifying the binding works

```bash
cd tools/relay
pnpm dev pack /tmp/dummy.toml --verbose
# expected: [relay pack] irisproc (dev-build): .../runtime/iris/build-irisproc/irisproc
```

If the line above says `(bundled-npm)` or `(path)` instead of
`(dev-build)`, that's also valid — it means one of the upstream
resolution sources won. Only complete-miss is an error.

## CI builds

| Workflow | Repo | Purpose |
|----------|------|---------|
| [`build-irisproc.yml`](../../runtime/iris/.github/workflows/build-irisproc.yml) | iris | Multi-OS standalone build (linux-x64, win32-x64) → GitHub Release |
| [`publish-irisproc-bindings.yml`](.github/workflows/publish-irisproc-bindings.yml) | this repo | Manual dispatch: download a `chevp/iris` `irisproc-*` release, wrap each binary into `@nuna/irisproc-<platform>-<arch>`, publish to npm |
| [`build-default-game.yml`](.github/workflows/build-default-game.yml) | this repo | Smoke + tarball + `.nuna` bundle for `examples/default-game` |
| [`default-game.yml`](.github/workflows/default-game.yml) | this repo | Build-only flavour of the above (PR-fast) |

See [ADR-0005](../../docs/adr/0005-irisproc-as-relay-binding.md) for the
distribution model (Weg B: relay-CI publishes the bindings, not iris-CI).

## Tests + lint

```bash
pnpm test                 # vitest run
pnpm test:watch
pnpm lint                 # eslint src
```

## Publishing (maintainers)

1. Bump `version` in `package.json`.
2. `pnpm build` to make sure `dist/` is up to date.
3. `npm publish` (the `files` field already restricts the tarball
   contents).
4. If irisproc was rebuilt in iris between releases, dispatch
   `publish-irisproc-bindings.yml` with the matching iris tag and
   the same npm version *before* publishing relay, so end-users'
   `npm i -g @nuna/relay` resolves both halves.
