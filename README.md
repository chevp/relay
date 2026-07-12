# @nuna/relay

Nuna relay — TypeScript / Node ≥20. Relays `nuna://` URLs and orchestrates
serving, opening, validating, building, and asset-packing for Nuna games.
Relay's own code is pure TypeScript; heavy asset-processing is delegated to
[`irisproc`](#asset-workers-irisproc), a native helper binary bundled via
`optionalDependencies`.

---

## Scope

`@nuna/relay` is responsible for everything that does **not** require the
Vulkan renderer:

| Command          | Purpose                                                     |
| ---------------- | ----------------------------------------------------------- |
| `relay serve`    | Dev HTTP server (Fastify). Mounts roots from `nuna-serve.xml`, exposes `/discover.json`, `/health`, per-root SHA-256 manifests. |
| `relay open`     | `serve` + hands `nuna://play?discovery=…` to the OS URL handler. |
| `relay validate` | Game validation against the Synth Protocol schema.          |
| `relay build`    | Game build pipeline.                                        |
| `relay pack`     | Build an iris asset pack from a TOML definition. Delegates to `irisproc` (see [Asset workers](#asset-workers-irisproc)). |
| `relay mcp`      | MCP server for AI tooling.                                  |
| `relay test`     | Scripted playbook runner — drives `iris-player --daemon` from a YAML playbook file (see [Playbooks](#playbooks)). |
| `relay story`    | Story / artifact-pipeline orchestration.                    |

What it is **not**: the renderer. See **Player** below.

---

## Install

```bash
npm i -g @nuna/relay
relay --help
```

Node ≥ 20 required. The published tarball contains only `dist/`,
`schema/`, and this README — no binaries.

### Try it on the bundled example

A minimal layout-only game lives in [examples/default-game/](examples/default-game/):

```bash
cd examples/default-game
relay serve --verbose
# in another shell:
curl http://localhost:3001/discover.json
```

See [examples/default-game/README.md](examples/default-game/README.md) for
the full layout and endpoint list.

---

## Player (separate package & repo)

The Vulkan renderer is shipped independently as
[`@nuna/player`](https://github.com/chevp/nuna-player) and lives at
`tools/nuna-player/` in this monorepo as a **git submodule** pointing at
the public `chevp/nuna-player` repo.

```
@nuna/relay  ──emits──▶  nuna://play?discovery=…  ──OS handler──▶  @nuna/player
   (npm,                                                              (npm + Inno
    pure JS)                                                            installer)
```

`@nuna/relay` does **not** spawn or bundle the player exe. The two
packages communicate exclusively through the `nuna://` URL protocol,
which the player registers at install time. You can install either
package without the other.

### Distribution channels for the player

| Audience                | Channel                              |
| ----------------------- | ------------------------------------ |
| Node / admin tooling    | `npm i -g @nuna/player` (platform binary resolved via `optionalDependencies`: `@nuna/player-win32-x64`, …) |
| End users (no Node)     | Inno Setup installer (`nuna-player-setup.exe`) |

Both channels ship the **same exe** built by the same CI job — see the
`chevp/nuna-player` repo.

### Why split

1. Relay consumers who only run `validate` / `build` / `mcp` shouldn't
   download a multi-MB Vulkan binary.
2. Renderer release cadence is decoupled from relay release cadence.
3. The Inno installer has a different release surface (code signing,
   uninstall, Start Menu entries, URL-handler registration) that
   doesn't belong in an npm package.

---

## Asset workers (`irisproc`)

CPU-heavy asset processing — shader compilation, texture encoding, mesh
optimization, scene linking, pack-building — lives in a separate native
helper called [`irisproc`](https://github.com/chevp/iris/tree/main/apps/irisproc),
shipped from the iris repo. relay never compiles a shader or encodes a
texture itself; it shells out.

```
relay pack packs/base.toml
   │
   └──spawn──▶  irisproc pack packs/base.toml --out dist/
                 (C++ exe — shaderc, basisu, meshoptimizer, libarchive)
```

### How the binary lands on your machine

`@nuna/relay` declares `optionalDependencies` on per-platform packages
that contain just the prebuilt `irisproc` binary (same pattern as esbuild,
swc, sharp, `@nuna/player`):

| Package                       | Contents                | When installed |
| ----------------------------- | ----------------------- | -------------- |
| `@nuna/irisproc-linux-x64`    | `bin/irisproc`          | Linux x64 hosts |
| `@nuna/irisproc-win32-x64`    | `bin/irisproc.exe`      | Windows x64 hosts |

`npm install -g @nuna/relay` pulls relay plus the one matching binary
package — the others are silently skipped via `os`/`cpu` constraints.

macOS bindings are temporarily not published. On a Mac, relay falls back
to `$PATH` lookup or a local dev build (see below).

### Resolution order

relay's [`src/tools/irisproc.ts`](src/tools/irisproc.ts) tries three
sources, in this order:

1. **Bundled npm package** — `@nuna/irisproc-<platform>-<arch>/bin/irisproc`.
2. **`$PATH`** — for users who downloaded the binary manually from
   [chevp/iris releases](https://github.com/chevp/iris/releases) and put
   it on `PATH`.
3. **Local dev build** — if you're in the kosmos monorepo and ran
   `cmake -B build-irisproc -S apps/irisproc` inside `runtime/iris/`,
   relay picks that up without needing an `npm link`.

If all three miss, the error message lists every install path with a
concrete command.

### Publishing the bindings (maintainers)

Bindings are published from this repo, not from iris. The
[`publish-irisproc-bindings`](.github/workflows/publish-irisproc-bindings.yml)
workflow downloads a chosen `irisproc-*` release from `chevp/iris`, wraps
each platform binary into a tiny npm package, and publishes to npm. Run
it manually with the iris tag and the target npm version; use
`dry_run: true` to inspect the produced tarballs as artifacts before
hitting the registry.

---

## Local development

```bash
# from tools/relay
pnpm install
pnpm dev -- serve --verbose       # run from source
pnpm build                        # tsc → dist/
pnpm test                         # vitest
```

Source layout:

```
src/
├── cli.ts              ← entry point, command registration
├── commands/           ← one file per subcommand
├── tools/              ← wrappers around external binaries (irisproc, …)
├── server.ts           ← Fastify server
├── config/             ← nuna-serve.xml loader
├── discovery/          ← /discover.json + connectivity checks
├── manifest/           ← SHA-256 manifest builder
├── open/               ← nuna:// URL launcher
└── watch/              ← chokidar-based file watcher
```

---

## Playbooks

`relay test <playbook.yaml>` runs a flat list of steps against
`iris-player --daemon`, capturing screenshots and writing a
`result.json` report. See **[docs/playbooks.md](docs/playbooks.md)** for
full usage docs, and [ADR-0008](../../runtime/iris/docs/adr/0008-scripted-scenario-runner-in-relay.md)
for the design rationale.

### Playbook file format (V1)

```yaml
name: macos-smoke              # required, used as the result dir name
game: ../games/demo            # optional, resolved relative to the YAML file
steps:                         # required, one or more steps
  - loadScene: nuna://scenes/hub.scene.json
  - wait: 800                  # pure wall-clock delay in ms
  - goto: { entity: PlayerSpawn }
  - capture: { out: shots/hub-spawn.png }
  - goto: { x: 0, y: 5, z: 12, rx: -20, ry: 0, rz: 0 }
  - capture: { out: shots/hub-overview.png }
  - shutdown                   # optional — the runner also sends this on exit
```

Step vocabulary (V1):

| Step        | Args                                                | Daemon `cmd`      |
| ----------- | --------------------------------------------------- | ----------------- |
| `loadScene` | `<scene-uri>` (string)                              | `loadScene`       |
| `wait`      | `<ms>` (number, ≥ 0)                                | *(client-side)*   |
| `capture`   | `{ out: <png-path> }` (relative to `--out`)         | `capture`         |
| `goto`      | `{ entity: <id> }` **or** `{ x, y, z[, rx, ry, rz] }` | `setCamera`     |
| `shutdown`  | none                                                | `shutdown`        |

Rules:

- Unknown step verbs are a hard error (with line number) — typos must
  not be silently skipped.
- Unknown *fields* on a known step are ignored (overlay policy, ADR-0007).
- Steps run sequentially. On the first failure the runner stops, marks
  remaining steps `skipped`, writes `result.json`, and exits non-zero.
- Output goes to `--out <dir>` (default
  `<playbook-dir>/_results/<name>/`). Relative `capture.out` paths
  resolve under `--out`.
- The runner does **not** restart the daemon between steps. Long
  playbooks that hit GPU-leak limits should be split into multiple files.

### Example

```bash
relay test playbooks/macos-smoke.yaml \
  --player /path/to/iris-player \
  --port 9876 \
  --out /tmp/macos-smoke
```

`result.json` fields are V1 only — schema may shuffle. Consumers other
than humans should not depend on it yet.

---

## License

UNLICENSED — see workspace root.
