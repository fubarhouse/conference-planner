package crud

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/ids"
	"server/internal/js"
	"server/internal/paths"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// nodeMutate performs one CRUD mutation with the JavaScript engine and returns
// the bytes it would persist.
//
// It calls the same registry helpers crudApi.js calls and finishes with the same
// `JSON.stringify(obj, null, 2) + '\n'`, so what comes back is what the API
// would have written to disk.
func nodeMutate(t *testing.T, docJSON, domain, nested, operation, bodyJSON, id string) string {
	t.Helper()
	// The document goes via a file, not an argument: datasets run to 400 KB and
	// the argument list is not that long.
	docFile := filepath.Join(t.TempDir(), "doc.json")
	if err := os.WriteFile(docFile, []byte(docJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	return ts.RunNode(t, nil, `
		import { readFileSync } from 'node:fs';
		import { REGISTRY, resolveArray, ensureArray } from './lib/resourceRegistry.js';
		const [docFile, domain, nested, operation, bodyJSON, id] = process.argv.slice(1);
		const doc = JSON.parse(readFileSync(docFile, 'utf8'));
		const desc = REGISTRY
			.filter((r) => r.domain === domain && (nested === r.key || nested.startsWith(r.key + '/')))
			.sort((a, b) => b.key.length - a.key.length)[0];
		if (!desc) throw new Error('no descriptor for ' + nested);

		if (operation === 'create') {
			const arr = ensureArray(doc, desc.pointer);
			const el = { ...JSON.parse(bodyJSON) };
			el.id = typeof el.id === 'string' && el.id ? el.id : 'FIXED_ID';
			arr.push(el);
		} else if (operation === 'replace') {
			const arr = resolveArray(doc, desc.pointer);
			const i = arr ? arr.findIndex((x) => x && x.id === id) : -1;
			if (i < 0) throw new Error('no element ' + id);
			arr[i] = { ...JSON.parse(bodyJSON), id };
		} else if (operation === 'delete') {
			const arr = resolveArray(doc, desc.pointer);
			const i = arr ? arr.findIndex((x) => x && x.id === id) : -1;
			if (i < 0) throw new Error('no element ' + id);
			arr.splice(i, 1);
		}
		process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
	`, docFile, domain, nested, operation, bodyJSON, id)
}

// goMutate performs the same mutation with the Go engine.
func goMutate(t *testing.T, docJSON, domain, nested, operation, bodyJSON, id string) string {
	t.Helper()
	doc, err := js.ParseJSON([]byte(docJSON))
	if err != nil {
		t.Fatal(err)
	}
	collection, _, err := MatchCollection(Domain(domain), nested)
	if err != nil {
		t.Fatal(err)
	}

	switch operation {
	case "create":
		array := EnsureArray(doc, collection.Pointer)
		element, err := js.ParseJSON([]byte(bodyJSON))
		if err != nil {
			t.Fatal(err)
		}
		if element.Get("id").Str() == "" {
			element.Set("id", js.Str("FIXED_ID"))
		}
		array.Append(element)
	case "replace":
		array := ResolveArray(doc, collection.Pointer)
		index := FindElement(array, id)
		if index < 0 {
			t.Fatalf("no element %s", id)
		}
		element, err := js.ParseJSON([]byte(bodyJSON))
		if err != nil {
			t.Fatal(err)
		}
		element.Set("id", js.Str(id))
		ReplaceElement(array, index, element)
	case "delete":
		array := ResolveArray(doc, collection.Pointer)
		index := FindElement(array, id)
		if index < 0 {
			t.Fatalf("no element %s", id)
		}
		RemoveElement(array, index)
	}
	return string(EncodeDocument(doc))
}

// The test a write path has to pass: the same mutation on the same document
// produces the same bytes. Run over every real dataset and planner, because a
// document nobody wrote by hand is where the surprises are.
func TestMutationsAreByteIdenticalToTheNodeEngine(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}

	type target struct {
		path, domain, nested string
	}
	var targets []target

	// Every dataset, mutating its sponsors.
	datasets, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range datasets {
		targets = append(targets, target{path, "dataset", "sponsors"})
	}
	// Every planner, mutating a handful of its collections.
	if planners := ts.PlannerDir(t); planners != "" {
		entries, _ := os.ReadDir(planners)
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			for _, key := range []string{
				"contacts", "tasks", "personal/itinerary", "personal/outbound-legs",
			} {
				targets = append(targets, target{filepath.Join(planners, entry.Name()), "planner", key})
			}
		}
	}
	if len(targets) == 0 {
		t.Fatal("nothing to mutate")
	}

	const body = `{"title":"A Test Sponsor","tier":"Gold","note":"with a comma, a \"quote\" and <html>"}`
	creates, replaces, deletes := 0, 0, 0

	for _, subject := range targets {
		raw, err := os.ReadFile(subject.path)
		if err != nil {
			continue
		}
		docJSON := string(raw)
		if _, err := js.ParseJSON(raw); err != nil {
			continue
		}

		// Create is always possible: EnsureArray builds the collection.
		want := nodeMutate(t, docJSON, subject.domain, subject.nested, "create", body, "")
		got := goMutate(t, docJSON, subject.domain, subject.nested, "create", body, "")
		if got != want {
			t.Fatalf("%s [%s] create differs\n%s", subject.path, subject.nested,
				ts.FirstDifference(got, want))
		}
		creates++

		// Replace and delete need an element that is actually there.
		collection, _, err := MatchCollection(Domain(subject.domain), subject.nested)
		if err != nil {
			t.Fatal(err)
		}
		parsed, _ := js.ParseJSON(raw)
		array := ResolveArray(parsed, collection.Pointer)
		if array == nil || len(array.Items()) == 0 {
			continue
		}
		id := array.Items()[0].Get("id").Str()
		if id == "" {
			continue
		}

		want = nodeMutate(t, docJSON, subject.domain, subject.nested, "replace", body, id)
		got = goMutate(t, docJSON, subject.domain, subject.nested, "replace", body, id)
		if got != want {
			t.Fatalf("%s [%s] replace differs\n%s", subject.path, subject.nested,
				ts.FirstDifference(got, want))
		}
		replaces++

		want = nodeMutate(t, docJSON, subject.domain, subject.nested, "delete", "", id)
		got = goMutate(t, docJSON, subject.domain, subject.nested, "delete", "", id)
		if got != want {
			t.Fatalf("%s [%s] delete differs\n%s", subject.path, subject.nested,
				ts.FirstDifference(got, want))
		}
		deletes++
	}

	t.Logf("byte-identical: %d creates, %d replaces, %d deletes across %d documents",
		creates, replaces, deletes, len(targets))
}

