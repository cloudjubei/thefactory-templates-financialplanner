import { describe, it, expect } from 'vitest'

import type { WrapperTaxTreatment } from './taxTypes.js'
import { afterWithdrawalTax, resolveWrapperTaxTreatment } from './taxUtils.js'

describe('resolveWrapperTaxTreatment', () => {
  it('TEE shelters everything: no relief, no growth drag, no withdrawal tax', () => {
    expect(resolveWrapperTaxTreatment({ wrapper: 'tee' })).toEqual({
      contributionMultiplier: 1,
      annualGrowthTaxDrag: 0,
      terminalWithdrawalTaxRate: 0,
    })
  })

  it('EET grosses up contributions by the relief and taxes the terminal', () => {
    expect(
      resolveWrapperTaxTreatment({
        wrapper: 'eet',
        marginalContributionRate: 0.2,
        withdrawalTaxRate: 0.15,
      }),
    ).toEqual({
      contributionMultiplier: 1.25,
      annualGrowthTaxDrag: 0,
      terminalWithdrawalTaxRate: 0.15,
    })
  })

  it('EET rejects a missing contribution rate', () => {
    expect(() => resolveWrapperTaxTreatment({ wrapper: 'eet', withdrawalTaxRate: 0.15 })).toThrow(
      RangeError,
    )
  })

  it('EET rejects a 100% contribution rate (would divide by zero)', () => {
    expect(() =>
      resolveWrapperTaxTreatment({
        wrapper: 'eet',
        marginalContributionRate: 1,
        withdrawalTaxRate: 0.15,
      }),
    ).toThrow(RangeError)
  })

  it('EET rejects a missing withdrawal rate', () => {
    expect(() =>
      resolveWrapperTaxTreatment({ wrapper: 'eet', marginalContributionRate: 0.2 }),
    ).toThrow(RangeError)
  })

  it('EET rejects a withdrawal rate outside [0,1]', () => {
    expect(() =>
      resolveWrapperTaxTreatment({
        wrapper: 'eet',
        marginalContributionRate: 0.2,
        withdrawalTaxRate: 1.2,
      }),
    ).toThrow(RangeError)
  })

  it('taxable applies the annual growth tax as a drag, nothing at withdrawal', () => {
    expect(resolveWrapperTaxTreatment({ wrapper: 'taxable', annualGrowthTaxRate: 0.019 })).toEqual({
      contributionMultiplier: 1,
      annualGrowthTaxDrag: 0.019,
      terminalWithdrawalTaxRate: 0,
    })
  })

  it('taxable defaults to a zero growth drag when the rate is omitted (fully shielded)', () => {
    expect(resolveWrapperTaxTreatment({ wrapper: 'taxable' })).toEqual({
      contributionMultiplier: 1,
      annualGrowthTaxDrag: 0,
      terminalWithdrawalTaxRate: 0,
    })
  })

  it('taxable rejects a negative growth tax rate', () => {
    expect(() =>
      resolveWrapperTaxTreatment({ wrapper: 'taxable', annualGrowthTaxRate: -0.01 }),
    ).toThrow(RangeError)
  })

  it('rejects an unknown wrapper type', () => {
    expect(() => resolveWrapperTaxTreatment({ wrapper: 'isa' as never })).toThrow(RangeError)
  })
})

describe('afterWithdrawalTax', () => {
  const eet: WrapperTaxTreatment = {
    contributionMultiplier: 1.25,
    annualGrowthTaxDrag: 0,
    terminalWithdrawalTaxRate: 0.15,
  }
  const tee: WrapperTaxTreatment = {
    contributionMultiplier: 1,
    annualGrowthTaxDrag: 0,
    terminalWithdrawalTaxRate: 0,
  }

  it('taxes the terminal at the withdrawal rate for EET', () => {
    expect(afterWithdrawalTax(1000, eet)).toBeCloseTo(850, 12)
  })

  it('leaves the terminal untouched when there is no withdrawal tax', () => {
    expect(afterWithdrawalTax(1000, tee)).toBe(1000)
  })

  it('rejects a non-finite terminal wealth', () => {
    expect(() => afterWithdrawalTax(Number.NaN, tee)).toThrow(RangeError)
  })
})
