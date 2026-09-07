package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// pageComparisonPaths covers every shape of page address: the two file-form
// redirects, the renamed section, a deep route at each depth, and one path that
// must NOT be answered with a page.
func pageComparisonPaths() []string {
	return []string{
		"/",
		"/home.html",
		"/schedules",
		"/schedules/drupalcon-eu-2026",
		"/schedule",
		"/index.html",
		"/index.html?id=x",
		"/planner",
		"/planner.html",
		"/planner.html?id=x",
		"/planner/my-trip",
		"/planner/my-trip/budget",
		"/archive",
		"/archive.html",
		"/archive/videos",
		"/archive/speaker/somebody",
		"/archive/topic/drupal/2024",
		"/curation",
		"/curation.html",
		"/editor",
		"/editor.html",
		"/editor/drupalcon/eu/2026",
		"/observatory",
		"/observatory.html",
		"/observatory/speaker/somebody",
		// A request that names a file must fall through rather than be answered
		// with HTML — this is the rule that stopped `fetch('./schemas/…')` from
		// dying on "Unexpected token '<'".
		"/editor/schemas/event.schema.json",
		"/archive/data/catalog.json",
	}
}

// The page layer, compared against Express: same status, same redirect target,
// and the same markup once the per-host social tags are accounted for.
//
// ⚠ THESE ARE NO LONGER PARITY — they are RECORDED ANSWERS. Node is deleted, so
// a recording can never follow a deliberate change to the markup, and every
// page has since been stripped of its HTML comments (markup is public; the
// reasoning moved to docs/html-notes.md, guarded by `pnpm run lint:html`).
// archive.html also lost a static `<base href="/">` that broke static
// sub-directory deployments, and the rail lost an `aria-live` that made it read
// its whole contents aloud on open.
//
// So the whole set was re-made from Go. What this test catches now is an
// UNINTENDED change to the markup; it no longer proves parity with anything.
//
// Re-recording one needs the Go server, not -update-golden, which still tries
// to boot the reference and dies on the deleted lib/.
func TestPageRoutesMatchTheNodeServer(t *testing.T) {
	dataDir := ts.CopyArchive(t, ts.ArchiveDir(t))
	nodeBase := ts.ReferenceBase(t, dataDir, t.TempDir())
	goServer := testApp(t, dataDir)

	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	for _, path := range pageComparisonPaths() {
		t.Run(path, func(t *testing.T) {
			want := ts.Reference(t, "page_"+ts.ResponseKey(path), func() ts.Response {
				return fetchPage(t, client, nodeBase, path)
			})
			got := fetchPage(t, client, goServer.URL, path)

			if got.Status != want.Status {
				t.Errorf("status = %d, node = %d", got.Status, want.Status)
			}
			if got.Headers["Location"] != want.Headers["Location"] {
				t.Errorf("Location = %q, node = %q",
					got.Headers["Location"], want.Headers["Location"])
			}
			if want.Status == http.StatusOK && string(got.Body) != string(want.Body) {
				t.Errorf("body differs (%d bytes vs node's %d)\n%s",
					len(got.Body), len(want.Body), ts.FirstDifference(string(got.Body), string(want.Body)))
			}
			// The ETag is what makes a page revalidate rather than re-download.
			if want.Status == http.StatusOK && got.Headers["ETag"] != want.Headers["ETag"] {
				t.Errorf("ETag = %q, node = %q", got.Headers["ETag"], want.Headers["ETag"])
			}
		})
	}
}

// fetchPage normalises the one thing that legitimately differs between two
// servers on two ports: the origin the social tags are built from, which is read
// from the request's own Host header by design.
func fetchPage(t *testing.T, client *http.Client, base, path string) ts.Response {
	t.Helper()
	resp := fetchHeaders(t, client, base+path, []string{"Location", "ETag", "Content-Type"})
	origin := strings.TrimPrefix(base, "http://")
	resp.Body = []byte(strings.ReplaceAll(string(resp.Body), origin, "SERVER"))
	// The ETag of a generated page is a hash of that body, so it moves with the
	// origin too and has to be compared after the same substitution.
	if strings.Contains(resp.Headers["ETag"], "-") && strings.Contains(string(resp.Body), "SERVER") {
		resp.Headers["ETag"] = expressContentETag(string(resp.Body))
	}
	return resp
}