func TestSplitDocPath(t *testing.T) {
	cases := []struct{ input, doc, nested string }{
		{"events/x.json", "events/x.json", ""},
		{"events/x.json/sponsors", "events/x.json", "sponsors"},
		{"events/x.json/sponsors/acme", "events/x.json", "sponsors/acme"},
		{"p.json/personal/outbound-legs/leg_1", "p.json", "personal/outbound-legs/leg_1"},
	}
	for _, testCase := range cases {
		doc, nested, err := SplitDocPath(testCase.input)
		if err != nil || doc != testCase.doc || nested != testCase.nested {
			t.Errorf("SplitDocPath(%q) = (%q, %q, %v)", testCase.input, doc, nested, err)
		}
	}
	if _, _, err := SplitDocPath("events/x"); err == nil {
		t.Error("a path with no .json should be refused")
	}
}

// Keys contain slashes, so the longest match has to win or a nested collection
// resolves to its own prefix and the wrong array gets mutated.
func TestMatchCollectionPrefersTheLongestKey(t *testing.T) {
	collection, id, err := MatchCollection(DomainPlanner, "personal/tracked-sessions/ts_1")
	if err != nil || collection.Key != "personal/tracked-sessions" || id != "ts_1" {
		t.Fatalf("= (%+v, %q, %v)", collection, id, err)
	}

	collection, id, err = MatchCollection(DomainPlanner, "personal/itinerary")
	if err != nil || collection.Key != "personal/itinerary" || id != "" {
		t.Fatalf("collection with no id = (%+v, %q, %v)", collection, id, err)
	}

	if _, _, err := MatchCollection(DomainPlanner, "sponsors"); err == nil {
		t.Error("a dataset collection must not resolve in the planner domain")
	}
	if _, _, err := MatchCollection(DomainDataset, "nonsense"); err == nil {
		t.Error("an unknown collection should be refused")
	}
}

