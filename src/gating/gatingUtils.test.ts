import { describe, it, expect } from 'vitest'

import type {
  FundCandidate,
  FundGateConfig,
  GateConfigs,
  LabeledPrediction,
  SavingsCandidate,
  SavingsGateConfig,
} from './gatingTypes.js'
import {
  classifyGateClass,
  evaluateFundCandidate,
  evaluatePredictions,
  evaluateSavingsCandidate,
  gateRecommendProduct,
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

  it('abstains on the closet-index gate when there is no tracking data', () => {
    const { trackingDifference, ...noTracking } = good
    void trackingDifference
    const v = evaluateFundCandidate(noTracking, FUND_CONFIG)
    expect(v.recommend).toBe(true)
    expect(v.reasons.some((r) => /not assessed/i.test(r))).toBe(true)
  })
})

describe('gateRecommendProduct', () => {
  const configs: GateConfigs = { savings: SAVINGS_CONFIG, fund: FUND_CONFIG }

  it('routes a savings product through the savings gate (percent → decimal)', () => {
    // 3.5% AER, covered → real-negative after tax → reject
    const v = gateRecommendProduct(
      { productType: 'savings', expectedReturnPct: 3.5, depositGuaranteeCovered: true },
      configs,
    )
    expect(v?.recommend).toBe(false)
  })

  it('recommends a covered high-yield savings product', () => {
    const v = gateRecommendProduct(
      { productType: 'savings', expectedReturnPct: 5, depositGuaranteeCovered: true },
      configs,
    )
    expect(v?.recommend).toBe(true)
  })

  it('routes an etf through the fund gate (feesPct → TER decimal)', () => {
    const v = gateRecommendProduct(
      { productType: 'etf', feesPct: 0.1, ucitsEligible: true },
      configs,
    )
    expect(v?.recommend).toBe(true)
  })

  it('rejects an expensive fund via the TER cap', () => {
    const v = gateRecommendProduct(
      { productType: 'fund', feesPct: 0.8, ucitsEligible: true },
      configs,
    )
    expect(v?.recommend).toBe(false)
  })

  it('conservatively rejects a savings product with unproven guarantee coverage', () => {
    const v = gateRecommendProduct({ productType: 'savings', expectedReturnPct: 5 }, configs)
    expect(v?.recommend).toBe(false)
  })

  it('returns null for a product class not gated by these classes (e.g. stock)', () => {
    expect(gateRecommendProduct({ productType: 'stock', expectedReturnPct: 8 }, configs)).toBeNull()
  })

  it('returns null when the product type is missing', () => {
    expect(gateRecommendProduct({ expectedReturnPct: 5 }, configs)).toBeNull()
  })

  it('treats a rate-less savings product as a 0% (real-negative) reject', () => {
    expect(gateRecommendProduct({ productType: 'savings' }, configs)?.recommend).toBe(false)
  })

  it('treats a fee-less UCITS etf as a 0% TER (passes)', () => {
    expect(
      gateRecommendProduct({ productType: 'etf', ucitsEligible: true }, configs)?.recommend,
    ).toBe(true)
  })

  it('conservatively rejects a fund with unproven UCITS eligibility', () => {
    expect(gateRecommendProduct({ productType: 'fund', feesPct: 0.1 }, configs)?.recommend).toBe(
      false,
    )
  })
})

