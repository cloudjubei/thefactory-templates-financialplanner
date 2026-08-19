/**
 * The evidence-gate layer: does a candidate instrument clear its class's hard
 * gates, on provable grounds? Each evaluator returns a recommend/reject verdict
 * with cited reasons (the auditable, "guidance not advice" trail), computed from
 * the per-class provable metrics (`src/instruments`) against thresholds the
 * caller supplies — the market-specific `[LIVE]` floors live in the config, never
 * here.
 *
 * The `evaluatePredictions` harness scores a run of verdicts against a labeled
 * golden corpus (precision / recall / accuracy), so "correctly gates a
 * genuinely-low-cost fund / flags a closet-indexer / rejects a below-inflation
 * savings account" becomes a measured criterion, not an assertion.
 */

import type { TrackingDifferenceStats } from '../instruments/instrumentTypes.js'

/** A cash/savings candidate. */
export interface SavingsCandidate {
  /** Product name. */
  name: string
  /** Nominal AER as a decimal. */
  aerNominal: number
  /** Whether the balance is covered by the market's deposit-guarantee scheme. */
  depositGuaranteeCovered: boolean
  /** Whether the headline rate is an introductory teaser that will drop. */
  isTeaserRate?: boolean
}

/** Thresholds gating a savings candidate (market-specific, `[LIVE]`-sourced). */
export interface SavingsGateConfig {
  /** Expected annual inflation as a decimal. */
  expectedInflation: number
  /** Marginal tax rate on interest, in [0,1]. */
  taxRate: number
  /** The provable floor: minimum acceptable real after-tax yield (e.g. 0 = must beat inflation). */
  minRealYield: number
}

/** An index-fund / UCITS-ETF candidate. */
export interface FundCandidate {
  /** Product name. */
  name: string
  /** Total expense ratio as a decimal. */
  ter: number
  /** The fund's tracking difference vs its benchmark (mean ± SE). */
  trackingDifference: TrackingDifferenceStats
  /** Whether the fund is UCITS-eligible. */
  ucitsEligible: boolean
}

/** Thresholds gating a fund candidate. */
export interface FundGateConfig {
  /** Maximum acceptable expense ratio (the certain-edge hard gate). */
  maxTer: number
  /**
   * The most negative the tracking-difference LOWER bound (mean − 2·SE) may be
   * before the fund is flagged as a proven drag / closet-index risk.
   */
  minTrackingLowerBound: number
  /** Whether UCITS eligibility is required. */
  requireUcits: boolean
}

/** A gate verdict: recommend or reject, with cited reasons. */
export interface CandidateVerdict {
  /** Whether the candidate clears all its gates. */
  recommend: boolean
  /** The cited reasons behind the verdict (auditable trail). */
  reasons: string[]
}

/** A single labeled prediction for the golden-corpus harness. */
export interface LabeledPrediction {
  /** What the gate decided. */
  predicted: boolean
  /** The ground-truth label (should it be recommended?). */
  label: boolean
}

/** Confusion-matrix counts. */
export interface ConfusionMatrix {
  /** True positives. */
  tp: number
  /** False positives. */
  fp: number
  /** True negatives. */
  tn: number
  /** False negatives. */
  fn: number
}

/** Evaluation metrics over a labeled corpus. */
export interface EvalMetrics extends ConfusionMatrix {
  /** Number of predictions. */
  n: number
  /** tp / (tp + fp); 1 when nothing was predicted positive. */
  precision: number
  /** tp / (tp + fn); 1 when there were no positives to find. */
  recall: number
  /** (tp + tn) / n. */
  accuracy: number
}
