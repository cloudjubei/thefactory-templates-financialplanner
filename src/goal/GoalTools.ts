import type { GoalTools } from './goalTypes.js'
import { assessFundedStatus, solveRequiredContribution } from './goalUtils.js'

export function createGoalTools(): GoalTools {
  return {
    assessFundedStatus(projection, target) {
      return assessFundedStatus(projection, target)
    },
    solveRequiredContribution(params) {
      return solveRequiredContribution(params)
    },
  }
}
