package web

// The first HTTP surface: `/data` and `/img`.
//
// These two mounts are the archive's URL contract — dataset files store
// `./img/…` paths and the client fetches `./data/catalog.json` — and they are
// the only routes in the server that are pure static file serving with no auth,
// no session and no shared state. That is what makes them the right first slice
// to move: a Go service can take them behind a path route while Node keeps
// everything else, with no change to a single client.
//
// Matching Express is the whole job, and "matching" means the headers. A cache
// is a machine that reads headers, so an ETag in a different format or a
// missing charset is a behaviour change even when the bytes are identical.
// serve_test.go boots the real Node server and compares both against it.

import (
	"compress/gzip"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/planner"
	"strconv"
	"strings"
	"time"
)

// Mount is one static tree published at one URL prefix.
type Mount struct {
	Prefix string // "/data"
	Dir    string // absolute path on disk
}

// Security headers the Node server sets on every response. Reproduced because a
// path-routed deployment means these responses no longer pass through it, and a
// header that protects the archive should not be lost to a refactor.
var securityHeaders = [][2]string{
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "strict-origin-when-cross-origin"},
	{"Permissions-Policy", "geolocation=(), camera=(), microphone=()"},
	{"X-Frame-Options", "DENY"},
	{"Access-Control-Allow-Origin", "*"},
	{"Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS"},
	{"Access-Control-Allow-Headers", "Content-Type, Authorization"},
}

// NewServer builds the handler. It serves exactly what it is given and 404s
// everything else — it is a component of the site, not the site.
//
// Deliberately not http.ServeMux: ServeMux cleans request paths and answers
// with a 301 when the cleaned form differs, so `/data//catalog.json` would
// redirect where Express serves it. Routing here is a prefix match on the raw
// path, and the cleaning happens once, in resolveRequestPath, where it can
// refuse rather than redirect.
func NewServer(mounts []Mount) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, header := range securityHeaders {
			w.Header().Set(header[0], header[1])
		}

		if r.URL.Path == "/schedule.ics" {
			serveScheduleIcs(w, r, mounts)
			return
		}

		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Cache-Control", policyPrivate)
			fmt.Fprint(w, "ok")
			return
		}

		for _, mount := range mounts {
			if r.URL.Path == mount.Prefix || strings.HasPrefix(r.URL.Path, mount.Prefix+"/") {
				serveMount(w, r, mount)
				return
			}
		}
		notFound(w, r)
	})
}

// serveScheduleIcs is the public feed of a whole event's programme.
//
// No token: the same public data the schedule page shows. The event file is
// whitelisted against the catalog inside BuildEventScheduleIcs, which is what
// stops a request naming an arbitrary path.
//
// Note the Cache-Control here is a literal `public, max-age=1800` rather than
// the cache policy's DATA value — because that is what the Node route sets, and
// the policy table (which says `max-age=60` for /schedule.ics) has never been
// what this route actually sends. Reproduced, and worth reconciling later on the
// JavaScript side rather than silently changing during a port.
func serveScheduleIcs(w http.ResponseWriter, r *http.Request, mounts []Mount) {
	dataDir := ""
	for _, mount := range mounts {
		if mount.Prefix == "/data" {
			dataDir = mount.Dir
		}
	}
	if dataDir == "" {
		notFound(w, r)
		return
	}

	query := r.URL.Query()
	file := paths.FirstNonEmpty(query.Get("e"), query.Get("event"))
	if file == "" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("Missing e (event file) or id (slug)."))
		return
	}

	feed := planner.BuildEventScheduleIcs(file, dataDir, planner.DefaultDTStamp())
	if feed == nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("Not found."))
		return
	}

	header := w.Header()
	header.Set("Cache-Control", "public, max-age=1800")
	// The dataset's mtime and size in base 36 — NOT the base-16 shape
	// express.static uses for files, and NOT rounded to whole milliseconds:
	// `st.mtimeMs` is a float and its base-36 form carries a fraction.
	if info, err := os.Stat(feed.Path); err == nil {
		millis := float64(info.ModTime().Unix())*1000 +
			float64(info.ModTime().Nanosecond())/1e6
		etag := `W/"` + js.JSNumberToStringRadix(millis, 36) + "-" +
			strconv.FormatInt(info.Size(), 36) + `"`
		header.Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	header.Set("Content-Type", "text/calendar; charset=utf-8")
	header.Set("Content-Disposition", `inline; filename="calendar.ics"`)
	_, _ = w.Write([]byte(feed.ICS))
}

