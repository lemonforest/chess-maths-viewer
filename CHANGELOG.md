# Changelog

Until this file was introduced, release notes lived in the prefix
of the version-bump commit messages (`vX.Y.Z: ...`). That history is
preserved verbatim below for the pre-0.6 line; everything from 0.6.0
onward gets a dedicated entry here.

The viewer follows loose semver: minor bumps for new overlays or
significant UX additions, patch bumps for fixes and infrastructure.
The `.spectralz` format version is tracked separately in
`README.md` and the file's header bytes.

## v0.7.0 — 2026-04-20

### Added
- **Channel overlay + fiber overlay can now coexist.** Previously
  mutually exclusive (both claimed the same board squares); the
  fiber overlay's `gradient` render mode uses a separate canvas
  layer, so the real conflict is only with `discrete` mode. The
  mutex now fires only in that narrow case: flipping on the channel
  while the fiber is discrete auto-promotes the fiber to gradient,
  and switching the fiber back to discrete auto-disables the
  channel. Clean composition rule: fiber is the smooth "elevation"
  underlay, channel is the localised per-square spike on top.
- **`mono` fiber colormap.** Greyscale elevation ramp designed to
  stay out of the channel overlay's cyan/amber hue zone, so both
  overlays can read simultaneously without hue competition. Joins
  `viridis` and `diverging` in the fiber panel's colormap
  seg-control.
- **Companion-aware gradient alpha.** When the channel overlay is
  also active, the fiber canvas auto-dims from 0.72 → 0.42 (0.5 in
  `mono`), so the per-square channel tints stay readable through
  the fiber layer.

### Changed
- Tighter board-panel header metrics. `.hdr-btn` now matches
  `.chan-btn`'s 11px font / 4×8 padding / 0.04em letter-spacing /
  transparent background + line-strong border. `.header-controls`
  gap 10px → 6px. `.fiber-controls` gap 10px → 6px. Both panel
  headers now read as the same button family at a glance.

### Fixed
- The ∥F∥ / ⊞ / ◻ / ⇅ buttons were clickable but silently no-op on
  the landing screen and during the brief window between
  corpus-load and first-game-parse. `handleAction()` was
  early-returning on `if (!game) return;` before reaching the
  switch. Non-game-dependent actions now fire first and return;
  the game guard protects only the ply/play/speed actions that
  genuinely need spectral data. Covered by
  `tests-js/fiber-overlay.test.js`.

## v0.6.0 — 2026-04-20

### Added
- **Fiber-norm overlay.** A new toggle (`∥F∥`) in the board panel
  header paints the per-square rank-3 fiber norm for a chosen piece
  type (N/B/R/Q/K) over the board. The field is a static property of
  the chess rules (independent of position/ply) and is served from
  `data/fiber_norms.json`, generated offline by
  `scripts/generate_fiber_norms.py`.
  - Sub-controls: piece selector, render mode (`smooth` bilinear
    canvas gradient vs `tiles` per-square), colormap (perceptual
    `viridis` vs divergent-around-mean).
  - Rook case handled with a uniform tint and a short helper line
    explaining that rook's rule content lives in the diagonal
    channel, not the off-diagonal fiber (research notebook §7b).
  - URL hash carries `fiber=<piece>,<mode>,<cmap>` when on, so
    shared links reproduce the view.
  - Existing per-channel overlay (`⊞`) is unchanged; the two
    overlays are mutually exclusive at the rendering level.
- **Verification gates.** `tests/test_fiber_norms.py` runs under
  `pytest -q` alongside the Othello tests and enforces rook-is-zero,
  D4 symmetry, bishop-queen parallelism (queen = bishop when rook's
  fiber is zero), knight corner-dim/center-bright structure, and
  consistency between the stored range metadata and the values
  array.
- **Data pipeline.** `pip install -e '.[fiber]'` adds numpy as a
  regeneration-only dependency. The viewer itself ships the JSON as
  a static asset and never computes the field at runtime.

### Notes
- The script and viewer work in the JS environment (chessboard.js),
  not python-chess; the task plan that originally spec'd the
  rendering paths assumed python-chess. The three candidate paths
  (per-square tint / canvas gradient / separate SVG) translate to
  Path A (existing `chess-overlay.js` mechanism), Path B (the new
  gradient canvas), and Path C (kept in
  `tests/fiber-overlay-poc.html` for reference, not shipped).

---

## v0.5.1 — self-heal bad OPFS cache bytes on read

Pre-0.6 history lives in the commit log. Run
`git log --oneline --grep='^v0\\.'` to see the per-release summaries
the project used before this file existed.
