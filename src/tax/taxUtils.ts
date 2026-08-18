import type { WrapperTaxSpec, WrapperTaxTreatment } from './taxTypes.js'

function requireRate(value: number | undefined, label: string, maxExclusive: boolean): number {
  if (
    value === undefined ||
    !Number.isFinite(value) ||
    value < 0 ||
    (maxExclusive ? value >= 1 : value > 1)
  ) {
    throw new RangeError(
      `${label} must be a finite rate within [0,${maxExclusive ? '1)' : '1]'}, got ${value}`,
    )
  }
  return value
}

export function resolveWrapperTaxTreatment(spec: WrapperTaxSpec): WrapperTaxTreatment {
  switch (spec.wrapper) {
    case 'tee':
      return { contributionMultiplier: 1, annualGrowthTaxDrag: 0, terminalWithdrawalTaxRate: 0 }
    case 'eet': {
      const relief = requireRate(spec.marginalContributionRate, 'marginalContributionRate', true)
      const withdrawal = requireRate(spec.withdrawalTaxRate, 'withdrawalTaxRate', false)
      return {
        contributionMultiplier: 1 / (1 - relief),
        annualGrowthTaxDrag: 0,
        terminalWithdrawalTaxRate: withdrawal,
      }
    }
    case 'taxable': {
      const drag = spec.annualGrowthTaxRate ?? 0
      if (!Number.isFinite(drag) || drag < 0) {
        throw new RangeError(`annualGrowthTaxRate must be ≥ 0, got ${spec.annualGrowthTaxRate}`)
      }
      return { contributionMultiplier: 1, annualGrowthTaxDrag: drag, terminalWithdrawalTaxRate: 0 }
    }
    default:
      throw new RangeError(`unknown wrapper type: ${(spec as WrapperTaxSpec).wrapper}`)
  }
}

export function afterWithdrawalTax(terminalWealth: number, treatment: WrapperTaxTreatment): number {
  if (!Number.isFinite(terminalWealth)) {
    throw new RangeError(`terminalWealth must be finite, got ${terminalWealth}`)
  }
  return terminalWealth * (1 - treatment.terminalWithdrawalTaxRate)
}
