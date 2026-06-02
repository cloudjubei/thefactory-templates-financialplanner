const moneyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatSignedMoney(value) {
  return `${value >= 0 ? "+" : "−"}${moneyFmt.format(Math.abs(value))}`;
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
    reason.textContent = pick.reason ?? "";
    li.append(sym, reason);
    list.append(li);
  }
  body.append(list);
}

function renderHoldings(holdings) {
  const tbody = document.getElementById("holdings-body");
  tbody.innerHTML = "";
  let cost = 0;
  let current = 0;
  for (const h of holdings) {
    const rowCost = Number(h.costBasis) || 0;
    const rowCurrent = Number(h.currentValue) || 0;
    const rowPnl = rowCurrent - rowCost;
    cost += rowCost;
    current += rowCurrent;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sym">${escapeHtml(h.symbol)}</td>
      <td>${escapeHtml(h.name)}</td>
      <td class="num">${h.quantity ?? 0}</td>
      <td class="num">${moneyFmt.format(rowCost)}</td>
      <td class="num">${moneyFmt.format(rowCurrent)}</td>
      <td class="num ${rowPnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatSignedMoney(rowPnl)}</td>
      <td class="row-actions">
        <button type="button" class="remove-holding" data-symbol="${escapeHtml(h.symbol)}" aria-label="Remove ${escapeHtml(h.symbol)}">×</button>
      </td>
    `;
    tbody.append(tr);
  }
  const pnl = current - cost;
  const pnlPct = cost === 0 ? 0 : (pnl / cost) * 100;
  document.getElementById("holdings-total").textContent =
    moneyFmt.format(current);
  document.getElementById("holdings-cost").textContent = moneyFmt.format(cost);
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

    projectionEl.textContent = moneyFmt.format(series.finalValue);
    investedEl.textContent = moneyFmt.format(series.invested);
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
                  `${ctx.dataset.label}: ${moneyFmt.format(ctx.parsed.y)}`,
              },
            },
          },
          scales: {
            y: {
              stacked: true,
              ticks: { callback: (v) => moneyFmt.format(v) },
            },
            x: { stacked: true },
          },
        },
      });
    }
  }

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
    renderTopPicks(topPicks);
    renderCalculator();
    setupHoldingControls();
    await ensureSeeded();
    await refreshHoldings();
  } catch (err) {
    const banner = document.createElement("pre");
    banner.style.cssText =
      "color:#dc2626;background:#fff;padding:12px;margin:0 0 16px;border:1px solid #fecaca;border-radius:8px;white-space:pre-wrap;";
    banner.textContent = `Failed to load template data: ${err && err.message ? err.message : err}\n\nThis template needs to be served over HTTP (e.g. \`python3 -m http.server\`) because the browser blocks file:// fetches.`;
    document.body.prepend(banner);
  }
}

init();
