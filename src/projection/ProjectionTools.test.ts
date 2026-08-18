import { describe, it, expect } from 'vitest'

import { createProjectionTools } from './ProjectionTools.js'
import type { ProjectionRequest } from './projectionTypes.js'

const baseRequest: ProjectionRequest = {
  series: [-0.2, 0.25, -0.1, 0.3, 0.05, -0.15],
  config: { blockSize: 2, paths: 200 },
  horizon: { years: 5, periodsPerYear: 12 },
  plan: { initial: 1000, perPeriod: 50 },
  goal: 6000,
}

describe('createProjectionTools.projectWealth', () => {
  it('is reproducible when a seed is supplied', () => {
    const tools = createProjectionTools()
    const a = tools.projectWealth({ ...baseRequest, seed: 123 })
    const b = tools.projectWealth({ ...baseRequest, seed: 123 })
    expect(a).toEqual(b)
  })

  it('reproduces across independent tool instances for the same seed', () => {
    const a = createProjectionTools().projectWealth({ ...baseRequest, seed: 7 })
    const b = createProjectionTools().projectWealth({ ...baseRequest, seed: 7 })
    expect(a.terminal).toEqual(b.terminal)
    expect(a.probabilityOfSuccess).toBe(b.probabilityOfSuccess)
  })

  it('falls back to the injected default rng when no seed is given', () => {
    let calls = 0
    const defaultRng = () => {
      calls++
      return 0.5
    }
    const result = createProjectionTools({ defaultRng }).projectWealth({
      ...baseRequest,
      seed: undefined,
    })
    expect(calls).toBeGreaterThan(0)
    expect(result.paths).toBe(200)
  })

  it('reports a probability of success in [0,1] when a goal is set', () => {
    const result = createProjectionTools().projectWealth({ ...baseRequest, seed: 1 })
    expect(result.probabilityOfSuccess).toBeGreaterThanOrEqual(0)
    expect(result.probabilityOfSuccess).toBeLessThanOrEqual(1)
  })

  it('omits the probability of success when no goal is set', () => {
    const { goal, ...noGoal } = baseRequest
    void goal
    const result = createProjectionTools().projectWealth({ ...noGoal, seed: 1 })
    expect(result.probabilityOfSuccess).toBeUndefined()
  })

  it('produces a fan point per period plus the starting point', () => {
    const result = createProjectionTools().projectWealth({ ...baseRequest, seed: 1 })
    expect(result.fan).toHaveLength(5 * 12 + 1)
  })

  it('propagates a validation error for an empty return series', () => {
    expect(() =>
      createProjectionTools().projectWealth({ ...baseRequest, series: [], seed: 1 }),
    ).toThrow(RangeError)
  })
})
