# Architecture

The Investment Planner — the first Overseer **project template**: a working investment-planning app a user
forks into a new project and personalises via stories. This doc describes how the shipped app works; the
[implementation plan](./implementation-plan.md) covers what's left to build.

The app is a multi-tab "daily companion": the user visits each day and either has an action to take (a fresh
proposal, advice, news) or learns something about their holdings. It runs **embedded** in Overseer
(`window.OverseerBridge.embedded`) or **standalone** (a static page on `localStorage`, with the analysis/live
features disabled).

## Invariants

- **Web is the source of truth.** Desktop ([overseer-local](../../overseer-local)) + mobile
  ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) mirror it 1:1; only rendering differs. The
  template iframe is identical across all three clients — only the host bridge ops need per-device verification.
- **Layering.** Core logic in [thefactory-tools](../../thefactory-tools); store schema in
  [thefactory-db](../../thefactory-db); the backend is a thin adapter; shared client logic lives in
  [thefactory-ui](../../thefactory-ui) headless, never duplicated per client.
- **Purity.** `utils*.ts` is pure (zero node deps); `helpers*.ts` holds node-touching code (fs, db, network).
- **Co-located tests.** Every logical `*.ts` (thefactory-db / -tools / -backend / -ui headless) has a
  `*.test.ts` (TDD). Frontend UI (`src/ui/`) and the template's vanilla `app.js` are verified in a browser, not
  unit-tested.
- **No bespoke per-domain tables.** Everything is `DataStorage` over the `entities` table (or a file store).
  Live-data adapters are declarative config — no code-execution adapters. Analysis is backend code, not stories.

## Template platform

- **A template is a full upstream git repo that already runs.** "Create from template" forks it (clean history,
  the template as the first commit) and registers a normal Overseer project with a seeded `.factory/`. The user
  opens the **App** tab and sees the project UI as a first-class host surface; subsequent stories sculpt it.
- **App surface** — a streamed HTML/CSS/JS document (iframe on web + desktop, `<WebView>` on mobile), served by
  `GET /…/view/*` ([files.ts](../../thefactory-backend/src/routes/files.ts)) from the project checkout
  (`..`-traversal-guarded, `no-store`), authed by a short-lived project-scoped **view token** accepted from query
  param / session cookie / `Referer` (minted by bearer-only `POST /…/view/grant`).
- **Repo layout** — static app at the root ([index.html](../index.html) / [style.css](../style.css) /
  [app.js](../app.js) / [forecast.js](../forecast.js) / [data/](../data); vanilla JS + Chart.js via CDN, no
  build); seed at `.factory/template/` (`project.json`, `manifest.json`, `stories/`). The backend detects a
  template structurally (`.factory/template/project.json` exists).
- **Backend** — hard-coded `TEMPLATES` catalog ([templates/](../../thefactory-backend/src/templates),
  `GET /templates`); `POST /projects/from-template` clones → installs the `.factory/template/*` layout →
  single-commit reinit → `createProject({ metadata: { hasApp: true } })`.
- **thefactory-ui** — `TemplatesProvider` / `useTemplates`; `useProjectAppView` (grants the token, builds the
  URL, auto-refreshes before expiry, remounts on debounced `files:changed`); `ProjectAppView` (web iframe +
  native `<WebView>`). `'app'` is the first shell tab, gated on `metadata.hasApp`.
