import type { RealReturnInputs, TrackingDifferenceStats } from './instrumentTypes.js'

export function realReturn(inputs: RealReturnInputs): number {
  const { nominalAnnual, expectedInflation } = inputs
  const taxRate = inputs.taxRate ?? 0
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    throw new RangeError(`taxRate must be within [0,1], got ${taxRate}`)
  }
  if (!Number.isFinite(expectedInflation) || expectedInflation <= -1) {
    throw new RangeError(`expectedInflation must be greater than −100%, got ${expectedInflation}`)
  }
  const nominalAfterTax = nominalAnnual * (1 - taxRate)
  return (1 + nominalAfterTax) / (1 + expectedInflation) - 1
}

export function netFundReturn(inputs: { grossAnnual: number; ter: number }): number {
  if (!Number.isFinite(inputs.ter) || inputs.ter < 0) {
    throw new RangeError(`ter must be ≥ 0, got ${inputs.ter}`)
  }
  return inputs.grossAnnual - inputs.ter
}

export function trackingDifferenceStats(
  fundReturns: number[],
  benchmarkReturns: number[],
): TrackingDifferenceStats {
  if (fundReturns.length !== benchmarkReturns.length) {
    throw new RangeError('fund and benchmark series must have the same length')
  }
  const n = fundReturns.length
  if (n < 2) throw new RangeError('need at least two paired observations')
  const diffs = fundReturns.map((r, i) => r - benchmarkReturns[i])
  const mean = diffs.reduce((a, b) => a + b, 0) / n
  const variance = diffs.reduce((sum, d) => sum + (d - mean) * (d - mean), 0) / (n - 1)
  const standardError = Math.sqrt(variance / n)
  return { mean, standardError, nObs: n }
}

export function modifiedDurationLoss(modifiedDuration: number, rateShockBps: number): number {
  if (!Number.isFinite(modifiedDuration) || modifiedDuration < 0) {
    throw new RangeError(`modifiedDuration must be ≥ 0, got ${modifiedDuration}`)
  }
  if (!Number.isFinite(rateShockBps)) {
    throw new RangeError(`rateShockBps must be finite, got ${rateShockBps}`)
  }
  return -modifiedDuration * (rateShockBps / 10000)
}