func serveMount(w http.ResponseWriter, r *http.Request, mount Mount) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.Header().Set("Cache-Control", CacheControlFor(r.URL.Path, false))
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	rel, ok := resolveRequestPath(mount.Prefix, r.URL.Path)
	if !ok {
		notFound(w, r)
		return
	}

	full := filepath.Join(mount.Dir, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil {
		notFound(w, r)
		return
	}
	if info.IsDir() {
		// express.static redirects a directory to its trailing-slash form, and
		// then has no index to serve. Reproduced because a client that follows
		// it gets the same answer either way; NOT reproduced for the mount root
		// itself — see resolveRequestPath.
		if !strings.HasSuffix(r.URL.Path, "/") {
			redirectToSlash(w, r)
			return
		}
		notFound(w, r)
		return
	}

	file, err := os.Open(full)
	if err != nil {
		notFound(w, r)
		return
	}
	defer file.Close()

	urlPath := mount.Prefix + "/" + rel
	header := w.Header()
	header.Set("Cache-Control", CacheControlFor(urlPath, r.URL.Query().Has("v")))
	if contentType := contentTypeFor(rel); contentType != "" {
		header.Set("Content-Type", contentType)
	}
	// Go canonicalises this to `Etag` on the wire where Express writes `ETag`.
	// Left alone deliberately: header names are case-insensitive (RFC 9110
	// §5.1) and HTTP/2 lowercases them all anyway, but more to the point
	// ServeContent reads the tag back through the canonicalising getter to do
	// If-None-Match. Writing the map key directly to force the casing would
	// make that lookup miss, trading working 304s for a cosmetic match.
	header.Set("ETag", expressETag(info.Size(), nodeMtimeMillis(info.ModTime())))
	header.Set("Accept-Ranges", "bytes")
	header.Set("Vary", "Accept-Encoding")

	writer := http.ResponseWriter(w)
	if gz := maybeGzip(w, r, rel, info.Size()); gz != nil {
		defer gz.Close()
		writer = gz
	}

	// ServeContent handles Range, If-None-Match, If-Modified-Since and
	// Last-Modified. The ETag set above is what it matches conditionals against.
	http.ServeContent(writer, r, filepath.Base(full), info.ModTime(), file)
}

// gzipResponseWriter compresses a response body in flight.
//
// Express runs `compression()`, so a client that asks for gzip gets it. The
// compressed bytes will not be identical to Node's — that is a property of the
// encoder, not of the content — but the decompressed body is, which is what the
// archive is promising.
type gzipResponseWriter struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) { return g.writer.Write(b) }
func (g *gzipResponseWriter) Close() error                { return g.writer.Close() }

// maybeGzip returns a compressing writer when the client asked for gzip and the
// content is worth compressing, or nil.
func maybeGzip(w http.ResponseWriter, r *http.Request, rel string, size int64) *gzipResponseWriter {
	// Inside the assembled app the middleware is already doing this. Two gzip
	// layers would produce a body no client can read, and nothing in a header
	// would say so.
	if alreadyCompressing(w) {
		return nil
	}
	// The `compression` default: below a kilobyte the header costs more than
	// the saving.
	if size < 1024 || !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		return nil
	}
	if r.Header.Get("Range") != "" {
		// A compressed range is a range of the compressed stream, which is not
		// what the client asked for.
		return nil
	}
	if !compressible(rel) {
		return nil
	}
	w.Header().Set("Content-Encoding", "gzip")
	// The length of the compressed body is not known yet, and a wrong one is
	// worse than none.
	w.Header().Del("Content-Length")
	return &gzipResponseWriter{ResponseWriter: w, writer: gzip.NewWriter(w)}
}

