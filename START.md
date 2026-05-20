# Start @nuna/relay

Three ways to invoke relay depending on context.

## End-user (global install)

```bash
npm i -g @nuna/relay
relay --help
```

`npm` pulls in the matching `@nuna/irisproc-<platform>-<arch>` binary
via `optionalDependencies`. No separate download needed.

## Local development (no build)

From `tools/relay`:

```bash
pnpm dev --help                          # serve, open, pack, …
pnpm dev pack packs/base.toml --verbose
```

`pnpm dev` runs the TypeScript sources directly through `tsx` — no
`pnpm build` needed between edits.

## Local development (built)

```bash
pnpm build                # one-time, after source changes
node dist/cli.js --help
node dist/cli.js pack packs/base.toml --verbose
# or:
pnpm start --help
```

`pnpm start` is `node dist/cli.js`.

## `relay pack` smoke test

```bash
# 1. From kosmos root: build irisproc once.
cd runtime/iris && cmake -B build-irisproc -S apps/irisproc && cmake --build build-irisproc

# 2. From tools/relay: run pack with --verbose to confirm resolution.
cd ../../tools/relay
pnpm dev pack /tmp/dummy.toml --verbose
```

Expected first line of output:

```
[relay pack] irisproc (dev-build): .../runtime/iris/build-irisproc/irisproc
```

The `(dev-build)` tag confirms the local irisproc was found. Production
installs (`npm i -g @nuna/relay`) report `(bundled-npm)` instead;
manual binary installs on `$PATH` report `(path)`.

## Logs

relay prints to stdout/stderr; no log file is written. Subcommands that
spawn helpers (`relay pack` → `irisproc`, `relay test` → `iris-player`)
inherit stdio, so their output appears inline.

## Stop

`Ctrl-C` in the foreground shell. Long-running subcommands (`relay
serve`, `relay test`) clean up child processes on `SIGINT`/`SIGTERM`.
