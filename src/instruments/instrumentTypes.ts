/**
 * The per-class provable-statistic computers — "one provable statistic per
 * product class." Each turns raw, sourced inputs (a nominal rate, an expense
 * ratio, two return series, a duration) into the number a recommendation must
 * carry, on ONE common footing: real, after-tax, after-fee.
 *
 * These are pure and universal; the market-specific rates they consume are
 * `[LIVE]` inputs sourced elsewhere. Each result becomes the `value` of a
 * `ProvableMeasure` (see `src/provable`); the tracking-difference result also
 * carries its own uncertainty.
 */

/** Inputs to the Fisher real-after-tax return (serves savings, deposits, bond YTM, MMF yield). */
export interface RealReturnInputs {
  /** The nominal annual rate as a decimal (AER / YTM / 7-day yield). */
  nominalAnnual: number
  /** Expected annual inflation as a decimal (must be > −1). */
  expectedInflation: number
  /** Marginal tax rate applied to the nominal return, in [0,1]. Defaults to 0. */
  taxRate?: number
}

/** The tracking-difference of a fund vs its benchmark — mean delivery plus its uncertainty. */
export interface TrackingDifferenceStats {
  /** Mean per-period (fund − benchmark) return; near 0 = tracks, large negative = drag/closet-index. */
  mean: number
  /** Standard error of the mean (sample-std ÷ √n). */
  standardError: number
  /** Number of paired observations. */
  nObs: number
}
