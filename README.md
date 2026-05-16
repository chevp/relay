# @nuna/cli

Unified Nuna CLI — pure TypeScript / Node ≥20. Orchestrates serving,
opening, validating, building for Nuna games. Contains **no
native code**.

---

## Scope

`@nuna/cli` is responsible for everything that does **not** require the
Vulkan renderer:

| Command         | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `nuna serve`    | Dev HTTP server (Fastify). Mounts roots from `nuna-serve.xml`, exposes `/discover.json`, `/health`, per-root SHA-256 manifests. |
| `nuna open`     | `serve` + hands `nuna://play?discovery=…` to the OS URL handler. |
| `nuna validate` | Game validation against the Synth Protocol schema.          |
| `nuna build`    | Game build pipeline.                                        |
| `nuna mcp`      | MCP server for AI tooling.                                  |
| `nuna test`     | MCP test harness.                                           |
| `nuna story`    | Story / artifact-pipeline orchestration.                    |

What it is **not**: the renderer. See **Player** below.

---

## Install

```bash
npm i -g @nuna/cli
nuna --help
```

Node ≥ 20 required. The published tarball contains only `dist/`,
`schema/`, and this README — no binaries.

---

## Player (separate package & repo)

The Vulkan renderer is shipped independently as
[`@nuna/player`](https://github.com/chevp/nuna-player) and lives at
`tools/nuna-player/` in this monorepo as a **git submodule** pointing at
the public `chevp/nuna-player` repo.

```
@nuna/cli  ──emits──▶  nuna://play?discovery=…  ──OS handler──▶  @nuna/player
   (npm,                                                            (npm + Inno
    pure JS)                                                          installer)
```

`@nuna/cli` does **not** spawn or bundle the player exe. The two
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

1. CLI consumers who only run `validate` / `build` / `mcp` shouldn't
   download a multi-MB Vulkan binary.
2. Renderer release cadence is decoupled from CLI release cadence.
3. The Inno installer has a different release surface (code signing,
   uninstall, Start Menu entries, URL-handler registration) that
   doesn't belong in an npm package.

---

## Local development

```bash
# from tools/nuna-cli
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
├── server.ts           ← Fastify server
├── config/             ← nuna-serve.xml loader
├── discovery/          ← /discover.json + connectivity checks
├── manifest/           ← SHA-256 manifest builder
├── open/               ← nuna:// URL launcher
└── watch/              ← chokidar-based file watcher
```

---

## License

UNLICENSED — see workspace root.
