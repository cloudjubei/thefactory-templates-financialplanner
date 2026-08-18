import { describe, it, expect } from 'vitest'

import { createFinancialPlanTools } from './FinancialPlanTools.js'
import type { FinancialPlanRequest } from './financialPlanTypes.js'

const SERIES_24: number[] = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0.03 : -0.02))

function request(overrides: Partial<FinancialPlanRequest> = {}): FinancialPlanRequest {
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
      shortDurationBonds: SERIES_24,
    },
    config: { blockSize: 6, paths: 150 },
    periodsPerYear: 12,
    tiltPremium: { rawAnnualPremium: 0.03, publicationRetention: 0.5, incrementalCost: 0.005 },
    ...overrides,
  }
}

describe('createFinancialPlanTools.buildFinancialPlan', () => {
  it('builds a plan with an allocation and a projection', () => {
    const plan = createFinancialPlanTools().buildFinancialPlan(request({ seed: 1 }))
    expect(plan.allocation.sleeves).toHaveLength(4)
    expect(plan.projection.probabilityOfSuccess).toBeGreaterThanOrEqual(0)
  })

  it('is reproducible when a seed is supplied', () => {
    const a = createFinancialPlanTools().buildFinancialPlan(request({ seed: 7 }))
    const b = createFinancialPlanTools().buildFinancialPlan(request({ seed: 7 }))
    expect(a.projection).toEqual(b.projection)
  })

  it('falls back to the injected default rng when no seed is given', () => {
    let calls = 0
    const defaultRng = () => {
      calls++
      return 0.5
    }
    const plan = createFinancialPlanTools({ defaultRng }).buildFinancialPlan(
      request({ seed: undefined }),
    )
    expect(calls).toBeGreaterThan(0)
    expect(plan.projection.paths).toBe(150)
  })

  it('propagates a validation error from the composition', () => {
    expect(() =>
      createFinancialPlanTools().buildFinancialPlan(
        request({ seed: 1, sleeveReturns: { globalEquityCore: [0.01] } }),
      ),
    ).toThrow(RangeError)
  })
})
