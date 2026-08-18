import type {
  SleeveKey,
  StrategicAllocation,
  SuitabilityProfile,
} from '../allocation/allocationTypes.js'
import type {
  BootstrapConfig,
  ContributionPlan,
  ProjectionResult,
  ReturnSeries,
} from '../projection/projectionTypes.js'
import type { WrapperTaxSpec } from '../tax/taxTypes.js'

/**
 * The end-to-end financial-planning composition: chain a suitability profile and
 * a goal through the honesty-spine tilt gate, the doctrine allocation, and the
 * block-bootstrap projection into one `FinancialPlan` — the "here is your mix and
 * here is the probability you make it" artifact.
 */

/** A concrete savings goal a plan's success is measured against. */
export interface FinancialGoal {
  /** Target terminal wealth, in real terms. */
  targetAmount: number
  /** Horizon in years (should match the profile's horizon). */
  horizonYears: number
}

/**
 * The raw doctrine assumption behind the value+quality tilt, before the honesty
 * spine haircuts it. Supply it to *permit* a tilt; the tilt is still refused
 * unless the haircut premium comes out strictly positive.
 */
export interface TiltPremiumAssumption {
  /** Raw backtested annual value+quality premium, as a decimal. */
  rawAnnualPremium: number
  /** Fraction retained out-of-sample after publication decay, in [0,1]. */
  publicationRetention: number
  /** Incremental annual cost of running the tilt over the plain core, as a decimal (≥ 0). */
  incrementalCost: number
}

/** Everything needed to assemble a plan. */
export interface FinancialPlanRequest {
  /** The suitability inputs driving the allocation. */
  profile: SuitabilityProfile
  /** The goal the projection is scored against. */
  goal: FinancialGoal
  /** The accumulation/decumulation cash-flow plan. */
  contributions: ContributionPlan
  /**
   * Per-sleeve historical per-period real return series (the block-bootstrap
   * source). Only sleeves with a non-zero weight need a series.
   */
  sleeveReturns: Partial<Record<SleeveKey, ReturnSeries>>
  /** Block-bootstrap configuration (block length + path count). */
  config: BootstrapConfig
  /** Periods per year of the sleeve return series (e.g. 12 for monthly). */
  periodsPerYear: number
  /** Optional value+quality tilt assumption; absent → no tilt. */
  tiltPremium?: TiltPremiumAssumption
  /**
   * Optional tax-wrapper the plan is held in (TEE / EET / taxable). Applies
   * contribution relief, sheltered-vs-taxed growth, and withdrawal tax to the
   * projection. Absent → no tax treatment (raw pre-tax projection).
   */
  wrapper?: WrapperTaxSpec
  /** Optional PRNG seed for a reproducible plan. */
  seed?: number
}

/** A complete financial plan: the strategic allocation plus a probabilistic projection vs the goal. */
export interface FinancialPlan {
  /** The doctrine-driven strategic sleeve allocation. */
  allocation: StrategicAllocation
  /** The block-bootstrap Monte-Carlo projection scored against the goal. */
  projection: ProjectionResult
  /** The goal the projection was scored against. */
  goal: FinancialGoal
  /** Combined honesty caveats (allocation caveats + the goal-probability caveat). */
  caveats: string[]
}

/** End-to-end financial planning, exposed as a chat-invocable tool. */
export interface FinancialPlanTools {
  /**
   * Assemble a complete financial plan — strategic allocation + probability of
   * reaching the goal — from a suitability profile, goal, cash-flow plan, and
   * per-sleeve return history. Set `seed` for a reproducible plan.
   * @param request The full planning inputs.
   */
  buildFinancialPlan(request: FinancialPlanRequest): FinancialPlan
}
