import { describe, it, expect } from 'vitest'

import type { Position, SeverityThresholds } from './surfacingTypes.js'
import {
  SEVERITY_RANK,
  assessMove,
  classifySeverity,
  opportunityIsHighlight,
  percentChange,
  portfolioStats,
  positionReturn,
  sortBySeverityDesc,
} from './surfacingUtils.js'

const THRESHOLDS: SeverityThresholds = { info: 0.02, notable: 0.05, critical: 0.1 }

describe('percentChange', () => {
  it('is the signed fractional change', () => {
    expect(percentChange(100, 110)).toBeCloseTo(0.1, 12)
    expect(percentChange(100, 90)).toBeCloseTo(-0.1, 12)
  })

  it('rejects a zero base', () => {
    expect(() => percentChange(0, 10)).toThrow(RangeError)
  })

  it('rejects a non-finite base', () => {
    expect(() => percentChange(Number.NaN, 10)).toThrow(RangeError)
  })
})

describe('classifySeverity', () => {
  it('maps magnitude to the band it reaches', () => {
    expect(classifySeverity(0.01, THRESHOLDS)).toBe('none')
    expect(classifySeverity(0.02, THRESHOLDS)).toBe('info')
    expect(classifySeverity(0.049, THRESHOLDS)).toBe('info')
    expect(classifySeverity(0.05, THRESHOLDS)).toBe('notable')
    expect(classifySeverity(0.1, THRESHOLDS)).toBe('critical')
    expect(classifySeverity(0.5, THRESHOLDS)).toBe('critical')
  })

  it('uses the absolute magnitude (sign-agnostic)', () => {
    expect(classifySeverity(-0.06, THRESHOLDS)).toBe('notable')
  })

  it('rejects misordered thresholds', () => {
    expect(() => classifySeverity(0.03, { info: 0.05, notable: 0.02, critical: 0.1 })).toThrow(
      RangeError,
    )
  })

  it('rejects a negative threshold', () => {
    expect(() => classifySeverity(0.03, { info: -0.01, notable: 0.05, critical: 0.1 })).toThrow(
      RangeError,
    )
  })
})

describe('assessMove', () => {
  it('surfaces a notable drop with direction down', () => {
    const a = assessMove({ from: 100, to: 94, thresholds: THRESHOLDS })
    expect(a.changePct).toBeCloseTo(-0.06, 12)
    expect(a.magnitude).toBeCloseTo(0.06, 12)
    expect(a.direction).toBe('down')
    expect(a.severity).toBe('notable')
    expect(a.surface).toBe(true)
  })

  it('does not surface a sub-threshold move', () => {
    const a = assessMove({ from: 100, to: 101, thresholds: THRESHOLDS })
    expect(a.direction).toBe('up')
    expect(a.severity).toBe('none')
    expect(a.surface).toBe(false)
  })

  it('reports a flat move', () => {
    const a = assessMove({ from: 100, to: 100, thresholds: THRESHOLDS })
    expect(a.direction).toBe('flat')
    expect(a.severity).toBe('none')
  })
})

describe('positionReturn', () => {
  it('computes absolute and fractional return', () => {
    expect(positionReturn({ costBasis: 100, currentValue: 130 })).toEqual({ pnl: 30, pnlPct: 0.3 })
  })

  it('handles a loss', () => {
    expect(positionReturn({ costBasis: 200, currentValue: 150 })).toEqual({
      pnl: -50,
      pnlPct: -0.25,
    })
  })

  it('returns a zero fractional return when there is no cost basis', () => {
    expect(positionReturn({ costBasis: 0, currentValue: 40 })).toEqual({ pnl: 40, pnlPct: 0 })
  })
})

describe('portfolioStats', () => {
  const positions: Position[] = [
    { costBasis: 100, currentValue: 110 },
    { costBasis: 200, currentValue: 140 },
    { costBasis: 50, currentValue: 75 },
  ]

  it('aggregates value, cost, and P&L', () => {
    const s = portfolioStats(positions)
    expect(s.totalValue).toBeCloseTo(325, 12)
    expect(s.totalCost).toBeCloseTo(350, 12)
    expect(s.pnl).toBeCloseTo(-25, 12)
    expect(s.pnlPct).toBeCloseTo(-25 / 350, 12)
  })

  it('picks the biggest mover by absolute fractional return', () => {
    const s = portfolioStats(positions)
    expect(s.biggestMover).toEqual({ index: 2, pnlPct: 0.5 })
  })

  it('is empty-safe (no positions → zeros and null mover)', () => {
    expect(portfolioStats([])).toEqual({
      totalValue: 0,
      totalCost: 0,
      pnl: 0,
      pnlPct: 0,
      biggestMover: null,
    })
  })
})

describe('opportunityIsHighlight', () => {
  const config = { minScore: 80, tiers: ['perfect', 'good'] }

  it('highlights an allowed tier at/above the score bar', () => {
    expect(opportunityIsHighlight({ tier: 'perfect', score: 85 }, config)).toBe(true)
    expect(opportunityIsHighlight({ tier: 'good', score: 80 }, config)).toBe(true)
  })

  it('does not highlight a disallowed tier', () => {
    expect(opportunityIsHighlight({ tier: 'ok', score: 99 }, config)).toBe(false)
  })

  it('does not highlight below the score bar', () => {
    expect(opportunityIsHighlight({ tier: 'perfect', score: 79 }, config)).toBe(false)
  })

  it('does not highlight a candidate with no tier or score', () => {
    expect(opportunityIsHighlight({}, config)).toBe(false)
  })
})

describe('sortBySeverityDesc', () => {
  it('orders items critical-first and is stable within a severity', () => {
    const items = [
      { id: 'a', sev: 'info' as const },
      { id: 'b', sev: 'critical' as const },
      { id: 'c', sev: 'none' as const },
      { id: 'd', sev: 'critical' as const },
      { id: 'e', sev: 'notable' as const },
    ]
    const sorted = sortBySeverityDesc(items, (i) => i.sev).map((i) => i.id)
    expect(sorted).toEqual(['b', 'd', 'e', 'a', 'c'])
  })

  it('does not mutate the input', () => {
    const items = [{ sev: 'info' as const }, { sev: 'critical' as const }]
    sortBySeverityDesc(items, (i) => i.sev)
    expect(items.map((i) => i.sev)).toEqual(['info', 'critical'])
  })
})

describe('SEVERITY_RANK', () => {
  it('orders the severities', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.notable)
    expect(SEVERITY_RANK.notable).toBeGreaterThan(SEVERITY_RANK.info)
    expect(SEVERITY_RANK.info).toBeGreaterThan(SEVERITY_RANK.none)
  })
})
