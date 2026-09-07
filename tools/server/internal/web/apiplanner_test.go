package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/auth"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/planner"
	"server/internal/schema"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// plannerTestApp wires the planner and dataset routes over disk only — no S3,
// which is the configuration a laptop and a fresh deployment both run in.
func plannerTestApp(t *testing.T, dataDir, privateRoot string) *httptest.Server {
	t.Helper()
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen, Signer: auth.NewSessionSigner("test-secret")}
	schemas := schema.LoadSchemas(appRoot)
	plannerDir := filepath.Join(privateRoot, "planner")

	server := httptest.NewServer(NewApp(AppConfig{
		Mounts:        []Mount{{Prefix: "/data", Dir: dataDir}},
		Mode:          auth.ModeOpen,
		Authenticator: authenticator,
		Planner: &PlannerAPI{
			DataDir: dataDir,
			Schemas: schemas,
			Planners: func(*http.Request) *planner.PlannerStore {
				return &planner.PlannerStore{LocalDir: plannerDir, Schema: schemas.Planners}
			},
		},
		Login: &auth.LoginService{Mode: auth.ModeOpen, Signer: authenticator.Signer,
			AppRoot: appRoot, Limiter: auth.NewLoginRateLimiter()},
	}))
	t.Cleanup(server.Close)
	return server
}

// The dataset reads, compared against Express over the real archive.
func TestDatasetRoutesMatchTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	private := t.TempDir()
	nodeBase := ts.ReferenceBase(t, dataDir, private)
	goServer := plannerTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 60 * time.Second}

	for _, path := range []string{
		"/api/meta",
		"/api/data/catalog.json",
		"/api/data/events/drupalcon/eu/2026-rotterdam.json",
		"/api/data/nope.json",
		"/api/data/../server.js",
		"/api/planner",
	} {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "planner_"+ts.ResponseKey(path), func() ts.Response {
				return getBody(t, client, nodeBase+path)
			})
			got := getBody(t, client, goServer.URL+path)
			if got.Status != want.Status {
				t.Fatalf("status = %d, node = %d\n%.200s", got.Status, want.Status, got.Body)
			}
			if string(ts.WithoutStamps(got.Body)) != string(ts.WithoutStamps(want.Body)) {
				t.Errorf("body differs (%d vs node's %d):\n%s", len(got.Body), len(want.Body),
					ts.FirstDifference(string(ts.WithoutStamps(got.Body)), string(ts.WithoutStamps(want.Body))))
			}
		})
	}
}

// A dataset write must be schema-validated, not merely parsed — the bug that
// motivated it wrote `"startDate": "2025-13-28T25:00:00Z"` happily and failed in
// CI after it had been committed.
func TestDatasetWriteValidatesAgainstTheSchema(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"), `{"events":[]}`)
	goServer := plannerTestApp(t, dataDir, t.TempDir())
	client := &http.Client{Timeout: 30 * time.Second}

	// A REAL dataset, not a hand-built one. The event schema requires twelve
	// properties on `event` alone and types several of them as objects, so a
	// fixture written from memory tests my reading of the schema rather than the
	// route — and the thing worth proving here is that a valid document lands
	// byte-identically.
	valid := aRealDataset(t)

	cases := []struct {
		name, path, payload string
		want                int
		expect              string
	}{
		{"a valid dataset", "/api/data/events/new.json", valid, 200, `"ok":true`},
		{"an impossible date", "/api/data/events/bad.json",
			withBadDate(t, valid), 422, "validation_failed"},
		{"not JSON at all", "/api/data/events/broken.json", `{nope`, 400, ""},
		{"not a .json path", "/api/data/events/thing.txt", valid, 400, "JSON files only"},
		{"a traversal", "/api/data/../../escape.json", valid, 400, ""},
		// Generated caches have no authored schema, so they are written
		// unvalidated rather than rejected.
		{"a generated cache", "/api/data/geocache.json", `{"anything":true}`, 200, `"ok":true`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resp := putJSON(t, client, goServer.URL+testCase.path, testCase.payload)
			if resp.Status != testCase.want {
				t.Errorf("status = %d, want %d: %.300s", resp.Status, testCase.want, resp.Body)
			}
			if testCase.expect != "" && !strings.Contains(string(resp.Body), testCase.expect) {
				t.Errorf("body %.300s does not contain %q", resp.Body, testCase.expect)
			}
		})
	}

	// The impossible date must not have reached the disk.
	if _, err := os.Stat(filepath.Join(dataDir, "events", "bad.json")); err == nil {
		t.Error("a dataset the schema rejected was written anyway")
	}
	// Nor must the traversal have escaped the data root.
	if _, err := os.Stat(filepath.Join(filepath.Dir(dataDir), "escape.json")); err == nil {
		t.Error("a traversal escaped the data root")
	}
	// The valid one did land, byte for byte — its formatting is part of the
	// dataset and the server must not re-encode it.
	written, err := os.ReadFile(filepath.Join(dataDir, "events", "new.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(written) != valid {
		t.Errorf("the dataset was rewritten:\n got %s\nwant %s", written, valid)
	}
}

