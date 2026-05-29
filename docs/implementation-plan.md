# Implementation plan

The first Overseer project template: a working investment-planning web app users fork into a new project and personalise via stories. This plan covers (1) the content of **this** repo and (2) the cross-repo work needed to make "create from template → see it run → run the first agentic feature" land end-to-end on web first, then desktop and mobile.

Source for the broader template concept: [overseer-local/docs/expansion/05-example-projects.md](../../overseer-local/docs/expansion/05-example-projects.md). Reference implementation plans for format: [thefactory-tools/docs/implementation-plan.md](../../thefactory-tools/docs/implementation-plan.md), [thefactory-backend/docs/implementation-plan.md](../../thefactory-backend/docs/implementation-plan.md), [thefactory-ui/docs/implementation-plan.md](../../thefactory-ui/docs/implementation-plan.md).

---

## What a template is, in one paragraph

An Overseer template is **a full upstream git repo that already runs**. "Create from template" forks the repo into a new project with a clean git history (the template is the very first commit) and registers it as a normal Overseer project. The user opens it, navigates to the **App** tab inside Overseer, and sees the project's UI rendered as a first-class surface of the host app. The repo ships with `.factory/stories/` already populated so at least one story+feature is sitting in `pending`, sized to complete in seconds with a configured CLI/LLM. Subsequent stories sculpt the working app into the user's own product.

The project's app surface is rendered via a streamed HTML/CSS/JS document — iframe on web, Electron `<webview>` on desktop, `<WebView>` on mobile. This pipe is what gives the same project the same look on every client and lets the project be extracted standalone (just open `index.html`). Integration with Overseer rides on two seams: a declarative [`.factory/manifest.json`](#b2-factory-seed-content) for things Overseer renders natively (nav items, theme overrides — designed, not built in v1) and a runtime `postMessage` bridge for things the project asks Overseer to do (navigation, toasts, modals, file writes via the host's auth — designed, not built in v1).

---

## Parity mandate (cross-repo)

- **Web ships first.** Desktop ([overseer-local](../../overseer-local)) and mobile ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) mirror once web is verified end-to-end on a real CLI run.
- **App-view transport is one HTTP route.** `GET /api/v1/projects/:id/view/*` on the backend serves files from the project checkout; web (`<iframe>`), desktop (Electron `<webview>`), and mobile (`<WebView>`) all point at the same URL. One transport, one component shape.
- **`ProjectAppView` shell lives in [thefactory-ui](../../thefactory-ui)** (`src/web/` + `src/native/` peers, headless `useProjectAppView` for the URL + refresh state). No client duplicates the chrome.
- **Every new logical `*.ts` in thefactory-tools / thefactory-backend / thefactory-ui headless gets a co-located `*.test.ts`.** Frontend UI (`src/ui/`) parts stay untested.

---

## A. Open questions / blocked

Engineering decisions waiting on a call; future template stories blocked on external triggers. Items here are **not** ready to execute — move into the relevant lettered section once the trigger fires.

### Engineering decisions still TBD

_None._ All engineering decisions for v1 are settled (below) or deferred with a named trigger (further below).

### Decided

