# Architecture

A map of how this codebase fits together, for humans and AI assistants. For
*what the app does*, see [README.md](../README.md); this document is about *how
the code is organized*.

## The three front ends

The app is three static HTML pages, each loading one entry-point ES module which
in turn imports from `app/js/modules/`:

| Page | Entry script | Purpose |
|---|---|---|
| `app/index.html` | `app/js/app.js` | **Schedule viewer** — browse/filter sessions for any indexed event, select a personal schedule, export `.ics` / share via URL. Public. |
| `app/planner.html` | `app/js/planner.js` | **Trip planner** — personal or sponsor-mode trip notebook in localStorage (travel, accommodation, budget, itinerary, team, receipts…). Desktop; auth-gated on the server. |
| `app/editor.html` | `app/js/editor.js` | **Data editor** — create/edit event dataset JSON (sessions, sponsors, themes, media). Auth-gated. |

There is **no bundler**. Browsers load the ES modules directly. UnoCSS generates
`app/css/utilities.css` from class usage (`npm run build:css`); the other CSS
files are hand-written.

## Module layout (`app/js/modules/`, ~60 files)

Modules are grouped by concern. Names prefixed `planner*` belong to the planner;
`editor*` to the editor; the rest are shared.

- **Core/shared** — `utils`, `notify`, `modal`, `currency`, `markdown`, `theme`,
  `validator`, `geocode`, `renderKit`, `homeLayout`, `mobileNav`, `eventCatalog`,
  `eventSearch`, `plannerStorage` (localStorage + item-id helpers).
- **Schedule viewer** — `scheduleHome`, `filters`, `calendar`, `timeline`,
  `nowIndicator`, `stats`, `render`, `speakers`, `sponsors`, `sponsorStyles`.
- **Planner** — one module per tab/feature: `plannerBudget`, `plannerItinerary`,
  `plannerSummary`, `plannerPersonal`, `plannerOrg`, `plannerTeam`, `plannerMap`,
  `plannerAccommodation`, `plannerCompanions`, `plannerAssignments`,
  `plannerTickets`, `plannerReceipts`, `plannerDocuments`, `plannerNotes`,
  `plannerTasks`, `plannerContacts`, `plannerTrackedSessions`, `plannerTravel`,
  `plannerPersonalLeg`, `plannerDashboard`, `plannerDashEdit`, `plannerCogMenu`,
  `plannerCreate`, `plannerGlobalSettings`, `plannerImportExport`,
  `plannerFields`, plus `s3Settings`, `usersPanel`.
- **Editor pure logic** (extracted, unit-tested) — `editorSponsors` (sponsor
  normalization), `editorDuration` (session duration parse/format/sync),
  `editorNormalize` (url/multi-value/flickr/logo/summary-strip),
  `editorDateTime` (UTC⇆local conversion incl. DST), `editorDataset` (dataset
  label/grouping/validation). The editor's DOM render/wire code still lives in
  `editor.js`.

## Conventions

These patterns recur throughout — following them keeps new code consistent and
greppable.

### `init → render → wire` triad
Most planner modules export a trio: `initX(deps)` (receive collaborators once),
`renderXTab()` (paint DOM from state), `wireXPanel()` (attach event listeners
once). `planner.js` calls each during startup.

### Dependency injection over cross-imports
Feature modules avoid import cycles by taking planner-internal collaborators
(shared `state`, `scheduleAutoSave`, sibling render fns) through `initX(deps)`,
while importing only *pure* helpers directly (utils, storage, fields). Injected
values are stored in module-level `let` bindings set inside `initX`.

### `els()` element map
For a panel/modal with many static fields, resolve them once into a lazily-built
map (`_els ??= { name: document.getElementById(...), … }`) instead of scattering
`getElementById` calls. This documents the DOM contract in one place. See
`plannerBudget.js` / `plannerItinerary.js`.

### Pure logic first
Business logic (money math, normalization, date conversion, parsing) is written
as pure functions — no DOM, no module state — so it can be unit-tested. The
editor extraction (`editor*` modules above) follows this deliberately: pure
helpers peel out and get tested *before* any DOM code moves.

