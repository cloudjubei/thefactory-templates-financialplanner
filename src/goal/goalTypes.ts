import type {
  BootstrapConfig,
  ProjectionHorizon,
  ProjectionResult,
  ReturnSeries,
} from '../projection/projectionTypes.js'

/**
 * The goal-assessment layer: turn a probabilistic projection into the two answers a
 * planner actually needs — "am I on track for my goal?" (funded status) and "how
 * much must I save to get there?" (required contribution). Both read the honest
 * block-bootstrap distribution, never a single deterministic line.
 */

/** How a projection stands against a target. */
export type FundedVerdict = 'on-track' | 'at-risk' | 'shortfall'

/** A goal-funding assessment derived from a projection's distribution. */
export interface FundedStatus {
  /** Target terminal wealth. */
  target: number
  /** Median (p50) projected terminal wealth. */
  projectedMedian: number
  /** projectedMedian / target — > 1 means the central path clears the goal. */
  fundedRatio: number
  /** Probability of reaching the target, in [0,1]; undefined when the projection carried none. */
  probabilityOfSuccess?: number
  /**
   * on-track (median ≥ target AND probability ≥ the on-track floor), at-risk (median
   * ≥ target but probability below the floor), or shortfall (median < target).
   */
  verdict: FundedVerdict
  /** How far the median falls short of the target (0 when it clears). */
  medianShortfall: number
}

/** Inputs to {@link solveRequiredContribution}. */
export interface RequiredContributionParams {
  /** Per-period real return series the block bootstrap resamples. */
  series: ReturnSeries
  /** Block-bootstrap configuration. */
  config: BootstrapConfig
  /** The projection horizon (years × periods-per-year). */
  horizon: ProjectionHorizon
  /** Starting balance. */
  initial: number
  /** Target terminal wealth to reach. */
  target: number
  /** Desired probability of reaching the target, in (0,1). Defaults to the module default. */
  targetSuccess?: number
  /** Affordability ceiling on the per-period contribution; the search never exceeds it. */
  maxPerPeriod?: number
  /** PRNG seed — held fixed across the search so the comparison is apples-to-apples. */
  seed?: number
  /** Optional terminal tax rate applied to wealth before it is compared to the target. */
  terminalTaxRate?: number
}

/** The result of solving for a required periodic contribution. */
export interface RequiredContribution {
  /** The per-period contribution that hits the target success probability (or the ceiling). */
  perPeriod: number
  /** The success probability the solved contribution actually achieves. */
  achievedSuccess: number
  /** The requested target success probability. */
  targetSuccess: number
  /** Whether the target was reached within the affordability ceiling. */
  achievable: boolean
}

/** Goal assessment, exposed as chat-invocable tools. */
export interface GoalTools {
  /**
   * Assess whether a projection is on track for a target: funded ratio, probability,
   * and an on-track / at-risk / shortfall verdict.
   * @param projection A completed block-bootstrap projection.
   * @param target The target terminal wealth (must be > 0).
   */
  assessFundedStatus(projection: ProjectionResult, target: number): FundedStatus
  /**
   * Solve for the per-period contribution needed to reach a target with a given
   * probability, bounded by an affordability ceiling.
   * @param params The projection inputs, target, desired probability, and ceiling.
   */
  solveRequiredContribution(params: RequiredContributionParams): RequiredContribution
}
