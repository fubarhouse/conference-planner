# Conference Planner

A static web application for browsing, planning, and archiving schedules and planners for community events such as DrupalSouth, DrupalCon (US, EU, Asia, LA), DrupalGov AU, and Drupal Developer Days.

This is not a Drupal-native project, but rather a community-driven initiative to preserve and share event information irrelevant of the technology stack which can be hosted completely free via github pages and managed locally.

## Attribution

> **Respect & credit**
>
> This project is based on [Adam Boros's DrupalCon Vienna 2025 Calendar Builder](https://github.com/aboros/drupalcon-vienna-2025-calendar-builder), adapted and significantly extended for a broader range of events.
>
> Please show your gratitude to [Adam Boros](https://www.drupal.org/u/aboros) for the original idea and proof of concept from DrupalCon Vienna 2025. 🙏

This project is driven by and for personal use. If others find it useful, they are welcome to use it as they see fit. It is not affiliated with DrupalSouth, the Drupal Association, or any event steering committee, and no guarantees are provided for the accuracy or completeness of schedules.

[See the app on GitHub Pages.](https://fubarhouse.github.io/conference-calendar-builder/)

---

## Purpose

Sessions, schedules, and event metadata from past Drupal events are scattered across archived websites, Wayback Machine snapshots, and community posts — most of it slowly disappearing. This project stores that information in static JSON files that will remain readable indefinitely, regardless of what happens to the original sites.

---

## Pages

### Schedule Viewer (`index.html`)

Browse sessions for any indexed event. Filter by date, track, or keyword. Click sessions to select them for your personal schedule and export to an `.ics` calendar file or share via URL.

### Trip Planner (`planner.html`) — desktop only

A personal or sponsor-mode trip notebook, stored in browser local storage. Supports:

- **Personal mode** — outbound and return travel legs, accommodation, timeline/itinerary, budget tracking, session notes, tracked sessions
- **Sponsor/org mode** — booth info, event team assignment, team travel and accommodation, swag, deliverables, sponsor budget, tracked sessions
- **Shared** — contacts, follow-up tasks, notes, receipts & expenses, document storage, budget summary with charts across all events

Planners are associated with events from the schedule catalog and can be exported/imported as JSON.

### Schedule Editor (`editor.html`) — localhost only

A full data editor for the JSON event files. Add, edit, and delete sessions; manage event metadata and sponsors; validate datasets. Requires the local dev server (see below).

---

## Running Locally

The schedule viewer and planner work by opening `index.html` directly in a browser. The editor requires the Node server so it can write files to disk.

```bash
pnpm install
pnpm start        # or: pnpm run dev  (restarts on file changes)
```

Then open `http://localhost:8080`.

### With Docker

```bash
docker compose up --build
```

The image carries the **application only** — no datasets, images, planners or
receipts. Content is mounted at runtime from `../conference-planner-data`, and
`docker-compose.yml` sets the roots to absolute container paths (`/srv/data/…`),
overriding the host-relative values in `.env` which would mean nothing inside a
container.

The compose file reads `.env` with `format: raw`, which is **required**: a bcrypt
`AUTH_PASSWORD_HASH` contains `$`, and Compose's default interpolation eats the
salt and hands the app a truncated hash that rejects every password.

### Deploying

```bash
./terraform/deploy.sh   # build + push to Lightsail
```

That build uses a **different image** from the one above — it bakes the archive in
rather than mounting it, because a container service has no volumes to mount.
Details, and why the build fails rather than shipping an empty archive, in
**[terraform/README.md](terraform/README.md)**.

---

## Development

New here? Start with **[docs/architecture.md](docs/architecture.md)** — a map of the
codebase (the three front ends, the ~60-module layout, the data flow, and the
conventions). AI assistants also read **[CLAUDE.md](CLAUDE.md)** automatically.

This project uses **pnpm** (pinned in `package.json`'s `packageManager` — run
`corepack enable` once and the right version is used automatically). pnpm blocks
dependency install scripts by default, which is the main reason it is used here;
the exceptions are listed by name in `pnpm-workspace.yaml`.

```bash
pnpm install        # install dependencies
pnpm test           # run the Vitest suite (**/__tests__/*.test.js)
pnpm run lint       # ESLint over app/js, lib, scripts, server.js
pnpm run format     # apply Prettier (use format:check to verify only)
pnpm run typecheck  # tsc over // @ts-check files (no emit)
pnpm run deadcode   # knip — find unused files, exports, dependencies
pnpm run validate   # validate event JSON against the schema
```

These same checks run in CI on every pull request to `main`
(`.github/workflows/test.yml`) — tests, data validation, lint, formatting, and
type-checking must all pass.

**Conventions** (detail in the architecture doc): planner feature modules follow an
`init → render → wire` triad and receive shared state via `initX(deps)` dependency
injection; business logic is written as pure, unit-tested functions (see any
`app/js/modules/__tests__/*.test.js`); type-checking is opt-in per file via
`// @ts-check` + JSDoc. There is **no build step** — browsers load the ES modules
directly, so keep imports cycle-free and natively runnable.

---

## Data

Event datasets live under `app/data/events/<series>/…`, one JSON file per event,
each with an `event` metadata block and an `items` array of sessions.

### The catalog

`app/data/catalog.json` is a **generated** index of every dataset, so the schedule
page fetches one file instead of eighty. It is derived from the event files, which
remain the source of truth. Regenerate it after adding, removing or editing events
— by any of these, whichever suits the moment:

```bash
pnpm run build:catalog   # explicit rebuild
pnpm start               # the server rebuilds on boot, and after every API write
```

A pre-commit hook keeps it in step automatically:

```bash
node scripts/install-git-hooks.mjs
```

If the catalog is ever missing or stale, the client falls back to reading the
event files directly — slower, but never broken.

### Where the data lives

The app is agnostic about where content sits on disk. Three roots, each
overridable, all defaulting to the layout in this repository:

| Env var | Default | Holds |
|---|---|---|
| `DATA_ROOT` | `app/data` | Public archive — `events/`, `sponsors.json`, `themes.json`, caches |
| `IMG_ROOT` | `app/img` | Data-owned images — `sponsors/`, `flickr/`, `logos/` |
| `PRIVATE_ROOT` | `private` | This installation's state — `planners/`, `receipts/`, `documents/`, `curation/` |

Relative values resolve against the repository root (not the working directory),
and absolute paths outside the repository are supported. This installation keeps
its content in a sibling directory:

```
../conference-planner-data/
  public/    ← DATA_ROOT — events/, img/, sponsors.json, themes.json, caches
  private/   ← PRIVATE_ROOT — planners/, receipts/, documents/, curation/
```

```ini
# .env
DATA_ROOT=../conference-planner-data/public
IMG_ROOT=../conference-planner-data/public/img
PRIVATE_ROOT=../conference-planner-data/private
```

`public/` is the tree intended to become its own repository; `private/` sits
outside it deliberately and must never be published — it holds planners, uploaded
receipts and documents, and the curation ledger's real names.

**`app/img` is not empty.** Data-owned images (`sponsors/`, `flickr/`, `logos/`)
live under `IMG_ROOT`; genuine app chrome — favicons, the OG card, flags — stays
in `app/img` and is served from there when `IMG_ROOT` has no such file. Both share
the `/img` URL namespace, so nothing in the datasets or the HTML has to know which
root a given image came from.

Any script that reads a content root loads `.env` for that reason
(`pnpm run build:catalog`, `validate`, `report:*`, …) — invoke them through the
pnpm script rather than `node scripts/…` directly, or they fall back to the
in-repo defaults and quietly do nothing.

Two things do **not** move with them. `/data` and `/img` remain the URL contract —
datasets store `./img/…` paths and the client fetches `./data/catalog.json`, so the
server mounts these roots at those URLs whatever the disk looks like. And the S3
prefixes are the bucket's layout, not this repo's: only the local side is
configurable.

`PRIVATE_ROOT` is deliberately **outside** `app/`, which is served statically.
Planners, uploads and the curation ledger are not public, and a directory that is
not in the served tree cannot be exposed by a routing mistake. See
[`lib/roots.js`](lib/roots.js) for the full reasoning.

### Data scripts

`scripts/` holds Node scripts for importing, enriching and auditing the archive.
The ones worth knowing:

| Command | Purpose |
|---|---|
| `pnpm run build:catalog` | Rebuild `app/data/catalog.json` from the event files |
| `pnpm run validate` | Validate every dataset against the schema |
| `pnpm run audit:archive` | Dataset health — broken images, duplicate clusters |
| `pnpm run report:coverage` | What each event is missing, worst first |
| `pnpm run report:quality` | What is present but wrong |
| `pnpm run resolve:albums` | Pre-resolve photo-album cover images |
| `pnpm run geocode:events` | Fill `geocache.json` from event locations |

A dataset can also be checked without storing it, which is how a separate data
repository validates against this app's schema — see
[docs/api.md](docs/api.md#validating-without-storing).

---

## Tech Stack

- Vanilla JS (ES modules, no build step)
- [UnoCSS](https://unocss.dev/) via CDN runtime
- [Font Awesome 6](https://fontawesome.com/)
- [Chart.js](https://www.chartjs.org/) for budget summary charts
- [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans)
- [Express](https://expressjs.com/) for the local dev server (editor file writes only)

---

## Privacy

- **No cookies**, and no accounts required to browse
- **No personal data collection** — schedule selections and planner data stay in
  your browser's local storage, and planner state only leaves the device if you
  configure sync yourself
- **Analytics: one page, no cookies.** The schedule viewer (`index.html`) loads
  [Simple Analytics](https://www.simpleanalytics.com/), which is cookieless and
  collects no personal data or cross-site identifiers. It is the only third-party
  request the app makes for its own purposes. The home, archive, planner, editor
  and curation pages load nothing of the kind.
- Event datasets may reference **external images** (sponsor logos, photo-album
  covers) that are fetched from their origin when a page shows them
