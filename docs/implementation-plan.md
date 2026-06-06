# Implementation plan

The first Overseer project template: a working investment-planning app users fork into a new project and personalise via stories. Two layers are **shipped and verified on all three clients** — the template platform (catalog → app-view transport → `thefactory-ui` surface → bridge) and the **DataStorage + LiveData** foundation (project storage + live, currency-aware market data). The **analysis layer** — AI analysis jobs (proposals, advisor, investigate, news) reshaping the app into a **multi-tab daily companion**, with multi-currency portfolios — is shipped through **Stage 7** plus **Stage 4 (News)**. The **active work** is **Stage 8 (Learn)**. This doc is a compact architecture reference + the active roadmap; git history holds the build steps and the why.

Broader template concept: [overseer-local/docs/expansion/05-example-projects.md](../../overseer-local/docs/expansion/05-example-projects.md).

---

## Ground rules

- **Web is the source of truth.** Desktop ([overseer-local](../../overseer-local)) + mobile ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) mirror it 1:1; only rendering differs. Parity isn't verified until run on a device. (The template iframe is identical across clients — only the host bridge ops need per-device verification.)
- **Layering.** Core logic in [thefactory-tools](../../thefactory-tools); store schema in [thefactory-db](../../thefactory-db); the backend is a thin adapter; shared client logic lives in [thefactory-ui](../../thefactory-ui) headless, never duplicated per client. The app-view transport is one HTTP route — `GET /api/v1/projects/:id/view/*` — all three clients point an iframe / WebView at the same URL.
- **Tests.** Every new logical `*.ts` (thefactory-db / -tools / -backend / -ui headless) gets a co-located `*.test.ts` (TDD). Frontend UI (`src/ui/`) and the template's `app.js` stay untested (verification is "open it in a browser").
- **Purity.** `utils*.ts` is pure (zero node deps); `helpers*.ts` holds node-touching code (fs, db, network).
- **No bespoke per-domain tables.** Everything is `DataStorage` over the `entities` table (or a file store). Live-data adapters are declarative config — no code-execution adapters. Analysis is backend code, not stories.

---

## Architecture (shipped) — reference

### Template platform