- **Catalog location.** Lives in [thefactory-backend](../../thefactory-backend) as a hard-coded constant alongside the route — see §C.1. No [thefactory-tools](../../thefactory-tools) surface in v1; revisit only when a CLI or non-backend consumer needs the catalog.
- **App-view auth.** Signed short-lived token in a query param. The web/desktop/mobile client requests `POST /api/v1/projects/:id/view/grant` (bearer-protected) and receives `{ token, expiresAt }` with a JWT-or-opaque token signed by `ENCRYPTION_KEY` carrying `{ projectId, exp }` claims. The `view/*` route accepts either bearer **or** a valid `viewToken` query param; tokens are project-scoped, read-only, ~15-min TTL, auto-refreshed by `useProjectAppView`. Picked over a cookie-session (cross-origin pain on web; flaky WebView cookie persistence on mobile) and over same-origin reuse (depends on production-hosting decisions not yet made). All real writes still flow through the bearer-protected file routes via the postMessage bridge — see §A "deferred integration seams".
- **App-view rendering model.** Streamed HTML/CSS/JS document via iframe/WebView is the v1 default. The alternatives (true plugin/module-loading into the host runtime, declarative manifest interpreter, Module Federation) were weighed and rejected as the **main app surface**: each either breaks parity on mobile, forces a tech-stack choice on the template author, or undermines the standalone-extractability of the project. The declarative model survives in a constrained, principled place — `.factory/manifest.json` for *integration metadata only* (nav items, theme overrides) — and a "Native app template" kind (uses thefactory-ui primitives, accepts the tech-stack lock-in for tighter integration) is on the future menu but not in v1.
- **App-view root directory.** v1 serves source files directly from the project checkout root (`index.html` at the top). No build step, no dev server, no `dist/` directory. Templates are no-build until proven otherwise — keeps the template author free of CI requirements and keeps every change instantly visible. Framework-requiring templates get the dev-server treatment (see §A "Deferred integration seams").
- **`.factory/project.json` is canonical; user customizations route to `overrides`.** The template's `.factory/project.json` is the shared truth for the forked project (`title`, `description`, `codeInfo`, `scopeGroupIds`). The `from-template` route reads it after clone and passes those values straight through to `projectTools.createProject` — net effect: project.json on disk matches the template's. Per-client customizations (a user renaming their copy "Bills tracker") go into `registry.overrides` via the existing project-edit path, which [`applyProjectOverrides`](../../thefactory-tools/src/project/ProjectTools.ts#L27-L30) merges on read. This supports the multi-dev-shares-one-project model without polluting the canonical config. The wizard does **not** collect title/description at create time for from-template (see §E.1).
- **From-template is local-only in v1.** `repo_url: ''`. No "Create hosted repo" branch or button in the wizard. The underlying primitive (`POST /api/v1/projects/github/create-repo`) already exists; the conversion UI lands later (see §A "Deferred integration seams").

### Deferred integration seams (designed for v1.5, not built in v1)

These are documented now so the v1 shapes don't paint us into a corner. None of them ship with the financial-planner template.

- **`postMessage` bridge between the embedded module and Overseer.** Single protocol with an `overseer:` prefix. Module → Overseer: `overseer:ready`, `overseer:setTitle`, `overseer:navigate`, `overseer:toast`, `overseer:openModal`, `overseer:writeFile` (routes through the bearer-protected file API). Overseer → Module: `overseer:theme` (design tokens), `overseer:user`, `overseer:files:changed`. Handshake owned by the `ProjectAppView` wrapper. Modules that ignore the bridge still work as plain iframes. Trigger to build: a template wants any of these (e.g. the project needs to mutate its own data files at runtime).
- **`.factory/manifest.json` native-integration rendering.** Overseer reads the manifest at project-load time and renders the declared customizations *natively* (not inside the iframe). Initial shape: `{ menuEntries?: [...], theme?: {...}, defaultChats?: [...] }`. v1 ships an empty manifest file; Overseer ignores its contents. Trigger to build: a template's manifest declares any of these and a contributor adds the host-side renderer.
- **Project data writes via Overseer's file API.** The project's mutable state (e.g. holdings, settings) lives as JSON files in the repo, edited through Overseer's existing bearer-protected file routes via the `overseer:writeFile` bridge. Data is automatically version-controlled, synced, and visible to the agent in stories. v1 template seed JSONs are read-only at the iframe level (agent edits them through stories); the bridge isn't shipped. Trigger to build: any project surface needs to persist user-entered data without a story.
- **"Native app template" kind.** A future class of template that ships a React component tree using [thefactory-ui](../../thefactory-ui)'s `web/` + `native/` peers and gets imported by the host directly (no iframe). Tradeoffs: tighter visual integration vs. tech-stack lock-in and a host-runtime security model. Not in v1; logged here so the dual-template-kind possibility is visible.
- **Per-project dev server for framework-requiring templates.** When a template ships a `package.json` with a `dev` script, the backend spawns it lazily on first App-tab open (`npm install && npm run dev`), reverse-proxies `/api/v1/projects/:id/view/*` through to the dev server's port, and shuts it down after an idle timeout (e.g. ~10 min with no App-tab subscribers). HMR rides on the dev server's own ws (Vite by default); the existing `files:changed` event coexists. Clean-rebuild trigger = the agent's commit/pull mutates `package*.json` or fires an explicit signal → backend kills + respawns the dev server. This is what gives framework templates the "trivial change → sub-second visible" UX without ever requiring CI or a shipped `dist/`. Trigger to build: the first template lands that needs a build pipeline.
- **Hosted-repo conversion from a local-only project.** UI affordance in project settings ("Create a hosted repo for this project") that wraps the existing `POST /api/v1/projects/github/create-repo` endpoint plus the git steps (`git remote add origin <url>` + `git push -u origin main`). Trigger to build: the user wants their first project pushed to GitHub from inside Overseer (most likely right after v1 ships and they want to back up their work).

### Future template stories (blocked)

These ship as `?` (blocked) stories inside this repo's `.factory/stories/` so the user sees the roadmap, but they cannot run until the named trigger fires. **Do not** flip them to `-` (pending) preemptively.

- **Live price fetching for the holdings tracker.** Trigger: a price-data integration tool ships in thefactory-tools (or a no-auth web fetch surface is exposed to the agent). Until then, holdings show static cost basis + mock current value.
- **LLM-powered web search for "Top picks".** Trigger: the web-search tool is exposed in `ALL_CHAT_AGENT_TOOLS` and `DEFAULT_AVAILABLE_TOOLS` in [thefactory-tools/src/chats/chatsConstants.ts](../../thefactory-tools/src/chats/chatsConstants.ts). Today the panel is populated only by the agent rewriting `data/top-picks.json` from the user's stated focus (Story 1 in §B.3 — no external lookup).
- **Periodic scouring of new opportunities.** Trigger: a scheduler/cron tool lands for agent runs. Until then, refresh is on-demand via the user kicking off a story.
- **Broker / brokerage-API connections (Vanguard, Schwab, IBKR, etc.).** Trigger: an OAuth credential type for brokerage APIs lands in [thefactory-tools/src/credentials/credentialTypes.ts](../../thefactory-tools/src/credentials/credentialTypes.ts).

### Subsequent templates

Board game, book writing, car buyer helper, interior planner — all named in [overseer-local/docs/expansion/05-example-projects.md](../../overseer-local/docs/expansion/05-example-projects.md). Out of scope until v1 ships end-to-end with this one template.

---

## B. This repo — the investment-planner template

The repo is a plain static web app plus a seeded `.factory/` tree. Standalone-runnable via `python3 -m http.server` (no build, no deps) so the template can be developed and verified outside Overseer.

### B.1 App content (root)

- [index.html](../index.html) — single page with three sections: hero/welcome heading, investment calculator (compound interest), holdings tracker, top-picks panel. Loads Chart.js via CDN. No build step.
- [style.css](../style.css) — minimal layout, light theme, mobile-friendly single-column at <640px.
- [app.js](../app.js) — vanilla JS. Fetches the three JSON files from `data/`, renders sections, wires calculator inputs (principal, monthly contribution, expected annual return %, years) to a Chart.js projection chart. No frameworks.
- [data/config.json](../data/config.json) — `{ "investmentDomain": "", "welcomeHeading": "Investing made yours" }`. The first agentic feature edits these.
- [data/sample-holdings.json](../data/sample-holdings.json) — 3 generic ETF entries (e.g. VOO / VTI / BND) with `symbol`, `name`, `quantity`, `costBasis`, `currentValue`. Static values; "live prices" is a future story.
- [data/top-picks.json](../data/top-picks.json) — `[]` empty by design; the placeholder text in `index.html` reads "✨ Personalize via the first story". The first feature populates this.
- [README.md](../README.md) — rewrite from the placeholder: what the template is, how to preview it locally (one paragraph), pointer to this plan. Keep under 50 lines.
- [.gitignore](../.gitignore) — `.DS_Store`, `node_modules/` (not used today but future-proof), `dist/`, `*.log`.
- LICENSE — keep as-is (already shipped).

### B.2 `.factory/` seed content

On-disk format mirrors the existing in-project layout used by [overseer-local/.factory/](../../overseer-local/.factory/) (flat: `project.json` + `stories/<uuid>.json` + `stories/order.json`).

- `.factory/project.json` — `{ title, description, repo_url: "", scopeGroupIds: [], createdAt, updatedAt }`. This is the project's **canonical** config (per §A → Decided). The `from-template` route reads it post-clone and passes its values through to `createProject` (project.json on disk effectively unchanged); user customizations later route to `registry.overrides`, not back here.
- `.factory/manifest.json` — `{}`. Empty by design in v1. The file's *presence* establishes the convention so future template versions can declare `menuEntries`, `theme`, `defaultChats`, etc. (per §A → Deferred integration seams). Overseer ignores its contents until the host-side renderer ships.
- `.factory/stories/order.json` — object form `{ ids: [storyId1, ...], updatedAt }` (new format; the read-side migration handles legacy flat-array). Lists Story 1 first, then the three blocked roadmap stories.
- `.factory/stories/<uuid>.json` — one file per story. Story shape per [thefactory-tools/src/story/storyTypes.ts](../../thefactory-tools/src/story/storyTypes.ts) (`Story` / `Feature`). Include the `featureIdToDisplayIndex` map alongside `features` to match the on-disk precedent.

### B.3 Story 1 — Tailor to your investment focus (the "first runnable" feature)

Status: `-` (pending). Has exactly one feature, sized to complete in seconds.

- **Feature: Personalize for your investment domain.** Status `-`. The agent:
  1. Asks the user (or reads from a chat-provided value) what their investment focus is — e.g. "tech ETFs", "dividend stocks", "renewable energy".
  2. Edits [data/config.json](../data/config.json): set `investmentDomain` and rewrite `welcomeHeading` to include it.
  3. Edits [data/top-picks.json](../data/top-picks.json): three plausible mock entries appropriate to the domain (no external lookup — agent-authored from its own knowledge).
  4. Edits [data/sample-holdings.json](../data/sample-holdings.json): three plausible holdings in that domain.
- `context`: `data/config.json`, `data/sample-holdings.json`, `data/top-picks.json`, `app.js`, `index.html`.
- `acceptance`: loading the App tab in Overseer shows the welcome heading mentioning the chosen domain; tracker rows and top-picks reflect that domain.

### B.4 Stories 2–4 — roadmap stubs (status `?`)

One file each. Status `?` (blocked). `blockers` array names the external trigger from §A. Description explains what the feature will do when unblocked. The user sees them in the stories list as roadmap; they cannot run until unblocked.

- Story 2 — *Live price fetching for the holdings tracker.* Blocker: price-data tool.
- Story 3 — *LLM-powered web search for Top Picks.* Blocker: web-search tool exposed to the agent.
- Story 4 — *Periodic scouring of new investment opportunities.* Blocker: agent scheduler.

### B.5 Verification

- Open [index.html](../index.html) directly in a browser → all three sections render with the seeded data; calculator chart updates as inputs change.
- Run `python3 -m http.server` from the repo root → same, served over HTTP (closer to how the backend will serve it).
- Static-validate the four JSON files in `.factory/` parse as `Story` / `StoryOrderRecord` / `ProjectConfig`.

---

## C. thefactory-backend — catalog + from-template + app-view transport

All v1 server-side work lives here. No [thefactory-tools](../../thefactory-tools) changes (per §A → Decided: Catalog location).

### C.1 Catalog — type + hard-coded constant + `GET /api/v1/templates`

New files in [thefactory-backend](../../thefactory-backend):

- [src/templates/templateTypes.ts](../../thefactory-backend/src/templates/templateTypes.ts) — the public type:

  ```ts
  export interface Template {
    id: string
    name: string
    description: string
    repoUrl: string
    thumbnailUrl?: string
  }
  ```

- [src/templates/templatesConstants.ts](../../thefactory-backend/src/templates/templatesConstants.ts) — the catalog:

  ```ts
  export const TEMPLATES: readonly Template[] = [
    {
      id: 'investment-planner',
      name: 'Investment Planner',
      description: 'A working investment planner you sculpt into your own — calculator, holdings tracker, and personalised top picks.',
      repoUrl: 'https://github.com/cloudjubei/thefactory-templates-financialplanner',
      // thumbnailUrl: optional; deferred until the picker UI is in place
    },
  ] as const
  ```

- [src/routes/templates.ts](../../thefactory-backend/src/routes/templates.ts) — `GET /api/v1/templates` (operation `listTemplates`). Returns `{ templates: Template[] }`; same `BEARER_TOKEN` policy as the rest of `/api/v1/*`.

Tests:

- [src/templates/templatesConstants.test.ts](../../thefactory-backend/src/templates/templatesConstants.test.ts) — `TEMPLATES` has ≥1 entry; every entry has non-empty `id`/`name`/`description`/`repoUrl`; `id`s unique; `repoUrl` matches the `https://github.com/.../...` shape (regex, no network).
- [src/routes/templates.integration.test.ts](../../thefactory-backend/src/routes/templates.integration.test.ts) — 200 + payload shape; 401 without bearer.

Per the [direct-tests-per-file rule](../../.claude/projects/-Users-cloud-Documents-Work-thefactory-tools/memory/feedback_direct_tests_per_file.md), the pure type file doesn't need its own test.

### C.2 `POST /api/v1/projects/from-template` (operation `createProjectFromTemplate`)

New handler in [thefactory-backend/src/routes/projects.ts](../../thefactory-backend/src/routes/projects.ts).

Body: `{ templateId: string, id: string, path: string, mainGroupId?: string }`. **No `title` / `description` / `repo_url`** — the template's `.factory/project.json` is canonical (per §A "Decided"); `repo_url` is forced to `''` (per §A "Decided — From-template is local-only").

Logic:

1. Resolve `templateId` against `TEMPLATES`; 404 if absent.
2. `projectCheckoutService.cloneIntoCheckout(body.path, template.repoUrl)` — same primitive as the existing `kind: 'clone'` checkout path at [projects.ts:518](../../thefactory-backend/src/routes/projects.ts#L518).
3. **Wipe git history.** Inside the cloned dir: `rm -rf .git`, then `git init`, `git add .`, `git commit -m "Initialize from <template.name> template"`. New helper `projectCheckoutService.reinitWithSingleCommit(path, message)`; co-located test.
4. **Read the cloned `.factory/project.json`** → `templateConfig: ProjectConfig`. Fail with a clear 422 if the file is missing or doesn't validate (template authoring bug; surface loudly rather than papering over).
5. Call `projectTools.createProject({ id: body.id, path: body.path, title: templateConfig.title, description: templateConfig.description, repo_url: '', codeInfo: templateConfig.codeInfo, scopeGroupIds: templateConfig.scopeGroupIds ?? [], mainGroupId: body.mainGroupId, overrides: {} })`. Net effect: project.json on disk matches the template's; registry.json gets a fresh entry for this client with no overrides yet.
6. **Skip `buildSeedFiles`** entirely — the template ships its own README and `.factory/` content; the existing seed (README.md + `.factory/stories/.gitkeep`) would clobber it.
7. Return the resulting `ProjectSpec` (with `applyProjectOverrides` already applied).

Integration test in `projects.integration.test.ts` (a sibling of the existing `kind=clone` test at [projects.integration.test.ts:647](../../thefactory-backend/src/routes/projects.integration.test.ts#L647)):
- Mock `cloneIntoCheckout` + `reinitWithSingleCommit` + a fixture `.factory/project.json` read + `createProject`. Assert the call sequence; assert `createProject` receives the template's title/description (not the request body's); assert `repo_url: ''`.
- 404 when `templateId` is unknown.
- 422 when the cloned `.factory/project.json` is missing or malformed.
- 409 when checkout path is already a git repo (reuse the existing `CheckoutAlreadyGitRepoError` translation).

### C.3 `GET /api/v1/projects/:id/view/*` (operation `viewProjectFile`)

New handler in [thefactory-backend/src/routes/files.ts](../../thefactory-backend/src/routes/files.ts) (sibling of the existing `GET /projects/:projectId/files/raw`).

- Resolves `:id` via `projectCheckoutService.getCheckoutPath`; 404 if none.
- Wildcard segment is the relative path inside the checkout. Default to `index.html` when empty.
- **Path safety:** resolve the request path, then reject any final path that escapes the checkout dir (no `..` traversal). Co-located test.
- Streams the file with the correct `Content-Type` from a small extension map (`.html`, `.css`, `.js`, `.mjs`, `.json`, `.png`, `.jpg`, `.svg`, `.woff2`); `application/octet-stream` fallback. Set `Cache-Control: no-store` so the App view reflects the latest agent edits without manual refresh of the iframe wrapper.
- Auth: accept either `Authorization: Bearer <BEARER_TOKEN>` **or** a `viewToken` query param signed via `ENCRYPTION_KEY` and carrying `{ projectId, exp }` claims (per §A → Decided: App-view auth). New sibling route `POST /api/v1/projects/:id/view/grant` (operation `grantProjectAppViewToken`, bearer-protected) returns `{ token, expiresAt }` with a 15-minute TTL. Co-located tests for token mint + verify; route tests for bearer path, valid-token path, expired-token rejection, wrong-project rejection.

Integration test in [thefactory-backend/src/routes/files.integration.test.ts](../../thefactory-backend/src/routes/files.integration.test.ts) (or a new sibling): 200 on `index.html`, sibling CSS/JS, 404 on missing file, 403 on `..` traversal attempts.

### C.4 Schema sync + WS events

- After §C.1–C.3 land, run `npm run sync-schemas` so `src/generated/upstream.ts` flows into [thefactory-ui/headless/api/generated](../../thefactory-ui/headless/api/generated). The `Template` type reaches every FE client through the generated SDK.
- **No new WS event for the App view.** "Live App-view updating as the agent writes files" (`files:changed` already broadcasts) is fielded entirely client-side via `<iframe>` refresh on relevant `files:changed` updates — no backend change.

### C.5 Quality bar check

Per the [backend thin-adapter rule](../../thefactory-backend/docs/ARCHITECTURE.md): every new logical `*.ts` has a co-located `*.test.ts`; no `any` / `unknown` at the API boundary; no back-compat shims.

---

## D. thefactory-ui — headless + ProjectAppView + TemplatePicker

### D.1 Headless — templates catalog + create-from-template

- New [thefactory-ui/src/headless/contexts/TemplatesContext.tsx](../../thefactory-ui/src/headless/contexts/TemplatesContext.tsx) (small — fetches once, caches).
- New [thefactory-ui/src/headless/hooks/useTemplates.ts](../../thefactory-ui/src/headless/hooks/useTemplates.ts) → `{ templates, isLoading, error }`.
- New [thefactory-ui/src/headless/hooks/useCreateFromTemplate.ts](../../thefactory-ui/src/headless/hooks/useCreateFromTemplate.ts) → wraps `createProjectFromTemplate` from the generated SDK; returns `{ create({ templateId, id, path, mainGroupId? }), isCreating, error }`. No `title` / `description` — those come from the template's canonical `.factory/project.json` (per §A "Decided").

Tests for the headless hooks per the [no-frontend-UI-tests rule](../../.claude/projects/-Users-cloud-Documents-Work-thefactory-tools/memory/feedback_no_frontend_unit_tests.md) — logical only.

### D.2 Headless — App-view URL + refresh

- New [thefactory-ui/src/headless/hooks/useProjectAppView.ts](../../thefactory-ui/src/headless/hooks/useProjectAppView.ts) → `{ url, refresh(), key }` where `url` is the backend app-view URL for the project (already carrying the signed `viewToken`; the hook calls `POST /view/grant` and refreshes before expiry) and `key` is a counter the consuming `<iframe>` keys on to force a remount.
- Subscribes to `files:changed` for the project; bumps `key` on update (debounced 250ms).

### D.3 `ProjectAppView` component — web + native peers

- New [thefactory-ui/src/web/compound/app-view/ProjectAppView.tsx](../../thefactory-ui/src/web/compound/app-view/ProjectAppView.tsx).
  - Renders a sandboxed `<iframe sandbox="allow-scripts" src={url} key={key} />`. **Not** `allow-same-origin` — the embedded App cannot read parent state.
  - Chrome: refresh button, "Open externally" link, optional resize handle (defer the resize for v1).
- New native peer [thefactory-ui/src/native/compound/app-view/ProjectAppView.tsx](../../thefactory-ui/src/native/compound/app-view/ProjectAppView.tsx) — `<WebView source={{ uri: url }} />` with `originWhitelist={['*']}` (since the backend is on a different origin) and JS enabled.

Re-export both from `src/web/index.ts`, `src/native/index.ts`, `src/headless/index.ts`.

### D.4 `TemplatePicker` component — web + native peers

- New `TemplatePicker.tsx` (web + native) — list of cards from `useTemplates()`; selection emits `templateId`. Trivial v1; one entry today.
- Used as a step in the project-create wizard in §E and §G.

### D.5 Doc updates

- [thefactory-ui/docs/ARCHITECTURE.md](../../thefactory-ui/docs/ARCHITECTURE.md) — note `ProjectAppView` as a shared web/native compound with the same public prop API; the host wires the app-view URL via headless `useProjectAppView`.

---

## E. thefactory-overseer-web — wizard + App tab (first-class)

### E.1 Project-create wizard

- Add a "Start from template" entry path that mounts `<TemplatePicker />` then collects `{ id, path }` (and optional `mainGroupId` if the screen exposes group selection); on submit calls `useCreateFromTemplate().create(...)`. **No title / description fields** — they're inherited from the template's canonical `.factory/project.json`; the user can personalize them later via the project-settings UI, which writes to `registry.overrides`.
- Existing "blank" + "clone" paths stay untouched.

### E.2 App tab on the project detail screen

- New tab "App" mounting `<ProjectAppView projectId={...} />`.
- Show only when the resolved app-view URL responds 200 to a HEAD probe; otherwise show "No app to view yet" with a hint to start a story.

### E.3 Verification on real CLI

- Demo: pick "Investment Planner" → wizard creates project → App tab shows the working app → open Story 1 → run feature with a configured CLI → App auto-refreshes with the personalised heading and top-picks within seconds.

---

## F. overseer-local — desktop mirror (after §E verified)

- Renderer reuses the same `thefactory-ui/web` `ProjectAppView` (renderer is Chromium — same iframe behaviour).
- Add wizard parity per §E.1; add the App tab per §E.2.
- Electron-specific addition: "Open externally" routes through `window.electron.shell.openExternal(url)` rather than `target="_blank"`. Bridge via preload if not already exposed.
- No new IPC surfaces.

---

## G. thefactory-overseer-mobile — mobile mirror (after §E verified)

- Use the `thefactory-ui/native` `ProjectAppView` (`<WebView>`).
- Wizard parity per §E.1 (using the native `TemplatePicker`); App tab per §E.2 on the project detail screen.
- Validate on a real device per the [web-small-screen-source-of-truth memory rule](../../.claude/projects/-Users-cloud-Documents-Work-thefactory-tools/memory/project_web_small_screen_source_of_truth.md) — typecheck/build pass alone is not "done".

---

## H. End-to-end verification (the "wow" check)

The whole point of v1 is the moment a new user can demo. Validation steps, in order — all must pass before declaring §A–§G done:

1. Standalone: `python3 -m http.server` from this repo root → all three sections render with seeded data; calculator math is correct.
2. Backend `GET /api/v1/templates` returns this template.
3. Web wizard "Start from template" → "Investment Planner" → clone lands in the user's project path with a single initial commit and no upstream remote.
4. Web project App tab renders the working app via `GET /projects/:id/view/index.html` (with a fresh `viewToken`).
5. Story 1 + its single feature appear in the stories list as `pending`.
6. With a configured CLI/LLM, running Story 1's feature completes in seconds; App tab reflects the personalised heading and top-picks without a manual refresh (via `files:changed`).
7. Roadmap stories (live prices, web search, scouring) appear in the list as `blocked` and cannot be run.

---

## Non-goals (do not accept scope creep here)

- A `template.json` / `scaffold/` machinery inside [thefactory-tools](../../thefactory-tools). Templates are full repos; no template loader.
- A dynamic catalog endpoint that fetches from a remote registry. Hard-coded only.
- Tests for the template repo's `app.js` / Chart.js wiring. Templates are demonstrations; verification is "open it in a browser".
- Pre-populating the user's project with anything beyond what the template repo contains. No post-clone tweaks beyond `rm -rf .git && git init && commit`.
- A second template in the same pass. Ship the plumbing with one, prove it, then add the next.
- Auth-bypass on `/projects/:id/view/*`. The signed-token path (per §A → Decided: App-view auth) is the only non-bearer entry; the token is project-scoped, read-only, short-lived.
- A build step / bundler for this template. Vanilla HTML/CSS/JS + Chart.js via CDN. If a future template needs a build, lift the contract then.
