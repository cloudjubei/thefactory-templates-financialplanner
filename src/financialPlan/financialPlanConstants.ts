/** The always-present caveat explaining what the probability of success does and does not mean. */
export const GOAL_PROBABILITY_CAVEAT =
  'Probability of success is the share of bootstrapped paths meeting the goal in real terms — an honest outcome distribution, not a guarantee.'

/** Attached whenever a tax wrapper is applied, describing the treatment and the fan/terminal distinction. */
export const WRAPPER_TAX_CAVEAT =
  'Tax-wrapper treatment applied (contribution relief · sheltered vs taxed growth · withdrawal tax) from the wrapper structure. The fan shows account value over time; the terminal figure and probability of success are after any withdrawal tax.'

/** Attached when horizon-derived ability caps the declared appetite (the allocation is sized to capacity). */
export const SUITABILITY_CAP_CAVEAT =
  'Allocation sized to your horizon-derived capacity, which is more conservative than your stated appetite — a short horizon cannot ride out and recover from an equity drawdown.'
