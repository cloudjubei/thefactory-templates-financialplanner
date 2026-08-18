import { describe, it, expect } from 'vitest'

import type { ContributionPlan, HaircutPolicy, Premium } from './projectionTypes.js'
import {
  annualToPeriodReturn,
  applyAnnualDragToSeries,
  applyPublicationDecay,
  bootstrapReturnPaths,
  buildProjectionFan,
  circularBlockBootstrap,
  createSeededRng,
  netRealReturn,
  percentile,
  probabilityOfSuccess,
  quantilesOf,
  runProjection,
  simulateWealthTrajectory,
  terminalWealths,
  wealthTrajectories,
} from './projectionUtils.js'

/** A deterministic rng that yields the given values in order and throws once exhausted. */
function rngFromSequence(values: number[]): () => number {
  let i = 0
  return () => {
    if (i >= values.length) throw new Error(`rng exhausted after ${values.length} draws`)
    return values[i++]
  }
}

/** mulberry32 — a tiny deterministic PRNG for statistical (tolerance) checks. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('createSeededRng', () => {
  it('is deterministic: the same seed yields the same sequence', () => {
    const a = createSeededRng(42)
    const b = createSeededRng(42)
    const seqA = [a(), a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b(), b()]
    expect(seqA).toEqual(seqB)
  })

  it('yields values within [0,1)', () => {
    const rng = createSeededRng(7)
    for (let i = 0; i < 100; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('different seeds diverge', () => {
    const a = createSeededRng(1)
    const b = createSeededRng(2)
    expect(a()).not.toEqual(b())
  })
})

describe('applyPublicationDecay', () => {
  it('retains exactly the given fraction of a raw premium', () => {
    expect(applyPublicationDecay(0.04, 0.5)).toBeCloseTo(0.02, 12)
  })

  it('retention of 1 leaves the premium unchanged', () => {
    expect(applyPublicationDecay(0.03, 1)).toBeCloseTo(0.03, 12)
  })

  it('retention of 0 removes the premium entirely', () => {
    expect(applyPublicationDecay(0.03, 0)).toBe(0)
  })

  it('rejects a retention above 1 (a premium cannot grow out-of-sample)', () => {
    expect(() => applyPublicationDecay(0.03, 1.2)).toThrow(RangeError)
  })

  it('rejects a negative retention', () => {
    expect(() => applyPublicationDecay(0.03, -0.1)).toThrow(RangeError)
  })

  it('rejects a non-finite retention', () => {
    expect(() => applyPublicationDecay(0.03, Number.NaN)).toThrow(RangeError)
  })
})

describe('netRealReturn', () => {
  const policy: HaircutPolicy = {
    publicationRetention: 0.5,
    annualCostDrag: 0.002,
    annualTaxDrag: 0.001,
  }
  const premiums: Premium[] = [
    { label: 'value', rawAnnual: 0.02 },
    { label: 'quality', rawAnnual: 0.01 },
  ]

  it('decomposes base + haircut premium − costs − taxes', () => {
    const r = netRealReturn({ baseRealReturn: 0.045, premiums, policy })
    expect(r.baseRealReturn).toBeCloseTo(0.045, 12)
    expect(r.grossPremium).toBeCloseTo(0.03, 12)
    expect(r.retainedPremium).toBeCloseTo(0.015, 12)
    expect(r.costDrag).toBeCloseTo(0.002, 12)
    expect(r.taxDrag).toBeCloseTo(0.001, 12)
    expect(r.netRealReturn).toBeCloseTo(0.057, 12)
  })

  it('never publication-haircuts the base market return', () => {
    const r = netRealReturn({ baseRealReturn: 0.045, premiums: [], policy })
    expect(r.retainedPremium).toBe(0)
    expect(r.netRealReturn).toBeCloseTo(0.045 - 0.002 - 0.001, 12)
  })

  it('subtracting the cost drag is load-bearing (guards a dropped-cost mutation)', () => {
    const withCost = netRealReturn({ baseRealReturn: 0.045, premiums: [], policy })
    const noCost = netRealReturn({
      baseRealReturn: 0.045,
      premiums: [],
      policy: { ...policy, annualCostDrag: 0 },
    })
    expect(noCost.netRealReturn - withCost.netRealReturn).toBeCloseTo(0.002, 12)
  })

  it('rejects a negative cost drag (no free lunch)', () => {
    expect(() =>
      netRealReturn({
        baseRealReturn: 0.045,
        premiums: [],
        policy: { ...policy, annualCostDrag: -0.001 },
      }),
    ).toThrow(RangeError)
  })

  it('rejects a negative tax drag', () => {
    expect(() =>
      netRealReturn({
        baseRealReturn: 0.045,
        premiums: [],
        policy: { ...policy, annualTaxDrag: -0.001 },
      }),
    ).toThrow(RangeError)
  })
})

describe('annualToPeriodReturn', () => {
  it('is the identity at one period per year', () => {
    expect(annualToPeriodReturn(0.07, 1)).toBeCloseTo(0.07, 12)
  })

  it('compounds geometrically (0.21 annual over 2 periods = 0.1 each)', () => {
    expect(annualToPeriodReturn(0.21, 2)).toBeCloseTo(0.1, 12)
  })

  it('rejects fewer than one period per year', () => {
    expect(() => annualToPeriodReturn(0.07, 0)).toThrow(RangeError)
  })

  it('rejects an annual return of −100% or worse', () => {
    expect(() => annualToPeriodReturn(-1, 12)).toThrow(RangeError)
  })
})

describe('applyAnnualDragToSeries', () => {
  it('subtracts the per-period equivalent drag from each return', () => {
    expect(applyAnnualDragToSeries([0.01, 0.02], 0.21, 2)).toEqual([
      expect.closeTo(-0.09, 12),
      expect.closeTo(-0.08, 12),
    ])
  })

  it('a zero drag leaves the series unchanged', () => {
    expect(applyAnnualDragToSeries([0.01, -0.02], 0, 12)).toEqual([0.01, -0.02])
  })
})

describe('circularBlockBootstrap', () => {
  it('draws contiguous blocks from the chosen start indices', () => {
    const rng = rngFromSequence([0.0, 0.5])
    expect(circularBlockBootstrap([10, 20, 30, 40], 2, 3, rng)).toEqual([10, 20, 30])
  })

  it('wraps circularly past the end of the series', () => {
    const rng = rngFromSequence([0.9999])
    expect(circularBlockBootstrap([10, 20, 30], 2, 2, rng)).toEqual([30, 10])
  })

  it('returns exactly the requested number of periods', () => {
    const rng = rngFromSequence([0.0, 0.0, 0.0])
    expect(circularBlockBootstrap([1, 2, 3, 4, 5], 2, 5, rng)).toHaveLength(5)
  })

  it('rejects an empty series', () => {
    expect(() => circularBlockBootstrap([], 2, 3, rngFromSequence([0]))).toThrow(RangeError)
  })

  it('rejects a block size below 1', () => {
    expect(() => circularBlockBootstrap([1, 2], 0, 3, rngFromSequence([0]))).toThrow(RangeError)
  })

  it('rejects a non-positive period count', () => {
    expect(() => circularBlockBootstrap([1, 2], 2, 0, rngFromSequence([0]))).toThrow(RangeError)
  })
})

describe('bootstrapReturnPaths', () => {
  it('produces one path per configured path count', () => {
    const rng = rngFromSequence([0.0, 0.5])
    const paths = bootstrapReturnPaths([10, 20, 30, 40], { blockSize: 2, paths: 1 }, 3, rng)
    expect(paths).toEqual([[10, 20, 30]])
  })

  it('draws independent paths in sequence', () => {
    const rng = rngFromSequence([0.0, 0.5])
    const paths = bootstrapReturnPaths([10, 20, 30, 40], { blockSize: 4, paths: 2 }, 4, rng)
    expect(paths).toEqual([
      [10, 20, 30, 40],
      [30, 40, 10, 20],
    ])
  })

  it('rejects a non-positive path count', () => {
    expect(() =>
      bootstrapReturnPaths([10, 20], { blockSize: 1, paths: 0 }, 2, rngFromSequence([0])),
    ).toThrow(RangeError)
  })
})

describe('simulateWealthTrajectory', () => {
  const plan: ContributionPlan = { initial: 100, perPeriod: 10 }

  it('grows then adds the contribution at the end of each period', () => {
    expect(simulateWealthTrajectory([0.5, 0.0], plan)).toEqual([100, 160, 170])
  })

  it('returns a trajectory one longer than the return series', () => {
    expect(simulateWealthTrajectory([0.5, 0.0, 0.25], plan)).toHaveLength(4)
  })

  it('handles withdrawals (a negative contribution)', () => {
    expect(simulateWealthTrajectory([0.0], { initial: 100, perPeriod: -30 })).toEqual([100, 70])
  })
})

describe('wealthTrajectories', () => {
  it('simulates every return path under the same plan', () => {
    const out = wealthTrajectories(
      [
        [0.5, 0.0],
        [0.0, 0.5],
      ],
      { initial: 100, perPeriod: 0 },
    )
    expect(out).toEqual([
      [100, 150, 150],
      [100, 100, 150],
    ])
  })
})

describe('percentile', () => {
  it('linearly interpolates the median of an even-length set', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBeCloseTo(25, 12)
  })

  it('returns the minimum at q=0', () => {
    expect(percentile([40, 10, 30, 20], 0)).toBe(10)
  })

  it('returns the maximum at q=1', () => {
    expect(percentile([40, 10, 30, 20], 1)).toBe(40)
  })

  it('interpolates at the lower quartile', () => {
    expect(percentile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5, 12)
  })

  it('rejects an empty set', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError)
  })

  it('rejects a quantile outside [0,1]', () => {
    expect(() => percentile([1, 2, 3], 1.5)).toThrow(RangeError)
  })
})

describe('quantilesOf', () => {
  it('reports the five-point summary', () => {
    const values = Array.from({ length: 101 }, (_, i) => i) // 0..100
    const q = quantilesOf(values)
    expect(q.p5).toBeCloseTo(5, 12)
    expect(q.p25).toBeCloseTo(25, 12)
    expect(q.p50).toBeCloseTo(50, 12)
    expect(q.p75).toBeCloseTo(75, 12)
    expect(q.p95).toBeCloseTo(95, 12)
  })
})

describe('terminalWealths', () => {
  it('takes the last value of each trajectory', () => {
    expect(
      terminalWealths([
        [100, 120, 130],
        [100, 100, 110],
      ]),
    ).toEqual([130, 110])
  })
})

describe('probabilityOfSuccess', () => {
  it('is the fraction of terminals meeting or exceeding the goal', () => {
    expect(probabilityOfSuccess([100, 200, 300, 400], 250)).toBeCloseTo(0.5, 12)
  })

  it('counts an exact match as success (≥)', () => {
    expect(probabilityOfSuccess([100, 200, 300, 400], 100)).toBe(1)
  })

  it('is zero when no terminal reaches the goal', () => {
    expect(probabilityOfSuccess([100, 200], 500)).toBe(0)
  })

  it('rejects an empty terminal set', () => {
    expect(() => probabilityOfSuccess([], 100)).toThrow(RangeError)
  })
})

describe('buildProjectionFan', () => {
  it('produces one fan point per period across all paths', () => {
    const fan = buildProjectionFan([
      [100, 120, 130],
      [100, 100, 110],
    ])
    expect(fan.map((p) => p.period)).toEqual([0, 1, 2])
    expect(fan[0].quantiles.p50).toBeCloseTo(100, 12)
    expect(fan[2].quantiles.p5).toBeCloseTo(111, 12)
  })

  it('rejects trajectories of differing lengths', () => {
    expect(() => buildProjectionFan([[100, 110], [100]])).toThrow(RangeError)
  })

  it('rejects an empty set of trajectories', () => {
    expect(() => buildProjectionFan([])).toThrow(RangeError)
  })
})

describe('runProjection', () => {
  it('is deterministic wealth when the return series is constant (rng-independent)', () => {
    const result = runProjection({
      series: [0.01, 0.01, 0.01],
      config: { blockSize: 3, paths: 8 },
      horizon: { years: 2, periodsPerYear: 12 },
      plan: { initial: 100, perPeriod: 0 },
      rng: mulberry32(42),
      goal: 120,
    })
    const expectedTerminal = 100 * Math.pow(1.01, 24)
    expect(result.paths).toBe(8)
    expect(result.terminal.p5).toBeCloseTo(expectedTerminal, 6)
    expect(result.terminal.p95).toBeCloseTo(expectedTerminal, 6)
    expect(result.probabilityOfSuccess).toBe(1)
    expect(result.fan).toHaveLength(25)
  })

  it('omits probabilityOfSuccess when no goal is supplied', () => {
    const result = runProjection({
      series: [0.0, 0.0],
      config: { blockSize: 1, paths: 2 },
      horizon: { years: 1, periodsPerYear: 2 },
      plan: { initial: 100, perPeriod: 0 },
      rng: mulberry32(1),
    })
    expect(result.probabilityOfSuccess).toBeUndefined()
  })

  it('reports a P(success) strictly between 0 and 1 for a dispersed outcome', () => {
    const result = runProjection({
      series: [-0.2, 0.25, -0.1, 0.3, 0.05, -0.15],
      config: { blockSize: 2, paths: 400 },
      horizon: { years: 5, periodsPerYear: 12 },
      plan: { initial: 1000, perPeriod: 50 },
      rng: mulberry32(7),
      goal: 6000,
    })
    expect(result.probabilityOfSuccess).toBeGreaterThan(0)
    expect(result.probabilityOfSuccess).toBeLessThan(1)
    expect(result.terminal.p5).toBeLessThan(result.terminal.p95)
  })

  it('rejects a horizon that is not a positive whole number of periods', () => {
    expect(() =>
      runProjection({
        series: [0.01],
        config: { blockSize: 1, paths: 2 },
        horizon: { years: 0, periodsPerYear: 12 },
        plan: { initial: 100, perPeriod: 0 },
        rng: mulberry32(1),
      }),
    ).toThrow(RangeError)
  })

  it('applies terminalTaxRate to the terminal + P(success) but leaves the fan gross (account value)', () => {
    const result = runProjection({
      series: [0.0, 0.0, 0.0],
      config: { blockSize: 1, paths: 4 },
      horizon: { years: 1, periodsPerYear: 12 },
      plan: { initial: 1000, perPeriod: 0 },
      rng: mulberry32(3),
      goal: 800,
      terminalTaxRate: 0.25,
    })
    expect(result.terminal.p50).toBeCloseTo(750, 9)
    expect(result.terminal.p95).toBeCloseTo(750, 9)
    expect(result.fan[result.fan.length - 1].quantiles.p50).toBeCloseTo(1000, 9)
    expect(result.probabilityOfSuccess).toBe(0)
  })

  it('rejects a terminalTaxRate outside [0,1]', () => {
    expect(() =>
      runProjection({
        series: [0.01],
        config: { blockSize: 1, paths: 2 },
        horizon: { years: 1, periodsPerYear: 12 },
        plan: { initial: 100, perPeriod: 0 },
        rng: mulberry32(1),
        terminalTaxRate: 1.5,
      }),
    ).toThrow(RangeError)
  })
})
