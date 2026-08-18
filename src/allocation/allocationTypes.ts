/**
 * Doctrine-driven strategic asset allocation. Given a suitability profile, derive
 * target weights across four sleeves — global cap-weight equity core, an optional
 * modest value+quality tilt, a capped cheap-trend sleeve, and short-duration
 * ballast — deterministically from the investment doctrine (Part I of the SOTA
 * plan), never from an error-maximizing mean-variance optimisation.
 *
 * The honesty spine is enforced here: the value+quality tilt is refused unless a
 * *positive already-haircut* premium is supplied (no weight is justified by a raw
 * backtest), and every allocation carries the caveats that make its weights honest
 * ranges rather than false precision.
 */

/** The three suitability risk buckets the front-end collects. */
export type RiskTolerance = 'cautious' | 'balanced' | 'adventurous'

/** Accumulation (saving) vs decumulation (drawing down) — they glide differently. */
export type InvestmentPhase = 'accumulation' | 'decumulation'

/** The suitability inputs that drive the strategic allocation. */
export interface SuitabilityProfile {
  /** Investment horizon in years (must be ≥ 0). */
  horizonYears: number
  /** The investor's assessed risk tolerance/capacity bucket. */
  riskTolerance: RiskTolerance
  /** Whether the investor is accumulating or decumulating. */
  phase: InvestmentPhase
  /** Appetite for the cheap-trend sleeve, in [0,1] (0 = none). Defaults to 0. */
  trendAppetite?: number
  /** Appetite for the value+quality tilt within equity, in [0,1] (0 = pure cap-weight). Defaults to 0. */
  tiltAppetite?: number
}

/**
 * Evidence gating the value+quality tilt: the premium AFTER the publication/cost/
 * tax haircut. A tilt is only ever sized on a strictly positive value here.
 */
export interface TiltEvidence {
  /** The net (already-haircut) annual value+quality premium, as a decimal. */
  netAnnualPremium: number
}

/** The four strategic sleeves an allocation is composed of. */
export type SleeveKey =
  'globalEquityCore' | 'valueQualityTilt' | 'trendFollowing' | 'shortDurationBonds'

/** A single sleeve's target weight and the doctrine reason it is held. */
export interface SleeveAllocation {
  /** Which sleeve. */
  sleeve: SleeveKey
  /** Target portfolio weight, in [0,1]. */
  weight: number
  /** The doctrine rationale for this sleeve and size. */
  rationale: string
}

/** A complete strategic allocation with its equity share and honesty caveats. */
export interface StrategicAllocation {
  /** The four sleeves; weights sum to 1. */
  sleeves: SleeveAllocation[]
  /** Total equity share (core + tilt), in [0,1]. */
  equityShare: number
  /** Doctrine caveats — always non-empty; weights are ranges, not precise optima. */
  caveats: string[]
}

/** The serializable input surface of {@link AllocationTools.deriveAllocation}. */
export interface AllocationRequest {
  /** The suitability inputs driving the allocation. */
  profile: SuitabilityProfile
  /**
   * The already-haircut value+quality premium gating the tilt. Omit it and the
   * tilt is refused regardless of appetite — no weight rides on a raw backtest.
   */
  tiltEvidence?: TiltEvidence
}

/** Doctrine-driven strategic allocation, exposed as a chat-invocable tool. */
export interface AllocationTools {
  /**
   * Derive a strategic sleeve allocation (global-equity core + optional
   * value/quality tilt + cheap-trend sleeve + short-duration ballast) from a
   * suitability profile and the doctrine. Deterministic; the tilt is only sized
   * on a strictly positive haircut premium.
   * @param request The suitability profile and optional tilt evidence.
   */
  deriveAllocation(request: AllocationRequest): StrategicAllocation
}
