import { describe, it, expect, vi } from 'vitest';

// spectral.js imports from app.js (state/on/set/getActiveGame) for the DOM
// renderer paths — none of which are exercised by these pure-math tests.
// Mock the module so the app.js → charts.js → spectral.js cycle can't fire
// during module evaluation.
vi.mock('../js/app.js', () => ({
  state: {},
  on: () => {},
  set: () => {},
  getActiveGame: () => null,
}));

const {
  channelEnergyForPly,
  getOverlayForPly,
  parseEvalString,
  divergingColor,
  CHANNELS,
  CHANNEL_BY_ID,
  OVERLAY_TRANSFORM_IDS,
} = await import('../js/spectral.js');

/** Synthetic 10-channel × 64-mode × N-ply buffer. Channel i mode j at ply p
 *  = (p+1)*0.01 + (i+1)*0.1 + (j % 8)*0.001, with sign flip on every ply
 *  for channel 1 to give delta/z something to work on. */
function makeSyntheticGame(nPlies) {
  const DIM = 640;
  const plies = [];
  for (let p = 0; p < nPlies; p++) {
    const row = new Float32Array(DIM);
    for (let c = 0; c < 10; c++) {
      for (let m = 0; m < 64; m++) {
        let v = (p + 1) * 0.01 + (c + 1) * 0.1 + (m % 8) * 0.001;
        if (c === 1 && p % 2 === 1) v = -v;
        row[c * 64 + m] = v;
      }
    }
    plies.push(row);
  }
  // Rough valueMinMax for rawAbsMax
  const valueMinMax = {};
  for (const ch of CHANNELS) {
    let mn = Infinity, mx = -Infinity;
    for (let p = 0; p < nPlies; p++) {
      for (let m = 0; m < 64; m++) {
        const v = plies[p][ch.index * 64 + m];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    valueMinMax[ch.id] = { min: mn, max: mx };
  }
  return {
    spectral: { plies, nPlies, valueMinMax },
  };
}

describe('channelEnergyForPly', () => {
  it('sums squared modes over the 64-mode window of a channel', () => {
    const modes = new Float32Array(640);
    for (let i = 0; i < 64; i++) modes[64 + i] = 2;  // channel index 1
    // channel 1 energy = 64 * 4 = 256
    expect(channelEnergyForPly(modes, 1)).toBe(256);
    expect(channelEnergyForPly(modes, 0)).toBe(0);
  });

  it('returns 0 for an all-zero ply', () => {
    const modes = new Float32Array(640);
    for (let c = 0; c < 10; c++) expect(channelEnergyForPly(modes, c)).toBe(0);
  });
});

describe('getOverlayForPly — transforms', () => {
  const game = makeSyntheticGame(5);

  it('returns null for a derived view (no single channel)', () => {
    expect(getOverlayForPly(game, 0, 'ALL', 'abs')).toBeNull();
    expect(getOverlayForPly(game, 0, 'FIBER', 'abs')).toBeNull();
  });

  it('returns null when game or spectral is absent', () => {
    expect(getOverlayForPly(null, 0, 'A1', 'abs')).toBeNull();
    expect(getOverlayForPly({}, 0, 'A1', 'abs')).toBeNull();
  });

  it('clamps out-of-range ply to a valid index', () => {
    const neg = getOverlayForPly(game, -10, 'A1', 'abs');
    const huge = getOverlayForPly(game, 99999, 'A1', 'abs');
    expect(neg).not.toBeNull();
    expect(huge).not.toBeNull();
    expect(neg.bySquare.length).toBe(64);
    expect(huge.bySquare.length).toBe(64);
  });

  it('abs transform copies raw mode coefficients', () => {
    const out = getOverlayForPly(game, 2, 'A1', 'abs');
    expect(out.transform).toBe('abs');
    // A1 has index 0 → bySquare[m] should equal plies[2][m]
    for (let m = 0; m < 64; m++) {
      expect(out.bySquare[m]).toBeCloseTo(game.spectral.plies[2][m], 6);
    }
    expect(out.absMax).toBeGreaterThan(0);
  });

  it('delta transform produces zeros at ply 0', () => {
    const out = getOverlayForPly(game, 0, 'A1', 'delta');
    expect(out.transform).toBe('delta');
    for (let m = 0; m < 64; m++) expect(out.bySquare[m]).toBe(0);
  });

  it('delta transform equals plies[p] - plies[p-1]', () => {
    const out = getOverlayForPly(game, 3, 'A2', 'delta');
    const A2 = CHANNEL_BY_ID['A2'].index;
    const cur = game.spectral.plies[3];
    const prev = game.spectral.plies[2];
    for (let m = 0; m < 64; m++) {
      expect(out.bySquare[m]).toBeCloseTo(cur[A2 * 64 + m] - prev[A2 * 64 + m], 6);
    }
  });

  it('log transform is monotone in |v| and sign-preserving', () => {
    const out = getOverlayForPly(game, 2, 'A1', 'log');
    const raw = game.spectral.plies[2];
    for (let m = 0; m < 64; m++) {
      expect(Math.sign(out.bySquare[m])).toBe(Math.sign(raw[m]));
    }
    // Pick two modes with different magnitudes and assert ordering holds.
    let small = 0, large = 0;
    for (let m = 0; m < 64; m++) {
      if (Math.abs(raw[m]) > Math.abs(raw[large])) large = m;
      if (Math.abs(raw[m]) < Math.abs(raw[small])) small = m;
    }
    expect(Math.abs(out.bySquare[large])).toBeGreaterThanOrEqual(Math.abs(out.bySquare[small]));
  });

  it('z transform is centered: mean over plies is ~0 per mode', () => {
    const nPlies = game.spectral.nPlies;
    const sums = new Array(64).fill(0);
    for (let p = 0; p < nPlies; p++) {
      const out = getOverlayForPly(game, p, 'A2', 'z');
      expect(out.transform).toBe('z');
      expect(out.absMax).toBe(3);
      for (let m = 0; m < 64; m++) sums[m] += out.bySquare[m];
    }
    for (const s of sums) expect(Math.abs(s / nPlies)).toBeLessThan(1e-5);
  });

  it('falls back to abs for an unknown transform id', () => {
    const out = getOverlayForPly(game, 1, 'A1', 'nonsense');
    expect(out.transform).toBe('abs');
    expect(OVERLAY_TRANSFORM_IDS).not.toContain('nonsense');
  });
});

describe('parseEvalString', () => {
  it('parses numeric evals', () => {
    expect(parseEvalString('+0.18')).toBeCloseTo(0.18);
    expect(parseEvalString('-1.50')).toBeCloseTo(-1.5);
    expect(parseEvalString('0')).toBe(0);
  });

  it('clamps mate strings to ±10', () => {
    expect(parseEvalString('#3')).toBe(10);
    expect(parseEvalString('#-2')).toBe(-10);
  });

  it('returns null for unparseable input', () => {
    expect(parseEvalString(null)).toBeNull();
    expect(parseEvalString('')).toBeNull();
    expect(parseEvalString('  ')).toBeNull();
    expect(parseEvalString('nonsense')).toBeNull();
  });
});

describe('divergingColor', () => {
  it('maps 0 to a near-black tone', () => {
    const [r, g, b] = divergingColor(0);
    expect(r).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(b).toBeLessThan(20);
  });

  it('maps positive t toward amber (r dominant)', () => {
    const [r, g, b] = divergingColor(1);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it('maps negative t toward cyan (b dominant)', () => {
    const [r, g, b] = divergingColor(-1);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('clamps |t| > 1 to the saturated endpoints', () => {
    expect(divergingColor(5)).toEqual(divergingColor(1));
    expect(divergingColor(-5)).toEqual(divergingColor(-1));
  });
});
