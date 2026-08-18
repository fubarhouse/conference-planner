# Feature roadmap — opportunities vs. TripIt & alternatives

Findings from a July 2026 competitive scan (TripIt, Wanderlog, Kayak Trips,
Flighty, the now-defunct App in the Air, Stippl, Roadtrippers, Splitwise/PackPoint
as point tools). This app is a **conference-centric trip planner**, so the goal
isn't parity — it's picking high-leverage additions.

## Where this app already leads

Don't rebuild these; they're differentiators competitors lack:

- **Conference session integration** — tracked sessions tie into the schedule
  viewer. Unique in the travel-app space.
- **Team / sponsor / booth mode** with assignments — closer to business-travel
  tooling (Navan/Concur) than to TripIt.
- **Multi-currency budget + receipts + tickets + FX rates** — richer than TripIt
  and most alternatives (which do flat expense logging).
- **Self-hosted / privacy / GPX tracks / import-export / a CRUD API.**

## Opportunity backlog (ranked by value ÷ effort)

| # | Feature | Who has it | Status | Value / Effort |
|---|---------|-----------|--------|----------------|
| 1 | **Installable PWA + offline** | Wanderlog/Roadtrippers (Pro) | ✅ done (this session) | High / Low-Med |
| 2 | **Expense splitting / settle-up** | Wanderlog, Stippl, Splitwise | ✅ done (this session) | Med-High / Med |
| 3 | **Trip calendar feed** (.ics export + per-user `webcal` subscribe of the *whole trip*: legs, hotels, itinerary, tracked sessions) | TripIt calendar sync | ⏳ backlog | **High / Low** |
| 4 | **Confirmation import** (paste / `.eml` / `.ics` → auto-fill a leg or accommodation) | TripIt's signature feature; Kayak; Wanderlog Pro Gmail scan | ⏳ backlog | High / Med-High |
| 5 | **Live flight status** (delay/gate/cancel alerts) | TripIt Pro, Flighty | ⏳ backlog | High / High + ongoing API cost |
| 6 | **Checklists** — mode-aware tick-off lists + starter templates (`plannerChecklists.js`; `personal.checklists`/`org.checklists`) | Wanderlog, Stippl, PackPoint | ✅ done | Med / Low |
| 7 | **Destination weather** — opt-in Weather tab (Open-Meteo, keyless): auto-picks the trip location, **per-day locations** (legs/accommodation stays/cruise stops/itinerary), climate **normals** for far-future trips, **and per-day chips on the Itinerary agenda** | Wanderlog, Stippl | ✅ done | Low-Med / Low |
| 8 | **POI discovery + route optimization** | Wanderlog, Roadtrippers | ⏳ backlog | Med / High |
| 9 | **Loyalty/points wallet** | Flighty, TravelRewards | ⏳ backlog | Low (niche here) / Med |
| 10 | **Real-time collaborative editing** | Wanderlog | ⏳ backlog | Med / Very High — fights the whole-document persistence model |

### Implementation notes for the top backlog items

**#3 Trip calendar feed (recommended next).** Reuse the existing `.ics` generation
in `app/js/modules/calendar.js` (today it only exports *schedule sessions*).
Generate VEVENTs from planner legs/accommodations/itinerary/tracked-sessions with
their times + the event timezone. Two delivery paths: a "Download .ics" button
(client, no server) and a per-user subscribe URL served via the new
`/api/v1` layer (e.g. `GET /api/v1/planners/{file}.ics` → `text/calendar`) so
Apple/Google/Outlook auto-refresh. Days-not-weeks; highest value-per-effort left.

**#4 Confirmation import.** Skip full Gmail OAuth. Start with paste-a-confirmation
/ drop an `.eml` or `.ics`, parse into the existing leg/accommodation shapes, and
route through the editor/planner add flows. Structured `.ics` (VEVENT) is the
cheapest reliable format; airline/hotel HTML parsing is the long tail.

**#5 Flight status.** Needs a flight-data API (AeroDataBox/FlightAware/Aviationstack)
+ a poll/push path; stage as a "Pro"/opt-in because of ongoing cost. Legs already
carry flight numbers to key off.

**#7 Weather (agreed design, next up).** Source: **Open-Meteo** (keyless,
CORS-friendly, forecast + climate) called straight from the browser; reuse the
geocode cache (`STORAGE_KEYS.geocodeCache`) for lat/long. Lives in **two** places:
weather chips on the **itinerary day headers** (render independent of any tab) and
a new **opt-in "Weather" tab disabled by default** — add to the base tab sets,
seed `disabledTabs: ['weather']` in `makeEmptyPlanner`, and bump PLANNER_VERSION
3→4 with a one-time migration so existing planners also start disabled (idempotent;
no planner has ever had a weather pref). Graceful degradation: within ~14 days →
live forecast; beyond → seasonal normals labelled "typical"; no location or
offline → cached values ("as of …") or hidden; a fetch failure never blocks the
itinerary. Single °C/°F preference (global setting) with a toggle — not both.

## Sources

usecarly (TripIt guide + alternatives), Going, tripit.com (Inbox Sync), Staywise,
tripstone (Wanderlog vs TripIt), wanderlog.com, The Blonde Abroad / merecivilian
(App in the Air / Flighty), blueplanit, stippl.io.
