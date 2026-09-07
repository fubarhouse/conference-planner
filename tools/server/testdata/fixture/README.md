# The fixture archive

Sixteen real events, frozen. This is what the Go test suite reads.

It replaced the live archive as the tests' input when the JavaScript reference
was deleted and its answers were recorded (see
[docs/go-port.md](../../../../docs/go-port.md)). A recording taken over live data
goes stale the moment somebody edits a dataset — the suite would then fail for
something that is not a regression.

## What it covers

Chosen greedily for coverage per byte, against what the code branches on:

- all four regions (EMEA, APAC, AMER, LATAM) and ten series
- sessions with and without video, with and without descriptions
- events with sponsors, with a Flickr album, with and without a logo
- `2026-rotterdam.json` and `2010-munich.json` specifically, because several
  tests name them — and the first is large enough to exercise the gzip threshold

Images are **deliberately incomplete**: every third referenced image, and
anything over 40 KB, was left out, so the broken-image report has something real
to find.

## Changing it

Adding an event means re-recording, because the reference answers are derived
from these files:

```sh
go run . catalog -data testdata/fixture      # rebuild the index
go test ./... -update-golden                 # needs server.js and lib/ restored
```

Nothing here is generated at test time. `catalog.json` is committed, and the
tests restore it if a server rewrites it.
