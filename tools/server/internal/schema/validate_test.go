package schema

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

// nodeVerdicts asks ajv about a batch of documents and returns just the
// verdicts. Batched because compiling the schema costs more than validating.
func nodeVerdicts(t *testing.T, domain string, paths []string) []bool {
	t.Helper()
	payload := js.Arr()
	for _, path := range paths {
		payload.Append(js.Str(path))
	}
	module := "./lib/validateDataset.js"
	function := "validateDataset"
	if domain == "planners" {
		module = "./lib/validatePlanner.js"
		function = "validatePlanner"
	}
	out := ts.RunNode(t, nil, `
		import { readFileSync } from 'node:fs';
		const { `+function+` } = await import('`+module+`');
		const paths = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(paths.map((p) => {
			try { return `+function+`(JSON.parse(readFileSync(p, 'utf8'))).valid; }
			catch { return null; }
		})));
	`, string(payload.Encode("")))

	var verdicts []bool
	if err := json.Unmarshal([]byte(out), &verdicts); err != nil {
		t.Fatalf("node returned %q: %v", out, err)
	}
	return verdicts
}

func appRoot(t *testing.T) string {
	t.Helper()
	return filepath.Join(ts.RepoRoot(t), "app")
}

// The bar for validation: the same VERDICT as ajv, over every file the archive
// holds. The error prose differs by construction and is not compared.
func TestValidationVerdictsMatchAjvOverTheArchive(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	validator := LoadSchemas(appRoot(t)).Datasets
	if validator.err != nil {
		t.Fatalf("schema did not compile: %v", validator.err)
	}

	paths, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Skip("no datasets")
	}

	want := nodeVerdicts(t, "datasets", paths)
	disagreements := 0
	for i, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		document, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		got := validator.Validate(document)
		if got.Valid != want[i] {
			disagreements++
			if disagreements <= 5 {
				t.Errorf("%s: go says valid=%v, ajv says valid=%v\n  %s",
					filepath.Base(path), got.Valid, want[i], firstError(got))
			}
		}
	}
	if disagreements > 5 {
		t.Errorf("… and %d more disagreements", disagreements-5)
	}
	t.Logf("agreed with ajv on %d datasets", len(paths))
}

func firstError(result ValidationResult) string {
	if len(result.Errors) == 0 {
		return "(no errors reported)"
	}
	return result.Errors[0].Path + ": " + result.Errors[0].Message
}

