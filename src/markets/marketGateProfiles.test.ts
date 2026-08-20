import { describe, it, expect } from 'vitest'

import type { RecommendProduct } from '../gating/gatingTypes.js'
import { evaluatePredictions, gateRecommendProduct } from '../gating/gatingUtils.js'
import { getMarketGateConfig, getMarketGateProfile } from './marketGateProfiles.js'

describe('market gate profiles', () => {
  it('resolves a supported market profile', () => {
    const uk = getMarketGateProfile('UK')
    expect(uk?.currency).toBe('GBP')
    expect(uk?.gateConfig.savings.expectedInflation).toBeGreaterThan(0)
  })

  it('returns undefined for an unsupported market', () => {
    expect(getMarketGateProfile('JP')).toBeUndefined()
    expect(getMarketGateConfig('JP')).toBeUndefined()
  })

  it('returns undefined for a missing market code', () => {
    expect(getMarketGateProfile(undefined as unknown as string)).toBeUndefined()
  })

  it('resolves the GB alias to the UK profile', () => {
    expect(getMarketGateProfile('gb')?.code).toBe('UK')
  })

  it('exposes the gate config directly', () => {
    expect(getMarketGateConfig('PL')?.savings.taxRate).toBeCloseTo(0.19, 12)
  })
})

/**
 * The end-to-end proof. A user in each market runs a search; these are real,
 * point-in-time (Aug 2026) products for that market. We gate them through the
 * market's real inflation/tax profile and assert the honesty-spine verdicts.
 * The assertions are on the SIGN (real-negative → reject, expensive → reject),
 * which is robust to exact-decimal drift in the sourced rates.
 */
interface JourneyRow {
  name: string
  product: RecommendProduct
  shouldRecommend: boolean
  note: string
}

const UK_CORPUS: JourneyRow[] = [
  {
    name: 'Best-buy easy-access 4.5% (no bonus)',
    product: {
      productType: 'savings',
      expectedReturnPct: 4.5,
      depositGuaranteeCovered: true,
      isTeaserRate: false,
    },
    shouldRecommend: true,
    note: 'real-positive after 20% tax + 2.9% inflation, FSCS-covered',
  },
  {
    name: 'Revolut Instant 5% (reverts to 2.9% Dec 2026)',
    product: {
      productType: 'savings',
      expectedReturnPct: 5.0,
      depositGuaranteeCovered: true,
      isTeaserRate: true,
    },
    shouldRecommend: false,
    note: 'teaser/bonus rate that drops',
  },
  {
    name: 'High-street big-bank easy-access 1.5%',
    product: { productType: 'savings', expectedReturnPct: 1.5, depositGuaranteeCovered: true },
    shouldRecommend: false,
    note: 'real-NEGATIVE after tax + inflation — the honesty spine',
  },
  {
    name: 'Uncovered e-money "savings" 5%',
    product: { productType: 'savings', expectedReturnPct: 5.0, depositGuaranteeCovered: false },
    shouldRecommend: false,
    note: 'not FSCS-covered — fails the deposit-guarantee gate',
  },
  {
    name: 'Invesco FTSE All-World UCITS ETF (0.15%)',
    product: { productType: 'etf', feesPct: 0.15, ucitsEligible: true },
    shouldRecommend: true,
    note: 'low-cost UCITS tracker — clears the TER cap',
  },
  {
    name: 'Expensive active global fund (0.85%)',
    product: { productType: 'fund', feesPct: 0.85, ucitsEligible: true },
    shouldRecommend: false,
    note: 'fee drag — over the 0.3% TER cap',
  },
]

const PL_CORPUS: JourneyRow[] = [
  {
    name: 'Promo lokata 7% (4-month bonus)',
    product: {
      productType: 'savings',
      expectedReturnPct: 7.0,
      depositGuaranteeCovered: true,
      isTeaserRate: true,
    },
    shouldRecommend: false,
    note: 'promotional teaser rate',
  },
  {
    name: 'Standard PLN savings 5%',
    product: { productType: 'savings', expectedReturnPct: 5.0, depositGuaranteeCovered: true },
    shouldRecommend: true,
    note: 'real-positive after 19% Belka + 3.0% inflation, BFG-covered',
  },
  {
    name: 'Low big-bank PLN account 2%',
    product: { productType: 'savings', expectedReturnPct: 2.0, depositGuaranteeCovered: true },
    shouldRecommend: false,
    note: 'real-NEGATIVE after Belka + inflation',
  },
  {
    name: 'Vanguard FTSE All-World UCITS (VWCE 0.22%)',
    product: { productType: 'etf', feesPct: 0.22, ucitsEligible: true },
    shouldRecommend: true,
    note: 'low-cost UCITS tracker — clears the TER cap',
  },
  {
    name: 'Bank-distributed active fund (2.0%)',
    product: { productType: 'fund', feesPct: 2.0, ucitsEligible: true },
    shouldRecommend: false,
    note: 'heavy fee drag — over the TER cap',
  },
]

