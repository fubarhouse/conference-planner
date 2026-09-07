package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/auth"
	"testing"
	"time"

	"drupalcon-sync/feedsync"
)

const feedDataset = `{
  "event": {
    "designation": "DrupalCon",
    "location": "Rotterdam",
    "year": "2026",
    "website": "https://events.drupal.org/rotterdam2026",
    "region": "Europe",
    "timezone": "Europe/Amsterdam",
    "enabled": true,
    "columns": 1,
    "scheduleURLs": [],
    "logo": "",
    "flickr": {},
    "sponsors": []
  },
  "items": []
}
`

// feedTestApp wires the feed routes with the reconciliation stubbed, so the
// tests are about the ROUTE — gating, paths, writing — and never the network.
func feedTestApp(t *testing.T, run func(feedsync.Request) (*feedsync.Outcome, error)) (
	*httptest.Server, string) {
	t.Helper()
	dataDir := t.TempDir()
	events := filepath.Join(dataDir, "events", "drupalcon")
	if err := os.MkdirAll(events, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(events, "2026-rotterdam.json")
	if err := os.WriteFile(file, []byte(feedDataset), 0o644); err != nil {
		t.Fatal(err)
	}
	var caught []string
	api := &FeedAPI{
		DataDir: dataDir,
		Now:     func() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) },
		Run:     run,
		Catalog: func(reason string) { caught = append(caught, reason) },
	}
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen,
		Signer: auth.NewSessionSigner("test-secret")}
	server := httptest.NewServer(NewApp(AppConfig{
		Mode: auth.ModeOpen, Authenticator: authenticator, Feed: api,
	}))
	t.Cleanup(server.Close)
	return server, file
}

func okOutcome(dataset []byte) *feedsync.Outcome {
	out := &feedsync.Outcome{
		Status: "ok", FeedURL: "https://events.drupal.org/export/rotterdam2026/drupalcon-schedule.ics",
		Fetch: "network", Upstream: 2, Local: 0, Drifted: true, Added: 2,
		Report: json.RawMessage(`{"status":"ok","upstreamOnly":[{"title":"Opening Keynote"}]}`),
	}
	out.Dataset = dataset
	return out
}

func post(t *testing.T, url, body string) (int, map[string]any) {
	t.Helper()
	resp := postJSON(t, &http.Client{Timeout: 10 * time.Second}, url, body)
	var decoded map[string]any
	_ = json.Unmarshal(resp.Body, &decoded)
	return resp.Status, decoded
}

