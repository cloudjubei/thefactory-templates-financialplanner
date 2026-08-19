import { describe, it, expect } from 'vitest'

import {
  modifiedDurationLoss,
  netFundReturn,
  realReturn,
  trackingDifferenceStats,
} from './instrumentUtils.js'

describe('realReturn', () => {
  it('is the Fisher real return after tax', () => {
    // (1 + 0.05) / (1 + 0.03) − 1
    expect(realReturn({ nominalAnnual: 0.05, expectedInflation: 0.03 })).toBeCloseTo(
      1.05 / 1.03 - 1,
      12,
    )
  })

  it('taxes the nominal return before deflating', () => {
    // nominal-after-tax = 0.05 × 0.8 = 0.04 → (1.04 / 1.03) − 1
    expect(realReturn({ nominalAnnual: 0.05, expectedInflation: 0.03, taxRate: 0.2 })).toBeCloseTo(
      1.04 / 1.03 - 1,
      12,
    )
  })

  it('can be negative when inflation outpaces the after-tax rate', () => {
    expect(realReturn({ nominalAnnual: 0.02, expectedInflation: 0.05 })).toBeLessThan(0)
  })

  it('rejects a tax rate outside [0,1]', () => {
    expect(() =>
      realReturn({ nominalAnnual: 0.05, expectedInflation: 0.03, taxRate: 1.2 }),
    ).toThrow(RangeError)
  })

  it('rejects inflation of −100% or worse', () => {
    expect(() => realReturn({ nominalAnnual: 0.05, expectedInflation: -1 })).toThrow(RangeError)
  })
})

describe('netFundReturn', () => {
  it('subtracts the expense ratio from the gross return', () => {
    expect(netFundReturn({ grossAnnual: 0.07, ter: 0.002 })).toBeCloseTo(0.068, 12)
  })

  it('rejects a negative expense ratio', () => {
    expect(() => netFundReturn({ grossAnnual: 0.07, ter: -0.001 })).toThrow(RangeError)
  })
})

describe('trackingDifferenceStats', () => {
  it('reports the mean difference and its standard error', () => {
    const s = trackingDifferenceStats([0.1, 0.1], [0.08, 0.12])
    expect(s.mean).toBeCloseTo(0, 12)
    expect(s.standardError).toBeCloseTo(0.02, 12)
    expect(s.nObs).toBe(2)
  })

  it('a fund that tracks perfectly has zero mean and zero SE', () => {
    const s = trackingDifferenceStats([0.1, 0.05, 0.2], [0.1, 0.05, 0.2])
    expect(s.mean).toBe(0)
    expect(s.standardError).toBe(0)
  })

  it('detects a persistent drag (negative mean)', () => {
    const s = trackingDifferenceStats([0.09, 0.09], [0.1, 0.1])
    expect(s.mean).toBeCloseTo(-0.01, 12)
  })

  it('rejects series of differing length', () => {
    expect(() => trackingDifferenceStats([0.1, 0.2], [0.1])).toThrow(RangeError)
  })

  it('rejects fewer than two observations', () => {
    expect(() => trackingDifferenceStats([0.1], [0.1])).toThrow(RangeError)
  })
})

describe('modifiedDurationLoss', () => {
  it('is the mark-to-market loss for a rate rise', () => {
    // duration 5, +100bp → −5 × 0.01 = −0.05
    expect(modifiedDurationLoss(5, 100)).toBeCloseTo(-0.05, 12)
  })

  it('is a gain when rates fall', () => {
    expect(modifiedDurationLoss(5, -100)).toBeCloseTo(0.05, 12)
  })

  it('rejects a negative duration', () => {
    expect(() => modifiedDurationLoss(-1, 100)).toThrow(RangeError)
  })

  it('rejects a non-finite rate shock', () => {
    expect(() => modifiedDurationLoss(5, Number.NaN)).toThrow(RangeError)
  })
})
