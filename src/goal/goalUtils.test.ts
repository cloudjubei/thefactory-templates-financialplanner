import { describe, it, expect } from 'vitest'

import type { ProjectionResult } from '../projection/projectionTypes.js'
import { assessFundedStatus, solveRequiredContribution } from './goalUtils.js'
import { createGoalTools } from './GoalTools.js'

function projection(p50: number, prob: number | undefined): ProjectionResult {
  return {
    terminal: { p5: p50 * 0.5, p25: p50 * 0.8, p50, p75: p50 * 1.2, p95: p50 * 1.6 },
    fan: [],
    probabilityOfSuccess: prob,
    paths: 1000,
  }
}

describe('assessFundedStatus', () => {
  it('is on-track when the median clears the target with high probability', () => {
    const s = assessFundedStatus(projection(120000, 0.9), 100000)
    expect(s.verdict).toBe('on-track')
    expect(s.fundedRatio).toBeCloseTo(1.2, 6)
    expect(s.medianShortfall).toBe(0)
  })

  it('is at-risk when the median clears the target but the probability is low', () => {
    expect(assessFundedStatus(projection(105000, 0.6), 100000).verdict).toBe('at-risk')
  })

  it('is a shortfall when the median misses the target', () => {
    const s = assessFundedStatus(projection(80000, 0.3), 100000)
    expect(s.verdict).toBe('shortfall')
    expect(s.medianShortfall).toBe(20000)
  })

  it('falls back to the median when the projection carries no probability', () => {
    expect(assessFundedStatus(projection(120000, undefined), 100000).verdict).toBe('on-track')
    expect(assessFundedStatus(projection(80000, undefined), 100000).verdict).toBe('shortfall')
  })

  it('rejects a non-positive target', () => {
    expect(() => assessFundedStatus(projection(1, 0.5), 0)).toThrow(RangeError)
    expect(() => assessFundedStatus(projection(1, 0.5), -5)).toThrow(RangeError)
  })
})

describe('solveRequiredContribution', () => {
  const base = {
    config: { blockSize: 1, paths: 200 },
    horizon: { years: 10, periodsPerYear: 12 },
    seed: 7,
  }

  it('finds the analytic contribution on a zero-volatility series', () => {
    // zero returns → terminal = initial + perPeriod × 120. target 12000, initial 0 → 100/period.
    const r = solveRequiredContribution({
      ...base,
      series: [0, 0, 0, 0],
      initial: 0,
      target: 12000,
      targetSuccess: 0.8,
    })
    expect(r.perPeriod).toBeCloseTo(100, 0)
    expect(r.achievable).toBe(true)
    expect(r.achievedSuccess).toBeGreaterThanOrEqual(0.8)
  })

  it('uses the default target success and seed when neither is given', () => {
    const r = solveRequiredContribution({
      series: [0, 0, 0, 0],
      config: { blockSize: 1, paths: 200 },
      horizon: { years: 10, periodsPerYear: 12 },
      initial: 0,
      target: 12000,
    })
    expect(r.targetSuccess).toBe(0.8)
    expect(r.perPeriod).toBeCloseTo(100, 0)
  })

  it('needs less than the zero-return amount when returns are positive', () => {
    const r = solveRequiredContribution({
      ...base,
      series: [0.01, 0.008, 0.012, 0.009],
      initial: 0,
      target: 12000,
      targetSuccess: 0.8,
    })
    expect(r.perPeriod).toBeLessThan(100)
    expect(r.achievable).toBe(true)
  })

  it('returns 0 when the initial balance already funds the goal', () => {
    const r = solveRequiredContribution({
      ...base,
      series: [0, 0, 0, 0],
      initial: 20000,
      target: 12000,
      targetSuccess: 0.8,
    })
    expect(r.perPeriod).toBe(0)
  })

  it('reports not achievable when the required contribution exceeds the affordability ceiling', () => {
    const r = solveRequiredContribution({
      ...base,
      series: [0, 0, 0, 0],
      initial: 0,
      target: 1_000_000,
      targetSuccess: 0.8,
      maxPerPeriod: 50,
    })
    expect(r.achievable).toBe(false)
    expect(r.perPeriod).toBe(50)
  })

  it('is monotone: a higher target needs a higher contribution', () => {
    const lo = solveRequiredContribution({
      ...base,
      series: [0, 0, 0, 0],
      initial: 0,
      target: 12000,
      targetSuccess: 0.8,
    })
    const hi = solveRequiredContribution({
      ...base,
      series: [0, 0, 0, 0],
      initial: 0,
      target: 24000,
      targetSuccess: 0.8,
    })
    expect(hi.perPeriod).toBeGreaterThan(lo.perPeriod)
  })

  it('rejects an out-of-range target success', () => {
    const bad = { ...base, series: [0], initial: 0, target: 1 }
    expect(() => solveRequiredContribution({ ...bad, targetSuccess: 0 })).toThrow(RangeError)
    expect(() => solveRequiredContribution({ ...bad, targetSuccess: 1 })).toThrow(RangeError)
  })

  it('rejects a non-positive affordability ceiling', () => {
    expect(() =>
      solveRequiredContribution({
        ...base,
        series: [0],
        initial: 0,
        target: 1,
        maxPerPeriod: 0,
      }),
    ).toThrow(RangeError)
  })
})

describe('createGoalTools', () => {
  it('exposes both goal operations', () => {
    const tools = createGoalTools()
    expect(tools.assessFundedStatus(projection(120000, 0.9), 100000).verdict).toBe('on-track')
    const r = tools.solveRequiredContribution({
      series: [0, 0, 0, 0],
      config: { blockSize: 1, paths: 100 },
      horizon: { years: 5, periodsPerYear: 12 },
      initial: 0,
      target: 6000,
      targetSuccess: 0.8,
      seed: 1,
    })
    expect(r.perPeriod).toBeCloseTo(100, 0)
  })
})
