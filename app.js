// Money follows the active market's currency — the country the project
// subscribes to (USD by default, GBP/EUR/PLN once subscribed to those markets).
// Live records carry their own currency; holdings + totals use the active one.
let activeCurrency = "USD";
let recalcCalculator = null;
const currencyFmtCache = new Map();
function currencyFormatter(currency, digits) {
  const cur = currency || "USD";
  const cacheKey = `${cur}:${digits}`;
  let fmt = currencyFmtCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      maximumFractionDigits: digits,
    });
    currencyFmtCache.set(cacheKey, fmt);
  }
  return fmt;
}
function formatMoney(value, currency) {
  return currencyFormatter(currency || activeCurrency, 0).format(value);
}
function formatPrice(value, currency) {
  return currencyFormatter(currency || activeCurrency, 2).format(value);
}

function formatPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatSignedMoney(value, currency) {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${currencyFormatter(currency || activeCurrency, 0).format(Math.abs(value))}`;
}

async function loadJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path}: HTTP ${res.status}`);
  return res.json();
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// Holdings persistence. Embedded in Overseer → records go through the bridge
// (`holding` records keyed by symbol); standalone → localStorage. Same shape
// both ways, so the rest of the app doesn't care which backend is live.
const HOLDING_TYPE = "holding";
const SEED_KEY = "planner.holdings.v1";

function createHoldingsStore() {
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    return {
      async list() {
        const records = await bridge.queryData({ type: HOLDING_TYPE });
        return records.map((r) => r.content);
      },
      put: (h) =>
        bridge.putData({ type: HOLDING_TYPE, key: h.symbol, content: h }),
      remove: (symbol) =>
        bridge.deleteData({ type: HOLDING_TYPE, key: symbol }),
      async isSeeded() {
        const marker = await bridge.queryData({
          type: "planner-meta",
          key: "seeded",
        });
        return marker.length > 0;
      },
      markSeeded: () =>
        bridge.putData({
          type: "planner-meta",
          key: "seeded",
          content: { seeded: true },
        }),
    };
  }
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(SEED_KEY)) || [];
    } catch {
      return [];
    }
  };
  const write = (arr) => localStorage.setItem(SEED_KEY, JSON.stringify(arr));
  return {
    async list() {
      return read();
    },
    async put(h) {
      write([...read().filter((x) => x.symbol !== h.symbol), h]);
    },
    async remove(symbol) {
      write(read().filter((x) => x.symbol !== symbol));
    },
    async isSeeded() {
      return localStorage.getItem(SEED_KEY) !== null;
    },
    async markSeeded() {
      if (localStorage.getItem(SEED_KEY) === null) write([]);
    },
  };
}

const holdingsStore = createHoldingsStore();

// Seed the saved defaults exactly once. The marker survives the user clearing
// every holding, so we never re-add defaults they deliberately removed.
async function ensureSeeded() {
  if (await holdingsStore.isSeeded()) return;
  const defaults = await loadJson("./data/sample-holdings.json");
  for (const h of defaults) await holdingsStore.put(h);
  await holdingsStore.markSeeded();
}

async function refreshHoldings() {
  renderHoldings(await holdingsStore.list());
}

// --- Live data (read-only, via the Overseer bridge) -----------------------
// Records of the live-data sources this project is subscribed to. `livePrices`
// is keyed by UPPER-CASE symbol so a holding can show a live price; empty when
// standalone (no host bridge).
const livePrices = new Map();
let liveMarkets = [];

// Stooq quote symbols carry an exchange suffix (VOO.US, VOD.UK, BMW.DE) while a
// holding is entered bare (VOO). Strip the known market suffix so the two match.
function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/\.(US|UK|DE|PL)$/, "");
}

