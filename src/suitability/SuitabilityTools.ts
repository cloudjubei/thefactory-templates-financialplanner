import type { SuitabilityTools } from './suitabilityTypes.js'
import { assessSuitability } from './suitabilityUtils.js'

export function createSuitabilityTools(): SuitabilityTools {
  return {
    assessSuitability(profile) {
      return assessSuitability(profile)
    },
  }
}
