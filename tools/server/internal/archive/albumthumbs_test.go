package archive

import (
	"encoding/json"
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

// The tag appears in three shapes across the hosts the archive links to, and a
// relative URL must never be stored, so the extractor is compared against the
// JavaScript on every shape at once.
func TestExtractOgImageMatchesNode(t *testing.T) {
	pages := []string{
		`<meta property="og:image" content="https://live.staticflickr.com/1/2_b.jpg">`,
		`<meta content="https://lh3.googleusercontent.com/x" property="og:image">`,
		`<meta name="twitter:image" content="https://example.org/t.png">`,
		`<meta property='og:image' content='https://example.org/single.png'>`,
		`<META PROPERTY="OG:IMAGE" CONTENT="https://example.org/shouty.png">`,
		// Relative and non-http are refused rather than stored.
		`<meta property="og:image" content="/relative.png">`,
		`<meta property="og:image" content="data:image/png;base64,AAA">`,
		`<meta property="og:image" content="  https://example.org/padded.png  ">`,
		// The first shape wins when a page carries several.
		`<meta name="twitter:image" content="https://example.org/tw.png">` +
			`<meta property="og:image" content="https://example.org/og.png">`,
		`<html><head><title>no tag here</title></head>`,
		``,
	}
	payload := js.Arr()
	for _, page := range pages {
		payload.Append(js.Str(page))
	}
	out := ts.RunNode(t, nil, `
		const { extractOgImage } = await import('./scripts/lib/albumThumbs.js');
		const pages = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(pages.map(extractOgImage)));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, page := range pages {
		if got := ExtractOgImage(page); got != want[i] {
			t.Errorf("ExtractOgImage(%q) = %q, node = %q", page, got, want[i])
		}
	}
}

// The rule that decides whether a cache is poisoned.
func TestDuplicateCoversMatchesNode(t *testing.T) {
	cache := js.Obj().
		Set("https://a", js.Obj().Set("thumb", js.Str("https://img/shared"))).
		Set("https://b", js.Obj().Set("thumb", js.Str("https://img/shared"))).
		Set("https://c", js.Obj().Set("thumb", js.Str("https://img/shared"))).
		Set("https://d", js.Obj().Set("thumb", js.Str("https://img/pair"))).
		Set("https://e", js.Obj().Set("thumb", js.Str("https://img/pair"))).
		Set("https://f", js.Obj().Set("thumb", js.Str("https://img/lonely"))).
		Set("https://g", js.Obj().Set("thumb", js.Str(""))).
		Set("https://h", js.Obj())
	albums := []string{"https://a", "https://b", "https://c", "https://d",
		"https://e", "https://f", "https://g", "https://h", "https://never-cached"}

	list := js.Arr()
	for _, url := range albums {
		list.Append(js.Str(url))
	}
	out := ts.RunNode(t, nil, `
		const { duplicateCovers } = await import('./scripts/lib/albumThumbs.js');
		const [cache, albums] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2])];
		process.stdout.write(JSON.stringify(
			Object.fromEntries(duplicateCovers(cache, albums))));
	`, string(cache.Encode("")), string(list.Encode("")))

	var want map[string][]string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	got := DuplicateCovers(cache, albums, 3)
	if len(got) != len(want) {
		t.Fatalf("go found %v, node found %v", got, want)
	}
	for thumb, urls := range want {
		if strings.Join(got[thumb], ",") != strings.Join(urls, ",") {
			t.Errorf("%s: go %v, node %v", thumb, got[thumb], urls)
		}
	}
	// The pair must NOT be flagged: two albums can honestly share a photo.
	if _, flagged := got["https://img/pair"]; flagged {
		t.Error("two albums sharing a cover is not evidence of a poisoned cache")
	}
}

// The allowlist is the only thing stopping this endpoint fetching a URL of the
// caller's choosing, so it is read from real dataset files.
func TestKnownAlbumsReadsDatasets(t *testing.T) {
	root := t.TempDir()
	events := filepath.Join(root, "events", "drupaljam", "nl")
	if err := os.MkdirAll(events, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(events, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("2024.json", `{"event":{"flickr":{"groupUrl":"  https://flickr.com/groups/x  "}}}`)
	write("2023.json", `{"event":{"flickr":{"groupUrl":"https://photos.google.com/share/y"}}}`)
	write("2022.json", `{"event":{"name":"no album"}}`)
	write("broken.json", `{"event":`)
	write("notes.txt", `https://not-a-dataset.example`)

	albums, err := KnownAlbums(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://flickr.com/groups/x", "https://photos.google.com/share/y"}
	if got := SortedAlbums(albums); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("albums = %v, want %v", got, want)
	}

	// A dataset that will not parse must not take the whole allowlist with it.
	if len(albums) != 2 {
		t.Errorf("a broken dataset changed the allowlist: %v", albums)
	}
}

// A missing directory is the normal state of a fresh checkout, not a failure.
func TestKnownAlbumsToleratesNoEvents(t *testing.T) {
	albums, err := KnownAlbums(t.TempDir())
	if err != nil || len(albums) != 0 {
		t.Errorf("= %v %v", albums, err)
	}
}

