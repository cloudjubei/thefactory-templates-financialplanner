# DataStorage + LiveData — implementation plan

A generic, cross-repo platform capability: give projects a real **storage** layer, then a **live-data** layer that fetches external data into it on a schedule, shares it across projects, and keeps history. First consumer is the investment-planner template, but nothing here is finance-specific — the same store holds car listings, furniture catalogs, game-competitor stats, anything.

Driven by the three blocked roadmap stories on the investment planner (live prices, opportunity search, portfolio advisor), re-architected away from "the agent fetches inside a story" into proper platform services surfaced in [LiveDataView](../../thefactory-overseer-web/src/ui/screens/LiveDataView.tsx).

This is platform infrastructure (core lives in [thefactory-tools](../../thefactory-tools) + [thefactory-db](../../thefactory-db)); it's planned from the template repo because the template is what drives + demonstrates it.

---

## The shape, in one paragraph

Two layers over one store. **`DataStorage`** (Stage 1) is a generic typed-record store — `{ scope, type, key, content }` keyed/unique by `(scope, type, key)` — with two interchangeable backends: DB (mapped onto the existing `entities` table) or a plain file store when there's no DB. It gives apps real internal storage (the planner persists the user's saved holdings; the car picker saves cars) — a gap nothing fills today. **`LiveData`** (Stage 2) sits on top: declarative **data sources** fetch external data into `DataStorage` on a schedule, **subscriptions** let many projects share one fetched dataset, and items carry inline **history**. LiveData needs the DB for sharing + query; DataStorage's file mode is the no-DB floor. **Analysis** (Stage 3) — opportunity search + portfolio advisor — is LLM work layered on what LiveData maintains.

---

## Data model (decided)

### The record

A `DataRecord` is `{ scope, type, key, content, metadata?, createdAt, updatedAt }`:

- **`scope`** — `<projectId>` for project-private data, or the sentinel `'__general__'` for shared/general data any subscribed project can read. (Maps to the `entities.project_id` column, which is already `text NOT NULL`; project ids and `'__general__'` coexist there.)
- **`type`** — free-form string (`stock-quote`, `car-listing`, `holding`, …). Callers invent types freely.
- **`key`** — the dedup key (e.g. `AAPL`). **Nullable**: `NULL` means "no dedup key, this is a one-off record" (authored entities); a set key means "the canonical row for this thing, upsert in place on refresh".
- **`content`** — arbitrary JSON.

### Entities-table change (the only schema modification)

In [thefactory-db](../../thefactory-db):

- Add nullable column `external_key text` to `entities`.
- Add `CREATE UNIQUE INDEX … ON entities (project_id, type, external_key)`. **Not partial** — Postgres treats `NULL` external_keys as distinct, so authored entities (no key) still duplicate freely while keyed live-data rows dedupe. This is the upsert target.
- DataStorage records default **`shouldEmbed: false`** — no point embedding price/listing rows; the vector index stays for genuine knowledge entities.

### Inline history + denormalized `latest`

A live item is **one row** keyed `(scope, type, key)` whose `content` carries its own time series:

```json
{ "symbol": "AAPL",
  "latest": { "t": "2026-05-31", "v": 187.2 },
  "history": [ { "t": "2026-05-30", "v": 185.1 }, { "t": "2026-05-31", "v": 187.2 } ] }
```

- `latest` **duplicates the last `history` entry** — denormalized on write so "current value" is a cheap read; full `history` is the slower read but is self-consistent (always includes `latest`). The write path must keep them in sync atomically (append point → set `latest` = that point).
- A **refresh** appends a point (it does not overwrite the row). Optional retention/cap on `history` length — see Open Questions.

---

## Capability ladder (decided)

- **No DB:** `DataStorage` works in **file mode** — app internal storage, project-scoped, basic. No search/vector, limited cross-project sharing.
- **DB present:** `DataStorage` maps onto `entities` — adds hybrid search, vector, scale. **`LiveData` requires this** (sharing + the subscription graph + cross-project reads need DB query). "Needs live data → needs a DB."

