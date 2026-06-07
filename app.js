// --- Country + currency ---------------------------------------------------
// The four seeded markets. `marketSuffix` matches the live-data recordType
// (`stock-quote-<suffix>`); ISO `GB` maps to the `uk` market. All subscriptions
// stay on — the app filters to the selected country and formats in its currency.
const COUNTRY_CONFIG = {
  US: { label: "United States", currency: "USD", marketSuffix: "us" },
  GB: { label: "United Kingdom", currency: "GBP", marketSuffix: "uk" },
  DE: { label: "Germany", currency: "EUR", marketSuffix: "de" },
  PL: { label: "Poland", currency: "PLN", marketSuffix: "pl" },
};
const DEFAULT_COUNTRY = "US";
const CURRENCY_SYMBOL = { USD: "$", GBP: "£", EUR: "€", PLN: "zł" };
// Shared phrase used to identify (and later clear) the "tailored for another
// country" hint that Proposals + Home set on their status lines.
const STALE_COUNTRY_MARK = "made for a different country";
function countryLabel(code) {
  return COUNTRY_CONFIG[code] ? COUNTRY_CONFIG[code].label : code;
}

let activeCountry = DEFAULT_COUNTRY;
let activeCurrency = "USD";
let recalcCalculator = null;
let recalcForecast = null;
// The latest saved profile, kept in memory for the Home digest + advisor.
let appProfile = {};

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

// --- Profile (project-scoped record, merged on write) ---------------------
const PROFILE_LS_KEY = "planner.profile.v1";

async function loadProfile() {
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    try {
      const recs = await bridge.queryData({ type: "profile", key: "profile" });
      return (recs && recs[0] && recs[0].content) || {};
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(localStorage.getItem(PROFILE_LS_KEY)) || {};
  } catch {
    return {};
  }
}

async function saveProfile(patch) {
  const next = { ...(await loadProfile()), ...patch };
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    await bridge.putData({ type: "profile", key: "profile", content: next });
  } else {
    try {
      localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors (private mode, etc.)
    }
  }
  appProfile = next;
  return next;
}

// --- Holdings persistence -------------------------------------------------
const HOLDING_TYPE = "holding";
const SEED_KEY = "planner.holdings.v1";

// Multi-asset support. `stock`/`etf` can be matched to a live `stock-quote`
// source; everything else is valued from a manual figure (or amount invested).
const ASSET_CLASSES = [
  { value: "stock", label: "Stock" },
  { value: "etf", label: "ETF" },
  { value: "fund", label: "Fund" },
  { value: "bond", label: "Bond" },
  { value: "crypto", label: "Crypto" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];
const ASSET_CLASS_LABEL = new Map(ASSET_CLASSES.map((a) => [a.value, a.label]));
const MARKET_ASSET_CLASSES = new Set(["stock", "etf"]);

function slugify(text) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "item";
}

// `<assetClass>:<symbol-or-slug>[:account]` — stable identity for a holding.
function holdingKey(h) {
  const ident = h.symbol ? normalizeSymbol(h.symbol) : slugify(h.name);
  const parts = [h.assetClass || "other", ident];
  if (h.account) parts.push(slugify(h.account));
  return parts.join(":");
}

// One-shot rewrite of a pre-3.5 stock-only record into the multi-asset shape.
function migrateOldHolding(old) {
  return {
    assetClass: "stock",
    name: old.name || old.symbol || "",
    symbol: old.symbol ? normalizeSymbol(old.symbol) : undefined,
    quantity: Number(old.quantity) || undefined,
    amountInvested: Number(old.costBasis) || 0,
    currency: activeCurrency,
    currentValueManual:
      old.currentValue !== undefined
        ? Number(old.currentValue) || 0
        : undefined,
  };
}

function isOldHolding(h) {
  return (
    h &&
    h.assetClass === undefined &&
    (h.costBasis !== undefined || h.currentValue !== undefined)
  );
}

// Two holdings share a key when they are the same instrument in the same
// account, so combining them is non-destructive: positions aggregate, amounts
// sum. Identity fields (assetClass/symbol/account/name) come from `base`.
function mergeHoldings(base, add) {
  const sum = (a, b) => (Number(a) || 0) + (Number(b) || 0);
  const merged = {
    ...base,
    amountInvested: sum(base.amountInvested, add.amountInvested),
  };
  if (base.quantity !== undefined || add.quantity !== undefined) {
    merged.quantity = sum(base.quantity, add.quantity);
  }
  if (
    base.currentValueManual !== undefined ||
    add.currentValueManual !== undefined
  ) {
    merged.currentValueManual = sum(
      base.currentValueManual,
      add.currentValueManual,
    );
  }
  if (!merged.purchaseDate && add.purchaseDate)
    merged.purchaseDate = add.purchaseDate;
  return merged;
}

function createHoldingsStore() {
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    return {
      async list() {
        const records = await bridge.queryData({ type: HOLDING_TYPE });
        return records.map((r) => r.content);
      },
      put: (h) =>
        bridge.putData({ type: HOLDING_TYPE, key: holdingKey(h), content: h }),
      remove: (key) => bridge.deleteData({ type: HOLDING_TYPE, key }),
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
      const key = holdingKey(h);
      write([...read().filter((x) => holdingKey(x) !== key), h]);
    },
    async remove(key) {
      write(read().filter((x) => holdingKey(x) !== key));
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

async function ensureSeeded() {
  if (await holdingsStore.isSeeded()) return;
  const defaults = await loadJson("./data/sample-holdings.json");
  for (const h of defaults) await holdingsStore.put(h);
  await holdingsStore.markSeeded();
}

// Rewrite any pre-3.5 stock-only `holding` records into the multi-asset shape.
// Embedded: gated by a `planner-meta/migrated-holdings-v1` marker (re-keys the
// record + deletes the old key). Standalone: rewrites the localStorage array.
async function migrateHoldings() {
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    const marker = await bridge.queryData({
      type: "planner-meta",
      key: "migrated-holdings-v1",
    });
    if (marker.length > 0) return;
    const records = await bridge.queryData({ type: HOLDING_TYPE });
    // Collect migrated records by their new key first, merging any that collide,
    // so two old records (e.g. AAPL + AAPL.US) aggregate rather than overwrite.
    const writes = new Map();
    const oldKeys = [];
    for (const rec of records) {
      if (!isOldHolding(rec.content)) continue;
      const next = migrateOldHolding(rec.content);
      const newKey = holdingKey(next);
      const prior = writes.get(newKey);
      writes.set(newKey, prior ? mergeHoldings(prior, next) : next);
      if (rec.key !== newKey) oldKeys.push(rec.key);
    }
    for (const [key, content] of writes) {
      await bridge.putData({ type: HOLDING_TYPE, key, content });
    }
    for (const key of oldKeys) {
      if (!writes.has(key))
        await bridge.deleteData({ type: HOLDING_TYPE, key });
    }
    await bridge.putData({
      type: "planner-meta",
      key: "migrated-holdings-v1",
      content: { migrated: true },
    });
    return;
  }
  let arr;
  try {
    arr = JSON.parse(localStorage.getItem(SEED_KEY));
  } catch {
    return;
  }
  if (!Array.isArray(arr) || !arr.some(isOldHolding)) return;
  // Rebuild through a key-map so migrated duplicates collapse into one holding.
  const byKey = new Map();
  for (const h of arr) {
    const next = isOldHolding(h) ? migrateOldHolding(h) : h;
    const key = holdingKey(next);
    const prior = byKey.get(key);
    byKey.set(key, prior ? mergeHoldings(prior, next) : next);
  }
  localStorage.setItem(SEED_KEY, JSON.stringify([...byKey.values()]));
}

async function refreshHoldings() {
  renderHoldings(await holdingsStore.list());
  if (recalcForecast) recalcForecast();
  renderHomeDigest();
}

// --- Live data (read-only, via the bridge) --------------------------------
const livePrices = new Map();
// Every subscribed stock-quote record across all markets — the Market tab.
let allMarkets = [];
let marketSearch = "";
let marketCountry = "";

// FX rates relative to USD (USD→X), from the `fx-rate` live source; `USD` is the
// implicit base (= 1). The rest fill in when the project is subscribed to FX Rates.
const FX_CURRENCIES = Object.keys(CURRENCY_SYMBOL);
let fxRates = { USD: 1 };

function fxRate(currency) {
  return currency === "USD" ? 1 : fxRates[currency];
}

// Convert between any two of the app's currencies via the USD base. Returns the
// amount unchanged when same-currency or a rate is missing (FX not subscribed).
function convertCurrency(amount, fromCurrency, toCurrency) {
  if (!fromCurrency || !toCurrency || fromCurrency === toCurrency)
    return amount;
  const from = fxRate(fromCurrency);
  const to = fxRate(toCurrency);
  if (!from || !to) return amount;
  return (amount / from) * to;
}

// Market suffix (us/uk/de/pl) → its country config, for the Market tab labels.
const MARKET_BY_SUFFIX = {};
for (const [code, cfg] of Object.entries(COUNTRY_CONFIG)) {
  MARKET_BY_SUFFIX[cfg.marketSuffix] = { code, ...cfg };
}

// Stooq quote symbols carry an exchange suffix (VOO.US, VOD.UK); a holding is
// entered bare (VOO). Strip the known suffix so the two match + display cleanly.
function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/\.(US|UK|DE|PL)$/, "");
}

