package crud

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/schema"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// newAPI builds the surface over a throwaway copy of the archive, so a test that
// writes cannot touch the real one.
func newAPI(t *testing.T) (*CrudAPI, string, string) {
	t.Helper()
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	dataDir := ts.CopyArchive(t, source)
	plannerRoot := t.TempDir()

	set := schema.LoadSchemas(filepath.Join(ts.RepoRoot(t), "app"))
	return &CrudAPI{
		Datasets: &DiskStore{Root: dataDir, Schema: set.Datasets},
		Planners: &DiskStore{Root: plannerRoot, Schema: set.Planners},
		Now:      func() time.Time { return time.Unix(1700000000, 0) },
	}, dataDir, plannerRoot
}

func call(t *testing.T, api *CrudAPI, method, path, body string) (int, string) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	recorder := httptest.NewRecorder()
	api.Handler().ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String()
}

func TestAPIReadsDocumentsCollectionsAndElements(t *testing.T) {
	api, _, _ := newAPI(t)
	const doc = "/api/v1/datasets/events/drupalcon/eu/2026-rotterdam.json"

	status, body := call(t, api, http.MethodGet, doc, "")
	if status != http.StatusOK || !strings.Contains(body, `"designation"`) {
		t.Fatalf("whole document = %d %s", status, ts.FirstLines(body, 1))
	}

	status, body = call(t, api, http.MethodGet, doc+"/sponsors", "")
	if status != http.StatusOK || !strings.HasPrefix(body, "[") {
		t.Fatalf("collection = %d %s", status, ts.FirstLines(body, 1))
	}
	var sponsors []map[string]any
	if err := json.Unmarshal([]byte(body), &sponsors); err != nil {
		t.Fatal(err)
	}
	if len(sponsors) == 0 {
		t.Skip("no sponsors on this dataset")
	}
	id, _ := sponsors[0]["id"].(string)

	status, body = call(t, api, http.MethodGet, doc+"/sponsors/"+id, "")
	if status != http.StatusOK || !strings.Contains(body, `"`+id+`"`) {
		t.Errorf("element = %d %s", status, body)
	}

	status, _ = call(t, api, http.MethodGet, doc+"/sponsors/no-such-sponsor", "")
	if status != http.StatusNotFound {
		t.Errorf("unknown element = %d, want 404", status)
	}
	status, _ = call(t, api, http.MethodGet, doc+"/not-a-collection", "")
	if status != http.StatusNotFound {
		t.Errorf("unknown collection = %d, want 404", status)
	}
	status, _ = call(t, api, http.MethodGet, "/api/v1/datasets/events/nope.json", "")
	if status != http.StatusNotFound {
		t.Errorf("unknown document = %d, want 404", status)
	}
	status, _ = call(t, api, http.MethodGet, "/api/v1/datasets/events/no-extension", "")
	if status != http.StatusBadRequest {
		t.Errorf("path with no .json = %d, want 400", status)
	}
}

// A write has to land on disk in the form the archive expects, and be readable
// by the thing that reads the archive.
func TestAPIWritesRoundTripThroughDisk(t *testing.T) {
	api, dataDir, _ := newAPI(t)
	const rel = "events/drupalcon/eu/2026-rotterdam.json"
	const doc = "/api/v1/datasets/" + rel

	before, err := os.ReadFile(filepath.Join(dataDir, rel))
	if err != nil {
		t.Fatal(err)
	}
	parsedBefore, _ := js.ParseJSON(before)
	sponsorsBefore := len(ResolveArray(parsedBefore, []string{"event", "sponsors"}).Items())

	// A schema-complete sponsor: the event schema requires row, priority, image,
	// imageAlt, bgStyle, aspect and enabled, and a thinner body is correctly
	// refused by both implementations.
	const sponsor = `{"title":"Test Sponsor Ltd","tier":"Gold","link":"https://example.org",` +
		`"row":1,"priority":10,"image":"./img/x.png","imageAlt":"Test logo",` +
		`"bgStyle":"auto","aspect":"auto","enabled":true}`
	status, body := call(t, api, http.MethodPost, doc+"/sponsors", sponsor)
	if status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	// Sponsors key off a slug of the title, not a random id.
	if created["id"] != "test-sponsor-ltd" {
		t.Errorf("minted id = %v, want the title slug", created["id"])
	}

	after, err := os.ReadFile(filepath.Join(dataDir, rel))
	if err != nil {
		t.Fatal(err)
	}
	parsedAfter, err := js.ParseJSON(after)
	if err != nil {
		t.Fatalf("the written document does not parse: %v", err)
	}
	if got := len(ResolveArray(parsedAfter, []string{"event", "sponsors"}).Items()); got != sponsorsBefore+1 {
		t.Errorf("sponsors on disk = %d, want %d", got, sponsorsBefore+1)
	}
	// Written the way the API writes: two-space, trailing newline.
	if !strings.HasSuffix(string(after), "}\n") || !strings.Contains(string(after), "\n  \"event\"") {
		t.Error("the file is not in the API's format")
	}

	// Replace, then delete, then confirm it is gone.
	status, body = call(t, api, http.MethodPut, doc+"/sponsors/test-sponsor-ltd",
		strings.Replace(strings.Replace(sponsor, "Test Sponsor Ltd", "Renamed Sponsor", 1),
			`"tier":"Gold"`, `"tier":"Platinum"`, 1))
	if status != http.StatusOK || !strings.Contains(body, "Renamed Sponsor") {
		t.Fatalf("replace = %d %s", status, body)
	}
	if !strings.Contains(body, `"id":"test-sponsor-ltd"`) {
		t.Error("the id is the address and must survive a replace")
	}

	status, _ = call(t, api, http.MethodDelete, doc+"/sponsors/test-sponsor-ltd", "")
	if status != http.StatusOK {
		t.Fatalf("delete = %d", status)
	}
	status, _ = call(t, api, http.MethodGet, doc+"/sponsors/test-sponsor-ltd", "")
	if status != http.StatusNotFound {
		t.Errorf("after delete = %d, want 404", status)
	}

	// And the datasets still validate — the whole point of persisting through a
	// validator.
	final, _ := os.ReadFile(filepath.Join(dataDir, rel))
	document, _ := js.ParseJSON(final)
	if result := schema.LoadSchemas(filepath.Join(ts.RepoRoot(t), "app")).Datasets.Validate(document); !result.Valid {
		t.Errorf("the dataset no longer validates: %s", firstValidationError(result))
	}
}

