import { describe, it, expect } from 'vitest'

import { createAllocationTools } from './AllocationTools.js'
import type { AllocationRequest } from './allocationTypes.js'

const request: AllocationRequest = {
  profile: { horizonYears: 15, riskTolerance: 'balanced', phase: 'accumulation', tiltAppetite: 1 },
}

describe('createAllocationTools.deriveAllocation', () => {
  it('returns a doctrine allocation whose weights sum to 1', () => {
    const a = createAllocationTools().deriveAllocation(request)
    const sum = a.sleeves.reduce((s, x) => s + x.weight, 0)
    expect(sum).toBeCloseTo(1, 9)
  })

  it('passes tilt evidence through: a positive premium enables the tilt', () => {
    const a = createAllocationTools().deriveAllocation({
      ...request,
      tiltEvidence: { netAnnualPremium: 0.01 },
    })
    const tilt = a.sleeves.find((s) => s.sleeve === 'valueQualityTilt')?.weight ?? 0
    expect(tilt).toBeGreaterThan(0)
  })

  it('refuses the tilt when no evidence is passed through', () => {
    const a = createAllocationTools().deriveAllocation(request)
    const tilt = a.sleeves.find((s) => s.sleeve === 'valueQualityTilt')?.weight ?? Number.NaN
    expect(tilt).toBe(0)
  })

  it('propagates a validation error for a negative horizon', () => {
    expect(() =>
      createAllocationTools().deriveAllocation({
        profile: { horizonYears: -1, riskTolerance: 'balanced', phase: 'accumulation' },
      }),
    ).toThrow(RangeError)
  })
})