const DE_CORPUS: JourneyRow[] = [
  {
    name: 'Standard Tagesgeld 2.0%',
    product: { productType: 'savings', expectedReturnPct: 2.0, depositGuaranteeCovered: true },
    shouldRecommend: false,
    note: 'real-NEGATIVE after 26.375% Abgeltungsteuer + 2.8% inflation',
  },
  {
    name: 'Neobank promo Tagesgeld 4.0% (intro)',
    product: {
      productType: 'savings',
      expectedReturnPct: 4.0,
      depositGuaranteeCovered: true,
      isTeaserRate: true,
    },
    shouldRecommend: false,
    note: 'introductory teaser — and even so, German cash barely beats inflation after tax',
  },
  {
    name: 'Vanguard FTSE All-World UCITS (VWCE 0.22%)',
    product: { productType: 'etf', feesPct: 0.22, ucitsEligible: true },
    shouldRecommend: true,
    note: 'low-cost UCITS tracker — the answer when cash is real-negative',
  },
  {
    name: 'Bank-distributed active fund (1.5%)',
    product: { productType: 'fund', feesPct: 1.5, ucitsEligible: true },
    shouldRecommend: false,
    note: 'fee drag — over the TER cap',
  },
]

const US_CORPUS: JourneyRow[] = [
  {
    name: 'Top HYSA 4.8% (FDIC)',
    product: { productType: 'savings', expectedReturnPct: 4.8, depositGuaranteeCovered: true },
    shouldRecommend: true,
    note: 'real-positive after ~22% income tax + 3.4% inflation, FDIC-insured',
  },
  {
    name: 'Big-bank savings 0.4% (national avg)',
    product: { productType: 'savings', expectedReturnPct: 0.4, depositGuaranteeCovered: true },
    shouldRecommend: false,
    note: 'real-NEGATIVE after tax + inflation',
  },
  {
    name: 'Vanguard Total Stock Market ETF (VTI 0.03%, US-domiciled, non-UCITS)',
    product: { productType: 'etf', feesPct: 0.03, ucitsEligible: false },
    shouldRecommend: true,
    note: 'cheapest tracker — clears because the US market does NOT require UCITS',
  },
  {
    name: 'Actively managed US equity fund (0.66% avg)',
    product: { productType: 'fund', feesPct: 0.66, ucitsEligible: false },
    shouldRecommend: false,
    note: 'fee drag — over the TER cap',
  },
]

function runMarketJourney(code: string, corpus: JourneyRow[]) {
  const config = getMarketGateConfig(code)!
  return corpus.map((row) => ({ ...row, verdict: gateRecommendProduct(row.product, config)! }))
}

describe('END-TO-END market journey — honesty-spine gating on real data (Aug 2026)', () => {
  for (const [code, corpus] of [
    ['UK', UK_CORPUS],
    ['PL', PL_CORPUS],
    ['DE', DE_CORPUS],
    ['US', US_CORPUS],
  ] as const) {
    describe(`${code} market`, () => {
      const results = runMarketJourney(code, corpus)

      for (const r of results) {
        it(`${r.shouldRecommend ? 'clears' : 'rejects'}: ${r.name}`, () => {
          expect(r.verdict.recommend).toBe(r.shouldRecommend)
          expect(r.verdict.reasons.length).toBeGreaterThan(0)
        })
      }

      it('rejects the real-negative cash on real-yield grounds (the honesty spine)', () => {
        const realNegative = results.find((r) => /real-NEGATIVE/.test(r.note))!
        expect(realNegative.verdict.recommend).toBe(false)
        expect(realNegative.verdict.reasons.some((x) => /yield/i.test(x))).toBe(true)
      })

      it('meets the declared success bar (precision & recall ≥ 0.9) on the real corpus', () => {
        const m = evaluatePredictions(
          results.map((r) => ({ predicted: r.verdict.recommend, label: r.shouldRecommend })),
        )
        expect(m.precision).toBeGreaterThanOrEqual(0.9)
        expect(m.recall).toBeGreaterThanOrEqual(0.9)
      })
    })
  }

  it('the same US-domiciled ETF clears for a US investor but is rejected for a UK investor (UCITS)', () => {
    const vti: RecommendProduct = { productType: 'etf', feesPct: 0.03, ucitsEligible: false }
    expect(gateRecommendProduct(vti, getMarketGateConfig('US')!)?.recommend).toBe(true)
    const uk = gateRecommendProduct(vti, getMarketGateConfig('UK')!)!
    expect(uk.recommend).toBe(false)
    expect(uk.reasons.some((r) => /ucits/i.test(r))).toBe(true)
  })

  it('prints the per-market verdict proof and clears the bar across all markets combined', () => {
    const lines: string[] = ['', '=== Honesty-spine gating on real market data (Aug 2026) ===']
    const predictions = []
    for (const [code, corpus] of [
      ['UK', UK_CORPUS],
      ['PL', PL_CORPUS],
      ['DE', DE_CORPUS],
      ['US', US_CORPUS],
    ] as const) {
      const profile = getMarketGateProfile(code)!
      lines.push(
        `\n${profile.name} (${profile.currency}) — inflation ${(profile.gateConfig.savings.expectedInflation * 100).toFixed(1)}%, tax ${(profile.gateConfig.savings.taxRate * 100).toFixed(0)}%, ${profile.depositGuarantee}`,
      )
      for (const r of runMarketJourney(code, corpus)) {
        const mark = r.verdict.recommend ? '✓ clears ' : '✗ below  '
        lines.push(`  ${mark} ${r.name}\n              → ${r.verdict.reasons.join('; ')}`)
        predictions.push({ predicted: r.verdict.recommend, label: r.shouldRecommend })
      }
    }
    console.log(lines.join('\n'))
    const m = evaluatePredictions(predictions)
    expect(m.precision).toBeGreaterThanOrEqual(0.9)
    expect(m.recall).toBeGreaterThanOrEqual(0.9)
  })
})
