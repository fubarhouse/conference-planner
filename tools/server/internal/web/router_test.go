package web

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"server/internal/auth"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// testApp builds the assembled server over a data directory, configured the way
// startNodeServer configures the Node one: open mode, no password.
func testApp(t *testing.T, dataDir string) *httptest.Server {
	t.Helper()
	mounts := []Mount{
		{Prefix: "/data", Dir: dataDir},
		{Prefix: "/img", Dir: filepath.Join(dataDir, "img")},
	}
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen, Signer: auth.NewSessionSigner("test-secret")}
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	server := httptest.NewServer(NewApp(AppConfig{
		Mounts:        mounts,
		Mode:          auth.ModeOpen,
		Authenticator: authenticator,
		Pages: &PageServer{
			AppRoot:    appRoot,
			Provenance: NewProvenance(appRoot, func(string) string { return "" }),
		},
		Login: &auth.LoginService{
			Mode:    auth.ModeOpen,
			Signer:  authenticator.Signer,
			AppRoot: filepath.Join(ts.RepoRoot(t), "app"),
			Limiter: auth.NewLoginRateLimiter(),
		},
	}))
	t.Cleanup(server.Close)
	return server
}

// headerComparisonPaths are chosen for the DECISIONS the middleware makes, not
// for coverage: the two framing exceptions, the embed case, a trailing slash
// with and without a query, and a path nothing routes.
func headerComparisonPaths() []string {
	return []string{
		"/healthz",
		"/api/auth/status",
		"/data/catalog.json",
		"/data/catalog.json?v=1",
		"/",
		"/?embed=1",
		"/index.html?embed=1",
		"/schedule?embed=1",
		"/schedule",
		"/receipts/nothing.pdf",
		"/api/receipts/nothing.pdf",
		"/documents/nothing.pdf",
		"/planner?embed=1", // an auth-gated page must NOT become framable
		"/data/",
		"/data/events/",
		"/nothing-here/",
		"/nothing-here/?a=b",
		"/nothing-at-all",
	}
}

// The headers a browser makes security decisions from, compared against Express
// on every path where the rules differ.
func TestMiddlewareHeadersMatchTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := testApp(t, dataDir)

	// Redirects are the point of two of these paths, so do not follow them.
	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	securityHeaders := []string{
		"X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy",
		"X-Frame-Options", "Content-Security-Policy", "Cache-Control",
		"Access-Control-Allow-Origin", "Access-Control-Allow-Methods",
		"Access-Control-Allow-Headers", "Location",
	}

	for _, path := range headerComparisonPaths() {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "headers_"+ts.ResponseKey(path), func() ts.Response {
				return fetchHeaders(t, client, nodeBase+path, securityHeaders)
			})
			got := fetchHeaders(t, client, goServer.URL+path, securityHeaders)

			for _, name := range securityHeaders {
				if got.Headers[name] != want.Headers[name] {
					t.Errorf("%s = %q, node = %q", name, got.Headers[name], want.Headers[name])
				}
			}
			// A redirect's status is part of the contract; a 404's body is the
			// Node app's own page and this server is not the whole app yet.
			if want.Status >= 300 && want.Status < 400 && got.Status != want.Status {
				t.Errorf("status = %d, node = %d", got.Status, want.Status)
			}
		})
	}
}

// fetchHeaders is fetch() with an explicit list of headers to keep — the same
// `response` shape, so a recorded reference answer can stand in for either.
func fetchHeaders(t *testing.T, client *http.Client, url string, names []string) ts.Response {
	t.Helper()
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	kept := map[string]string{}
	for _, name := range names {
		kept[name] = resp.Header.Get(name)
	}
	return ts.Response{Status: resp.StatusCode, Headers: kept, Body: body}
}

