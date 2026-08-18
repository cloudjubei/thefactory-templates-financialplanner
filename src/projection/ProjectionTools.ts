import type { ProjectionRequest, ProjectionResult, ProjectionTools } from './projectionTypes.js'
import { createSeededRng, runProjection } from './projectionUtils.js'

export interface ProjectionToolsDeps {
  /**
   * Fallback PRNG used when a request omits `seed`. Defaults to `Math.random`;
   * injected in tests for determinism.
   */
  defaultRng?: () => number
}

export function createProjectionTools(deps: ProjectionToolsDeps = {}): ProjectionTools {
  const defaultRng = deps.defaultRng ?? Math.random
  return {
    projectWealth(request: ProjectionRequest): ProjectionResult {
      const rng = request.seed === undefined ? defaultRng : createSeededRng(request.seed)
      return runProjection({
        series: request.series,
        config: request.config,
        horizon: request.horizon,
        plan: request.plan,
        rng,
        goal: request.goal,
      })
    },
  }
}
