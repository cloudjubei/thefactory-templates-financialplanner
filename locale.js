// Locale primitive for the Investment Planner template. A "locale set" is
// { country, currency, language, hour12 }. It is inferred from the host
// environment at first run, stored via Overseer's layered settings (a
// user-global default + an optional per-app override), and drives all
// region-specific formatting (currency, number grouping, dates, percent).
// `language` is stored for a future translation pass — the app text stays
// English for now. (Measurement units are intentionally omitted — irrelevant
// for an investing app; the Car Finder template keeps them.)
(function () {
  // Country → default ISO-4217 currency. Selectable countries are the keys.
  const CURRENCY_BY_COUNTRY = {
    US: "USD",
    GB: "GBP",
    IE: "EUR",
    FR: "EUR",
    DE: "EUR",
    ES: "EUR",
    IT: "EUR",
    NL: "EUR",
    BE: "EUR",
    AT: "EUR",
    PT: "EUR",
    GR: "EUR",
    FI: "EUR",
    PL: "PLN",
    CZ: "CZK",
    HU: "HUF",
    SE: "SEK",
    NO: "NOK",
    DK: "DKK",
    CH: "CHF",
    CA: "CAD",
    AU: "AUD",
    NZ: "NZD",
    JP: "JPY",
    CN: "CNY",
    HK: "HKD",
    SG: "SGD",
    IN: "INR",
    KR: "KRW",
    BR: "BRL",
    MX: "MXN",
    AR: "ARS",
    ZA: "ZAR",
    AE: "AED",
    SA: "SAR",
    TR: "TRY",
    RU: "RUB",
    UA: "UAH",
    IL: "ILS",
    TH: "THB",
    MY: "MYR",
    ID: "IDR",
    PH: "PHP",
    VN: "VND",
  };
  const COUNTRY_CODES = Object.keys(CURRENCY_BY_COUNTRY);
  // Curated common currencies, unioned with every country default above so a
  // country → currency suggestion always has a matching option.
  const CURRENCY_CODES = Array.from(
    new Set(
      [
        "USD",
        "EUR",
        "GBP",
        "JPY",
        "CNY",
        "CHF",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "PLN",
        "CZK",
        "HUF",
        "INR",
        "KRW",
        "SGD",
        "HKD",
        "BRL",
        "MXN",
        "ZAR",
        "AED",
        "TRY",
        "RUB",
      ].concat(
        Object.keys(CURRENCY_BY_COUNTRY).map((c) => CURRENCY_BY_COUNTRY[c]),
      ),
    ),
  );
  const LANGUAGE_CODES = [
    "en",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "nl",
    "pl",
    "sv",
    "cs",
    "ru",
    "uk",
    "ja",
    "zh",
    "ko",
    "ar",
    "tr",
    "hi",
  ];

  function currencyForCountry(country) {
    return CURRENCY_BY_COUNTRY[country] || "USD";
  }
  function hour12ForTag(tag) {
    try {
      return !!new Intl.DateTimeFormat(tag, {
        hour: "numeric",
      }).resolvedOptions().hour12;
    } catch {
      return false;
    }
  }

  // --- Display names (always English so the UI stays English) --------------
  const dnCache = {};
  function displayNames(type) {
    if (type in dnCache) return dnCache[type];
    let dn = null;
    try {
      dn = new Intl.DisplayNames(["en"], { type });
    } catch {
      dn = null;
    }
    dnCache[type] = dn;
    return dn;
  }
  function nameOf(type, code) {
    const dn = displayNames(type);
    try {
      return (dn && dn.of(code)) || code;
    } catch {
      return code;
    }
  }
  const countryName = (code) => nameOf("region", code);
  const currencyName = (code) => nameOf("currency", code);
  const languageName = (code) => nameOf("language", code);

  function options(codes, namer) {
    return codes
      .map((code) => ({ value: code, label: namer(code) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // --- Inference + resolution ----------------------------------------------
  // Fill any missing fields of a partial set from country-driven defaults.
  function normalizeSettings(partial) {
    const p = partial || {};
    const country = String(p.country || "US").toUpperCase();
    const language = String(p.language || "en");
    const currency = p.currency || currencyForCountry(country);
    const hour12 =
      typeof p.hour12 === "boolean"
        ? p.hour12
        : hour12ForTag(language + "-" + country);
    return { country, language, currency, hour12 };
  }

  // Best-effort locale set from the browser / desktop / mobile environment.
  function inferLocaleSettings() {
    const tag =
      (typeof navigator !== "undefined" && navigator.language) || "en-US";
    let language = "en";
    let country = "US";
    try {
      const loc = new Intl.Locale(tag);
      language = loc.language || "en";
      const maxed = typeof loc.maximize === "function" ? loc.maximize() : loc;
      country = maxed.region || loc.region || "US";
    } catch {
      const parts = String(tag).split("-");
      language = parts[0] || "en";
      country = parts[1] || "US";
    }
    return normalizeSettings({
      country: String(country).toUpperCase(),
      language,
    });
  }

  // Resolve the effective set: per-app override wins, then global default,
  // then inference. Field-level merge so a layer may set only some fields.
  function resolveLayers(layers, inferred) {
    const base = inferred || inferLocaleSettings();
    const ls = layers || {};
    return normalizeSettings(
      Object.assign({}, base, ls.global || {}, ls.app || {}),
    );
  }

  // --- Formatters ----------------------------------------------------------
  function localeTag(s) {
    const tag =
      (s && s.language ? s.language : "en") +
      "-" +
      (s && s.country ? s.country : "US");
    try {
      // eslint-disable-next-line no-new
      new Intl.Locale(tag);
      return tag;
    } catch {
      return "en-US";
    }
  }
  function formatMoney(value, s, digits) {
    const n = Number(value) || 0;
    const d = typeof digits === "number" ? digits : 0;
    try {
      return new Intl.NumberFormat(localeTag(s), {
        style: "currency",
        currency: (s && s.currency) || "USD",
        maximumFractionDigits: d,
      }).format(n);
    } catch {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: d,
      }).format(n);
    }
  }
  function currencySymbol(s) {
    try {
      const parts = new Intl.NumberFormat(localeTag(s), {
        style: "currency",
        currency: (s && s.currency) || "USD",
      }).formatToParts(0);
      const part = parts.find((p) => p.type === "currency");
      return (part && part.value) || (s && s.currency) || "$";
    } catch {
      return (s && s.currency) || "$";
    }
  }
  function formatNumber(value, s) {
    const n = Number(value) || 0;
    try {
      return new Intl.NumberFormat(localeTag(s)).format(n);
    } catch {
      return String(n);
    }
  }
  // `value` is in percent units (e.g. 1.2 → "1.2%"). opts.signed adds an
  // explicit +/− (for gains/losses); rates pass it falsy.
  function formatPercent(value, s, opts) {
    const o = opts || {};
    const n = (Number(value) || 0) / 100;
    const max = typeof o.maxDigits === "number" ? o.maxDigits : 1;
    const min =
      typeof o.minDigits === "number" ? o.minDigits : o.signed ? 1 : 0;
    try {
      return new Intl.NumberFormat(localeTag(s), {
        style: "percent",
        signDisplay: o.signed ? "exceptZero" : "auto",
        minimumFractionDigits: min,
        maximumFractionDigits: max,
      }).format(n);
    } catch {
      const sign = o.signed && (Number(value) || 0) >= 0 ? "+" : "";
      return sign + (Number(value) || 0).toFixed(max) + "%";
    }
  }
  function formatDate(ts, s) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(localeTag(s), {
        dateStyle: "medium",
      }).format(d);
    } catch {
      return d.toLocaleDateString();
    }
  }
  function formatDateTime(ts, s) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(localeTag(s), {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: !!(s && s.hour12),
      }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  window.PlannerLocale = {
    COUNTRY_CODES,
    CURRENCY_CODES,
    LANGUAGE_CODES,
    countryName,
    currencyName,
    languageName,
    countryOptions: () => options(COUNTRY_CODES, countryName),
    currencyOptions: () => options(CURRENCY_CODES, currencyName),
    languageOptions: () => options(LANGUAGE_CODES, languageName),
    currencyForCountry,
    hour12ForCountry: (country) => hour12ForTag("en-" + country),
    normalizeSettings,
    inferLocaleSettings,
    resolveLayers,
    localeTag,
    formatMoney,
    currencySymbol,
    formatNumber,
    formatPercent,
    formatDate,
    formatDateTime,
  };
})();
