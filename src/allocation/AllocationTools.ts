import type { AllocationRequest, AllocationTools, StrategicAllocation } from './allocationTypes.js'
import { deriveStrategicAllocation } from './allocationUtils.js'

export function createAllocationTools(): AllocationTools {
  return {
    deriveAllocation(request: AllocationRequest): StrategicAllocation {
      return deriveStrategicAllocation(request.profile, request.tiltEvidence)
    },
  }
}