// The planner lifecycle end to end, on disk.
func TestPlannerRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	private := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"), `{"events":[]}`)
	goServer := plannerTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 30 * time.Second}

	// A fresh install has written no planner, and the honest answer is "none",
	// not a 500 — and NOT a created directory, because this path exists to
	// support a read-only filesystem.
	list := getBody(t, client, goServer.URL+"/api/planner")
	if list.Status != 200 || strings.TrimSpace(string(list.Body)) != "[]" {
		t.Errorf("empty list = %d %s", list.Status, list.Body)
	}
	if _, err := os.Stat(filepath.Join(private, "planner")); err == nil {
		t.Error("a read created the planner directory")
	}

	planner := `{"id":"trip","name":"A trip","schemaVersion":5}`
	if resp := putJSON(t, client, goServer.URL+"/api/planner/trip.json", planner); resp.Status != 200 {
		t.Fatalf("write = %d: %s", resp.Status, resp.Body)
	}

	read := getBody(t, client, goServer.URL+"/api/planner/trip.json")
	if read.Status != 200 || string(read.Body) != planner {
		t.Errorf("read = %d %s", read.Status, read.Body)
	}

	list = getBody(t, client, goServer.URL+"/api/planner")
	if !strings.Contains(string(list.Body), `"trip.json"`) {
		t.Errorf("list = %s", list.Body)
	}

	// Missing, and not-a-json, are distinguishable failures.
	if missing := getBody(t, client, goServer.URL+"/api/planner/nope.json"); missing.Status != 404 {
		t.Errorf("missing = %d %s", missing.Status, missing.Body)
	}
	if bad := getBody(t, client, goServer.URL+"/api/planner/trip.txt"); bad.Status != 400 {
		t.Errorf("non-json = %d %s", bad.Status, bad.Body)
	}

	if resp := deleteURL(t, client, goServer.URL+"/api/planner/trip.json"); resp.Status != 200 {
		t.Errorf("delete = %d %s", resp.Status, resp.Body)
	}
	if after := getBody(t, client, goServer.URL+"/api/planner/trip.json"); after.Status != 404 {
		t.Errorf("after delete = %d", after.Status)
	}
	if resp := deleteURL(t, client, goServer.URL+"/api/planner/trip.json"); resp.Status != 404 {
		t.Errorf("deleting twice = %d", resp.Status)
	}
}