async function loadLiveData() {
  livePrices.clear();
  allMarkets = [];
  fxRates = { USD: 1 };
  // The portfolio's display currency follows the chosen country.
  activeCurrency = COUNTRY_CONFIG[activeCountry].currency;
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !bridge.readLiveData) return;
  let subscribed;
  try {
    subscribed = await bridge.readLiveData();
  } catch {
    return;
  }
  for (const source of subscribed || []) {
    const recordType = source.recordType || "";
    if (recordType === "fx-rate") {
      for (const rec of source.records || []) {
        const c = rec.content || {};
        for (const cur of FX_CURRENCIES) {
          if (typeof c[cur] === "number") fxRates[cur] = c[cur];
        }
      }
      continue;
    }
    if (!recordType.startsWith("stock-quote-")) continue;
    const market = MARKET_BY_SUFFIX[recordType.slice("stock-quote-".length)];
    for (const rec of source.records || []) {
      const content = rec.content || {};
      const latest = content.latest;
      const value =
        latest && typeof latest.v === "number" ? latest.v : undefined;
      const currency =
        typeof content.currency === "string"
          ? content.currency
          : (market && market.currency) || activeCurrency;
      allMarkets.push({
        key: rec.key,
        value,
        currency,
        t: latest && latest.t,
        market: market ? market.code : recordType.slice(12).toUpperCase(),
        history: Array.isArray(content.history) ? content.history : [],
      });
      // A holding can now be from any market, so match symbols across them all.
      if (value !== undefined && rec.key) {
        livePrices.set(normalizeSymbol(rec.key), {
          v: value,
          t: latest.t,
          currency,
        });
      }
    }
  }
}

// Percent change of a daily series over the last `days`: latest vs the most
// recent point at/before the cutoff. null when there isn't enough history.
function changeOverDays(history, days) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const last = history[history.length - 1];
  const lastT = Date.parse(last.t);
  if (Number.isNaN(lastT) || !last.v) return null;
  const cutoff = lastT - days * 86400000;
  let base = null;
  for (let i = history.length - 2; i >= 0; i--) {
    const t = Date.parse(history[i].t);
    if (!Number.isNaN(t) && t <= cutoff) {
      base = history[i];
      break;
    }
  }
  if (!base || !base.v) return null;
  return ((last.v - base.v) / base.v) * 100;
}

function pctText(p) {
  return p === null ? "—" : `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}
function pctClass(p) {
  return p === null ? "" : p >= 0 ? "pnl-positive" : "pnl-negative";
}

// A tiny inline-SVG trend line from the last ~30 history points.
function sparklineSvg(history, up) {
  const pts = (history || [])
    .slice(-30)
    .map((p) => p.v)
    .filter((v) => typeof v === "number");
  if (pts.length < 2) return "";
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = max - min || 1;
  const w = 72;
  const h = 22;
  const coords = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="sparkline ${up ? "is-up" : "is-down"}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>`;
}

function renderMarkets() {
  const body = document.getElementById("markets-body");
  if (!body) return;
  if (!window.OverseerBridge || !window.OverseerBridge.embedded) {
    body.className = "markets-empty";
    body.innerHTML = "<p>Open this project in Overseer to see live prices.</p>";
    return;
  }
  if (allMarkets.length === 0) {
    body.className = "markets-empty";
    body.innerHTML =
      "<p>No market data yet — subscribe to a stock source in Overseer's <strong>Live Data</strong> tab.</p>";
    return;
  }
  const term = marketSearch.trim().toUpperCase();
  const filtered = allMarkets.filter(
    (m) =>
      (!marketCountry || m.market === marketCountry) &&
      (!term || normalizeSymbol(m.key).includes(term)),
  );
  if (filtered.length === 0) {
    body.className = "markets-empty";
    const label = COUNTRY_CONFIG[marketCountry]
      ? COUNTRY_CONFIG[marketCountry].label
      : "";
    body.innerHTML = term
      ? `<p>No match for "${escapeHtml(marketSearch.trim())}"${label ? ` in ${escapeHtml(label)}` : ""}.</p>`
      : `<p>No live prices${label ? ` for ${escapeHtml(label)}` : ""} yet.</p>`;
    return;
  }
  body.className = "";
  body.innerHTML = "";
  const table = document.createElement("table");
  table.className = "markets-table";
  table.innerHTML =
    '<thead><tr><th>Symbol</th><th class="num">Price</th><th class="num">1d</th><th class="num">7d</th><th class="num">30d</th><th class="trend-col">Trend</th><th aria-label="Info"></th></tr></thead>';
  const tbody = document.createElement("tbody");
  for (const m of filtered.slice(0, 80)) {
    const sym = escapeHtml(normalizeSymbol(m.key));
    const price =
      m.value !== undefined
        ? escapeHtml(formatPrice(m.value, m.currency))
        : "—";
    const c1 = changeOverDays(m.history, 1);
    const c7 = changeOverDays(m.history, 7);
    const c30 = changeOverDays(m.history, 30);
    const trendUp = (c30 ?? c7 ?? c1 ?? 0) >= 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="market-symbol-cell">
        <span class="market-symbol">${sym}</span>
        <span class="market-badge">${escapeHtml(m.market)}</span>
      </td>
      <td class="num"${m.t ? ` title="as of ${escapeHtml(String(m.t))}"` : ""}>${price}</td>
      <td class="num ${pctClass(c1)}">${pctText(c1)}</td>
      <td class="num ${pctClass(c7)}">${pctText(c7)}</td>
      <td class="num ${pctClass(c30)}">${pctText(c30)}</td>
      <td class="market-trend">${sparklineSvg(m.history, trendUp)}</td>
      <td class="market-info-cell">
        <button type="button" class="market-info" data-key="${escapeHtml(m.key)}" data-symbol="${sym}" aria-label="About ${sym}">i</button>
      </td>
    `;
    tbody.append(tr);
  }
  table.append(tbody);
  body.append(table);
}

function setupMarket() {
  const input = document.getElementById("market-search");
  if (input) {
    input.addEventListener("input", () => {
      marketSearch = input.value;
      renderMarkets();
    });
  }
  const country = document.getElementById("market-country");
  if (country) {
    for (const [code, cfg] of Object.entries(COUNTRY_CONFIG)) {
      const opt = document.createElement("option");
      opt.value = code;
      opt.textContent = cfg.label;
      country.append(opt);
    }
    country.addEventListener("change", () => {
      marketCountry = country.value;
      renderMarkets();
    });
  }
  const body = document.getElementById("markets-body");
  if (body) {
    body.addEventListener("click", (event) => {
      const info = event.target.closest(".market-info");
      if (info) openAssetInfo({ symbol: info.dataset.symbol });
    });
  }
  setupAssetInfoModal();
  renderMarkets();
}

// --- Asset info ("i" button → a stored short description) -----------------
const ongoingAssetInfo = new Set();

function assetInfoId(asset) {
  return (
    String(asset.symbol || asset.name || "item")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

async function loadAssetInfo(id) {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return null;
  try {
    const recs = await bridge.queryData({ type: "asset-info", key: id });
    return (recs && recs[0] && recs[0].content) || null;
  } catch {
    return null;
  }
}

function renderAssetInfo(info) {
  const bodyEl = document.getElementById("asset-info-body");
  if (!bodyEl) return;
  bodyEl.innerHTML = "";
  if (!info || !info.summary) {
    const p = document.createElement("p");
    p.className = "asset-info-summary";
    p.textContent = "No description found — try again later.";
    bodyEl.append(p);
    return;
  }
  const summary = document.createElement("p");
  summary.className = "asset-info-summary";
  summary.textContent = info.summary;
  bodyEl.append(summary);
  const sources = Array.isArray(info.sources) ? info.sources : [];
  const sourcesEl = renderNewsSources(sources);
  if (sourcesEl) bodyEl.append(sourcesEl);
}

async function runAssetInfo(asset) {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !asset) return;
  const id = assetInfoId(asset);
  if (ongoingAssetInfo.has(id)) return;
  ongoingAssetInfo.add(id);
  try {
    await bridge.runJob("asset-info", { asset });
  } catch {
    // The backend writes the record even if the bridge timed out; re-read.
  } finally {
    ongoingAssetInfo.delete(id);
  }
}

async function openAssetInfo(asset) {
  const modal = document.getElementById("asset-info-modal");
  const titleEl = document.getElementById("asset-info-title");
  const bodyEl = document.getElementById("asset-info-body");
  if (!modal || !asset || !asset.symbol) return;
  titleEl.textContent = asset.name || asset.symbol;
  modal.hidden = false;
  const id = assetInfoId(asset);
  let info = await loadAssetInfo(id);
  if (info && info.summary) {
    renderAssetInfo(info);
    return;
  }
  bodyEl.innerHTML =
    '<p class="asset-info-summary">Looking it up… this can take up to a minute.</p>';
  await runAssetInfo(asset);
  info = await loadAssetInfo(id);
  renderAssetInfo(info);
}

function setupAssetInfoModal() {
  const modal = document.getElementById("asset-info-modal");
  if (!modal) return;
  const close = () => {
    modal.hidden = true;
  };
  const closeBtn = document.getElementById("asset-info-close");
  if (closeBtn) closeBtn.addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) close();
  });
}

async function refreshLive() {
  await loadLiveData();
  renderMarkets();
  await refreshHoldings();
  if (recalcCalculator) recalcCalculator();
}

// The holdings currently rendered, by key — lets row actions (edit/remove)
// resolve the full record without re-querying the store.
let holdingsByKey = new Map();
// Total current value of all holdings (the Forecast tab's starting base).
let portfolioCurrentValue = 0;
// Total amount invested across all holdings (the Home digest's delta base).
let portfolioInvested = 0;

// Whether `fromCur` can be expressed in `toCur` right now: same currency, or both
// FX rates are loaded (USD is the base and always has one; others need the FX
// Rates source subscribed).
function canConvert(fromCur, toCur) {
  if (!fromCur || fromCur === toCur) return true;
  return (
    typeof fxRate(fromCur) === "number" && typeof fxRate(toCur) === "number"
  );
}

// Express a native amount in the display currency when the FX rate is available,
// else keep it in its own currency and leave it unconverted. `approx` marks a
// converted (FX-rate) figure so the UI can flag it.
function toDisplayMoney(amount, fromCur) {
  const display = activeCurrency;
  const cur = fromCur || display;
  if (canConvert(cur, display)) {
    return {
      amount: convertCurrency(amount, cur, display),
      currency: display,
      approx: cur !== display,
    };
  }
  return { amount, currency: cur, approx: false };
}

// A holding's current value in its NATIVE currency: live (price × qty, in the
// quote's currency) for market assets with a quote, else the manual figure, else
// the amount invested (both in the holding's own currency). A non-positive quote
// means "no useful price", so it falls through rather than zeroing the holding.
function holdingNativeCurrent(h) {
  const cur = h.currency || activeCurrency;
  if (MARKET_ASSET_CLASSES.has(h.assetClass) && h.symbol) {
    const live = livePrices.get(normalizeSymbol(h.symbol));
    if (live && live.v > 0 && Number(h.quantity)) {
      return {
        amount: Number(h.quantity) * live.v,
        currency: live.currency || cur,
        live,
      };
    }
  }
  if (h.currentValueManual !== undefined && h.currentValueManual !== null) {
    return {
      amount: Number(h.currentValueManual) || 0,
      currency: cur,
      live: null,
    };
  }
  return { amount: Number(h.amountInvested) || 0, currency: cur, live: null };
}

// Current value in the display currency (or native + a flag when FX is missing).
function holdingCurrentValue(h) {
  const native = holdingNativeCurrent(h);
  const d = toDisplayMoney(native.amount, native.currency);
  return {
    value: d.amount,
    currency: d.currency,
    approx: d.approx,
    live: native.live,
  };
}

function renderHoldings(holdings) {
  const tbody = document.getElementById("holdings-body");
  tbody.innerHTML = "";
  holdingsByKey = new Map();
  let invSum = 0;
  let curSum = 0;
  let anyApprox = false;
  let unconverted = 0;
  for (const h of holdings) {
    const key = holdingKey(h);
    holdingsByKey.set(key, h);
    const invD = toDisplayMoney(
      Number(h.amountInvested) || 0,
      h.currency || activeCurrency,
    );
    const native = holdingNativeCurrent(h);
    const curD = toDisplayMoney(native.amount, native.currency);
    const live = native.live;
    // P&L only makes sense when invested + current resolve to the same currency.
    const rowPnl =
      invD.currency === curD.currency ? curD.amount - invD.amount : null;

    // A row contributes to the totals only when both legs are in the display
    // currency — otherwise summing it would mix currencies and mislead.
    if (invD.currency === activeCurrency && curD.currency === activeCurrency) {
      invSum += invD.amount;
      curSum += curD.amount;
      if (invD.approx || curD.approx) anyApprox = true;
    } else {
      unconverted++;
    }

    const badge = `<span class="asset-badge asset-${escapeHtml(h.assetClass || "other")}">${escapeHtml(ASSET_CLASS_LABEL.get(h.assetClass) || "Other")}</span>`;
    const symbolBit = h.symbol
      ? `<span class="asset-symbol">${escapeHtml(normalizeSymbol(h.symbol))}</span>`
      : "";
    const accountBit = h.account
      ? `<span class="asset-account">${escapeHtml(h.account)}</span>`
      : "";
    const liveTag = live
      ? `<span class="live-dot" title="Live ${escapeHtml(formatPrice(live.v, live.currency))}/share${live.t ? " @ " + escapeHtml(live.t) : ""}">● live</span>`
      : "";
    const investedText = `${invD.approx ? "≈ " : ""}${formatMoney(invD.amount, invD.currency)}`;
    const currentText = `${curD.approx ? "≈ " : ""}${formatMoney(curD.amount, curD.currency)}`;
    const pnlText =
      rowPnl === null
        ? "—"
        : `${invD.approx || curD.approx ? "≈ " : ""}${formatSignedMoney(rowPnl, curD.currency)}`;
    const pnlClass =
      rowPnl === null ? "" : rowPnl >= 0 ? "pnl-positive" : "pnl-negative";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="asset-cell">
        <span class="asset-name">${escapeHtml(h.name)}</span>
        <span class="asset-meta">${badge}${symbolBit}${accountBit}${liveTag}</span>
      </td>
      <td class="num">${h.quantity ? escapeHtml(String(h.quantity)) : "—"}</td>
      <td class="num">${investedText}</td>
      <td class="num${live ? " is-live" : ""}">${currentText}</td>
      <td class="num ${pnlClass}">${pnlText}</td>
      <td class="row-actions">
        <button type="button" class="edit-holding" data-key="${escapeHtml(key)}" aria-label="Edit ${escapeHtml(h.name)}">Edit</button>
        <button type="button" class="remove-holding" data-key="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(h.name)}">×</button>
      </td>
    `;
    tbody.append(tr);
  }
  portfolioCurrentValue = curSum;
  portfolioInvested = invSum;
  const pnl = curSum - invSum;
  // No invested base → a percentage is undefined; show "—" rather than a
  // misleading "+0.0%" next to a real money gain.
  const pctText = invSum === 0 ? "—" : formatPct((pnl / invSum) * 100);
  const approx = anyApprox ? "≈ " : "";
  document.getElementById("holdings-total").textContent =
    approx + formatMoney(curSum);
  document.getElementById("holdings-cost").textContent =
    approx + formatMoney(invSum);
  const pnlEl = document.getElementById("holdings-pnl");
  pnlEl.textContent = `${approx}${formatSignedMoney(pnl)} (${pctText})`;
  pnlEl.className = pnl >= 0 ? "pnl-positive" : "pnl-negative";

  const fxNote = document.getElementById("portfolio-fx-note");
  if (fxNote) {
    if (unconverted > 0) {
      fxNote.innerHTML = `${unconverted} holding${unconverted > 1 ? "s" : ""} shown in ${unconverted > 1 ? "their" : "its"} own currency and excluded from the totals — subscribe to <strong>FX Rates</strong> in Overseer's Live Data tab to convert.`;
      fxNote.hidden = false;
    } else if (anyApprox) {
      fxNote.textContent =
        "Totals are approximate — converted from other currencies at the latest daily FX rates.";
      fxNote.hidden = false;
    } else {
      fxNote.hidden = true;
    }
  }
}

