package web

import (
	"net/http"
	"os"
	"path/filepath"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// The app's own files, compared against Express. Without these every page loads
// unstyled and scriptless, which is a failure no page-level test would notice —
// the HTML is identical either way.
func TestAppStaticMatchesTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := testApp(t, dataDir)
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	paths := []string{
		"/sw.js",
		"/api/v1/openapi.yaml",
		// A traversal must not reach the repository above the app root.
		"/../server.js",
		"/js/../../server.js",
		// Dotfiles are not served.
		"/.env",
	}
	// Plus the first real file of each kind actually in the checkout, so the
	// content-type table is tested against the app rather than my assumptions.
	for _, spec := range []struct{ dir, ext string }{
		{"css", ".css"}, {"js", ".js"}, {"js/modules", ".js"}, {"", ".html"},
		{"", ".yaml"}, {"schemas", ".json"}, {"partials", ".html"},
	} {
		if rel := findFile(filepath.Join(appRoot, spec.dir), spec.ext); rel != "" {
			paths = append(paths, "/"+strings.TrimPrefix(filepath.ToSlash(
				filepath.Join(spec.dir, rel)), "/"))
		}
	}

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "static_"+ts.ResponseKey(path), func() ts.Response {
				return fetch(t, client, nodeBase+path, nil)
			})
			got := fetch(t, client, goServer.URL+path, nil)

			if got.Status != want.Status {
				t.Fatalf("status = %d, node = %d", got.Status, want.Status)
			}
			if want.Status != http.StatusOK {
				return
			}
			if string(got.Body) != string(want.Body) {
				t.Errorf("body differs: %d bytes vs node's %d", len(got.Body), len(want.Body))
			}
			for _, name := range []string{"Content-Type", "ETag"} {
				if got.Headers[name] != want.Headers[name] {
					t.Errorf("%s = %q, node = %q", name, got.Headers[name], want.Headers[name])
				}
			}
		})
	}
}

// A page route must beat a file of the same name, which is why the static
// handler is registered last.
func TestPageRoutesBeatStaticFiles(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	goServer := testApp(t, ts.CopyArchive(t, source))
	client := &http.Client{Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	// `/editor.html` is a real file AND a canonical redirect. The redirect wins.
	resp, err := client.Get(goServer.URL + "/editor.html")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently {
		t.Errorf("/editor.html = %d, want a 301 to /editor", resp.StatusCode)
	}
	if location := resp.Header.Get("Location"); location != "/editor" {
		t.Errorf("Location = %q", location)
	}
}

// The path rules for the app root, which is the one static tree mounted at "/".
func TestResolveAppPath(t *testing.T) {
	cases := []struct {
		path string
		want string
	}{
		{"/css/components.css", "css/components.css"},
		{"/sw.js", "sw.js"},
		{"//css//components.css", "css/components.css"},
		{"/css/./components.css", "css/components.css"},
		// `..` does not escape: path.Clean anchors at "/", so these resolve
		// INSIDE the app root and 404 there rather than reaching the repository
		// above it. Express resolves them the same way.
		{"/../server.js", "server.js"},
		{"/css/../../server.js", "server.js"},
		// A dotfile is refused outright.
		{"/.env", ""},
		{"/css/.hidden", ""},
		{"/", ""},
		{"", ""},
	}
	for _, testCase := range cases {
		rel, ok := resolveAppPath(testCase.path)
		if testCase.want == "" {
			if ok {
				t.Errorf("resolveAppPath(%q) = %q, want a refusal", testCase.path, rel)
			}
			continue
		}
		if !ok || rel != testCase.want {
			t.Errorf("resolveAppPath(%q) = %q %v, want %q", testCase.path, rel, ok, testCase.want)
		}
	}
}

// A NUL in a path is refused before it reaches the filesystem.
func TestResolveAppPathRefusesNul(t *testing.T) {
	if _, ok := resolveAppPath("/css/components.css\x00.txt"); ok {
		t.Error("a NUL byte was accepted")
	}
}

// The property that matters: whatever comes in, the resolved file is under the
// app root. Asserted over the shapes that have historically got past
// hand-rolled matching in this codebase.
func TestResolveAppPathNeverEscapes(t *testing.T) {
	root := "/srv/app"
	for _, probe := range []string{
		"/../server.js", "/../../etc/passwd", "/css/../../../../etc/passwd",
		"/.././.././server.js", "//../server.js", "/a/b/../../../c",
	} {
		rel, ok := resolveAppPath(probe)
		if !ok {
			continue
		}
		full := filepath.Join(root, filepath.FromSlash(rel))
		if !strings.HasPrefix(full, root+string(filepath.Separator)) {
			t.Errorf("%q resolved to %q, outside %q", probe, full, root)
		}
	}
}

// The service worker must not be served with a cache policy that outlives a
// deploy — a stale one keeps serving the old app to a returning reader.
func TestServiceWorkerIsNotHeldByCaches(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	if _, err := os.Stat(filepath.Join(ts.RepoRoot(t), "app", "sw.js")); err != nil {
		t.Skip("no service worker in this checkout")
	}
	goServer := testApp(t, ts.CopyArchive(t, source))
	client := &http.Client{Timeout: 30 * time.Second}

	resp, err := client.Get(goServer.URL + "/sw.js")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	cacheControl := resp.Header.Get("Cache-Control")
	// Whatever the policy says, it must not be a long immutable hold.
	if strings.Contains(cacheControl, "immutable") {
		t.Errorf("the service worker is held immutable: %q", cacheControl)
	}
}
