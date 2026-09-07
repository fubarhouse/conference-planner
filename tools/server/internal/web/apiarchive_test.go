package web

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/archive/curation"
	"server/internal/auth"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// apiTestApp builds the assembled server with the archive API wired in, over a
// data directory and a private root the caller controls.
func apiTestApp(t *testing.T, dataDir, privateRoot string) *httptest.Server {
	t.Helper()
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen, Signer: auth.NewSessionSigner("test-secret")}
	archive := &ArchiveAPI{
		DataDir:   dataDir,
		ImgDir:    filepath.Join(dataDir, "img"),
		Decisions: &curation.DecisionStore{CurationRoot: filepath.Join(privateRoot, "curation")},
		Albums:    &AlbumResolver{DataDir: dataDir},
		// Fixed so the coverage report's "is this snooze expired" question has a
		// stable answer between the two servers.
		Now: func() time.Time { return time.Now() },
	}
	server := httptest.NewServer(NewApp(AppConfig{
		Mounts: []Mount{
			{Prefix: "/data", Dir: dataDir},
			{Prefix: "/img", Dir: filepath.Join(dataDir, "img")},
		},
		Mode:          auth.ModeOpen,
		Authenticator: authenticator,
		Archive:       archive,
		Pages: &PageServer{
			AppRoot:    appRoot,
			Provenance: NewProvenance(appRoot, func(string) string { return "" }),
		},
		Login: &auth.LoginService{Mode: auth.ModeOpen, Signer: authenticator.Signer,
			AppRoot: appRoot, Limiter: auth.NewLoginRateLimiter()},
	}))
	t.Cleanup(server.Close)
	return server
}

// The read endpoints, compared against Express body for body over the real
// archive. These are the answers the archive page is drawn from.
func TestArchiveAPIMatchesTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	private := t.TempDir()
	nodeBase := ts.ReferenceBase(t, dataDir, private)
	goServer := apiTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 60 * time.Second}

	paths := []string{
		"/api/health",
		"/api/archive/sessions?q=drupal",
		"/api/archive/sessions?q=drupal&limit=5",
		"/api/archive/sessions?q=drupal&limit=5&offset=3",
		"/api/archive/sessions?q=ai&mode=contains",
		"/api/archive/sessions?q=&video=1&limit=4",
		"/api/archive/sessions?q=accessibility&series=DrupalCon",
		// The clamps: a page size beyond the ceiling, a negative offset, and a
		// value that is not a number at all.
		"/api/archive/sessions?q=drupal&limit=99999",
		"/api/archive/sessions?q=drupal&limit=-5",
		"/api/archive/sessions?q=drupal&limit=abc",
		"/api/archive/topic?term=performance",
		"/api/archive/topic?term=layout%20builder",
		"/api/archive/topic?term=performance&year=2024",
		"/api/archive/topic?term=",
		"/api/archive/cospeakers?name=Nobody%20At%20All",
		"/api/curation/coverage",
		"/api/curation/series",
		"/api/curation/suggestions",
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "api_"+ts.ResponseKey(path), func() ts.Response {
				return getBody(t, client, nodeBase+path)
			})
			got := getBody(t, client, goServer.URL+path)
			if got.Status != want.Status {
				t.Fatalf("status = %d, node = %d\n%s", got.Status, want.Status, got.Body)
			}
			if string(ts.WithoutStamps(got.Body)) != string(ts.WithoutStamps(want.Body)) {
				t.Errorf("body differs (%d vs node's %d):\n%s", len(got.Body), len(want.Body),
					ts.FirstDifference(string(ts.WithoutStamps(got.Body)), string(ts.WithoutStamps(want.Body))))
			}
		})
	}
}

