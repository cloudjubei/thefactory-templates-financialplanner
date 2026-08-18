import { describe, it, expect } from 'vitest'

import {
  BALLAST_MIN,
  DOCTRINE_RANGE_CAVEAT,
  EQUITY_CAP,
  TILT_MAX_FRACTION,
  TREND_MAX,
} from './allocationConstants.js'
import type { SleeveKey, SuitabilityProfile } from './allocationTypes.js'
import { clamp, deriveStrategicAllocation, equityGlidepath } from './allocationUtils.js'

function weightOf(sleeves: { sleeve: SleeveKey; weight: number }[], key: SleeveKey): number {
  return sleeves.find((s) => s.sleeve === key)?.weight ?? Number.NaN
}

const balancedAccum: SuitabilityProfile = {
  horizonYears: 15,
  riskTolerance: 'balanced',
  phase: 'accumulation',
}

describe('clamp', () => {
  it('returns the value when within bounds', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })
  it('clamps to the lower bound', () => {
    expect(clamp(-0.2, 0, 1)).toBe(0)
  })
  it('clamps to the upper bound', () => {
    expect(clamp(1.4, 0, 1)).toBe(1)
  })
})

describe('equityGlidepath', () => {
  it('returns the risk-bucket base at the reference horizon in accumulation', () => {
    expect(equityGlidepath(15, 'balanced', 'accumulation')).toBeCloseTo(0.7, 12)
  })

  it('is strictly increasing in horizon (interior)', () => {
    expect(equityGlidepath(20, 'balanced', 'accumulation')).toBeGreaterThan(
      equityGlidepath(10, 'balanced', 'accumulation'),
    )
  })

  it('is non-decreasing in horizon across the full range', () => {
    expect(equityGlidepath(30, 'balanced', 'accumulation')).toBeGreaterThanOrEqual(
      equityGlidepath(5, 'balanced', 'accumulation'),
    )
  })

  it('is strictly ordered by risk tolerance (interior)', () => {
    const cautious = equityGlidepath(15, 'cautious', 'accumulation')
    const balanced = equityGlidepath(15, 'balanced', 'accumulation')
    const adventurous = equityGlidepath(15, 'adventurous', 'accumulation')
    expect(cautious).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(adventurous)
  })

  it('assigns strictly less equity in decumulation than accumulation', () => {
    expect(equityGlidepath(15, 'balanced', 'decumulation')).toBeLessThan(
      equityGlidepath(15, 'balanced', 'accumulation'),
    )
  })

  it('clamps to the equity cap for aggressive long horizons', () => {
    expect(equityGlidepath(40, 'adventurous', 'accumulation')).toBe(EQUITY_CAP)
  })

  it('rejects a negative horizon', () => {
    expect(() => equityGlidepath(-1, 'balanced', 'accumulation')).toThrow(RangeError)
  })

  it('rejects an unknown risk tolerance', () => {
    expect(() => equityGlidepath(15, 'reckless' as never, 'accumulation')).toThrow(RangeError)
  })
})

