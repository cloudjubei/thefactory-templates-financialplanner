/**
 * Probabilistic long-horizon wealth projection — the honest replacement for a
 * single deterministic return line.
 *
 * The engine is deliberately split into two concerns that the doctrine keeps
 * separate: the **honesty spine** (discount every published premium for
 * publication decay, then costs, then taxes — "trust the sign, distrust the
 * decimals") and the **block-bootstrap Monte-Carlo** (resample a real per-period
 * return series in contiguous blocks so fat tails and autocorrelation survive,
 * unlike a lognormal fan). Every exported number is a decimal fraction unless a
 * field's doc says otherwise (e.g. `0.045` = 4.5%).
 */

/**
 * A per-period real return series (decimals, e.g. monthly real returns). This is
 * the empirical distribution the block bootstrap resamples; it is NOT annualised.
 */
export type ReturnSeries = number[]

/**
 * The publication-decay + cost/tax discounting policy applied before any premium
 * is allowed to justify an allocation or inflate a projection. This is the
 * differentiator: no expected return is ever a raw backtest.
 */
export interface HaircutPolicy {
  /**
   * Fraction of a *published anomaly premium* expected to persist out-of-sample
   * (McLean-Pontiff ≈ 0.5). Must lie within [0, 1]; a value above 1 (a premium
   * that grows after publication) is rejected, not clamped.
   */
  publicationRetention: number
  /** Annual cost drag — expense ratio + trading + platform — as a decimal (≥ 0). */
  annualCostDrag: number
  /** Annual tax drag as a decimal (≥ 0). */
  annualTaxDrag: number
}

/** A single published tilt/anomaly premium and its raw (pre-haircut) size. */
export interface Premium {
  /** Human label, e.g. "value+quality". */
  label: string
  /** Raw backtested annual premium as a decimal (e.g. 0.03 = 3%/yr). */
  rawAnnual: number
}

/** The transparent decomposition of a defensible net real return. */
export interface NetReturnBreakdown {
  /** The undisputed base real return (market beta) — never publication-haircut. */
  baseRealReturn: number
  /** Sum of raw premiums before the publication haircut. */
  grossPremium: number
  /** Sum of premiums after the publication haircut. */
  retainedPremium: number
  /** Annual cost drag subtracted. */
  costDrag: number
  /** Annual tax drag subtracted. */
  taxDrag: number
  /** baseRealReturn + retainedPremium − costDrag − taxDrag. */
  netRealReturn: number
}

/** Configuration of the circular block bootstrap. */
export interface BootstrapConfig {
  /**
   * Contiguous block length (periods) resampled as a unit. Blocks > 1 preserve
   * short-horizon autocorrelation and fat tails the i.i.d. bootstrap destroys.
   */
  blockSize: number
  /** Number of Monte-Carlo paths to simulate. */
  paths: number
}

/** The accumulation/decumulation cash-flow plan applied along every path. */
export interface ContributionPlan {
  /** Starting balance. */
  initial: number
  /** Fixed cash flow each period: positive = contribution, negative = withdrawal. */
  perPeriod: number
}

/** The projection horizon expressed in years at a given period granularity. */
export interface ProjectionHorizon {
  /** Number of years to project. */
  years: number
  /** Periods per year of the return series (e.g. 12 for monthly). */
  periodsPerYear: number
}

/** A five-point summary of a wealth distribution (the fan-chart bands). */
export interface WealthQuantiles {
  /** 5th percentile. */
  p5: number
  /** 25th percentile. */
  p25: number
  /** Median. */
  p50: number
  /** 75th percentile. */
  p75: number
  /** 95th percentile. */
  p95: number
}

/** Wealth quantiles at a single period along the horizon. */
export interface ProjectionFanPoint {
  /** Period index (0 = start, horizon.years × periodsPerYear = terminal). */
  period: number
  /** The five-point wealth summary at this period. */
  quantiles: WealthQuantiles
}

/** The full probabilistic projection: a fan-chart plus a probability of success. */
export interface ProjectionResult {
  /** Terminal-wealth five-point summary. */
  terminal: WealthQuantiles
  /** Per-period wealth bands across the horizon (the fan chart). */
  fan: ProjectionFanPoint[]
  /**
   * Fraction of paths whose terminal wealth meets the goal, in [0, 1]. Omitted
   * when no goal is supplied.
   */
  probabilityOfSuccess?: number
  /** Number of Monte-Carlo paths the summary was computed over. */
  paths: number
}

/**
 * A fully-specified probabilistic wealth projection request — the serializable
 * input surface of {@link ProjectionTools.projectWealth}.
 */
export interface ProjectionRequest {
  /** The per-period real return series (decimals) the block bootstrap resamples. */
  series: ReturnSeries
  /** Block-bootstrap configuration: contiguous block length and Monte-Carlo path count. */
  config: BootstrapConfig
  /** The projection horizon (years × periods-per-year). */
  horizon: ProjectionHorizon
  /** The accumulation/decumulation cash-flow plan applied along every path. */
  plan: ContributionPlan
  /** Optional target terminal wealth; when set, the result carries a probability of meeting it. */
  goal?: number
  /**
   * Optional PRNG seed. Supply it for a reproducible, auditable projection (same
   * inputs → identical fan-chart); omit it for a fresh non-deterministic draw.
   */
  seed?: number
}

/** Probabilistic long-horizon wealth projection, exposed as a chat-invocable tool. */
export interface ProjectionTools {
  /**
   * Run a block-bootstrap Monte-Carlo wealth projection and return a percentile
   * fan-chart plus (when a goal is given) the probability of reaching it. Every
   * return assumption is expected to already carry its publication/cost/tax
   * haircut — this tool projects the distribution, it does not invent optimism.
   * @param request The projection inputs; set `seed` for a reproducible result.
   */
  projectWealth(request: ProjectionRequest): ProjectionResult
}
