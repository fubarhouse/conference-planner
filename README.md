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
npm install
npm start        # or: npm run dev  (restarts on file changes)
```

Then open `http://localhost:8080`.

---

## Data

Event data lives in `data/*.json`. Each file covers one event and contains an `event` metadata block and an `items` array of sessions.

`data/index.json` is the catalog used by both the schedule viewer and editor. Regenerate it after adding or removing event files:

```bash
node scripts/sync-data-index.mjs
```

### Git hook

Install a pre-commit hook that regenerates and stages `data/index.json` automatically:

```bash
node scripts/install-git-hooks.mjs
```

### Data scripts

The `scripts/` directory contains Node.js scripts for importing and enriching data from external sources:

| Pattern | Purpose |
|---|---|
| `sync-data-index.mjs` | Rebuild `data/index.json` from current files |

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

- No user tracking or analytics
- No cookies
- No external data collection
- All schedule selections and planner data stay in browser local storage
