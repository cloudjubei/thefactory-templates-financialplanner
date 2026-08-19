// Pure forecast math — no DOM, no bridge. Loaded before app.js as a classic
// script, so these declarations are shared globals. Used by both the Calculator
// (a single scenario) and the Forecast tab (three scenarios from the live
// portfolio value).

// Per-risk default annual nominal return assumptions (%). Deterministic v1 — an
// LLM assumption-sourcing / commentary layer is a documented later step.
const RISK_RETURN_BANDS = {
  cautious: { conservative: 3, expected: 4.5, optimistic: 6 },
  balanced: { conservative: 4, expected: 6.5, optimistic: 9 },
  adventurous: { conservative: 5, expected: 8.5, optimistic: 12 },
};
const FORECAST_DEFAULT_RISK = "balanced";
const FORECAST_DEFAULT_YEARS = 20;

function riskReturnBand(risk) {
  return RISK_RETURN_BANDS[risk] || RISK_RETURN_BANDS[FORECAST_DEFAULT_RISK];
}

// Compound a starting principal plus a fixed monthly contribution at a constant
// annual return, sampled once per year. Returns the series + summary figures.
function projectSeries({ principal, monthly, annualReturnPct, years }) {
  const r = annualReturnPct / 100 / 12;
  const labels = [];
  const balances = [];
  const contributions = [];
  const growth = [];
  for (let y = 0; y <= years; y++) {
    const n = y * 12;
    const invested = principal + monthly * n;
    const compounded = principal * Math.pow(1 + r, n);
    const contributedWithGrowth =
      r === 0
        ? monthly * n
        : monthly * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
    const balance = compounded + contributedWithGrowth;
    labels.push(`${y}y`);
    balances.push(balance);
    contributions.push(invested);
    growth.push(Math.max(0, balance - invested));
  }
  const lastYearMonths = years * 12;
  return {
    labels,
    balances,
    contributions,
    growth,
    finalValue: balances[balances.length - 1],
    invested: principal + monthly * lastYearMonths,
  };
}

// --- Probabilistic plan request (Forecast tab) ----------------------------
// Assembles a FinancialPlanRequest for the host `plan` activity
// (thefactory-financialtools). The block-bootstrap Monte-Carlo + doctrine
// allocation run SERVER-SIDE; this only maps the app's simple inputs. The
// deterministic band functions above stay for the Calculator + home digest.

// The app's 3-way risk → a suitability profile: higher risk lifts the trend
// sleeve appetite and enables the (haircut-gated) value+quality tilt.
const RISK_TO_PLAN_PROFILE = {
  cautious: { riskTolerance: "cautious", trendAppetite: 0.3, tiltAppetite: 0 },
  balanced: { riskTolerance: "balanced", trendAppetite: 0.5, tiltAppetite: 0.5 },
  adventurous: {
    riskTolerance: "adventurous",
    trendAppetite: 0.7,
    tiltAppetite: 1,
  },
};

// Doctrine default for the value+quality premium — haircut server-side
// (publication decay ½ per McLean-Pontiff, then the tilt's incremental cost).
// The allocator refuses the tilt if it doesn't survive positive.
const PLAN_TILT_PREMIUM = {
  rawAnnualPremium: 0.02,
  publicationRetention: 0.5,
  incrementalCost: 0.003,
};

// Account type → tax-wrapper structure. The RATES here are ILLUSTRATIVE
// placeholders, not real per-market figures — the real rates are [LIVE],
// sourced per market at build-time. Only the STRUCTURE (TEE/EET/taxable) is
// meaningful today.
const ACCOUNT_TYPE_TO_WRAPPER = {
  taxable: { wrapper: "taxable", annualGrowthTaxRate: 0.005 },
  taxfree: { wrapper: "tee" },
  taxrelief: { wrapper: "eet", marginalContributionRate: 0.2, withdrawalTaxRate: 0.15 },
};

function accountTypeToWrapper(accountType) {
  return ACCOUNT_TYPE_TO_WRAPPER[accountType] || ACCOUNT_TYPE_TO_WRAPPER.taxable;
}

function buildPlanRequest({
  risk,
  years,
  initial,
  monthly,
  goalAmount,
  sleeveReturns,
  accountType,
  seed,
}) {
  const mapped =
    RISK_TO_PLAN_PROFILE[risk] || RISK_TO_PLAN_PROFILE[FORECAST_DEFAULT_RISK];
  const horizonYears = Math.max(1, Number(years) || FORECAST_DEFAULT_YEARS);
  const request = {
    profile: {
      horizonYears,
      riskTolerance: mapped.riskTolerance,
      phase: "accumulation",
      trendAppetite: mapped.trendAppetite,
      tiltAppetite: mapped.tiltAppetite,
    },
    goal: {
      targetAmount: Math.max(0, Number(goalAmount) || 0),
      horizonYears,
    },
    contributions: {
      initial: Math.max(0, Number(initial) || 0),
      perPeriod: Math.max(0, Number(monthly) || 0),
    },
    sleeveReturns,
    config: { blockSize: 12, paths: 500 },
    periodsPerYear: 12,
    tiltPremium: PLAN_TILT_PREMIUM,
    wrapper: accountTypeToWrapper(accountType),
  };
  if (typeof seed === "number") request.seed = seed;
  return request;
}

// Three deterministic scenarios for the user's current portfolio, using the
// per-risk return band.
function buildForecast({ startingValue, monthly, years, risk }) {
  const band = riskReturnBand(risk);
  const run = (annualReturnPct) =>
    projectSeries({
      principal: startingValue,
      monthly,
      annualReturnPct,
      years,
    });
  return {
    years,
    risk,
    band,
    startingValue,
    monthly,
    conservative: run(band.conservative),
    expected: run(band.expected),
    optimistic: run(band.optimistic),
  };
}
