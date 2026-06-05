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