// compressible reports whether an extension is worth gzipping. PNG, JPEG, GIF
// and WebP are already compressed; running them through gzip costs CPU and
// gains nothing.
func compressible(rel string) bool {
	switch strings.ToLower(filepath.Ext(rel)) {
	case ".json", ".svg", ".ics", ".txt", ".html", ".css", ".js", ".mjs":
		return true
	}
	return false
}

func redirectToSlash(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Path + "/"
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	body := "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n" +
		"<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to " + target +
		"</pre>\n</body>\n</html>\n"
	header := w.Header()
	header.Set("Cache-Control", CacheControlFor(r.URL.Path, false))
	header.Set("Content-Type", "text/html; charset=UTF-8")
	header.Set("Content-Security-Policy", "default-src 'none'")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	header.Set("Location", target)
	w.WriteHeader(http.StatusMovedPermanently)
	fmt.Fprint(w, body)
}

// notFound answers the way the Node app does in every respect that matters to a
// cache: the same status, and the same Cache-Control for the path.
//
// The BODY differs deliberately. Node serves app/404.html to anything that
// accepts HTML, and this service has no app/ — it publishes two content trees
// and nothing else. Serving a copy of the site's 404 page from here would mean
// shipping app/ alongside it just to be wrong more slowly.
func notFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.Header().Set("Cache-Control", CacheControlFor(r.URL.Path, false))
	w.WriteHeader(http.StatusNotFound)
	fmt.Fprint(w, `{"error":"Not found"}`)
}

// resolveRequestPath turns a request URL into a path relative to the mount, or
// refuses.
//
// Traversal is the whole risk here. Three separate leaks got past hand-rolled
// matching in the Node server — `%2F`, then `//`, then `/.//` — because each fix
// only knew about the trick in front of it. So: the URL path arrives already
// percent-decoded, path.Clean resolves `.`, `..` and repeated separators
// together the way the file system does, and anything that still escapes the
// prefix is refused rather than reinterpreted.
//
// The mount ROOT (`/data` and `/data/`) is refused too. Express answers those
// with a redirect from `/data` to `/data/` and another from `/data/` back to
// `/data` — an infinite loop that nothing requests, since the contract is
// `/data/<file>`. A 404 is the honest answer and the one that cannot spin.
func resolveRequestPath(prefix, urlPath string) (string, bool) {
	if strings.ContainsRune(urlPath, 0) {
		return "", false
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(urlPath, "/"))
	if cleaned != prefix && !strings.HasPrefix(cleaned, prefix+"/") {
		return "", false
	}
	rel := strings.TrimPrefix(strings.TrimPrefix(cleaned, prefix), "/")
	if rel == "" {
		return "", false
	}
	// Dotfiles are not served: express.static's default is to ignore them, and
	// the archive has no public file that starts with a dot.
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || strings.HasPrefix(segment, ".") {
			return "", false
		}
	}
	return rel, true
}

// expressETag reproduces the `etag` package's stat tag, which is what
// express.static sends: a weak tag of size and mtime, both in hex.
//
// The format is not incidental. A client that already holds one of these sends
// it back in If-None-Match, and a tag in any other shape turns every
// revalidation into a full 200 — the caching would still be "correct" and the
// archive would move several hundred kilobytes it did not need to.
func expressETag(size, mtimeMillis int64) string {
	return `W/"` + strconv.FormatInt(size, 16) + "-" + strconv.FormatInt(mtimeMillis, 16) + `"`
}

// nodeMtimeMillis is the millisecond value Node's fs.Stats carries, which
// ROUNDS the nanoseconds rather than truncating them.
//
// Found by comparison, not by reading a spec: for catalog.json the kernel
// reports …648.084766578, Node's `stat.mtime.getTime()` is …648085 and Go's
// `UnixMilli()` is …648084. One millisecond, and it changes every ETag on the
// archive — every conditional request would miss, and every revalidation would
// send the whole file.
func nodeMtimeMillis(t time.Time) int64 {
	return t.Unix()*1000 + (int64(t.Nanosecond())+500_000)/1_000_000
}