## State & persistence

- **Planner** state lives in `localStorage` via `plannerStorage.js` (keys under a
  shared prefix; a `GLOBAL_KEY` for cross-event settings). When the optional
  server is running and authed, planner data can also sync to disk/S3 through the
  `/api/planner/*` endpoints.
- **Event data** are static JSON files under `app/data/events/<series>/…`
  (`drupalcon`, `drupalsouth`, `drupalgovau`, `drupalcamp`, `ddd`). A generated
  `app/data/catalog.json` is the read-optimized index the schedule viewer loads;
  regenerate with `npm run build:catalog` (the server also regenerates it on boot
  and on dataset PUT, with a client-side fallback).
- **Themes/sponsors** — `app/data/themes.json`, `app/data/sponsors.json`.

## Content roots (`lib/roots.js`)

Where content sits on disk is configuration, not a constant. `lib/roots.js` is the
single answer for the whole app; `server.js`, `lib/s3-sync.js` and the maintained
`scripts/*.mjs` all import from it rather than deriving their own paths.

| Export | Env var | Default | Holds |
|---|---|---|---|
| `DATA_ROOT` | `DATA_ROOT` | `app/data` | Public archive — datasets, `sponsors.json`, `themes.json`, caches |
| `IMG_ROOT` | `IMG_ROOT` | `app/img` | Data-owned images — `sponsors/`, `flickr/`, `logos/` |
| `PRIVATE_ROOT` | `PRIVATE_ROOT` | `private` | This installation's state |
| `PLANNER_ROOT` | — | `private/planners` | Planner documents, tombstones, global settings |
| `RECEIPT_ROOT` / `DOCUMENT_ROOT` | — | `private/receipts` · `private/documents` | Uploads |
| `CURATION_ROOT` | — | `private/curation` | The identity ledger (`decisions.json`) |

Four properties are load-bearing:

- **Roots are resolved once, absolutely.** `guardPath` compares a resolved
  candidate against its base with `startsWith`, so an unnormalised base (trailing
  slash, `./` prefix) would match none of its own children and fail every guarded
  write *closed* — which presents as "saving stopped working", not as an error.
  Relative overrides resolve against the repo root, not the process CWD.
- **URLs do not follow the disk.** `/data` and `/img` are the contract datasets and
  the client depend on, so `server.js` mounts those roots there explicitly rather
  than relying on them living inside `app/`.
- **Private state is outside `app/`**, which is served statically. The HTTP guards
  (`PRIVATE_TREES`) remain, but a tree that is not in the served directory cannot
  be leaked by a routing mistake — this tree has been exposed once before.
- **Only the local side of the S3 mapping is configurable.** The prefixes
  (`data/`, `img/`, `receipts/`, `documents/`, `planners/`) are the bucket's
  layout and a contract with every existing installation. The curation ledger is
  the sharp edge: it moved locally but keeps its `data/curation/` S3 key, so
  `toLocalPath` special-cases that prefix — without it a pull rewrites the ledger
  back into the public tree.

The local mirror is optional: with a `PRIVATE_ROOT` that does not exist, reads
answer empty rather than failing, and nothing is created as a side effect of
reading (which would break on a read-only container filesystem).

Full rationale, including the read-through fallback for an install whose ledger is
still at the old path, is in the module's own comments and
[data-separation-plan.md](data-separation-plan.md).

## The optional server (`server.js` + `lib/`)

An Express server used for local editing, auth, and sync — the app also runs as
pure static files without it. Route groups:

- **HTML routes** — serves the three pages; `/planner` and `/editor` require auth.
- **`/api/auth/*`, `/login`, `/api/users/*`** — session/token auth and user
  management (`lib/auth.js`, `lib/users.js`); role tiers viewer < editor < admin.
- **`/api/data/*`** (GET/PUT) — read/write dataset JSON on disk; what the editor
  saves through. Writes are schema-validated (422 on failure) via
  `lib/validateDataFile.js`, which picks the schema by filename — this route also
  carries `themes.json` and `sponsors.json`, which are **not** event datasets.
