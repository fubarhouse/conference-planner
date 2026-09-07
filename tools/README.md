# tools/

Go tooling that ships in the deployed image.

Every directory here holding a `go.mod` is built by the `go-tools` stage in the
[Dockerfile](../Dockerfile), and every binary it produces lands on the `PATH` of
both runtime images. That makes them available to `.lagoon.yml` cronjobs and to
`lagoon ssh … service=cli` the same way a `node scripts/…` command is. Adding a
second tool needs no change to the Dockerfile — drop the module in.

## What is here

- **`archive/`** — Go ports of the server's own logic, one slice at a time. See
  [docs/go-port.md](../docs/go-port.md). Nothing here replaces its Node
  original yet — each command is proven byte-identical and then run beside it.

  - `server catalog` — rebuilds `catalog.json` (`lib/buildCatalog.js`)
  - `server coverage` — what each event is missing (`lib/archiveCoverage.js`)
  - `server quality` — what is here but wrong (`lib/archiveQuality.js`)
  - `server insights` — the Observatory payload (`lib/archiveInsights.js`)
  - `server serve` — `/data` and `/img` over HTTP (`server.js` static mounts)
  - `server sync` — push/pull against the S3 bucket (`lib/s3-sync.js`)

  Plus the classification rules from `lib/archiveInsights.js` (topics, regions,
  countries, session lengths), used by the above and by the slices to come.

`drupalcon-sync` reconciles the archived DrupalCon datasets against the
schedule exports events.drupal.org publishes. It runs as a weekly Lagoon
cronjob, read-only — see `.lagoon.yml`. Seven packages:

```
cmd/drupalcon-sync   the CLI
internal/jsondoc     ordered JSON that round-trips a hand-edited dataset
internal/ics         iCalendar parsing, folding and escaping included
internal/dataset     loading, saving and citing archive datasets
internal/export      fetching exports, and the record of what each last said
internal/reconcile   the comparison, and the timezone correction
internal/report      rendering it for a person
```

A Lagoon build only ever sees this repository, so a tool that runs on a schedule
against the archive has to be in this build context — there is no second
checkout to reach into.

## Conventions

- **Stdlib first, and vendor anything else.** The build stage runs `go build`
  with no module proxy, so a dependency has to be committed under `vendor/` or
  the image will not build. `tools/server` vendors four, each for something
  that cannot responsibly be hand-rolled: `golang.org/x/text` (NFKD
  normalisation and Unicode collation), `golang.org/x/crypto` (bcrypt), and
  `github.com/santhosh-tekuri/jsonschema` (draft-07 validation) and
  `github.com/aws/aws-sdk-go-v2` (S3, where hand-rolled request signing is not
  a risk worth taking). See docs/go-port.md for why each earned its place.
- **Keep the `go` directive at minor version** (`go 1.26`, not `go 1.26.5`). A
  patch-level directive makes the build download a toolchain to satisfy it, or
  fail outright when the base image is one patch behind.
- **Default to reporting.** These run unattended against the live archive on a
  writable volume. A tool that writes should need a flag to do it.
