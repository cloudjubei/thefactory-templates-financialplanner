import { deriveStrategicAllocation } from '../allocation/allocationUtils.js'
import type { SleeveKey, StrategicAllocation, TiltEvidence } from '../allocation/allocationTypes.js'
import {
  applyAnnualDragToSeries,
  applyPublicationDecay,
  runProjection,
} from '../projection/projectionUtils.js'
import type { ReturnSeries } from '../projection/projectionTypes.js'
import { resolveWrapperTaxTreatment } from '../tax/taxUtils.js'
import { assessSuitability } from '../suitability/suitabilityUtils.js'
import type { SuitabilityAssessment } from '../suitability/suitabilityTypes.js'
import { assessFundedStatus, solveRequiredContribution } from '../goal/goalUtils.js'
import type { RequiredContribution } from '../goal/goalTypes.js'
import {
  GOAL_PROBABILITY_CAVEAT,
  SUITABILITY_CAP_CAVEAT,
  WRAPPER_TAX_CAVEAT,
} from './financialPlanConstants.js'
import type {
  FinancialPlan,
  FinancialPlanRequest,
  SolveContributionOptions,
  TiltPremiumAssumption,
} from './financialPlanTypes.js'

interface WrapperTaxTreatment {
  contributionMultiplier: number
  annualGrowthTaxDrag: number
  terminalWithdrawalTaxRate: number
}

interface PlanInputs {
  suitability: SuitabilityAssessment
  allocation: StrategicAllocation
  taxedSeries: ReturnSeries
  treatment: WrapperTaxTreatment
}

export function deriveTiltEvidence(assumption: TiltPremiumAssumption): TiltEvidence {
  if (!Number.isFinite(assumption.incrementalCost) || assumption.incrementalCost < 0) {
    throw new RangeError(`incrementalCost must be ≥ 0, got ${assumption.incrementalCost}`)
  }
  const retained = applyPublicationDecay(
    assumption.rawAnnualPremium,
    assumption.publicationRetention,
  )
  return { netAnnualPremium: retained - assumption.incrementalCost }
}

export function blendReturnSeries(
  weights: Partial<Record<SleeveKey, number>>,
  sleeveReturns: Partial<Record<SleeveKey, ReturnSeries>>,
): ReturnSeries {
  const active = (Object.keys(weights) as SleeveKey[]).filter((k) => (weights[k] ?? 0) > 0)
  if (active.length === 0) throw new RangeError('at least one sleeve must carry a positive weight')

  const series: Record<string, ReturnSeries> = {}
  let length = -1
  for (const key of active) {
    const s = sleeveReturns[key]
    if (s === undefined || s.length === 0) {
      throw new RangeError(`sleeve ${key} has a positive weight but no return series`)
    }
    if (length === -1) length = s.length
    else if (s.length !== length) {
      throw new RangeError('all positive-weight sleeve series must have the same length')
    }
    series[key] = s
  }

  const blended: number[] = new Array<number>(length).fill(0)
  for (const key of active) {
    const w = weights[key] as number
    const s = series[key]
    for (let t = 0; t < length; t++) blended[t] += w * s[t]
  }
  return blended
}

/**
 * The shared front half of a plan: resolve suitability → effective allocation →
 * blended, wrapper-taxed return series. Both {@link composeFinancialPlan} and
 * {@link solvePlanContribution} build on exactly these inputs.
 */
function resolvePlanInputs(request: FinancialPlanRequest): PlanInputs {
  const suitability = assessSuitability(request.profile)
  const tiltEvidence = request.tiltPremium ? deriveTiltEvidence(request.tiltPremium) : undefined
  const allocation = deriveStrategicAllocation(
    { ...request.profile, riskTolerance: suitability.effective },
    tiltEvidence,
  )

  const weights: Partial<Record<SleeveKey, number>> = {}
  for (const s of allocation.sleeves) weights[s.sleeve] = s.weight

  const blended = blendReturnSeries(weights, request.sleeveReturns)

  const treatment = request.wrapper
    ? resolveWrapperTaxTreatment(request.wrapper)
    : { contributionMultiplier: 1, annualGrowthTaxDrag: 0, terminalWithdrawalTaxRate: 0 }

  const taxedSeries =
    treatment.annualGrowthTaxDrag > 0
      ? applyAnnualDragToSeries(blended, treatment.annualGrowthTaxDrag, request.periodsPerYear)
      : blended

  return { suitability, allocation, taxedSeries, treatment }
}

export function composeFinancialPlan(
  request: FinancialPlanRequest,
  rng: () => number,
): FinancialPlan {
  const { suitability, allocation, taxedSeries, treatment } = resolvePlanInputs(request)

  const contributions = {
    initial: request.contributions.initial,
    perPeriod: request.contributions.perPeriod * treatment.contributionMultiplier,
  }

  const projection = runProjection({
    series: taxedSeries,
    config: request.config,
    horizon: { years: request.goal.horizonYears, periodsPerYear: request.periodsPerYear },
    plan: contributions,
    rng,
    goal: request.goal.targetAmount,
    terminalTaxRate: treatment.terminalWithdrawalTaxRate,
  })

  const fundedStatus = assessFundedStatus(projection, request.goal.targetAmount)

  const caveats = [...allocation.caveats, GOAL_PROBABILITY_CAVEAT]
  if (suitability.binding === 'ability') caveats.push(SUITABILITY_CAP_CAVEAT)
  if (request.wrapper) caveats.push(WRAPPER_TAX_CAVEAT)

  return {
    suitability,
    allocation,
    projection,
    goal: request.goal,
    fundedStatus,
    caveats,
  }
}

/**
 * Solve for the per-period contribution the investor must make to reach their goal
 * with a target probability, using the SAME effective allocation and taxed series a
 * full plan would. The returned `perPeriod` is the investor's own out-of-pocket
 * amount (any wrapper contribution relief is unwound), so it can be shown directly.
 */
export function solvePlanContribution(
  request: FinancialPlanRequest,
  options: SolveContributionOptions = {},
): RequiredContribution {
  const { taxedSeries, treatment } = resolvePlanInputs(request)
  const grossMax =
    options.maxPerPeriod === undefined
      ? undefined
      : options.maxPerPeriod * treatment.contributionMultiplier

  const solved = solveRequiredContribution({
    series: taxedSeries,
    config: request.config,
    horizon: { years: request.goal.horizonYears, periodsPerYear: request.periodsPerYear },
    initial: request.contributions.initial,
    target: request.goal.targetAmount,
    targetSuccess: options.targetSuccess,
    maxPerPeriod: grossMax,
    seed: request.seed,
    terminalTaxRate: treatment.terminalWithdrawalTaxRate,
  })

  return { ...solved, perPeriod: solved.perPeriod / treatment.contributionMultiplier }
}