async function loadLiveData() {
  livePrices.clear();
  liveMarkets = [];
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !bridge.readLiveData) return;
  let subscribed;
  try {
    subscribed = await bridge.readLiveData();
  } catch {
    return;
  }
  let resolvedCurrency = null;
  for (const source of subscribed || []) {
    const recordType = source.recordType || "";
    if (!recordType.startsWith("stock-quote")) continue;
    const market = (
      (recordType.match(/-([a-z]{2})$/i) || [])[1] || ""
    ).toUpperCase();
    for (const rec of source.records || []) {
      const content = rec.content || {};
      const latest = content.latest;
      const value =
        latest && typeof latest.v === "number" ? latest.v : undefined;
      const currency =
        typeof content.currency === "string" ? content.currency : undefined;
      if (!resolvedCurrency && currency) resolvedCurrency = currency;
      liveMarkets.push({
        key: rec.key,
        market,
        value,
        currency,
        t: latest && latest.t,
      });
      if (value !== undefined && rec.key) {
        livePrices.set(normalizeSymbol(rec.key), {
          v: value,
          t: latest.t,
          currency,
        });
      }
    }
  }
  // The currency follows the subscribed market; values are already in major
  // units (the source scales sub-units like LSE pence), so they value directly.
  activeCurrency = resolvedCurrency || "USD";
}

function renderMarkets() {
  const card = document.getElementById("markets");
  const body = document.getElementById("markets-body");
  if (!window.OverseerBridge || !window.OverseerBridge.embedded) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  body.innerHTML = "";
  if (liveMarkets.length === 0) {
    body.className = "markets-empty";
    body.innerHTML = `<p>Subscribe this project to a live-data source in Overseer's <strong>Live Data</strong> tab to see prices here.</p>`;
    return;
  }
  body.className = "";
  const list = document.createElement("ul");
  list.className = "markets-list";
  for (const m of liveMarkets.slice(0, 24)) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.className = "market-symbol";
    left.textContent = m.market
      ? `${m.key} · ${m.market}`
      : String(m.key ?? "");
    const right = document.createElement("span");
    right.className = "market-value";
    right.textContent =
      m.value !== undefined ? formatPrice(m.value, m.currency) : "—";
    if (m.t) right.title = `as of ${m.t}`;
    li.append(left, right);
    list.append(li);
  }
  body.append(list);
}

async function refreshLive() {
  await loadLiveData();
  renderMarkets();
  await refreshHoldings();
  // loadLiveData may have changed the active currency; reformat the calculator.
  if (recalcCalculator) recalcCalculator();
}

function setupHoldingControls() {
  const form = document.getElementById("add-holding");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const symbol = String(data.get("symbol") || "")
      .trim()
      .toUpperCase();
    if (!symbol) return;
    await holdingsStore.put({
      symbol,
      name: String(data.get("name") || "").trim(),
      quantity: Number(data.get("quantity")) || 0,
      costBasis: Number(data.get("costBasis")) || 0,
      currentValue: Number(data.get("currentValue")) || 0,
    });
    form.reset();
    await refreshHoldings();
  });

  document
    .getElementById("holdings-body")
    .addEventListener("click", async (event) => {
      const btn = event.target.closest(".remove-holding");
      if (!btn) return;
      await holdingsStore.remove(btn.dataset.symbol);
      await refreshHoldings();
    });
}

function renderHero(config) {
  const heading = document.getElementById("welcome-heading");
  const sub = document.getElementById("welcome-subheading");
  if (config && typeof config.welcomeHeading === "string")
    heading.textContent = config.welcomeHeading;
  if (config && typeof config.welcomeSubheading === "string")
    sub.textContent = config.welcomeSubheading;
}

function renderTopPicks(picks) {
  const body = document.getElementById("top-picks-body");
  body.innerHTML = "";
  if (!Array.isArray(picks) || picks.length === 0) {
    body.className = "top-picks-empty";
    body.innerHTML = `
      <p class="empty-emoji" aria-hidden="true">✨</p>
      <p>Run the first story to fill this with picks tailored to your investment focus.</p>
    `;
    return;
  }
  body.className = "";
  const list = document.createElement("ul");
  list.className = "top-picks-list";
  for (const pick of picks) {
    const li = document.createElement("li");
    const sym = document.createElement("div");
    sym.className = "pick-symbol";
    const name = pick.name ? ` — ${pick.name}` : "";
    sym.textContent = `${pick.symbol ?? ""}${name}`;
    const reason = document.createElement("div");
    reason.className = "pick-reason";
    reason.textContent = pick.rationale ?? pick.reason ?? "";
    li.append(sym, reason);
    list.append(li);
  }
  body.append(list);
}