---

## Parity mandate (cross-repo)

- **Web is the source of truth.** Desktop ([overseer-local](../../overseer-local)) + mobile ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) mirror it 1:1; only rendering differs.
- **Core in [thefactory-tools](../../thefactory-tools); store schema in [thefactory-db](../../thefactory-db); backend is a thin adapter.** Shared client logic lives in [thefactory-ui](../../thefactory-ui) headless, never duplicated per client.
- **Every new logical `*.ts` in thefactory-db / thefactory-tools / thefactory-backend / thefactory-ui headless gets a co-located `*.test.ts`** (TDD). UI parts (`src/ui/`) stay untested.
- **`utils*.ts` pure / `helpers*.ts` for node-touching** (fs, db, network) — strict.

---

## Stage 1 — `DataStorage` (generic store, DB or file)

Self-contained and immediately useful: apps get internal storage, and the entities-reuse + file-fallback foundation is proven behind one interface before any live-fetch complexity.

### 1.1 thefactory-db

- Migration: add `external_key` + the unique index (above). Backfill is a no-op (column nullable).
- Extend `Entity` / `EntityInput` with `externalKey?`. Add an **`upsertEntity`** on the entity API that inserts or updates on conflict `(project_id, type, external_key)` and returns the row. Tests: insert-then-upsert updates in place; NULL-key inserts always create; embedding skipped when `shouldEmbed: false`.

### 1.2 thefactory-tools — the `dataStorage` toolset ✅

- `src/dataStorage/dataStorageTypes.ts` — `DataRecord`, `DataRecordInput`, `DataRecordRef`, `DataQuery`, `CreateDataStorageOptions`, and the `DataStorage` interface: `upsertRecord` (keyed upsert by `(scope,type,key)` or keyless insert), `readRecord`, `listRecords(query)`, `deleteRecord`. (Read methods are `read*`/`list*` per the repo verb convention — they touch I/O, so not `get*`.)
- `src/dataStorage/dataStorageConstants.ts` — `GENERAL_SCOPE = '__general__'`.
- `src/dataStorage/dataStorageTypeValidations.ts` — `assertDataRecordInput` / `assertDataRecordRef` (pure; shared by both backends).
- `src/storage/FileDataStorage.ts` — JSON store, one file per record under `<root>/<scope>/<type>/`. Path segments are base64url-encoded so caller-invented scopes/types/keys cannot escape the root. (Lives in `src/storage/` per the CODE_STANDARD `*Storage.ts` rule, not the toolset folder.)
- `src/storage/DbDataStorage.ts` — maps records onto `entities` via `upsertEntity`/`addEntity` + `matchEntities`; `shouldEmbed: false`. Tested against an in-memory fake entity api.
- No factory — clients instantiate the backend they want directly (`new DbDataStorage(db)` when a DB is configured, else `new FileDataStorage(root)`), mirroring how every other `*Storage` class in the repo is constructed.
- Re-exports: types via `src/types.ts`, constants via `src/constants.ts`, both storage classes via `src/index.ts`.

**Deferred to Stage 2:** `DataStorage.subscribe(handler)` — no Stage-1 consumer (the backend route emits `data:updated` itself after a write; LiveData is the real subscriber). Adding it now would be a speculative surface, and per the CODE_STANDARD storage classes do not own subscriber notification — it composes around them when Stage 2.1 needs change fan-out.

### 1.3 thefactory-backend ✅

- `src/routes/data.ts` — project-scoped CRUD over DataStorage. The route picks the backend per request (`dbService.isConfigured() ? new DbDataStorage(await dbService.getDb()) : new FileDataStorage(<overseerRepoPath>/.factory/data)`), so no new service/decoration was needed.
  - `GET /projects/:projectId/data?type=&key=` → `listRecords` (array).
  - `PUT /projects/:projectId/data` (body `{ type, key?, content, metadata? }`) → `upsertRecord`; emits `data:updated`.
  - `DELETE /projects/:projectId/data?type=&key=` → `deleteRecord` (idempotent 204; emits `data:updated` only on a real delete).
  - All bearer-authed (server-level hook); unknown project → 404 via `resolveProjectPath`. `scope` is the `:projectId` (general-scope sharing is a Stage 2 concern).
