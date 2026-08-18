/**
 * The structural wrapper-tax transform — replaces a single scalar "tax drag"
 * with the real three-stage treatment of a tax wrapper, because the wrapper is
 * the single most certain edge in a plan and a constant drag cannot express it.
 *
 * The three stages are contribution / growth / withdrawal, each either Taxed or
 * Exempt:
 * - **TEE** (Taxed-Exempt-Exempt): after-tax money in, tax-free growth, tax-free
 *   out — e.g. Roth, UK ISA, PL IKE.
 * - **EET** (Exempt-Exempt-Taxed): contribution relief at the marginal rate,
 *   tax-free growth, withdrawals taxed — e.g. Traditional 401k/IRA, PL IKZE,
 *   DE Rürup.
 * - **taxable**: after-tax money in, growth taxed each year, nothing more at the
 *   end — a standard brokerage/depot (an annual allowance is a later refinement).
 *
 * Every rate here is a decimal and is a `[LIVE]`, market-specific input sourced at
 * build-time — this module encodes the STRUCTURE, never a hardcoded rate.
 */

/** Which tax-wrapper structure an account uses. */
export type WrapperType = 'tee' | 'eet' | 'taxable'

/** A wrapper plus the (live-sourced) rates its treatment depends on. */
export interface WrapperTaxSpec {
  /** The wrapper structure. */
  wrapper: WrapperType
  /**
   * Marginal income-tax rate giving EET contribution relief, decimal in [0,1).
   * Required for `eet`; ignored otherwise.
   */
  marginalContributionRate?: number
  /**
   * Marginal rate applied to EET withdrawals at the horizon, decimal in [0,1].
   * Required for `eet`; ignored otherwise.
   */
  withdrawalTaxRate?: number
  /**
   * Effective annual tax drag on growth inside a taxable wrapper, decimal ≥ 0.
   * Used for `taxable`; defaults to 0 (fully allowance-shielded) when omitted.
   */
  annualGrowthTaxRate?: number
}

/** The resolved, projection-ready treatment derived from a {@link WrapperTaxSpec}. */
export interface WrapperTaxTreatment {
  /** Multiplier on each contribution — EET grosses up by the relief; else 1. */
  contributionMultiplier: number
  /** Per-year tax drag on returns — 0 when growth is sheltered (TEE/EET). */
  annualGrowthTaxDrag: number
  /** Rate applied to terminal wealth at withdrawal — non-zero only for EET. */
  terminalWithdrawalTaxRate: number
}
