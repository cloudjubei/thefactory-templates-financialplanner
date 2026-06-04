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
| **News**       | `news`/`<asset>` (read)              | scheduled (daily) + on-demand `research()`, per asset |
| **Calculator** | none                                 | none (the existing calculator, moved here)            |
| **Home** (3.3) | reads all + `advice`/`latest`        | scheduled (daily) + on-demand advisor `research()`    |

**Default tab is derived from records** (never a stored onboarding flag): no profile + no holdings → **Start**; matured (profile + ≥1 holding) + Home enabled → **Home**; profile but no holdings → **Proposals**; else **Portfolio**. Start hides itself once matured (re-openable from Profile). Per-tab "done" is derived from record existence (drives a progress stepper). A **country toggle** at the top (= `profile.country`) swaps the live market the project is subscribed to + the app's currency (one country concept — the "company-stocks dropdown" is the same toggle re-subscribing).

### Data model (all project-scoped DataStorage; `{schemaVersion, …}` envelopes)

- **`profile`/`profile`** — `{country (ISO-2), currency (derived), lumpSum?, monthlyContribution?, riskAppetite, interests[], horizon='long'}`.
- **`holding`/`<assetClass>:<symbol-or-slug>[:account]`** — multi-asset: `{assetClass (stock|etf|fund|bond|crypto|cash|other), name, symbol?, quantity?, amountInvested, currency, currentValueManual?, account?, purchaseDate?}`. One-shot migration (gated by `planner-meta/migrated-holdings-v1`) rewrites the old stock-only `holding` records, then deletes them.
- **`opportunity`/`latest`** — kept as the record type (UI label "Proposals"); enriched items `{name, symbol?, assetClass?, whyItFits, whereAvailable?, expectedReturnPctRange?, currency?}`; the batch carries `country/currency/riskAppetite` so a country/risk change marks it stale (banner + re-run, never silent stale).
- **`news`/`<holding key>`** — one record per held asset, overwritten daily: `{generatedAt, asset, items: {headline, summary, url, sentiment?, date}[], sources}`. Removing a holding deletes its news record.
- **Forecast** — _no record;_ computed on read from `holding` + `profile` via a pure `forecastUtils.ts` (the extracted `projectSeries`). Optional `forecast-assumptions`/`assumptions` overrides risk-derived defaults.
- **`advice`/`latest`** (3.3) — `{generatedAt, country, currency, summary, actions[], newOpportunities: ProposalItem[]}` + a tiny `home-meta`/`seen` for the "what's new since last visit" diff.

### Country model (decided)