// --- Add / edit holding form (in a modal) ---------------------------------
let editingKey = null;

function openHoldingModal() {
  const modal = document.getElementById("holding-modal");
  if (modal) modal.hidden = false;
}

function closeHoldingModal() {
  const modal = document.getElementById("holding-modal");
  if (modal) modal.hidden = true;
}

function resetHoldingForm() {
  const form = document.getElementById("add-holding");
  form.reset();
  form.currentValueManual.placeholder = "auto";
  form.currency.value = activeCurrency;
  syncHoldingFormPrefix();
  editingKey = null;
  document.getElementById("holding-form-title").textContent = "Add a holding";
  document.getElementById("holding-submit").textContent = "Add holding";
}

// Prefill the form (from a proposal's "I bought this") without entering edit
// mode — it's still a brand-new holding the user is adding.
function prefillHolding(seed) {
  const form = document.getElementById("add-holding");
  resetHoldingForm();
  const known = ASSET_CLASS_LABEL.has(seed.assetClass);
  form.assetClass.value = known
    ? seed.assetClass
    : seed.symbol
      ? "stock"
      : "other";
  form.name.value = seed.name || "";
  form.symbol.value = seed.symbol ? normalizeSymbol(seed.symbol) : "";
  // The modal lives inside the Portfolio panel, so reveal that tab first (its
  // `hashchange` is async, so call showTab synchronously too).
  location.hash = "portfolio";
  showTab("portfolio");
  openHoldingModal();
  form.amountInvested.focus();
}

function startEditHolding(key) {
  const h = holdingsByKey.get(key);
  if (!h) return;
  const form = document.getElementById("add-holding");
  form.assetClass.value = ASSET_CLASS_LABEL.has(h.assetClass)
    ? h.assetClass
    : "other";
  form.name.value = h.name || "";
  form.symbol.value = h.symbol ? normalizeSymbol(h.symbol) : "";
  form.currency.value = h.currency || activeCurrency;
  syncHoldingFormPrefix();
  form.quantity.value = h.quantity ?? "";
  form.amountInvested.value = h.amountInvested ?? "";
  form.currentValueManual.value =
    typeof h.currentValueManual === "number" ? h.currentValueManual : "";
  // When a live quote is driving this row's value, a manual figure would be
  // ignored — show the live value as the placeholder so that's clear. Use the
  // native figure so it matches the form's holding-currency prefix.
  const native = holdingNativeCurrent(h);
  form.currentValueManual.placeholder = native.live
    ? `${formatMoney(native.amount, native.currency)} (live)`
    : "auto";
  form.account.value = h.account || "";
  form.purchaseDate.value = h.purchaseDate || "";
  editingKey = key;
  document.getElementById("holding-form-title").textContent = "Edit holding";
  document.getElementById("holding-submit").textContent = "Save changes";
  openHoldingModal();
}

function readHoldingForm(form) {
  const data = new FormData(form);
  const name = String(data.get("name") || "").trim();
  if (!name) return null;
  const symbolRaw = String(data.get("symbol") || "").trim();
  const accountRaw = String(data.get("account") || "").trim();
  const manualRaw = String(data.get("currentValueManual") || "").trim();
  const qtyRaw = String(data.get("quantity") || "").trim();
  const holding = {
    assetClass: String(data.get("assetClass") || "other"),
    name,
    amountInvested: Number(data.get("amountInvested")) || 0,
    currency: String(data.get("currency") || activeCurrency),
  };
  if (symbolRaw) holding.symbol = normalizeSymbol(symbolRaw);
  if (qtyRaw) holding.quantity = Number(qtyRaw) || 0;
  if (manualRaw) holding.currentValueManual = Number(manualRaw) || 0;
  if (accountRaw) holding.account = accountRaw;
  const purchaseDate = String(data.get("purchaseDate") || "").trim();
  if (purchaseDate) holding.purchaseDate = purchaseDate;
  return holding;
}

