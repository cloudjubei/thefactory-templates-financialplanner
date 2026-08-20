import type {
  InvestmentPhase,
  RiskTolerance,
  SuitabilityProfile,
} from '../allocation/allocationTypes.js'
import { ABILITY_BALANCED_MAX_YEARS, ABILITY_CAUTIOUS_MAX_YEARS } from './suitabilityConstants.js'
import type { SuitabilityAssessment, SuitabilityBinding } from './suitabilityTypes.js'

const RISK_RANK: Record<RiskTolerance, number> = { cautious: 0, balanced: 1, adventurous: 2 }

function riskAtRank(rank: number): RiskTolerance {
  if (rank <= 0) return 'cautious'
  if (rank === 1) return 'balanced'
  return 'adventurous'
}

/**
 * The most risk an investor's HORIZON and phase can bear (capacity), independent of
 * their stated appetite. Short horizons cannot absorb an equity drawdown; long ones
 * can. Decumulation caps capacity one notch lower — a loss while drawing down is not
 * recoverable from future contributions.
 */
export function deriveAbility(horizonYears: number, phase: InvestmentPhase): RiskTolerance {
  if (!Number.isFinite(horizonYears) || horizonYears < 0) {
    throw new RangeError(`horizonYears must be finite and ≥ 0, got ${horizonYears}`)
  }
  const base =
    horizonYears < ABILITY_CAUTIOUS_MAX_YEARS
      ? 'cautious'
      : horizonYears < ABILITY_BALANCED_MAX_YEARS
        ? 'balanced'
        : 'adventurous'
  return phase === 'decumulation' ? riskAtRank(RISK_RANK[base] - 1) : base
}

/** Resolve suitability as the MORE CONSERVATIVE of willingness and ability. */
export function resolveSuitability(
  willingness: RiskTolerance,
  ability: RiskTolerance,
): { effective: RiskTolerance; binding: SuitabilityBinding } {
  const wr = RISK_RANK[willingness]
  const ar = RISK_RANK[ability]
  const effective = riskAtRank(Math.min(wr, ar))
  const binding: SuitabilityBinding = wr === ar ? 'both' : wr < ar ? 'willingness' : 'ability'
  return { effective, binding }
}

function suitabilityRationale(a: SuitabilityAssessment, profile: SuitabilityProfile): string {
  const horizon = `${profile.horizonYears}y horizon`
  if (a.binding === 'willingness') {
    return `Sized to your stated ${a.willingness} appetite, below the ${a.ability} risk your ${horizon} could bear.`
  }
  if (a.binding === 'ability') {
    const decum = profile.phase === 'decumulation' ? ' while drawing down' : ''
    return `Capped at ${a.ability} by your ${horizon}${decum}, despite a stated ${a.willingness} appetite.`
  }
  return `Your stated ${a.willingness} appetite matches the capacity of your ${horizon}.`
}

/** Resolve an investor's effective risk bucket from their profile, with an auditable rationale. */
export function assessSuitability(profile: SuitabilityProfile): SuitabilityAssessment {
  const willingness = profile.riskTolerance
  const ability = deriveAbility(profile.horizonYears, profile.phase)
  const { effective, binding } = resolveSuitability(willingness, ability)
  const partial: SuitabilityAssessment = { willingness, ability, effective, binding, rationale: '' }
  return { ...partial, rationale: suitabilityRationale(partial, profile) }
}
