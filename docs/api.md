# CRUD API (`/api/v1`)

A versioned REST surface for custom integrations, added on top of the existing
server. It is **additive**: the legacy `/api/data/*`, `/api/planner/*`, the
editor, the planner UI, and the CLI all keep working unchanged.

Machine-readable spec: **`/api/v1/openapi.yaml`** (also `app/openapi.yaml`).

## Domains

| Domain     | Documents                              | Schema                                | Side effects            |
| ---------- | -------------------------------------- | ------------------------------------- | ----------------------- |
| `datasets` | event files under `app/data/events/`   | strict `app/schemas/event.schema.json`   | writes rebuild `catalog.json` |
| `planners` | per-user planner blobs                 | permissive `app/schemas/planner.schema.json` | S3-first, per-user in `multi` mode |

Both support **whole-document** CRUD and **nested-resource** CRUD on their
id-addressable collections. Every write validates the *resulting whole document*
before persisting; on failure nothing is written and you get `422` with the AJV
error list.

## URL shape

A document path always ends in `.json`, which separates it from any trailing
`<collection>[/id]`:

```
GET    /api/v1/datasets                                   # list datasets
GET    /api/v1/datasets/events/drupalcon/us/2025.json     # read a dataset
PUT    /api/v1/datasets/events/drupalcon/us/2025.json     # replace it (whole doc)
POST   /api/v1/datasets/events/…/2025.json                # create a dataset
DELETE /api/v1/datasets/events/…/2025.json                # delete it

GET    /api/v1/datasets/events/…/2025.json/sponsors       # list sponsors
POST   /api/v1/datasets/events/…/2025.json/sponsors       # create a sponsor
GET    /api/v1/datasets/events/…/2025.json/sponsors/acme  # read one
PUT    /api/v1/datasets/events/…/2025.json/sponsors/acme  # replace one (id kept)
DELETE /api/v1/datasets/events/…/2025.json/sponsors/acme  # delete one

GET    /api/v1/planners                                   # list planners
GET    /api/v1/planners/my-trip.json                      # read a planner
POST   /api/v1/planners/my-trip.json/tasks                # create a task
PUT    /api/v1/planners/my-trip.json/tasks/t_123          # replace a task
DELETE /api/v1/planners/my-trip.json/personal/outbound-legs/leg_9

POST   /api/v1/validate                                   # check a document, store nothing
POST   /api/v1/validate?domain=planners                   # …against the planner schema
```

## Validating without storing

`POST /api/v1/validate` checks a document you already hold. Nothing is read,
nothing is written.

It exists for a **data repository that lives outside this app**: the data repo
holds the files, this app holds the schema that defines what a valid file is, and
this endpoint is how the two meet — without the data repo vendoring a copy of the
schema that quietly goes stale.

```bash
curl -sX POST "$HOST/api/v1/validate" \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  --data-binary @events/drupalcon/us/2025.json
```

```json
{ "valid": false,
  "errors": [{ "path": ".items[3].title", "message": "must be string",
               "keyword": "type", "params": { "type": "string" } }],
  "domain": "datasets",
  "schemaFingerprint": "5472be7b630e" }
```

**It answers `200` even when the document is invalid.** The request succeeded; the
verdict is `valid`. Only a malformed *call* — unparseable JSON, empty body,
unknown `domain` — is a `400`. That split is the point: CI reads one field and can
still distinguish "my data is wrong" from "my request is wrong", which a status
code alone cannot express. (Writes still answer `422`; there an invalid document
really is a failed request.)

`schemaFingerprint` is a content hash of the schema actually enforced — not a
hand-maintained version number that someone forgets to bump. **Record it.** A
schema change is a breaking change for every data repo at once, and a changed
fingerprint is how a repo finds out deliberately rather than as a wave of
failures. For the same reason, pin any shared CI workflow to a tag.

Requires `viewer`: it needs no more privilege than fetching the schema from
`/schemas/`, which is already public. The role is there for rate limiting and
consistency, not secrecy.

## Auth

Same model as the rest of the server (`lib/auth.js`):

- **`open` mode** — no auth.
- **`multi` mode** — send a per-user API token as `Authorization: Bearer <token>`
  (generated from the admin **Users** panel). Reads require role `viewer`, writes
  require `editor`. Planner documents are isolated per user.

## Registered planner collections

Driven by `lib/resourceRegistry.js`. New elements get a stable id if you omit one
(`id` prefix in parentheses):