// The notice is the product's statement about what it is and is not, so it must
// reach every page that asks for it — and must not depend on JavaScript.
func TestProvenanceInjection(t *testing.T) {
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	if _, err := os.Stat(filepath.Join(appRoot, "partials", "provenance.html")); err != nil {
		t.Skip("no provenance partial in this checkout")
	}
	provenance := NewProvenance(appRoot, func(string) string { return "" })

	notice := provenance.HTML()
	if notice == "" {
		t.Fatal("the notice is empty")
	}
	// The authoring comments explain the file to a maintainer and have no
	// business being served to every visitor.
	if strings.HasPrefix(strings.TrimSpace(notice), "<!--") {
		t.Errorf("an authoring comment was served: %.120q", notice)
	}
	if strings.Contains(notice, "{{ALMANAC_HOME}}") || strings.Contains(notice, "{{ALMANAC_LABEL}}") {
		t.Errorf("an unsubstituted token was served: %.200q", notice)
	}
	// Both halves of the link must name the same domain — the bug that made this
	// a token substitution rather than a regex was a link whose text and
	// destination disagreed.
	if !strings.Contains(notice, "drupal-almanac.com") {
		t.Errorf("the default home is missing: %.200q", notice)
	}

	page := "<html><head></head><body>" + provenancePlaceholder + "</body></html>"
	injected := provenance.Inject(page)
	if strings.Contains(injected, provenancePlaceholder) || !strings.Contains(injected, notice) {
		t.Error("the placeholder was not replaced")
	}
	// A page without the marker is left alone, byte for byte.
	untouched := "<html><head></head><body>nothing here</body></html>"
	if provenance.Inject(untouched) != untouched {
		t.Error("a page without the marker was modified")
	}

	// A deployment can point the notice at its own address.
	own := NewProvenance(appRoot, func(name string) string {
		if name == "ALMANAC_HOME" {
			return "https://example.org/"
		}
		return ""
	})
	if !strings.Contains(own.HTML(), "https://example.org") ||
		strings.Contains(own.HTML(), "https://example.org/\"") {
		t.Errorf("the trailing slash should be trimmed: %.200q", own.HTML())
	}
}

