import {
  BALLAST_MIN,
  DECUMULATION_EQUITY_HAIRCUT,
  DOCTRINE_RANGE_CAVEAT,
  EQUITY_CAP,
  EQUITY_FLOOR,
  HORIZON_EQUITY_SLOPE,
  HORIZON_REF_YEARS,
  RISK_BASE_EQUITY,
  TILT_MAX_FRACTION,
  TREND_MAX,
} from './allocationConstants.js'
import type {
  InvestmentPhase,
  RiskTolerance,
  SleeveAllocation,
  StrategicAllocation,
  SuitabilityProfile,
  TiltEvidence,
} from './allocationTypes.js'

export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

export function equityGlidepath(
  horizonYears: number,
  riskTolerance: RiskTolerance,
  phase: InvestmentPhase,
): number {
  if (!Number.isFinite(horizonYears) || horizonYears < 0) {
    throw new RangeError(`horizonYears must be ≥ 0, got ${horizonYears}`)
  }
  const base = RISK_BASE_EQUITY[riskTolerance]
  if (base === undefined) throw new RangeError(`unknown riskTolerance: ${riskTolerance}`)
  const horizonAdjustment = HORIZON_EQUITY_SLOPE * (horizonYears - HORIZON_REF_YEARS)
  const phaseAdjustment = phase === 'decumulation' ? -DECUMULATION_EQUITY_HAIRCUT : 0
  return clamp(base + horizonAdjustment + phaseAdjustment, EQUITY_FLOOR, EQUITY_CAP)
}

function normalizedAppetite(value: number | undefined, label: string): number {
  if (value === undefined) return 0
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite, got ${value}`)
  return clamp(value, 0, 1)
}

export function deriveStrategicAllocation(
  profile: SuitabilityProfile,
  tiltEvidence?: TiltEvidence,
): StrategicAllocation {
  const rawEquity = equityGlidepath(profile.horizonYears, profile.riskTolerance, profile.phase)
  const trendAppetite = normalizedAppetite(profile.trendAppetite, 'trendAppetite')
  const tiltAppetite = normalizedAppetite(profile.tiltAppetite, 'tiltAppetite')

  const trend = trendAppetite * TREND_MAX
  const equity = Math.min(rawEquity, 1 - trend - BALLAST_MIN)
  const ballast = 1 - equity - trend

  const tiltWarranted =
    tiltAppetite > 0 && tiltEvidence !== undefined && tiltEvidence.netAnnualPremium > 0
  const tilt = tiltWarranted ? equity * TILT_MAX_FRACTION * tiltAppetite : 0
  const core = equity - tilt

  const caveats = [DOCTRINE_RANGE_CAVEAT]
  if (tiltAppetite > 0 && !tiltWarranted) {
    caveats.push(
      'Value+quality tilt omitted: no positive haircut premium supplied — a plain global cap-weight core is fully defensible.',
    )
  }
  if (trend > 0) {
    caveats.push(
      'Trend sleeve is convex diversification, not a return engine — only defensible if accessed cheaply (net Sharpe ≈ 0.3–0.5, with multi-year droughts).',
    )
  }

  const sleeves: SleeveAllocation[] = [
    {
      sleeve: 'globalEquityCore',
      weight: core,
      rationale:
        'Own the global market cap-weighted and cheaply — the only premium beyond serious dispute.',
    },
    {
      sleeve: 'valueQualityTilt',
      weight: tilt,
      rationale: tiltWarranted
        ? 'Modest, low-turnover value+quality tilt — the factor exposure that best survives net-of-cost, sized only on a positive haircut premium.'
        : 'No tilt: the value+quality premium was not shown to survive its publication/cost/tax haircut.',
    },
    {
      sleeve: 'trendFollowing',
      weight: trend,
      rationale:
        'Cheap trend sleeve — crisis-alpha diversification that hedges a correlated stock+bond selloff.',
    },
    {
      sleeve: 'shortDurationBonds',
      weight: ballast,
      rationale:
        'Short-duration ballast — sequence-risk insurance, retained even in aggressive accumulation.',
    },
  ]

  return { sleeves, equityShare: equity, caveats }
}
