package web

// The HTML page layer: section addresses, deep routes, and the two things the
// server injects into a page that the page cannot know itself.
//
// A port of the `sendPage`/`canonical` block in server.js and of
// lib/provenance.js.
//
// Every section has ONE address when this app is served: /schedules, /planner,
// /archive, /editor. The pages themselves still link to `./index.html`,
// `./planner.html` and friends, because those are the links that work when the
// app is deployed as plain files — so the file form is canonicalised HERE
// rather than guessed at in the browser.

import (
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/js"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── The provenance notice ───────────────────────────────────────────────────

// provenancePlaceholder is the marker a page puts where the notice belongs.
//
// It is a plain HTML comment, so a static deployment that never runs this
// server renders nothing visible rather than a broken element.
const provenancePlaceholder = "<!--provenance-->"

// Provenance holds the notice, read once.
//
// Injected server-side rather than fetched by the client on purpose: a
// disclosure that depends on JavaScript is a disclosure that sometimes is not
// there.
type Provenance struct {
	AppRoot     string
	AlmanacHome string // where corrections and removals are handled; per-deployment

	once sync.Once
	html string
}

// NewProvenance reads the deployment's canonical home from the environment.
func NewProvenance(appRoot string, env func(string) string) *Provenance {
	home := strings.TrimSpace(env("ALMANAC_HOME"))
	if home == "" {
		home = "https://drupal-almanac.com"
	}
	return &Provenance{AppRoot: appRoot, AlmanacHome: strings.TrimRight(home, "/")}
}

// HTML is the notice, with the canonical home applied.
func (p *Provenance) HTML() string {
	p.once.Do(func() {
		raw, err := os.ReadFile(filepath.Join(p.AppRoot, "partials", "provenance.html"))
		if err != nil {
			return // a deployment without the partial renders no notice, not an error page
		}
		body := stripLeadingComments(string(raw))
		// Token substitution, not pattern matching on markup: the formatter wraps
		// long tags across lines, and a regex written against the unwrapped shape
		// silently replaced the href while leaving the visible label saying the
		// old domain — a link whose text and destination disagreed.
		label := strings.TrimPrefix(strings.TrimPrefix(p.AlmanacHome, "https://"), "http://")
		body = strings.ReplaceAll(body, "{{ALMANAC_HOME}}", p.AlmanacHome)
		body = strings.ReplaceAll(body, "{{ALMANAC_LABEL}}", label)
		p.html = strings.TrimSpace(body)
	})
	return p.html
}

// Inject replaces the marker in a page. A page without the marker is left alone.
func (p *Provenance) Inject(html string) string {
	if !strings.Contains(html, provenancePlaceholder) {
		return html
	}
	return strings.Replace(html, provenancePlaceholder, p.HTML(), 1)
}

// stripLeadingComments drops the authoring comments at the top of the partial.
// They explain the file to a maintainer and have no business being served to
// every visitor.
//
// Anchored to the START and looped, rather than one lazy match: the first
// version of this stopped at the first `-->` it found, which was one INSIDE the
// comment's own prose, and shipped the remainder of that comment to every
// reader.
func stripLeadingComments(html string) string {
	trimmed := jsTrimStart(html)
	for strings.HasPrefix(trimmed, "<!--") {
		end := strings.Index(trimmed, "-->")
		if end == -1 {
			break
		}
		trimmed = jsTrimStart(trimmed[end+3:])
	}
	return trimmed
}

func jsTrimStart(s string) string { return strings.TrimLeftFunc(s, js.IsSpace) }

// ── Social metadata ─────────────────────────────────────────────────────────

// viewerOrigin is the origin as the VIEWER sees it, which is not always what the
// origin server sees.
//
// CloudFront sends the ORIGIN's own domain in `Host` unless the distribution is
// configured to forward the viewer's, so reading `Host` alone produced
// `https://app-origin.internal.example/…` on every share. Proxies that preserve
// the viewer host advertise it in `X-Forwarded-Host`, so that wins.
//
// PUBLIC_ORIGIN is an explicit override for topologies where neither header is
// trustworthy — and, incidentally, the answer for anyone who does not want these
// tags derived from an attacker-controllable header at all. Nothing but the
// og/twitter metadata uses this, so a forged Host cannot move a redirect or a
// cookie; it can only put a wrong URL in somebody's share preview.
func viewerOrigin(r *http.Request, publicOrigin string) string {
	if override := strings.TrimSpace(publicOrigin); override != "" {
		return strings.TrimRight(override, "/")
	}
	// A proxy chain appends, so the viewer's host is the FIRST entry.
	host := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
	if host == "" {
		host = r.Host
	}
	proto := strings.TrimSpace(r.Header.Get("CloudFront-Forwarded-Proto"))
	if proto == "" {
		proto = strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	}
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host
}

// ogTags completes the social markup a page opted into.
//
// `og:url` and `og:image` must be ABSOLUTE, and a shared product must not have
// somebody's domain compiled into it — anyone can host this, and a hardcoded
// origin would make every share on their deployment point at someone else's
// site.
//
// Pages OPT IN by carrying `og:title` in their own markup. The server completes
// what only it can know; it never invents social markup for a page that did not
// ask (the gated tools have none, and should not).
func ogTags(r *http.Request, html, publicOrigin string) string {
	if !strings.Contains(html, "og:title") {
		return ""
	}
	origin := viewerOrigin(r, publicOrigin)
	// The path without the query: a share of `?id=x` and of the bare page are the
	// same document, and two card URLs for one page splits the sharing signal.
	url := origin + r.URL.Path
	card := escapeAttr(origin + "/img/og-card.png")
	return "\n  <meta property=\"og:url\" content=\"" + escapeAttr(url) + "\">" +
		"\n  <meta property=\"og:image\" content=\"" + card + "\">" +
		"\n  <meta name=\"twitter:image\" content=\"" + card + "\">"
}

// escapeAttr is minimal attribute escaping — these values come from the Host
// header.
func escapeAttr(v string) string {
	return strings.NewReplacer("&", "&amp;", `"`, "&quot;", "<", "&lt;").Replace(v)
}

// ── Serving a page ──────────────────────────────────────────────────────────

// PageServer serves the app's HTML with the two server-side injections applied.
type PageServer struct {
	AppRoot      string
	Provenance   *Provenance
	PublicOrigin string

	mu    sync.Mutex
	cache map[string]cachedPage
}

type cachedPage struct {
	stamp time.Time
	size  int64
	raw   string
}

// read returns the page with its provenance notice already in place.
//
// Keyed by mtime, not just by name: an unkeyed cache serves the page as it was
// at boot, so an edited file keeps rendering the old markup and a verification
// pass reports a clean run against markup that no longer exists. It cost two
// false passes during the rebrand before anyone noticed.
//
// The FILE is cached, not the response: the OG tags differ per request (host,
// path), so baking them into the cached copy would serve the first visitor's URL
// to everyone after them. The provenance notice is injected here, at read time,
// because it is identical for every visitor.
func (p *PageServer) read(file string) (string, os.FileInfo, error) {
	full := filepath.Join(p.AppRoot, file)
	info, err := os.Stat(full)
	if err != nil {
		return "", nil, err
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if hit, ok := p.cache[file]; ok && hit.stamp.Equal(info.ModTime()) && hit.size == info.Size() {
		return hit.raw, info, nil
	}

	raw, err := os.ReadFile(full)
	if err != nil {
		return "", nil, err
	}
	page := string(raw)
	if p.Provenance != nil {
		page = p.Provenance.Inject(page)
	}
	if p.cache == nil {
		p.cache = map[string]cachedPage{}
	}
	p.cache[file] = cachedPage{stamp: info.ModTime(), size: info.Size(), raw: page}
	return page, info, nil
}

// SendPage serves one of the app's HTML files.
//
// EVERY SERVED PAGE GETS `<base href="/">`, not just the deep ones.
//
// It began as a deep-route fix: /planner/<slug> serves the same HTML from a
// deeper path, so relative asset URLs would resolve against the route. (The
// client used to insert the base itself from an inline script — too late: the
// speculative preload scanner has already started fetching the stylesheets, and
// they resolved against the route, returning this very HTML at 200 text/html
// rather than 404. A status-code check does not see that, and a warm
// service-worker cache hides it entirely.)
//
// Conditioning it on the REQUEST was still wrong, because the request is not
// where the address ends up. Every section rewrites the URL client-side —
// editor.js replaceStates to /editor/<dataset>/<tab>, the archive pushes a
// drill — and the page is not reloaded, so a base decided at load time is stale
// the moment that happens. Load /editor (shallow, no base), open a dataset, and
// the top nav's "./archive.html" now resolves against /editor/<dataset>/ and
// 404s. That is the reported bug, and it is a property of client routing, not
// of any one link.
//
// So the base is unconditional here: when this app is SERVED, every relative URL
// on the page is anchored to the app root and stays anchored however the client
// moves the address. A static deployment has no server, gets no base, and keeps
// resolving document-relative — which is what lets it live at /repo/.
func (p *PageServer) SendPage(w http.ResponseWriter, r *http.Request, file string, social bool) {
	page, info, err := p.read(file)
	if err != nil {
		notFound(w, r)
		return
	}

	head := "\n  <base href=\"/\">"
	if social {
		head += ogTags(r, page, p.PublicOrigin)
	}

	if head == "" {
		// `res.sendFile`: the file's own stat ETag and Last-Modified, so a
		// conditional request still gets its 304.
		p.sendFile(w, r, filepath.Join(p.AppRoot, file), info)
		return
	}
	body := replaceHeadTag(page, head)

	header := w.Header()
	header.Set("Content-Type", "text/html; charset=utf-8")
	header.Set("ETag", expressContentETag(body))
	header.Set("Content-Length", strconv.Itoa(len(body)))
	if match := r.Header.Get("If-None-Match"); match != "" && match == header.Get("ETag") {
		header.Del("Content-Length")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(body))
	}
}

func (p *PageServer) sendFile(w http.ResponseWriter, r *http.Request, full string, info os.FileInfo) {
	file, err := os.Open(full)
	if err != nil {
		notFound(w, r)
		return
	}
	defer file.Close()
	header := w.Header()
	header.Set("Content-Type", "text/html; charset=UTF-8")
	header.Set("ETag", expressETag(info.Size(), nodeMtimeMillis(info.ModTime())))
	header.Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, filepath.Base(full), info.ModTime(), file)
}

