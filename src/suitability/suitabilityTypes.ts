import type { RiskTolerance, SuitabilityProfile } from '../allocation/allocationTypes.js'

/**
 * The suitability decision: an investor should take the LESSER of the risk they are
 * willing to bear (declared) and the risk they are able to bear (capacity derived
 * from their horizon and phase). Sizing an allocation to the more aggressive of the
 * two is the classic mis-selling failure — this layer enforces `min(willingness,
 * ability)` and names which constraint bound the result.
 */

/** Which side of `min(willingness, ability)` set the effective bucket. */
export type SuitabilityBinding = 'willingness' | 'ability' | 'both'

/** A resolved suitability assessment. */
export interface SuitabilityAssessment {
  /** The investor's DECLARED risk appetite. */
  willingness: RiskTolerance
  /** The risk their horizon + phase can bear (capacity). */
  ability: RiskTolerance
  /** `min(willingness, ability)` — the bucket the allocation should actually use. */
  effective: RiskTolerance
  /** Which constraint set the effective bucket. */
  binding: SuitabilityBinding
  /** A plain-language, auditable explanation of the effective bucket. */
  rationale: string
}

/** Suitability resolution, exposed as a chat-invocable tool. */
export interface SuitabilityTools {
  /**
   * Resolve an investor's effective risk bucket as the more conservative of their
   * declared appetite and their horizon-derived capacity, with the binding
   * constraint and an auditable rationale.
   * @param profile The suitability inputs (horizon, declared risk, phase).
   */
  assessSuitability(profile: SuitabilityProfile): SuitabilityAssessment
}
