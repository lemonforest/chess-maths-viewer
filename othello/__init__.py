"""Lightweight Othello (Reversi) library that mimics the python-chess API.

This package exposes a :class:`Board` with ``push``, ``pop``, ``legal_moves`` and
``is_game_over``, plus a :class:`Move` type, square constants, and colour flags.
Squares, colours and bitboards follow python-chess conventions:

* ``A1 = 0 ... H8 = 63``; ``file = sq & 7``; ``rank = sq >> 3``.
* ``WHITE = True``, ``BLACK = False``.
* Bitboards are plain Python ints masked to 64 bits.

Note: Othello's first-to-move convention is Black, so ``Board().turn == BLACK``.
"""

from __future__ import annotations

from typing import Iterator, Optional

from ._bitboard import (
    BB_ALL,
    BB_EMPTY,
    flips_bb,
    iter_squares,
    legal_moves_bb,
    popcount,
)

__all__ = [
    "BLACK",
    "WHITE",
    "COLORS",
    "COLOR_NAMES",
    "SQUARES",
    "SQUARE_NAMES",
    "BB_SQUARES",
    "BB_EMPTY",
    "BB_ALL",
    "Move",
    "Board",
    "LegalMoveGenerator",
]

# --- Colours ----------------------------------------------------------------

BLACK = False
WHITE = True
COLORS = [BLACK, WHITE]
COLOR_NAMES = ["black", "white"]

# --- Squares ----------------------------------------------------------------

SQUARES = list(range(64))
SQUARE_NAMES = [f + r for r in "12345678" for f in "abcdefgh"]

# Inject A1..H8 into the module namespace (A1=0, H1=7, A8=56, H8=63).
for _i, _name in enumerate(SQUARE_NAMES):
    globals()[_name.upper()] = _i
del _i, _name

BB_SQUARES = [1 << sq for sq in SQUARES]


def square(file_index: int, rank_index: int) -> int:
    """Return the square index for ``(file, rank)`` with both in 0..7."""
    return (rank_index << 3) | file_index


def square_file(sq: int) -> int:
    return sq & 7


def square_rank(sq: int) -> int:
    return sq >> 3


def square_name(sq: int) -> str:
    return SQUARE_NAMES[sq]


def parse_square(name: str) -> int:
    try:
        return SQUARE_NAMES.index(name.lower())
    except ValueError as exc:
        raise ValueError(f"invalid square name: {name!r}") from exc


# --- Move -------------------------------------------------------------------


class Move:
    """A single Othello move.

    Mirrors the relevant shape of ``chess.Move``: ``from_square`` and
    ``to_square`` are both present, and for a real Othello drop they are equal
    to the placed square. A null move (pass) has ``from_square == to_square ==
    0`` and is falsy (matching ``chess.Move.null()``).
    """

    __slots__ = ("from_square", "to_square", "_null")

    def __init__(self, from_square: int, to_square: int, *, _null: bool = False) -> None:
        self.from_square = from_square
        self.to_square = to_square
        self._null = _null

    @classmethod
    def null(cls) -> "Move":
        return cls(0, 0, _null=True)

    @classmethod
    def from_uci(cls, uci: str) -> "Move":
        if uci == "0000":
            return cls.null()
        if len(uci) != 2:
            raise ValueError(
                f"invalid Othello UCI: {uci!r} (expected a single square like 'e3' or '0000')"
            )
        sq = parse_square(uci)
        return cls(sq, sq)

    def uci(self) -> str:
        if self._null:
            return "0000"
        return SQUARE_NAMES[self.to_square]

    def __bool__(self) -> bool:
        return not self._null

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Move):
            return NotImplemented
        return (
            self._null == other._null
            and self.from_square == other.from_square
            and self.to_square == other.to_square
        )

    def __hash__(self) -> int:
        if self._null:
            return hash(("null",))
        return hash((self.from_square, self.to_square))

    def __repr__(self) -> str:
        return f"Move.from_uci({self.uci()!r})"

    def __str__(self) -> str:
        return self.uci()


# --- Legal move generator ---------------------------------------------------


class LegalMoveGenerator:
    """Iterable/container of legal moves for a given :class:`Board` state.

    Matches the shape of ``chess.LegalMoveGenerator``: supports ``iter``,
    ``len`` and ``in``. Yields :class:`Move` objects. If the side to move has
    no placements but the opponent does, yields a single null (pass) move.
    """

    def __init__(self, board: "Board") -> None:
        self.board = board

    def _bb(self) -> int:
        own, opp = self.board._own_opp()
        return legal_moves_bb(own, opp)

    def _opp_has_moves(self) -> bool:
        own, opp = self.board._own_opp()
        return legal_moves_bb(opp, own) != 0

    def __iter__(self) -> Iterator[Move]:
        bb = self._bb()
        if bb:
            for sq in iter_squares(bb):
                yield Move(sq, sq)
        elif self._opp_has_moves():
            yield Move.null()

    def __len__(self) -> int:
        bb = self._bb()
        if bb:
            return popcount(bb)
        return 1 if self._opp_has_moves() else 0

    def __contains__(self, move: object) -> bool:
        if not isinstance(move, Move):
            return False
        bb = self._bb()
        if move._null:
            return bb == 0 and self._opp_has_moves()
        return bool(bb & BB_SQUARES[move.to_square])

    def __bool__(self) -> bool:
        return len(self) > 0

    def __repr__(self) -> str:
        moves = ", ".join(m.uci() for m in self)
        return f"<LegalMoveGenerator ({moves})>"