- top level: `contacts` (`c`), `tasks` (`t`), `receipts` (`rc`)
- `personal/`: `outbound-legs` (`leg`), `return-legs` (`leg`), `accommodations`
  (`ia`), `note-list` (`note`), `tracked-sessions` (`ts`), `itinerary` (`it`),
  `documents` (`doc`), `budget-items` (`bi`), `tickets` (`tk`),
  `trip-assignments` (`ta`), `local-companions` (`lc`)
- `org/`: `accommodations` (`ia`), `swag`, `deliverables`, `tracked-sessions`
  (`ts`), `documents` (`doc`), `budget-items` (`bi`), `tickets` (`tk`),
  `itinerary` (`it`), `member-itinerary` (`it`)

Datasets expose one nested collection: `sponsors` (id slugified from `title`).

## Calendar feeds and their tokens

A calendar client polls unattended: it cannot log in, cannot carry a session
cookie, and cannot refresh anything. So a subscribable URL **is** a credential.
These endpoints are public of necessity, and the work goes into making the
credential good rather than pretending it can be a session.

```
GET /planner/<slug>/calendar.ics?k=<token>     one trip, token-gated
GET /schedules/<slug>/calendar.ics             one event's programme, public
```

Only the first carries a secret. The two look alike and are treated very
differently by the CDN — see [http-surface.md](http-surface.md).

### Managing subscriptions

```
GET    /api/planner/<slug>/feeds            viewer   list (no secrets)
POST   /api/planner/<slug>/feeds            editor   mint; returns the token ONCE
DELETE /api/planner/<slug>/feeds/<id>       editor   revoke
```

The scheme mirrors the user API tokens in `lib/users.js`:

- **Minted on the server** with `crypto.randomBytes(32)` — 256 bits from a real
  CSPRNG. The browser never decides how strong the credential is.
- **Only a SHA-256 is stored.** The plaintext is in the `POST` response and
  nowhere else, so a leaked planner file — or a leaked S3 object — exposes no
  live subscription.
- **Compared in constant time over the hashes**, which are fixed-length hex;
  comparing raw tokens of attacker-controlled length would leak through the
  length check.
- **Every failure is a 404.** A wrong token and a planner that does not exist are
  indistinguishable.
- **Rate limited** to 60 requests / 15 min, because guessing is the only attack
  left and it should not be free.

### One token per subscription, not per planner

Each device gets its own. That is what makes show-once acceptable: losing a link
is not a crisis, since minting another does not disturb the devices already
subscribed, and revoking the laptop does not unsubscribe the phone. It also
means `lastUsedAt` describes a single device, which turns it into a way of
noticing a token being used from somewhere it should not be.

Each entry stores `id`, `label`, `hash`, `createdAt`, `lastUsedAt` and a coarse
`lastAgent` — deliberately **not** an IP address. "Apple Calendar, last seen
Tuesday" is enough to spot misuse without the product accumulating a location
history of its reader. A poll only rewrites the planner once an hour (calendars
poll constantly), but writes immediately when the client changes.

### S3 is the source of truth

Minting writes through the same S3-first path as any other planner change, so
"minted" and "saved to S3" are one act rather than two. The feed reads S3 first
as well. This matters on the deployed shape — a single task with an ephemeral
disk and no boot-time pull — where a local-disk read meant every deploy silently
broke every subscription until someone pulled by hand.

Revocation takes effect immediately for the same reason: it is one call that
reaches S3, not a local delete plus a remembered push.

### Uploaded files

Receipts and documents are read through the API:

```
GET /api/receipts/<planner>/<file>          viewer
GET /api/documents/<planner>/<file>         viewer
```

`resolveFileUrl()` in `app/js/planner.js` builds these. The original
`/receipts/*` and `/documents/*` paths remain mounted and gated, but nothing in
the product uses them, so they can be blocked at the CDN outright.

## Not exposed

Event **sessions** (`event.items`) have no stable id, so per-element CRUD would
need an `items[].id` schema + data migration first. Edit sessions via a
whole-document `PUT` for now.

## Status codes

`200` ok · `201` created · `400` bad path/JSON · `401`/`403` auth · `404` no such
document/collection/element · `405` wrong verb for the target (e.g. `POST` to an
element) · `422` schema validation failed (body lists the errors) · `502` object
store unreachable.

## Architecture

- `lib/crudApi.js` — one generic, registry-driven engine serving both domains and
  every collection; built via `createV1Router(deps)` with document I/O injected.
- `lib/resourceRegistry.js` — the declarative collection → document-location map.
- `lib/validateDataset.js` / `lib/validatePlanner.js` — AJV validators.
- `lib/makeId.js` — server-side id generation.
- `lib/feedTokens.js` — calendar subscription tokens (mint, verify, revoke,
  last-used), pure and unit-tested.
- `server.js` — the injected document-I/O helpers (disk + S3-first + catalog).
