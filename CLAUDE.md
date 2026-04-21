# CLAUDE.md

Project-specific notes for Claude Code. Read README.md first for what
this project is; this file only captures things that are easy to get
wrong.

## Architecture at a glance

- **Pure-JS viewer, no build step.** Static site served straight from
  the repo root. Task specs that assume python-chess are wrong — the
  board is driven by chessboard.js 1.0 UMD + jQuery (both vendored in
  `lib/`), positions are driven directly from FEN, and chess.js is
  NOT used. Translate any "python-chess rendering path" into
  chessboard.js equivalents.
- **Pub/sub state store in `js/app.js`.** `state` + `set(patch)` +
  `emit(event)` + `subscribe(event, fn)`. Panels subscribe to fields
  they care about; never mutate `state` directly, always go through
  `set()`.
- **Corpus decode happens in-browser.** `.7z` → `manifest.json` +
  per-game PGN/NDJSON/spectralz. See `js/loader.js`. The viewer works
  without a server beyond static file hosting.
- **Static fiber-norm data in `data/fiber_norms.json`.** Regenerate
  with `python3 scripts/generate_fiber_norms.py` (requires
  `pip install -e '.[fiber]'` for numpy). The V3 basis is derived
  from N/B/Q/K only; pawn is projected onto that existing basis so
  existing piece values stay byte-stable across regenerations.

## Test commands

```bash
npm test -- --run                         # vitest (jsdom)
python3 -m pytest tests/ -q               # Python (fiber norms + othello)
python3 scripts/generate_fiber_norms.py   # regenerate data/fiber_norms.json
```

Run both suites after any viewer or fiber change. Gate `data/fiber_norms.json`
regeneration on actual changes to `scripts/generate_fiber_norms.py` — the
script has verification gates that run on write.

## Version bump checklist

A minor or patch bump requires updating **five** stamps:

1. `js/app.js` — `APP_VERSION = 'vX.Y.Z'`
2. `package.json` — `"version": "X.Y.Z"`
3. `package-lock.json` — two occurrences of `"version": "X.Y.Z"`
4. `index.html` — `<span id="version-tag">viewer vX.Y.Z · ...`
5. `README.md` — version badge `version-vX.Y.Z-8b5cf6`

Plus a new `CHANGELOG.md` entry. The user explicitly asks for version
bumps when shipping meaningful UX/feature work — don't skip.

## Known user preferences (observed)

- **Aphantasia is a real constraint.** Layout shifts hurt; the user
  has explicitly called out board-bouncing as "eyes or brain too sad"
  territory. When adding sub-controls, reserve space even when
  hidden (use `visibility: hidden` + flex-reserved space, not
  `display: none`) OR keep the row's total width tight enough that it
  can't wrap at typical desktop widths.
- **Wants mathematical caveats disclosed in plain chess terms.** When
  introducing something with a non-obvious simplification (e.g. pawn's
  direction-collapsed adjacency, rook's fiber-invisibility), add a
  README paragraph that explains it in terms of chess moves and
  piece-count intuitions. The user is a chess-literate researcher but
  not a lattice-fermion specialist.
- **Loves version bumps as a signal of real work shipping.**
- **Prefers tooltips that auto-fade over persistent notes.** Helper
  text that sits forever over the board is visual noise.

## Git workflow

- Default branch for new work in a session: whatever the session's
  task runner specifies in its intro. Never push to a different
  branch without explicit permission.
- Never create a PR unless the user explicitly asks.
- Always use `git push -u origin <branch>` for the first push of a
  session.
- Commit messages: prefix with `vX.Y.Z: <summary>` when the commit
  also bumps the version. For pre-0.6 the per-release summary lived
  entirely in the version-bump commit message; from 0.6.0 onward it
  lives in `CHANGELOG.md` and the commit message is a shorter
  paraphrase.

## Small gotchas worth remembering

- `handleAction()` in `js/board.js` used to early-return on
  `if (!game) return;` before reaching the switch, silently
  swallowing non-game-dependent clicks (fiber/plain/flip/overlay
  toggles) on the landing screen. Non-game-dependent cases now run
  first and return before the game guard. Don't re-introduce the
  guard above those cases.
- Fiber `discrete` mode and the channel overlay both paint
  `background-image` on board squares. They can't coexist. The
  `gradient` fiber mode uses a separate canvas layer and composes
  fine with the channel overlay; combining the two auto-dims the
  fiber canvas and auto-promotes `discrete` → `gradient` when needed.
  If you add a new overlay, think carefully about which layer it
  uses and which others it conflicts with.
- The viewer ships the fiber JSON as a static asset; there's no
  runtime fiber computation. Don't add a JS fiber-generator path.
- chessboard.js uses `data-square` attributes on squares; flipping
  the board doesn't re-key them. Code that depends on square
  position must either read the attributes directly (discrete
  overlay path) or measure bounding rects of rank-1/rank-8 squares
  (gradient overlay path).