# --- Board ------------------------------------------------------------------


class Board:
    """Othello board state with push/pop semantics modelled on ``chess.Board``.

    Two bitboards (``black``, ``white``) hold the disc positions; ``turn``
    indicates the side to move (``BLACK`` or ``WHITE``). A parallel undo stack
    records each move's placed bit, flipped mask, and prior turn so ``pop``
    can fully reverse a ``push`` — including null (pass) moves.
    """

    # Starting position: D4=white, E5=white, D5=black, E4=black.
    _START_BLACK = BB_SQUARES[28] | BB_SQUARES[35]   # E4, D5
    _START_WHITE = BB_SQUARES[27] | BB_SQUARES[36]   # D4, E5

    def __init__(self) -> None:
        self.black: int = self._START_BLACK
        self.white: int = self._START_WHITE
        self.turn: bool = BLACK
        self.move_stack: list[Move] = []
        # Each entry: (placed_bb, flipped_bb, prev_turn). placed_bb == 0 marks a pass.
        self._undo_stack: list[tuple[int, int, bool]] = []

    # -- bitboard access -----------------------------------------------------

    @property
    def occupied(self) -> int:
        return self.black | self.white

    def pieces(self, color: bool) -> int:
        return self.white if color else self.black

    def _own_opp(self) -> tuple[int, int]:
        if self.turn == BLACK:
            return self.black, self.white
        return self.white, self.black

    # -- move generation -----------------------------------------------------

    @property
    def legal_moves(self) -> LegalMoveGenerator:
        return LegalMoveGenerator(self)

    def has_legal_moves(self) -> bool:
        own, opp = self._own_opp()
        return legal_moves_bb(own, opp) != 0

    def is_legal(self, move: Move) -> bool:
        return move in self.legal_moves

    # -- push / pop ----------------------------------------------------------

    def push(self, move: Move) -> None:
        prev_turn = self.turn
        own, opp = self._own_opp()

        if move._null:
            # A pass is only legal if the side to move has no placements but
            # the opponent does. Enforce this to match python-chess's habit of
            # rejecting obviously wrong moves.
            if legal_moves_bb(own, opp) != 0 or legal_moves_bb(opp, own) == 0:
                raise ValueError("null move is only legal as a forced pass")
            self._undo_stack.append((0, 0, prev_turn))
            self.move_stack.append(move)
            self.turn = not self.turn
            return

        placed = BB_SQUARES[move.to_square]
        if not (placed & legal_moves_bb(own, opp)):
            raise ValueError(f"illegal Othello move: {move.uci()}")

        flipped = flips_bb(placed, own, opp)
        new_own = own | placed | flipped
        new_opp = opp & ~flipped

        if self.turn == BLACK:
            self.black, self.white = new_own, new_opp
        else:
            self.white, self.black = new_own, new_opp

        self._undo_stack.append((placed, flipped, prev_turn))
        self.move_stack.append(move)
        self.turn = not self.turn

    def pop(self) -> Move:
        placed, flipped, prev_turn = self._undo_stack.pop()
        move = self.move_stack.pop()

        if placed == 0:
            # Null / pass — just restore the turn.
            self.turn = prev_turn
            return move

        if prev_turn == BLACK:
            # Black moved: remove placed from black, return flipped from black to white.
            self.black = (self.black & ~placed) & ~flipped
            self.white = self.white | flipped
        else:
            self.white = (self.white & ~placed) & ~flipped
            self.black = self.black | flipped

        self.turn = prev_turn
        return move

    # -- terminal / result ---------------------------------------------------

    def is_game_over(self) -> bool:
        return (
            legal_moves_bb(self.black, self.white) == 0
            and legal_moves_bb(self.white, self.black) == 0
        )

    def result(self) -> str:
        if not self.is_game_over():
            return "*"
        b = popcount(self.black)
        w = popcount(self.white)
        if b > w:
            # Black wins. python-chess uses "0-1" for black-wins-in-chess; keep
            # the same mapping of "WHITE = 1-0" for API parity.
            return "0-1"
        if w > b:
            return "1-0"
        return "1/2-1/2"

    # -- misc ---------------------------------------------------------------

    def copy(self) -> "Board":
        new = Board.__new__(Board)
        new.black = self.black
        new.white = self.white
        new.turn = self.turn
        new.move_stack = list(self.move_stack)
        new._undo_stack = list(self._undo_stack)
        return new

    def __repr__(self) -> str:
        rows = []
        for r in range(7, -1, -1):
            row = [str(r + 1), " "]
            for f in range(8):
                bit = 1 << ((r << 3) | f)
                if self.black & bit:
                    row.append("B")
                elif self.white & bit:
                    row.append("W")
                else:
                    row.append(".")
                row.append(" ")
            rows.append("".join(row).rstrip())
        rows.append("  a b c d e f g h")
        turn = "black" if self.turn == BLACK else "white"
        rows.append(f"turn: {turn}")
        return "\n".join(rows)