// contentTypeFor mirrors what express.static sends for the extensions this
// archive actually contains — including the UPPERCASE charset, which is what
// Node's mime-types emits and a byte comparison notices.
//
// The table is explicit rather than inherited from the operating system's
// /etc/mime.types, which is not the same file on two machines.
func contentTypeFor(rel string) string {
	switch strings.ToLower(filepath.Ext(rel)) {
	case ".json":
		return "application/json; charset=UTF-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".svg":
		return "image/svg+xml"
	case ".ics":
		return "text/calendar; charset=UTF-8"
	case ".txt":
		return "text/plain; charset=UTF-8"
	case ".html":
		return "text/html; charset=UTF-8"
	case ".css":
		return "text/css; charset=UTF-8"
	case ".js", ".mjs":
		return "application/javascript; charset=UTF-8"
	case ".yaml", ".yml":
		return "text/yaml; charset=UTF-8"
	case ".webmanifest":
		return "application/manifest+json; charset=UTF-8"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".pdf":
		return "application/pdf"
	}
	return "application/octet-stream"
}

// ── The app's own files ─────────────────────────────────────────────────────

// serveAppStatic is `express.static(APP)`: the CSS, the ES modules, the service
// worker, the manifest — everything a page references.
//
// Registered LAST, after the page routes, for the same reason Express registers
// it last: `/editor` must be the editor page, not a 404 for a file of that name,
// and a deep route must win over a stray match. Reports whether it answered.
//
// Serving these from the Go backend rather than a separate static service is a
// deliberate choice, not a shortcut. The HTML pages cannot be served by a dumb
// file server — they need the provenance notice, the og/twitter tags and the
// `<base href="/">` injected per request — so splitting assets away from pages
// would put half of one document's delivery in each of two services.
func serveAppStatic(w http.ResponseWriter, r *http.Request, appRoot string) bool {
	if appRoot == "" || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		return false
	}
	rel, ok := resolveAppPath(r.URL.Path)
	if !ok {
		return false
	}
	full := filepath.Join(appRoot, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		return false
	}
	file, err := os.Open(full)
	if err != nil {
		return false
	}
	defer file.Close()

	header := w.Header()
	// A caller that has already chosen a content type keeps it — the
	// /api/v1/openapi.yaml route sends the same file under a different one.
	if header.Get("Content-Type") == "" {
		if contentType := contentTypeFor(rel); contentType != "" {
			header.Set("Content-Type", contentType)
		}
	}
	header.Set("ETag", expressETag(info.Size(), nodeMtimeMillis(info.ModTime())))
	header.Set("Accept-Ranges", "bytes")
	header.Set("Vary", "Accept-Encoding")

	writer := http.ResponseWriter(w)
	if gz := maybeGzip(w, r, rel, info.Size()); gz != nil {
		defer gz.Close()
		writer = gz
	}
	http.ServeContent(writer, r, filepath.Base(full), info.ModTime(), file)
	return true
}

// resolveAppPath cleans a request path into something under the app root, or
// refuses.
//
// Same rule as the content mounts: clean first so `..`, `//` and `/.//` are all
// resolved together, then refuse anything that names a dotfile.
//
// The escape is handled by the cleaning rather than by a check afterwards.
// path.Clean anchors at "/", so `/../server.js` resolves to `/server.js` and
// lands INSIDE the app root — it does not reach the repository above it. That is
// also what express.static does with the same request, and both then 404
// because no such file exists there. The property to preserve is "the result is
// always under the root", not "a path containing .. is rejected".
func resolveAppPath(urlPath string) (string, bool) {
	if strings.ContainsRune(urlPath, 0) {
		return "", false
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(urlPath, "/"))
	rel := strings.TrimPrefix(cleaned, "/")
	if rel == "" {
		return "", false
	}
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" || strings.HasPrefix(segment, ".") {
			return "", false
		}
	}
	return rel, true
}