// Agreeing that everything valid is valid proves little on its own. These are
// documents broken in specific ways, and both implementations must reject each
// one — otherwise the API would accept a write the CLI would reject.
func TestValidationRejectsTheSameBrokenDocuments(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	paths, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil || len(paths) == 0 {
		t.Skip("no datasets")
	}

	raw, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}

	breakages := map[string]func(*js.Value){
		"a required event field removed": func(doc *js.Value) {
			doc.Get("event").Delete("designation")
		},
		"a string where an array belongs": func(doc *js.Value) {
			doc.Set("items", js.Str("not an array"))
		},
		"a number where a string belongs": func(doc *js.Value) {
			doc.Get("event").Set("designation", js.Int(42))
		},
		"a malformed date": func(doc *js.Value) {
			doc.Get("event").Set("startDate", js.Str("the third of never"))
		},
		"an unknown source kind": func(doc *js.Value) {
			sources := doc.Get("event").Get("sources")
			if sources.IsArray() && len(sources.Items()) > 0 {
				sources.Items()[0].Set("kind", js.Str("not-a-real-kind"))
			} else {
				doc.Get("event").Set("sources",
					js.Arr(js.Obj().Set("id", js.Str("x")).Set("kind", js.Str("not-a-real-kind"))))
			}
		},
		"an item with the wrong shape": func(doc *js.Value) {
			doc.Set("items", js.Arr(js.Str("a session should be an object")))
		},
	}

	validator := LoadSchemas(appRoot(t)).Datasets
	dir := t.TempDir()

	var names, files []string
	for name, breakage := range breakages {
		document, err := js.ParseJSON(raw)
		if err != nil {
			t.Fatal(err)
		}
		breakage(document)
		path := filepath.Join(dir, strings.ReplaceAll(name, " ", "-")+".json")
		if err := os.WriteFile(path, document.Encode("  "), 0o644); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
		files = append(files, path)
	}

	want := nodeVerdicts(t, "datasets", files)
	for i, name := range names {
		document, err := js.ParseJSON(mustRead(t, files[i]))
		if err != nil {
			t.Fatal(err)
		}
		got := validator.Validate(document)
		if want[i] {
			t.Errorf("%s: ajv ACCEPTED it — the breakage is not one the schema catches", name)
			continue
		}
		if got.Valid {
			t.Errorf("%s: ajv rejected it, Go accepted it", name)
			continue
		}
		if len(got.Errors) == 0 {
			t.Errorf("%s: rejected with no errors to show", name)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// Planners are validated against a deliberately permissive schema — it catches
// gross structural corruption, not every field, so a migration-era planner is
// never rejected and nobody's save breaks.
func TestPlannerValidationVerdictsMatchAjv(t *testing.T) {
	planners := ts.PlannerDir(t)
	if planners == "" {
		t.Skip("no planner directory found")
	}
	entries, err := os.ReadDir(planners)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			paths = append(paths, filepath.Join(planners, entry.Name()))
		}
	}
	if len(paths) == 0 {
		t.Skip("no planners")
	}

	validator := LoadSchemas(appRoot(t)).Planners
	if validator.err != nil {
		t.Fatalf("planner schema did not compile: %v", validator.err)
	}

	want := nodeVerdicts(t, "planners", paths)
	for i, path := range paths {
		document, err := js.ParseJSON(mustRead(t, path))
		if err != nil {
			continue
		}
		if got := validator.Validate(document); got.Valid != want[i] {
			t.Errorf("%s: go says valid=%v, ajv says valid=%v\n  %s",
				filepath.Base(path), got.Valid, want[i], firstError(got))
		}
	}
	t.Logf("agreed with ajv on %d planners", len(paths))
}

// The fingerprint is what a data repository pins against, so it has to be the
// same twelve characters on both sides.
func TestSchemaFingerprintMatchesNode(t *testing.T) {
	want := strings.TrimSpace(ts.RunNode(t, nil, `
		const { DATASET_SCHEMA_FINGERPRINT } = await import('./lib/validateDataset.js');
		const { PLANNER_SCHEMA_FINGERPRINT } = await import('./lib/validatePlanner.js');
		process.stdout.write(DATASET_SCHEMA_FINGERPRINT + ' ' + PLANNER_SCHEMA_FINGERPRINT);
	`))
	parts := strings.Fields(want)
	if len(parts) != 2 {
		t.Fatalf("node returned %q", want)
	}

	set := LoadSchemas(appRoot(t))
	if set.Datasets.Fingerprint != parts[0] {
		t.Errorf("dataset fingerprint = %q, node = %q", set.Datasets.Fingerprint, parts[0])
	}
	if set.Planners.Fingerprint != parts[1] {
		t.Errorf("planner fingerprint = %q, node = %q", set.Planners.Fingerprint, parts[1])
	}
}

func TestErrorPathRendersTheDotForm(t *testing.T) {
	cases := []struct {
		location []string
		want     string
	}{
		{nil, "(root)"},
		{[]string{"event"}, ".event"},
		{[]string{"items", "3", "title"}, ".items[3].title"},
		{[]string{"event", "sponsors", "0", "tier"}, ".event.sponsors[0].tier"},
	}
	for _, testCase := range cases {
		if got := ErrorPath(testCase.location); got != testCase.want {
			t.Errorf("ErrorPath(%v) = %q, want %q", testCase.location, got, testCase.want)
		}
	}
}

// A schema that will not compile must fail CLOSED. "We could not check" and
// "it is fine" are not the same answer, and only one of them is safe to write.
func TestUncompilableSchemaRejectsEverything(t *testing.T) {
	broken := &Validator{err: os.ErrNotExist}
	result := broken.Validate(js.Obj())
	if result.Valid {
		t.Error("a validator with no schema accepted a document")
	}
	if len(result.Errors) == 0 || !strings.Contains(result.Errors[0].Message, "schema unavailable") {
		t.Errorf("errors = %+v", result.Errors)
	}
}
