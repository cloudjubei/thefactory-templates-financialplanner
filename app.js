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

// --- Live data (read-only, via the bridge; filtered to the active country) --
const livePrices = new Map();
let liveMarkets = [];

// Stooq quote symbols carry an exchange suffix (VOO.US, VOD.UK); a holding is
// entered bare (VOO). Strip the known suffix so the two match + display cleanly.
function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .replace(/\.(US|UK|DE|PL)$/, "");
}

async function loadLiveData() {
  livePrices.clear();
  liveMarkets = [];
  // Currency follows the chosen country regardless of which markets are subscribed.
  activeCurrency = COUNTRY_CONFIG[activeCountry].currency;
  const bridge = window.OverseerBridge;
  if (!bridge || !bridge.embedded || !bridge.readLiveData) return;
  let subscribed;
  try {
    subscribed = await bridge.readLiveData();
  } catch {
    return;
  }
  const wantType = `stock-quote-${COUNTRY_CONFIG[activeCountry].marketSuffix}`;
  for (const source of subscribed || []) {
    if ((source.recordType || "") !== wantType) continue; // only the selected country's market
    for (const rec of source.records || []) {
      const content = rec.content || {};
      const latest = content.latest;
      const value =
        latest && typeof latest.v === "number" ? latest.v : undefined;
      const currency =
        typeof content.currency === "string"
          ? content.currency
          : activeCurrency;
      liveMarkets.push({
        key: rec.key,
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
    const label = COUNTRY_CONFIG[activeCountry].label;
    body.className = "markets-empty";
    body.innerHTML = `<p>No live market for <strong>${escapeHtml(label)}</strong> — subscribe to its source in Overseer's <strong>Live Data</strong> tab.</p>`;
    return;
  }
  body.className = "";
  const list = document.createElement("ul");
  list.className = "markets-list";
  for (const m of liveMarkets.slice(0, 24)) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.className = "market-symbol";
    left.textContent = normalizeSymbol(m.key);
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
  if (recalcCalculator) recalcCalculator();
}

// The holdings currently rendered, by key — lets row actions (edit/remove)
// resolve the full record without re-querying the store.
let holdingsByKey = new Map();
// Total current value of all holdings (the Forecast tab's starting base).
let portfolioCurrentValue = 0;
// Total amount invested across all holdings (the Home digest's delta base).
let portfolioInvested = 0;

// A holding's current value: live (price × qty) for market assets with a quote,
// else the manual figure, else fall back to the amount invested (flat).
function holdingCurrentValue(h) {
  if (MARKET_ASSET_CLASSES.has(h.assetClass) && h.symbol) {
    const live = livePrices.get(normalizeSymbol(h.symbol));
    // A non-positive quote means "no useful price", not "worth nothing" — fall
    // through to the manual / invested figure rather than zeroing the holding.
    if (live && live.v > 0 && Number(h.quantity)) {
      return { value: Number(h.quantity) * live.v, live };
    }
  }
  if (h.currentValueManual !== undefined && h.currentValueManual !== null) {
    return { value: Number(h.currentValueManual) || 0, live: null };
  }
  return { value: Number(h.amountInvested) || 0, live: null };
}

function renderHoldings(holdings) {
  const tbody = document.getElementById("holdings-body");
  tbody.innerHTML = "";
  holdingsByKey = new Map();
  let invested = 0;
  let current = 0;
  for (const h of holdings) {
    const key = holdingKey(h);
    holdingsByKey.set(key, h);
    const rowInvested = Number(h.amountInvested) || 0;
    const { value: rowCurrent, live } = holdingCurrentValue(h);
    const rowPnl = rowCurrent - rowInvested;
    invested += rowInvested;
    current += rowCurrent;

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

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="asset-cell">
        <span class="asset-name">${escapeHtml(h.name)}</span>
        <span class="asset-meta">${badge}${symbolBit}${accountBit}${liveTag}</span>
      </td>
      <td class="num">${h.quantity ? escapeHtml(String(h.quantity)) : "—"}</td>
      <td class="num">${formatMoney(rowInvested)}</td>
      <td class="num${live ? " is-live" : ""}">${formatMoney(rowCurrent)}</td>
      <td class="num ${rowPnl >= 0 ? "pnl-positive" : "pnl-negative"}">${formatSignedMoney(rowPnl)}</td>
      <td class="row-actions">
        <button type="button" class="edit-holding" data-key="${escapeHtml(key)}" aria-label="Edit ${escapeHtml(h.name)}">Edit</button>
        <button type="button" class="remove-holding" data-key="${escapeHtml(key)}" aria-label="Remove ${escapeHtml(h.name)}">×</button>
      </td>
    `;
    tbody.append(tr);
  }
  portfolioCurrentValue = current;
  portfolioInvested = invested;
  const pnl = current - invested;
  // No invested base → a percentage is undefined; show "—" rather than a
  // misleading "+0.0%" next to a real money gain.
  const pctText = invested === 0 ? "—" : formatPct((pnl / invested) * 100);
  document.getElementById("holdings-total").textContent = formatMoney(current);
  document.getElementById("holdings-cost").textContent = formatMoney(invested);
  const pnlEl = document.getElementById("holdings-pnl");
  pnlEl.textContent = `${formatSignedMoney(pnl)} (${pctText})`;
  pnlEl.className = pnl >= 0 ? "pnl-positive" : "pnl-negative";
}

// --- Add / edit holding form ----------------------------------------------
let editingKey = null;

function resetHoldingForm() {
  const form = document.getElementById("add-holding");
  form.reset();
  form.currentValueManual.placeholder = "auto";
  editingKey = null;
  document.getElementById("holding-form-title").textContent = "Add a holding";
  document.getElementById("holding-submit").textContent = "Add holding";
  document.getElementById("holding-cancel").hidden = true;
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
  // Reveal the Portfolio panel synchronously — `hashchange` (which drives
  // showTab) fires async, so focus/scroll would otherwise hit a hidden element.
  location.hash = "portfolio";
  showTab("portfolio");
  form.amountInvested.focus();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
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
  form.quantity.value = h.quantity ?? "";
  form.amountInvested.value = h.amountInvested ?? "";
  form.currentValueManual.value =
    typeof h.currentValueManual === "number" ? h.currentValueManual : "";
  // When a live quote is driving this row's value, a manual figure would be
  // ignored — show the live value as the placeholder so that's clear.
  const { live, value } = holdingCurrentValue(h);
  form.currentValueManual.placeholder = live
    ? `${formatMoney(value)} (live)`
    : "auto";
  form.account.value = h.account || "";
  form.purchaseDate.value = h.purchaseDate || "";
  editingKey = key;
  document.getElementById("holding-form-title").textContent = "Edit holding";
  document.getElementById("holding-submit").textContent = "Save changes";
  document.getElementById("holding-cancel").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
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
    currency: activeCurrency,
  };
  if (symbolRaw) holding.symbol = normalizeSymbol(symbolRaw);
  if (qtyRaw) holding.quantity = Number(qtyRaw) || 0;
  if (manualRaw) holding.currentValueManual = Number(manualRaw) || 0;
  if (accountRaw) holding.account = accountRaw;
  const purchaseDate = String(data.get("purchaseDate") || "").trim();
  if (purchaseDate) holding.purchaseDate = purchaseDate;
  return holding;
}

function setupHoldingControls() {
  const form = document.getElementById("add-holding");
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
    await refreshHoldings();
  });

  document
    .getElementById("holding-cancel")
    .addEventListener("click", resetHoldingForm);

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
    const li = document.createElement("li");
    const sym = document.createElement("div");
    sym.className = "pick-symbol";
    const name = pick.name ? ` — ${pick.name}` : "";
    sym.textContent = `${pick.symbol ?? ""}${name}`;
    const reason = document.createElement("div");
    reason.className = "pick-reason";
    reason.textContent = pick.rationale ?? pick.whyItFits ?? pick.reason ?? "";
    li.append(sym, reason);

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
    li.append(actions);

    list.append(li);
  }
  body.append(list);
}

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

async function setupProposals(staticPicks) {
  const bridge = window.OverseerBridge;
  const btn = document.getElementById("find-opportunities");
  const status = document.getElementById("opportunities-status");

  document
    .getElementById("top-picks-body")
    .addEventListener("click", (event) => {
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
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Finding…";
  }
  if (status)
    status.textContent =
      "Searching the web and analysing — this can take a moment…";
  try {
    await bridge.runJob("opportunities");
    // The job wrote `opportunity/latest`; re-read it rather than depending on
    // the generic job route's return shape.
    const items = (await loadLatestOpportunities()) || [];
    renderTopPicks(items);
    if (status)
      status.textContent = items.length
        ? ""
        : "No opportunities found — try adjusting your profile.";
  } catch (err) {
    if (status)
      status.textContent = `Could not run analysis: ${err && err.message ? err.message : err}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
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
    const inv = Number(h.amountInvested) || 0;
    if (inv === 0) continue;
    const pct = ((holdingCurrentValue(h).value - inv) / inv) * 100;
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
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Thinking…";
  }
  if (status) status.textContent = "Reviewing your portfolio…";
  try {
    const opportunityItems = (await loadLatestOpportunities()) || [];
    await bridge.runJob("advisor", {
      latestOpportunity: { items: opportunityItems },
    });
    const advice = await loadLatestAdvice();
    renderAdvice(advice ? advice.items : []);
    await updateWhatsNew(advice);
    if (status) status.textContent = "";
  } catch (err) {
    if (status)
      status.textContent = `Could not refresh advice: ${err && err.message ? err.message : err}`;
  } finally {
    adviceInFlight = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
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

// --- Start onboarding -----------------------------------------------------
// Whether the guided setup has been completed (drives the Start tab's
// visibility + the default landing tab). Set once the wizard is submitted.
let onboarded = false;

function isOnboarded(profile) {
  return !!profile.onboarded;
}

// Push the saved profile back into the Profile + Forecast inputs so they stay
// consistent after the wizard writes them.
function applyProfileToForms(profile) {
  const pf = document.getElementById("profile-form");
  if (pf) {
    pf.risk.value = profile.risk || "balanced";
    pf.preferences.value = profile.preferences || "";
  }
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveProfile({
      risk: form.risk.value,
      preferences: form.preferences.value.trim(),
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
  });
}

function updateCurrencyUI() {
  const symbol = CURRENCY_SYMBOL[activeCurrency] || activeCurrency;
  for (const el of document.querySelectorAll(".currency-prefix")) {
    el.textContent = symbol;
  }
  if (recalcCalculator) recalcCalculator();
  if (recalcForecast) recalcForecast();
}

// --- Tabs (hash-routed; one <section> per tab) ----------------------------
const TABS = [
  { id: "start", label: "Start" },
  { id: "profile", label: "Profile" },
  { id: "proposals", label: "Proposals" },
  { id: "portfolio", label: "Portfolio" },
  { id: "forecast", label: "Forecast" },
  { id: "news", label: "News" },
  { id: "calculator", label: "Calculator" },
  { id: "home", label: "Home" },
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

function showTab(id) {
  const target = tabIsAvailable(id) ? id : defaultTab();
  for (const tab of TABS) {
    const panel = document.getElementById(`tab-${tab.id}`);
    if (panel) panel.hidden = tab.id !== target;
    const btn = document.querySelector(`.tab-btn[data-tab="${tab.id}"]`);
    if (btn) {
      btn.classList.toggle("is-active", tab.id === target);
      btn.setAttribute("aria-selected", String(tab.id === target));
    }
  }
  // A chart created while its panel was display:none lays out at zero height;
  // resize it once its tab is actually visible.
  if (target === "calculator" && calculatorChart) calculatorChart.resize();
  if (target === "forecast" && forecastChart) forecastChart.resize();
  if (target === "home") handleHomeOpen();
}

function setupTabs() {
  const bar = document.getElementById("tabbar");
  bar.innerHTML = "";
  for (const tab of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn";
    btn.dataset.tab = tab.id;
    btn.textContent = tab.label;
    btn.setAttribute("role", "tab");
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
