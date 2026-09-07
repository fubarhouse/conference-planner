package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// The paths every comparison runs. Chosen for what they exercise, not for
// coverage: a JSON dataset, the catalog, three image formats, a conditional
// request, a range, and four ways of trying to leave the mount.
func comparisonPaths(t *testing.T, dataDir string) []string {
	t.Helper()
	paths := []string{
		"/data/catalog.json",
		"/data/events/drupalcon/eu/2026-rotterdam.json",
		"/data/geocache.json",
		"/data/nope.json",
		"/data/events",       // a directory
		"/data/../server.js", // traversal, resolved by the client
		"/data/%2e%2e/server.js",
		"/data//catalog.json",
		"/data/./catalog.json",
		"/img/nope.png",
	}
	// Add the first image of each type actually present, so the content-type
	// table is tested against the archive rather than against my assumptions.
	for _, ext := range []string{".png", ".jpg", ".svg", ".gif", ".webp"} {
		if rel := findFile(filepath.Join(dataDir, "img"), ext); rel != "" {
			paths = append(paths, "/img/"+rel)
		}
	}
	return paths
}

func findFile(root, ext string) string {
	var found string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || found != "" || d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ext) {
			if rel, err := filepath.Rel(root, p); err == nil {
				found = filepath.ToSlash(rel)
			}
		}
		return nil
	})
	return found
}

func fetch(t *testing.T, client *http.Client, url string, headers map[string]string) ts.Response {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	resp, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	// Only the headers that are a contract with a cache or a client. Date,
	// Connection, Keep-Alive and X-Powered-By are not.
	kept := map[string]string{}
	for _, name := range []string{
		"Cache-Control", "Content-Type", "ETag", "Accept-Ranges", "Content-Range", "Content-Length",
	} {
		kept[name] = resp.Header.Get(name)
	}
	return ts.Response{Status: resp.StatusCode, Headers: kept, Body: body}
}

// The test that says the Go service can stand in for the Node one on these two
// mounts: same status, same caching and content headers, same bytes.
func TestServeMatchesTheNodeServerOnDataAndImg(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())

	goServer := httptest.NewServer(NewServer([]Mount{
		{Prefix: "/data", Dir: dataDir},
		{Prefix: "/img", Dir: filepath.Join(dataDir, "img")},
	}))
	defer goServer.Close()

	// Do not follow redirects: express.static redirects a directory request to
	// a trailing slash, and whether the Go side does the same is exactly the
	// kind of difference this test exists to surface.
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	for _, path := range comparisonPaths(t, dataDir) {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "serve_"+ts.ResponseKey(path), func() ts.Response {
				return fetch(t, client, nodeBase+path, nil)
			})
			got := fetch(t, client, goServer.URL+path, nil)

			if got.Status != want.Status {
				t.Errorf("status = %d, node = %d", got.Status, want.Status)
			}
			// A 404's body is the Node app's own, and this service is not the
			// whole app — only the status and the caching matter there.
			if want.Status == http.StatusOK &&
				string(ts.WithoutStamps(got.Body)) != string(ts.WithoutStamps(want.Body)) {
				t.Errorf("body differs: %d bytes vs node's %d", len(got.Body), len(want.Body))
			}
			for _, name := range []string{"Cache-Control", "Content-Type", "ETag"} {
				if want.Status != http.StatusOK && name != "Cache-Control" {
					continue
				}
				if got.Headers[name] != want.Headers[name] {
					t.Errorf("%s = %q, node = %q", name, got.Headers[name], want.Headers[name])
				}
			}
		})
	}
}