// Keep the add-holding money prefixes on the currency the user picked for the
// holding (not the display currency).
function syncHoldingFormPrefix() {
  const form = document.getElementById("add-holding");
  if (!form || !form.currency) return;
  const sym = CURRENCY_SYMBOL[form.currency.value] || form.currency.value;
  for (const el of form.querySelectorAll(".currency-prefix")) {
    el.textContent = sym;
  }
}

function setupHoldingControls() {
  const form = document.getElementById("add-holding");
  form.currency.addEventListener("change", syncHoldingFormPrefix);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const holding = readHoldingForm(form);
    if (!holding) return;
    const newKey = holdingKey(holding);
    // Editing with an unchanged key just replaces that record. Otherwise (a new
    // add, or an edit whose key now points elsewhere) never overwrite a different
    // holding sitting at the target key — merge into it so nothing is lost.
    if (editingKey === newKey) {
      await holdingsStore.put(holding);
    } else {
      const existing = holdingsByKey.get(newKey);
      if (editingKey) await holdingsStore.remove(editingKey);
      await holdingsStore.put(
        existing ? mergeHoldings(existing, holding) : holding,
      );
    }
    resetHoldingForm();
    closeHoldingModal();
    await refreshHoldings();
  });

  const openBtn = document.getElementById("add-holding-open");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      resetHoldingForm();
      openHoldingModal();
      form.name.focus();
    });
  }

  document.getElementById("holding-cancel").addEventListener("click", () => {
    resetHoldingForm();
    closeHoldingModal();
  });

  const modal = document.getElementById("holding-modal");
  if (modal) {
    // Backdrop click (the overlay itself, not the card) closes the modal.
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        resetHoldingForm();
        closeHoldingModal();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) {
        resetHoldingForm();
        closeHoldingModal();
      }
    });
  }

  document
    .getElementById("holdings-body")
    .addEventListener("click", async (event) => {
      const editBtn = event.target.closest(".edit-holding");
      if (editBtn) {
        startEditHolding(editBtn.dataset.key);
        return;
      }
      const removeBtn = event.target.closest(".remove-holding");
      if (!removeBtn) return;
      if (editingKey === removeBtn.dataset.key) resetHoldingForm();
      await holdingsStore.remove(removeBtn.dataset.key);
      await refreshHoldings();
    });
}

// --- Proposals (the opportunity analysis job, via the bridge) -------------
// Map a (real, propagated) analysis error into a short user-facing line, falling
// back to the raw message so an unexpected failure is still legible.
function analysisErrorText(err) {
  const msg = err && err.message ? String(err.message) : "";
  if (/bridge timeout/i.test(msg))
    return "Still working in the background — results will appear shortly.";
  if (/no web search providers/i.test(msg))
    return "No web-search provider is configured — add one in Overseer settings.";
  if (/\b429\b|rate.?limit/i.test(msg))
    return "The web-search provider is rate-limited — try again in a minute.";
  return (
    msg || "That hit an error — it may still be finishing. Try again shortly."
  );
}

// The static picks shown when no live proposals exist yet (set in setupProposals).
let proposalsStaticPicks = [];

async function refreshProposalsFromStore() {
  const content = await loadLatestOpportunityContent();
  const items = content && Array.isArray(content.items) ? content.items : [];
  renderTopPicks(items.length ? items : proposalsStaticPicks);
  const status = document.getElementById("opportunities-status");
  if (!status) return;
  if (content && content.country && content.country !== activeCountry) {
    status.textContent = `These proposals were ${STALE_COUNTRY_MARK} — "Find opportunities" again to tailor them to ${countryLabel(activeCountry)}.`;
  } else if (status.textContent.includes(STALE_COUNTRY_MARK)) {
    // Clear only our own stale note, never a findProposals empty/error message.
    status.textContent = "";
  }
}

function renderTopPicks(picks) {
  const body = document.getElementById("top-picks-body");
  body.innerHTML = "";
  if (!Array.isArray(picks) || picks.length === 0) {
    body.className = "top-picks-empty";
    body.innerHTML = `
      <p class="empty-emoji" aria-hidden="true">✨</p>
      <p>Set your profile, then "Find opportunities" to fill this in.</p>
    `;
    return;
  }
  body.className = "";
  const list = document.createElement("ul");
  list.className = "top-picks-list";
  for (const pick of picks) {
    list.append(renderPickCard(pick));
  }
  body.append(list);
}

// One expandable proposal card: a clickable header (symbol/name + asset badge),
// and collapsible details (the rationale, where to get it, and actions).
function renderPickCard(pick) {
  const li = document.createElement("li");
  li.className = "pick";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "pick-header";
  header.setAttribute("aria-expanded", "false");
  const sym = document.createElement("span");
  sym.className = "pick-symbol";
  const name = pick.name ? (pick.symbol ? ` — ${pick.name}` : pick.name) : "";
  sym.textContent = `${pick.symbol ?? ""}${name}`;
  header.append(sym);
  if (pick.assetClass) {
    const badge = document.createElement("span");
    badge.className = `asset-badge asset-${pick.assetClass}`;
    badge.textContent =
      ASSET_CLASS_LABEL.get(pick.assetClass) || pick.assetClass;
    header.append(badge);
  }
  const chevron = document.createElement("span");
  chevron.className = "pick-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▸";
  header.append(chevron);

  const details = document.createElement("div");
  details.className = "pick-details";
  details.hidden = true;
  const reason = document.createElement("div");
  reason.className = "pick-reason";
  reason.textContent = pick.rationale ?? pick.whyItFits ?? pick.reason ?? "";
  details.append(reason);
  if (pick.whereAvailable) {
    const where = document.createElement("div");
    where.className = "pick-where";
    where.textContent = `Where: ${pick.whereAvailable}`;
    details.append(where);
  }
  details.append(renderPickActions(pick));

  header.addEventListener("click", () => {
    const open = details.hidden;
    details.hidden = !open;
    header.setAttribute("aria-expanded", String(open));
    chevron.textContent = open ? "▾" : "▸";
  });

  li.append(header, details);
  return li;
}

function renderPickActions(pick) {
  const actions = document.createElement("div");
  actions.className = "pick-actions";
  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "pick-buy";
  buy.textContent = "I bought this";
  buy.dataset.name = pick.name || pick.symbol || "";
  if (pick.symbol) buy.dataset.symbol = pick.symbol;
  if (pick.assetClass) buy.dataset.assetClass = pick.assetClass;
  actions.append(buy);
  if (window.OverseerBridge && window.OverseerBridge.embedded) {
    const investigate = document.createElement("button");
    investigate.type = "button";
    investigate.className = "pick-investigate";
    investigate.dataset.name = pick.name || pick.symbol || "";
    if (pick.symbol) investigate.dataset.symbol = pick.symbol;
    if (pick.assetClass) investigate.dataset.assetClass = pick.assetClass;
    applyInvestigateButtonState(investigate);
    actions.append(investigate);
  }
  return actions;
}

async function loadLatestOpportunityContent() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return null;
  try {
    const recs = await bridge.queryData({ type: "opportunity", key: "latest" });
    return (recs && recs[0] && recs[0].content) || null;
  } catch {
    return null;
  }
}

async function loadLatestOpportunities() {
  const content = await loadLatestOpportunityContent();
  if (content === null) return null;
  return Array.isArray(content.items) ? content.items : [];
}

async function setupProposals(staticPicks) {
  proposalsStaticPicks = staticPicks || [];
  const bridge = window.OverseerBridge;
  const btn = document.getElementById("find-opportunities");
  const status = document.getElementById("opportunities-status");

  document
    .getElementById("top-picks-body")
    .addEventListener("click", (event) => {
      const investigate = event.target.closest(".pick-investigate");
      if (investigate) {
        if (investigate.classList.contains("is-done")) {
          location.hash = "investigations";
        } else if (!investigate.classList.contains("is-ongoing")) {
          runInvestigation({
            name: investigate.dataset.name,
            symbol: investigate.dataset.symbol,
            assetClass: investigate.dataset.assetClass,
          });
        }
        return;
      }
      const buy = event.target.closest(".pick-buy");
      if (!buy) return;
      prefillHolding({
        name: buy.dataset.name,
        symbol: buy.dataset.symbol,
        assetClass: buy.dataset.assetClass,
      });
    });

  if (!bridge || !bridge.embedded) {
    btn.disabled = true;
    if (status)
      status.textContent =
        "Open this project in Overseer to find live proposals.";
    renderTopPicks(staticPicks);
    return;
  }

  const existing = await loadLatestOpportunities();
  renderTopPicks(existing && existing.length ? existing : staticPicks);

  btn.addEventListener("click", findProposals);
}