// A write that would break the schema must be refused, and must not touch the
// file. This is the guard the whole validation slice exists for.
func TestAPIRefusesAWriteThatBreaksTheSchema(t *testing.T) {
	api, dataDir, _ := newAPI(t)
	const rel = "events/drupalcon/eu/2026-rotterdam.json"

	before, err := os.ReadFile(filepath.Join(dataDir, rel))
	if err != nil {
		t.Fatal(err)
	}

	status, body := call(t, api, http.MethodPut, "/api/v1/datasets/"+rel,
		`{"event":{"designation":42},"items":"not an array"}`)
	if status != 422 {
		t.Fatalf("invalid document = %d %s", status, body)
	}
	if !strings.Contains(body, "validation_failed") || !strings.Contains(body, `"errors"`) {
		t.Errorf("the refusal should say why: %s", body)
	}

	after, _ := os.ReadFile(filepath.Join(dataDir, rel))
	if string(after) != string(before) {
		t.Error("the file was modified by a write that was refused")
	}
}

func TestAPIMethodRulesOnCollections(t *testing.T) {
	api, _, _ := newAPI(t)
	const doc = "/api/v1/datasets/events/drupalcon/eu/2026-rotterdam.json"

	status, _ := call(t, api, http.MethodPut, doc+"/sponsors", `{"title":"x"}`)
	if status != http.StatusMethodNotAllowed {
		t.Errorf("PUT a whole collection = %d, want 405", status)
	}
	status, _ = call(t, api, http.MethodPost, doc+"/sponsors/some-id", `{"title":"x"}`)
	if status != http.StatusMethodNotAllowed {
		t.Errorf("POST to an element = %d, want 405", status)
	}
	status, _ = call(t, api, http.MethodDelete, doc+"/sponsors", "")
	if status != http.StatusMethodNotAllowed {
		t.Errorf("DELETE a whole collection = %d, want 405", status)
	}
	status, _ = call(t, api, http.MethodPost, doc+"/sponsors", `["not","an","object"]`)
	if status != http.StatusBadRequest {
		t.Errorf("an array body = %d, want 400", status)
	}
	status, _ = call(t, api, http.MethodPost, doc+"/sponsors", `{not json`)
	if status != http.StatusBadRequest {
		t.Errorf("malformed JSON = %d, want 400", status)
	}
}

// /validate answers 200 whether or not the document is valid: the request
// succeeded, and the verdict is in the body.
func TestValidateEndpointMatchesNode(t *testing.T) {
	api, dataDir, _ := newAPI(t)

	good, err := os.ReadFile(filepath.Join(dataDir, "events/drupalcon/eu/2026-rotterdam.json"))
	if err != nil {
		t.Fatal(err)
	}

	status, body := call(t, api, http.MethodPost, "/api/v1/validate", string(good))
	if status != http.StatusOK {
		t.Fatalf("valid document = %d", status)
	}
	var response map[string]any
	if err := json.Unmarshal([]byte(body), &response); err != nil {
		t.Fatal(err)
	}
	if response["valid"] != true || response["domain"] != "datasets" {
		t.Errorf("response = %v", response)
	}

	// The fingerprint is what a data repo pins, so it must be the JavaScript's.
	if _, err := exec.LookPath("node"); err == nil {
		want := strings.TrimSpace(ts.RunNode(t, nil, `
			const { DATASET_SCHEMA_FINGERPRINT } = await import('./lib/validateDataset.js');
			process.stdout.write(DATASET_SCHEMA_FINGERPRINT);
		`))
		if response["schemaFingerprint"] != want {
			t.Errorf("schemaFingerprint = %v, node = %q", response["schemaFingerprint"], want)
		}
	}

	// An invalid document is still a 200 — the verdict is the payload.
	status, body = call(t, api, http.MethodPost, "/api/v1/validate", `{"event":{"designation":42}}`)
	if status != http.StatusOK {
		t.Fatalf("invalid document = %d, want 200 with valid:false", status)
	}
	if !strings.Contains(body, `"valid":false`) || !strings.Contains(body, `"errors"`) {
		t.Errorf("response = %s", body)
	}

	status, _ = call(t, api, http.MethodPost, "/api/v1/validate?domain=nope", `{}`)
	if status != http.StatusBadRequest {
		t.Errorf("unknown domain = %d, want 400", status)
	}
	status, _ = call(t, api, http.MethodPost, "/api/v1/validate", "")
	if status != http.StatusBadRequest {
		t.Errorf("empty body = %d, want 400", status)
	}
}