// The subscription tokens, through the routes. The plaintext is returned once
// and never stored, so a revoked link must stop working immediately.
func TestFeedTokenRoutes(t *testing.T) {
	dataDir := t.TempDir()
	private := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"), `{"events":[]}`)
	goServer := plannerTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 30 * time.Second}

	if resp := putJSON(t, client, goServer.URL+"/api/planner/trip.json",
		`{"id":"trip","name":"A trip","schemaVersion":5}`); resp.Status != 200 {
		t.Fatalf("planner write = %d: %s", resp.Status, resp.Body)
	}

	created := postJSON(t, client, goServer.URL+"/api/planner/trip/feeds", `{"label":"Phone"}`)
	if created.Status != 200 {
		t.Fatalf("create = %d: %s", created.Status, created.Body)
	}
	var feed struct{ ID, Token, Label, URL, Note string }
	if err := json.Unmarshal(created.Body, &feed); err != nil {
		t.Fatal(err)
	}
	if len(feed.Token) != 64 || feed.ID == "" || feed.Label != "Phone" {
		t.Fatalf("feed = %+v", feed)
	}
	if !strings.Contains(feed.URL, "/planner/trip/calendar.ics?k="+feed.Token) {
		t.Errorf("url = %q", feed.URL)
	}

	// The plaintext must not be in the stored document — only its hash.
	stored, err := os.ReadFile(filepath.Join(private, "planner", "trip.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), feed.Token) {
		t.Error("the plaintext token was written to disk")
	}

	listed := getBody(t, client, goServer.URL+"/api/planner/trip/feeds")
	if !strings.Contains(string(listed.Body), feed.ID) {
		t.Errorf("list = %s", listed.Body)
	}
	if strings.Contains(string(listed.Body), "hash") {
		t.Errorf("the listing leaked a hash: %s", listed.Body)
	}

	if resp := deleteURL(t, client, goServer.URL+"/api/planner/trip/feeds/"+feed.ID); resp.Status != 200 {
		t.Errorf("revoke = %d %s", resp.Status, resp.Body)
	}
	if resp := deleteURL(t, client, goServer.URL+"/api/planner/trip/feeds/"+feed.ID); resp.Status != 404 {
		t.Errorf("revoking twice = %d", resp.Status)
	}
	// A planner nobody has must answer the same as a wrong slug: never confirm
	// which trips exist.
	if resp := getBody(t, client, goServer.URL+"/api/planner/no-such-trip/feeds"); resp.Status != 404 {
		t.Errorf("unknown planner = %d %s", resp.Status, resp.Body)
	}
}

// A planner that fails the schema must not be stored.
func TestPlannerWriteValidates(t *testing.T) {
	dataDir := t.TempDir()
	private := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"), `{"events":[]}`)
	goServer := plannerTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 30 * time.Second}

	// The planner schema is deliberately permissive — `additionalProperties` is
	// true and almost nothing is required, because a planner grows fields as the
	// product does. `_version` is one of the few it types, so that is what a
	// violation has to be built from.
	resp := putJSON(t, client, goServer.URL+"/api/planner/bad.json",
		`{"_version":"not a number","isConference":"also not a boolean"}`)
	if resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("status = %d, want 422: %s", resp.Status, resp.Body)
	}
	if !strings.Contains(string(resp.Body), "validation_failed") {
		t.Errorf("body = %s", resp.Body)
	}
	if _, err := os.Stat(filepath.Join(private, "planner", "bad.json")); err == nil {
		t.Error("a planner the schema rejected was written anyway")
	}
}

