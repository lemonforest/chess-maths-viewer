# Chess Spectral Lattice Fermion Viewer

![version](https://img.shields.io/badge/version-v0.2.0-8b5cf6?style=flat-square)
![spectralz](https://img.shields.io/badge/spectralz-v2-475569?style=flat-square)

A drop-in spectral analysis instrument for chess corpora. Drop a `.7z`
spectral corpus onto the page; the browser decompresses, parses, and indexes
everything client-side, then renders a synchronized chessboard PGN replay,
spectral lattice-fermion heatmaps (10 symmetry channels × 64 eigenmodes),
channel energy traces, and an engine eval overlay.

The site **is** the instrument. The `.7z` **is** the specimen. There is no
server, no build step, no pre-generated data directory.

## Usage

1. Open `https://lemonforest.github.io/chess-maths-viewer/` (or serve the
   repo root locally — see below).
2. Click a bundled corpus card, drop a `.7z` onto the page, or click "browse".
3. Step through plies with `←`/`→`, `Home`/`End`, `Space` to autoplay,
   `1`–`9`/`0` to switch games.

### Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works; there is no build step required to serve the
site.

### Bundled corpora

Any `.7z` dropped into `dataset/` becomes a one-click card on the landing
screen. After adding or removing a file, regenerate the manifest:

```bash
node scripts/build-dataset-index.mjs
```

This writes `dataset/index.json`, which the viewer fetches on load to
populate the BUNDLED CORPORA list. Commit both the `.7z` and the
regenerated `index.json`.

### URL state

The viewer state is encoded in the URL fragment so positions are shareable:

```
#game=3&ply=42&view=A1&ch=A1,FT&scale=z
```

Loading a URL with a fragment but no corpus shows the drop zone with a hint;
after dropping the matching corpus the viewer jumps to the requested state.

## Corpus format

Each corpus is a `.7z` archive containing:

| Path | Description |
|------|-------------|
| `manifest.json` | Master index: games list, file paths, channel means. |
| `pgn/game_NNN.pgn` | Standard PGN with inline `[%eval]` and `[%clk]`. |
| `ndjson/game_NNN.ndjson` | Per-ply records: FEN, SAN, UCI, eval, clock. |
| `spectralz/game_NNN.spectralz` | Gzip-compressed binary eigenmode matrix. |

### `.spectralz` binary layout

```
HEADER (256 bytes):
  bytes  0– 7  ASCII "LARTPSEC"
  bytes  8–11  uint32 LE   version (currently 2)
  bytes 12–15  uint32 LE   dimensionality (640 = 10 channels × 64 modes)
  bytes 16–19  uint32 LE   stride per ply record (2568 bytes)
  bytes 20–23  uint32 LE   number of plies
  bytes 24–255 zero padding

PLY RECORDS (n_plies × 2568 bytes each, starting at byte 256):
  642 float32 LE values per record
    floats   0–639  spectral eigenmode values (10 channels × 64 modes)
    floats 640–641  reserved padding (ignored)
```

Channel index → (id, label, semantics):

| idx | id | label  | semantics |
|----:|----|--------|-----------|
| 0   | A1 | A₁     | D₄-invariant singlet (rotational complexity) |
| 1   | A2 | A₂     | D₄ antisymmetric singlet |
| 2   | B1 | B₁     | diagonal-reflection symmetry |
| 3   | B2 | B₂     | anti-diagonal reflection symmetry |
| 4   | E  | E      | 2-D irrep — total board energy |
| 5   | F1 | F₁     | fiber 1 — cross-piece interaction |
| 6   | F2 | F₂     | fiber 2 |
| 7   | F3 | F₃     | fiber 3 |
| 8   | FA | F\_A   | pawn antisymmetric (Z₂ symmetry breaking) |
| 9   | FD | F\_D   | fiber determinant — interaction topology |

Per-channel energy at a ply = Σ (eigenmode value)² over its 64 modes.
Total fiber energy (`F_T`) = E(F₁) + E(F₂) + E(F₃).
Chaos ratio χ (per game) = ⟨F_T⟩ / ⟨A₁⟩.

## Architecture

Pure static site. No framework, no bundler, no Node.

```
chess-maths-viewer/
├── index.html            Entry point, drop zone, viewer shell
├── css/viewer.css        Dark scientific-instrument theme
├── js/
│   ├── app.js            State store, pub/sub, keyboard, URL hash, table, chain
│   ├── loader.js         .7z extraction, .spectralz parser, NDJSON, manifest
│   ├── board.js          chessboard.js + chess.js, FEN sync, playback
│   ├── spectral.js       Channel registry, canvas heatmap renderer
│   ├── charts.js         D3 line chart, eval overlay, crosshair tooltip
│   ├── lru.js            LRU eviction for parsed game state
│   └── virtual-table.js  Virtual scroller for the corpus table
├── dataset/              Bundled .7z corpora + generated index.json
├── scripts/              Dev utilities (run with node ≥18)
└── lib/                  Vendored JS libraries
```

External dependencies (CDN, no install required):

- [libarchive.js 2.0.2](https://github.com/nika-begiashvili/libarchivejs) — `.7z` decompression
- Native `DecompressionStream('gzip')` — `.spectralz` decompression
- [chessboard.js 1.0](https://chessboardjs.com/) + [chess.js 0.13.4](https://github.com/jhlywa/chess.js)
- [D3 v7](https://d3js.org/) — scales, axes, line generators

## License

See `LICENSE`.
