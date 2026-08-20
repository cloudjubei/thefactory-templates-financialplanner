/** Default probability a required-contribution solve aims for (an 80% chance of success). */
export const DEFAULT_TARGET_SUCCESS = 0.8

/** A funded status is "on-track" only when the success probability clears this floor. */
export const ON_TRACK_MIN_SUCCESS = 0.8

/** Default affordability ceiling on a per-period contribution when the caller gives none. */
export const DEFAULT_MAX_PER_PERIOD = 1e9

/** Fixed PRNG seed for the solver when the caller gives none (reproducible searches). */
export const DEFAULT_SOLVER_SEED = 1

/** Bisection steps — resolves the contribution to a fraction of a currency unit even at the ceiling. */
export const CONTRIBUTION_BISECTION_STEPS = 40