describe('classifyGateClass', () => {
  it('maps asset-class product types directly', () => {
    expect(classifyGateClass({ productType: 'savings' })).toBe('savings')
    expect(classifyGateClass({ productType: 'fund' })).toBe('fund')
    expect(classifyGateClass({ productType: 'etf' })).toBe('fund')
  })

  it('returns null for ungated / missing types', () => {
    expect(classifyGateClass({ productType: 'stock' })).toBeNull()
    expect(classifyGateClass({ productType: 'crypto' })).toBeNull()
    expect(classifyGateClass({})).toBeNull()
  })

  it('resolves a bond by signal: fixed-rate savings bond → savings, bond fund/ETF → fund, bare → abstain', () => {
    expect(classifyGateClass({ productType: 'bond', name: '1 Year Fixed Rate Bond' })).toBe(
      'savings',
    )
    expect(
      classifyGateClass({ productType: 'bond', name: 'Corporate Bond Fund', feesPct: 0.2 }),
    ).toBe('fund')
    expect(
      classifyGateClass({ productType: 'bond', name: 'Global Bond ETF', ucitsEligible: true }),
    ).toBe('fund')
    expect(classifyGateClass({ productType: 'bond' })).toBeNull()
  })

  it('routes a wrapper by a CASH name to savings', () => {
    expect(classifyGateClass({ productType: 'isa', name: 'Cash ISA' })).toBe('savings')
    expect(classifyGateClass({ productType: 'isa', name: '5 Year Fixed Rate Cash ISA' })).toBe(
      'savings',
    )
  })

  it('routes a wrapper by an INVESTMENT name to fund', () => {
    expect(classifyGateClass({ productType: 'isa', name: 'Stocks & Shares ISA' })).toBe('fund')
    expect(classifyGateClass({ productType: 'pension', name: 'SIPP index fund pension' })).toBe(
      'fund',
    )
  })

  it('lets the name win over the fee signal (name checked first)', () => {
    expect(classifyGateClass({ productType: 'isa', name: 'Cash ISA', feesPct: 0.25 })).toBe(
      'savings',
    )
  })

  it('falls back to signals when the name is silent: fee → fund', () => {
    expect(classifyGateClass({ productType: 'isa', feesPct: 0.25 })).toBe('fund')
  })

  it('falls back to signals when the name is silent: UCITS → fund', () => {
    expect(classifyGateClass({ productType: 'isa', ucitsEligible: true })).toBe('fund')
  })

  it('falls back to signals when the name is silent: deposit-guarantee → savings', () => {
    expect(classifyGateClass({ productType: 'isa', depositGuaranteeCovered: true })).toBe('savings')
  })

  it('abstains (null) on a genuinely ambiguous wrapper with no signal', () => {
    expect(classifyGateClass({ productType: 'isa', name: 'Junior ISA' })).toBeNull()
    expect(classifyGateClass({ productType: 'pension', name: 'Personal Pension' })).toBeNull()
  })

  it('abstains when the name carries BOTH cash and investment cues and nothing breaks the tie', () => {
    expect(classifyGateClass({ productType: 'isa', name: 'Cash and Shares ISA' })).toBeNull()
  })
})

describe('gateRecommendProduct — wrapper (ISA) routing', () => {
  const configs: GateConfigs = { savings: SAVINGS_CONFIG, fund: FUND_CONFIG }

  it('routes a Cash ISA through the SAVINGS gate, not the fund gate (the bug)', () => {
    // 1.5% covered Cash ISA: real-negative after tax → reject on YIELD grounds, never "not UCITS".
    const v = gateRecommendProduct(
      {
        productType: 'isa',
        name: 'Cash ISA',
        expectedReturnPct: 1.5,
        depositGuaranteeCovered: true,
      },
      configs,
    )
    expect(v?.recommend).toBe(false)
    expect(v?.reasons.some((r) => /yield/i.test(r))).toBe(true)
    expect(v?.reasons.some((r) => /ucits/i.test(r))).toBe(false)
  })

  it('recommends a covered, high-yield Cash ISA via the savings gate', () => {
    const v = gateRecommendProduct(
      { productType: 'isa', name: 'Cash ISA', expectedReturnPct: 5, depositGuaranteeCovered: true },
      configs,
    )
    expect(v?.recommend).toBe(true)
  })

  it('credits the ISA tax shelter: a 3.5% Cash ISA clears where a 3.5% taxable account is rejected', () => {
    const cashIsa = gateRecommendProduct(
      {
        productType: 'isa',
        name: 'Cash ISA',
        expectedReturnPct: 3.5,
        depositGuaranteeCovered: true,
      },
      configs,
    )
    const taxable = gateRecommendProduct(
      { productType: 'savings', expectedReturnPct: 3.5, depositGuaranteeCovered: true },
      configs,
    )
    expect(cashIsa?.recommend).toBe(true)
    expect(taxable?.recommend).toBe(false)
  })

  it('routes a Stocks & Shares ISA through the fund gate', () => {
    const v = gateRecommendProduct(
      { productType: 'isa', name: 'Stocks & Shares ISA', feesPct: 0.1, ucitsEligible: true },
      configs,
    )
    expect(v?.recommend).toBe(true)
  })

  it('abstains (null) on an ambiguous ISA wrapper rather than mis-rejecting it', () => {
    expect(gateRecommendProduct({ productType: 'isa', name: 'Junior ISA' }, configs)).toBeNull()
  })

  it('routes a covered fixed-rate savings bond through the savings gate', () => {
    const v = gateRecommendProduct(
      {
        productType: 'bond',
        name: '2 Year Fixed Rate Bond',
        expectedReturnPct: 5,
        depositGuaranteeCovered: true,
      },
      configs,
    )
    expect(v?.recommend).toBe(true)
  })

  it('routes a bond fund through the fund gate (TER cap applies)', () => {
    const v = gateRecommendProduct(
      { productType: 'bond', name: 'Global Bond Fund', feesPct: 0.8, ucitsEligible: true },
      configs,
    )
    expect(v?.recommend).toBe(false)
    expect(v?.reasons.some((r) => /ter/i.test(r))).toBe(true)
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
