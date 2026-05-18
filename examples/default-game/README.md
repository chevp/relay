# default-game — minimal relay example

Smallest possible game layout that `@nuna/relay` can serve. Use it to
verify a fresh install, or copy it as the starting point for a new game.

## Layout

```
default-game/
├── nuna-serve.xml        # tells relay what to mount
├── runtime.xml           # Synth Protocol runtime config (read by the player)
├── scenes/
│   └── main.scene.json   # empty scene (camera only, zero entities)
├── smoke-test.sh         # CI-friendly endpoint check (Weg A)
└── Dockerfile            # `relay serve` baked into an image (Weg A)
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

## Ship it — two ways

### Weg A — serve-and-pack

Treat the folder as the artifact. CI starts `relay serve`, checks the live
endpoints, then tarballs the folder. The player or another relay instance
re-serves the unpacked tarball.

```bash
./smoke-test.sh                                    # local smoke
tar -czf default-game.tar.gz -C .. default-game    # pack

# or as a container:
docker build -t nuna-default-game .
docker run --rm -p 3001:3001 nuna-default-game
```

Pros: zero new format, easy to inspect, plays well with `docker run`.
Cons: many small files, no built-in integrity check, no single-file hand-off.

### Weg B — `relay build` → single-file `.nuna` bundle

Pack the folder into a single SQLite file containing every byte + SHA-256
hashes + a metadata table. One file moves between systems; deterministic
output; easy to verify integrity.

```bash
relay build --out dist/default-game.nuna --verbose

# inspect:
sqlite3 dist/default-game.nuna 'SELECT path, size, hex(substr(sha256,1,8)) FROM files;'
sqlite3 dist/default-game.nuna 'SELECT key, value FROM manifest;'
```

Schema:

```sql
CREATE TABLE files (
  path    TEXT PRIMARY KEY,
  mime    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  sha256  BLOB NOT NULL,
  content BLOB NOT NULL
);
CREATE TABLE manifest (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Today `relay build` is MVP: it walks the folder, hashes every file, and
writes them all into the bundle. There is no asset optimization, scene
traversal, or `.relayignore` yet — those land with the full pipeline
(§1.2.16, §1.2.4). A `relay serve --bundle <file>` reader is the next
obvious step so the bundle can be mounted read-only with the same HTTP
surface as a directory.

## CI

See [`.github/workflows/build-default-game.yml`](../../.github/workflows/build-default-game.yml)
for a complete pipeline running both paths.