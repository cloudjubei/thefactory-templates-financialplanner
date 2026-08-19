import { realReturn } from '../instruments/instrumentUtils.js'
import type {
  CandidateVerdict,
  EvalMetrics,
  FundCandidate,
  FundGateConfig,
  LabeledPrediction,
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
  const { mean, standardError } = candidate.trackingDifference
  const trackingLowerBound = mean - 2 * standardError
  if (trackingLowerBound < config.minTrackingLowerBound) {
    recommend = false
    reasons.push('proven tracking drag — closet-index risk')
  }
  if (recommend) {
    reasons.push('low-cost, UCITS-eligible, tracks its index faithfully')
  }
  return { recommend, reasons }
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