// Run the opportunities job, then re-read `opportunity/latest` and render it.
// Shared by the Proposals "Find" button and the Start onboarding wizard, so it
// drives its own button/status state and never throws to the caller.
async function findProposals() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return;
  const btn = document.getElementById("find-opportunities");
  const status = document.getElementById("opportunities-status");
  const original = btn ? btn.textContent : "";
  const before = await loadLatestOpportunityContent();
  const beforeAt = before && before.generatedAt;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Finding…";
    btn.classList.add("is-loading");
  }
  if (status)
    status.textContent =
      "Searching the web and analysing — this can take a minute or two…";
  setTabBusy("proposals", true);

  let runError;
  try {
    await bridge.runJob("opportunities");
  } catch (err) {
    runError = err;
  }
  // Re-read regardless: the backend writes `opportunity/latest` even if the
  // bridge call timed out, so a slow-but-completed run still shows its result.
  const content = await loadLatestOpportunityContent();
  const produced =
    content && content.generatedAt && content.generatedAt !== beforeAt;

  if (btn) {
    btn.disabled = false;
    btn.textContent = original;
    btn.classList.remove("is-loading");
  }
  setTabBusy("proposals", false);
  if (produced) {
    const items = Array.isArray(content.items) ? content.items : [];
    renderTopPicks(items);
    setTabUnread("proposals", items.length);
    if (status)
      status.textContent = items.length
        ? ""
        : "No opportunities found — try adjusting your profile.";
  } else if (runError) {
    if (status) status.textContent = analysisErrorText(runError);
  } else if (status) {
    status.textContent = "Couldn't get opportunities just now — try again.";
  }
}

// --- Home (daily digest + advisor) ----------------------------------------
const ADVICE_STALE_MS = 24 * 60 * 60 * 1000;
const HOME_SEEN_LS_KEY = "planner.homeSeen.v1";
let advisorAutoRanThisSession = false;

async function loadLatestAdvice() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return null;
  try {
    const recs = await bridge.queryData({ type: "advice", key: "latest" });
    return (recs && recs[0] && recs[0].content) || null;
  } catch {
    return null;
  }
}

async function loadHomeSeen() {
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    try {
      const recs = await bridge.queryData({ type: "home-meta", key: "seen" });
      return (recs && recs[0] && recs[0].content) || {};
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(localStorage.getItem(HOME_SEEN_LS_KEY)) || {};
  } catch {
    return {};
  }
}

async function markHomeSeen(patch) {
  const next = { ...(await loadHomeSeen()), ...patch };
  const bridge = window.OverseerBridge;
  if (bridge && bridge.embedded) {
    await bridge.putData({ type: "home-meta", key: "seen", content: next });
  } else {
    try {
      localStorage.setItem(HOME_SEEN_LS_KEY, JSON.stringify(next));
    } catch {
      // ignore storage errors
    }
  }
}

// Deterministic digest from the current portfolio + forecast — no LLM, instant.
function renderHomeDigest() {
  const body = document.getElementById("home-digest-body");
  if (!body) return;
  const holdings = [...holdingsByKey.values()];
  const invested = portfolioInvested;
  const current = portfolioCurrentValue;
  const pnl = current - invested;
  const pnlPct = invested === 0 ? 0 : (pnl / invested) * 100;

  let mover = null;
  for (const h of holdings) {
    const invD = toDisplayMoney(
      Number(h.amountInvested) || 0,
      h.currency || activeCurrency,
    );
    const native = holdingNativeCurrent(h);
    const curD = toDisplayMoney(native.amount, native.currency);
    // Skip holdings we can't compare in one currency, or with no invested base.
    if (invD.currency !== curD.currency || invD.amount === 0) continue;
    const pct = ((curD.amount - invD.amount) / invD.amount) * 100;
    if (!mover || Math.abs(pct) > Math.abs(mover.pct)) mover = { h, pct };
  }

  const monthly = Number(appProfile.monthlyContribution) || 0;
  const risk = RISK_RETURN_BANDS[appProfile.risk]
    ? appProfile.risk
    : FORECAST_DEFAULT_RISK;
  const forecast = buildForecast({
    startingValue: current,
    monthly,
    years: FORECAST_DEFAULT_YEARS,
    risk,
  });

  const moverTile = mover
    ? `<strong class="${mover.pct >= 0 ? "pnl-positive" : "pnl-negative"}">${escapeHtml(mover.h.name)} ${formatPct(mover.pct)}</strong>`
    : `<strong>—</strong>`;

  body.innerHTML = `
    <div class="digest-tile">
      <span class="digest-label">Portfolio value</span>
      <strong>${formatMoney(current)}</strong>
      <span class="digest-delta ${pnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatSignedMoney(pnl)} (${invested === 0 ? "—" : formatPct(pnlPct)})</span>
    </div>
    <div class="digest-tile">
      <span class="digest-label">Biggest mover</span>
      ${moverTile}
    </div>
    <div class="digest-tile">
      <span class="digest-label">On track for (${FORECAST_DEFAULT_YEARS}y, expected)</span>
      <strong>${formatMoney(forecast.expected.finalValue)}</strong>
      <span class="digest-sub">${monthly > 0 ? `with ${formatMoney(monthly)}/mo` : "from your portfolio"}</span>
    </div>
  `;
}

function renderAdvice(items) {
  const body = document.getElementById("advice-body");
  if (!body) return;
  if (!Array.isArray(items) || items.length === 0) {
    body.className = "advice-empty";
    body.innerHTML = window.OverseerBridge?.embedded
      ? `<p>No advice yet — use "Refresh advice" to generate some.</p>`
      : `<p>Open this project in Overseer to get personalised advice.</p>`;
    return;
  }
  body.className = "";
  const list = document.createElement("ul");
  list.className = "advice-list";
  for (const item of items) {
    const li = document.createElement("li");
    const title = document.createElement("div");
    title.className = "advice-title";
    title.textContent = item.title ?? "";
    const detail = document.createElement("div");
    detail.className = "advice-detail";
    detail.textContent = item.detail ?? "";
    li.append(title, detail);
    list.append(li);
  }
  body.innerHTML = "";
  body.append(list);
}

// Run the advisor job (diffed against the latest proposals), then re-read
// `advice/latest`. Self-manages the refresh button + status; never throws.
// `adviceInFlight` makes it reentrancy-safe: a manual click + an auto-run (or
// two) can never launch concurrent advisor jobs.
let adviceInFlight = false;
async function refreshAdvice() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || adviceInFlight) return;
  adviceInFlight = true;
  const btn = document.getElementById("refresh-advice");
  const status = document.getElementById("advice-status");
  const original = btn ? btn.textContent : "";
  const beforeAt = (await loadLatestAdvice())?.generatedAt;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Thinking…";
    btn.classList.add("is-loading");
  }
  if (status) status.textContent = "Reviewing your portfolio…";
  setTabBusy("home", true);

  let runError;
  try {
    const opportunityItems = (await loadLatestOpportunities()) || [];
    await bridge.runJob("advisor", {
      latestOpportunity: { items: opportunityItems },
    });
  } catch (err) {
    runError = err;
  }
  // Re-read regardless: the backend writes `advice/latest` even if the bridge
  // call timed out.
  const advice = await loadLatestAdvice();
  const produced =
    advice && advice.generatedAt && advice.generatedAt !== beforeAt;

  if (btn) {
    btn.disabled = false;
    btn.textContent = original;
    btn.classList.remove("is-loading");
  }
  adviceInFlight = false;
  setTabBusy("home", false);
  if (produced) {
    renderAdvice(advice.items);
    setTabUnread("home", Array.isArray(advice.items) ? advice.items.length : 0);
    await updateWhatsNew(advice);
    if (status)
      status.textContent =
        Array.isArray(advice.items) && advice.items.length
          ? ""
          : "No new advice right now.";
  } else if (runError) {
    renderAdvice(advice ? advice.items : []);
    if (status) status.textContent = analysisErrorText(runError);
  } else {
    renderAdvice(advice ? advice.items : []);
    if (status) status.textContent = "Couldn't refresh advice — try again.";
  }
}

// "What's new since last visit": flag when the advice is newer than last seen,
// then record what we've now shown.
async function updateWhatsNew(advice) {
  const banner = document.getElementById("home-whatsnew");
  if (!banner) return;
  const adviceAt = advice && advice.generatedAt;
  const seen = await loadHomeSeen();
  if (
    adviceAt &&
    seen.adviceGeneratedAt &&
    adviceAt !== seen.adviceGeneratedAt
  ) {
    banner.textContent = "✨ New advice since your last visit.";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
  if (adviceAt) await markHomeSeen({ adviceGeneratedAt: adviceAt });
}

// Render existing advice on open, surface "what's new", and auto-run the advisor
// once per session when the advice is missing or >24h stale.
async function handleHomeOpen() {
  renderHomeDigest();
  // Claim the once-per-session auto-run synchronously, before any await, so a
  // rapid second Home entry can't also trigger it.
  const mayAutoRun =
    !advisorAutoRanThisSession &&
    !!(window.OverseerBridge && window.OverseerBridge.embedded);
  if (mayAutoRun) advisorAutoRanThisSession = true;

  const advice = await loadLatestAdvice();
  renderAdvice(advice ? advice.items : []);
  await updateWhatsNew(advice);

  const status = document.getElementById("advice-status");
  if (status) {
    if (advice && advice.country && advice.country !== activeCountry) {
      status.textContent = `This advice was ${STALE_COUNTRY_MARK} — "Refresh advice" to tailor it to ${countryLabel(activeCountry)}.`;
    } else if (status.textContent.includes(STALE_COUNTRY_MARK)) {
      status.textContent = "";
    }
  }

  if (!mayAutoRun) return;
  const at = advice && advice.generatedAt ? Date.parse(advice.generatedAt) : 0;
  if (!at || Date.now() - at > ADVICE_STALE_MS) refreshAdvice();
}

function setupHome() {
  const btn = document.getElementById("refresh-advice");
  if (btn) {
    if (!window.OverseerBridge || !window.OverseerBridge.embedded) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", refreshAdvice);
    }
  }
  renderHomeDigest();
}

// --- Investigations (per-product deep-dives) ------------------------------
// Completed investigation records, and the products with a run in flight.
let investigations = [];
const ongoingInvestigations = new Map();