// A preflight has to be answered without reaching a route, or the editor cannot
// talk to the server from a file:// page at all.
func TestOptionsPreflightMatchesNode(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := testApp(t, dataDir)

	client := &http.Client{Timeout: 30 * time.Second}
	for _, path := range []string{"/api/v1/datasets", "/data/catalog.json", "/anything"} {
		t.Run(path, func(t *testing.T) {
			ask := func(base string) (int, string) {
				request, err := http.NewRequest(http.MethodOptions, base+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				resp, err := client.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				_, _ = io.Copy(io.Discard, resp.Body)
				return resp.StatusCode, resp.Header.Get("Access-Control-Allow-Methods")
			}
			recorded := ts.Reference(t, "options_"+ts.ResponseKey(path), func() ts.Response {
				status, methods := ask(nodeBase)
				return ts.Response{Status: status, Headers: map[string]string{"m": methods}}
			})
			wantStatus, wantMethods := recorded.Status, recorded.Headers["m"]
			gotStatus, gotMethods := ask(goServer.URL)
			if gotStatus != wantStatus || gotMethods != wantMethods {
				t.Errorf("= %d %q, node = %d %q", gotStatus, gotMethods, wantStatus, wantMethods)
			}
		})
	}
}

// Compression is worth 60 KB on the largest dataset, so whether it happens at
// all is compared — and so is the body underneath it, because a double-gzipped
// response is one no client can read and no header would admit to.
func TestCompressionMatchesNodesDecision(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := testApp(t, dataDir)

	// A transport that does NOT ask for gzip itself, so the test controls the
	// header and can see the raw encoding that comes back.
	client := &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{DisableCompression: true},
	}

	paths := []string{
		"/data/catalog.json", // large JSON: compress
		"/healthz",           // two bytes: do not
		"/api/auth/status",   // small JSON: do not
		"/data/events/drupalcon/eu/2026-rotterdam.json", // large JSON: compress
	}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			ask := func(base string) (string, []byte) {
				request, err := http.NewRequest(http.MethodGet, base+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Accept-Encoding", "gzip")
				resp, err := client.Do(request)
				if err != nil {
					t.Fatalf("GET %s: %v", base+path, err)
				}
				defer resp.Body.Close()
				raw, err := io.ReadAll(resp.Body)
				if err != nil {
					t.Fatal(err)
				}
				encoding := resp.Header.Get("Content-Encoding")
				if encoding != "gzip" {
					return encoding, raw
				}
				reader, err := gzip.NewReader(strings.NewReader(string(raw)))
				if err != nil {
					t.Fatalf("%s: response is not readable gzip: %v", base+path, err)
				}
				defer reader.Close()
				plain, err := io.ReadAll(reader)
				if err != nil {
					// This is what a double-compressed body looks like from here.
					t.Fatalf("%s: gzip body did not decode: %v", base+path, err)
				}
				return encoding, plain
			}

			recorded := ts.Reference(t, "gzip_"+ts.ResponseKey(path), func() ts.Response {
				encoding, body := ask(nodeBase)
				return ts.Response{Headers: map[string]string{"e": encoding}, Body: body}
			})
			wantEncoding, wantBody := recorded.Headers["e"], recorded.Body
			gotEncoding, gotBody := ask(goServer.URL)

			if gotEncoding != wantEncoding {
				t.Errorf("Content-Encoding = %q, node = %q", gotEncoding, wantEncoding)
			}
			if string(ts.WithoutStamps(gotBody)) != string(ts.WithoutStamps(wantBody)) {
				t.Errorf("body differs: %d bytes vs node's %d", len(gotBody), len(wantBody))
			}
		})
	}
}

// A client that cannot read gzip must still get the file.
func TestUncompressedClientsGetPlainBytes(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	dataDir := ts.CopyArchive(t, source)
	goServer := testApp(t, dataDir)

	client := &http.Client{Timeout: 30 * time.Second,
		Transport: &http.Transport{DisableCompression: true}}
	request, err := http.NewRequest(http.MethodGet, goServer.URL+"/data/catalog.json", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept-Encoding", "identity")
	resp, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if encoding := resp.Header.Get("Content-Encoding"); encoding != "" {
		t.Errorf("Content-Encoding = %q for a client that did not ask", encoding)
	}
	if len(body) == 0 || body[0] != '{' {
		t.Errorf("body does not look like the catalog: %.40q", body)
	}
}

// The routes the assembled server owns, answered without Node running.
func TestAssembledRoutesAnswer(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	dataDir := ts.CopyArchive(t, source)
	goServer := testApp(t, dataDir)
	client := &http.Client{Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	cases := []struct {
		path        string
		status      int
		contentType string
		contains    string
	}{
		{"/healthz", 200, "text/plain; charset=utf-8", "ok"},
		{"/api/auth/status", 200, "application/json; charset=utf-8", `"mode":"open"`},
		// In open mode there is nothing to log in to, so the form redirects home
		// rather than asking for a password that does not exist.
		{"/login", 302, "", ""},
		{"/nothing-at-all", 404, "", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.path, func(t *testing.T) {
			resp, err := client.Get(goServer.URL + testCase.path)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)

			if resp.StatusCode != testCase.status {
				t.Errorf("status = %d, want %d", resp.StatusCode, testCase.status)
			}
			if testCase.contentType != "" &&
				!strings.EqualFold(resp.Header.Get("Content-Type"), testCase.contentType) {
				t.Errorf("Content-Type = %q, want %q", resp.Header.Get("Content-Type"), testCase.contentType)
			}
			if testCase.contains != "" && !strings.Contains(string(body), testCase.contains) {
				t.Errorf("body %.80q does not contain %q", body, testCase.contains)
			}
		})
	}

	// In open mode every caller is a synthetic admin, and the status route has to
	// say so or the frontend will not attempt the requests it is entitled to.
	resp, err := client.Get(goServer.URL + "/api/auth/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"role":"admin"`) ||
		!strings.Contains(string(body), `"authenticated":true`) {
		t.Errorf("open mode should resolve an admin: %s", body)
	}
}
