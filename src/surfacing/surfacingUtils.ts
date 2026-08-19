import type {
  HighlightConfig,
  MoveAssessment,
  OpportunityCandidate,
  PortfolioStats,
  Position,
  PositionReturn,
  Severity,
  SeverityThresholds,
} from './surfacingTypes.js'

export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  info: 1,
  notable: 2,
  critical: 3,
}

export function percentChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) {
    throw new RangeError(`from must be a non-zero finite number, got ${from}`)
  }
  return (to - from) / from
}

export function classifySeverity(magnitude: number, thresholds: SeverityThresholds): Severity {
  const { info, notable, critical } = thresholds
  if (
    !Number.isFinite(info) ||
    !Number.isFinite(notable) ||
    !Number.isFinite(critical) ||
    info < 0 ||
    !(info <= notable && notable <= critical)
  ) {
    throw new RangeError('thresholds must satisfy 0 ≤ info ≤ notable ≤ critical and be finite')
  }
  const m = Math.abs(magnitude)
  if (m >= critical) return 'critical'
  if (m >= notable) return 'notable'
  if (m >= info) return 'info'
  return 'none'
}

export function assessMove(params: {
  from: number
  to: number
  thresholds: SeverityThresholds
}): MoveAssessment {
  const changePct = percentChange(params.from, params.to)
  const magnitude = Math.abs(changePct)
  const direction = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat'
  const severity = classifySeverity(magnitude, params.thresholds)
  return { changePct, magnitude, direction, severity, surface: severity !== 'none' }
}

export function positionReturn(position: Position): PositionReturn {
  const pnl = position.currentValue - position.costBasis
  const pnlPct = position.costBasis > 0 ? pnl / position.costBasis : 0
  return { pnl, pnlPct }
}

export function portfolioStats(positions: Position[]): PortfolioStats {
  let totalValue = 0
  let totalCost = 0
  let biggestMover: PortfolioStats['biggestMover'] = null
  positions.forEach((position, index) => {
    totalValue += position.currentValue
    totalCost += position.costBasis
    const { pnlPct } = positionReturn(position)
    if (biggestMover === null || Math.abs(pnlPct) > Math.abs(biggestMover.pnlPct)) {
      biggestMover = { index, pnlPct }
    }
  })
  const pnl = totalValue - totalCost
  const pnlPct = totalCost > 0 ? pnl / totalCost : 0
  return { totalValue, totalCost, pnl, pnlPct, biggestMover }
}

export function opportunityIsHighlight(
  candidate: OpportunityCandidate,
  config: HighlightConfig,
): boolean {
  const tierOk = candidate.tier !== undefined && config.tiers.includes(candidate.tier)
  const score = candidate.score ?? Number.NEGATIVE_INFINITY
  return tierOk && score >= config.minScore
}

export function sortBySeverityDesc<T>(items: T[], getSeverity: (item: T) => Severity): T[] {
  return [...items].sort((a, b) => SEVERITY_RANK[getSeverity(b)] - SEVERITY_RANK[getSeverity(a)])
}