function investigationId(product) {
  const base = String(product.symbol || product.name || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "item";
}

// State of a product's investigation, for the proposal card's Investigate button.
function investigationState(product) {
  const id = investigationId(product);
  if (ongoingInvestigations.has(id)) return "ongoing";
  if (investigations.some((inv) => inv.key === id)) return "done";
  return "idle";
}

function applyInvestigateButtonState(btn) {
  const state = investigationState({
    name: btn.dataset.name,
    symbol: btn.dataset.symbol,
    assetClass: btn.dataset.assetClass,
  });
  btn.classList.toggle("is-ongoing", state === "ongoing");
  btn.classList.toggle("is-done", state === "done");
  btn.disabled = state === "ongoing";
  btn.textContent =
    state === "ongoing"
      ? "Investigating…"
      : state === "done"
        ? "View investigation →"
        : "Investigate";
}

// Re-sync every visible Investigate button to the current investigation state
// (in place, so an expanded proposal card stays open).
function updateInvestigateButtons() {
  for (const btn of document.querySelectorAll(".pick-investigate")) {
    applyInvestigateButtonState(btn);
  }
}

async function loadInvestigations() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return [];
  try {
    const recs = await bridge.queryData({ type: "investigation" });
    return (recs || []).map((r) => ({ key: r.key, content: r.content || {} }));
  } catch {
    return [];
  }
}

async function refreshInvestigations() {
  investigations = await loadInvestigations();
  renderInvestigations();
  updateInvestigateButtons();
}

function renderInvestigations() {
  const body = document.getElementById("investigations-body");
  if (!body) return;
  if (!window.OverseerBridge || !window.OverseerBridge.embedded) {
    body.className = "investigations-empty";
    body.innerHTML =
      "<p>Open this project in Overseer to run investigations.</p>";
    return;
  }
  const ongoing = [...ongoingInvestigations.values()];
  const done = [...investigations]
    .filter((inv) => !ongoingInvestigations.has(inv.key))
    .sort((a, b) =>
      String(b.content.generatedAt || "").localeCompare(
        String(a.content.generatedAt || ""),
      ),
    );
  if (ongoing.length === 0 && done.length === 0) {
    body.className = "investigations-empty";
    body.innerHTML =
      '<p>No investigations yet — open a proposal and hit "Investigate".</p>';
    return;
  }
  body.className = "";
  body.innerHTML = "";
  const list = document.createElement("ul");
  list.className = "top-picks-list";
  for (const product of ongoing)
    list.append(renderOngoingInvestigation(product));
  for (const inv of done) list.append(renderInvestigationCard(inv));
  body.append(list);
}

function renderOngoingInvestigation(product) {
  const li = document.createElement("li");
  li.className = "pick";
  const header = document.createElement("div");
  header.className = "pick-header is-ongoing";
  const sym = document.createElement("span");
  sym.className = "pick-symbol";
  sym.textContent = `Investigating ${product.name || product.symbol || "…"}`;
  const spin = document.createElement("span");
  spin.className = "tab-indicator is-busy";
  header.append(sym, spin);
  li.append(header);
  return li;
}

function renderInvestigationCard(inv) {
  const c = inv.content || {};
  const product = c.product || {};
  const li = document.createElement("li");
  li.className = "pick";

  const header = document.createElement("button");
  header.type = "button";
  header.className = "pick-header";
  header.setAttribute("aria-expanded", "false");
  const sym = document.createElement("span");
  sym.className = "pick-symbol";
  sym.textContent = product.name || product.symbol || inv.key;
  header.append(sym);
  if (product.assetClass) {
    const badge = document.createElement("span");
    badge.className = `asset-badge asset-${product.assetClass}`;
    badge.textContent =
      ASSET_CLASS_LABEL.get(product.assetClass) || product.assetClass;
    header.append(badge);
  }
  const chevron = document.createElement("span");
  chevron.className = "pick-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "▸";
  header.append(chevron);

  const details = document.createElement("div");
  details.className = "pick-details";
  details.hidden = true;
  const sections = Array.isArray(c.sections) ? c.sections : [];
  if (sections.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pick-reason";
    empty.textContent = "No analysis was produced — try again.";
    details.append(empty);
  }
  for (const s of sections) {
    const wrap = document.createElement("div");
    wrap.className = "investigation-section";
    const h = document.createElement("div");
    h.className = "investigation-heading";
    h.textContent = s.heading || "";
    const b = document.createElement("div");
    b.className = "pick-reason";
    b.textContent = s.body || "";
    wrap.append(h, b);
    details.append(wrap);
  }

  header.addEventListener("click", () => {
    const open = details.hidden;
    details.hidden = !open;
    header.setAttribute("aria-expanded", String(open));
    chevron.textContent = open ? "▾" : "▸";
  });

  li.append(header, details);
  return li;
}

// Launch a deep-dive on one product. The Investigations tab shows it as ongoing
// (a tab spinner), then badges when done — so the user can stay on Proposals.
async function runInvestigation(product) {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !product) return;
  const id = investigationId(product);
  if (ongoingInvestigations.has(id)) return;
  ongoingInvestigations.set(id, product);
  setTabBusy("investigations", true);
  renderInvestigations();
  updateInvestigateButtons();
  try {
    await bridge.runJob("investigate", { product });
  } catch {
    // The backend writes the record even if the bridge call timed out; re-read.
  }
  ongoingInvestigations.delete(id);
  await refreshInvestigations();
  setTabBusy("investigations", ongoingInvestigations.size > 0);
  if (activeTabId !== "investigations") {
    setTabUnread("investigations", getTabStatus("investigations").unread + 1);
  }
}

function setupInvestigations() {
  // Load existing investigations up front so proposal cards show a "done" /
  // "View investigation" state without waiting for the tab to be opened.
  refreshInvestigations();
}

// --- News (per-held-asset recent news) ------------------------------------
// Completed news records, the assets with a pull in flight, and whether a
// "Refresh all" sweep is running (keeps the tab spinner steady across it).
let news = [];
const ongoingNews = new Map();
const newsErrors = new Map();
let newsBusyAll = false;

function newsGeneratedAt(id) {
  const rec = news.find((n) => n.key === id);
  return rec && rec.content ? rec.content.generatedAt : undefined;
}