func TestThumbCacheRoundTripsThroughNode(t *testing.T) {
	dir := t.TempDir()
	if cache := LoadThumbCache(dir); cache.Len() != 0 {
		t.Error("no cache file yet should read as empty, not as an error")
	}

	cache := js.Obj().
		Set("https://flickr.com/groups/x", js.Obj().
			Set("thumb", js.Str("https://live.staticflickr.com/1/2_b.jpg")).
			Set("at", js.Int(1700000000000))).
		Set("https://photos.google.com/share/y", js.Obj().
			Set("thumb", js.Str("")).
			Set("at", js.Int(1700000001000)))
	if err := SaveThumbCache(dir, cache); err != nil {
		t.Fatal(err)
	}

	// Byte-identical to what the JavaScript writes for the same object.
	written, err := os.ReadFile(filepath.Join(dir, "album-thumbs.json"))
	if err != nil {
		t.Fatal(err)
	}
	nodeText := ts.RunNode(t, nil, `
		process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]), null, 2) + '\n');
	`, string(cache.Encode("")))
	if string(written) != nodeText {
		t.Errorf("cache file differs:\ngo:   %q\nnode: %q", written, nodeText)
	}

	reloaded := LoadThumbCache(dir)
	if reloaded.Get("https://flickr.com/groups/x").Get("thumb").StrVal() !=
		"https://live.staticflickr.com/1/2_b.jpg" {
		t.Errorf("reloaded = %s", reloaded.Encode(""))
	}
}

// A cache file somebody has hand-edited into invalid JSON should cost a refetch,
// not a crash.
func TestThumbCacheSurvivesCorruption(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "album-thumbs.json"), []byte("{oops"), 0o644); err != nil {
		t.Fatal(err)
	}
	if cache := LoadThumbCache(dir); cache.Len() != 0 {
		t.Errorf("= %s", cache.Encode(""))
	}
}

func TestResolveThumbCachingRules(t *testing.T) {
	var hits int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if agent := r.Header.Get("user-agent"); !strings.Contains(agent, "conference-planner") {
			t.Errorf("user-agent = %q", agent)
		}
		if r.URL.Path == "/missing" {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		// The tag sits behind a lot of markup, as it does on a real album page.
		_, _ = w.Write([]byte("<html><head>" + strings.Repeat("<link>", 5000) +
			`<meta property="og:image" content="https://img.example/cover.jpg">` +
			"</head><body>ignored</body></html>"))
	}))
	defer server.Close()

	cache := js.Obj()
	now := time.Unix(1700000000, 0)
	options := ThumbOptions{Client: server.Client(), Now: now}

	thumb, cached := ResolveThumb(server.URL+"/album", cache, options)
	if thumb != "https://img.example/cover.jpg" || cached {
		t.Fatalf("first = %q %v", thumb, cached)
	}
	if hits != 1 {
		t.Fatalf("hits = %d", hits)
	}

	// A hit is served from the cache for thirty days.
	options.Now = now.Add(29 * 24 * time.Hour)
	if thumb, cached = ResolveThumb(server.URL+"/album", cache, options); !cached || hits != 1 {
		t.Errorf("day 29: %q cached=%v hits=%d", thumb, cached, hits)
	}
	options.Now = now.Add(31 * 24 * time.Hour)
	if _, cached = ResolveThumb(server.URL+"/album", cache, options); cached || hits != 2 {
		t.Errorf("day 31 should re-ask: cached=%v hits=%d", cached, hits)
	}

	// A miss is cached too, but for two days rather than thirty — a 429 is
	// usually the host's mood, not the album's fault.
	options.Now = now
	if thumb, cached = ResolveThumb(server.URL+"/missing", cache, options); thumb != "" || cached {
		t.Errorf("miss = %q %v", thumb, cached)
	}
	before := hits
	options.Now = now.Add(24 * time.Hour)
	if _, cached = ResolveThumb(server.URL+"/missing", cache, options); !cached || hits != before {
		t.Errorf("day 1 should still be cached: cached=%v", cached)
	}
	options.Now = now.Add(3 * 24 * time.Hour)
	if _, cached = ResolveThumb(server.URL+"/missing", cache, options); cached || hits != before+1 {
		t.Errorf("day 3 should re-ask a miss: cached=%v hits=%d", cached, hits)
	}

	// Refresh is how a rate-limited miss gets cleared without waiting.
	options.Now = now
	before = hits
	if _, cached = ResolveThumb(server.URL+"/album", cache, options); !cached {
		t.Fatal("expected a cached hit to set up the refresh case")
	}
	options.Refresh = true
	if _, cached = ResolveThumb(server.URL+"/album", cache, options); cached || hits != before+1 {
		t.Errorf("refresh should re-ask: cached=%v hits=%d", cached, hits)
	}
}

// An unreachable host is an answer, not an error.
func TestResolveThumbSurvivesADeadHost(t *testing.T) {
	cache := js.Obj()
	thumb, cached := ResolveThumb("http://127.0.0.1:1/album", cache,
		ThumbOptions{Now: time.Unix(1700000000, 0)})
	if thumb != "" || cached {
		t.Errorf("= %q %v", thumb, cached)
	}
	// The failure is recorded so the next page view does not retry immediately.
	if !cache.Get("http://127.0.0.1:1/album").Exists() {
		t.Error("a failed resolution should still be cached as a miss")
	}
}

// The ceiling exists so a stranger's endless document cannot be read forever.
func TestReadOgImageGivesUpAtTheCeiling(t *testing.T) {
	tag := `<meta property="og:image" content="https://img.example/deep.jpg">`
	page := "<html><head>" + strings.Repeat("<link>", 30000) + tag

	if got := readOgImage(strings.NewReader(page), 2_000_000); got != "https://img.example/deep.jpg" {
		t.Errorf("within the ceiling: %q", got)
	}
	// Cut the budget below where the tag sits and it is simply not found.
	if got := readOgImage(strings.NewReader(page), 1000); got != "" {
		t.Errorf("past the ceiling: %q", got)
	}
}
