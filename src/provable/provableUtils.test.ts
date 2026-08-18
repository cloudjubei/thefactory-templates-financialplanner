import { describe, it, expect } from 'vitest'

import type { ProvableMeasure } from './provableTypes.js'
import {
  isProvenPositive,
  passesProvableFloor,
  probabilityBeatsFloor,
  probabilityRealReturnNegative,
} from './provableUtils.js'

describe('probabilityBeatsFloor', () => {
  it('is the fraction of paths where the candidate strictly beats the floor', () => {
    expect(probabilityBeatsFloor([100, 200, 300, 400], [150, 150, 150, 500])).toBeCloseTo(0.5, 12)
  })

  it('a tie does not count as beating the floor', () => {
    expect(probabilityBeatsFloor([150], [150])).toBe(0)
  })

  it('rejects empty distributions', () => {
    expect(() => probabilityBeatsFloor([], [])).toThrow(RangeError)
  })

  it('rejects paired distributions of differing length', () => {
    expect(() => probabilityBeatsFloor([1, 2], [1])).toThrow(RangeError)
  })
})

describe('passesProvableFloor', () => {
  it('passes when the probability meets the threshold', () => {
    const c = passesProvableFloor([100, 200, 300, 400], [150, 150, 150, 500], 0.5)
    expect(c.probabilityBeatsFloor).toBeCloseTo(0.5, 12)
    expect(c.threshold).toBe(0.5)
    expect(c.passes).toBe(true)
  })

  it('fails when the probability is below the threshold', () => {
    const c = passesProvableFloor([100, 200, 300, 400], [150, 150, 150, 500], 0.6)
    expect(c.passes).toBe(false)
  })

  it('rejects a threshold outside [0,1]', () => {
    expect(() => passesProvableFloor([1], [0], 1.5)).toThrow(RangeError)
    expect(() => passesProvableFloor([1], [0], -0.1)).toThrow(RangeError)
  })
})

describe('probabilityRealReturnNegative', () => {
  it('is the fraction of outcomes below zero', () => {
    expect(probabilityRealReturnNegative([-0.02, 0.01, -0.03, 0.04])).toBeCloseTo(0.5, 12)
  })

  it('a zero real return is not negative', () => {
    expect(probabilityRealReturnNegative([0, -0.01])).toBeCloseTo(0.5, 12)
  })

  it('is zero when every outcome is positive', () => {
    expect(probabilityRealReturnNegative([0.01, 0.02])).toBe(0)
  })

  it('is one when every outcome is negative', () => {
    expect(probabilityRealReturnNegative([-0.01, -0.02])).toBe(1)
  })

  it('rejects an empty set', () => {
    expect(() => probabilityRealReturnNegative([])).toThrow(RangeError)
  })
})

describe('isProvenPositive', () => {
  it('se: proven when value minus sigmas*se exceeds zero', () => {
    const m: ProvableMeasure = {
      statistic: 'realYield',
      value: 0.03,
      uncertainty: { kind: 'se', standardError: 0.01 },
    }
    expect(isProvenPositive(m)).toBe(true)
  })

  it('se: not proven when the lower bound straddles zero', () => {
    const m: ProvableMeasure = {
      statistic: 'deflatedSharpe',
      value: 0.03,
      uncertainty: { kind: 'se', standardError: 0.02 },
    }
    expect(isProvenPositive(m)).toBe(false)
  })

  it('se: honours a custom sigma count', () => {
    const m: ProvableMeasure = {
      statistic: 'x',
      value: 0.03,
      uncertainty: { kind: 'se', standardError: 0.01 },
    }
    expect(isProvenPositive(m, 1)).toBe(true)
    expect(isProvenPositive(m, 4)).toBe(false)
  })

  it('ci: proven when the lower bound is above zero', () => {
    const m: ProvableMeasure = {
      statistic: 'trackingDifference',
      value: 0.02,
      uncertainty: { kind: 'ci', lower: 0.005, upper: 0.05 },
    }
    expect(isProvenPositive(m)).toBe(true)
  })

  it('ci: not proven when the interval includes zero', () => {
    const m: ProvableMeasure = {
      statistic: 'trackingDifference',
      value: 0.02,
      uncertainty: { kind: 'ci', lower: -0.01, upper: 0.05 },
    }
    expect(isProvenPositive(m)).toBe(false)
  })

  it('band: proven when the band floor is above zero', () => {
    const m: ProvableMeasure = {
      statistic: 'realYield',
      value: 0.01,
      uncertainty: { kind: 'band', lower: 0.001, upper: 0.02 },
    }
    expect(isProvenPositive(m)).toBe(true)
  })

  it('band: not proven when the band straddles zero', () => {
    const m: ProvableMeasure = {
      statistic: 'realYield',
      value: 0.01,
      uncertainty: { kind: 'band', lower: -0.02, upper: 0.02 },
    }
    expect(isProvenPositive(m)).toBe(false)
  })

  it('rejects a negative sigma count', () => {
    const m: ProvableMeasure = {
      statistic: 'x',
      value: 0.03,
      uncertainty: { kind: 'se', standardError: 0.01 },
    }
    expect(() => isProvenPositive(m, -1)).toThrow(RangeError)
  })
})
