import { describe, it, expect } from 'vitest'

import type { SleeveKey } from '../allocation/allocationTypes.js'
import { createSeededRng } from '../projection/projectionUtils.js'
import { GOAL_PROBABILITY_CAVEAT, SUITABILITY_CAP_CAVEAT } from './financialPlanConstants.js'
import type { FinancialPlanRequest } from './financialPlanTypes.js'
import {
  blendReturnSeries,
  composeFinancialPlan,
  deriveTiltEvidence,
  solvePlanContribution,
} from './financialPlanUtils.js'

const SERIES_24: number[] = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0.03 : -0.02))
const BOND_24: number[] = Array.from({ length: 24 }, () => 0.001)

function baseRequest(overrides: Partial<FinancialPlanRequest> = {}): FinancialPlanRequest {
  return {
    profile: {
      horizonYears: 15,
      riskTolerance: 'balanced',
      phase: 'accumulation',
      tiltAppetite: 1,
    },
    goal: { targetAmount: 20000, horizonYears: 15 },
    contributions: { initial: 1000, perPeriod: 50 },
    sleeveReturns: {
      globalEquityCore: SERIES_24,
      valueQualityTilt: SERIES_24,
      trendFollowing: SERIES_24,
      shortDurationBonds: BOND_24,
    },
    config: { blockSize: 6, paths: 200 },
    periodsPerYear: 12,
    tiltPremium: { rawAnnualPremium: 0.03, publicationRetention: 0.5, incrementalCost: 0.005 },
    ...overrides,
  }
}

describe('deriveTiltEvidence', () => {
  it('haircuts the raw premium then nets the incremental cost', () => {
    const e = deriveTiltEvidence({
      rawAnnualPremium: 0.03,
      publicationRetention: 0.5,
      incrementalCost: 0.005,
    })
    expect(e.netAnnualPremium).toBeCloseTo(0.01, 12)
  })

  it('can net to a non-positive premium (which the allocator then refuses)', () => {
    const e = deriveTiltEvidence({
      rawAnnualPremium: 0.01,
      publicationRetention: 0.5,
      incrementalCost: 0.01,
    })
    expect(e.netAnnualPremium).toBeLessThanOrEqual(0)
  })

  it('rejects a negative incremental cost', () => {
    expect(() =>
      deriveTiltEvidence({
        rawAnnualPremium: 0.03,
        publicationRetention: 0.5,
        incrementalCost: -0.001,
      }),
    ).toThrow(RangeError)
  })

  it('propagates the publication-retention guard', () => {
    expect(() =>
      deriveTiltEvidence({ rawAnnualPremium: 0.03, publicationRetention: 1.5, incrementalCost: 0 }),
    ).toThrow(RangeError)
  })
})

describe('blendReturnSeries', () => {
  it('is the per-period weighted sum of the sleeve series', () => {
    const blended = blendReturnSeries(
      { globalEquityCore: 0.5, shortDurationBonds: 0.5 },
      { globalEquityCore: [0.02, 0.04], shortDurationBonds: [0.0, 0.0] },
    )
    expect(blended[0]).toBeCloseTo(0.01, 12)
    expect(blended[1]).toBeCloseTo(0.02, 12)
  })

  it('skips zero-weight sleeves that supply no series', () => {
    const blended = blendReturnSeries(
      { globalEquityCore: 1, valueQualityTilt: 0 },
      { globalEquityCore: [0.01, 0.02] },
    )
    expect(blended).toEqual([0.01, 0.02])
  })

  it('treats an explicitly-undefined weight as absent', () => {
    const blended = blendReturnSeries(
      { globalEquityCore: 1, valueQualityTilt: undefined },
      { globalEquityCore: [0.01, 0.02] },
    )
    expect(blended).toEqual([0.01, 0.02])
  })

  it('rejects a positive-weight sleeve with no series', () => {
    expect(() => blendReturnSeries({ globalEquityCore: 1 }, {})).toThrow(RangeError)
  })

  it('rejects sleeve series of differing lengths', () => {
    expect(() =>
      blendReturnSeries(
        { globalEquityCore: 0.5, shortDurationBonds: 0.5 },
        { globalEquityCore: [0.01, 0.02], shortDurationBonds: [0.01] },
      ),
    ).toThrow(RangeError)
  })

  it('rejects an all-zero weight set (nothing to blend)', () => {
    const weights: Partial<Record<SleeveKey, number>> = {
      globalEquityCore: 0,
      shortDurationBonds: 0,
    }
    expect(() =>
      blendReturnSeries(weights, { globalEquityCore: [0.01], shortDurationBonds: [0.0] }),
    ).toThrow(RangeError)
  })
})