// replaceHeadTag inserts into the first <head>, case-insensitively, matching
// `html.replace(/<head>/i, …)`.
func replaceHeadTag(html, head string) string {
	lower := strings.ToLower(html)
	index := strings.Index(lower, "<head>")
	if index == -1 {
		return html
	}
	return html[:index+len("<head>")] + head + html[index+len("<head>"):]
}

// expressContentETag reproduces the tag `res.send` puts on a generated body: a
// weak tag of the byte length in hex and a truncated base64 SHA-1 of the
// content.
//
// The format matters for the same reason the static one does — a tag in any
// other shape turns every revalidation of a page into a full 200.
func expressContentETag(body string) string {
	sum := sha1.Sum([]byte(body))
	digest := base64.StdEncoding.EncodeToString(sum[:])
	return `W/"` + strconv.FormatInt(int64(len(body)), 16) + "-" + digest[:27] + `"`
}

// ── Section addresses ───────────────────────────────────────────────────────

// canonicalRedirect is the 301 from a file-form address to its section address.
//
// The query string is carried across, so `./planner.html?id=x` still lands on
// the right planner; the client then rewrites that to `/planner/x` itself.
func canonicalRedirect(w http.ResponseWriter, r *http.Request, to string) {
	target := to
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	expressRedirect(w, r, http.StatusMovedPermanently, target)
}

