# `relay test` — scripted scenarios

A scripted-scenario runner that drives `iris-player --daemon` from a flat
YAML file. One command, one config file, exit 0 on success / non-zero on
the first failed step.

Design: [ADR-0008](../../../runtime/iris/docs/adr/0008-scripted-scenario-runner-in-relay.md).

---

## Quick start

```bash
# 1. Write a scenario
cat > smoke.yaml <<'YAML'
name: smoke
steps:
  - loadScene: nuna://scenes/hub.scene.json
  - wait: 800
  - goto: { entity: PlayerSpawn }
  - capture: { out: hub-spawn.png }
YAML

# 2. Run it
relay test smoke.yaml --player /path/to/iris-player

# 3. Inspect artefacts
ls ./_results/smoke/
#   result.json   hub-spawn.png
```

The runner spawns the player, waits for `engineRunning`, executes the
steps over the Storybook WebSocket, then sends `shutdown` and exits.

---

## CLI

```
relay test <scenario.yaml> [options]
```

| Option              | Default                                             | Purpose |
| ------------------- | --------------------------------------------------- | ------- |
| `--player <path>`   | `<repo>/cpp/build/bin/Release/nuna-player.exe`      | Path to the `iris-player` binary. |
| `-p, --port <n>`    | `9876`                                              | TCP port for the daemon WebSocket. |
| `--out <dir>`       | `<scenario-dir>/_results/<scenario-name>/`          | Where artefacts and `result.json` are written. |
| `--repo <path>`     | Auto-detected from cwd                              | Repo root (looks for `games/` + `cpp/` siblings). |
| `--command-timeout <ms>` | `15000`                                        | Per-WS-command timeout. Applies to `loadScene`, `capture`, `goto`, `shutdown`. |

Exit codes:

| Code | Meaning |
| ---- | ------- |
| `0`  | All steps succeeded. |
| `1`  | At least one step failed, or the scenario / player setup is invalid. |

---

## Scenario file format

YAML, one document, three top-level keys.

```yaml
name: <string>          # required — used as the result-dir name
game: <path>            # optional — resolved relative to the YAML file,
                        # forwarded as gameRoot for Lua/prefab resolution
steps:                  # required — non-empty list of steps
  - <step>
  - <step>
```

### Step vocabulary (V1)

| Step        | Args                                                | Daemon `cmd`    | Notes |
| ----------- | --------------------------------------------------- | --------------- | ----- |
| `loadScene` | `<scene-uri>` (string)                              | `loadScene`     | `previewOnly=true` is sent automatically. |
| `wait`      | `<ms>` (number ≥ 0)                                 | *(client-side)* | Pure wall-clock delay. No frame counting in V1. |
| `capture`   | `{ out: <png-path> }`                               | `capture`       | Relative `out` is resolved under `--out`. PNG is awaited up to `--command-timeout`. |
| `goto`      | `{ entity: <id> }` **or** `{ x, y, z[, rx, ry, rz] }` | `setCamera`   | Entity form looks up the entity and frames it; pose form sets absolute camera. |
| `shutdown`  | none                                                | `shutdown`      | Optional — the runner also sends `shutdown` on exit. |

### Examples

```yaml
name: macos-smoke
game: ../games/demo
steps:
  - loadScene: nuna://scenes/hub.scene.json
  - wait: 800
  - goto: { entity: PlayerSpawn }
  - capture: { out: shots/hub-spawn.png }

  - goto: { x: 0, y: 5, z: 12, rx: -20, ry: 0, rz: 0 }
  - capture: { out: shots/hub-overview.png }

  - shutdown
```

```yaml
# Bare-string form is allowed for arg-less steps.
name: minimal
steps:
  - loadScene: nuna://scenes/empty.scene.json
  - shutdown
```

### Validation rules

- **Unknown step verbs are a hard error.** A typo like `lodScene` fails
  the run with a line number — it is *not* silently skipped.
- **Unknown fields on a known step are ignored.** Mirrors the overlay
  policy from [ADR-0007](../../../runtime/iris/docs/adr/0007-per-user-ini-config-store.md).
- **Steps run sequentially.** On the first failure, the runner stops,
  marks the remaining steps as `skipped` in `result.json`, sends
  `shutdown`, and exits non-zero.
- **No conditional logic, retries, loops, or variable interpolation.**
  If you need those, write multiple scenario files and run them from a
  shell.

---

## Output

The runner writes everything under `--out` (default
`<scenario-dir>/_results/<scenario-name>/`):

```
_results/<name>/
├── result.json        ← machine-readable run report
└── <capture paths>    ← PNGs from `capture` steps
```