describe('composeFinancialPlan', () => {
  it('assembles an allocation whose weights sum to 1', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    const sum = plan.allocation.sleeves.reduce((s, x) => s + x.weight, 0)
    expect(sum).toBeCloseTo(1, 9)
  })

  it('resolves suitability to the effective (more conservative) bucket', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.suitability.willingness).toBe('balanced')
    expect(plan.suitability.ability).toBe('adventurous')
    expect(plan.suitability.effective).toBe('balanced')
    expect(plan.suitability.binding).toBe('willingness')
    expect(plan.caveats).not.toContain(SUITABILITY_CAP_CAVEAT)
  })

  it('caps the allocation to horizon-derived capacity when appetite exceeds ability', () => {
    const capped = composeFinancialPlan(
      baseRequest({
        profile: {
          horizonYears: 1,
          riskTolerance: 'adventurous',
          phase: 'accumulation',
          tiltAppetite: 1,
        },
        goal: { targetAmount: 20000, horizonYears: 1 },
      }),
      createSeededRng(1),
    )
    const eager = composeFinancialPlan(
      baseRequest({
        profile: {
          horizonYears: 25,
          riskTolerance: 'adventurous',
          phase: 'accumulation',
          tiltAppetite: 1,
        },
      }),
      createSeededRng(1),
    )
    expect(capped.suitability.effective).toBe('cautious')
    expect(capped.suitability.binding).toBe('ability')
    expect(capped.caveats).toContain(SUITABILITY_CAP_CAVEAT)
    expect(capped.allocation.equityShare).toBeLessThan(eager.allocation.equityShare)
  })

  it('reports a funded status assessed against the goal', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.fundedStatus.target).toBe(20000)
    expect(['on-track', 'at-risk', 'shortfall']).toContain(plan.fundedStatus.verdict)
    expect(plan.fundedStatus.fundedRatio).toBeGreaterThan(0)
  })

  it('lets a positive haircut premium size the tilt', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    const tilt = plan.allocation.sleeves.find((s) => s.sleeve === 'valueQualityTilt')?.weight ?? 0
    expect(tilt).toBeGreaterThan(0)
  })

  it('refuses the tilt (and needs no tilt series) when no premium is supplied', () => {
    const plan = composeFinancialPlan(
      baseRequest({
        tiltPremium: undefined,
        sleeveReturns: { globalEquityCore: SERIES_24, shortDurationBonds: BOND_24 },
      }),
      createSeededRng(1),
    )
    const tilt =
      plan.allocation.sleeves.find((s) => s.sleeve === 'valueQualityTilt')?.weight ?? Number.NaN
    expect(tilt).toBe(0)
  })

  it('projects a fan across the whole horizon plus the starting point', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.projection.fan).toHaveLength(15 * 12 + 1)
  })

  it('scores the projection against the goal with a probability in [0,1]', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.projection.probabilityOfSuccess).toBeGreaterThanOrEqual(0)
    expect(plan.projection.probabilityOfSuccess).toBeLessThanOrEqual(1)
  })

  it('carries the allocation caveats plus the goal-probability caveat', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.caveats).toContain(GOAL_PROBABILITY_CAVEAT)
    expect(plan.caveats.length).toBeGreaterThan(1)
  })

  it('is reproducible for the same seed', () => {
    const a = composeFinancialPlan(baseRequest(), createSeededRng(42))
    const b = composeFinancialPlan(baseRequest(), createSeededRng(42))
    expect(a.projection.terminal).toEqual(b.projection.terminal)
  })

  it('propagates a sleeve-series length mismatch', () => {
    expect(() =>
      composeFinancialPlan(
        baseRequest({
          sleeveReturns: {
            globalEquityCore: SERIES_24,
            valueQualityTilt: SERIES_24,
            trendFollowing: SERIES_24,
            shortDurationBonds: [0.001],
          },
        }),
        createSeededRng(1),
      ),
    ).toThrow(RangeError)
  })

  it('attaches the wrapper-tax caveat when a wrapper is applied', () => {
    const plan = composeFinancialPlan(
      baseRequest({
        wrapper: { wrapper: 'eet', marginalContributionRate: 0.2, withdrawalTaxRate: 0.15 },
      }),
      createSeededRng(1),
    )
    expect(plan.caveats.some((c) => /wrapper/i.test(c))).toBe(true)
  })

  it('leaves caveats free of a wrapper note when no wrapper is applied', () => {
    const plan = composeFinancialPlan(baseRequest(), createSeededRng(1))
    expect(plan.caveats.some((c) => /wrapper/i.test(c))).toBe(false)
  })

  it("EET's withdrawal tax scales the terminal by (1 − rate) vs a tax-free wrapper, all else equal", () => {
    const req = baseRequest({ contributions: { initial: 1000, perPeriod: 0 } })
    const tee = composeFinancialPlan({ ...req, wrapper: { wrapper: 'tee' } }, createSeededRng(9))
    const eet = composeFinancialPlan(
      {
        ...req,
        wrapper: { wrapper: 'eet', marginalContributionRate: 0.2, withdrawalTaxRate: 0.15 },
      },
      createSeededRng(9),
    )
    expect(eet.projection.terminal.p50).toBeCloseTo(tee.projection.terminal.p50 * 0.85, 6)
  })

  it('a taxable wrapper with a growth-tax rate drags the series below the tax-free terminal', () => {
    const req = baseRequest({ contributions: { initial: 1000, perPeriod: 0 } })
    const tee = composeFinancialPlan({ ...req, wrapper: { wrapper: 'tee' } }, createSeededRng(11))
    const taxable = composeFinancialPlan(
      { ...req, wrapper: { wrapper: 'taxable', annualGrowthTaxRate: 0.02 } },
      createSeededRng(11),
    )
    expect(taxable.projection.terminal.p50).toBeLessThan(tee.projection.terminal.p50)
  })
})