- **App↔Overseer bridge** — an `overseer:`-prefixed `postMessage` protocol owned by `ProjectAppView` (validates
  origin, dispatches to a host handler, posts a response envelope); the sandboxed app never holds a credential.
  Ops: `ready`, `toast`, `data.*` (project storage), `live-data.read` (subscribed records), `analysis.run`
  (`{jobName, params}`, on the user's active agent LLM config). `bridge.runJob(jobName, params)` has a 180s
  timeout; the backend writes its record even if the bridge call times out, so callers re-read.

## DataStorage + LiveData

- **DataStorage** — a generic store of `DataRecord { scope, type, key, content, … }`, unique by
  `(scope, type, key)`. `scope` is a `projectId` (project-private) or `GENERAL_SCOPE` (shared). Backends:
  `DbDataStorage` (onto `entities`) and `FileDataStorage`. The iframe reads/writes via `overseer:data.*` (the
  host holds the write credential); a `data:updated` WS event fires on change.
- **LiveData** — declarative **DataSources** (general scope) fetch external JSON into DataStorage on a 60s tick
  (by `freshness`); **subscriptions** let projects share a dataset. Adapter =
  `{ fetch, itemsPath, kind: sample|snapshot, map: { key, value?, time?, fields?, valueScale?, constFields? } }`
  — `$key` for object-keyed feeds. `sample` records keep an inline `history: [{t, v}]`. The **Live Data tab**
  (all clients) manages sources; the app reads its subscribed records via `overseer:live-data.read`. **System**
  providers (`DataSource.system`) are platform-managed + delete-guarded — only the **LLM price table** is system;
  the stock-quote and FX sources are ordinary market data the project subscribes to.
- **Seeded sources** ([liveDataSeed.ts](../../thefactory-backend/src/utils/liveDataSeed.ts)): per-market Stooq
  stock quotes (`stock-quote-us|uk|de|pl`, daily, native currency, LSE pence scaled to pounds), the system LLM
  price table, and the FX source (Frankfurter `fx-rate/rates`, daily ECB rates, no key).

## The app (tabs)

Home leads once matured; the rest ≈ the new-user journey. The default tab is **derived from records**, never a
stored flag: no profile + no holdings → Start; matured (profile + ≥1 holding) → Home; profile but no holdings →
Proposals; else Portfolio. Start hides once matured (re-openable from Profile).

| Tab                | Reads / writes                       | Analysis behind it                            |
| ------------------ | ------------------------------------ | --------------------------------------------- |
| **Home**           | reads all + `advice/latest`          | `advisor` job, on open if >24h stale + manual |
| **Start**          | writes `profile`; triggers Proposals | none (onboarding wizard)                      |
| **Profile**        | `profile` (edit)                     | none                                          |
| **Proposals**      | `opportunity/latest`                 | `opportunities` job, on-demand                |
| **Investigations** | `investigation/<id>`                 | `investigate` job (deep-dive from a proposal) |
| **Portfolio**      | `holding` CRUD                       | none                                          |
| **Market**         | `live-data.read` (all markets)       | `asset-info` job (the per-row "i")            |
| **Forecast**       | reads `holding` + `profile`          | none — pure client math (`forecast.js`)       |
| **News**           | `news/<asset id>`                    | `news` job, on-demand per held asset          |
| **Learn**          | static lessons + `profile`           | _pending — see the implementation plan_       |
| **Calculator**     | none                                 | none                                          |

- **Per-tab work indicators** — each tab button shows a spinner while its job runs and an unread-count badge when
  one completes off-tab; opening the tab clears it (a per-tab `{busy, unread}` registry).
- **Portfolio** — your holdings only; totals (value / cost / P&L) at the top; the add/edit form is a modal opened
  by a "+" icon button (the standard two-line Overseer IconPlus).
- **Market** — a searchable, country-filterable table of every subscribed market's live prices, with
  **1d/7d/30d** change columns + a sparkline (both from the record's inline `history`), and an "i" button per row
  that opens a stored short description (the `asset-info` job).
- **Proposals** — expandable cards (headline → rationale + where-available). Each card's **Investigate** button
  reflects state: idle → ongoing (spinner) → done (navigates to the Investigations tab on click).

## Data model

All project-scoped `DataStorage` records (`{schemaVersion, …}` envelopes) unless noted.

- **`profile/profile`** — `{country (ISO-2), currency (derived), lumpSum?, monthlyContribution?, risk,
preferences?, productTypes[], horizon}`.
- **`holding/<assetClass>:<symbol-or-slug>[:account]`** — `{assetClass (stock|etf|fund|bond|crypto|cash|other),
name, symbol?, quantity?, amountInvested, currency, currentValueManual?, account?, purchaseDate?}`. The key is
  content-derived, so identity is one row per instrument+account; collisions **aggregate** (sum) rather than
  overwrite. `currency` is per-holding and authoritative — never rewritten on a country switch.
- **`opportunity/latest`** — `{generatedAt, country, items:[{name, symbol?, assetClass?, rationale,
whereAvailable?}], sources}`. `country` stamps which country it was generated for (drives the stale banner).
- **`advice/latest`** (Home) — `{generatedAt, country, items:[{title, detail}], sources}` + a `home-meta/seen`
  marker for the "what's new since last visit" diff.
- **`investigation/<id>`** — `{generatedAt, product, sections:[{heading, body}], sources}`; `<id>` slugs the
  product symbol/name so re-running overwrites.
- **`news/<asset id>`** — `{generatedAt, asset, items:[{title, source?, url?, publishedAt?, summary?}], sources}`;
  `<asset id>` = symbol/name slug, so news is per-company (deduped across holding lots).
- **`asset-info/<id>`** — `{generatedAt, asset, summary, sources}`; a short beginner description for the Market "i".
- **`fx-rate/rates`** (general scope) — one Frankfurter snapshot `{base:'USD', GBP, EUR, PLN, …}`.
- **Forecast** — _no record;_ computed on read from `holding` + `profile` (`forecast.js`).

## Country + currency

- **Country lives on `profile.country`**; a top toggle (`COUNTRY_CONFIG`: `cc → {label, currency, marketSuffix}`,
  fixed to US/GB/DE/PL) switches it. The app filters its subscribed live records to that country's market and
  formats money in its currency — all subscriptions stay on; the app does the filtering.
- **Currency correctness** — each figure shown is either truly in the display currency (converted via the
  `fx-rate` records, marked `≈`) or in the holding's own currency when its rate isn't subscribed. Totals sum only
  fully-converted holdings; a note reports any excluded. Never a native amount under the wrong symbol, never a
  mixed-currency sum. Holdings need the project subscribed to the FX source for conversion.
- **Country-tailored analysis** — the opportunity + advisor prompts demand only investments a retail investor
  based in `profile.country` can access; the records are stamped with their country, and Proposals/Home show a
  "made for another country — refresh" hint when it no longer matches.

## Analysis jobs

Analysis is **backend code, not stories**, on one generic mechanism (the named-job registry — the one new
platform primitive this template added; tested in shared layers, free on all three clients):

- **Registry** — [analysisJobs.ts](../../thefactory-backend/src/utils/analysisJobs.ts) maps `jobName → AnalysisJob
{ buildRequest(profile, holdings, params?), toRecords(items, sources, ctx) }`. The generic route
  `POST /projects/:id/analysis/jobs/:jobName/run` runs `buildRequest` → `ResearchTools.researchWeb` → `toRecords`
  → upsert. Adding a job = one module exporting an `AnalysisJob` + one registry line. Jobs: `opportunities`,
  `advisor`, `investigate`, `news`, `asset-info`.
- **`researchWeb`** = web search → LLM structured extraction → parsed items. **No backend cron**: daily-fresh
  jobs refresh when the user opens the relevant tab and the record is >24h old, plus a manual refresh.
- **Reliability invariants** (the fix for "jobs return nothing"):
  - The research path **must** pass `structuredOutput: false` to `sendCompletion`. The default forces the
    agent-envelope schema, which strands the model's JSON array inside a prose `message` and parses to `[]`
    (non-deterministic per call — it looks like flaky/empty results). There's a load-bearing guard comment;
    do not remove it.
  - `WebTools.webSearch` retries 429/5xx + network errors with backoff and throws the **real** provider error
    (status preserved); `dispatchAnalysisBridge` lifts `response.data.error` off the axios error so the template
    shows the true cause (rate-limit / no-provider) instead of a silent "nothing".

## Generic vs template (forkable)

- **Generic, reused as-is:** DataStorage, LiveData sources/subscriptions, `ResearchTools.researchWeb()`, the
  bridge transport + host-held credential, and the named-job analysis route/registry.
- **Template / finance domain:** all record _shapes_ + `type` strings; the finance prompt modules
  (`opportunityAnalysis` / `homeAdvisorAnalysis` / `newsAnalysis` / `investigationAnalysis` / `assetInfoAnalysis`,
  pure + tested); the template-side `COUNTRY_CONFIG`; the tab registry + rendering; calculator + forecast math;
  the client-side country filtering + currency conversion.
