# Chess Spectral Lattice Fermion Viewer

![version](https://img.shields.io/badge/version-v0.5.1-8b5cf6?style=flat-square)
![spectralz](https://img.shields.io/badge/spectralz-v2-475569?style=flat-square)

A drop-in spectral analysis instrument for chess corpora. Drop a `.7z`
spectral corpus onto the page; the browser decompresses, parses, and indexes
everything client-side, then renders a synchronized chessboard PGN replay,
spectral lattice-fermion heatmaps (10 symmetry channels × 64 eigenmodes),
channel energy traces, and an engine eval overlay.

The site **is** the instrument. The `.7z` **is** the specimen. There is no
server, no build step, no pre-generated data directory.

**The bytes this viewer renders are produced by the [`chess-spectral`
encoder](https://pypi.org/project/chess-spectral/)** (`pip install
chess-spectral` — Python reference + byte-identical C17 port), part of the
broader `mlehaptics` research programme that treats chess as a classical
lattice fermion system — pieces as quantum-numbered particles on a
grid-graph Laplacian, captures as field-energy redistribution on a shared
rank-5 fiber bundle. See [Producing corpora](#producing-corpora) for the
encoder CLI and [Background](#background) for the theoretical framing.

## Usage

1. Open `https://lemonforest.github.io/chess-maths-the-movie/` (or serve the
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

## Producing corpora

This repo is a **consumer** of `.7z` corpus archives — it does not produce
them. The encoder that makes the `.spectralz` files inside those archives
is published on PyPI:

**→ [`chess-spectral` on PyPI](https://pypi.org/project/chess-spectral/)**

```bash
pip install "chess-spectral[corpus]"
```

The `[corpus]` extra pulls in `python-chess` for PGN ingest via the
`chess_spectral.corpus` module. Source, C17 port, and a parity test suite
that keeps the two implementations byte-identical live in the sibling
[`mlehaptics` repo](https://github.com/lemonforest/mlehaptics/tree/main/docs/chess-maths/chess-spectral)
— install from there instead if you want the C binary (µs/encode batch
throughput) or to develop new channels.

### CLI

After install, `chess-spectral` is on your `$PATH`:

| Command | Purpose |
|---|---|
| `chess-spectral encode-fen --fen "<fen>" -o out.spectral` | Encode a single position to a 1-frame file. |
| `chess-spectral encode -i game.ndjson -o game.spectralz -z` | Encode an NDJSON game to a gzip-compressed `.spectralz`. |
| `chess-spectral csv game.spectralz [-o game.csv]` | Emit the 17-column chat-friendly CSV (inter-frame metrics + channel energies). Auto-picks up a sibling `.ndjson` for eval/clk/NAG columns. |
| `chess-spectral version` | Print file-format / encoding-dim info. |

Run any subcommand with `--help` for the full flag set — names and defaults
in the CLI are the source of truth.

### Packaging a viewer-ready `.7z`

The encoder emits a **folder** (`manifest.json` + `corpus_index.csv` +
`pgn/` + `ndjson/` + `spectralz/`); the viewer expects a `.7z` archive, so
you have to compress it yourself as a final step:

```bash
7z a my_corpus.7z my_corpus/
# → drop my_corpus.7z onto the viewer
```

### End-to-end from Lichess

[`run_corpus_sweep.py`](https://github.com/lemonforest/mlehaptics/blob/main/docs/chess-maths/run_corpus_sweep.py)
in the `mlehaptics` repo wires fetch → encode → feature-extract into one
step:

```bash
python docs/chess-maths/run_corpus_sweep.py \
    --source lichess --username DrNykterstein --n 10 \
    --run-id lichess_drnykterstein_$(date +%Y-%m-%d)_N10
# → results/sweep_<run-id>/{manifest.json,pgn/,ndjson/,spectralz/,corpus_index.csv}

7z a sweep_lichess_drnykterstein_$(date +%Y-%m-%d)_N10.7z \
    results/sweep_lichess_drnykterstein_$(date +%Y-%m-%d)_N10/
# ↑ manual archive step — the encoder never writes .7z itself.
```

See [`ENCODERS.md`](https://github.com/lemonforest/mlehaptics/blob/main/docs/chess-maths/ENCODERS.md)
for the full reproduction recipe, encoder lineage, and channel-layout
reference.

## Background

The 10 channels above are not a feature-engineering choice — they are the
irreducible components of the 8×8 board Laplacian under D₄ symmetry (A₁,
A₂, B₁, B₂, E) plus three shared off-diagonal fiber modes (F₁–F₃) and two
pawn-specific channels (F_A antisymmetric, F_D diagonal deviation). Every
piece type is uniquely classified by a 5-tuple of spectral quantum numbers;
captures decompose into movement + annihilation + cross-term with exact
charge-conjugation signature.

Full theoretical treatment, proofs, and computational verification:
[`CHESS_SPECTRAL_INSTRUCTIONS.md`](https://github.com/lemonforest/mlehaptics/blob/main/docs/chess-maths/CHESS_SPECTRAL_INSTRUCTIONS.md)
and
[`chess_spectral_research_notebook.md`](https://github.com/lemonforest/mlehaptics/blob/main/docs/chess-maths/chess_spectral_research_notebook.md)
in the `mlehaptics` repo.

## Architecture

Pure static site. No framework, no bundler, no Node.

```
chess-maths-viewer/
├── index.html            Entry point, drop zone, viewer shell
├── css/viewer.css        Dark scientific-instrument theme
├── js/
│   ├── app.js            State store, pub/sub, keyboard, URL hash, table, chain
│   ├── loader.js         .7z extraction, .spectralz parser, NDJSON, manifest
│   ├── opfs.js           Origin Private File System cache for per-game entries
│   ├── board.js          chessboard.js driver, FEN sync, playback
│   ├── chess-overlay.js  Paints per-square channel tint into chessboard.js squares
│   ├── othello-board.js  SVG driver for Othello corpora (swap-in for board.js)
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
- [chessboard.js 1.0](https://chessboardjs.com/) — board rendering (FEN-driven; chess.js is **not** loaded — positions come straight from per-ply FENs in the NDJSON)
- [jQuery 3.7.1](https://jquery.com/) — required by chessboard.js 1.0
- [D3 v7](https://d3js.org/) — scales, axes, line generators

## Tests

Two test suites run in CI (see `.github/workflows/ci.yml`):

- **Python** — `pytest -q` exercises the bundled `othello` library
  (`tests/test_board.py`, `tests/test_svg.py`). Requires the dev extra:
  `pip install -e '.[dev]'`.
- **JavaScript** — `npm test` runs a [vitest](https://vitest.dev/)
  suite under `tests-js/`:
    - `lru.test.js` — eviction order, pin safety, error tolerance of
      `js/lru.js`.
    - `spectral.test.js` — `channelEnergyForPly`, `getOverlayForPly`
      across the four overlay transforms (abs / Δply / log / z),
      `parseEvalString`, `divergingColor`.
    - `virtual-table.test.js` — jsdom-backed check that the virtual
      scroller renders fewer rows than the full dataset and keeps
      `.active` exclusive to the matching key.
    - `opfs.test.js` — Map-backed OPFS polyfill exercises
      `isOpfsAvailable`, cache-key derivation, and read/write round-trip
      of `js/opfs.js`.
    - `smoke-large-corpus.test.js` — reproduces the last-click-loses
      race on a synthetic 191 MB-shaped corpus by calling the real
      `ensureGameData` / LRU / virtual-table paths with a hand-verified
      10-ply fixture (libarchive.js + WASM don't run under jsdom).

Install the dev dependencies with `npm install`; they stay under
`node_modules/` and are not loaded by the viewer at runtime.

## License

See `LICENSE`.