// The two expensive builds get their own test: they are slow, and a mismatch in
// them is a mismatch in the whole archive page.
//
// ⚠ THE TWO RECORDINGS NO LONGER MEAN THE SAME THING. /api/curation/clusters is
// still what Node answered. /api/archive/insights is NOT: the payload has since
// grown fields Node never had (the register measure, per-year videos/albums),
// and Node is deleted, so its recording could never grow them. That recording
// was re-made from the Go server and is now a RECORDED ANSWER — it catches an
// unintended change to the payload, it does not prove parity with anything.
//
// Re-recording it needs the Go server rather than -update-golden, which still
// tries to boot the reference and dies on the deleted lib/.
func TestArchiveInsightsAndClustersMatchNode(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	private := t.TempDir()
	nodeBase := ts.ReferenceBase(t, dataDir, private)
	goServer := apiTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 120 * time.Second}

	for _, path := range []string{"/api/archive/insights", "/api/curation/clusters"} {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "api_"+ts.ResponseKey(path), func() ts.Response {
				return getBody(t, client, nodeBase+path)
			})
			got := getBody(t, client, goServer.URL+path)
			if got.Status != want.Status {
				t.Fatalf("status = %d, node = %d\n%.400s", got.Status, want.Status, got.Body)
			}
			if string(ts.WithoutStamps(got.Body)) != string(ts.WithoutStamps(want.Body)) {
				t.Errorf("body differs (%d vs node's %d):\n%s", len(got.Body), len(want.Body),
					ts.FirstDifference(string(ts.WithoutStamps(got.Body)), string(ts.WithoutStamps(want.Body))))
			}
		})
	}

	// The memo: the same version must not be rebuilt, and must say so.
	first := getBody(t, client, goServer.URL+"/api/archive/insights")
	second := getBody(t, client, goServer.URL+"/api/archive/insights")
	if first.Headers["X-Cache"] != "miss" && first.Headers["X-Cache"] != "hit" {
		t.Errorf("X-Cache = %q", first.Headers["X-Cache"])
	}
	if second.Headers["X-Cache"] != "hit" {
		t.Errorf("a second request should be a memo hit, got %q", second.Headers["X-Cache"])
	}
	if !bytes.Equal(first.Body, second.Body) {
		t.Error("the memo returned a different payload for the same version")
	}
	if second.Headers["X-Curation-Version"] == "" {
		t.Error("the response should name the curation version it was built at")
	}
}

// A decision must move the curation version, or a client holding a `?v=` URL
// keeps reading the archive as it was before they made it.
func TestADecisionInvalidatesTheInsightsMemo(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	dataDir := ts.CopyArchive(t, source)
	goServer := apiTestApp(t, dataDir, t.TempDir())
	client := &http.Client{Timeout: 120 * time.Second}

	before := getBody(t, client, goServer.URL+"/api/archive/insights")
	beforeVersion := before.Headers["X-Curation-Version"]

	// Merge two spellings. The response carries the version the client should now
	// be reading at.
	merged := postJSON(t, client, goServer.URL+"/api/curation/merge",
		`{"name":"gábor hojtsy","canonical":"Gábor Hojtsy"}`)
	if merged.Status != 200 {
		t.Fatalf("merge = %d: %s", merged.Status, merged.Body)
	}
	if !strings.Contains(string(merged.Body), `"version"`) {
		t.Fatalf("merge did not return a version: %s", merged.Body)
	}

	after := getBody(t, client, goServer.URL+"/api/archive/insights")
	if after.Headers["X-Curation-Version"] == beforeVersion {
		t.Error("a merge did not move the curation version")
	}
	if after.Headers["X-Cache"] != "miss" {
		t.Errorf("a merge should invalidate the memo, X-Cache = %q", after.Headers["X-Cache"])
	}
	if bytes.Equal(before.Body, after.Body) {
		t.Error("the payload did not change after a merge")
	}
}