describe('deriveStrategicAllocation', () => {
  it('produces weights that sum to 1 across many profiles', () => {
    const profiles: SuitabilityProfile[] = [
      {
        horizonYears: 30,
        riskTolerance: 'adventurous',
        phase: 'accumulation',
        trendAppetite: 1,
        tiltAppetite: 1,
      },
      { horizonYears: 5, riskTolerance: 'cautious', phase: 'decumulation' },
      { horizonYears: 20, riskTolerance: 'balanced', phase: 'accumulation', trendAppetite: 0.5 },
      { horizonYears: 10, riskTolerance: 'cautious', phase: 'accumulation', tiltAppetite: 0.3 },
    ]
    for (const p of profiles) {
      const a = deriveStrategicAllocation(p, { netAnnualPremium: 0.01 })
      const sum = a.sleeves.reduce((s, x) => s + x.weight, 0)
      expect(sum).toBeCloseTo(1, 9)
    }
  })

  it('never assigns a negative weight', () => {
    const a = deriveStrategicAllocation(
      {
        horizonYears: 40,
        riskTolerance: 'adventurous',
        phase: 'accumulation',
        trendAppetite: 1,
        tiltAppetite: 1,
      },
      { netAnnualPremium: 0.02 },
    )
    for (const s of a.sleeves) expect(s.weight).toBeGreaterThanOrEqual(0)
  })

  it('always retains at least the minimum ballast', () => {
    const a = deriveStrategicAllocation(
      { horizonYears: 40, riskTolerance: 'adventurous', phase: 'accumulation', trendAppetite: 1 },
      { netAnnualPremium: 0.01 },
    )
    expect(weightOf(a.sleeves, 'shortDurationBonds')).toBeGreaterThanOrEqual(BALLAST_MIN)
  })

  it('caps the trend sleeve at TREND_MAX for full appetite', () => {
    const a = deriveStrategicAllocation({ ...balancedAccum, trendAppetite: 1 })
    expect(weightOf(a.sleeves, 'trendFollowing')).toBeCloseTo(TREND_MAX, 12)
  })

  it('holds no trend sleeve when appetite is unset', () => {
    const a = deriveStrategicAllocation(balancedAccum)
    expect(weightOf(a.sleeves, 'trendFollowing')).toBe(0)
  })

  it('refuses the value+quality tilt when no evidence is supplied', () => {
    const a = deriveStrategicAllocation({ ...balancedAccum, tiltAppetite: 1 })
    expect(weightOf(a.sleeves, 'valueQualityTilt')).toBe(0)
  })

  it('refuses the value+quality tilt when the haircut premium is not positive', () => {
    const a = deriveStrategicAllocation(
      { ...balancedAccum, tiltAppetite: 1 },
      { netAnnualPremium: 0 },
    )
    expect(weightOf(a.sleeves, 'valueQualityTilt')).toBe(0)
  })

  it('sizes the tilt from appetite and equity when the premium is positive', () => {
    const a = deriveStrategicAllocation(
      { ...balancedAccum, tiltAppetite: 0.5 },
      { netAnnualPremium: 0.01 },
    )
    const equity = a.equityShare
    expect(weightOf(a.sleeves, 'valueQualityTilt')).toBeCloseTo(
      equity * TILT_MAX_FRACTION * 0.5,
      12,
    )
  })

  it('never tilts more than the tilt fraction of equity', () => {
    const a = deriveStrategicAllocation(
      { ...balancedAccum, tiltAppetite: 1 },
      { netAnnualPremium: 0.05 },
    )
    expect(weightOf(a.sleeves, 'valueQualityTilt')).toBeLessThanOrEqual(
      a.equityShare * TILT_MAX_FRACTION + 1e-12,
    )
  })

  it('the equity core is equity minus the tilt', () => {
    const a = deriveStrategicAllocation(
      { ...balancedAccum, tiltAppetite: 1 },
      { netAnnualPremium: 0.01 },
    )
    expect(weightOf(a.sleeves, 'globalEquityCore')).toBeCloseTo(
      a.equityShare - weightOf(a.sleeves, 'valueQualityTilt'),
      12,
    )
  })

  it('caps equity so the ballast floor survives a full trend sleeve', () => {
    const a = deriveStrategicAllocation(
      { horizonYears: 40, riskTolerance: 'adventurous', phase: 'accumulation', trendAppetite: 1 },
      { netAnnualPremium: 0.01 },
    )
    expect(a.equityShare).toBeCloseTo(1 - TREND_MAX - BALLAST_MIN, 12)
  })

  it('always attaches the doctrine-range caveat', () => {
    const a = deriveStrategicAllocation(balancedAccum)
    expect(a.caveats).toContain(DOCTRINE_RANGE_CAVEAT)
  })

  it('explains an omitted tilt when appetite was expressed without evidence', () => {
    const a = deriveStrategicAllocation({ ...balancedAccum, tiltAppetite: 1 })
    expect(a.caveats.some((c) => /tilt/i.test(c))).toBe(true)
  })

  it('flags the trend sleeve as convex diversification, not a return engine', () => {
    const a = deriveStrategicAllocation({ ...balancedAccum, trendAppetite: 1 })
    expect(a.caveats.some((c) => /trend/i.test(c))).toBe(true)
  })

  it('exposes all four sleeves', () => {
    const a = deriveStrategicAllocation(balancedAccum)
    expect(a.sleeves.map((s) => s.sleeve).sort()).toEqual(
      ['globalEquityCore', 'shortDurationBonds', 'trendFollowing', 'valueQualityTilt'].sort(),
    )
  })

  it('rejects a non-finite trend appetite', () => {
    expect(() =>
      deriveStrategicAllocation({ ...balancedAccum, trendAppetite: Number.NaN }),
    ).toThrow(RangeError)
  })

  it('rejects a non-finite tilt appetite', () => {
    expect(() =>
      deriveStrategicAllocation({ ...balancedAccum, tiltAppetite: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError)
  })
})
