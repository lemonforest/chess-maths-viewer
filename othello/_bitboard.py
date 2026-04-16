"""Low-level bitboard helpers for Othello.

All bitboards are plain Python ints masked to 64 bits. Square indexing
matches python-chess: A1=0, H1=7, A8=56, H8=63 (file = sq & 7, rank = sq >> 3).
"""

from __future__ import annotations

BB_EMPTY = 0
BB_ALL = 0xFFFF_FFFF_FFFF_FFFF
BB_FILE_A = 0x0101_0101_0101_0101
BB_FILE_H = 0x8080_8080_8080_8080

# (shift, pre_mask) — pre_mask zeroes source squares that would wrap across an
# edge for the given direction. Shift is signed: positive = left shift, negative
# = right shift.
DIRECTIONS: tuple[tuple[int, int], ...] = (
    (+8, BB_ALL),                    # N
    (-8, BB_ALL),                    # S
    (+1, BB_ALL ^ BB_FILE_H),        # E
    (-1, BB_ALL ^ BB_FILE_A),        # W
    (+9, BB_ALL ^ BB_FILE_H),        # NE
    (+7, BB_ALL ^ BB_FILE_A),        # NW
    (-7, BB_ALL ^ BB_FILE_H),        # SE
    (-9, BB_ALL ^ BB_FILE_A),        # SW
)


def _shift(bb: int, s: int) -> int:
    if s >= 0:
        return (bb << s) & BB_ALL
    return bb >> -s


def legal_moves_bb(own: int, opp: int) -> int:
    """Return the bitboard of legal drop squares for the player with ``own``.

    Classic directional fill: in each direction, step off an own square into a
    chain of opponent squares (up to six long), and mark any empty square
    immediately beyond the far end of the chain.
    """
    empty = ~(own | opp) & BB_ALL
    moves = 0
    for shift, mask in DIRECTIONS:
        x = _shift(own & mask, shift) & opp
        # Max chain length = 6 opponent discs on an 8x8 board, so 5 extensions.
        for _ in range(5):
            x |= _shift(x & mask, shift) & opp
        moves |= _shift(x & mask, shift) & empty
    return moves


def flips_bb(move_bb: int, own: int, opp: int) -> int:
    """Return the bitboard of opponent discs flipped by placing ``move_bb``.

    ``move_bb`` must be a single-bit bitboard representing the drop square.
    Caller is responsible for ensuring the move is legal; this routine simply
    walks each direction and flips opponent runs that terminate at an own disc.
    """
    flipped = 0
    for shift, mask in DIRECTIONS:
        line = 0
        x = _shift(move_bb & mask, shift) & opp
        while x:
            line |= x
            nxt = _shift(x & mask, shift)
            if nxt & own:
                flipped |= line
                break
            x = nxt & opp
    return flipped


def popcount(bb: int) -> int:
    return bin(bb).count("1")


def iter_squares(bb: int):
    """Yield square indices (0..63) of set bits in ``bb``, low to high."""
    while bb:
        lsb = bb & -bb
        yield lsb.bit_length() - 1
        bb ^= lsb