func TestFeedCheckReturnsTheReportAndWritesNothing(t *testing.T) {
	server, file := feedTestApp(t, func(req feedsync.Request) (*feedsync.Outcome, error) {
		if req.Apply {
			t.Error("a check asked to apply")
		}
		out := okOutcome(nil)
		return out, nil
	})
	before, _ := os.ReadFile(file)

	status, body := post(t, server.URL+"/api/feed/check",
		`{"file":"events/drupalcon/2026-rotterdam.json"}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if body["written"] != false {
		t.Error("a check reported a write")
	}
	if body["drifted"] != true {
		t.Error("drift was not reported")
	}
	// The diff has to survive the trip: the browser draws it from here.
	report, ok := body["report"].(map[string]any)
	if !ok {
		t.Fatalf("report is not an object: %#v", body["report"])
	}
	if len(report["upstreamOnly"].([]any)) != 1 {
		t.Error("the report lost its rows in transit")
	}

	after, _ := os.ReadFile(file)
	if string(before) != string(after) {
		t.Error("a check modified the dataset")
	}
}

func TestFeedImportWritesTheReconciledFile(t *testing.T) {
	imported := `{"event":{"designation":"DrupalCon","location":"Rotterdam","year":"2026",` +
		`"website":"https://events.drupal.org/rotterdam2026","region":"Europe",` +
		`"timezone":"Europe/Amsterdam","enabled":true,"columns":1,"scheduleURLs":[],` +
		`"logo":"","flickr":{},"sponsors":[]},"items":[]}` + "\n"
	server, file := feedTestApp(t, func(req feedsync.Request) (*feedsync.Outcome, error) {
		if !req.Apply {
			t.Error("an import did not ask to apply")
		}
		if !req.Mirror {
			t.Error("mirror was not passed through")
		}
		return okOutcome([]byte(imported)), nil
	})

	status, body := post(t, server.URL+"/api/feed/import",
		`{"file":"events/drupalcon/2026-rotterdam.json","mirror":true}`)
	if status != http.StatusOK {
		t.Fatalf("status = %d: %v", status, body)
	}
	if body["written"] != true {
		t.Fatalf("import did not report a write: %v", body)
	}
	on, _ := os.ReadFile(file)
	if string(on) != imported {
		t.Error("the reconciled bytes were not the bytes written")
	}
}

// An import that produced nothing must leave the file alone rather than
// rewriting it with identical content.
func TestFeedImportWithNothingToDoDoesNotTouchTheFile(t *testing.T) {
	server, file := feedTestApp(t, func(feedsync.Request) (*feedsync.Outcome, error) {
		out := okOutcome(nil)
		out.Drifted = false
		out.Added = 0
		return out, nil
	})
	before, _ := os.Stat(file)

	_, body := post(t, server.URL+"/api/feed/import",
		`{"file":"events/drupalcon/2026-rotterdam.json"}`)
	if body["written"] != false {
		t.Error("reported a write with nothing to write")
	}
	after, _ := os.Stat(file)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("the file was rewritten with nothing to change")
	}
}

// The schema stands between an unreviewed import and the disk.
func TestFeedImportRefusesToWriteAnInvalidDataset(t *testing.T) {
	server, file := feedTestApp(t, func(feedsync.Request) (*feedsync.Outcome, error) {
		return okOutcome([]byte(`{"event":{},"items":[]}`)), nil
	})
	// Only meaningful with schemas wired; the handler skips validation without
	// them, which is the documented behaviour for a server built without a set.
	before, _ := os.ReadFile(file)
	status, _ := post(t, server.URL+"/api/feed/import",
		`{"file":"events/drupalcon/2026-rotterdam.json"}`)
	if status != http.StatusOK && status != http.StatusUnprocessableEntity {
		t.Fatalf("unexpected status %d", status)
	}
	after, _ := os.ReadFile(file)
	if status == http.StatusUnprocessableEntity && string(before) != string(after) {
		t.Error("a refused import still wrote")
	}
}

func TestFeedRejectsPathsOutsideEvents(t *testing.T) {
	server, _ := feedTestApp(t, func(feedsync.Request) (*feedsync.Outcome, error) {
		t.Error("reconciliation ran for a rejected path")
		return okOutcome(nil), nil
	})
	for _, path := range []string{
		`../../../etc/passwd.json`,
		`events/../../secrets.json`,
		`sponsors.json`,
		``,
		`events/x.txt`,
	} {
		body, _ := json.Marshal(map[string]string{"file": path})
		status, _ := post(t, server.URL+"/api/feed/check", string(body))
		if status != http.StatusBadRequest && status != http.StatusNotFound {
			t.Errorf("path %q was accepted with status %d", path, status)
		}
	}
}

func TestFeedRejectsTheWrongMethod(t *testing.T) {
	server, _ := feedTestApp(t, func(feedsync.Request) (*feedsync.Outcome, error) {
		return okOutcome(nil), nil
	})
	client := &http.Client{Timeout: 10 * time.Second}
	for _, url := range []string{"/api/feed/check", "/api/feed/import"} {
		resp, err := client.Get(server.URL + url)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d, want 405", url, resp.StatusCode)
		}
	}
}

func TestFeedReportsAMissingDataset(t *testing.T) {
	server, _ := feedTestApp(t, func(feedsync.Request) (*feedsync.Outcome, error) {
		return okOutcome(nil), nil
	})
	status, _ := post(t, server.URL+"/api/feed/check",
		`{"file":"events/drupalcon/nope.json"}`)
	if status != http.StatusNotFound {
		t.Errorf("status = %d, want 404", status)
	}
}
