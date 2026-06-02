# Implementation plan

The first Overseer project template: a working investment-planning web app users fork into a new project and personalise via stories. The v1 vertical slice — template repo → backend catalog/transport → thefactory-ui surface → web + desktop + mobile clients — has **shipped and is verified on all three clients**. This doc is now the backlog of what's left plus a compact architecture reference; git history holds the build steps.

Source for the broader template concept: [overseer-local/docs/expansion/05-example-projects.md](../../overseer-local/docs/expansion/05-example-projects.md).

---

## What a template is

An Overseer template is **a full upstream git repo that already runs**. "Create from template" forks the repo into a new project with a clean git history (the template is the very first commit) and registers it as a normal Overseer project. The user opens it, hits the **App** tab inside Overseer, and sees the project's UI rendered as a first-class surface of the host app. The repo ships a seeded `.factory/` so at least one story+feature sits in `pending`, sized to complete in seconds with a configured CLI/LLM. Subsequent stories sculpt the working app into the user's own product.

The app surface is a streamed HTML/CSS/JS document — iframe on web + desktop (Electron renderer is Chromium), `<WebView>` on mobile. This pipe gives the same project the same look on every client and lets the project be extracted standalone (just open `index.html` over a local server). Runtime interaction between the embedded app and Overseer rides a **`postMessage` bridge** owned by the `ProjectAppView` wrapper (see [§ App↔Overseer bridge](#app-overseer-bridge) — being built now; it's also the transport [live-data-plan.md](./live-data-plan.md) Stage 1 uses for app data writes). The other integration seam — a declarative `.factory/template/manifest.json` for things Overseer renders natively — stays designed-not-built (see [Deferred integration seams](#deferred-integration-seams)).

---

## Parity mandate (cross-repo)

- **Web is the source of truth.** Desktop ([overseer-local](../../overseer-local)) and mobile ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) mirror it; matching features stay 1:1, only rendering differs.
- **App-view transport is one HTTP route.** `GET /api/v1/projects/:id/view/*` serves files from the project checkout; all three clients point an iframe / WebView at the same URL.
- **`ProjectAppView` + `TemplatePicker` shells live in [thefactory-ui](../../thefactory-ui)** (`src/web/` + `src/native/` peers, headless `useProjectAppView` + `TemplatesContext`). No client duplicates the chrome.
- **Every new logical `*.ts` in thefactory-tools / thefactory-backend / thefactory-ui headless gets a co-located `*.test.ts`.** Frontend UI (`src/ui/`) parts stay untested.

---

## Architecture (shipped) — reference

How the pieces fit, for a new contributor. No rationale here; see git history / PRs for the why.

### Template repo layout

- Static app at the repo root: [index.html](../index.html), [style.css](../style.css), [app.js](../app.js), [data/*.json](../data) (vanilla JS + Chart.js via CDN, no build).
- Seed at `.factory/template/` — deliberately **off** the canonical `.factory/projects/<id>/` layout so it can't be mistaken for a registered project, and so every template follows the same grep-able pattern. Contains `project.json` (canonical config), `manifest.json` (`{}` placeholder), and `stories/` (`order.json` + one file per story).
- Detection by the backend is structural: "does `.factory/template/project.json` exist?".

### Backend ([thefactory-backend](../../thefactory-backend))

- **Catalog** — `Template` type + hard-coded `TEMPLATES` const in [src/templates/](../../thefactory-backend/src/templates), served by `GET /api/v1/templates` ([src/routes/templates.ts](../../thefactory-backend/src/routes/templates.ts)).
- **From-template** — `POST /api/v1/projects/from-template` in [src/routes/projects.ts](../../thefactory-backend/src/routes/projects.ts). Order: clone → read `.factory/template/project.json` → `installTemplateProjectLayout` (move `.factory/template/*` → `.factory/projects/<id>/`) → `reinitWithSingleCommit` (wipe history, single "Initialize from … template" commit) → `createProject({ …, repo_url: '', dataLocation: 'inProject', metadata: { hasApp: true }, overrides: {} })`. Title/description/codeInfo/scopeGroupIds come from the template's canonical `project.json`; the wizard only supplies `id` + optional `mainGroupId`. Helpers + route have co-located tests.
- **App-view transport** — `GET /api/v1/projects/:id/view/*` ([src/routes/files.ts](../../thefactory-backend/src/routes/files.ts)) streams checkout files with correct content-types, `Cache-Control: no-store`, and `..`-traversal protection. Auth accepts **any of three** signed-`viewToken` sources, checked in the `onRequest` hook in [src/server.ts](../../thefactory-backend/src/server.ts): query param, session cookie, or `Referer`. The cookie + Referer fallbacks exist because iframe/WebView **sub-resource** loads (CSS/JS/`fetch`) don't inherit the parent URL's query string, and cross-site cookies are blocked on dev HTTP. `POST /api/v1/projects/:id/view/grant` (bearer-only) mints the token (15-min TTL, project-scoped, read-only). Utils: [viewToken.ts](../../thefactory-backend/src/utils/viewToken.ts), [viewSessionCookie.ts](../../thefactory-backend/src/utils/viewSessionCookie.ts), [viewRefererToken.ts](../../thefactory-backend/src/utils/viewRefererToken.ts), each with co-located tests.
- After backend route changes: `npm run sync-schemas` + `npm run generate-swagger`, then `npm run generate:backend` in thefactory-ui so the SDK + types regenerate.

### thefactory-ui ([thefactory-ui](../../thefactory-ui))

- **Headless** — `TemplatesProvider` / `useTemplates` ([src/headless/contexts/TemplatesContext.tsx](../../thefactory-ui/src/headless/contexts/TemplatesContext.tsx)) bundles the catalog read **and** the `createFromTemplate` mutation (matches the `LLMConfigsContext.createConfig` precedent — no standalone mutation hooks in this codebase). `useProjectAppView` ([src/headless/hooks/useProjectAppView.ts](../../thefactory-ui/src/headless/hooks/useProjectAppView.ts)) grants the token, builds the absolute URL, auto-refreshes before expiry (pure scheduling logic in [viewTokenSchedule.ts](../../thefactory-ui/src/headless/utils/viewTokenSchedule.ts), tested), and bumps a remount `key` on debounced `files:changed`. `ApiContextValue` now exposes `apiBaseUrl` for absolute-URL construction.
- **Components** — `ProjectAppView` (web iframe `sandbox="allow-scripts allow-same-origin"`; native `<WebView>`) + `TemplatePicker`, each web + native peers. The native `ProjectAppView` is exported from the dedicated subpath `thefactory-ui/native/ProjectAppView` (default export), **not** the native barrel, because it hard-depends on the optional `react-native-webview` peer — a barrel export would force every native consumer to ship that native module.
- **`hasApp` + nav** — `'app'` is the first entry in `SHELL_TAB_DEFS` ([src/headless/utils/shellNav.ts](../../thefactory-ui/src/headless/utils/shellNav.ts)). `ProjectEditorForm` carries a "Has App surface" toggle writing `metadata.hasApp`. Each client's sidebar/drawer filters the App tab to `metadata.hasApp === true`.

### Clients

- **Web** ([thefactory-overseer-web](../../thefactory-overseer-web)) — `TemplatesProvider` in the stack; App tab dispatch + `ProjectAppTab`; "Start from template" wizard mode in `ProjectManagerModal`; Sidebar `hasApp` filter.
- **Desktop** ([overseer-local](../../overseer-local)) — same, reusing the web `ProjectAppView`. Renderer CSP in [src/renderer/index.html](../../overseer-local/src/renderer/index.html) includes `frame-src 'self' http: https:` so the iframe can frame the user-configured backend.
- **Mobile** ([thefactory-overseer-mobile](../../thefactory-overseer-mobile)) — same, using the native `ProjectAppView` from the subpath. Requires the `react-native-webview` native dependency; a native binary rebuild (dev client / prebuild, not Expo Go) is needed whenever that dep changes.

---

## App↔Overseer bridge

A `postMessage` protocol between the embedded app (iframe / WebView) and the `ProjectAppView` wrapper, so the running app can ask Overseer to do things it can't (and shouldn't) do itself. The wrapper holds the authed context; the sandboxed app never holds a credential. This is the transport [live-data-plan.md](./live-data-plan.md) Stage 1 extends with `data.*` for app storage writes.

**Protocol.** `overseer:`-prefixed messages. App → Overseer: `ready` (handshake), `toast { message, variant? }`, and later `data.put|query|delete` (live-data Stage 1), `setTitle`, `navigate`, `openModal`. Overseer → App: response envelopes `{ id, ok, result?, error? }`, and later `theme`, `user`, `files:changed`.

**Where it lives.**
- **Transport in [thefactory-ui](../../thefactory-ui) `ProjectAppView`** (web `iframe` + native `<WebView>` peers): listen for messages, validate the source/origin against the served `url`, dispatch to a host-supplied `onBridgeMessage(req) => Promise<res|void>`, post the response back. The component stays pure transport; the host owns semantics. Headless carries the `BridgeRequest` / `BridgeResponse` types.
- **Host handlers** wired per client at the App-tab mount (`ProjectAppTab`): `ready` → noop; `toast` → the client's toast surface; `data.*` → DataStorage (Stage 1 of the live-data plan).
- **App side**: a tiny bridge client in the template's `app.js` that abstracts iframe (`window.parent.postMessage`) vs WebView (`window.ReactNativeWebView.postMessage`) and listens for responses. Fires `overseer:ready` on load.

**Status:** transport is **built + verified** on web / desktop / mobile (a temporary `ready` + `toast` round-trip confirmed both directions across all three, then removed). The `ProjectAppView` `onBridgeMessage` seam ships; the first real handlers (`data.*`) land with [live-data-plan.md](./live-data-plan.md) Stage 1. Apps that ignore the bridge stay plain iframes.

---

## Backlog

### Deferred integration seams

Designed so the v1 shapes don't paint us into a corner; none built. Each names its build trigger.

- **`manifest.json` native rendering.** Overseer reads `.factory/template/manifest.json` (currently `{}`) at load time and renders declared `{ menuEntries?, theme?, defaultChats? }` *natively*. **Trigger:** a template declares any of these and a contributor adds the host-side renderer.
- **App writes to repo source files (`overseer:writeFile`).** Distinct from app *data* (which goes through DataStorage — see [live-data-plan.md](./live-data-plan.md)). This is the app editing its own version-controlled source via the bearer-protected file routes. **Trigger:** an app surface needs to mutate repo files at runtime (rare; most runtime state is DataStorage).
- **"Native app template" kind.** A template that ships a React tree using thefactory-ui's `web/`+`native/` peers, imported by the host directly (no iframe). Tighter integration vs. tech-stack lock-in + host-runtime security. **Trigger:** product decision to offer a second template kind.
- **Per-project dev server (framework templates).** When a template ships a `package.json` with a `dev` script, the backend spawns it lazily on first App-tab open, reverse-proxies `/view/*` to it, idle-shuts-down, and HMR rides the dev server's own ws. **Trigger:** the first template that needs a build pipeline.
- **Hosted-repo conversion.** Project-settings affordance wrapping the existing `POST /api/v1/projects/github/create-repo` + git remote/push steps, converting a local-only project to GitHub-backed. **Trigger:** a user wants their project pushed from inside Overseer.

### Template content polish (this repo)

The tooling is done; the investment-planner content can grow. Open, low-priority:

- Tighten the calculator + holdings copy and visual design.
- Flesh out Story 1's feature prompt as real usage surfaces rough edges.

### Future template stories (ship as `?` in `.factory/template/stories/`)

The roadmap the user sees in the stories list.

- **Live prices, opportunity search, periodic scouring** — no longer blocked-on-a-trigger; **re-architected into the DataStorage + LiveData platform plan** ([live-data-plan.md](./live-data-plan.md)). They become real features (Stages 1–3 there), not agent-in-story hacks. The `.factory` stories stay as the user-facing roadmap entries.
- **Broker / brokerage-API connections.** Still a genuine future story. Trigger: an OAuth credential type for brokerage APIs in [thefactory-tools/src/credentials/credentialTypes.ts](../../thefactory-tools/src/credentials/credentialTypes.ts).

### Subsequent templates

Board game, book writing, car buyer helper, interior planner (per [the expansion doc](../../overseer-local/docs/expansion/05-example-projects.md)). The plumbing is proven with one; add the next when prioritised.

---

## Non-goals

- A `template.json` / `scaffold/` machinery in thefactory-tools. Templates are full repos; no template loader.
- A dynamic catalog endpoint fetching from a remote registry. Hard-coded const only.
- Tests for the template's `app.js` / Chart.js wiring. Templates are demonstrations; verification is "open it in a browser".
- Post-clone tweaks beyond install-layout + `git init` + single commit.
- Auth-bypass on `/view/*`. The signed-token paths (query / cookie / Referer) are the only non-bearer entry; the token is project-scoped, read-only, short-lived.