- **`/api/planner/*`** (GET/PUT/POST/DELETE) — server-side planner storage; writes
  are schema-validated (`lib/validatePlanner.js`).
- **`/api/v1/*`** — versioned CRUD API for integrations (whole-document **and**
  nested-resource CRUD across `datasets` + `planners`). A registry-driven engine
  (`lib/crudApi.js` + `lib/resourceRegistry.js`) read-modify-writes the parent
  document and validates it (`lib/validateDataset.js` / `lib/validatePlanner.js`)
  before persisting via the same document-I/O helpers the `/api/planner/*` routes
  use. Errors flow through `lib/httpError.js`; ids via `lib/makeId.js`. Full
  reference: [api.md](api.md); OpenAPI spec at `/api/v1/openapi.yaml`. Also
  `POST /api/v1/validate`, which checks a document against the schema **without
  storing it** — how a data repository living outside this app validates against
  the schema the app enforces, instead of vendoring a copy that goes stale.
- **`/api/s3/*`** — push/pull sync (`lib/s3-sync.js`), scopable to editor vs planner.
- **`/api/upload`, `/api/receipts`, `/api/documents`** — file uploads.
- **`/api/meta`, `/api/rates`, `/api/health`** — catalog metadata (`lib/buildCatalog.js`), FX rates, health.

## Build, test, lint

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | Run the server (dev = `--watch`) |
| `npm test` / `npm run test:watch` | Vitest suite (`**/__tests__/*.test.js`) |
| `npm run lint` | ESLint over `app/js`, `lib`, `scripts`, `server.js` |
| `npm run typecheck` | `tsc` type-checks files opting in via `// @ts-check` (no emit) |
| `npm run deadcode` | knip finds unused files, exports, and dependencies |
| `npm run format` / `format:check` | Prettier over `app/js/**`, `lib`, `scripts` |
| `npm run build:catalog` | Regenerate `app/data/catalog.json` |
| `npm run build:css` / `watch:css` | UnoCSS → `app/css/utilities.css` |
| `npm run validate` | Validate dataset JSON against the schema |

### Testing notes
- Tests run in the **node environment — there is no jsdom.** Test *pure*
  functions and injected-state logic. For code that touches `document`, either
  keep the DOM access behind an `if (!el) return` guard (already the norm) or stub
  it: `globalThis.document ??= { getElementById: () => null, querySelector: () => null }`.
- Modules using `initX(deps)` are tested by calling `init` with fake
  collaborators (`vi.fn()` spies + a plain `state` object), then asserting on the
  pure outputs / mutated state.

## Where the big files are

`editor.js` (~6.5k lines) and `planner.js` (~4.3k) are the two remaining
monoliths. `planner.js` orchestrates the already-extracted `planner*` modules;
`editor.js` still holds its DOM render/wire code (its pure logic has been
extracted into the `editor*` modules). Both are the natural targets for continued
incremental extraction.

## Deferred maintainability work

Larger, higher-touch follow-ups intentionally left for a dedicated effort — they
need **browser verification** (`/verify`, `/run`), not just unit tests, so they
don't fit the low-risk pure-extraction pattern used so far:

- **HTML/template extraction** — `planner.html` (~2.9k lines) holds tab-panel
  markup divorced from the code that drives it. Extract repeated panels into
  `<template>` elements or their owning module's render function.
- **`editor.js` render/wire extraction** — carve the DOM-heavy feature areas
  (Sessions, Sponsors, Themes) out of `editor.js` into `editor*` modules,
  following the `init → render → wire` convention. Do one feature slice at a time
  with browser verification, since these can't be validated by unit tests alone.

## Security surface

- [http-surface.md](http-surface.md) — every route, whether it is public, and
  how the CDN should treat it. Regenerate with `npm run audit:routes`.
- [api.md](api.md#calendar-feeds-and-their-tokens) — the calendar feed token
  scheme: server-minted, hashed at rest, one per subscription.

Two properties worth keeping true: uploads are read through `/api/receipts/*`
and `/api/documents/*` so the static paths can be blocked at the CDN, and
`lib/auth.js` refuses to start on a deployed-looking box with no auth
configured.