// Keep in lock-step with the backend `newsId` so a record written for an asset
// is found again here; news is keyed per-company (symbol/name), not per lot.
function newsId(asset) {
  const base = String(asset.symbol || asset.name || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "item";
}

// The distinct assets the user holds, deduped by news id (so two lots of the
// same instrument share one news card).
function heldAssets() {
  const seen = new Map();
  for (const h of holdingsByKey.values()) {
    const id = newsId(h);
    if (!seen.has(id)) {
      seen.set(id, {
        name: h.name,
        symbol: h.symbol,
        assetClass: h.assetClass,
      });
    }
  }
  return [...seen.values()];
}

// Only allow http(s) links through — news urls are LLM-authored, so reject
// anything that could smuggle a javascript: or data: URL into an href.
function safeUrl(value) {
  if (!value) return "";
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

function formatNewsDate(value) {
  if (!value) return "";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

async function loadNews() {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded) return [];
  try {
    const recs = await bridge.queryData({ type: "news" });
    return (recs || []).map((r) => ({ key: r.key, content: r.content || {} }));
  } catch {
    return [];
  }
}

async function refreshNews() {
  news = await loadNews();
  renderNews();
}

function updateNewsAllButton() {
  const btn = document.getElementById("news-refresh-all");
  if (!btn) return;
  const embedded = !!(window.OverseerBridge && window.OverseerBridge.embedded);
  btn.disabled = !embedded || newsBusyAll || heldAssets().length === 0;
  btn.textContent = newsBusyAll ? "Refreshing…" : "Refresh all";
  btn.classList.toggle("is-loading", newsBusyAll);
}

function renderNews() {
  const body = document.getElementById("news-body");
  if (!body) return;
  updateNewsAllButton();
  if (!window.OverseerBridge || !window.OverseerBridge.embedded) {
    body.className = "news-empty";
    body.innerHTML =
      "<p>Open this project in Overseer to fetch news on your holdings.</p>";
    return;
  }
  const assets = heldAssets();
  if (assets.length === 0) {
    body.className = "news-empty";
    body.innerHTML =
      "<p>No holdings yet — add some in Portfolio to get news on them.</p>";
    return;
  }
  body.className = "";
  body.innerHTML = "";
  const byKey = new Map(news.map((n) => [n.key, n.content || {}]));
  const list = document.createElement("div");
  list.className = "news-list";
  for (const asset of assets) {
    const id = newsId(asset);
    list.append(renderNewsCard(asset, byKey.get(id), ongoingNews.has(id)));
  }
  body.append(list);
}

function renderNewsCard(asset, content, ongoing) {
  const card = document.createElement("section");
  card.className = "news-card";

  const head = document.createElement("div");
  head.className = "news-head";
  const title = document.createElement("div");
  title.className = "news-title";
  const name = document.createElement("span");
  name.className = "news-asset";
  name.textContent = asset.name || asset.symbol || "Holding";
  title.append(name);
  if (asset.symbol) {
    const sym = document.createElement("span");
    sym.className = "asset-symbol";
    sym.textContent = normalizeSymbol(asset.symbol);
    title.append(sym);
  }
  if (asset.assetClass) {
    const badge = document.createElement("span");
    badge.className = `asset-badge asset-${asset.assetClass}`;
    badge.textContent = ASSET_CLASS_LABEL.get(asset.assetClass) || "Other";
    title.append(badge);
  }
  head.append(title);
  if (ongoing) {
    const spin = document.createElement("span");
    spin.className = "tab-indicator is-busy";
    head.append(spin);
  } else {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "news-refresh";
    btn.dataset.id = newsId(asset);
    btn.textContent = content ? "Refresh" : "Fetch news";
    head.append(btn);
  }
  card.append(head);

  if (content && content.generatedAt) {
    const when = document.createElement("p");
    when.className = "news-updated";
    when.textContent = `Updated ${formatNewsDate(content.generatedAt) || "recently"}`;
    card.append(when);
  }

  const error = newsErrors.get(newsId(asset));
  const items = content && Array.isArray(content.items) ? content.items : [];
  if (!ongoing && error) {
    const e = document.createElement("p");
    e.className = "news-error";
    e.textContent = error;
    card.append(e);
  } else if (!ongoing && content && items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "news-meta";
    empty.textContent = "No recent news found — try again later.";
    card.append(empty);
  }
  if (items.length) {
    const ul = document.createElement("ul");
    ul.className = "news-items";
    for (const item of items) ul.append(renderNewsItem(item));
    card.append(ul);
  }

  const sources =
    content && Array.isArray(content.sources) ? content.sources : [];
  const sourcesEl = renderNewsSources(sources);
  if (sourcesEl) card.append(sourcesEl);

  return card;
}

function renderNewsItem(item) {
  const li = document.createElement("li");
  li.className = "news-item";
  const url = safeUrl(item.url);
  const titleEl = document.createElement(url ? "a" : "span");
  titleEl.className = "news-item-title";
  titleEl.textContent = item.title || "Untitled";
  if (url) {
    titleEl.href = url;
    titleEl.target = "_blank";
    titleEl.rel = "noopener noreferrer";
  }
  li.append(titleEl);

  const meta = [item.source, formatNewsDate(item.publishedAt)].filter(Boolean);
  if (meta.length) {
    const metaEl = document.createElement("div");
    metaEl.className = "news-meta";
    metaEl.textContent = meta.join(" · ");
    li.append(metaEl);
  }
  if (item.summary) {
    const sum = document.createElement("p");
    sum.className = "news-summary";
    sum.textContent = item.summary;
    li.append(sum);
  }
  return li;
}

// The verified research sources (real search-result urls), rendered as the
// provenance footer; returns null when none survive the http(s) filter.
function renderNewsSources(sources) {
  const wrap = document.createElement("div");
  wrap.className = "news-sources";
  const label = document.createElement("span");
  label.className = "news-sources-label";
  label.textContent = "Sources:";
  wrap.append(label);
  let count = 0;
  for (const s of sources) {
    const url = safeUrl(s && s.url);
    if (!url) continue;
    const a = document.createElement("a");
    a.className = "news-source";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = (s && s.title) || new URL(url).hostname;
    wrap.append(a);
    if (++count >= 6) break;
  }
  return count ? wrap : null;
}

// Pull recent news for one asset. Mirrors runInvestigation: the tab spins while
// in flight, then badges when done so the user can stay on another tab.
async function runNewsRefresh(asset) {
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !asset) return;
  const id = newsId(asset);
  if (ongoingNews.has(id)) return;
  const beforeAt = newsGeneratedAt(id);
  ongoingNews.set(id, asset);
  newsErrors.delete(id);
  setTabBusy("news", true);
  renderNews();
  let runError;
  try {
    await bridge.runJob("news", { holding: asset });
  } catch (err) {
    runError = err;
  }
  ongoingNews.delete(id);
  // Re-read regardless: the backend writes the record even if the bridge timed
  // out. A failure with no fresh record is a real error, not "no news".
  await refreshNews();
  if (runError && newsGeneratedAt(id) === beforeAt) {
    newsErrors.set(id, analysisErrorText(runError));
  } else {
    newsErrors.delete(id);
  }
  renderNews();
  setTabBusy("news", ongoingNews.size > 0 || newsBusyAll);
  if (activeTabId !== "news") {
    setTabUnread("news", getTabStatus("news").unread + 1);
  }
}

// Refresh every held asset in turn (sequential to stay gentle on cost / rate
// limits); the per-asset cards each have their own on-demand refresh too.
async function runAllNews() {
  if (newsBusyAll) return;
  newsBusyAll = true;
  updateNewsAllButton();
  try {
    for (const asset of heldAssets()) await runNewsRefresh(asset);
  } finally {
    newsBusyAll = false;
    setTabBusy("news", ongoingNews.size > 0);
    updateNewsAllButton();
  }
}

function setupNews() {
  const body = document.getElementById("news-body");
  if (body) {
    body.addEventListener("click", (event) => {
      const refresh = event.target.closest(".news-refresh");
      if (!refresh) return;
      const asset = heldAssets().find((a) => newsId(a) === refresh.dataset.id);
      if (asset) runNewsRefresh(asset);
    });
  }
  const allBtn = document.getElementById("news-refresh-all");
  if (allBtn) allBtn.addEventListener("click", runAllNews);
  renderNews();
}

// --- Start onboarding -----------------------------------------------------
// Whether the guided setup has been completed (drives the Start tab's
// visibility + the default landing tab). Set once the wizard is submitted.
let onboarded = false;

function isOnboarded(profile) {
  return !!profile.onboarded;
}

// Push the saved profile back into the Profile + Forecast inputs so they stay
// consistent after the wizard writes them.
// Product categories the user is open to — the `value`s must match the backend
// (opportunityAnalysis.PRODUCT_TYPE_LABELS keys). Empty selection = all.
const PRODUCT_TYPES = [
  { value: "stocks", label: "Stocks" },
  { value: "etfs", label: "ETFs" },
  { value: "funds", label: "Funds" },
  { value: "bonds", label: "Bonds" },
  { value: "crypto", label: "Crypto" },
  { value: "savings", label: "Savings & cash" },
];

function renderProductTypes(containerId, selected) {
  const c = document.getElementById(containerId);
  if (!c) return;
  // Default to all when none chosen yet (matches the backend's "empty = all").
  const set = new Set(
    Array.isArray(selected) && selected.length
      ? selected
      : PRODUCT_TYPES.map((p) => p.value),
  );
  c.innerHTML = "";
  for (const p of PRODUCT_TYPES) {
    const label = document.createElement("label");
    label.className = "checkbox-pill";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = p.value;
    cb.checked = set.has(p.value);
    const span = document.createElement("span");
    span.textContent = p.label;
    label.append(cb, span);
    c.append(label);
  }
}

function readProductTypes(containerId) {
  const c = document.getElementById(containerId);
  if (!c) return [];
  return [...c.querySelectorAll("input[type=checkbox]:checked")].map(
    (cb) => cb.value,
  );
}

function applyProfileToForms(profile) {
  const pf = document.getElementById("profile-form");
  if (pf) {
    pf.risk.value = profile.risk || "balanced";
    pf.preferences.value = profile.preferences || "";
  }
  renderProductTypes("profile-products", profile.productTypes);
  renderProductTypes("start-products", profile.productTypes);
  const fm = document.getElementById("forecast-monthly");
  if (fm && typeof profile.monthlyContribution === "number") {
    fm.value = profile.monthlyContribution;
  }
  const fr = document.getElementById("forecast-risk");
  if (fr && RISK_RETURN_BANDS[profile.risk]) fr.value = profile.risk;
  if (recalcForecast) recalcForecast();
}

function fillStartForm(profile) {
  const form = document.getElementById("start-form");
  if (!form) return;
  form.lumpSum.value =
    typeof profile.lumpSum === "number" ? profile.lumpSum : "";
  form.monthly.value =
    typeof profile.monthlyContribution === "number"
      ? profile.monthlyContribution
      : "";
  form.risk.value = profile.risk || "balanced";
  form.preferences.value = profile.preferences || "";
  renderProductTypes("start-products", profile.productTypes);
}

function setupStart(profile) {
  const form = document.getElementById("start-form");
  if (!form) return;
  const status = document.getElementById("start-status");
  fillStartForm(profile);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const saved = await saveProfile({
      lumpSum: Number(data.get("lumpSum")) || 0,
      monthlyContribution: Number(data.get("monthly")) || 0,
      risk: String(data.get("risk") || "balanced"),
      preferences: String(data.get("preferences") || "").trim(),
      productTypes: readProductTypes("start-products"),
      onboarded: true,
    });
    markOnboarded();
    applyProfileToForms(saved);
    if (status) status.textContent = "";
    // Route to Proposals straight away; the job runs while it shows its spinner.
    location.hash = "proposals";
    showTab("proposals");
    findProposals();
  });
}

// --- Profile tab ----------------------------------------------------------
function setupProfile(profile) {
  const form = document.getElementById("profile-form");
  const status = document.getElementById("profile-status");
  form.risk.value = profile.risk || "balanced";
  form.preferences.value = profile.preferences || "";
  renderProductTypes("profile-products", profile.productTypes);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveProfile({
      risk: form.risk.value,
      preferences: form.preferences.value.trim(),
      productTypes: readProductTypes("profile-products"),
    });
    if (status) status.textContent = "Saved.";
  });

  const redo = document.getElementById("redo-onboarding");
  if (redo) {
    redo.addEventListener("click", async () => {
      // Re-read the latest profile so the wizard doesn't resubmit stale values.
      fillStartForm(await loadProfile());
      showStartTabButton();
      location.hash = "start";
      showTab("start");
    });
  }
}

// --- Calculator -----------------------------------------------------------
// projectSeries() lives in forecast.js (shared with the Forecast tab).

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
            y: { stacked: true, ticks: { callback: (v) => formatMoney(v) } },
            x: { stacked: true },
          },
        },
      });
    }
  }

  recalcCalculator = recalc;
  form.addEventListener("input", recalc);
  recalc();
  if (!window.Chart) {
    const tick = () => (window.Chart ? recalc() : setTimeout(tick, 50));
    tick();
  }
}

// --- Forecast -------------------------------------------------------------
let forecastChart;

