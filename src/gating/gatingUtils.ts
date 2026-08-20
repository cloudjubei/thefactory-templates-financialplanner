import { realReturn } from '../instruments/instrumentUtils.js'
import type {
  CandidateVerdict,
  EvalMetrics,
  FundCandidate,
  FundGateConfig,
  GateConfigs,
  LabeledPrediction,
  RecommendProduct,
  SavingsCandidate,
  SavingsGateConfig,
} from './gatingTypes.js'

export function evaluateSavingsCandidate(
  candidate: SavingsCandidate,
  config: SavingsGateConfig,
): CandidateVerdict {
  const reasons: string[] = []
  let recommend = true
  if (!candidate.depositGuaranteeCovered) {
    recommend = false
    reasons.push('not covered by the deposit-guarantee scheme')
  }
  if (candidate.isTeaserRate) {
    recommend = false
    reasons.push('headline is a teaser rate that will drop')
  }
  const yieldReal = realReturn({
    nominalAnnual: candidate.aerNominal,
    expectedInflation: config.expectedInflation,
    taxRate: config.taxRate,
  })
  if (yieldReal < config.minRealYield) {
    recommend = false
    reasons.push(`real after-tax yield ${(yieldReal * 100).toFixed(2)}% is below the floor`)
  }
  if (recommend) {
    reasons.push('deposit-guarantee covered, non-teaser, real after-tax yield above the floor')
  }
  return { recommend, reasons }
}

export function evaluateFundCandidate(
  candidate: FundCandidate,
  config: FundGateConfig,
): CandidateVerdict {
  const reasons: string[] = []
  let recommend = true
  if (config.requireUcits && !candidate.ucitsEligible) {
    recommend = false
    reasons.push('not UCITS-eligible')
  }
  if (candidate.ter > config.maxTer) {
    recommend = false
    reasons.push(`TER ${(candidate.ter * 100).toFixed(2)}% is above the cap`)
  }
  let trackingAssessed = false
  if (candidate.trackingDifference) {
    trackingAssessed = true
    const { mean, standardError } = candidate.trackingDifference
    if (mean - 2 * standardError < config.minTrackingLowerBound) {
      recommend = false
      reasons.push('proven tracking drag — closet-index risk')
    }
  }
  if (recommend) {
    reasons.push(
      trackingAssessed
        ? 'low-cost, UCITS-eligible, tracks its index faithfully'
        : 'low-cost, UCITS-eligible (tracking not assessed — no return data)',
    )
  }
  return { recommend, reasons }
}

const SAVINGS_PRODUCT_TYPES = new Set(['savings'])
const FUND_PRODUCT_TYPES = new Set(['fund', 'etf'])
const BY_SIGNAL_PRODUCT_TYPES = new Set(['isa', 'pension', 'bond'])

const CASH_NAME_CUE = /\b(cash|easy[-\s]?access|fixed[-\s]?rate|saver|deposit)\b/i
const INVEST_NAME_CUE = /\b(stocks?|shares?|equit\w*|index|tracker|fund|etf|invest\w*)\b/i

/**
 * The gate class an instrument belongs to, or null when it isn't gated / can't be
 * resolved. Some product types don't map to one asset class: `isa`/`pension` are
 * WRAPPERS (a Cash ISA holds deposits → savings; a Stocks & Shares ISA holds funds
 * → fund) and `bond` spans both (a fixed-rate savings bond is deposit-like → savings;
 * a bond fund/ETF → fund). These are resolved by name cues, then
 * fee/UCITS/deposit-guarantee signals, and abstain (null) when genuinely ambiguous
 * rather than mis-route.
 */
export function classifyGateClass(product: RecommendProduct): 'savings' | 'fund' | null {
  const type = (product.productType ?? '').toLowerCase()
  if (SAVINGS_PRODUCT_TYPES.has(type)) return 'savings'
  if (FUND_PRODUCT_TYPES.has(type)) return 'fund'
  if (!BY_SIGNAL_PRODUCT_TYPES.has(type)) return null

  const name = product.name ?? ''
  const cashName = CASH_NAME_CUE.test(name)
  const investName = INVEST_NAME_CUE.test(name)
  if (cashName && !investName) return 'savings'
  if (investName && !cashName) return 'fund'
  if (typeof product.feesPct === 'number' && product.feesPct > 0) return 'fund'
  if (product.ucitsEligible === true) return 'fund'
  if (product.depositGuaranteeCovered === true) return 'savings'
  return null
}

// Tax-sheltered wrappers whose interest/gains are tax-free (TEE) — a Cash ISA's real
// yield must not be docked the market's savings tax, or a good tax-free rate near the
// inflation line is wrongly rejected. (Pensions are EET — taxed on withdrawal — so are
// deliberately NOT here.)
const TAX_FREE_WRAPPER_TYPES = new Set(['isa'])

export function gateRecommendProduct(
  product: RecommendProduct,
  configs: GateConfigs,
): CandidateVerdict | null {
  const type = (product.productType ?? '').toLowerCase()
  const gateClass = classifyGateClass(product)
  if (gateClass === 'savings') {
    const savingsConfig = TAX_FREE_WRAPPER_TYPES.has(type)
      ? { ...configs.savings, taxRate: 0 }
      : configs.savings
    return evaluateSavingsCandidate(
      {
        name: product.name ?? '',
        aerNominal: (product.expectedReturnPct ?? 0) / 100,
        depositGuaranteeCovered: product.depositGuaranteeCovered ?? false,
        isTeaserRate: product.isTeaserRate,
      },
      savingsConfig,
    )
  }
  if (gateClass === 'fund') {
    return evaluateFundCandidate(
      {
        name: product.name ?? '',
        ter: (product.feesPct ?? 0) / 100,
        ucitsEligible: product.ucitsEligible ?? false,
        trackingDifference: product.trackingDifference,
      },
      configs.fund,
    )
  }
  return null
}

export function evaluatePredictions(predictions: LabeledPrediction[]): EvalMetrics {
  const n = predictions.length
  if (n === 0) throw new RangeError('cannot evaluate an empty corpus')
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  for (const { predicted, label } of predictions) {
    if (predicted && label) tp++
    else if (predicted && !label) fp++
    else if (!predicted && !label) tn++
    else fn++
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn)
  const accuracy = (tp + tn) / n
  return { tp, fp, tn, fn, n, precision, recall, accuracy }
}