// deepArchivePath matches /archive/<one or more segments>, where the last does
// not look like a file.
//
// One or more segments in total: the home's view modes are a single segment
// (/archive/videos), a drill is two (/archive/speaker/<name>), and a topic drill
// is three. This used to require exactly two, so the view modes 404ed before the
// client ever saw them.
func deepArchivePath(path string) bool { return deepSectionPath(path, "/archive/") }

// deepEditorPath is the same shape under /editor.
//
// The "last segment must not look like a file" rule is load-bearing. Without it
// this route answered EVERY path under /editor/ with the page — so a
// document-relative `fetch('./schemas/event.schema.json')` from a deep route got
// HTML back and died on "Unexpected token '<'". A request that names a file must
// fall through to static/404, where a wrong URL fails loudly instead of looking
// like data.
func deepEditorPath(path string) bool { return deepSectionPath(path, "/editor/") }

func deepSectionPath(path, prefix string) bool {
	if !strings.HasPrefix(path, prefix) {
		return false
	}
	segments := strings.Split(strings.TrimPrefix(path, prefix), "/")
	for index, segment := range segments {
		if segment == "" {
			return false
		}
		// Only the LAST segment is barred from looking like a file.
		if index == len(segments)-1 && strings.Contains(segment, ".") {
			return false
		}
	}
	return len(segments) >= 1
}
