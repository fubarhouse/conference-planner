package web

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/auth"
	"server/internal/storage"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// adminTestApp wires the sync surface against a stub bucket.
func adminTestApp(t *testing.T, root string, bucket *ts.MemoryStore, connectErr error) *httptest.Server {
	t.Helper()
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen, Signer: auth.NewSessionSigner("test-secret")}
	admin := &AdminAPI{
		Settings: storage.S3Settings{Bucket: "test-bucket", Region: "eu-west-1", Prefix: "content/"},
		Roots: storage.SyncRoots{
			Data:     filepath.Join(root, "data"),
			Img:      filepath.Join(root, "img"),
			Planners: filepath.Join(root, "planner"),
		},
		Manifest: filepath.Join(root, ".s3-manifest.json"),
		AppRoot:  appRoot,
		Connect: func(context.Context) (storage.ObjectStore, error) {
			if connectErr != nil {
				return nil, connectErr
			}
			return bucket, nil
		},
	}
	server := httptest.NewServer(NewApp(AppConfig{
		Mode:          auth.ModeOpen,
		Authenticator: authenticator,
		Admin:         admin,
		Login: &auth.LoginService{Mode: auth.ModeOpen, Signer: authenticator.Signer,
			AppRoot: appRoot, Limiter: auth.NewLoginRateLimiter()},
	}))
	t.Cleanup(server.Close)
	return server
}

func TestS3ConfigReportsTheEnvironment(t *testing.T) {
	server := adminTestApp(t, t.TempDir(), ts.NewMemoryStore(), nil)
	client := &http.Client{Timeout: 30 * time.Second}

	resp := getBody(t, client, server.URL+"/api/s3/config")
	var config struct {
		Bucket, Region, Prefix string
		Configured             bool
	}
	if err := json.Unmarshal(resp.Body, &config); err != nil {
		t.Fatal(err)
	}
	if config.Bucket != "test-bucket" || config.Region != "eu-west-1" ||
		config.Prefix != "content/" || !config.Configured {
		t.Errorf("= %+v", config)
	}
}

// A failed probe is a valid ANSWER, not a server error — that is what keeps sync
// optional and stops an unconfigured deployment looking broken.
func TestS3TestAlwaysAnswers200(t *testing.T) {
	client := &http.Client{Timeout: 30 * time.Second}

	working := adminTestApp(t, t.TempDir(), ts.NewMemoryStore(), nil)
	resp := getBody(t, client, working.URL+"/api/s3/test")
	if resp.Status != 200 || !strings.Contains(string(resp.Body), `"ok":true`) {
		t.Errorf("working bucket = %d %s", resp.Status, resp.Body)
	}

	broken := adminTestApp(t, t.TempDir(), nil, storage.ErrNoBucket)
	resp = getBody(t, client, broken.URL+"/api/s3/test")
	if resp.Status != 200 {
		t.Errorf("an unreachable bucket should still answer 200, got %d", resp.Status)
	}
	if !strings.Contains(string(resp.Body), `"ok":false`) {
		t.Errorf("= %s", resp.Body)
	}
	// The code is what the settings panel shows, so it must name the condition
	// rather than say "ERROR" for everything.
	if !strings.Contains(string(resp.Body), `"code":"NOT_CONFIGURED"`) {
		t.Errorf("code = %s", resp.Body)
	}
}

// Status is a dry run: it names the state of every file and moves none of them.
func TestS3StatusIsADryRun(t *testing.T) {
	root := t.TempDir()
	bucket := ts.NewMemoryStore()
	writeFile(t, filepath.Join(root, "data", "events", "local.json"), `{"only":"local"}`)
	bucket.Seed("content/data/events/remote.json", `{"only":"s3"}`)

	server := adminTestApp(t, root, bucket, nil)
	client := &http.Client{Timeout: 30 * time.Second}
	before := bucket.Snapshot()

	resp := getBody(t, client, server.URL+"/api/s3/status")
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	var states map[string]string
	if err := json.Unmarshal(resp.Body, &states); err != nil {
		t.Fatal(err)
	}
	if states["data/events/local.json"] != "local-only" {
		t.Errorf("local file = %q (%v)", states["data/events/local.json"], states)
	}
	if states["data/events/remote.json"] != "s3-only" {
		t.Errorf("remote file = %q (%v)", states["data/events/remote.json"], states)
	}

	// Nothing moved, in either direction.
	if len(bucket.Snapshot()) != len(before) {
		t.Error("a status changed the bucket")
	}
	if _, err := os.Stat(filepath.Join(root, "data", "events", "remote.json")); err == nil {
		t.Error("a status pulled a file")
	}
	// And no manifest was written: a dry run agrees to nothing.
	if _, err := os.Stat(filepath.Join(root, ".s3-manifest.json")); err == nil {
		t.Error("a status wrote the manifest")
	}
}

