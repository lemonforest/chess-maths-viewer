"""Tests for othello.svg.board()."""

from __future__ import annotations

import re
from xml.etree import ElementTree as ET

import othello
from othello import Board, Move
from othello.svg import DISC_RADIUS, MARGIN, SQUARE_SIZE, board as svg_board


SVG_NS = {"svg": "http://www.w3.org/2000/svg"}


def _parse(svg: str) -> ET.Element:
    # Strip the XML declaration so fromstring accepts it, then parse with
    # the SVG namespace in place.
    body = svg.split("?>", 1)[1] if svg.startswith("<?xml") else svg
    return ET.fromstring(body)


def test_default_viewbox_dimensions():
    svg = svg_board(Board())
    root = _parse(svg)
    # 8 squares * 45 + 2 * 20 margin = 400
    expected = 8 * SQUARE_SIZE + 2 * MARGIN
    assert root.get("viewBox") == f"0 0 {expected} {expected}"


def test_viewbox_without_coordinates_has_no_margin():
    svg = svg_board(Board(), coordinates=False)
    root = _parse(svg)
    expected = 8 * SQUARE_SIZE
    assert root.get("viewBox") == f"0 0 {expected} {expected}"


def test_size_attribute_sets_fixed_dimensions():
    svg = svg_board(Board(), size=360)
    root = _parse(svg)
    assert root.get("width") == "360"
    assert root.get("height") == "360"


def test_draws_sixty_four_squares_with_correct_classes():
    svg = svg_board(Board())
    root = _parse(svg)
    squares = root.findall(".//svg:g[@class='squares']/svg:rect", SVG_NS)
    assert len(squares) == 64
    # Every rect must carry "square" + a shade + the square name.
    shades = {"light", "dark"}
    for rect in squares:
        classes = set((rect.get("class") or "").split())
        assert "square" in classes
        assert classes & shades, rect.get("class")


def test_starting_position_draws_four_discs():
    svg = svg_board(Board())
    root = _parse(svg)
    discs = root.findall(".//svg:g[@class='pieces']/svg:circle", SVG_NS)
    assert len(discs) == 4
    # Two black, two white, all at radius DISC_RADIUS.
    by_class = {}
    for d in discs:
        c = d.get("class") or ""
        by_class.setdefault(c, 0)
        by_class[c] += 1
        assert d.get("r") == str(DISC_RADIUS)
    assert by_class.get("disc black") == 2
    assert by_class.get("disc white") == 2


def test_css_style_block_includes_class_rules():
    svg = svg_board(Board())
    # We use <style>…</style>; chess.svg-style class rules should be present.
    assert ".square.light" in svg
    assert ".square.dark" in svg
    assert ".disc.black" in svg
    assert ".disc.white" in svg
    assert ".coord" in svg


def test_coordinate_labels_rendered_when_coordinates_true():
    svg = svg_board(Board(), coordinates=True)
    # Files a-h and ranks 1-8 should appear at least once each.
    for ch in "abcdefgh12345678":
        assert f">{ch}</text>" in svg


def test_coordinate_labels_omitted_when_coordinates_false():
    svg = svg_board(Board(), coordinates=False)
    assert "class=\"coordinates\"" not in svg and "class='coordinates'" not in svg


def test_lastmove_highlights_target_square():
    b = Board()
    m = Move.from_uci("d3")
    b.push(m)
    svg = svg_board(b, lastmove=m)
    # There must be exactly one rect carrying both "lastmove" and "d3" classes.
    root = _parse(svg)
    hits = [
        r for r in root.findall(".//svg:g[@class='squares']/svg:rect", SVG_NS)
        if {"lastmove", "d3"}.issubset(set((r.get("class") or "").split()))
    ]
    assert len(hits) == 1


def test_null_lastmove_is_ignored():
    svg = svg_board(Board(), lastmove=Move.null())
    # The CSS rule for .lastmove always appears in the <style> block; what we
    # care about is that no rect element carries the class.
    root = _parse(svg)
    hits = [
        r for r in root.findall(".//svg:g[@class='squares']/svg:rect", SVG_NS)
        if "lastmove" in (r.get("class") or "").split()
    ]
    assert hits == []


def test_orientation_flips_coordinate_order():
    svg_white = svg_board(Board(), orientation=othello.WHITE)
    svg_black = svg_board(Board(), orientation=othello.BLACK)
    # When black is at the bottom, the first file label encountered should be "h".
    file_labels_white = re.findall(
        r'<text class="coord file"[^>]*>([a-h])</text>', svg_white
    )
    file_labels_black = re.findall(
        r'<text class="coord file"[^>]*>([a-h])</text>', svg_black
    )
    # First label in both orientations is "a" vs "h".
    assert file_labels_white[0] == "a"
    assert file_labels_black[0] == "h"


def test_colors_override_merges_with_defaults():
    svg = svg_board(Board(), colors={"disc black": "#ff0000"})
    assert "#ff0000" in svg
    # Default values should still be present for keys we didn't override.
    assert "#ffce9e" in svg  # square light default