const FORECAST_LINES = [
  { key: "optimistic", label: "Optimistic", color: "#16a34a", width: 1.5 },
  { key: "expected", label: "Expected", color: "#2563eb", width: 2.5 },
  { key: "conservative", label: "Conservative", color: "#6b7280", width: 1.5 },
];

function renderForecastChart(forecast) {
  const canvas = document.getElementById("forecast-chart");
  if (!window.Chart || !canvas) return;
  const labels = forecast.expected.labels;
  const series = FORECAST_LINES.map((line) => forecast[line.key].balances);
  if (forecastChart) {
    forecastChart.data.labels = labels;
    forecastChart.data.datasets.forEach((ds, i) => (ds.data = series[i]));
    forecastChart.update();
    return;
  }
  forecastChart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: FORECAST_LINES.map((line, i) => ({
        label: line.label,
        data: series[i],
        borderColor: line.color,
        backgroundColor: "transparent",
        borderWidth: line.width,
        tension: 0.25,
        pointRadius: 0,
      })),
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
      scales: { y: { ticks: { callback: (v) => formatMoney(v) } } },
    },
  });
}

function setupForecast(profile) {
  const form = document.getElementById("forecast-form");
  const monthlyEl = document.getElementById("forecast-monthly");
  const yearsEl = document.getElementById("forecast-years");
  const riskEl = document.getElementById("forecast-risk");

  riskEl.value = RISK_RETURN_BANDS[profile.risk]
    ? profile.risk
    : FORECAST_DEFAULT_RISK;
  yearsEl.value = FORECAST_DEFAULT_YEARS;
  // Default the monthly contribution from the onboarding profile when set.
  if (typeof profile.monthlyContribution === "number") {
    monthlyEl.value = profile.monthlyContribution;
  }

  function recalc() {
    const startingValue = portfolioCurrentValue;
    const monthly = Number(monthlyEl.value) || 0;
    const years = Math.max(1, Number(yearsEl.value) || 1);
    const forecast = buildForecast({
      startingValue,
      monthly,
      years,
      risk: riskEl.value,
    });

    document.getElementById("forecast-start").textContent =
      formatMoney(startingValue);
    const hint = document.getElementById("forecast-empty-hint");
    if (hint) hint.hidden = startingValue > 0;

    document.getElementById("forecast-cons").textContent = formatMoney(
      forecast.conservative.finalValue,
    );
    document.getElementById("forecast-exp").textContent = formatMoney(
      forecast.expected.finalValue,
    );
    document.getElementById("forecast-opt").textContent = formatMoney(
      forecast.optimistic.finalValue,
    );
    document.getElementById("forecast-rate-cons").textContent =
      `${forecast.band.conservative}%`;
    document.getElementById("forecast-rate-exp").textContent =
      `${forecast.band.expected}%`;
    document.getElementById("forecast-rate-opt").textContent =
      `${forecast.band.optimistic}%`;

    renderForecastChart(forecast);
  }

  recalcForecast = recalc;
  form.addEventListener("input", recalc);
  recalc();
  if (!window.Chart) {
    const tick = () => (window.Chart ? recalc() : setTimeout(tick, 50));
    tick();
  }
}

// --- Country selector + currency-driven UI --------------------------------
function setupCountry() {
  const sel = document.getElementById("country-select");
  sel.innerHTML = "";
  for (const [code, cfg] of Object.entries(COUNTRY_CONFIG)) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = cfg.label;
    sel.append(opt);
  }
  sel.value = activeCountry;
  sel.addEventListener("change", async () => {
    activeCountry = sel.value;
    activeCurrency = COUNTRY_CONFIG[activeCountry].currency;
    await saveProfile({ country: activeCountry });
    updateCurrencyUI();
    await refreshLive();
    // Surface the "tailored for another country — refresh" hint on Proposals.
    await refreshProposalsFromStore();
  });
}

function updateCurrencyUI() {
  const symbol = CURRENCY_SYMBOL[activeCurrency] || activeCurrency;
  for (const el of document.querySelectorAll(".currency-prefix")) {
    el.textContent = symbol;
  }
  // The add-holding money fields follow the holding's own currency, not display.
  syncHoldingFormPrefix();
  if (recalcCalculator) recalcCalculator();
  if (recalcForecast) recalcForecast();
}

// --- Tabs (hash-routed; one <section> per tab) ----------------------------
const TABS = [
  { id: "home", label: "Home" },
  { id: "start", label: "Start" },
  { id: "profile", label: "Profile" },
  { id: "proposals", label: "Proposals" },
  { id: "investigations", label: "Investigations" },
  { id: "portfolio", label: "Portfolio" },
  { id: "market", label: "Market" },
  { id: "forecast", label: "Forecast" },
  { id: "news", label: "News" },
  { id: "calculator", label: "Calculator" },
];

// A brand-new user lands on the Start wizard; once onboarded (matured), Home is
// the daily-companion landing.
function defaultTab() {
  return onboarded ? "home" : "start";
}

function setStartTabVisible(visible) {
  const btn = document.querySelector('.tab-btn[data-tab="start"]');
  if (btn) btn.hidden = !visible;
}

function showStartTabButton() {
  setStartTabVisible(true);
}

function markOnboarded() {
  onboarded = true;
  setStartTabVisible(false);
}

// Routing and Start-button visibility share one source of truth: Start is
// routable only while its button is shown (not onboarded, or during a re-run),
// so a stale `#start` hash can't reveal the panel with no active tab.
function tabIsAvailable(id) {
  if (!TABS.some((t) => t.id === id)) return false;
  if (id === "start") {
    const btn = document.querySelector('.tab-btn[data-tab="start"]');
    return btn ? !btn.hidden : !onboarded;
  }
  return true;
}

function hashTab() {
  const id = (location.hash || "").replace(/^#/, "");
  return tabIsAvailable(id) ? id : null;
}

// --- Per-tab work indicators ----------------------------------------------
// Each tab button shows a spinner while a job for that tab is running, and an
// unread-count badge once it completes off-tab; opening the tab clears the badge.
let activeTabId = null;
const tabStatus = new Map();

function getTabStatus(id) {
  let s = tabStatus.get(id);
  if (!s) {
    s = { busy: false, unread: 0 };
    tabStatus.set(id, s);
  }
  return s;
}

function renderTabIndicator(id) {
  const ind = document.querySelector(
    `.tab-btn[data-tab="${id}"] .tab-indicator`,
  );
  if (!ind) return;
  const s = getTabStatus(id);
  if (s.busy) {
    ind.className = "tab-indicator is-busy";
    ind.textContent = "";
    ind.title = "Working…";
  } else if (s.unread > 0) {
    ind.className = "tab-indicator is-unread";
    ind.textContent = s.unread > 99 ? "99+" : String(s.unread);
    ind.title = `${s.unread} new`;
  } else {
    ind.className = "tab-indicator";
    ind.textContent = "";
    ind.removeAttribute("title");
  }
}

function setTabBusy(id, busy) {
  getTabStatus(id).busy = busy;
  renderTabIndicator(id);
}

// Badge a tab with `count` unread items — unless the user is already on it.
function setTabUnread(id, count) {
  getTabStatus(id).unread = id === activeTabId ? 0 : count;
  renderTabIndicator(id);
}

function clearTabUnread(id) {
  getTabStatus(id).unread = 0;
  renderTabIndicator(id);
}

function showTab(id) {
  const target = tabIsAvailable(id) ? id : defaultTab();
  activeTabId = target;
  for (const tab of TABS) {
    const panel = document.getElementById(`tab-${tab.id}`);
    if (panel) panel.hidden = tab.id !== target;
    const btn = document.querySelector(`.tab-btn[data-tab="${tab.id}"]`);
    if (btn) {
      btn.classList.toggle("is-active", tab.id === target);
      btn.setAttribute("aria-selected", String(tab.id === target));
    }
  }
  clearTabUnread(target);
  // A chart created while its panel was display:none lays out at zero height;
  // resize it once its tab is actually visible.
  if (target === "calculator" && calculatorChart) calculatorChart.resize();
  if (target === "forecast" && forecastChart) forecastChart.resize();
  if (target === "home") handleHomeOpen();
  if (target === "proposals") refreshProposalsFromStore();
  if (target === "investigations") refreshInvestigations();
  if (target === "news") refreshNews();
}

function setupTabs() {
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn";
    btn.dataset.tab = tab.id;
    btn.setAttribute("role", "tab");
    const label = document.createElement("span");
    label.textContent = tab.label;
    const ind = document.createElement("span");
    ind.className = "tab-indicator";
    ind.setAttribute("aria-hidden", "true");
    btn.append(label, ind);
    btn.addEventListener("click", () => {
      location.hash = tab.id;
    });
    bar.append(btn);
  }
  setStartTabVisible(!onboarded);
  window.addEventListener("hashchange", () => showTab(hashTab()));
  showTab(hashTab() || defaultTab());
}

async function init() {
  try {
    const profile = await loadProfile();
    onboarded = isOnboarded(profile);
    appProfile = profile;
    activeCountry = COUNTRY_CONFIG[profile.country]
      ? profile.country
      : DEFAULT_COUNTRY;
    activeCurrency = COUNTRY_CONFIG[activeCountry].currency;
    const topPicks = await loadJson("./data/top-picks.json");

    setupCountry();
    setupProfile(profile);
    setupStart(profile);
    renderCalculator();
    setupForecast(profile);
    setupHome();
    setupMarket();
    setupInvestigations();
    setupNews();
    updateCurrencyUI();
    setupHoldingControls();
    await setupProposals(topPicks);
    // Load holdings BEFORE the first tab paints so the Home digest (the default
    // landing once onboarded) shows real figures, not a $0 flash.
    await migrateHoldings();
    await ensureSeeded();
    await refreshHoldings();
    // Now the initial showTab fires with both setup wired and data loaded.
    setupTabs();
    await refreshLive();
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