// Push and pull through the routes, against the stub bucket.
func TestS3PushAndPullRoutes(t *testing.T) {
	root := t.TempDir()
	bucket := ts.NewMemoryStore()
	writeFile(t, filepath.Join(root, "data", "events", "e.json"), `{"pushed":true}`)

	server := adminTestApp(t, root, bucket, nil)
	client := &http.Client{Timeout: 30 * time.Second}

	pushed := postJSON(t, client, server.URL+"/api/s3/push", `{}`)
	if pushed.Status != 200 {
		t.Fatalf("push = %d: %s", pushed.Status, pushed.Body)
	}
	var outcome struct {
		OK      bool
		Moved   []string
		Errors  []map[string]string
		Skipped []string
	}
	if err := json.Unmarshal(pushed.Body, &outcome); err != nil {
		t.Fatal(err)
	}
	if !outcome.OK || len(outcome.Errors) != 0 {
		t.Fatalf("push = %+v", outcome)
	}
	if strings.Join(outcome.Moved, ",") != "data/events/e.json" {
		t.Errorf("moved = %v", outcome.Moved)
	}
	if bucket.Read("content/data/events/e.json") != `{"pushed":true}` {
		t.Errorf("bucket = %v", bucket.Snapshot())
	}

	// Pulling it straight back is a no-op: the manifest says both sides agree.
	pulled := postJSON(t, client, server.URL+"/api/s3/pull", `{}`)
	if pulled.Status != 200 {
		t.Fatalf("pull = %d: %s", pulled.Status, pulled.Body)
	}
	if err := json.Unmarshal(pulled.Body, &outcome); err != nil {
		t.Fatal(err)
	}
	if len(outcome.Moved) != 0 {
		t.Errorf("a pull straight after a push moved %v", outcome.Moved)
	}

	// A scope limits the sync to one side.
	writeFile(t, filepath.Join(root, "planner", "trip.json"), `{"trip":true}`)
	scoped := postJSON(t, client, server.URL+"/api/s3/push", `{"scope":"data"}`)
	if err := json.Unmarshal(scoped.Body, &outcome); err != nil {
		t.Fatal(err)
	}
	for _, path := range outcome.Moved {
		if strings.HasPrefix(path, "planners/") {
			t.Errorf("a data-scoped push moved a planner: %v", outcome.Moved)
		}
	}
}

// The sync routes are gated: a status is a viewer's, a push is an editor's.
func TestS3RoutesRejectWrongMethods(t *testing.T) {
	server := adminTestApp(t, t.TempDir(), ts.NewMemoryStore(), nil)
	client := &http.Client{Timeout: 30 * time.Second}

	if resp := postJSON(t, client, server.URL+"/api/s3/config", `{}`); resp.Status != 405 {
		t.Errorf("POST to config = %d, want 405", resp.Status)
	}
	if resp := getBody(t, client, server.URL+"/api/s3/push"); resp.Status != 405 {
		t.Errorf("GET to push = %d, want 405", resp.Status)
	}
}

// Content negotiation on a 404 matters more than the page does: a fetch() that
// gets HTML back fails on "Unexpected token '<'".
func TestNotFoundNegotiatesContentType(t *testing.T) {
	server := adminTestApp(t, t.TempDir(), ts.NewMemoryStore(), nil)
	client := &http.Client{Timeout: 30 * time.Second}

	cases := []struct {
		name, path, accept, wantType string
	}{
		{"a browser gets the page", "/nothing", "text/html,application/xhtml+xml", "text/html"},
		{"a fetch gets JSON", "/nothing", "application/json", "application/json"},
		{"no Accept gets JSON", "/nothing", "", "application/json"},
		// Anything under /api/ is a client whatever its Accept header says.
		{"an api path always gets JSON", "/api/nothing", "text/html", "application/json"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, server.URL+testCase.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.accept != "" {
				request.Header.Set("Accept", testCase.accept)
			}
			resp, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("status = %d", resp.StatusCode)
			}
			if !strings.HasPrefix(resp.Header.Get("Content-Type"), testCase.wantType) {
				t.Errorf("Content-Type = %q, want %q",
					resp.Header.Get("Content-Type"), testCase.wantType)
			}
		})
	}
}

// The failure classifier decides whether an edit degrades to disk or is refused,
// so its two families are pinned apart.
func TestS3FailureClassification(t *testing.T) {
	// Not configured is "carry on with disk".
	if !storage.IsUnavailable(storage.ErrNoBucket) {
		t.Error("an unconfigured bucket should read as unavailable")
	}
	// A missing object is NOT unavailable — it is a real per-object answer, and
	// treating it as an outage would hide a 404 behind a disk read.
	missing := &ts.StubAPIError{Code: "NoSuchKey"}
	if storage.IsUnavailable(missing) {
		t.Error("a missing key should not read as an outage")
	}
	if !storage.IsMissingObject(missing) {
		t.Error("a missing key should be recognised as such")
	}
	// A misconfiguration degrades rather than failing every request.
	for _, code := range []string{"NoSuchBucket", "AccessDenied", "InvalidAccessKeyId",
		"PermanentRedirect", "SignatureDoesNotMatch", "AllAccessDisabled", "NotFound"} {
		if !storage.IsUnavailable(&ts.StubAPIError{Code: code}) {
			t.Errorf("%s should read as unavailable", code)
		}
	}
	// Something the SDK has never heard of is NOT waved through: an unknown
	// failure during a write must surface, not silently write to disk.
	if storage.IsUnavailable(errors.New("something else entirely")) {
		t.Error("an unknown error should not read as unavailable")
	}
	if storage.IsUnavailable(nil) || storage.IsMissingObject(nil) {
		t.Error("nil is not a failure")
	}
}