// The write endpoints, and the ledger they leave behind.
func TestCurationWritesProduceAStableLedger(t *testing.T) {
	dataDir := t.TempDir()
	private := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"),
		`{"generatedAt":"2026-01-01T00:00:00.000Z","events":[{"file":"events/e.json"}]}`)
	writeFile(t, filepath.Join(dataDir, "events", "e.json"),
		`{"event":{"designation":"DrupalCamp","year":2024},"items":[]}`)

	goServer := apiTestApp(t, dataDir, private)
	client := &http.Client{Timeout: 30 * time.Second}

	steps := []struct {
		name, path, payload string
		want                int
	}{
		{"merge", "/api/curation/merge", `{"key":"abc","canonical":"Real Name"}`, 200},
		{"merge needs a canonical", "/api/curation/merge", `{"key":"abc"}`, 400},
		{"distinct", "/api/curation/distinct", `{"key":"two-people"}`, 200},
		{"distinct needs a key", "/api/curation/distinct", `{}`, 400},
		{"series", "/api/curation/series", `{"file":"events/e.json","series":"DrupalSouth"}`, 200},
		// Only a real event may be mapped, so a typo cannot quietly create a
		// lineage entry for a dataset that does not exist.
		{"series refuses an unknown file", "/api/curation/series",
			`{"file":"events/nope.json","series":"X"}`, 400},
		{"coverage snooze", "/api/curation/coverage",
			`{"file":"events/e.json","check":"speakers","state":"later","until":"2027-01-01"}`, 200},
		{"coverage rejects a bad state", "/api/curation/coverage",
			`{"file":"events/e.json","check":"speakers","state":"nonsense"}`, 400},
		{"undo", "/api/curation/undo", `{"type":"distinct","key":"two-people"}`, 200},
	}
	for _, step := range steps {
		t.Run(step.name, func(t *testing.T) {
			resp := postJSON(t, client, goServer.URL+step.path, step.payload)
			if resp.Status != step.want {
				t.Errorf("status = %d, want %d: %s", resp.Status, step.want, resp.Body)
			}
		})
	}

	// The ledger on disk.
	//
	// This used to hand the file to lib/archiveAudit.js and compare what it
	// parsed. That was a real cross-implementation property while both servers
	// were writing this file in turn, and it is not one that can outlive the
	// implementation it compared against — recorded as a reference answer it
	// would replay the same summary forever, whatever this code went on to
	// write. So the format is pinned here directly, which is what the round trip
	// was checking underneath.
	ledgerPath := filepath.Join(private, "curation", "decisions.json")
	raw, err := os.ReadFile(ledgerPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(raw), "}\n") {
		t.Error("the ledger should end with a newline")
	}

	ledger := curation.ParseLedger(string(raw))
	checks := []struct {
		what string
		got  string
		want string
	}{
		{"the alias landed", ledger.Aliases.Get("abc").StrVal(), "Real Name"},
		{"the series lineage", ledger.Series.Get("events/e.json").StrVal(), "DrupalSouth"},
		{"the snooze", ledger.Snoozes.Get(archive.SnoozeKey("events/e.json", "speakers")).
			Get("state").StrVal(), "later"},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s: got %q, want %q\n%s", check.what, check.got, check.want, raw)
		}
	}
	// The undo took the distinct ruling back out.
	if keys := ledger.DistinctKeys(); len(keys) != 0 {
		t.Errorf("distinct = %v, want none after the undo", keys)
	}
	// Byte-stable through the serialiser: two writers taking turns on this file
	// must not reformat it back and forth.
	if rewritten := ledger.Serialize(); rewritten != string(raw) {
		t.Errorf("the ledger is not stable through a round trip:\n got %s\nwant %s",
			rewritten, raw)
	}
}

// The allowlist is the only thing stopping this endpoint fetching a URL of the
// caller's choosing.
func TestAlbumThumbRefusesUnknownAlbums(t *testing.T) {
	dataDir := t.TempDir()
	writeFile(t, filepath.Join(dataDir, "catalog.json"), `{"events":[]}`)
	writeFile(t, filepath.Join(dataDir, "events", "e.json"),
		`{"event":{"flickr":{"groupUrl":"https://flickr.com/groups/known"}}}`)

	goServer := apiTestApp(t, dataDir, t.TempDir())
	client := &http.Client{Timeout: 30 * time.Second}

	for _, url := range []string{
		"https://evil.example/ssrf",
		"http://169.254.169.254/latest/meta-data/",
		"",
	} {
		resp := getBody(t, client, goServer.URL+"/api/archive/album-thumb?url="+
			strings.ReplaceAll(url, "&", "%26"))
		if resp.Status != http.StatusBadRequest {
			t.Errorf("%q was not refused: %d %s", url, resp.Status, resp.Body)
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func getBody(t *testing.T, client *http.Client, url string) ts.Response {
	t.Helper()
	return fetchHeaders(t, client, url, []string{"X-Cache", "X-Curation-Version",
		"Cache-Control", "Content-Type"})
}

func postJSON(t *testing.T, client *http.Client, url, body string) ts.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return ts.Response{Status: resp.StatusCode, Body: payload, Headers: map[string]string{
		"Content-Type": resp.Header.Get("Content-Type"),
	}}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}
