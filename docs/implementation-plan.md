# Implementation plan

Forward-looking plan for the Investment Planner template. How the shipped app works (platform, data model,
analysis jobs, currency, conventions) lives in [ARCHITECTURE.md](./ARCHITECTURE.md) — read that first.

**Where things stand:** the template platform, the DataStorage + LiveData foundation, and the analysis layer
(Proposals, Home advisor, Investigations, News, per-asset info) are shipped, with multi-currency portfolios and
country-tailored analysis. The one remaining roadmap item is **Learn**.

Build per the invariants in [ARCHITECTURE.md](./ARCHITECTURE.md#invariants); broader template concept in
[overseer-local/docs/expansion/05-example-projects.md](../../overseer-local/docs/expansion/05-example-projects.md).

---

## Next: Learn / newbie education mode

A guided **"newbie mode"** that teaches the user about investing — asset classes, what's actually possible, and
plain-English explanations of basic terms — so a beginner uses the planner confidently. A phase in its own right.

- A **Learn** tab with curated lessons + LLM-explained-terms-on-demand.
- A `profile` beginner flag that softens tone and surfaces inline explainers across the other tabs; the Stage 6
  structured preferences (`profile.productTypes`) decide how much hand-holding to show.
- **Open question:** how much of the beginner flag drives inline explainers across tabs vs. a dedicated Learn tab.

---

## Deferred refinements (each names its trigger)

Each sits on existing rails; build when its trigger fires.

- **`data.changed` push into the iframe.** Long jobs outlive the bridge request; today the app re-reads the
  record after `runJob` settles + badges the tab. The cleaner version forwards the host's `data:updated` WS event
  into the iframe as an `overseer:data.changed` event so the app re-renders the moment a record lands (a generic
  change in `ProjectAppView` + the bridge). **Trigger:** a job whose completion the re-read pattern can't catch
  (a record written with no originating bridge call), or background pre-warming.
- **News: discover-then-pull.** News currently search-each-time per held asset. A first pass could curate the best
  outlets for the user's assets + interests into a `news-sources` record; later refreshes pull from those + a
  cheap digest pass, with periodic re-evaluation. **Trigger:** per-asset search cost becomes the bottleneck.
- **Backend scheduler + per-project cost ceiling.** Pre-warm digests/news overnight instead of on-open, with a
  daily spend cap. **Trigger:** users want fresh results without opening the tab (also unlocks the `data.changed`
  push and motivates the cost ceiling).
- **News: social-media sweep.** Desirable but **needs research** (build vs. integrate a service) — out of scope
  until that research lands.
- **Sectors / ethics weighting** — a v2 extension of `profile.productTypes` so proposals weight by sector/values.
  **Trigger:** users ask to steer by theme, not just asset class.

---

## Backlog — template platform

Integration seams the platform can grow into; each names its build trigger.

- **`manifest.json` native rendering** — Overseer reads `.factory/template/manifest.json` and renders declared
  `{ menuEntries?, theme?, defaultChats? }` natively. **Trigger:** a template declares any of these and a
  contributor adds the host renderer.
- **App writes to repo source files (`overseer:writeFile`)** — the app editing its own version-controlled source
  via the bearer file routes (distinct from app _data_, which is DataStorage). **Trigger:** an app surface needs
  to mutate repo files at runtime.
- **"Native app template" kind** — a template shipping a React tree using thefactory-ui's web+native peers,
  imported by the host directly (no iframe). **Trigger:** a product decision to offer a second template kind.
- **Per-project dev server (framework templates)** — when a template ships a `dev` script, the backend spawns it
  lazily on first App-tab open and reverse-proxies `/view/*` to it. **Trigger:** the first template that needs a
  build pipeline.
- **Hosted-repo conversion** — a project-settings affordance converting a local-only project to GitHub-backed
  (wraps `POST /projects/github/create-repo` + remote/push). **Trigger:** a user wants their project pushed from
  inside Overseer.
- **3rd-party portfolio integrations** (bank / brokerage import) — credential type → OAuth flow → backend
  importer writing `holding` records → `integration.connect`/`import` bridge ops. **Trigger:** the first
  brokerage/aggregator OAuth credential type in
  [credentialTypes.ts](../../thefactory-tools/src/credentials/credentialTypes.ts). Keep `holding` the single
  portfolio source of truth + the connect affordance hidden when standalone.
- **Subsequent templates** — board game, book writing, car-buyer helper, interior planner (per
  [the expansion doc](../../overseer-local/docs/expansion/05-example-projects.md)). The plumbing is proven with
  one; add the next when prioritised.

---

## Non-goals (name the trigger to revisit)

**Template platform**

- No `template.json` / `scaffold/` machinery in thefactory-tools — templates are full repos, no loader.
- No dynamic catalog endpoint fetching a remote registry — hard-coded const only.
- No post-clone tweaks beyond install-layout + `git init` + single commit.
- No auth-bypass on `/view/*` — the signed-token paths (query / cookie / Referer) are the only non-bearer entry.

**Data / analysis**

- No bespoke per-domain tables; no code-execution live-data adapters; no non-DB analysis.
- No **declarative-analysis-spec DSL** — the named-job registry is enough. **Trigger:** a _second_ domain needs
  analysis jobs.
- No **dynamic countries** — fixed to the four seeded markets. _(If it ever changes: promote `COUNTRY_CONFIG` to
  a thefactory-tools util and have `liveDataSeed` derive its sources from it.)_
- No **"browse another market" peek** or authed/paginated live-data adapters — each on existing rails when a
  concrete need triggers it. (FX is a declarative `fx-rate` source — no bespoke engine.)
