"""SVG rendering for :class:`othello.Board`.

Mirrors ``chess.svg.board()`` in dimensions, grid layout, coordinate labelling
and CSS styling approach — same 45-px squares, same 20-px coordinate margin,
same ``squares``/``coordinates``/``pieces`` group structure — but draws simple
discs instead of chess pieces.

The public entry point is :func:`board`, whose signature intentionally echoes
``chess.svg.board`` so callers already set up for python-chess can swap in
`othello.svg` without refactoring.
"""

from __future__ import annotations

from typing import Iterable, Mapping, Optional

from . import BLACK, WHITE, Board, Move, SQUARE_NAMES, square_file, square_rank

# --- Dimensions (match chess.svg) -------------------------------------------

SQUARE_SIZE = 45
MARGIN = 20            # coordinate gutter on all four sides when coordinates=True
DISC_RADIUS = 20       # slightly smaller than the square so the board shows through

# --- Default colours (chess.svg parity where applicable) --------------------

DEFAULT_COLORS: Mapping[str, str] = {
    "square light":       "#ffce9e",
    "square dark":        "#d18b47",
    "square light lastmove": "#cdd26a",
    "square dark lastmove":  "#aaa23b",
    "margin":             "#212121",
    "coord":              "#e5e5e5",
    "disc black":         "#111111",
    "disc white":         "#f5f5f5",
    "disc outline":       "#000000",
}


def _esc(s: str) -> str:
    return (
        s.replace("&", "&amp;")
         .replace("<", "&lt;")
         .replace(">", "&gt;")
         .replace('"', "&quot;")
    )


def _resolve_colors(overrides: Optional[Mapping[str, str]]) -> dict[str, str]:
    merged = dict(DEFAULT_COLORS)
    if overrides:
        merged.update(overrides)
    return merged


def board(
    board: Optional[Board] = None,
    *,
    orientation: bool = WHITE,
    lastmove: Optional[Move] = None,
    size: Optional[int] = None,
    coordinates: bool = True,
    colors: Optional[Mapping[str, str]] = None,
    flipped: bool = False,
    borders: bool = False,
    style: Optional[str] = None,
) -> str:
    """Return an SVG string rendering ``board`` as an Othello position.

    Parameters mirror :func:`chess.svg.board`:

    * ``orientation`` / ``flipped`` — orientation is the side shown at the
      bottom (default ``WHITE``); ``flipped=True`` flips that choice, matching
      python-chess's semantics.
    * ``lastmove`` — an :class:`othello.Move` whose ``to_square`` is highlighted
      (ignored if it's a null/pass move).
    * ``size`` — if set, renders a fixed-size SVG (``width``/``height``);
      otherwise the SVG scales with its container via ``viewBox`` only.
    * ``coordinates`` — render ``a``–``h`` / ``1``–``8`` gutter labels.
    * ``colors`` — override any of the keys in :data:`DEFAULT_COLORS`.
    * ``borders`` — draw the chess.svg-style dark margin behind the coordinate
      gutter.
    * ``style`` — extra CSS appended to the inline ``<style>`` block.
    """
    board = board if board is not None else Board()
    palette = _resolve_colors(colors)

    # Orientation: in python-chess, `orientation=True` means white at the
    # bottom; `flipped=True` reverses that. We follow the same convention.
    white_bottom = bool(orientation) ^ bool(flipped)

    margin = MARGIN if coordinates else 0
    inner = 8 * SQUARE_SIZE
    total = inner + 2 * margin

    parts: list[str] = []
    parts.append('<?xml version="1.0" encoding="UTF-8"?>')
    attrs = [
        'xmlns="http://www.w3.org/2000/svg"',
        'xmlns:xlink="http://www.w3.org/1999/xlink"',
        f'viewBox="0 0 {total} {total}"',
        'version="1.1"',
    ]
    if size is not None:
        attrs.append(f'width="{size}"')
        attrs.append(f'height="{size}"')
    parts.append(f"<svg {' '.join(attrs)}>")

    # Inline style — same approach as chess.svg (a <defs><style> block keyed on
    # class names so consumers can restyle via CSS overrides).
    css = _build_css(palette, extra=style)
    parts.append("<defs><style><![CDATA[")
    parts.append(css)
    parts.append("]]></style></defs>")

    if borders:
        parts.append(
            f'<rect class="margin" x="0" y="0" width="{total}" height="{total}" '
            f'fill="{palette["margin"]}"/>'
        )

    parts.append(f'<g transform="translate({margin},{margin})">')

    # Determine the lastmove square (if any, and if it's a real move).
    last_sq: Optional[int] = None
    if lastmove is not None and bool(lastmove):
        last_sq = lastmove.to_square

    parts.append(_render_squares(white_bottom, last_sq, palette))
    if coordinates:
        parts.append(_render_coordinates(white_bottom, margin))
    parts.append(_render_discs(board, white_bottom))

    parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


