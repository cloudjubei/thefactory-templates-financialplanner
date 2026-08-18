import type { RiskTolerance } from './allocationTypes.js'

/** Highest defensible equity share (adventurous, long-horizon accumulation). */
export const EQUITY_CAP = 0.9

/** Lowest equity share the glidepath will assign (cautious, short-horizon decumulation). */
export const EQUITY_FLOOR = 0.3

/** Minimum short-duration ballast retained even in aggressive accumulation (sequence-risk insurance). */
export const BALLAST_MIN = 0.05

/** Maximum weight of the cheap-trend sleeve — a convex diversifier, never a return engine. */
export const TREND_MAX = 0.15

/** Maximum value+quality tilt as a fraction of the equity allocation (modest, low-turnover). */
export const TILT_MAX_FRACTION = 0.2

/** Horizon (years) at which the risk-bucket base equity share applies unadjusted. */
export const HORIZON_REF_YEARS = 15

/** Equity share added per year of horizon beyond the reference (before clamping). */
export const HORIZON_EQUITY_SLOPE = 0.005

/** Equity share removed when decumulating rather than accumulating. */
export const DECUMULATION_EQUITY_HAIRCUT = 0.15

/** Base equity share by risk bucket at the reference horizon, in accumulation. */
export const RISK_BASE_EQUITY: Record<RiskTolerance, number> = {
  cautious: 0.55,
  balanced: 0.7,
  adventurous: 0.85,
}

/** The always-present honesty caveat governing every allocation. */
export const DOCTRINE_RANGE_CAVEAT =
  'Weights are doctrine ranges, not precise optima — trust the sign, distrust the decimals.'