- Dedicated WS event `data:updated` (`{ action: 'upserted'|'deleted', scope, type, key }`) — not `entities:updated`, so file mode emits too.
- `src/schemas/data.ts` (`DataRecord` narrowed `content` like `Entity`); `DataRecord` promoted to a named OpenAPI component. Ran `sync-schemas` + `generate-swagger` — spec carries `listProjectData`/`putProjectData`/`deleteProjectData` + the `DataRecord` schema.
- Covered by `data.integration.test.ts` (13 tests: list/filter, keyed + keyless PUT, idempotent + broadcasting DELETE, 404, 401, 400, 500).

### 1.4 thefactory-ui — headless + `data.*` over the existing bridge ✅

- Regenerated the backend SDK (`generate:backend`) — `listProjectData`/`putProjectData`/`deleteProjectData` + the `DataRecord` type.
- `src/headless/api/projectData.ts` — imperative SDK wrappers (`queryProjectData`/`putProjectDataRecord`/`deleteProjectDataRecord`) + the pure `dispatchProjectDataBridge(projectId, req)` that maps `overseer:data.query|put|delete` → those wrappers (returns `undefined` for non-`data.*` so the host can compose other handlers; validates payloads). Co-located test (12 cases).
- `useProjectData(projectId)` — imperative `{ query, put, remove }` hook over the wrappers.
- `useProjectDataBridge(projectId)` — returns the `onBridgeMessage` handler built from `dispatchProjectDataBridge`. Wired into the web `ProjectAppTab` (`onBridgeMessage={useProjectDataBridge(projectId)}`); the **write credential stays in the host**.
- Exported all of the above from the `thefactory-ui/headless` barrel.

**Deferred:** the reactive `useProjectData` *provider* (cached record list + `data:updated` WS refetch, matching `TemplatesContext`) — no Stage-1 Overseer-native renderer consumes a project-data list (the template app renders its own records inside the iframe via the bridge). Add it when a native data view lands (Stage 2 `LiveDataView`). For now `useProjectData` is the imperative method surface only.

### 1.5 Template (investment planner) ✅

- [bridge.js](../bridge.js) — client half of the App↔Overseer bridge: `window.OverseerBridge.{queryData,putData,deleteData}` post `overseer:data.*` requests to the host and await the correlated response. `embedded` is false when opened standalone (not in an iframe).
- [app.js](../app.js) — a `holdingsStore` over the bridge when embedded (records of type `holding`, keyed by symbol; reads `record.content`) and over `localStorage` standalone. The holdings table reads from the store on load, with an **Add holding** form (`overseer:data.put`) and per-row remove (`overseer:data.delete`); user input is HTML-escaped before render.
- [data/sample-holdings.json](../data/sample-holdings.json) is now the **seed**, not the truth: seeded once on first run (guarded by a `planner-meta/seeded` marker so clearing every holding never re-adds defaults).
- This demonstrates "apps have internal storage" end-to-end with zero live-fetch.

### 1.6 Parity + quality

- Desktop + mobile inherit the bridge via the shared `ProjectAppView`; verify the message channel on each.
- Quality bar: co-located tests for every new logical file; `utils`/`helpers` split honored; no `any` at the API boundary.

---

## Stage 2 — `LiveData` (sources, subscriptions, history; DB-required)

### 2.1 thefactory-tools — the `liveData` toolset