# --- Helpers ----------------------------------------------------------------


def _build_css(palette: Mapping[str, str], extra: Optional[str]) -> str:
    lines = [
        f".square.light {{ fill: {palette['square light']}; }}",
        f".square.dark {{ fill: {palette['square dark']}; }}",
        f".square.light.lastmove {{ fill: {palette['square light lastmove']}; }}",
        f".square.dark.lastmove {{ fill: {palette['square dark lastmove']}; }}",
        f".coord {{ fill: {palette['coord']}; font-family: sans-serif; font-size: 12px; }}",
        f".disc.black {{ fill: {palette['disc black']}; stroke: {palette['disc outline']}; stroke-width: 1; }}",
        f".disc.white {{ fill: {palette['disc white']}; stroke: {palette['disc outline']}; stroke-width: 1; }}",
    ]
    if extra:
        lines.append(extra)
    return "\n".join(lines)


def _square_xy(sq: int, white_bottom: bool) -> tuple[int, int]:
    """Return (x, y) top-left pixel coordinates for ``sq`` given orientation."""
    f = square_file(sq)
    r = square_rank(sq)
    if white_bottom:
        # Rank 1 at the bottom; A-file at the left.
        col = f
        row = 7 - r
    else:
        # Rank 8 at the bottom; H-file at the left.
        col = 7 - f
        row = r
    return col * SQUARE_SIZE, row * SQUARE_SIZE


def _render_squares(white_bottom: bool, last_sq: Optional[int], palette: Mapping[str, str]) -> str:
    parts = ['<g class="squares">']
    for sq in range(64):
        x, y = _square_xy(sq, white_bottom)
        f = square_file(sq)
        r = square_rank(sq)
        shade = "light" if (f + r) % 2 else "dark"
        classes = ["square", shade, SQUARE_NAMES[sq]]
        if last_sq is not None and sq == last_sq:
            classes.append("lastmove")
        parts.append(
            f'<rect class="{" ".join(classes)}" x="{x}" y="{y}" '
            f'width="{SQUARE_SIZE}" height="{SQUARE_SIZE}" '
            f'stroke="none"/>'
        )
    parts.append("</g>")
    return "\n".join(parts)


def _render_coordinates(white_bottom: bool, margin: int) -> str:
    # chess.svg renders coordinates in the gutters outside the board group.
    # We draw them relative to the inner origin (inside the translated group)
    # using negative offsets for the top/left gutters.
    parts = ['<g class="coordinates">']
    files = "abcdefgh" if white_bottom else "hgfedcba"
    ranks = "87654321" if white_bottom else "12345678"

    for i, ch in enumerate(files):
        x = i * SQUARE_SIZE + SQUARE_SIZE // 2
        # Bottom gutter (and top if we wanted — match chess.svg: both).
        parts.append(
            f'<text class="coord file" x="{x}" y="{8 * SQUARE_SIZE + margin - 6}" '
            f'text-anchor="middle">{ch}</text>'
        )
        parts.append(
            f'<text class="coord file" x="{x}" y="{-6}" text-anchor="middle">{ch}</text>'
        )
    for i, ch in enumerate(ranks):
        y = i * SQUARE_SIZE + SQUARE_SIZE // 2 + 4
        parts.append(
            f'<text class="coord rank" x="{-margin + 6}" y="{y}" text-anchor="start">{ch}</text>'
        )
        parts.append(
            f'<text class="coord rank" x="{8 * SQUARE_SIZE + 4}" y="{y}" text-anchor="start">{ch}</text>'
        )
    parts.append("</g>")
    return "\n".join(parts)


def _render_discs(board: Board, white_bottom: bool) -> str:
    parts = ['<g class="pieces">']
    for sq in range(64):
        bit = 1 << sq
        color_cls: Optional[str] = None
        if board.black & bit:
            color_cls = "black"
        elif board.white & bit:
            color_cls = "white"
        if color_cls is None:
            continue
        x, y = _square_xy(sq, white_bottom)
        cx = x + SQUARE_SIZE // 2
        cy = y + SQUARE_SIZE // 2
        parts.append(
            f'<circle class="disc {color_cls}" cx="{cx}" cy="{cy}" '
            f'r="{DISC_RADIUS}"/>'
        )
    parts.append("</g>")
    return "\n".join(parts)


__all__ = ["board", "SQUARE_SIZE", "MARGIN", "DISC_RADIUS", "DEFAULT_COLORS"]
