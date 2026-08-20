import { createSeededRng, runProjection } from '../projection/projectionUtils.js'
import type { ProjectionResult } from '../projection/projectionTypes.js'
import {
  CONTRIBUTION_BISECTION_STEPS,
  DEFAULT_MAX_PER_PERIOD,
  DEFAULT_SOLVER_SEED,
  DEFAULT_TARGET_SUCCESS,
  ON_TRACK_MIN_SUCCESS,
} from './goalConstants.js'
import type {
  FundedStatus,
  FundedVerdict,
  RequiredContribution,
  RequiredContributionParams,
} from './goalTypes.js'

/** Assess a projection against a target: funded ratio, probability, and a plain verdict. */
export function assessFundedStatus(projection: ProjectionResult, target: number): FundedStatus {
  if (!Number.isFinite(target) || target <= 0) {
    throw new RangeError(`target must be a positive, finite number, got ${target}`)
  }
  const projectedMedian = projection.terminal.p50
  const probabilityOfSuccess = projection.probabilityOfSuccess
  const effectiveProb = probabilityOfSuccess ?? (projectedMedian >= target ? 1 : 0)
  const verdict: FundedVerdict =
    projectedMedian < target
      ? 'shortfall'
      : effectiveProb >= ON_TRACK_MIN_SUCCESS
        ? 'on-track'
        : 'at-risk'
  return {
    target,
    projectedMedian,
    fundedRatio: projectedMedian / target,
    probabilityOfSuccess,
    verdict,
    medianShortfall: Math.max(0, target - projectedMedian),
  }
}

/** Solve for the per-period contribution needed to reach a target with a given probability. */
export function solveRequiredContribution(
  params: RequiredContributionParams,
): RequiredContribution {
  const targetSuccess = params.targetSuccess ?? DEFAULT_TARGET_SUCCESS
  if (!(targetSuccess > 0 && targetSuccess < 1)) {
    throw new RangeError(`targetSuccess must be within (0,1), got ${targetSuccess}`)
  }
  const maxPerPeriod = params.maxPerPeriod ?? DEFAULT_MAX_PER_PERIOD
  if (!Number.isFinite(maxPerPeriod) || maxPerPeriod <= 0) {
    throw new RangeError(`maxPerPeriod must be a positive, finite number, got ${maxPerPeriod}`)
  }
  const seed = params.seed ?? DEFAULT_SOLVER_SEED

  // `goal` is always supplied here, so runProjection always returns a probability.
  const successAt = (perPeriod: number): number => {
    const result = runProjection({
      series: params.series,
      config: params.config,
      horizon: params.horizon,
      plan: { initial: params.initial, perPeriod },
      rng: createSeededRng(seed),
      goal: params.target,
      terminalTaxRate: params.terminalTaxRate,
    })
    return result.probabilityOfSuccess as number
  }

  const successAtZero = successAt(0)
  if (successAtZero >= targetSuccess) {
    return { perPeriod: 0, achievedSuccess: successAtZero, targetSuccess, achievable: true }
  }
  const successAtCeiling = successAt(maxPerPeriod)
  if (successAtCeiling < targetSuccess) {
    return {
      perPeriod: maxPerPeriod,
      achievedSuccess: successAtCeiling,
      targetSuccess,
      achievable: false,
    }
  }

  let lo = 0
  let hi = maxPerPeriod
  for (let i = 0; i < CONTRIBUTION_BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2
    if (successAt(mid) >= targetSuccess) hi = mid
    else lo = mid
  }
  return { perPeriod: hi, achievedSuccess: successAt(hi), targetSuccess, achievable: true }
}
