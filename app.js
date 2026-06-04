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

  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Finding…";
    if (status)
      status.textContent =
        "Searching the web and analysing — this can take a moment…";
    try {
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
}

// --- Calculator -----------------------------------------------------------
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

// The records-derived default lands properly once Start/Home are built; for now
// the seeded Portfolio is the most useful first view.
const DEFAULT_TAB = "portfolio";

function hashTab() {
  const id = (location.hash || "").replace(/^#/, "");
  return TABS.some((t) => t.id === id) ? id : null;
}

function showTab(id) {
  const target = TABS.some((t) => t.id === id) ? id : DEFAULT_TAB;
  for (const tab of TABS) {
    const panel = document.getElementById(`tab-${tab.id}`);
    if (panel) panel.hidden = tab.id !== target;
    const btn = document.querySelector(`.tab-btn[data-tab="${tab.id}"]`);
    if (btn) {
      btn.classList.toggle("is-active", tab.id === target);
      btn.setAttribute("aria-selected", String(tab.id === target));
    }
  }
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
  window.addEventListener("hashchange", () => showTab(hashTab()));
  showTab(hashTab() || DEFAULT_TAB);
}

async function init() {
  try {
    setupTabs();
    const profile = await loadProfile();
    activeCountry = COUNTRY_CONFIG[profile.country]
      ? profile.country
      : DEFAULT_COUNTRY;
    activeCurrency = COUNTRY_CONFIG[activeCountry].currency;
    const topPicks = await loadJson("./data/top-picks.json");

    setupCountry();
    setupProfile(profile);
    renderCalculator();
    updateCurrencyUI();
    setupHoldingControls();
    await setupProposals(topPicks);
    await migrateHoldings();
    await ensureSeeded();
    await refreshHoldings();
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
