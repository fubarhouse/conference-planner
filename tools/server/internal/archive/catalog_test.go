package archive

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// nodeCatalog asks the Node implementation for the catalog it would build,
// without letting it write anything. This is the oracle: while both
// implementations exist, the Go one is correct exactly insofar as it agrees.
func nodeCatalog(t *testing.T, dataDir string) ([]byte, bool) {
	t.Helper()
	root := ts.RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "lib", "buildCatalog.js")); err != nil {
		return nil, false
	}
	if _, err := exec.LookPath("node"); err != nil {
		return nil, false
	}

	script := `
		import { buildCatalog } from './scripts/lib/buildCatalog.js';
		const { skipped, ...catalog } = await buildCatalog(process.argv[1]);
		process.stdout.write(JSON.stringify(catalog, null, 2) + '\n');
	`
	cmd := exec.Command("node", "--input-type=module", "--eval", script, dataDir)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if ok := asExitError(err, &exit); ok {
			t.Fatalf("node build failed: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		t.Fatalf("node build failed: %v", err)
	}
	return out, true
}

func asExitError(err error, target **exec.ExitError) bool {
	exit, ok := err.(*exec.ExitError)
	if ok {
		*target = exit
	}
	return ok
}

// stripStamp removes generatedAt, which is a timestamp rather than a fact about
// the datasets and differs between two runs by construction.
func stripStamp(t *testing.T, raw []byte) string {
	t.Helper()
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return string(StripGeneratedAt(parsed).Encode("  "))
}

// The test that matters. Everything else here is a unit test of a detail; this
// is the one that says the port is correct.
func TestCatalogIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}

	want, ok := nodeCatalog(t, dataDir)
	if !ok {
		t.Skip("node or lib/buildCatalog.js unavailable")
	}

	built, err := BuildCatalog(dataDir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got := append(built.Value.Encode("  "), '\n')

	if stripStamp(t, got) != stripStamp(t, want) {
		ts.WriteArtefacts(t, got, want)
		t.Fatalf("Go and Node catalogs differ — artefacts written next to the test")
	}
	t.Logf("byte-identical over %d events, %d skipped", built.Events, len(built.Skipped))
}

// The Node side sorts file paths with localeCompare, which is not a code-point
// sort in general. It happens to agree for the paths this archive holds; this
// is what notices the day one arrives that it does not.
func TestFileOrderMatchesLocaleCompare(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}

	files, err := CollectEventFiles(filepath.Join(dataDir, "events"), dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Skip("no event files")
	}

	payload, err := json.Marshal(files)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", "--input-type=module", "--eval", `
		const files = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify([...files].sort((a, b) => a.localeCompare(b))));
	`, string(payload))
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	var localeSorted []string
	if err := json.Unmarshal(out, &localeSorted); err != nil {
		t.Fatal(err)
	}

	goSorted := append([]string(nil), files...)
	sortStringSlice(goSorted)
	for i := range goSorted {
		if goSorted[i] != localeSorted[i] {
			t.Fatalf("sort order diverges at %d:\n  go:     %s\n  locale: %s\n"+
				"BuildCatalog must switch to a collation-aware sort", i, goSorted[i], localeSorted[i])
		}
	}
}

func TestPickEventFieldsKeepsFieldOrderAndVerbatimValues(t *testing.T) {
	// Fields deliberately out of order in the source, and a `year` that is a
	// string here and a number in other datasets.
	dataset, err := js.ParseJSON([]byte(`{"event":{
		"enabled": true,
		"year": "2010",
		"designation": "Drupal Dev Days",
		"default": true,
		"organisers": ["someone"],
		"location": "Munich"
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := string(pickEventFields(dataset.Get("event")).Encode("  "))
	want := `{
  "designation": "Drupal Dev Days",
  "location": "Munich",
  "year": "2010",
  "enabled": true
}`
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
	// `default` is collapsed into the top-level defaultFile, and anything not in
	// the client-facing subset stays out of the catalog.
	if strings.Contains(got, "default") || strings.Contains(got, "organisers") {
		t.Error("a field outside EVENT_FIELDS leaked into the catalog")
	}
}

func TestBuildCatalogOnSyntheticTree(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("events/a/2001-one.json", `{"event":{"designation":"One","default":true}}`)
	write("events/b/2002-two.json", `{"event":{"designation":"Two"}}`)
	write("events/b/broken.json", `{"event":`)
	write("events/index.json", `{"ignored":true}`) // excluded by name
	write("events/b/notes.txt", `not json`)        // excluded by extension
	write("catalog.json", `{"stale":true}`)        // top level, never an event
	write("sponsors.json", `{"notAnEvent":true}`)  // top level, never an event

	catalog, err := BuildCatalog(dir, time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}

	if catalog.Events != 2 {
		t.Errorf("events = %d, want 2", catalog.Events)
	}
	if len(catalog.Skipped) != 1 || catalog.Skipped[0].File != "events/b/broken.json" {
		t.Errorf("skipped = %+v, want the unparseable file recorded", catalog.Skipped)
	}
	if got := catalog.Value.Get("defaultFile").Str(); got != "events/a/2001-one.json" {
		t.Errorf("defaultFile = %q, want the file flagged default", got)
	}
	if got := catalog.Value.Get("generatedAt").Str(); got != "2026-08-26T12:00:00.000Z" {
		t.Errorf("generatedAt = %q, want the JS toISOString shape", got)
	}
}

func TestDefaultFileFallsBackToTheFirstFile(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"events/z.json", "events/a.json"} {
		full := filepath.Join(dir, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(`{"event":{"designation":"x"}}`), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	catalog, err := BuildCatalog(dir, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if got := catalog.Value.Get("defaultFile").Str(); got != "events/a.json" {
		t.Errorf("defaultFile = %q, want the first file in sort order", got)
	}
}

func TestMissingEventsDirectoryIsNotAnError(t *testing.T) {
	catalog, err := BuildCatalog(t.TempDir(), time.Now())
	if err != nil {
		t.Fatalf("an archive with no events/ should build an empty catalog, got %v", err)
	}
	if catalog.Events != 0 {
		t.Errorf("events = %d, want 0", catalog.Events)
	}
	if got := catalog.Value.Get("defaultFile").Str(); got != "" {
		t.Errorf("defaultFile = %q, want empty", got)
	}
}

func sortStringSlice(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
