import { describe, it, expect } from 'vitest'

import type {
  FundCandidate,
  FundGateConfig,
  LabeledPrediction,
  SavingsCandidate,
  SavingsGateConfig,
} from './gatingTypes.js'
import {
  evaluateFundCandidate,
  evaluatePredictions,
  evaluateSavingsCandidate,
} from './gatingUtils.js'

const SAVINGS_CONFIG: SavingsGateConfig = { expectedInflation: 0.03, taxRate: 0.2, minRealYield: 0 }
const FUND_CONFIG: FundGateConfig = {
  maxTer: 0.003,
  minTrackingLowerBound: -0.005,
  requireUcits: true,
}

describe('evaluateSavingsCandidate', () => {
  it('recommends a covered, non-teaser account whose real after-tax yield clears the floor', () => {
    const v = evaluateSavingsCandidate(
      { name: 'Good', aerNominal: 0.05, depositGuaranteeCovered: true },
      SAVINGS_CONFIG,
    )
    expect(v.recommend).toBe(true)
  })

  it('rejects an uncovered account regardless of rate', () => {
    const v = evaluateSavingsCandidate(
      { name: 'Fintech', aerNominal: 0.06, depositGuaranteeCovered: false },
      SAVINGS_CONFIG,
    )
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /guarantee/i.test(r))).toBe(true)
  })

  it('rejects a teaser rate', () => {
    const v = evaluateSavingsCandidate(
      { name: 'Teaser', aerNominal: 0.055, depositGuaranteeCovered: true, isTeaserRate: true },
      SAVINGS_CONFIG,
    )
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /teaser/i.test(r))).toBe(true)
  })

  it('rejects a high-nominal account that is real-negative after tax (the honesty spine)', () => {
    const v = evaluateSavingsCandidate(
      { name: 'Looks good', aerNominal: 0.035, depositGuaranteeCovered: true },
      SAVINGS_CONFIG,
    )
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /yield/i.test(r))).toBe(true)
  })
})

describe('evaluateFundCandidate', () => {
  const good: FundCandidate = {
    name: 'Low-cost tracker',
    ter: 0.001,
    trackingDifference: { mean: -0.0005, standardError: 0.0005, nObs: 60 },
    ucitsEligible: true,
  }

  it('recommends a low-cost, UCITS, faithfully-tracking fund', () => {
    expect(evaluateFundCandidate(good, FUND_CONFIG).recommend).toBe(true)
  })

  it('rejects a fund over the TER cap', () => {
    const v = evaluateFundCandidate({ ...good, ter: 0.008 }, FUND_CONFIG)
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /ter/i.test(r))).toBe(true)
  })

  it('flags a closet-indexer whose tracking drag is proven', () => {
    const v = evaluateFundCandidate(
      { ...good, trackingDifference: { mean: -0.012, standardError: 0.001, nObs: 60 } },
      FUND_CONFIG,
    )
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /closet|track/i.test(r))).toBe(true)
  })

  it('rejects a non-UCITS fund when UCITS is required', () => {
    const v = evaluateFundCandidate({ ...good, ucitsEligible: false }, FUND_CONFIG)
    expect(v.recommend).toBe(false)
    expect(v.reasons.some((r) => /ucits/i.test(r))).toBe(true)
  })
})

describe('evaluatePredictions', () => {
  it('computes the confusion matrix and metrics', () => {
    const preds: LabeledPrediction[] = [
      { predicted: true, label: true },
      { predicted: true, label: false },
      { predicted: false, label: false },
      { predicted: false, label: true },
    ]
    const m = evaluatePredictions(preds)
    expect(m).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1, n: 4 })
    expect(m.precision).toBeCloseTo(0.5, 12)
    expect(m.recall).toBeCloseTo(0.5, 12)
    expect(m.accuracy).toBeCloseTo(0.5, 12)
  })

  it('treats no-positive-predictions as vacuously perfect precision', () => {
    const m = evaluatePredictions([
      { predicted: false, label: false },
      { predicted: false, label: true },
    ])
    expect(m.precision).toBe(1)
    expect(m.recall).toBe(0)
  })

  it('treats no-positive-labels as vacuously perfect recall', () => {
    const m = evaluatePredictions([{ predicted: false, label: false }])
    expect(m.recall).toBe(1)
  })

  it('rejects an empty corpus', () => {
    expect(() => evaluatePredictions([])).toThrow(RangeError)
  })
})

describe('GOLDEN CORPUS — gating precision/recall (success bar declared: ≥ 0.9 each)', () => {
  // Labeled illustrative corpus. Label = ground-truth "should be recommended".
  const savings: { c: SavingsCandidate; label: boolean }[] = [
    {
      c: { name: 'Best-buy covered', aerNominal: 0.05, depositGuaranteeCovered: true },
      label: true,
    },
    {
      c: { name: 'Decent covered', aerNominal: 0.045, depositGuaranteeCovered: true },
      label: true,
    },
    {
      c: { name: 'Below inflation', aerNominal: 0.02, depositGuaranteeCovered: true },
      label: false,
    },
    {
      c: { name: 'High-nominal real-negative', aerNominal: 0.035, depositGuaranteeCovered: true },
      label: false,
    },
    {
      c: { name: 'Uncovered fintech', aerNominal: 0.06, depositGuaranteeCovered: false },
      label: false,
    },
    {
      c: { name: 'Teaser', aerNominal: 0.055, depositGuaranteeCovered: true, isTeaserRate: true },
      label: false,
    },
  ]
  const funds: { c: FundCandidate; label: boolean }[] = [
    {
      c: {
        name: 'Cheap tracker',
        ter: 0.001,
        trackingDifference: { mean: -0.0004, standardError: 0.0005, nObs: 60 },
        ucitsEligible: true,
      },
      label: true,
    },
    {
      c: {
        name: 'Faithful tracker',
        ter: 0.0015,
        trackingDifference: { mean: 0, standardError: 0.0008, nObs: 60 },
        ucitsEligible: true,
      },
      label: true,
    },
    {
      c: {
        name: 'Expensive active',
        ter: 0.008,
        trackingDifference: { mean: -0.002, standardError: 0.001, nObs: 60 },
        ucitsEligible: true,
      },
      label: false,
    },
    {
      c: {
        name: 'Closet indexer',
        ter: 0.002,
        trackingDifference: { mean: -0.012, standardError: 0.001, nObs: 60 },
        ucitsEligible: true,
      },
      label: false,
    },
    {
      c: {
        name: 'Non-UCITS',
        ter: 0.001,
        trackingDifference: { mean: -0.0004, standardError: 0.0005, nObs: 60 },
        ucitsEligible: false,
      },
      label: false,
    },
  ]

  it('clears the declared precision/recall bar on the golden corpus', () => {
    const preds: LabeledPrediction[] = [
      ...savings.map((s) => ({
        predicted: evaluateSavingsCandidate(s.c, SAVINGS_CONFIG).recommend,
        label: s.label,
      })),
      ...funds.map((f) => ({
        predicted: evaluateFundCandidate(f.c, FUND_CONFIG).recommend,
        label: f.label,
      })),
    ]
    const m = evaluatePredictions(preds)
    expect(m.precision).toBeGreaterThanOrEqual(0.9)
    expect(m.recall).toBeGreaterThanOrEqual(0.9)
  })
})
