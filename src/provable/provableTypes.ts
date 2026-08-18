/**
 * The "prove it or don't recommend it" contract. Every recommendation must carry
 * a {@link ProvableMeasure} — a statistic WITH its uncertainty and provenance —
 * and clear a {@link FloorComparison} against the cheapest/safest provable floor.
 * When nothing is provable, the doctrine defaults to that floor rather than
 * asserting a decimal.
 */

/**
 * The uncertainty attached to a statistic. `se` carries a standard error; `ci`
 * a statistical confidence interval; `band` a scenario range (e.g. an inflation
 * band). All bounds are in the statistic's own units.
 */
export type Uncertainty =
  | { kind: 'se'; standardError: number }
  | { kind: 'ci'; lower: number; upper: number }
  | { kind: 'band'; lower: number; upper: number }

/**
 * A statistic that justifies a recommendation, carrying its uncertainty and
 * provenance. A product with no populated ProvableMeasure is never recommended.
 */
export interface ProvableMeasure {
  /** What is measured, e.g. "realYield", "trackingDifference", "deflatedSharpe". */
  statistic: string
  /** The point estimate, in the statistic's units (decimals for returns). */
  value: number
  /** The uncertainty around `value`. */
  uncertainty: Uncertainty
  /** Number of observations behind the estimate, when applicable. */
  nObs?: number
  /** Effective number of independent observations/trials (after deflation), when applicable. */
  nEff?: number
  /** The authoritative source the figure was read from. */
  source?: string
  /** ISO timestamp the figure was current as of (staleness gate). */
  asOf?: string
}

/** The outcome of comparing a candidate's outcome distribution to the provable floor. */
export interface FloorComparison {
  /** Fraction of Monte-Carlo paths on which the candidate beats the floor, in [0,1]. */
  probabilityBeatsFloor: number
  /** The confidence bar the candidate had to clear. */
  threshold: number
  /** Whether the candidate clears the bar (recommend) or not (default to the floor). */
  passes: boolean
}