func TestResolveAndEnsureArray(t *testing.T) {
	doc, err := js.ParseJSON([]byte(`{"personal":{"itinerary":[{"id":"a"}],"notAnArray":{}}}`))
	if err != nil {
		t.Fatal(err)
	}

	if array := ResolveArray(doc, []string{"personal", "itinerary"}); array == nil ||
		len(array.Items()) != 1 {
		t.Error("an existing collection should resolve")
	}
	// Absent, and present-but-not-an-array, both read as "no such collection".
	if ResolveArray(doc, []string{"personal", "missing"}) != nil {
		t.Error("an absent collection should resolve to nothing")
	}
	if ResolveArray(doc, []string{"personal", "notAnArray"}) != nil {
		t.Error("a non-array should resolve to nothing")
	}
	if ResolveArray(doc, []string{"nope", "deeper"}) != nil {
		t.Error("a path through an absent parent should resolve to nothing")
	}

	// EnsureArray builds what is missing, including the intermediate object.
	created := EnsureArray(doc, []string{"org", "swag"})
	if created == nil || len(created.Items()) != 0 {
		t.Fatal("EnsureArray should create an empty array")
	}
	created.Append(js.Str("x"))
	if got := string(doc.Encode("")); !strings.Contains(got, `"org":{"swag":["x"]}`) {
		t.Errorf("document = %s", got)
	}
	// It replaces a non-array rather than failing on it.
	replaced := EnsureArray(doc, []string{"personal", "notAnArray"})
	if replaced == nil || !replaced.IsArray() {
		t.Error("EnsureArray should replace a non-array")
	}
}

func TestSlugID(t *testing.T) {
	now := time.Unix(1700000000, 0)
	cases := map[string]string{
		"Acquia":          "acquia",
		"Acquia Inc.":     "acquia-inc",
		"Café Ölsson":     "cafe-olsson",
		"  spaced  out  ": "spaced-out",
		"--edges--":       "edges",
		"Ærø":             "r",
		"日本語":             "",
		"Platinum & Gold": "platinum-gold",
	}
	for input, want := range cases {
		got := SlugID(input, "sponsor", now)
		if want == "" {
			// An empty slug falls back to a random id so a sponsor always has one.
			if !strings.HasPrefix(got, "sponsor_") {
				t.Errorf("SlugID(%q) = %q, want a sponsor_ fallback", input, got)
			}
			continue
		}
		if got != want {
			t.Errorf("SlugID(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSlugIDMatchesNode(t *testing.T) {
	inputs := []string{
		"Acquia", "Acquia Inc.", "Café Ölsson", "  spaced  out  ", "--edges--",
		"Platinum & Gold", "1&1 IONOS", "ÆØÅ", "Ünïcödé Ltd",
	}
	payload := js.Arr()
	for _, input := range inputs {
		payload.Append(js.Str(input))
	}
	out := ts.RunNode(t, nil, `
		import { slugId } from './lib/makeId.js';
		const inputs = JSON.parse(process.argv[1]);
		// Only the slug branch: the fallback mints a random id.
		process.stdout.write(JSON.stringify(inputs.map((s) => slugId(s, 'sponsor'))));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	for i, input := range inputs {
		got := SlugID(input, "sponsor", now)
		if strings.HasPrefix(want[i], "sponsor_") {
			continue // a random fallback on both sides; nothing to compare
		}
		if got != want[i] {
			t.Errorf("slugId(%q): go %q, node %q", input, got, want[i])
		}
	}
}

func TestMakeIDShape(t *testing.T) {
	now := time.Unix(1700000000, 500_000_000)
	id := ids.MakeID("leg", now)
	parts := strings.Split(id, "_")
	if len(parts) != 3 || parts[0] != "leg" || parts[1] != "1700000000500" || len(parts[2]) != 5 {
		t.Errorf("MakeID = %q", id)
	}
	if ids.MakeID("", now)[:5] != "item_" {
		t.Errorf("an empty prefix should default to item_, got %q", ids.MakeID("", now))
	}
	// Two ids minted in the same millisecond must still differ.
	if ids.MakeID("t", now) == ids.MakeID("t", now) {
		t.Error("ids minted in the same millisecond collided")
	}
}

// The API round-trips through parse and stringify, so it writes two-space JSON
// whatever the file's own indent was. That is a real difference from the archive
// tooling, which preserves it — and the one the API's callers already see.
func TestEncodeDocumentAlwaysUsesTwoSpaces(t *testing.T) {
	doc, err := js.ParseJSON([]byte("{\n \"a\": {\n  \"b\": 1\n }\n}"))
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"a\": {\n    \"b\": 1\n  }\n}\n"
	if got := string(EncodeDocument(doc)); got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}
