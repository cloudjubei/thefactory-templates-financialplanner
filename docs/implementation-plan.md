# Implementation plan

The first Overseer project template: a working investment-planning app users fork into a new project and personalise via stories. Two layers are **shipped and verified on all three clients** — the template platform (catalog → app-view transport → `thefactory-ui` surface → bridge) and the **DataStorage + LiveData** foundation (project storage + live, currency-aware market data). The **active work** is the **analysis layer**, which both adds AI analysis jobs and reshapes the app from a single page into a **multi-tab daily companion** (the user visits each day and either has an action to take or learns something about their assets). This doc is a compact architecture reference + the active roadmap; git history holds the build steps and the why.

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
- **App↔Overseer bridge** — a `overseer:`-prefixed `postMessage` protocol owned by `ProjectAppView` (validates origin against the served URL, dispatches to a host `onBridgeMessage`, posts a response envelope); the sandboxed app never holds a credential. Shipped handlers: `ready`, `toast`, `data.*` (project storage), `live-data.read` (subscribed records), `analysis.run-opportunities` (run the analysis job, on the user's active agent LLM config).

### DataStorage + LiveData foundation

- **DataStorage** — a generic store of `DataRecord { scope, type, key, content, metadata?, createdAt, updatedAt }`, unique by `(scope, type, key)`. `scope` is a `projectId` (project-private) or `GENERAL_SCOPE = '__general__'` (shared). Two interchangeable backends: `DbDataStorage` (maps onto `entities` via an `external_key` unique index, `shouldEmbed: false`) and `FileDataStorage` (one JSON file per record). Backend CRUD at `…/projects/:id/data` + a `data:updated` WS event; the iframe app reads/writes via `overseer:data.*` (the host holds the write credential).
- **LiveData** — declarative **DataSources** (general scope) fetch external JSON into DataStorage on a 60s scheduler tick (by `freshness`); **subscriptions** let projects share one dataset; `sample` records keep inline `history`. Adapter = `{ fetch, itemsPath, kind: sample|snapshot, map: { key, value?, time?, fields?, valueScale?, constFields? } }` — dotted paths, `$key` for object-keyed feeds, empty `itemsPath` = response root. The **Live Data tab** (all three clients) manages sources (create/edit/subscribe/refresh/records-peek); the app reads its subscribed records via `overseer:live-data.read`. **System providers** (`DataSource.system`) are platform-managed + delete-guarded (409 without `?force`).
- **Already on these rails:** the planner persists holdings (project data) and shows live, currency-aware stock prices from Stooq country sources (US/UK/DE/PL); the platform's own **LLM price table** is a system DataSource whose refresh feeds `llmCostsTools.upsertPrices()`. The **analysis layer** (web search → LLM → `opportunity` records) is shipped through 3.2 and is the active roadmap below.

---

## Active roadmap — the analysis layer + multi-tab planner

The analysis layer turns stored + live data into LLM-generated guidance and reshapes the planner into a multi-tab daily companion. 3.2's opportunity search **is** the Proposals tab, and its `profile` record **is** Profile/Start — so the original "3.3 advisor" is reframed as **Home** (the daily digest), with new sub-stages building the tabs + jobs between them.

### The app shape (8 tabs)

Left-to-right ≈ the new-user journey; **Home** is the daily landing once the user has a profile + holdings.

| Tab            | Reads / writes                       | Analysis behind it                                    |
| -------------- | ------------------------------------ | ----------------------------------------------------- |
| **Start**      | writes `profile`; triggers Proposals | none (onboarding wizard)                              |
| **Profile**    | `profile` (edit)                     | none                                                  |
| **Proposals**  | `opportunity`/`latest` (read)        | on-demand `research()` (shipped; evolved prompt)      |
| **Portfolio**  | `holding` CRUD + `live-data.read`    | none                                                  |
| **Forecast**   | reads `holding` + `profile`          | none — pure client math                               |
| **News**       | `news`/`<asset>` (read)              | **Stage 4** — dedicated phase (built last)            |
| **Calculator** | none                                 | none (the existing calculator, moved here)            |
| **Home**       | reads all + `advice`/`latest`        | on open if >24h stale + manual (advisor `research()`) |

**Default tab is derived from records** (never a stored onboarding flag): no profile + no holdings → **Start**; matured (profile + ≥1 holding) + Home enabled → **Home**; profile but no holdings → **Proposals**; else **Portfolio**. Start hides itself once matured (re-openable from Profile). Per-tab "done" is derived from record existence (drives a progress stepper). A **country toggle** at the top writes `profile.country`; the app then **filters** its subscribed live records to that country's market and switches currency — all live-data subscriptions stay on, the app does the filtering (one country concept).

### Data model (all project-scoped DataStorage; `{schemaVersion, …}` envelopes)

- **`profile`/`profile`** — `{country (ISO-2), currency (derived), lumpSum?, monthlyContribution?, riskAppetite, interests[], horizon='long'}`.
- **`holding`/`<assetClass>:<symbol-or-slug>[:account]`** — multi-asset: `{assetClass (stock|etf|fund|bond|crypto|cash|other), name, symbol?, quantity?, amountInvested, currency, currentValueManual?, account?, purchaseDate?}`. The key is content-derived, so identity is one row per instrument+account: holdings that collide on a key **aggregate** (amounts/quantity sum) rather than overwrite — per-lot tracking of the same instrument is v2. **v1 assumes all holdings are in the user's country currency** (single-currency); multi-currency/multi-country is v2. One-shot migration (gated by `planner-meta/migrated-holdings-v1`) rewrites the old stock-only `holding` records, then deletes them.
- **`opportunity`/`latest`** — kept as the record type (UI label "Proposals"); enriched items `{name, symbol?, assetClass?, whyItFits, whereAvailable?, expectedReturnPctRange?}`; the batch carries `country/riskAppetite` so a country/risk change marks it stale (banner + re-run, never silent stale).
- **Forecast** — _no record;_ computed on read from `holding` + `profile` via a pure `forecastUtils.ts` (the extracted `projectSeries`). Optional `forecast-assumptions`/`assumptions` overrides risk-derived defaults.
- **`advice`/`latest`** (Home) — `{generatedAt, country, summary, actions[], newOpportunities: ProposalItem[]}` + a tiny `home-meta`/`seen` for the "what's new since last visit" diff.
- **`news`/`<holding key>`** — defined in **Stage 4** (the News phase): one record per held asset, refreshed daily.

### Country model (decided — fixed US/UK/DE/PL, app-side filtering)

- **Country lives on `profile.country`.** The app **filters client-side**: it reads its subscribed live records (`live-data.read`) and shows only the selected country's market (recordType `stock-quote-<cc>`), formatting money in that country's currency. **All subscriptions stay on** — no subscribe-swap, no new bridge op; the live-data layer just works and the app does the filtering.
- A small **template-side `COUNTRY_CONFIG`** (`cc → {label, currency, marketSuffix}`) drives the toggle, the filter, and the currency. Fixed to the four seeded markets (US/UK/DE/PL); **adding/removing countries is not on the agenda**. _(If countries ever go dynamic: promote `COUNTRY_CONFIG` to a thefactory-tools util and have `liveDataSeed` derive its sources from it — a clean future refactor, not needed now.)_
- **Currency follows the country**, set synchronously on toggle (no USD flash); the record currency is a consistency check. Fix the hard-coded `$` input prefixes (a real non-US bug).
- For a country's live prices the project must be subscribed to that country's source (via the **Live Data** tab); unsubscribed → the markets card shows "No live market for {label} — subscribe in the Live Data tab."

### Analysis jobs (all reuse the generic `research()` primitive)

| Job          | Where                            | Trigger                            | Record                 | Prompt module                |
| ------------ | -------------------------------- | ---------------------------------- | ---------------------- | ---------------------------- |
| Proposals    | backend `research()`             | on-demand (shipped)                | `opportunity`/`latest` | `opportunityAnalysis.ts`     |
| Forecast     | client, pure math                | instant                            | none                   | `forecastUtils.ts`           |
| Home/advisor | backend `research()` + assembler | on **open if >24h stale** + manual | `advice`/`latest`      | new `homeAdvisorAnalysis.ts` |
| News         | backend `research()`, per asset  | **Stage 4** (dedicated phase)      | `news`/`<symbol>`      | new `newsAnalysis.ts`        |

**No backend cron in v1** — daily-fresh jobs run when the user **opens the relevant tab and the record is >24h old** (the daily-visit model) + a manual refresh. A server-side scheduler that pre-warms digests is a later phase.

### Buildable sub-stages

3.1 ✅ web search · 3.2 ✅ opportunity search (→ Proposals + the `profile` record). Then, in order:

- **3.4 — Multi-tab shell + country selector** _(foundation; template-only — no platform changes)._ Hash-routed tab shell (`<section>` per tab, a tab registry, shared ctx, progress stepper); move the existing calculator / profile form / top-picks into the Calculator / Profile / Proposals tabs verbatim. Country toggle writes `profile.country`; a template-side `COUNTRY_CONFIG` drives client-side filtering of the subscribed records + currency. `$`-prefix bug fixed. (Builds on the existing subscribe UI + `live-data.read`.)
- **3.5 — Portfolio multi-asset** _(single-currency v1)._ Generalize `holding` content + key; one-shot migration; Portfolio tab (live-price match where a `stock-quote` exists, single-currency totals, add/edit form, "I bought this" deep-link from Proposals). Imported-later holdings (3rd-party) land here unchanged.
- **3.6 — Forecast.** Extract `projectSeries` → pure `forecastUtils.ts` + `forecastConstants.ts` (per-risk default returns); Forecast tab (projection from portfolio value + monthly contribution + blended return; conservative/expected/optimistic; calculator-style fallback when empty). **Deterministic-only in v1** — an LLM assumption-sourcing/commentary layer is deferred (documented). Zero new backend.
- **3.7 — Generalize the analysis route to a named-job registry.** Backend `analysisJobs` registry `jobName → {buildRequest, toRecords→{type,key,content}}` + generic `POST /projects/:id/analysis/jobs/:jobName/run`; `opportunityAnalysis` becomes job `'opportunities'`; the specific route deleted (no shim). thefactory-ui: generic `analysis.run {jobName, params}` bridge op (replaces `analysis.run-opportunities`). Template: `bridge.runJob(jobName, params)`. Adding a job = one prompt module + one registry line.
- **3.8 — Start onboarding.** 3-question wizard (lump sum / monthly / risk + interests) → writes `profile` → runs Proposals → routes to Proposals mid-spinner; hides once matured. Extend `buildOpportunityRequest` to consume the new profile fields (drop the mirror fields in the same change).
- **3.9 — Home digest + advisor** _(the reframed 3.3)._ `homeAdvisorAnalysis.ts` (`buildAdvisorRequest(profile, holdings, latestOpportunity)`) registered as a job → `advice`/`latest`; a deterministic digest skeleton (portfolio delta, biggest mover, forecast headline) + LLM only for new opportunities / strategy improvements (diffed against held + already-proposed). Runs **on open if the `advice` record is >24h stale** + a manual refresh (no cron); becomes the default landing once matured. `home-meta`/`seen` powers a "what's new since last visit" diff.

### Stage 4 — News (a big dedicated phase, built last)

Daily LLM-curated news on the user's held assets — a feature large enough to stand alone; built after everything else. The design is a **hybrid**:

- **Discover-then-pull:** the first run has an agent find the best handful of outlets/sources for the user's assets + interests (stored as a `news-sources` record); subsequent refreshes only **pull the latest from those sources + run a small consolidation/digest pass** (cheap). Every few days a re-evaluation pass prunes/adds outlets.
- **Search-each-time** is the simple fallback for assets with no curated source list yet.
- **Social-media sweep** is desirable but **needs research** (build it ourselves vs. integrate a service) — out of scope until that research lands.

This phase is where a real **per-project cost ceiling** and likely a **backend scheduler** (pre-warm overnight) land — deferred to here, not the earlier stages.

### Generic (platform) vs template (forkable)

- **Generic, reused as-is:** DataStorage, LiveData sources/subscriptions, `AnalysisTools.research()`, the bridge transport + host-held credential. **The one new generic mechanism is the named-job analysis route/registry (3.7)** — tested in shared layers, free on all 3 clients.
- **Template / finance domain:** all record _shapes_ + `type` strings; the finance prompt modules (`opportunityAnalysis`/`homeAdvisorAnalysis`/`newsAnalysis`, pure + tested); the template-side `COUNTRY_CONFIG`; the tab registry + rendering; calculator + forecast math; the client-side country filtering.

### Decided (v1 scope) & deferred

**Decided:** country stored on the profile + app-side filtering (all subscriptions stay on); `opportunity` record type kept (label "Proposals"); **single-currency v1** (the user's country only); **no backend cron** — daily jobs refresh on-open-if-stale (24h) + manual; Home reads whatever proposals exist; Forecast deterministic-only; fixed 4 countries.

**Deferred to later phases (v2+), each on existing rails:**

- **Multi-currency / multi-country assets** + an FX feed (a declarative DataSource) — v2.
- **Stage 4 — News** (hybrid outlet-curation + the social-media research) — the last big phase.
- **`data.changed` push into the iframe** (instant cross-tab freshness; today: 60s poll + refresh-on-show) — a later stage.
- **Backend scheduler** pre-warming digests + a per-project daily cost ceiling — with Stage 4.
- **3rd-party integrations**, a **declarative-analysis-spec DSL**, **dynamic countries**, a **"browse another market" peek** — each triggered by a concrete need (see Non-goals).

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
- **No FX engine, "browse another market" peek, or authed/paginated live-data adapters yet** — each on existing rails when a concrete need triggers it.
