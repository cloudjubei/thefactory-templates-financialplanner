import { describe, it, expect } from 'vitest'

import type { RiskTolerance, SuitabilityProfile } from '../allocation/allocationTypes.js'
import { assessSuitability, deriveAbility, resolveSuitability } from './suitabilityUtils.js'
import { createSuitabilityTools } from './SuitabilityTools.js'

describe('deriveAbility', () => {
  it('maps horizon to a capacity bucket in accumulation', () => {
    expect(deriveAbility(1, 'accumulation')).toBe('cautious')
    expect(deriveAbility(5, 'accumulation')).toBe('balanced')
    expect(deriveAbility(20, 'accumulation')).toBe('adventurous')
  })

  it('places the threshold boundaries on the balanced/adventurous side', () => {
    expect(deriveAbility(3, 'accumulation')).toBe('balanced')
    expect(deriveAbility(10, 'accumulation')).toBe('adventurous')
  })

  it('caps capacity one notch lower in decumulation (a drawdown while drawing down is unrecoverable)', () => {
    expect(deriveAbility(20, 'decumulation')).toBe('balanced')
    expect(deriveAbility(5, 'decumulation')).toBe('cautious')
    expect(deriveAbility(1, 'decumulation')).toBe('cautious')
  })

  it('rejects a non-finite or negative horizon', () => {
    expect(() => deriveAbility(-1, 'accumulation')).toThrow(RangeError)
    expect(() => deriveAbility(Number.NaN, 'accumulation')).toThrow(RangeError)
  })
})

describe('resolveSuitability', () => {
  it('takes the more conservative of willingness and ability', () => {
    expect(resolveSuitability('adventurous', 'cautious')).toEqual({
      effective: 'cautious',
      binding: 'ability',
    })
    expect(resolveSuitability('cautious', 'adventurous')).toEqual({
      effective: 'cautious',
      binding: 'willingness',
    })
  })

  it('reports "both" when they agree', () => {
    expect(resolveSuitability('balanced', 'balanced')).toEqual({
      effective: 'balanced',
      binding: 'both',
    })
  })
})

describe('assessSuitability', () => {
  const profile = (
    horizonYears: number,
    riskTolerance: RiskTolerance,
    phase: 'accumulation' | 'decumulation' = 'accumulation',
  ): SuitabilityProfile => ({ horizonYears, riskTolerance, phase })

  it('caps an over-eager investor to their horizon capacity (ability binds)', () => {
    const a = assessSuitability(profile(1, 'adventurous'))
    expect(a.willingness).toBe('adventurous')
    expect(a.ability).toBe('cautious')
    expect(a.effective).toBe('cautious')
    expect(a.binding).toBe('ability')
    expect(a.rationale.length).toBeGreaterThan(0)
  })

  it('respects a cautious investor even on a long horizon (willingness binds)', () => {
    const a = assessSuitability(profile(20, 'cautious'))
    expect(a.ability).toBe('adventurous')
    expect(a.effective).toBe('cautious')
    expect(a.binding).toBe('willingness')
  })

  it('agrees when appetite and capacity align', () => {
    const a = assessSuitability(profile(8, 'balanced'))
    expect(a.effective).toBe('balanced')
    expect(a.binding).toBe('both')
  })

  // The declared success criterion: effective is ALWAYS min(willingness, ability).
  it('always returns min(willingness, ability) across a labeled corpus', () => {
    const rank: Record<RiskTolerance, number> = { cautious: 0, balanced: 1, adventurous: 2 }
    const horizons = [0.5, 2, 3, 5, 9, 10, 25]
    const risks: RiskTolerance[] = ['cautious', 'balanced', 'adventurous']
    const phases = ['accumulation', 'decumulation'] as const
    for (const h of horizons) {
      for (const r of risks) {
        for (const p of phases) {
          const a = assessSuitability(profile(h, r, p))
          expect(rank[a.effective]).toBe(Math.min(rank[a.willingness], rank[a.ability]))
        }
      }
    }
  })
})

describe('createSuitabilityTools', () => {
  it('exposes assessSuitability as a tool', () => {
    const tools = createSuitabilityTools()
    const a = tools.assessSuitability({
      horizonYears: 30,
      riskTolerance: 'adventurous',
      phase: 'accumulation',
    })
    expect(a.effective).toBe('adventurous')
  })
})