// --- Opportunities (analysis job, via the bridge) -------------------------
// The user's profile drives a backend web-search + LLM pass that writes an
// `opportunity` record; the app reads it for Top picks. Standalone (no host),
// the static seed picks are shown instead.
async function loadLatestOpportunities() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return null;
  try {
    const recs = await bridge.queryData({ type: "opportunity", key: "latest" });
    const content = recs && recs[0] && recs[0].content;
    return content && Array.isArray(content.items) ? content.items : [];
  } catch {
    return null;
  }
}

async function setupOpportunities(staticPicks) {
  const bridge = window.OverseerBridge;
  const form = document.getElementById("profile-form");
  const btn = document.getElementById("find-opportunities");
  const status = document.getElementById("opportunities-status");

  if (!bridge || !bridge.embedded) {
    if (form) form.hidden = true;
    renderTopPicks(staticPicks);
    return;
  }
  form.hidden = false;

  try {
    const recs = await bridge.queryData({ type: "profile", key: "profile" });
    const p = (recs && recs[0] && recs[0].content) || {};
    form.country.value = p.country || "";
    form.risk.value = p.risk || "balanced";
    form.preferences.value = p.preferences || "";
  } catch {
    // No saved profile yet — leave the form at its defaults.
  }

  const existing = await loadLatestOpportunities();
  renderTopPicks(existing && existing.length ? existing : staticPicks);

  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Finding…";
    if (status)
      status.textContent =
        "Searching the web and analysing — this can take a moment…";
    try {
      await bridge.putData({
        type: "profile",
        key: "profile",
        content: {
          country: form.country.value.trim(),
          risk: form.risk.value,
          preferences: form.preferences.value.trim(),
        },
      });
      const result = await bridge.runOpportunities();
      const items = (result && result.items) || [];
      renderTopPicks(items);
      if (status)
        status.textContent = items.length
          ? ""
          : "No opportunities found — try adjusting your profile.";
    } catch (err) {
      if (status)
        status.textContent = `Could not run analysis: ${err && err.message ? err.message : err}`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function renderHoldings(holdings) {
  const tbody = document.getElementById("holdings-body");
  tbody.innerHTML = "";
  let cost = 0;
  let current = 0;
  for (const h of holdings) {
    const live = livePrices.get(normalizeSymbol(h.symbol));
    const rowCost = Number(h.costBasis) || 0;
    const rowCurrent = live
      ? (Number(h.quantity) || 0) * live.v
      : Number(h.currentValue) || 0;
    const rowPnl = rowCurrent - rowCost;
    cost += rowCost;
    current += rowCurrent;
    const liveTag = live
      ? ` <span class="live-dot" title="Live ${escapeHtml(formatPrice(live.v, live.currency))}/share${live.t ? " @ " + escapeHtml(live.t) : ""}">● live</span>`
      : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sym">${escapeHtml(h.symbol)}${liveTag}</td>
      <td>${escapeHtml(h.name)}</td>
      <td class="num">${h.quantity ?? 0}</td>
      <td class="num">${formatMoney(rowCost)}</td>
      <td class="num${live ? " is-live" : ""}">${formatMoney(rowCurrent)}</td>
      <td class="num ${rowPnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatSignedMoney(rowPnl)}</td>
      <td class="row-actions">
        <button type="button" class="remove-holding" data-symbol="${escapeHtml(h.symbol)}" aria-label="Remove ${escapeHtml(h.symbol)}">×</button>
      </td>
    `;
    tbody.append(tr);
  }
  const pnl = current - cost;
  const pnlPct = cost === 0 ? 0 : (pnl / cost) * 100;
  document.getElementById("holdings-total").textContent = formatMoney(current);
  document.getElementById("holdings-cost").textContent = formatMoney(cost);
  const pnlEl = document.getElementById("holdings-pnl");
  pnlEl.textContent = `${formatSignedMoney(pnl)} (${formatPct(pnlPct)})`;
  pnlEl.className = pnl >= 0 ? "pnl-positive" : "pnl-negative";
}

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

let calculatorChart;

function renderCalculator() {
  const form = document.getElementById("calc-form");
  const projectionEl = document.getElementById("calc-projection");
  const investedEl = document.getElementById("calc-invested");
  const growthEl = document.getElementById("calc-growth");
  const canvas = document.getElementById("calc-chart");

  function recalc() {
    const principal =
      Number(document.getElementById("calc-principal").value) || 0;
    const monthly = Number(document.getElementById("calc-monthly").value) || 0;
    const annualReturnPct =
      Number(document.getElementById("calc-return").value) || 0;
    const years = Math.max(
      1,
      Number(document.getElementById("calc-years").value) || 1,
    );
    const series = projectSeries({
      principal,
      monthly,
      annualReturnPct,
      years,
    });

    projectionEl.textContent = formatMoney(series.finalValue);
    investedEl.textContent = formatMoney(series.invested);
    growthEl.textContent = formatSignedMoney(
      series.finalValue - series.invested,
    );

    if (!window.Chart) return;
    if (calculatorChart) {
      calculatorChart.data.labels = series.labels;
      calculatorChart.data.datasets[0].data = series.contributions;
      calculatorChart.data.datasets[1].data = series.growth;
      calculatorChart.update();
    } else {
      calculatorChart = new window.Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          labels: series.labels,
          datasets: [
            {
              label: "Contributions",
              data: series.contributions,
              borderColor: "#2563eb",
              backgroundColor: "rgba(37, 99, 235, 0.18)",
              fill: "origin",
              tension: 0.25,
              pointRadius: 0,
            },
            {
              label: "Growth",
              data: series.growth,
              borderColor: "#0ea5a4",
              backgroundColor: "rgba(14, 165, 164, 0.18)",
              fill: "-1",
              tension: 0.25,
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              display: true,
              position: "bottom",
              labels: { boxWidth: 12, usePointStyle: true },
            },
            tooltip: {
              callbacks: {
                label: (ctx) =>
                  `${ctx.dataset.label}: ${formatMoney(ctx.parsed.y)}`,
              },
            },
          },
          scales: {
            y: {
              stacked: true,
              ticks: { callback: (v) => formatMoney(v) },
            },
            x: { stacked: true },
          },
        },
      });
    }
  }

  recalcCalculator = recalc;
  form.addEventListener("input", recalc);
  recalc();
  // Chart.js loads with defer; ensure first draw runs once it's ready.
  if (!window.Chart) {
    const tick = () => (window.Chart ? recalc() : setTimeout(tick, 50));
    tick();
  }
}

async function init() {
  try {
    const [config, topPicks] = await Promise.all([
      loadJson("./data/config.json"),
      loadJson("./data/top-picks.json"),
    ]);
    renderHero(config);
    renderCalculator();
    setupHoldingControls();
    await setupOpportunities(topPicks);
    await ensureSeeded();
    await refreshHoldings();
    await refreshLive();
    // Keep live prices current without a manual reload; a transient bridge
    // failure must not become an unhandled rejection or stop the timer.
    setInterval(() => {
      refreshLive().catch(() => {});
    }, 60000);
  } catch (err) {
    const banner = document.createElement("pre");
    banner.style.cssText =
      "color:#dc2626;background:#fff;padding:12px;margin:0 0 16px;border:1px solid #fecaca;border-radius:8px;white-space:pre-wrap;";
    banner.textContent = `Failed to load template data: ${err && err.message ? err.message : err}\n\nThis template needs to be served over HTTP (e.g. \`python3 -m http.server\`) because the browser blocks file:// fetches.`;
    document.body.prepend(banner);
  }
}

init();
