package archive

// A Go port of lib/buildCatalog.js.
//
// The catalog is the consolidated event-metadata file the schedule page fetches
// instead of every event JSON at startup, so the `event` shape here must stay a
// drop-in for each file's `data.event` — the client repopulates its manifest
// maps from it and falls back to per-file fetching when it is absent.
//
// The Node implementation stays in place and stays authoritative until this one
// has proven byte-identical for long enough to retire it. catalog_test.go runs
// both over the real archive and diffs the bytes.

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	"sort"
	"strings"
	"time"
)

// Only the fields the client reads. Order matters: pickEventFields walks this
// list, so it decides the key order in the output, not the order the fields
// happen to appear in a dataset.
var eventFields = []string{
	"designation",
	"location",
	"year",
	"region",
	"venue",
	"startDate",
	"endDate",
	"timezone",
	"website",
	"scheduleURL",
	"enabled",
	"hidden",
	"eventVisibility",
}

// Event files live under events/; these top-level data files never do.
var excludeNames = map[string]bool{
	"index.json":     true,
	"catalog.json":   true,
	"new-event.json": true,
}

const eventsSubdir = "events"

// Skipped is a file on disk that could not be read or parsed.
type Skipped struct {
	File   string
	Reason string
}

// Catalog is the built result. `Skipped` is reported to the caller but kept out
// of the written file.
type Catalog struct {
	Value   *js.Value
	Events  int
	Skipped []Skipped
}

// CollectEventFiles returns every *.json under dir as a slash-separated path
// relative to dataDir, e.g. "events/drupalcon/us/2008-boston.json".
func CollectEventFiles(dir, dataDir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			// events/ absent — treat as no events rather than failing, matching
			// the Node version's try/catch around readdir.
			if os.IsNotExist(err) {
				return fs.SkipAll
			}
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") || excludeNames[entry.Name()] {
			return nil
		}
		rel, relErr := filepath.Rel(dataDir, name)
		if relErr != nil {
			return relErr
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// readSeriesMap loads the curation ledger's event-file → series mapping.
//
// An event's NAME and the series it BELONGS TO are separate facts. `designation`
// is what it was marketed as and lives in the dataset; the series it is grouped
// under is a curation decision and lives in the private ledger — so DrupalSouth
// Community Day groups under DrupalSouth, and Drupal Camp Delhi under DrupalCamp,
// without either losing its own name.
//
// The catalog carries the RESOLVED series so the browse page can group by it
// without reading a private file or calling an API, which is what keeps the
// static deployment working. A missing ledger is the normal case for a static
// build and is not an error.
//
// MUST STAY IN STEP WITH scripts/lib/buildCatalog.js — catalog_test.go asserts
// the two produce byte-identical output over the real corpus.
func readSeriesMap() map[string]string {
	out := map[string]string{}
	root := paths.ResolvePrivateRoot("")
	if root == "" {
		return out
	}
	raw, err := os.ReadFile(filepath.Join(root, "curation", "decisions.json"))
	if err != nil {
		return out
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return out
	}
	series := parsed.Get("series")
	if !series.IsObject() {
		return out
	}
	for _, key := range series.Keys() {
		out[key] = series.Get(key).Str()
	}
	return out
}

// BuildCatalog reads a data directory and returns the catalog.
//
// Unreadable or invalid event files are skipped, exactly as the client does —
// but recorded, because a broken file would otherwise silently vanish from the
// archive with nothing to say it had ever been there.
func BuildCatalog(dataDir string, now time.Time) (Catalog, error) {
	files, err := CollectEventFiles(filepath.Join(dataDir, eventsSubdir), dataDir)
	if err != nil {
		return Catalog{}, err
	}
	// The Node side sorts with localeCompare. For the paths this archive
	// actually holds — lowercase ASCII, digits, dashes and slashes — that is
	// the same order as a code-point sort, and catalog_test.go asserts the two
	// agree over the real corpus rather than trusting the claim.
	sort.Strings(files)
	seriesOf := readSeriesMap()

	events := js.Arr()
	var skipped []Skipped
	defaultFile := ""

	for _, file := range files {
		raw, readErr := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(file)))
		if readErr != nil {
			skipped = append(skipped, Skipped{File: file, Reason: ErrCode(readErr)})
			continue
		}
		data, parseErr := js.ParseJSON(raw)
		if parseErr != nil {
			skipped = append(skipped, Skipped{File: file, Reason: "SyntaxError"})
			continue
		}

		event := data.Get("event")
		// First file flagged as default wins; falls back to the first file below.
		if defaultFile == "" && event.Get("default").IsTrue() {
			defaultFile = file
		}

		entry := js.Obj().Set("file", js.Str(file)).Set("event", pickEventFields(event))
		// Only when the series differs from the designation, so the file stays
		// lean and the events that map to themselves are unchanged.
		if series := strings.TrimSpace(seriesOf[file]); series != "" && series != event.Get("designation").Str() {
			entry.Set("series", js.Str(series))
		}
		// Omitted entirely when an event has no sources, to keep the file lean.
		if summary := SummarizeSources(data); summary.Count > 0 {
			entry.Set("sources", summary.Value())
		}
		events.Append(entry)
	}

	if defaultFile == "" && len(files) > 0 {
		defaultFile = files[0]
	}

	catalog := js.Obj().
		Set("generatedAt", js.Str(ISOMillis(now))).
		Set("defaultFile", js.Str(defaultFile)).
		Set("events", events)

	return Catalog{Value: catalog, Events: len(events.Items()), Skipped: skipped}, nil
}

// WriteCatalog builds and writes catalog.json under dataDir.
func WriteCatalog(dataDir string, now time.Time) (Catalog, error) {
	catalog, err := BuildCatalog(dataDir, now)
	if err != nil {
		return catalog, err
	}
	out := append(catalog.Value.Encode("  "), '\n')
	return catalog, os.WriteFile(path.Join(dataDir, "catalog.json"), out, 0o644)
}

// pickEventFields copies the client-facing subset, verbatim. Values are carried
// across as parsed, not re-typed: `year` is a string in some datasets and a
// number in others, and the catalog is not the place to decide which is right.
func pickEventFields(event *js.Value) *js.Value {
	out := js.Obj()
	for _, field := range eventFields {
		if child := event.Get(field); child.Exists() {
			out.Set(field, child)
		}
	}
	return out
}

// ISOMillis formats the way Date.toISOString() does — always UTC, always three
// decimal places, always the Z.
func ISOMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// ErrCode reports the shape the Node version records: an errno name when there
// is one, so a permissions problem is distinguishable from a missing file.
func ErrCode(err error) string {
	switch {
	case os.IsNotExist(err):
		return "ENOENT"
	case os.IsPermission(err):
		return "EACCES"
	}
	return err.Error()
}

// StripGeneratedAt drops the build stamp, so two catalogs can be compared for
// the archive they describe rather than the moment they were written.
func StripGeneratedAt(catalog *js.Value) *js.Value {
	out := js.Obj()
	for _, key := range catalog.Keys() {
		if key == "generatedAt" {
			continue
		}
		out.Set(key, catalog.Get(key))
	}
	return out
}
