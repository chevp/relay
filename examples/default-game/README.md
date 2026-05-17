# default-game — minimal relay example

Smallest possible game layout that `@nuna/relay` can serve. Use it to
verify a fresh install, or copy it as the starting point for a new game.

## Layout

```
default-game/
├── nuna-serve.xml        # tells relay what to mount
├── runtime.xml           # Synth Protocol runtime config (read by the player)
└── scenes/
    └── main.scene.json   # empty scene (camera only, zero entities)
```

No binary assets are included on purpose — relay only serves files, and
shipping a `.gltf` here would just bloat the npm tarball. Add your own
under `assets/` and reference them from `scenes/main.scene.json`.

## Run

From this directory:

```bash
relay serve --verbose
```

Then poke the endpoints:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/discover.json
curl http://localhost:3001/games/default/v-dev/manifest.json
curl http://localhost:3001/games/default/v-dev/runtime.xml
```

`/discover.json` is what the player consumes after the OS hands it a
`nuna://play?discovery=…` URL. To trigger that flow end-to-end (relay +
OS handler + `@nuna/player`):

```bash
relay open
```