### `result.json` shape (V1)

```jsonc
{
  "scenario": "/abs/path/to/smoke.yaml",
  "name":     "smoke",
  "game":     "../games/demo",          // omitted if absent
  "status":   "ok",                     // or "error"
  "startedAt": "2026-05-18T12:34:56.000Z",
  "durationMs": 4123,
  "outDir":   "/abs/path/to/_results/smoke",
  "steps": [
    {
      "index": 0,
      "kind":  "loadScene",
      "line":  3,                       // line in the YAML file
      "status": "ok",                   // "ok" | "error" | "skipped"
      "startedAt": "2026-05-18T12:34:57.000Z",
      "durationMs": 812,
      "result": { /* daemon response */ }
    },
    {
      "index": 1,
      "kind":  "capture",
      "line":  6,
      "status": "error",
      "startedAt": "2026-05-18T12:34:58.000Z",
      "durationMs": 15001,
      "error": "capture timeout: PNG not written within 15000ms ..."
    }
  ]
}
```

> **Stability:** `result.json` is V1 only — fields may shuffle until the
> schema stabilises. Human consumption is fine; don't build long-lived
> tooling on it yet.

---

## Lifecycle in detail

```
relay test scenario.yaml
   │
   ├── parse YAML (line-numbered errors)
   ├── resolve --player, --port, --out
   ├── spawn iris-player --daemon --port <n>
   ├── waitForEngineRunning  (≤ 30s)
   ├── open ws://127.0.0.1:<n>
   ├── for each step:
   │      send(cmd, args, id)  ; await response or --command-timeout
   │      stop on first failure (remaining steps → skipped)
   ├── send(shutdown)          ; best-effort, then SIGKILL
   ├── write _results/<name>/result.json
   └── exit 0 / 1
```

Notes:

- The runner uses the **Storybook daemon** WebSocket (see
  [StorybookDaemon.cpp](../../../runtime/iris/apps/iris/src/daemon/StorybookDaemon.cpp)),
  not `SceneEditorBridge`. ImGui is suppressed at bind-time, so captures
  contain clean geometry.
- The daemon is **not** restarted between steps. Long scenarios that hit
  GPU-leak limits should be split into multiple files. (`relay story`
  restarts every N captures because gallery runs walk hundreds of
  scenes; that's a `story` concern, not a scenario concern.)
- The runner runs against a real GPU. Headless OSes need a virtual
  framebuffer (Xvfb, Vulkan-on-llvmpipe). Same guidance as
  `iris-player`.

---

## CI usage

```bash
relay test scenarios/smoke.yaml \
  --player "$PLAYER_BIN" \
  --port 9876 \
  --out "$RUNNER_TEMP/scenario-out" \
  --command-timeout 30000
```

Pair with whatever your CI uses for "publish artefacts" — point it at
the `--out` directory.

---

## Troubleshooting

| Symptom                                              | Likely cause / fix |
| ---------------------------------------------------- | ------------------ |
| `iris-player not found at <path>`                    | Pass `--player <abs-path>`. The default assumes a Windows build layout. |
| `daemon never reached engineRunning state`           | The player crashed during startup, or `--port` is already bound. Check player stdout/stderr (currently `stdio: 'ignore'` — running the binary by hand reproduces the issue). |
| `capture timeout: PNG not written within …ms`        | The engine accepted `capture` but the PNG never appeared on disk. Usually a renderer or filesystem permission issue. Re-run with `--command-timeout` raised. |
| `setCamera: entity 'X' not found`                    | Either the scene isn't loaded, or the entity id is wrong. Verify with a manual `relay open` first. |
| `ScenarioParseError … unknown step kind: "lodScene"` | Typo'd verb — fix the YAML. V1 verbs: `loadScene`, `wait`, `capture`, `goto`, `shutdown`. |

---

## What this is *not*

These are out of scope for V1 (and tracked under "Deferred" in
[ADR-0008](../../../runtime/iris/docs/adr/0008-scripted-scenario-runner-in-relay.md)):

- **Visual regression / pixel diffing.** PNGs are produced; diffing is
  a separate tool.
- **Assertions on scene correctness.** A step succeeds when the daemon
  answers `ok`; the runner does not inspect rendered pixels or scene
  state.
- **Parallel scenarios.** One player per `relay test` invocation.
- **Conditionals, loops, variables, retries.** Flat step list only.
- **Multiplayer / network scenarios.** Single-player only.
- **Editor-mode scenarios** (driving `iris-editor` instead of
  `iris-player`).
