import type { FloorComparison, ProvableMeasure } from './provableTypes.js'

export function probabilityBeatsFloor(
  candidateTerminals: number[],
  floorTerminals: number[],
): number {
  if (candidateTerminals.length === 0 || floorTerminals.length === 0) {
    throw new RangeError('both distributions must be non-empty')
  }
  if (candidateTerminals.length !== floorTerminals.length) {
    throw new RangeError('candidate and floor distributions must be paired (equal length)')
  }
  let wins = 0
  for (let i = 0; i < candidateTerminals.length; i++) {
    if (candidateTerminals[i] > floorTerminals[i]) wins++
  }
  return wins / candidateTerminals.length
}

export function passesProvableFloor(
  candidateTerminals: number[],
  floorTerminals: number[],
  threshold: number,
): FloorComparison {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError(`threshold must be within [0,1], got ${threshold}`)
  }
  const probabilityBeatsFloorValue = probabilityBeatsFloor(candidateTerminals, floorTerminals)
  return {
    probabilityBeatsFloor: probabilityBeatsFloorValue,
    threshold,
    passes: probabilityBeatsFloorValue >= threshold,
  }
}

export function probabilityRealReturnNegative(realReturns: number[]): number {
  if (realReturns.length === 0) throw new RangeError('realReturns must be non-empty')
  const negative = realReturns.reduce((count, r) => count + (r < 0 ? 1 : 0), 0)
  return negative / realReturns.length
}

export function isProvenPositive(measure: ProvableMeasure, sigmas = 2): boolean {
  if (!Number.isFinite(sigmas) || sigmas < 0) {
    throw new RangeError(`sigmas must be ≥ 0, got ${sigmas}`)
  }
  const u = measure.uncertainty
  switch (u.kind) {
    case 'se':
      return measure.value - sigmas * u.standardError > 0
    case 'ci':
    case 'band':
      return u.lower > 0
  }
}