// Comment-stripping is anchored to the start and LOOPED — that loop is the fix,
// and it is what removes a run of sibling comments rather than only the first.
//
// It does not survive a `-->` inside a comment's own prose: the strip ends
// there and the remainder is emitted. That is a real sharp edge in the partial's
// authoring rather than a difference between the two implementations, so it is
// pinned here against the JavaScript rather than asserted from either side.
func TestStripLeadingCommentsMatchesNode(t *testing.T) {
	sources := []string{
		"<!-- one -->\n<!-- two -->\n<section>the notice</section>\n",
		"<!-- explains the file, and mentions --> in passing -->\n<section>x</section>\n",
		"<section>no comments at all</section>\n",
		"  \n\n<!-- padded -->\n\n<section>x</section>",
		"<!-- never closed <section>x</section>",
		"",
	}
	payload := js.Arr()
	for _, source := range sources {
		payload.Append(js.Str(source))
	}
	out := ts.RunNode(t, nil, `
		const sources = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(sources.map((html) => {
			let trimmed = html.trimStart();
			while (trimmed.startsWith('<!--')) {
				const end = trimmed.indexOf('-->');
				if (end === -1) break;
				trimmed = trimmed.slice(end + 3).trimStart();
			}
			return trimmed;
		})));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, source := range sources {
		if got := stripLeadingComments(source); got != want[i] {
			t.Errorf("stripLeadingComments(%q) = %q, node = %q", source, got, want[i])
		}
	}

	// The loop is the part that matters: a run of sibling comments goes.
	if got := stripLeadingComments("<!-- a -->\n<!-- b -->\n<p>kept</p>"); got != "<p>kept</p>" {
		t.Errorf("sibling comments survived: %q", got)
	}
}

// The origin the social tags are built from, and the header precedence that
// decides it. A wrong answer here puts somebody else's domain on every share.
func TestViewerOriginPrecedence(t *testing.T) {
	cases := []struct {
		name         string
		headers      map[string]string
		host         string
		publicOrigin string
		want         string
	}{
		{"host alone", nil, "example.org", "", "http://example.org"},
		{"forwarded host wins over host",
			map[string]string{"X-Forwarded-Host": "viewer.example"}, "origin.internal", "",
			"http://viewer.example"},
		{"a proxy chain appends, so the viewer is first",
			map[string]string{"X-Forwarded-Host": "viewer.example, inner.example"},
			"origin.internal", "", "http://viewer.example"},
		{"forwarded proto",
			map[string]string{"X-Forwarded-Proto": "https"}, "example.org", "",
			"https://example.org"},
		{"cloudfront's own header wins",
			map[string]string{"CloudFront-Forwarded-Proto": "https", "X-Forwarded-Proto": "http"},
			"example.org", "", "https://example.org"},
		// The override is the answer for anyone who does not want these tags
		// derived from an attacker-controllable header at all.
		{"the override beats everything",
			map[string]string{"X-Forwarded-Host": "attacker.example"}, "example.org",
			"https://real.example/", "https://real.example"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Host = testCase.host
			for name, value := range testCase.headers {
				request.Header.Set(name, value)
			}
			if got := viewerOrigin(request, testCase.publicOrigin); got != testCase.want {
				t.Errorf("= %q, want %q", got, testCase.want)
			}
		})
	}
}

// A page that did not opt in must not be given social markup, and one that did
// must get absolute URLs.
func TestOgTagsAreOptIn(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/schedules/x?id=y", nil)
	request.Host = "example.org"

	if tags := ogTags(request, "<html><head></head></html>", ""); tags != "" {
		t.Errorf("a page without og:title was given tags: %q", tags)
	}

	tags := ogTags(request, `<meta property="og:title" content="x">`, "")
	for _, want := range []string{
		`<meta property="og:url" content="http://example.org/schedules/x">`,
		`<meta property="og:image" content="http://example.org/img/og-card.png">`,
		`<meta name="twitter:image" content="http://example.org/img/og-card.png">`,
	} {
		if !strings.Contains(tags, want) {
			t.Errorf("missing %s in %q", want, tags)
		}
	}
	// The query is deliberately dropped: a share of `?id=x` and of the bare page
	// are the same document, and two card URLs for one page splits the signal.
	if strings.Contains(tags, "id=y") {
		t.Errorf("the query string reached the card URL: %q", tags)
	}
}

// These values come from the Host header, so they are escaped.
func TestOgTagsEscapeTheHost(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Host = `example.org/"><script>alert(1)</script>`
	tags := ogTags(request, `<meta property="og:title" content="x">`, "")
	if strings.Contains(tags, "<script>") || strings.Contains(tags, `"><`) {
		t.Errorf("the host escaped its attribute: %q", tags)
	}
}

// The deep-route patterns, including the file rule that keeps a fetch from
// getting HTML back.
func TestDeepSectionPaths(t *testing.T) {
	cases := []struct {
		path    string
		archive bool
		editor  bool
	}{
		{"/archive/videos", true, false},
		{"/archive/speaker/somebody", true, false},
		{"/archive/topic/drupal/2024", true, false},
		{"/archive/data/catalog.json", false, false},
		{"/editor/drupalcon/eu/2026", false, true},
		{"/editor/schemas/event.schema.json", false, false},
		{"/editor/", false, false},
		{"/archive/", false, false},
		{"/archive//double", false, false},
		{"/archives/videos", false, false},
	}
	for _, testCase := range cases {
		if got := deepArchivePath(testCase.path); got != testCase.archive {
			t.Errorf("deepArchivePath(%q) = %v, want %v", testCase.path, got, testCase.archive)
		}
		if got := deepEditorPath(testCase.path); got != testCase.editor {
			t.Errorf("deepEditorPath(%q) = %v, want %v", testCase.path, got, testCase.editor)
		}
	}
}

// A deep route ships `<base href="/">` because the browser's preload scanner
// resolves stylesheets before any script could fix it.
//
// EVERY SERVED PAGE, not only the deep ones — the rule changed, and this test
// changed with it.
//
// It used to assert that `/` had no base ("home is served from the root; a base
// would be noise"). That reasoning held while the base was a fix for deep
// REQUESTS. It is not one any more: every section rewrites its own URL
// client-side without reloading, so a base decided from the request path is
// stale the moment that happens — load /editor, open a dataset, and the top
// nav's "./archive.html" resolves against /editor/<dataset>/ and 404s.
//
// So the base now means "this page is being served from the app root", which is
// true of home as well. On `/` it is a no-op; the value is that the invariant
// has no exceptions to remember.
//
// A static deployment gets no base at all — that is what lets it live at /repo/.
func TestEveryServedPageCarriesABaseTag(t *testing.T) {
	source := ts.ArchiveDir(t)
	if source == "" {
		t.Skip("no archive checkout found")
	}
	goServer := testApp(t, ts.CopyArchive(t, source))
	client := &http.Client{Timeout: 30 * time.Second}

	for path, wantBase := range map[string]bool{
		"/schedules/x":    true,
		"/planner/x":      true,
		"/archive/videos": true,
		"/editor/a/b":     true,
		"/schedules":      true, // shallow, and still client-routed
		"/archive":        true,
		"/editor":         true,
		"/":               true, // a no-op here, and one less exception to remember
	} {
		resp, err := client.Get(goServer.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if hasBase := strings.Contains(string(body), `<base href="/">`); hasBase != wantBase {
			t.Errorf("%s: base tag present = %v, want %v", path, hasBase, wantBase)
		}
	}
}