- A canonical **`COUNTRY_CONFIG`** (ISO-2 → `{label, currency, stockRecordType?}`) as a pure util in thefactory-tools; `liveDataSeed.ts` builds its Stooq sources _from_ it (seed + registry can't drift); the template learns it via a bridge op (no hand-maintained mirror). Keep `country→currency` and `country→marketCode` distinct (`GB`↔`uk`).
- A single host-side **`live-data.set-country`** bridge op owns the subscribe-swap (subscribe the new market _before_ unsubscribing others, so markets never blank) — policy in tested shared TS, not `app.js`.
- **Currency: country decides, records confirm.** On toggle, set `activeCurrency = COUNTRY_CONFIG[c].currency` synchronously (no USD flash); the record currency is then a consistency check. Fix the hard-coded `$` input prefixes (a real non-US bug).
- Countries with no seeded source stay fully usable (Profile/Proposals/News/Forecast/Calculator); the markets card shows "No live market seeded for {label} yet."

### Analysis jobs (all reuse the generic `research()` primitive)

| Job                | Where                            | Trigger                       | Record                 | Prompt module                |
| ------------------ | -------------------------------- | ----------------------------- | ---------------------- | ---------------------------- |
| Proposals          | backend `research()`             | on-demand (shipped)           | `opportunity`/`latest` | `opportunityAnalysis.ts`     |
| News               | backend `research()`, per asset  | scheduled (daily) + on-demand | `news`/`<symbol>`      | new `newsAnalysis.ts`        |
| Forecast           | client, pure math                | instant                       | none                   | `forecastUtils.ts`           |
| Home/advisor (3.3) | backend `research()` + assembler | scheduled (daily) + on-demand | `advice`/`latest`      | new `homeAdvisorAnalysis.ts` |

### Buildable sub-stages

3.1 ✅ web search · 3.2 ✅ opportunity search (→ Proposals + the `profile` record). Then, in order:

- **3.4 — Multi-tab shell + country selector** _(foundation)._ Hash-routed tab shell (`<section>` per tab, a tab registry, shared ctx, progress stepper); move the existing calculator / profile form / top-picks into the Calculator / Profile / Proposals tabs verbatim. `COUNTRY_CONFIG` util + tests; `liveDataSeed` rebuilt to derive from it. `live-data.set-country` (+ subscribe/unsubscribe/list-sources) bridge ops in thefactory-ui (tested; all 3 clients inherit). Country toggle swaps market + currency correctly; no mixed-currency totals; `$`-prefix bug fixed.
- **3.5 — Portfolio multi-asset.** Generalize `holding` content + key; one-shot migration; Portfolio tab (live-price match where a `stock-quote` exists, totals **grouped by currency**, add/edit form, "I bought this" deep-link from Proposals). Imported-later holdings (3rd-party) land here unchanged.
- **3.6 — Forecast.** Extract `projectSeries` → pure `forecastUtils.ts` + `forecastConstants.ts` (per-risk default returns); Forecast tab (projection from portfolio value + monthly contribution + blended return; conservative/expected/optimistic; calculator-style fallback when empty). Same-currency-only (stated). Zero new backend.
- **3.7 — Generalize the analysis route to a named-job registry** _(do before News)._ Backend `analysisJobs` registry `jobName → {buildRequest, toRecords→{type,key,content}}` + generic `POST /projects/:id/analysis/jobs/:jobName/run`; `opportunityAnalysis` becomes job `'opportunities'`; the specific route deleted (no shim). thefactory-ui: generic `analysis.run {jobName, params}` bridge op (replaces `analysis.run-opportunities`). Template: `bridge.runJob(jobName, params)`. Adding a job = one prompt module + one registry line.
- **3.8 — News daily job** _(first consumer of 3.7)._ `newsAnalysis.ts` (per-asset `buildNewsRequest` + `toNewsItems`); a `newsTick` in `server.ts` (6h tick, 24h freshness gate, held-only, skip-not-error on no config/key, re-entrancy guard, abort-on-close); on-demand refresh via the generic job route. News tab grouped by asset.
- **3.9 — Start onboarding** _(any time after 3.4)._ 3-question wizard (lump sum / monthly / risk + interests) → writes `profile` → runs Proposals → routes to Proposals mid-spinner; hides once matured. Extend `buildOpportunityRequest` to consume the new profile fields (drop the mirror fields in the same change).
- **3.3 → 3.10 — Home digest + advisor** _(3.3 reframed)._ `homeAdvisorAnalysis.ts` (`buildAdvisorRequest(profile, holdings, latestOpportunity, newsDigest)`) registered as a job → `advice`/`latest`; a deterministic digest skeleton (portfolio delta, biggest mover, top news, forecast headline) + LLM only for new opportunities / strategy improvements (diffed against held + already-proposed); a `homeTick` (24h freshness; projects with a profile + ≥1 holding); Home tab + `home-meta`/`seen` diff; becomes the default landing once matured.

### Generic (platform) vs template (forkable)

- **Generic, reused as-is:** DataStorage, LiveData sources/subscriptions, `AnalysisTools.research()`, the bridge transport + host-held credential. **New generic mechanisms:** the named-job analysis route/registry (3.7) and the `live-data.set-country`/subscribe/unsubscribe bridge ops (3.4) — tested in shared layers, free on all 3 clients.
- **Template / finance domain:** all record _shapes_ + `type` strings; the finance prompt modules (`opportunityAnalysis`/`newsAnalysis`/`homeAdvisorAnalysis`, pure + tested); `COUNTRY_CONFIG` + currency/market maps; the tab registry + rendering; calculator + forecast math.

### Open questions (decide before the affected stage; leans noted)

1. **Country op shape (3.4).** `live-data.set-country` (single host op owns the subscribe-swap). Lean: the app writes `profile.country` and the op only reconciles subscriptions.
2. **`opportunity` type kept (not renamed `proposal`).** Avoids migrating shipped user data; UI label is "Proposals" regardless. Confirm acceptable.
3. **FX / multi-currency totals (3.5/3.6).** No FX feed is seeded. v1 **groups totals by currency** (no silent cross-currency sum); an FX feed is a future declarative DataSource. Confirm grouping-only for v1, or is FX in scope now?
4. **News cadence + ceiling (3.8).** 6h tick / 24h freshness, held-only, low `searchLimit`. Add a hard per-project/day call ceiling? What's an acceptable spend per project/day?
5. **Scheduled-job project filter (3.8/3.10).** Lean: any project with a `profile` + ≥1 `holding` (data-driven) vs a template-id metadata tag.
6. **Home ordering (3.10).** Lean: Home reads whatever news exists (independent 24h freshness) vs chaining News→Home.
7. **Forecast LLM layer (3.6).** Lean: v1 deterministic-only (per-risk defaults); LLM assumption-sourcing/commentary deferred.
8. **`data.changed` push into the iframe.** Not in the bridge today; v1 uses 60s poll + refresh-on-show. A push is the clean follow-up for instant cross-tab freshness. Confirm acceptable for v1.
9. **Countries without a seeded source (3.4).** Lean: registry currency + empty markets card (fully usable) vs hiding them from the toggle.

**Dominant risk — cost.** Two daily ticks (News, Home) across all planner projects draw on the shared web-search key pool. Mitigation is structural: 24h per-record freshness (cost ∝ stale records, not tick rate), held-only News, low `searchLimit`, "return [] if nothing material," skip-not-error on missing config/key, optional per-project daily ceiling. News (`holdings × daily`) is the multiplier.

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