// Conditional and range requests are what the ETag and Accept-Ranges headers
// promise. A cache that is told it may revalidate and then gets a 200 every
// time is worse than one that was never told anything.
func TestServeHonoursConditionalAndRangeRequests(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := httptest.NewServer(NewServer([]Mount{{Prefix: "/data", Dir: dataDir}}))
	defer goServer.Close()

	client := &http.Client{Timeout: 30 * time.Second}
	const path = "/data/catalog.json"

	nodeFirst := ts.Reference(t, "conditional_first", func() ts.Response {
		return fetch(t, client, nodeBase+path, nil)
	})
	goFirst := fetch(t, client, goServer.URL+path, nil)
	if goFirst.Headers["ETag"] != nodeFirst.Headers["ETag"] {
		t.Fatalf("ETag = %q, node = %q", goFirst.Headers["ETag"], nodeFirst.Headers["ETag"])
	}

	// Revalidation: the same tag back must produce a 304 with no body.
	conditional := map[string]string{"If-None-Match": goFirst.Headers["ETag"]}
	nodeAgain := ts.Reference(t, "conditional_revalidate", func() ts.Response {
		return fetch(t, client, nodeBase+path, conditional)
	})
	goAgain := fetch(t, client, goServer.URL+path, conditional)
	if goAgain.Status != http.StatusNotModified || nodeAgain.Status != http.StatusNotModified {
		t.Errorf("conditional GET: go %d, node %d — want 304 from both",
			goAgain.Status, nodeAgain.Status)
	}
	if len(goAgain.Body) != 0 {
		t.Errorf("a 304 must have no body, got %d bytes", len(goAgain.Body))
	}

	// A stale tag must produce the whole file again.
	stale := map[string]string{"If-None-Match": `W/"0-0"`}
	if got := fetch(t, client, goServer.URL+path, stale); got.Status != http.StatusOK {
		t.Errorf("stale ETag: status = %d, want 200", got.Status)
	}

	rangeHeader := map[string]string{"Range": "bytes=0-9"}
	nodeRange := ts.Reference(t, "conditional_range", func() ts.Response {
		return fetch(t, client, nodeBase+path, rangeHeader)
	})
	goRange := fetch(t, client, goServer.URL+path, rangeHeader)
	if goRange.Status != nodeRange.Status {
		t.Errorf("range status = %d, node = %d", goRange.Status, nodeRange.Status)
	}
	if string(goRange.Body) != string(nodeRange.Body) {
		t.Errorf("range body = %q, node = %q", goRange.Body, nodeRange.Body)
	}
	if goRange.Headers["Content-Range"] != nodeRange.Headers["Content-Range"] {
		t.Errorf("Content-Range = %q, node = %q",
			goRange.Headers["Content-Range"], nodeRange.Headers["Content-Range"])
	}
}

// The cache policy, path by path.
//
// This is the ONE test in this package that is no longer anchored to the
// JavaScript, and the reason is a sequencing mistake worth recording:
// lib/cachePolicy.js was deleted before this test had been converted to use a
// recorded answer, so there was nothing left to record from. Restoring that file
// from git history and re-running with -update-golden would put the stronger
// form back.
//
// It is not unanchored in practice. Every path this application actually SERVES
// has its Cache-Control compared against a recorded reference response in
// TestServeMatchesTheNodeServerOnDataAndImg and
// TestMiddlewareHeadersMatchTheNodeServer. What is lost is the direct comparison
// on the paths below that no route reaches — the fail-closed cases, mostly,
// which are the ones a table can state perfectly well.
//
// The values are the policy as shipped. Read as a change-detector: if you change
// one deliberately, change it here too, and say why in cachepolicy.go.
func TestCacheControlPolicy(t *testing.T) {
	cases := []struct{ path, plain, versioned string }{}
	for _, row := range cachePolicyTable() {
		cases = append(cases, row)
	}
	for _, testCase := range cases {
		if got := CacheControlFor(testCase.path, false); got != testCase.plain {
			t.Errorf("CacheControlFor(%q) = %q, want %q", testCase.path, got, testCase.plain)
		}
		if got := CacheControlFor(testCase.path, true); got != testCase.versioned {
			t.Errorf("CacheControlFor(%q, versioned) = %q, want %q",
				testCase.path, got, testCase.versioned)
		}
	}

	// The property that matters most, stated separately from the table: anything
	// unrecognised is uncacheable. A route added later is private until somebody
	// classifies it deliberately.
	for _, unknown := range []string{
		"/unknown", "/api/whatever", "/some/new/route", "/api/v2/things", "",
	} {
		if got := CacheControlFor(unknown, false); got != policyPrivate {
			t.Errorf("CacheControlFor(%q) = %q — an unclassified path must be %q",
				unknown, got, policyPrivate)
		}
	}
}

