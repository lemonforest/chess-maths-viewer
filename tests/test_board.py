"""Tests for othello.Board covering start position, push/pop symmetry,
forced passes, and terminal detection."""

from __future__ import annotations

import random

import pytest

import othello
from othello import BB_ALL, BB_SQUARES, BLACK, WHITE, Board, Move
from othello._bitboard import legal_moves_bb, popcount


# ---------------------------------------------------------------------------
# Starting position
# ---------------------------------------------------------------------------


def test_start_position_bitboards_and_turn():
    b = Board()
    # D4=white, E5=white, D5=black, E4=black.
    assert b.black == BB_SQUARES[28] | BB_SQUARES[35]
    assert b.white == BB_SQUARES[27] | BB_SQUARES[36]
    assert b.turn is BLACK
    assert popcount(b.black) == 2
    assert popcount(b.white) == 2


def test_start_position_has_four_legal_moves_for_black():
    b = Board()
    moves = list(b.legal_moves)
    assert len(moves) == 4
    assert len(b.legal_moves) == 4
    expected_squares = {othello.D3, othello.C4, othello.F5, othello.E6}
    assert {m.to_square for m in moves} == expected_squares
    # from_square mirrors to_square for Othello drops.
    for m in moves:
        assert m.from_square == m.to_square
        assert bool(m) is True


def test_legal_move_containment_and_bool():
    b = Board()
    assert Move.from_uci("d3") in b.legal_moves
    assert Move.from_uci("a1") not in b.legal_moves
    assert Move.null() not in b.legal_moves
    assert bool(b.legal_moves)


# ---------------------------------------------------------------------------
# Known opening
# ---------------------------------------------------------------------------


def test_push_d3_flips_d4():
    b = Board()
    b.push(Move.from_uci("d3"))

    # Black gained D3 and flipped D4; white lost D4.
    expected_black = (
        BB_SQUARES[othello.D3]
        | BB_SQUARES[othello.D4]
        | BB_SQUARES[othello.D5]
        | BB_SQUARES[othello.E4]
    )
    expected_white = BB_SQUARES[othello.E5]
    assert b.black == expected_black
    assert b.white == expected_white
    assert popcount(b.black) == 4
    assert popcount(b.white) == 1
    assert b.turn is WHITE


def test_push_illegal_raises():
    b = Board()
    with pytest.raises(ValueError):
        b.push(Move.from_uci("a1"))


def test_push_uci_from_move_roundtrip():
    m = Move.from_uci("e6")
    assert m.uci() == "e6"
    assert Move.from_uci("0000") == Move.null()
    assert Move.null().uci() == "0000"


# ---------------------------------------------------------------------------
# Push / pop symmetry under random play
# ---------------------------------------------------------------------------


def test_push_pop_roundtrip_random_walk():
    rng = random.Random(0xC0FFEE)
    b = Board()

    snapshots: list[tuple[int, int, bool]] = []
    pushed: list[Move] = []

    for _ in range(30):
        moves = list(b.legal_moves)
        if not moves:
            break
        snapshots.append((b.black, b.white, b.turn))
        choice = rng.choice(moves)
        b.push(choice)
        pushed.append(choice)

    # Unwind and verify each pop restores the previous snapshot exactly.
    for move in reversed(pushed):
        popped = b.pop()
        assert popped == move
        exp_black, exp_white, exp_turn = snapshots.pop()
        assert b.black == exp_black
        assert b.white == exp_white
        assert b.turn is exp_turn

    # Back to the starting position.
    fresh = Board()
    assert b.black == fresh.black
    assert b.white == fresh.white
    assert b.turn is fresh.turn
    assert b.move_stack == []


# ---------------------------------------------------------------------------
# Forced pass
# ---------------------------------------------------------------------------


def _set_position(board: Board, black_bb: int, white_bb: int, turn: bool) -> None:
    board.black = black_bb & BB_ALL
    board.white = white_bb & BB_ALL
    board.turn = turn
    board.move_stack.clear()
    board._undo_stack.clear()


def test_forced_pass_yields_single_null_move():
    # A1 (black) and B2 (white). Whoever is on the move at B2 has no legal
    # placements because A1 is pinned in the corner, but A1 can place at C3
    # (NE) to flank B2. So white-to-move must pass.
    b = Board()
    _set_position(b, black_bb=BB_SQUARES[othello.A1], white_bb=BB_SQUARES[othello.B2], turn=WHITE)

    # Sanity: the bitboard routines agree with the scenario above.
    assert legal_moves_bb(b.white, b.black) == 0
    assert legal_moves_bb(b.black, b.white) != 0

    moves = list(b.legal_moves)
    assert len(moves) == 1
    assert moves[0] == Move.null()
    assert Move.null() in b.legal_moves
    assert not b.has_legal_moves()

    b.push(Move.null())
    assert b.turn is BLACK
    assert b.black == BB_SQUARES[othello.A1]
    assert b.white == BB_SQUARES[othello.B2]

    popped = b.pop()
    assert popped == Move.null()
    assert b.turn is WHITE


def test_pass_illegal_when_side_has_moves():
    b = Board()  # Black to move at starting position has four legal moves.
    with pytest.raises(ValueError):
        b.push(Move.null())


# ---------------------------------------------------------------------------
# Terminal detection
# ---------------------------------------------------------------------------


def test_is_game_over_when_board_full():
    b = Board()
    _set_position(b, black_bb=0, white_bb=BB_ALL, turn=BLACK)
    assert b.is_game_over() is True
    assert b.result() == "1-0"


def test_is_game_over_when_both_sides_have_no_pieces():
    # No discs anywhere -> neither side can place -> terminal.
    b = Board()
    _set_position(b, black_bb=0, white_bb=0, turn=BLACK)
    assert b.is_game_over() is True
    assert b.result() == "1/2-1/2"


def test_start_position_is_not_game_over():
    assert Board().is_game_over() is False
    assert Board().result() == "*"