- **A template is a full upstream git repo that already runs.** "Create from template" forks it (clean history, the template as the first commit) and registers a normal Overseer project with a seeded `.factory/`. The user opens the **App** tab and sees the project UI as a first-class host surface; subsequent stories sculpt it.
- **App surface** = a streamed HTML/CSS/JS document — iframe on web + desktop, `<WebView>` on mobile — served by `GET /…/view/*` ([files.ts](../../thefactory-backend/src/routes/files.ts)) from the project checkout (`..`-traversal-guarded, `no-store`), authed by a short-lived project-scoped **view token** accepted from any of query param / session cookie / `Referer` (minted by bearer-only `POST /…/view/grant`). Utils: [viewToken](../../thefactory-backend/src/utils/viewToken.ts), [viewSessionCookie](../../thefactory-backend/src/utils/viewSessionCookie.ts), [viewRefererToken](../../thefactory-backend/src/utils/viewRefererToken.ts).
- **Template repo layout** — static app at the root ([index.html](../index.html) / [style.css](../style.css) / [app.js](../app.js) / [data/](../data), vanilla JS + Chart.js via CDN, no build); seed at `.factory/template/` (`project.json`, `manifest.json`, `stories/`), deliberately off the `.factory/projects/<id>/` layout. The backend detects a template structurally (`.factory/template/project.json` exists).
- **Backend** — hard-coded `TEMPLATES` catalog ([templates/](../../thefactory-backend/src/templates), `GET /templates`); `POST /projects/from-template` ([projects.ts](../../thefactory-backend/src/routes/projects.ts): clone → install `.factory/template/*` layout → single-commit reinit → `createProject({ metadata: { hasApp: true } })`). After backend route changes: `sync-schemas` + `generate-swagger`, then thefactory-ui `generate:backend`.
- **thefactory-ui** — `TemplatesProvider` / `useTemplates` (catalog + `createFromTemplate`); `useProjectAppView` (grants the token, builds the absolute URL, auto-refreshes before expiry, remounts on debounced `files:changed`); `ProjectAppView` (web iframe + native `<WebView>` from the `thefactory-ui/native/ProjectAppView` subpath) + `TemplatePicker`. `'app'` is the first `SHELL_TAB_DEFS` entry, gated on `metadata.hasApp`.
- **App↔Overseer bridge** — a `overseer:`-prefixed `postMessage` protocol owned by `ProjectAppView` (validates origin against the served URL, dispatches to a host `onBridgeMessage`, posts a response envelope); the sandboxed app never holds a credential. Shipped handlers: `ready`, `toast`, `data.*` (project storage), `live-data.read` (subscribed records), `analysis.run` (run a named analysis job — `{jobName, params}` — on the user's active agent LLM config).

### DataStorage + LiveData foundation

- **DataStorage** — a generic store of `DataRecord { scope, type, key, content, metadata?, createdAt, updatedAt }`, unique by `(scope, type, key)`. `scope` is a `projectId` (project-private) or `GENERAL_SCOPE = '__general__'` (shared). Two interchangeable backends: `DbDataStorage` (maps onto `entities` via an `external_key` unique index, `shouldEmbed: false`) and `FileDataStorage` (one JSON file per record). Backend CRUD at `…/projects/:id/data` + a `data:updated` WS event; the iframe app reads/writes via `overseer:data.*` (the host holds the write credential).
- **LiveData** — declarative **DataSources** (general scope) fetch external JSON into DataStorage on a 60s scheduler tick (by `freshness`); **subscriptions** let projects share one dataset; `sample` records keep inline `history`. Adapter = `{ fetch, itemsPath, kind: sample|snapshot, map: { key, value?, time?, fields?, valueScale?, constFields? } }` — dotted paths, `$key` for object-keyed feeds, empty `itemsPath` = response root. The **Live Data tab** (all three clients) manages sources (create/edit/subscribe/refresh/records-peek); the app reads its subscribed records via `overseer:live-data.read`. **System providers** (`DataSource.system`) are platform-managed + delete-guarded (409 without `?force`).
- **Already on these rails:** the planner persists holdings (project data) and shows live, currency-aware stock prices from Stooq country sources (US/UK/DE/PL); the platform's own **LLM price table** is a system DataSource whose refresh feeds `llmCostsTools.upsertPrices()`. The **analysis layer** (web search → LLM → `opportunity` records) is shipped through 3.2 and is the active roadmap below.

---

## Active roadmap — the analysis layer + multi-tab planner

The analysis layer turns stored + live data into LLM-generated guidance and reshapes the planner into a multi-tab daily companion. 3.2's opportunity search **is** the Proposals tab, and its `profile` record **is** Profile/Start — so the original "3.3 advisor" is reframed as **Home** (the daily digest), with new sub-stages building the tabs + jobs between them.

### The app shape (tabs)

**Home leads** (the daily landing once matured); the rest ≈ the new-user journey.

| Tab                | Reads / writes                       | Analysis behind it                                    |
| ------------------ | ------------------------------------ | ----------------------------------------------------- |
| **Home**           | reads all + `advice`/`latest`        | on open if >24h stale + manual (advisor `research()`) |
| **Start**          | writes `profile`; triggers Proposals | none (onboarding wizard)                              |
| **Profile**        | `profile` (edit)                     | none                                                  |
| **Proposals**      | `opportunity`/`latest` (read)        | on-demand `research()` (shipped; evolved prompt)      |
| **Investigations** | `investigation`/`<id>` (read)        | ✅ deep-dive `investigate` job                        |
| **Portfolio**      | `holding` CRUD (your holdings only)  | none                                                  |
| **Market**         | `live-data.read` (all markets)       | none — searchable live-price browser                  |
| **Forecast**       | reads `holding` + `profile`          | none — pure client math                               |
| **News**           | `news`/`<asset id>` (read)           | ✅ per-asset `news` job (search-each-time)            |
| **Learn**          | static lessons + `profile`           | **Stage 8** — newbie education mode                   |
| **Calculator**     | none                                 | none (the existing calculator, moved here)            |

**Default tab is derived from records** (never a stored onboarding flag): no profile + no holdings → **Start**; matured (profile + ≥1 holding) + Home enabled → **Home**; profile but no holdings → **Proposals**; else **Portfolio**. Start hides itself once matured (re-openable from Profile). Per-tab "done" is derived from record existence (drives a progress stepper). A **country toggle** at the top writes `profile.country`; the app then **filters** its subscribed live records to that country's market and switches currency — all live-data subscriptions stay on, the app does the filtering (one country concept).

### Data model (all project-scoped DataStorage; `{schemaVersion, …}` envelopes)

- **`profile`/`profile`** — `{country (ISO-2), currency (derived), lumpSum?, monthlyContribution?, riskAppetite, interests[], productTypes[] (Stage 6), horizon='long'}`.
- **`holding`/`<assetClass>:<symbol-or-slug>[:account]`** — multi-asset: `{assetClass (stock|etf|fund|bond|crypto|cash|other), name, symbol?, quantity?, amountInvested, currency, currentValueManual?, account?, purchaseDate?}`. The key is content-derived, so identity is one row per instrument+account: holdings that collide on a key **aggregate** (amounts/quantity sum) rather than overwrite — per-lot tracking of the same instrument is v2. **`currency` is per-holding and authoritative** (Stage 5): totals convert each holding into the display currency via the `fx-rate` records, never rewriting the holding. One-shot migration (gated by `planner-meta/migrated-holdings-v1`) rewrites the old stock-only `holding` records, then deletes them.
- **`opportunity`/`latest`** — kept as the record type (UI label "Proposals"); enriched items `{name, symbol?, assetClass?, whyItFits, whereAvailable?, expectedReturnPctRange?}` spanning all `productTypes` (Stage 6); the batch carries `country/riskAppetite` so a country/risk change marks it stale (banner + re-run, never silent stale).
- **`fx-rate`/`rates`** (Stage 5, general scope) — one snapshot from Frankfurter (`{base:'USD', GBP, EUR, PLN, …}`); read via `live-data.read` to convert holding/forecast/digest totals into the display currency.
- **`investigation`/`<id>`** (Stage 7) — `{generatedAt, product, sections:[{heading, body}], sources}`; `<id>` is a slug of the product symbol/name so re-running overwrites.
- **Forecast** — _no record;_ computed on read from `holding` + `profile` via a pure `forecastUtils.ts` (the extracted `projectSeries`). Optional `forecast-assumptions`/`assumptions` overrides risk-derived defaults.
- **`advice`/`latest`** (Home) — `{generatedAt, country, summary, actions[], newOpportunities: ProposalItem[]}` + a tiny `home-meta`/`seen` for the "what's new since last visit" diff.
- **`news`/`<asset id>`** (Stage 4) — `{generatedAt, asset, items:[{title, source?, url?, publishedAt?, summary?}], sources}`; `<asset id>` = `newsId` (symbol/name slug), so news is per-company (deduped across holding lots) and a refresh overwrites. On-demand (per-card + "Refresh all"); no cron in v1.

### Country model (decided — fixed US/UK/DE/PL, app-side filtering)

- **Country lives on `profile.country`.** The app **filters client-side**: it reads its subscribed live records (`live-data.read`) and shows only the selected country's market (recordType `stock-quote-<cc>`), formatting money in that country's currency. **All subscriptions stay on** — no subscribe-swap, no new bridge op; the live-data layer just works and the app does the filtering.
- A small **template-side `COUNTRY_CONFIG`** (`cc → {label, currency, marketSuffix}`) drives the toggle, the filter, and the currency. Fixed to the four seeded markets (US/UK/DE/PL); **adding/removing countries is not on the agenda**. _(If countries ever go dynamic: promote `COUNTRY_CONFIG` to a thefactory-tools util and have `liveDataSeed` derive its sources from it — a clean future refactor, not needed now.)_
- **Currency follows the country**, set synchronously on toggle (no USD flash); the record currency is a consistency check. Fix the hard-coded `$` input prefixes (a real non-US bug).
- For a country's live prices the project must be subscribed to that country's source (via the **Live Data** tab); unsubscribed → the markets card shows "No live market for {label} — subscribe in the Live Data tab."

### Analysis jobs (all reuse the generic `research()` primitive)

| Job          | Where                              | Trigger                            | Record                 | Prompt module                |
| ------------ | ---------------------------------- | ---------------------------------- | ---------------------- | ---------------------------- |
| Proposals    | backend `research()`               | on-demand (shipped)                | `opportunity`/`latest` | `opportunityAnalysis.ts`     |
| Forecast     | client, pure math                  | instant                            | none                   | `forecastUtils.ts`           |
| Home/advisor | backend `research()` + assembler   | on **open if >24h stale** + manual | `advice`/`latest`      | new `homeAdvisorAnalysis.ts` |
| News         | backend `researchWeb()`, per asset | ✅ on-demand (per-card + all)      | `news`/`<asset id>`    | `newsAnalysis.ts`            |

**No backend cron in v1** — daily-fresh jobs run when the user **opens the relevant tab and the record is >24h old** (the daily-visit model) + a manual refresh. A server-side scheduler that pre-warms digests is a later phase.

### Buildable sub-stages

3.1 ✅ web search · 3.2 ✅ opportunity search (→ Proposals + the `profile` record). Then, in order:

- **3.4 ✅ Multi-tab shell + country selector** _(foundation; template-only — no platform changes)._ Hash-routed tab shell (`<section>` per tab, a tab registry, shared ctx, progress stepper); move the existing calculator / profile form / top-picks into the Calculator / Profile / Proposals tabs verbatim. Country toggle writes `profile.country`; a template-side `COUNTRY_CONFIG` drives client-side filtering of the subscribed records + currency. `$`-prefix bug fixed. (Builds on the existing subscribe UI + `live-data.read`.)
- **3.5 ✅ Portfolio multi-asset** _(single-currency v1)._ Generalize `holding` content + key; one-shot migration; Portfolio tab (live-price match where a `stock-quote` exists, single-currency totals, add/edit form, "I bought this" deep-link from Proposals). Imported-later holdings (3rd-party) land here unchanged.
- **3.6 ✅ Forecast.** Extract `projectSeries` into a pure template-local `forecast.js` (loaded before `app.js`; the template is vanilla JS, so no `.ts`) alongside per-risk return bands (`RISK_RETURN_BANDS`) + `buildForecast`; Forecast tab (projection from the live portfolio value + monthly contribution + blended return; conservative/expected/optimistic; calculator-style fallback when empty). **Deterministic-only in v1** — an LLM assumption-sourcing/commentary layer is deferred (documented). Zero new backend.
- **3.7 ✅ Generalize the analysis route to a named-job registry.** Backend `analysisJobs` registry `jobName → {buildRequest, toRecords→{type,key,content}}` + generic `POST /projects/:id/analysis/jobs/:jobName/run` (`runAnalysisJob`); `opportunitiesJob` lives in `opportunityAnalysis.ts`; the specific route deleted (no shim). thefactory-ui: generic `analysis.run {jobName, params}` bridge op. Template: `bridge.runJob(jobName, params)` + re-read via `data.*`. Adding a job = one module exporting an `AnalysisJob` + one registry line.
- **3.8 — Start onboarding.** 3-question wizard (lump sum / monthly / risk + interests) → writes `profile` → runs Proposals → routes to Proposals mid-spinner; hides once matured. Extend `buildOpportunityRequest` to consume the new profile fields (drop the mirror fields in the same change).
- **3.9 ✅ Home digest + advisor** _(the reframed 3.3)._ `homeAdvisorAnalysis.ts` (`buildAdvisorRequest(profile, holdings, latestOpportunity)` + `advisorJob`) registered as the `advisor` job → `advice`/`latest`; a deterministic digest skeleton (portfolio delta, biggest mover, forecast headline) + LLM only for new opportunities / strategy improvements (diffed against held + already-proposed). Runs **on open if the `advice` record is >24h stale** + a manual refresh (no cron); becomes the default landing once matured. `home-meta`/`seen` powers a "what's new since last visit" diff.

**Stage 3 (3.4–3.9), Polish P1–P5, Stage 4 (News), and Stages 5–7 are shipped.** The only remaining roadmap stage is **Stage 8 (Learn)**. The expanded vision below — surfaced from real use — keeps the shipped stages as a compact reference.

### Polish P1–P5 ✅ (shipped — template-only)

- **P1 — Full-height layout.** When content doesn't fill the viewport the page shows two backgrounds and the footer floats mid-screen. Make `body` a `min-height:100dvh` flex column with one background and pin `.page-foot` to the bottom (`margin-top:auto`).
- **P2 — Home is the first tab.** Reorder the tab registry so Home leads. (Default-landing logic unchanged: Start until onboarded, then Home.)
- **P3 — Analysis-run resilience.** A first Proposals run showed "Finding…" then silently reverted with no result/error. Add a visible spinner, raise the `analysis.run` bridge timeout (web search + LLM routinely exceeds 90s), surface failures prominently, and on timeout/settle re-read the record (the backend writes it even if the bridge call gave up). Root-cause fix = the `data.changed` push (below).
- **P4 — Per-tab work indicators.** Each tab button shows a **spinner** while a job for that tab is running (Proposals find, Home advisor) and an **unread-count notification badge** when it completes off-tab; opening the tab clears it. A small per-tab `{busy, unread}` registry rendered into the tab buttons (mirrors thefactory-ui's `NotificationBadge` / `SpinnerWithDot` look). Generalises Stage 7's Investigations notifications; becomes fully background-proof once the `data.changed` push lands.
- **P5 — Split Portfolio / Market.** Portfolio is now just **your holdings**; the live-market card moved to its own **Market** tab — a searchable browser of every subscribed market's live prices (all countries, per-item currency, symbol search). Holdings still match live prices in the user's country market only (single-currency v1); _future:_ arbitrary-ticker lookup needs a new on-demand live-data bridge op beyond the subscribed records.

### Stage 5 ✅ — Multi-currency portfolio + FX feed

A holding is pinned to **its own** currency and must NOT change when the country toggle changes; a user in country A may hold country-B assets, so the portfolio needs **currency conversion**. The country toggle is just a market filter + display-currency picker now (a real user sets country once).

- **FX LiveData source** — a new **system DataSource** off [frankfurter.dev](https://frankfurter.dev) (`https://api.frankfurter.dev/v1/latest?base=…&symbols=…`): free, **no API key**, no quota, ECB daily rates, covers USD/GBP/EUR/PLN. Declarative adapter → `fx-rate` records; the app reads them via `live-data.read`. Seed it in `liveDataSeed`.
- **Per-asset currency** — the add/edit-holding form gains a currency field (defaults to the country currency); `holding.currency` is authoritative and never rewritten on a country switch (drop the country→currency coupling for held assets).
- **Display currency** — portfolio / Forecast / Home totals convert each holding's value from its currency → the user's display currency via the FX records; missing-rate fallback shows native currency + a flag. Live stock prices keep using their own source currency, then convert.

### Stage 6 ✅ — Richer proposals: all products + structured preferences

Proposals are stock-centric and unfiltered; broaden them and make them relevant.

- **Any legally-purchasable opportunity** — broaden the opportunity + advisor prompts beyond stocks/ETFs to funds, bonds, crypto, **and non-asset procedures** (e.g. a savings/cash account with a strong promo rate, ISAs/tax wrappers). Items carry `assetClass`/`productType` + `whereAvailable`; "I bought this" already routes by `assetClass`.
- **Structured preferences** — onboarding captures which asset classes the user wants (savings/cash, crypto, bonds, etc.) into `profile.productTypes`. Proposals + advice filter on these, so an uninterested user isn't shown (say) savings accounts. _(Sectors/ethics weighting is a v2 extension of the same field.)_

### Stage 7 ✅ — Proposal deep-dive + Investigations tab

- **Expandable proposal cards** — each Proposals/advice card expands to a summary + _why it fits_; collapses to the headline.
- **"Investigate" action** — from an expanded card, launch a deep-research `investigate` analysis job (one product in → a thorough `investigation`/`<id>` record). One new `AnalysisJob` + one registry line (the 3.7 payoff).
- **New "Investigations" tab** — lists ongoing (spinner) + completed investigations; a completed-but-unread one shows a **notification badge** on the tab that clears once read.
- Shipped on the **runJob + re-read + per-tab badge** pattern (P3/P4); the `data.changed` push (below) stays deferred since that pattern already covers completion notifications.

### `data.changed` push into the iframe (deferred — re-read pattern shipped instead)

Long jobs (Proposals/advice/investigations) outlive the bridge request; today the app re-reads the record after the `runJob` call settles (the backend writes it even on bridge timeout) and badges the tab. A cleaner root-cause version forwards the host's `data:updated` WS event into the iframe as an `overseer:data.changed` event so the app re-renders the moment a record lands — a generic platform change in `ProjectAppView` + the bridge. **Trigger:** a job whose completion the re-read pattern can't catch (e.g. a record written with no originating bridge call), or background pre-warming (Stage 4's scheduler).

### Stage 4 ✅ — News (per-asset, search-each-time v1)

LLM-curated recent news on the user's held assets — a News tab with one card per distinct held asset (deduped by `newsId` = symbol/name slug), each refreshable on demand (per-card + "Refresh all"). A `news` analysis job (`newsAnalysis.ts`, one `researchWeb` pass per asset → a `news`/`<asset id>` record); the card shows the items (title → source · date, summary) plus a verified-sources footer; LLM-authored urls pass an http(s)-only `safeUrl` guard before reaching any `href`. Runs on the existing runJob + re-read + per-tab badge rails (no cron).

**v1 ships the "search-each-time" path** (the documented fallback); these refinements stay deferred, each on existing rails:

- **Discover-then-pull:** a first pass curates the best outlets for the user's assets + interests into a `news-sources` record; later refreshes only pull from those + a cheap digest pass, with a periodic re-evaluation. **Trigger:** per-asset search cost becomes the bottleneck.
- **Backend scheduler + per-project cost ceiling:** pre-warm digests overnight instead of on-open. **Trigger:** users want fresh news without opening the tab (also unlocks the `data.changed` push).
- **Social-media sweep** — desirable but **needs research** (build vs. integrate); out of scope until that lands.

### Stage 8 — Learn / newbie education mode (item 8 — after News)

A guided **"newbie mode"** that educates the user about investing — asset classes, what's actually possible, and plain-English explanations of basic terms — so a beginner uses the planner confidently. A big phase in its own right, **built after News**. Likely a **Learn** tab with curated lessons + LLM-explained-terms-on-demand, plus a `profile` beginner flag that softens tone / surfaces inline explainers across the other tabs. The structured preferences from Stage 6 decide how much hand-holding to show.

### Generic (platform) vs template (forkable)

- **Generic, reused as-is:** DataStorage, LiveData sources/subscriptions, `ResearchTools.researchWeb()`, the bridge transport + host-held credential. **The one new generic mechanism is the named-job analysis route/registry (3.7)** — tested in shared layers, free on all 3 clients.
- **Template / finance domain:** all record _shapes_ + `type` strings; the finance prompt modules (`opportunityAnalysis`/`homeAdvisorAnalysis`/`newsAnalysis`, pure + tested); the template-side `COUNTRY_CONFIG`; the tab registry + rendering; calculator + forecast math; the client-side country filtering.

### Decided (v1 scope) & deferred

**Decided (Stage 3 v1):** country stored on the profile + app-side filtering (all subscriptions stay on); `opportunity` record type kept (label "Proposals"); single-currency for Stage 3 (**now superseded by Stage 5**); **no backend cron** — daily jobs refresh on-open-if-stale (24h) + manual; Forecast deterministic-only; fixed 4 countries.

**Shipped (were deferred):** multi-currency + FX feed → **Stage 5**. **Re-deferred:** the `data.changed` push (the re-read + per-tab badge pattern shipped instead — see above).

**Resolved at build (Stages 4–7):**

- **Stage 4:** v1 is **search-each-time, per held asset**, keyed per-company by `newsId`; discover-then-pull source curation + a backend scheduler/cost-ceiling are deferred (see the Stage 4 section).
- **Stage 5:** FX is **one snapshot `fx-rate`/`rates` record** per base (USD), carrying all symbols; display currency derives from `profile.country` (no separate setting).
- **Stage 6:** the preference taxonomy is the template-side `PRODUCT_TYPES` set (stocks/etfs/funds/bonds/crypto/savings); `profile.productTypes` filters the opportunity + advisor prompts.
- **Stage 7:** completion rides the **runJob re-read + per-tab unread badge** (session-scoped seen state), not a `data.changed` push.

**Open questions (decide at the start of each stage):**

- **Stage 8:** how much of the `profile` beginner flag drives inline explainers vs a dedicated Learn tab.

**Still deferred (v2+), each on existing rails:**

- **Backend scheduler** pre-warming digests + a per-project daily cost ceiling — with Stage 4.
- **3rd-party integrations** (bank/brokerage import), a **declarative-analysis-spec DSL**, **dynamic countries**, a **"browse another market" peek** — each triggered by a concrete need (see Non-goals).

---

## Backlog (template platform)

### Deferred integration seams (each names its build trigger)

- **`manifest.json` native rendering** — Overseer reads `.factory/template/manifest.json` and renders declared `{ menuEntries?, theme?, defaultChats? }` natively. Trigger: a template declares any of these and a contributor adds the host renderer.
- **App writes to repo source files (`overseer:writeFile`)** — the app editing its own version-controlled source via the bearer file routes (distinct from app _data_, which is DataStorage). Trigger: an app surface needs to mutate repo files at runtime.
- **"Native app template" kind** — a template shipping a React tree using thefactory-ui's web+native peers, imported by the host directly (no iframe). Trigger: a product decision to offer a second template kind.
- **Per-project dev server (framework templates)** — when a template ships a `dev` script, the backend spawns it lazily on first App-tab open and reverse-proxies `/view/*` to it. Trigger: the first template that needs a build pipeline.
- **Hosted-repo conversion** — a project-settings affordance converting a local-only project to GitHub-backed (wraps `POST /projects/github/create-repo` + remote/push). Trigger: a user wants their project pushed from inside Overseer.

### Subsequent templates

Board game, book writing, car-buyer helper, interior planner (per [the expansion doc](../../overseer-local/docs/expansion/05-example-projects.md)). The plumbing is proven with one; add the next when prioritised.

---

## Non-goals (name the trigger to revisit)

**Template platform:**

- No `template.json` / `scaffold/` machinery in thefactory-tools — templates are full repos, no loader.
- No dynamic catalog endpoint fetching a remote registry — hard-coded const only.
- No post-clone tweaks beyond install-layout + `git init` + single commit.
- No auth-bypass on `/view/*` — the signed-token paths (query / cookie / Referer) are the only non-bearer entry; the token is project-scoped, read-only, short-lived.

**Data / analysis:**

- No bespoke per-domain tables; no code-execution live-data adapters; no non-DB analysis (feeds, sharing, and analysis need the DB).
- **No 3rd-party integrations yet** (bank / brokerage import). Designed on existing rails: credential type → OAuth flow → backend importer writing `holding` records → `integration.connect`/`import` bridge ops. **Trigger:** the first brokerage/aggregator OAuth credential type in [credentialTypes.ts](../../thefactory-tools/src/credentials/credentialTypes.ts). Standing obligation: keep `holding` the single portfolio source of truth + the connect affordance hidden when standalone.
- **No declarative-analysis-spec DSL yet** — the named-job registry (3.7) is enough. **Trigger:** a _second_ domain needs analysis jobs.
- **No "browse another market" peek or authed/paginated live-data adapters yet** — each on existing rails when a concrete need triggers it. (FX shipped in Stage 5 as a declarative `fx-rate` source — no bespoke engine.)