// The per-path schema dispatch, compared against the JavaScript that owns it.
func TestValidateDataFileDispatchMatchesNode(t *testing.T) {
	schemas := schema.LoadSchemas(filepath.Join(ts.RepoRoot(t), "app"))
	cases := []struct {
		path, body string
	}{
		{"catalog.json", `{"anything":true}`},
		{"geocache.json", `{"anything":true}`},
		{"album-thumbs.json", `{"anything":true}`},
		{"events/x.json", `{"event":{"designation":"X"},"items":[]}`},
		{"events/deep/y.json", `{"nope":true}`},
		{"themes.json", `{"nope":true}`},
		{"sponsors.json", `{"nope":true}`},
	}
	payload := js.Arr()
	for _, testCase := range cases {
		payload.Append(js.Obj().Set("path", js.Str(testCase.path)).Set("body", js.Str(testCase.body)))
	}
	out := ts.RunNode(t, nil, `
		const { validateDataFile } = await import('./lib/validateDataFile.js');
		const cases = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(cases.map(({ path, body }) => {
			const r = validateDataFile(path, JSON.parse(body));
			return { valid: r.valid, schema: r.schema, skipped: !!r.skipped };
		})));
	`, string(payload.Encode("")))

	var want []struct {
		Valid   bool   `json:"valid"`
		Schema  string `json:"schema"`
		Skipped bool   `json:"skipped"`
	}
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, testCase := range cases {
		parsed, err := js.ParseJSON([]byte(testCase.body))
		if err != nil {
			t.Fatal(err)
		}
		got := schemas.ValidateDataFile(testCase.path, parsed)
		if got.Valid != want[i].Valid {
			t.Errorf("%s: valid = %v, node = %v (%s)",
				testCase.path, got.Valid, want[i].Valid, got.ValidationResult)
		}
		if got.Skipped != want[i].Skipped {
			t.Errorf("%s: skipped = %v, node = %v", testCase.path, got.Skipped, want[i].Skipped)
		}
		if got.Schema != want[i].Schema {
			t.Errorf("%s: schema = %q, node = %q", testCase.path, got.Schema, want[i].Schema)
		}
	}
}

// The summary is shown to a person verbatim, so its shape is compared too.
func TestSummarizeErrorsMatchesNode(t *testing.T) {
	sets := [][]schema.ValidationError{
		{},
		{{Path: "event.year", Message: "must be string"}},
		{{Path: "", Message: "must have required property 'event'"}},
		{
			{Path: "a", Message: "one"}, {Path: "b", Message: "two"},
			{Path: "c", Message: "three"}, {Path: "d", Message: "four"},
			{Path: "e", Message: "five"},
		},
	}
	payload := js.Arr()
	for _, set := range sets {
		list := js.Arr()
		for _, item := range set {
			list.Append(js.Obj().Set("path", js.Str(item.Path)).Set("message", js.Str(item.Message)))
		}
		payload.Append(list)
	}
	out := ts.RunNode(t, nil, `
		const { summarizeErrors } = await import('./lib/validateDataFile.js');
		const sets = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(sets.map(summarizeErrors)));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, set := range sets {
		if got := schema.SummarizeErrors(set); got != want[i] {
			t.Errorf("set %d: %q, node = %q", i, got, want[i])
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func putJSON(t *testing.T, client *http.Client, url, body string) ts.Response {
	t.Helper()
	return sendJSON(t, client, http.MethodPut, url, body)
}

func deleteURL(t *testing.T, client *http.Client, url string) ts.Response {
	t.Helper()
	return sendJSON(t, client, http.MethodDelete, url, "")
}

func sendJSON(t *testing.T, client *http.Client, method, url, body string) ts.Response {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return ts.Response{Status: resp.StatusCode, Body: payload,
		Headers: map[string]string{"Content-Type": resp.Header.Get("Content-Type")}}
}

// aRealDataset is one dataset from the archive, verbatim. Skips when there is no
// checkout to read one from.
func aRealDataset(t *testing.T) string {
	t.Helper()
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}
	paths, err := paths.DatasetFiles(filepath.Join(source, "events"))
	if err != nil || len(paths) == 0 {
		t.Skip("no datasets in this archive")
	}
	raw, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// withBadDate is that same dataset with one impossible timestamp in it — the
// exact defect that made this route validate rather than merely parse.
func withBadDate(t *testing.T, dataset string) string {
	t.Helper()
	parsed, err := js.ParseJSON([]byte(dataset))
	if err != nil {
		t.Fatal(err)
	}
	parsed.Get("event").Set("startDate", js.Str("2025-13-28T25:00:00Z"))
	return string(parsed.Encode("  "))
}
