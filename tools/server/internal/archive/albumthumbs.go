package archive

// A Go port of lib/albumThumbs.js — a cover image for a photo album, without an
// API key for every host.
//
// Flickr and Google Photos both publish an `og:image` on the album's own page —
// the picture they would show if you pasted the link into a chat app — so one
// resolver covers both, and anything else that follows the same convention.
//
// Two things make this safe to do from the server. The URL must already be an
// album recorded in the archive, so this cannot be pointed at an arbitrary host;
// and every answer is cached to disk, because an album's cover changes about as
// often as the conference happens.

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"server/internal/paths"
	"sort"
	"strings"
	"time"
)

// The three shapes the tag is written in, tried in the original's order:
// property-then-content, content-then-property, and Twitter's name for it.
var ogImagePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']`),
	regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']`),
	regexp.MustCompile(`(?i)<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']`),
}

var absoluteHTTP = regexp.MustCompile(`(?i)^https?://`)

// ExtractOgImage reads `og:image` (either attribute order) from a page.
func ExtractOgImage(html string) string {
	for _, pattern := range ogImagePatterns {
		match := pattern.FindStringSubmatch(html)
		if match == nil {
			continue
		}
		url := js.Trim(match[1])
		// Only an absolute http(s) image is worth storing: a relative one would
		// have to be resolved against a page we do not otherwise keep.
		if absoluteHTTP.MatchString(url) {
			return url
		}
		return ""
	}
	return ""
}

// KnownAlbums is every album URL the archive actually records.
//
// This is the allowlist: a request to resolve anything else is refused, so the
// endpoint cannot be used to make the server fetch a URL of the caller's
// choosing.
func KnownAlbums(dataDir string) (map[string]bool, error) {
	paths, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		parsed, err := js.ParseJSON(raw)
		if err != nil {
			continue // a dataset that will not parse has no album to offer
		}
		if url := js.Trim(parsed.Get("event").Get("flickr").Get("groupUrl").StrVal()); url != "" {
			out[url] = true
		}
	}
	return out, nil
}

// readOgImage reads a response only as far as its og:image.
//
// Flickr puts the tag in the first few kilobytes; Google Photos puts it 1.1 MB
// into a 1.4 MB document. Reading the whole body for both meant every Google
// album cost seconds and megabytes, so this consumes the stream in chunks and
// stops at the tag — and gives up at a ceiling rather than trusting a stranger's
// page to end.
//
// The ceiling is counted in bytes here where the JavaScript counts UTF-16 code
// units. It is a safety limit on a stranger's document, not a contract: the tag
// is a megabyte inside the largest page we know of, and both numbers are twice
// that.
func readOgImage(body io.Reader, maxBytes int) string {
	var buf strings.Builder
	chunk := make([]byte, 64*1024)
	for buf.Len() < maxBytes {
		n, err := body.Read(chunk[:min(len(chunk), maxBytes-buf.Len())])
		if n > 0 {
			buf.Write(chunk[:n])
			if found := ExtractOgImage(buf.String()); found != "" {
				return found
			}
			// The tag never appears after </head>; anything past it is the app
			// itself.
			if strings.Contains(buf.String(), "</head>") {
				break
			}
		}
		if err != nil {
			break
		}
	}
	return ExtractOgImage(buf.String())
}

// DuplicateCovers reports albums whose cached cover is shared with several
// others.
//
// A cache holding the WRONG answer is worse than one holding none: a hit lives
// for thirty days, so a bad write is served for a month. Production once showed
// the same photograph on all 54 cards, and nothing in a normal run would have
// corrected it — filling gaps skips every entry that already has a cover.
//
// Two albums sharing a cover is possible (the same photo in two pools), so one
// duplicate is not evidence. Three is: no real archive has one picture standing
// for three different conferences.
func DuplicateCovers(cache *js.Value, albums []string, min int) map[string][]string {
	byThumb := map[string][]string{}
	var order []string
	for _, url := range albums {
		thumb := cache.Get(url).Get("thumb").StrVal()
		if thumb == "" {
			continue
		}
		if _, seen := byThumb[thumb]; !seen {
			order = append(order, thumb)
		}
		byThumb[thumb] = append(byThumb[thumb], url)
	}
	out := map[string][]string{}
	for _, thumb := range order {
		if len(byThumb[thumb]) >= min {
			out[thumb] = byThumb[thumb]
		}
	}
	return out
}

const albumCacheFile = "album-thumbs.json"

// LoadThumbCache reads the cache. No file yet is the normal first run, not an
// error.
func LoadThumbCache(dataDir string) *js.Value {
	raw, err := os.ReadFile(filepath.Join(dataDir, albumCacheFile))
	if err != nil {
		return js.Obj()
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return js.Obj()
	}
	return parsed
}

// SaveThumbCache writes it back in the JavaScript's format.
func SaveThumbCache(dataDir string, cache *js.Value) error {
	path := filepath.Join(dataDir, albumCacheFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(cache.Encode("  "), '\n'), 0o644)
}

// ThumbOptions is what a caller can vary about one resolution.
type ThumbOptions struct {
	Client      *http.Client
	Now         time.Time
	TTLDays     float64
	MissTTLDays float64
	Refresh     bool
}

const day = 864e5 // ms, as the JavaScript writes it

// ResolveThumb resolves one album's cover, using the cache first.
//
// A miss is cached too — as an empty string with a timestamp — so an album whose
// host publishes nothing is not re-fetched on every page view. It is kept for far
// less time than a hit, because a miss is often not the album's fault: resolving
// all 33 in a row had Google rate-limit two of them, and both had covers when
// asked again a moment later. A month of blankness for a momentary 429 is the
// wrong trade.
//
// Refresh re-asks even when the cache has an answer — the way to clear a miss
// that was really a rate-limit, without waiting for it to expire.
func ResolveThumb(url string, cache *js.Value, options ThumbOptions) (thumb string, cached bool) {
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	if options.TTLDays == 0 {
		options.TTLDays = 30
	}
	if options.MissTTLDays == 0 {
		options.MissTTLDays = 2
	}
	now := float64(options.Now.UnixMilli())

	if hit := cache.Get(url); hit.Exists() {
		ttl := options.MissTTLDays * day
		if hit.Get("thumb").StrVal() != "" {
			ttl = options.TTLDays * day
		}
		at, _ := hit.Get("at").Number()
		if !options.Refresh && now-at < ttl {
			return hit.Get("thumb").StrVal(), true
		}
	}

	thumb = fetchOgImage(url, options.Client)
	cache.Set(url, js.Obj().Set("thumb", js.Str(thumb)).Set("at", js.Int(int(options.Now.UnixMilli()))))
	return thumb, false
}

// fetchOgImage asks the host. Every way this can go wrong — unreachable host,
// timeout, bad TLS, a non-200 — is the same answer here: no cover.
func fetchOgImage(url string, client *http.Client) string {
	if client == nil {
		client = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	request.Header.Set("user-agent", "conference-planner (archive album preview)")

	response, err := client.Do(request)
	if err != nil {
		return ""
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return ""
	}
	return readOgImage(response.Body, 2_000_000)
}

// SortedAlbums is the album list in a stable order, for the callers that report
// on the whole set rather than resolving one.
func SortedAlbums(albums map[string]bool) []string {
	out := make([]string, 0, len(albums))
	for url := range albums {
		out = append(out, url)
	}
	sort.Strings(out)
	return out
}
