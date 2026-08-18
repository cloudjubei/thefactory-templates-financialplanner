import type {
  BootstrapConfig,
  ContributionPlan,
  HaircutPolicy,
  NetReturnBreakdown,
  Premium,
  ProjectionFanPoint,
  ProjectionHorizon,
  ProjectionResult,
  ReturnSeries,
  WealthQuantiles,
} from './projectionTypes.js'

export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function applyPublicationDecay(rawAnnualPremium: number, retention: number): number {
  if (!Number.isFinite(retention) || retention < 0 || retention > 1) {
    throw new RangeError(`publicationRetention must be within [0,1], got ${retention}`)
  }
  return rawAnnualPremium * retention
}

export function netRealReturn(input: {
  baseRealReturn: number
  premiums: Premium[]
  policy: HaircutPolicy
}): NetReturnBreakdown {
  const { baseRealReturn, premiums, policy } = input
  if (!Number.isFinite(policy.annualCostDrag) || policy.annualCostDrag < 0) {
    throw new RangeError(`annualCostDrag must be ≥ 0, got ${policy.annualCostDrag}`)
  }
  if (!Number.isFinite(policy.annualTaxDrag) || policy.annualTaxDrag < 0) {
    throw new RangeError(`annualTaxDrag must be ≥ 0, got ${policy.annualTaxDrag}`)
  }
  const grossPremium = premiums.reduce((sum, p) => sum + p.rawAnnual, 0)
  const retainedPremium = premiums.reduce(
    (sum, p) => sum + applyPublicationDecay(p.rawAnnual, policy.publicationRetention),
    0,
  )
  const netRealReturnValue =
    baseRealReturn + retainedPremium - policy.annualCostDrag - policy.annualTaxDrag
  return {
    baseRealReturn,
    grossPremium,
    retainedPremium,
    costDrag: policy.annualCostDrag,
    taxDrag: policy.annualTaxDrag,
    netRealReturn: netRealReturnValue,
  }
}

export function annualToPeriodReturn(annual: number, periodsPerYear: number): number {
  if (!Number.isFinite(periodsPerYear) || periodsPerYear < 1) {
    throw new RangeError(`periodsPerYear must be ≥ 1, got ${periodsPerYear}`)
  }
  if (!Number.isFinite(annual) || annual <= -1) {
    throw new RangeError(`annual return must be greater than −100%, got ${annual}`)
  }
  return Math.pow(1 + annual, 1 / periodsPerYear) - 1
}

export function applyAnnualDragToSeries(
  series: ReturnSeries,
  annualDrag: number,
  periodsPerYear: number,
): ReturnSeries {
  const perPeriodDrag = annualToPeriodReturn(annualDrag, periodsPerYear)
  return series.map((r) => r - perPeriodDrag)
}

export function circularBlockBootstrap(
  series: ReturnSeries,
  blockSize: number,
  periods: number,
  rng: () => number,
): number[] {
  if (series.length === 0) throw new RangeError('series must be non-empty')
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new RangeError(`blockSize must be a positive integer, got ${blockSize}`)
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError(`periods must be a positive integer, got ${periods}`)
  }
  const out: number[] = []
  const length = series.length
  while (out.length < periods) {
    const start = Math.floor(rng() * length)
    for (let j = 0; j < blockSize && out.length < periods; j++) {
      out.push(series[(start + j) % length])
    }
  }
  return out
}

export function bootstrapReturnPaths(
  series: ReturnSeries,
  config: BootstrapConfig,
  periods: number,
  rng: () => number,
): number[][] {
  if (!Number.isInteger(config.paths) || config.paths < 1) {
    throw new RangeError(`paths must be a positive integer, got ${config.paths}`)
  }
  const paths: number[][] = []
  for (let p = 0; p < config.paths; p++) {
    paths.push(circularBlockBootstrap(series, config.blockSize, periods, rng))
  }
  return paths
}

export function simulateWealthTrajectory(returns: number[], plan: ContributionPlan): number[] {
  let wealth = plan.initial
  const trajectory = [wealth]
  for (const r of returns) {
    wealth = wealth * (1 + r) + plan.perPeriod
    trajectory.push(wealth)
  }
  return trajectory
}

export function wealthTrajectories(returnPaths: number[][], plan: ContributionPlan): number[][] {
  return returnPaths.map((returns) => simulateWealthTrajectory(returns, plan))
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) throw new RangeError('values must be non-empty')
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError(`quantile must be within [0,1], got ${q}`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  const idx = q * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

export function quantilesOf(values: number[]): WealthQuantiles {
  return {
    p5: percentile(values, 0.05),
    p25: percentile(values, 0.25),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
  }
}

export function terminalWealths(trajectories: number[][]): number[] {
  return trajectories.map((t) => t[t.length - 1])
}

export function probabilityOfSuccess(terminals: number[], goal: number): number {
  if (terminals.length === 0) throw new RangeError('terminals must be non-empty')
  const met = terminals.reduce((count, w) => count + (w >= goal ? 1 : 0), 0)
  return met / terminals.length
}

export function buildProjectionFan(trajectories: number[][]): ProjectionFanPoint[] {
  if (trajectories.length === 0) throw new RangeError('trajectories must be non-empty')
  const periods = trajectories[0].length
  if (!trajectories.every((t) => t.length === periods)) {
    throw new RangeError('all trajectories must have the same length')
  }
  const fan: ProjectionFanPoint[] = []
  for (let period = 0; period < periods; period++) {
    const slice = trajectories.map((t) => t[period])
    fan.push({ period, quantiles: quantilesOf(slice) })
  }
  return fan
}

export function runProjection(params: {
  series: ReturnSeries
  config: BootstrapConfig
  horizon: ProjectionHorizon
  plan: ContributionPlan
  rng: () => number
  goal?: number
  terminalTaxRate?: number
}): ProjectionResult {
  const { series, config, horizon, plan, rng, goal } = params
  const terminalTaxRate = params.terminalTaxRate ?? 0
  if (!Number.isFinite(terminalTaxRate) || terminalTaxRate < 0 || terminalTaxRate > 1) {
    throw new RangeError(`terminalTaxRate must be within [0,1], got ${terminalTaxRate}`)
  }
  const periods = Math.round(horizon.years * horizon.periodsPerYear)
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError(
      `horizon must resolve to a positive whole number of periods, got ${periods}`,
    )
  }
  const returnPaths = bootstrapReturnPaths(series, config, periods, rng)
  const trajectories = wealthTrajectories(returnPaths, plan)
  const grossTerminals = terminalWealths(trajectories)
  const netTerminals =
    terminalTaxRate === 0 ? grossTerminals : grossTerminals.map((w) => w * (1 - terminalTaxRate))
  return {
    terminal: quantilesOf(netTerminals),
    fan: buildProjectionFan(trajectories),
    probabilityOfSuccess: goal === undefined ? undefined : probabilityOfSuccess(netTerminals, goal),
    paths: config.paths,
  }
}
