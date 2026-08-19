/**
 * The pure scoring layer behind "surface what matters." Given a change (a price/
 * value move) it decides how severe it is and whether it crosses the bar to be
 * surfaced; given a portfolio it computes performance stats + the biggest mover;
 * given an opportunity it decides whether it's a standout worth highlighting.
 *
 * All thresholds and configuration are INPUTS — this module encodes no policy of
 * its own, so the eventual "what counts as vital" decision lives in the config a
 * caller passes, never here.
 */

/** Ordered severity of a surfaced change. */
export type Severity = 'none' | 'info' | 'notable' | 'critical'

/** Magnitude bands (decimals, e.g. 0.05 = 5%) at/above which a change reaches each severity. */
export interface SeverityThresholds {
  /** At/above this absolute magnitude → 'info'. */
  info: number
  /** At/above this → 'notable'. */
  notable: number
  /** At/above this → 'critical'. */
  critical: number
}

/** Direction of a move. */
export type MoveDirection = 'up' | 'down' | 'flat'

/** The assessment of a single value/price move. */
export interface MoveAssessment {
  /** Signed fractional change (to − from) / from. */
  changePct: number
  /** Absolute magnitude of the change. */
  magnitude: number
  /** Up, down, or flat. */
  direction: MoveDirection
  /** Severity from the thresholds. */
  severity: Severity
  /** Whether this crosses the bar to surface (severity ≠ 'none'). */
  surface: boolean
}

/** A single holding's cost basis and current value, in one common currency. */
export interface Position {
  /** What was paid (cost basis). */
  costBasis: number
  /** Current value. */
  currentValue: number
}

/** Absolute and fractional return of a position. */
export interface PositionReturn {
  /** currentValue − costBasis. */
  pnl: number
  /** pnl / costBasis (0 when costBasis ≤ 0). */
  pnlPct: number
}

/** The biggest-moving position by absolute fractional return. */
export interface BiggestMover {
  /** Index into the positions array. */
  index: number
  /** That position's fractional return. */
  pnlPct: number
}

/** Aggregate portfolio performance. */
export interface PortfolioStats {
  /** Sum of current values. */
  totalValue: number
  /** Sum of cost bases. */
  totalCost: number
  /** totalValue − totalCost. */
  pnl: number
  /** pnl / totalCost (0 when totalCost ≤ 0). */
  pnlPct: number
  /** The biggest mover, or null when there are no positions. */
  biggestMover: BiggestMover | null
}

/** The parts of an opportunity a highlight decision needs. */
export interface OpportunityCandidate {
  /** Recommendation tier (e.g. 'perfect' | 'good' | 'ok'). */
  tier?: string
  /** Fit/quality score, 0–100. */
  score?: number
}

/** What makes an opportunity a standout worth highlighting. */
export interface HighlightConfig {
  /** Minimum score to qualify. */
  minScore: number
  /** Tiers allowed to be highlighted. */
  tiers: string[]
}