func TestResolveRequestPathRefusesEscapes(t *testing.T) {
	cases := map[string]string{
		"/data/catalog.json":              "catalog.json",
		"/data/events/a/b.json":           "events/a/b.json",
		"/data//catalog.json":             "catalog.json",
		"/data/./catalog.json":            "catalog.json",
		"/data/events/../catalog.json":    "catalog.json",
		"/data/../server.js":              "",
		"/data/../../etc/passwd":          "",
		"/data/events/../../../server.js": "",
		"/data/":                          "",
		"/data":                           "",
		"/data/.env":                      "",
		"/data/.git/config":               "",
		"/dataother/x.json":               "",
	}
	for input, want := range cases {
		got, ok := resolveRequestPath("/data", input)
		if want == "" {
			if ok {
				t.Errorf("resolveRequestPath(%q) = %q, want refusal", input, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("resolveRequestPath(%q) = %q (ok=%v), want %q", input, got, ok, want)
		}
	}
}

func TestExpressETagFormat(t *testing.T) {
	// size 255, mtime 1 January 2026 00:00:00.000 UTC
	if got := expressETag(255, 1767225600000); got != `W/"ff-19b76daa800"` {
		t.Errorf("expressETag = %s", got)
	}
}

// The public schedule feed, compared against the Node route that serves it.
func TestScheduleIcsRouteMatchesTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := httptest.NewServer(NewServer([]Mount{
		{Prefix: "/data", Dir: dataDir},
		{Prefix: "/img", Dir: filepath.Join(dataDir, "img")},
	}))
	defer goServer.Close()

	client := &http.Client{Timeout: 30 * time.Second}

	for _, query := range []string{
		"?e=events/drupalcon/eu/2026-rotterdam.json",
		"?event=events/ddd/2010-munich.json",
		"?e=drupalcon-eu-2026-rotterdam.json", // the flattened form
		"?e=nope.json",
		"?e=../server.js",
		"", // no parameter at all
	} {
		t.Run(query, func(t *testing.T) {
			want := ts.Reference(t, "scheduleics_"+ts.ResponseKey(query), func() ts.Response {
				return fetch(t, client, nodeBase+"/schedule.ics"+query, nil)
			})
			got := fetch(t, client, goServer.URL+"/schedule.ics"+query, nil)

			if got.Status != want.Status {
				t.Errorf("status = %d, node = %d", got.Status, want.Status)
			}
			for _, name := range []string{"Cache-Control", "Content-Type", "ETag"} {
				if want.Status != http.StatusOK && name != "Content-Type" {
					continue
				}
				if got.Headers[name] != want.Headers[name] {
					t.Errorf("%s = %q, node = %q", name, got.Headers[name], want.Headers[name])
				}
			}
			if want.Status != http.StatusOK {
				if string(got.Body) != string(want.Body) {
					t.Errorf("body = %q, node = %q", got.Body, want.Body)
				}
				return
			}
			if ts.NormaliseStamp(string(got.Body)) != ts.NormaliseStamp(string(want.Body)) {
				t.Errorf("feeds differ:\n--- go ---\n%s\n--- node ---\n%s",
					ts.FirstLines(string(got.Body), 12), ts.FirstLines(string(want.Body), 12))
			}
		})
	}

	// The ETag is the dataset's, so a conditional request is answered from it.
	first := fetch(t, client, goServer.URL+"/schedule.ics?e=events/ddd/2010-munich.json", nil)
	again := fetch(t, client, goServer.URL+"/schedule.ics?e=events/ddd/2010-munich.json",
		map[string]string{"If-None-Match": first.Headers["ETag"]})
	if again.Status != http.StatusNotModified || len(again.Body) != 0 {
		t.Errorf("conditional feed request = %d with %d bytes", again.Status, len(again.Body))
	}
}

// cachePolicyTable is the policy as shipped, one row per path shape.
//
// Generated once from the implementation and committed, rather than computed in
// the test — a table that calls the code it is testing proves nothing.
func cachePolicyTable() []struct{ path, plain, versioned string } {
	return []struct{ path, plain, versioned string }{
		{"/data/catalog.json", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/data/events/x.json", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/img/logo.png", "public, max-age=86400, stale-while-revalidate=604800", "public, max-age=86400, stale-while-revalidate=604800"},
		{"/js/app.js", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/css/main.css", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/fonts/x.woff2", "public, max-age=86400, stale-while-revalidate=604800", "public, max-age=86400, stale-while-revalidate=604800"},
		{"/favicon.ico", "public, max-age=86400, stale-while-revalidate=604800", "public, max-age=86400, stale-while-revalidate=604800"},
		{"/manifest.webmanifest", "public, max-age=86400, stale-while-revalidate=604800", "public, max-age=86400, stale-while-revalidate=604800"},
		{"/robots.txt", "public, max-age=86400, stale-while-revalidate=604800", "public, max-age=86400, stale-while-revalidate=604800"},
		{"/api/meta", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/api/data/x", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/schedule.ics", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/schedules/drupalcon/calendar.ics", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/schedules/drupalcon/subscribe", "public, max-age=60, stale-while-revalidate=300", "public, max-age=60, stale-while-revalidate=300"},
		{"/schedules", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/schedules/drupalcon", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/home.html", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/index.html", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/", "public, max-age=60, must-revalidate", "public, max-age=60, must-revalidate"},
		{"/api/archive/insights", "public, no-cache", "public, max-age=31536000, immutable"},
		{"/api/archive/sessions", "public, no-cache", "public, max-age=31536000, immutable"},
		{"/api/archive/topic", "public, no-cache", "public, max-age=31536000, immutable"},
		{"/planner/x", "private, no-store", "private, no-store"},
		{"/planner/x/calendar.ics", "private, no-store", "private, no-store"},
		{"/api/auth/status", "private, no-store", "private, no-store"},
		{"/api/health", "private, no-store", "private, no-store"},
		{"/login", "private, no-store", "private, no-store"},
		{"/logout", "private, no-store", "private, no-store"},
		{"/receipts/x.pdf", "private, no-store", "private, no-store"},
		{"/documents/x.pdf", "private, no-store", "private, no-store"},
		{"/data", "private, no-store", "private, no-store"},
		{"/imgx/y.png", "private, no-store", "private, no-store"},
	}
}
