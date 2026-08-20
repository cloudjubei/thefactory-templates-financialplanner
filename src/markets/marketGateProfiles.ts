import type { GateConfigs } from '../gating/gatingTypes.js'

/**
 * Real, point-in-time per-market gate profiles for the first-cut markets (UK, PL).
 * The inflation/tax figures are the `[LIVE]` inputs the honesty-spine gates need,
 * sourced and dated below — in production these are refreshed from an authoritative
 * feed (staleness-suppressed); here they are pinned to their `asOf` snapshot so the
 * journey proof runs on real numbers rather than guesses.
 */

/** ISO-ish market code. */
export type MarketCode = 'UK' | 'PL' | 'DE' | 'US'

/** A market's honesty-spine gate configuration plus its provenance. */
export interface MarketGateProfile {
  /** Market code. */
  code: MarketCode
  /** Display name. */
  name: string
  /** Currency. */
  currency: string
  /** The deposit-guarantee scheme + per-depositor limit (display). */
  depositGuarantee: string
  /** The per-class gate thresholds derived from this market's inflation/tax. */
  gateConfig: GateConfigs
  /** Point-in-time snapshot the figures are current as of. */
  asOf: string
  /** Authoritative sources for the figures. */
  sources: string[]
}

// United Kingdom — CPI 2.9% (ONS, to Jul 2026); savings taxed at the 20% basic
// rate above the Personal Savings Allowance; FSCS deposit protection £120,000
// (from 1 Dec 2025). A 0.3% TER cap admits cheap global UCITS ETFs (Invesco
// FTSE All-World 0.15%, VWCE 0.22%) and rejects typical active funds (~0.75%+).
export const UK_GATE_PROFILE: MarketGateProfile = {
  code: 'UK',
  name: 'United Kingdom',
  currency: 'GBP',
  depositGuarantee: 'FSCS £120,000 per depositor',
  gateConfig: {
    savings: { expectedInflation: 0.029, taxRate: 0.2, minRealYield: 0 },
    fund: { maxTer: 0.003, minTrackingLowerBound: -0.005, requireUcits: true },
  },
  asOf: '2026-08',
  sources: [
    'https://www.ons.gov.uk/economy/inflationandpriceindices/bulletins/consumerpriceinflation/latest',
    'https://www.fscs.org.uk/what-we-cover/',
    'https://www.gov.uk/apply-tax-free-interest-on-savings',
  ],
}

// Poland — CPI 3.0% (GUS, to Jul 2026); interest/gains taxed at the 19% flat
// "Belka" rate; BFG deposit protection €100,000 per depositor. Same 0.3% TER cap.
export const PL_GATE_PROFILE: MarketGateProfile = {
  code: 'PL',
  name: 'Poland',
  currency: 'PLN',
  depositGuarantee: 'BFG €100,000 per depositor',
  gateConfig: {
    savings: { expectedInflation: 0.03, taxRate: 0.19, minRealYield: 0 },
    fund: { maxTer: 0.003, minTrackingLowerBound: -0.005, requireUcits: true },
  },
  asOf: '2026-08',
  sources: ['https://tradingeconomics.com/poland/inflation-cpi', 'https://www.bfg.pl/'],
}

// Germany — HICP 2.8% (Destatis, to Jul 2026); investment income taxed at the
// 26.375% Abgeltungsteuer (25% + solidarity surcharge, above the
// Sparer-Pauschbetrag); statutory Einlagensicherung €100,000. EU retail → UCITS
// required. Note: after that high tax, typical German cash is real-NEGATIVE — the
// gate exposes it, steering the plan toward a low-cost equity tracker.
export const DE_GATE_PROFILE: MarketGateProfile = {
  code: 'DE',
  name: 'Germany',
  currency: 'EUR',
  depositGuarantee: 'Einlagensicherung €100,000 per depositor',
  gateConfig: {
    savings: { expectedInflation: 0.028, taxRate: 0.26375, minRealYield: 0 },
    fund: { maxTer: 0.003, minTrackingLowerBound: -0.005, requireUcits: true },
  },
  asOf: '2026-08',
  sources: [
    'https://www.destatis.de/EN/Themes/Economy/Prices/Consumer-Price-Index/_node.html',
    'https://www.bundesbank.de/en/statistics/economic-activity-and-prices/harmonised-consumer-prices/harmonised-index-of-consumer-prices-932146',
  ],
}

// United States — CPI 3.4% (BLS, to Jul 2026); interest taxed as ordinary income
// (~22% representative federal marginal; state tax varies); FDIC $250,000.
// Crucially, US investors buy US-domiciled ETFs (VTI/VOO, ~0.03%) that are NOT
// UCITS — so UCITS is NOT required here (unlike the EU/UK markets).
export const US_GATE_PROFILE: MarketGateProfile = {
  code: 'US',
  name: 'United States',
  currency: 'USD',
  depositGuarantee: 'FDIC $250,000 per depositor',
  gateConfig: {
    savings: { expectedInflation: 0.034, taxRate: 0.22, minRealYield: 0 },
    fund: { maxTer: 0.003, minTrackingLowerBound: -0.005, requireUcits: false },
  },
  asOf: '2026-08',
  sources: [
    'https://www.bls.gov/news.release/cpi.nr0.htm',
    'https://www.fdic.gov/resources/deposit-insurance/',
  ],
}

/** All first-cut market gate profiles, keyed by code. */
export const MARKET_GATE_PROFILES: Record<MarketCode, MarketGateProfile> = {
  UK: UK_GATE_PROFILE,
  PL: PL_GATE_PROFILE,
  DE: DE_GATE_PROFILE,
  US: US_GATE_PROFILE,
}

// Accept the common code variants an app might carry (e.g. ISO 'GB' for the UK).
const MARKET_ALIASES: Record<string, MarketCode> = {
  UK: 'UK',
  GB: 'UK',
  PL: 'PL',
  POL: 'PL',
  DE: 'DE',
  DEU: 'DE',
  US: 'US',
  USA: 'US',
}

/** Look up a market's gate profile (accepting aliases like `GB`), or undefined. */
export function getMarketGateProfile(code: string): MarketGateProfile | undefined {
  const normalized = MARKET_ALIASES[(code ?? '').toUpperCase()]
  return normalized ? MARKET_GATE_PROFILES[normalized] : undefined
}

/** Convenience: a market's gate config, or undefined. */
export function getMarketGateConfig(code: string): GateConfigs | undefined {
  return getMarketGateProfile(code)?.gateConfig
}
