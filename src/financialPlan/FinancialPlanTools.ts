import { createSeededRng } from '../projection/projectionUtils.js'
import type {
  FinancialPlan,
  FinancialPlanRequest,
  FinancialPlanTools,
} from './financialPlanTypes.js'
import { composeFinancialPlan } from './financialPlanUtils.js'

export interface FinancialPlanToolsDeps {
  /**
   * Fallback PRNG used when a request omits `seed`. Defaults to `Math.random`;
   * injected in tests for determinism.
   */
  defaultRng?: () => number
}

export function createFinancialPlanTools(deps: FinancialPlanToolsDeps = {}): FinancialPlanTools {
  const defaultRng = deps.defaultRng ?? Math.random
  return {
    buildFinancialPlan(request: FinancialPlanRequest): FinancialPlan {
      const rng = request.seed === undefined ? defaultRng : createSeededRng(request.seed)
      return composeFinancialPlan(request, rng)
    },
  }
}
