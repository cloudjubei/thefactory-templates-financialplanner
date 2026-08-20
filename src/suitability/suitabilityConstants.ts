/**
 * Ability-from-horizon thresholds (years). Horizon is the dominant driver of the
 * block-bootstrap's downside: a short horizon cannot ride out and recover from an
 * equity drawdown, a long one can. These are CAPACITY boundaries, not a promise —
 * even a long horizon carries real-loss risk (Anarkulova-Cederburg), which is why
 * the doctrine keeps ballast at every bucket.
 */

/** Below this horizon (years) the investor can bear only cautious risk. */
export const ABILITY_CAUTIOUS_MAX_YEARS = 3

/** At/above {@link ABILITY_CAUTIOUS_MAX_YEARS} and below this, balanced; at/above this, adventurous. */
export const ABILITY_BALANCED_MAX_YEARS = 10