func TestAPIAuthorization(t *testing.T) {
	api, _, _ := newAPI(t)
	// Reads need viewer, writes need editor — so a viewer-only caller may read
	// and may not write.
	api.Authorize = func(r *http.Request, minRole string) bool { return minRole == "viewer" }

	const doc = "/api/v1/datasets/events/drupalcon/eu/2026-rotterdam.json"
	if status, _ := call(t, api, http.MethodGet, doc, ""); status != http.StatusOK {
		t.Errorf("viewer read = %d, want 200", status)
	}
	if status, _ := call(t, api, http.MethodPost, doc+"/sponsors", `{"title":"x"}`); status != http.StatusUnauthorized {
		t.Errorf("viewer write = %d, want 401", status)
	}

	api.Authorize = func(*http.Request, string) bool { return false }
	if status, _ := call(t, api, http.MethodGet, doc, ""); status != http.StatusUnauthorized {
		t.Errorf("anonymous read = %d, want 401", status)
	}
	if status, _ := call(t, api, http.MethodGet, "/api/v1/datasets", ""); status != http.StatusUnauthorized {
		t.Errorf("anonymous list = %d, want 401", status)
	}
}

func TestAPIListsDocuments(t *testing.T) {
	api, _, _ := newAPI(t)
	status, body := call(t, api, http.MethodGet, "/api/v1/datasets", "")
	if status != http.StatusOK {
		t.Fatalf("list = %d", status)
	}
	var documents []string
	if err := json.Unmarshal([]byte(body), &documents); err != nil {
		t.Fatal(err)
	}
	// Every .json under the store's root, which is the data root — so the
	// generated caches (catalog.json, geocache.json) are in the list too. The
	// count is derived from disk rather than written down, so adding a dataset to
	// the fixture does not mean editing a number here.
	if want := countFixtureDocuments(t); len(documents) != want {
		t.Errorf("listed %d documents, the fixture has %d:\n%v", len(documents), want, documents)
	}
	for i := 1; i < len(documents); i++ {
		if documents[i-1] > documents[i] {
			t.Fatal("the list is not sorted")
		}
	}
}

// A planner document is written through the permissive planner schema, and the
// generic engine handles its nested collections the same way.
func TestAPIHandlesPlannerCollections(t *testing.T) {
	api, _, plannerRoot := newAPI(t)
	if err := os.WriteFile(filepath.Join(plannerRoot, "p.json"),
		[]byte(`{"_id":"abc","_displayName":"Trip"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	status, body := call(t, api, http.MethodPost, "/api/v1/planners/p.json/personal/itinerary",
		`{"title":"Coffee","date":"2026-09-28"}`)
	if status != http.StatusCreated {
		t.Fatalf("create = %d %s", status, body)
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(body), &created); err != nil {
		t.Fatal(err)
	}
	// Planner collections mint a prefixed random id, not a slug.
	id, _ := created["id"].(string)
	if !strings.HasPrefix(id, "it_") {
		t.Errorf("minted id = %q, want an it_ prefix", id)
	}

	// EnsureArray built `personal` on a document that had no such field.
	status, body = call(t, api, http.MethodGet, "/api/v1/planners/p.json/personal/itinerary", "")
	if status != http.StatusOK || !strings.Contains(body, "Coffee") {
		t.Errorf("collection = %d %s", status, body)
	}
}

// countFixtureDocuments counts every JSON document the dataset store can see.
func countFixtureDocuments(t *testing.T) int {
	t.Helper()
	paths, err := paths.DatasetFiles(ts.ArchiveDir(t))
	if err != nil {
		t.Fatal(err)
	}
	return len(paths)
}

// firstValidationError is the first message from a validation result, for a
// test that reports which rule refused a document.
func firstValidationError(result schema.ValidationResult) string {
	if len(result.Errors) == 0 {
		return ""
	}
	return strings.TrimSpace(result.Errors[0].Path + " " + result.Errors[0].Message)
}