describe('solvePlanContribution', () => {
  it('solves a contribution that, fed back into the plan, clears the target probability', () => {
    const req = baseRequest({ seed: 1, goal: { targetAmount: 30000, horizonYears: 15 } })
    const solved = solvePlanContribution(req, { targetSuccess: 0.7 })
    expect(solved.achievable).toBe(true)
    const roundTrip = composeFinancialPlan(
      { ...req, contributions: { ...req.contributions, perPeriod: solved.perPeriod } },
      createSeededRng(1),
    )
    expect(roundTrip.projection.probabilityOfSuccess).toBeGreaterThanOrEqual(0.7)
  })

  it('needs a larger contribution for a bigger goal', () => {
    const small = solvePlanContribution(
      baseRequest({ seed: 1, goal: { targetAmount: 25000, horizonYears: 15 } }),
      { targetSuccess: 0.7 },
    )
    const big = solvePlanContribution(
      baseRequest({ seed: 1, goal: { targetAmount: 60000, horizonYears: 15 } }),
      { targetSuccess: 0.7 },
    )
    expect(big.perPeriod).toBeGreaterThan(small.perPeriod)
  })

  it('reports not achievable when the goal exceeds the affordability ceiling', () => {
    const solved = solvePlanContribution(
      baseRequest({ seed: 1, goal: { targetAmount: 5_000_000, horizonYears: 15 } }),
      { targetSuccess: 0.8, maxPerPeriod: 25 },
    )
    expect(solved.achievable).toBe(false)
    expect(solved.perPeriod).toBeCloseTo(25, 6)
  })
})