- Types: `DataSource { id, name, entityType, freshness, autoUpdate, adapter }` where `adapter = { fetch: { url, method?, headers?, auth? }, itemsPath, map: { key, content } }` — a **declarative** spec (no code execution). `DataSubscription { projectId, sourceId }`.
- `LiveDataTools`: CRUD sources, `subscribe(projectId, sourceId)` / `unsubscribe` / `listSubscriptions`, `refresh(sourceId)`, `listSources`. Change fan-out via the DataStorage subscribe.
- **Generic adapter runner** — interprets `adapter`: fetch → walk `itemsPath` → for each record produce `{ key, content }` → **append-with-history** into DataStorage (append point, set `latest`). One runner, all domains.
- History append helper (keeps `latest` == last point; applies retention cap).
- DataSource + DataSubscription stored in dedicated control-plane tables (clean separation from the data plane). Confirm vs. modeling-as-entities in 2.1.

### 2.2 thefactory-backend

- Routes for sources + subscriptions + manual `refresh`; a scheduler tick (mirroring the existing `liveDataScheduler`) refreshing stale sources by `freshness`. WS on source status + `data:updated`.
- **App read of subscribed live data:** `GET /api/v1/projects/:id/live-data` (view-token auth) → resolve the project's subscriptions → return the records from subscribed sources for the iframe.
- **Absorb the existing file-based `LiveData`** (`liveDataService`/`liveDataExecutors`/`liveDataScheduler`): `LiveDataProvider` → `DataSource`, `http`/`static` executors → the adapter runner, single-blob payload → records, global/project scope → subscriptions. Re-point everything; delete the superseded paths (no parallel system, no back-compat shim).

### 2.3 thefactory-ui + clients

- Evolve `LiveDataProvidersContext` + [LiveDataView](../../thefactory-overseer-web/src/ui/screens/LiveDataView.tsx) to show **sources + the subscription graph** (which projects pull which data), freshness, manual "Update now", and a peek at the records. Web first; desktop + mobile mirror.

### 2.4 Template

- Holdings tracker shows **live prices** for the user's holdings from a subscribed source; add a small **sector watchlist** (general-scope data shared across projects).
- Pre-seed showcase `DataSource` specs for **US / UK / Germany / Poland** basic stock prices, plus a story "Set your country / data region" the agent runs to find a provider + author the adapter for a new country.

---

## Stage 3 — Analysis services (outline; built later)

- **Web search as a backend service** — lift [WebTools](../../thefactory-tools/src/web/WebTools.ts) (Exa/Tavily/SerpAPI) out of agent-only into a backend-invocable service so an executor can call it.
- **Opportunity search (#2)** — a source/executor that takes the user's profile (country, budget, preferences — stored via DataStorage) → web search + an LLM analysis pass (`CompletionTools.sendCompletion`, structured output) → opportunity records → presented in the app.
- **Portfolio advisor (#3)** — scheduled; combines the user's live holdings + an opportunity scan + richer LLM analysis (promos, news, portfolio fit) → advice records.

---

## Open questions / decisions deferred to their stage

- **History retention** — cap length? downsample old points? (Stage 2.)
- **Adapter `map` grammar** — simple field paths vs. a small expression language for `itemsPath`/`map`. Start with dotted paths; escalate only if a showcase needs it. (Stage 2.)
- **DataSource/DataSubscription: dedicated tables vs. entities** — recommended dedicated control-plane tables; confirm at Stage 2.1.
- **App-write security** — Stage 1 routes writes through the postMessage bridge (no credential in the iframe). Confirm that over a token-authed write endpoint.
- **`data:updated` vs reuse `entities:updated`** — lean a dedicated event so file-mode (no entities) emits too. (Stage 1.3.)
- **Profile inputs + presentation for #2/#3** — country/budget/preferences storage + input UI. (Stage 3.)

---

## Non-goals

- No bespoke per-domain tables (market_data, cars, …). Everything is `DataStorage` over `entities` (or file).
- No code-execution adapters. Adapters are declarative config the LLM authors in a story.
- No non-DB `LiveData`. File mode is `DataStorage`-only (app internal storage); live feeds + sharing require the DB.
- No parallel live-data system. Stage 2 absorbs and replaces the existing file-based one.
