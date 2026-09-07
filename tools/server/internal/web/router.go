package web

// The middleware stack, and the router that composes every ported slice into
// one application.
//
// Until now each slice was proven on its own and run beside the Node original.
// This is where they become a server: the same middleware chain, in the same
// order, wrapping the same routes. Order is not a detail here — Express applies
// these in the order they are declared, and a Cache-Control set before the
// routes is one a handler can still override, while the same line after them
// would silently win over every deliberate choice a route made.
//
// The chain, top to bottom, matching server.js:
//
//	compression → Cache-Control → security headers → CORS → trailing slash → log
//
// Everything a browser trusts is decided in those five steps, so router_test.go
// compares them against the real Express server rather than against my reading
// of it.

import (
	"compress/gzip"
	"log"
	"net/http"
	"server/internal/auth"
	"server/internal/crud"
	"server/internal/httpx"
	"server/internal/js"
	"strconv"
	"strings"
)

// AppConfig is everything the assembled server needs to answer a request.
type AppConfig struct {
	Mounts        []Mount
	Authenticator *auth.Authenticator
	Login         *auth.LoginService
	Crud          *crud.CrudAPI
	Pages         *PageServer
	Archive       *ArchiveAPI
	Planner       *PlannerAPI
	Uploads       *UploadAPI
	Admin         *AdminAPI
	Feed          *FeedAPI
	Mode          auth.AuthMode
	// Logger receives one line per failed response, as the Node request logger
	// does. Nil silences it, which is what the tests want.
	Logger *log.Logger
}

// NewApp builds the whole handler: middleware chain, then routes.
func NewApp(config AppConfig) http.Handler {
	handler := newRoutes(config)
	// Applied so that the FIRST listed runs outermost, which is the order
	// server.js declares them in.
	handler = logMiddleware(config, handler)
	handler = trailingSlashMiddleware(handler)
	handler = corsMiddleware(handler)
	handler = securityHeadersMiddleware(handler)
	handler = cacheControlMiddleware(handler)
	handler = compressMiddleware(handler)
	return handler
}

// newRoutes is the routing table itself, with no middleware around it.
func newRoutes(config AppConfig) http.Handler {
	crud := http.NotFoundHandler()
	if config.Crud != nil {
		crud = config.Crud.Handler()
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		switch {
		// Liveness. Public, unauthenticated, and deliberately does NOT touch the
		// disk: a monitor that stats the archive every minute turns a slow volume
		// into a failed environment, and a broken one into a cached 200.
		case path == "/healthz" && isRead(r):
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("ok"))
			return

		// Always public: it is how the UI finds out whether to bother asking for
		// anything protected, and a 401 here would be a chicken and an egg.
		case path == "/api/auth/status" && isRead(r):
			serveAuthStatus(w, r, config)
			return

		case path == "/login" && isRead(r):
			config.Login.ServeLoginPage(w, r)
			return
		case path == "/login" && r.Method == http.MethodPost:
			config.Login.HandleLogin(w, r)
			return
		case path == "/logout" && isRead(r):
			config.Login.HandleLogout(w, r)
			return

		// Re-verifying the current password (the planner's lock screen) answers
		// with JSON rather than redirecting to the login page: the fetch client
		// would read a 302 to HTML as a wrong password.
		case path == "/api/auth/verify" && r.Method == http.MethodPost:
			if !requireRole(w, r, config, "viewer") {
				return
			}
			config.Login.HandleVerifyPassword(w, r)
			return

		case path == "/schedule.ics" && isRead(r):
			serveScheduleIcs(w, r, config.Mounts)
			return

		// The spec is served from the app root, before the CRUD engine sees the
		// path — it is documentation about the API, not a resource in it.
		case path == "/api/v1/openapi.yaml" && isRead(r):
			if config.Pages != nil {
				spec := r.Clone(r.Context())
				spec.URL.Path = "/openapi.yaml"
				// `res.type('text/yaml')` — lowercase charset, which is what the
				// dedicated route sends and is NOT what the static table emits
				// for the same file at /openapi.yaml.
				w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
				if serveAppStatic(w, spec, config.Pages.AppRoot) {
					return
				}
				w.Header().Del("Content-Type")
			}
			notFound(w, r)
			return

		case strings.HasPrefix(path, "/api/v1/"):
			crud.ServeHTTP(w, r)
			return
		}

		if serveArchiveAPI(w, r, config) {
			return
		}

		if servePlannerAPI(w, r, config) {
			return
		}

		if serveUploadAPI(w, r, config) {
			return
		}

		if serveAdminAPI(w, r, config) {
			return
		}

		if serveFeedAPI(w, r, config) {
			return
		}

		if isRead(r) && config.Pages != nil && servePageRoute(w, r, config) {
			return
		}

		for _, mount := range config.Mounts {
			if path == mount.Prefix || strings.HasPrefix(path, mount.Prefix+"/") {
				serveMount(w, r, mount)
				return
			}
		}
		// The app's own files come after the pages, so a route always wins over a
		// file that happens to share its name.
		if config.Pages != nil && serveAppStatic(w, r, config.Pages.AppRoot) {
			return
		}

		// An unrouted request gets the app's own 404 page when it wants HTML,
		// and JSON otherwise — an API client asked for JSON and must keep
		// getting it, or error handling in the app breaks.
		if config.Admin != nil && config.Admin.notFoundPage(w, r) {
			return
		}
		notFound(w, r)
	})
}

func isRead(r *http.Request) bool {
	return r.Method == http.MethodGet || r.Method == http.MethodHead
}

// serveAuthStatus reports whether THIS client is authorized, so the frontend can
// skip authorized-only requests when it is not — avoiding noisy 401s. In open
// mode CheckAuth resolves a synthetic admin.
func serveAuthStatus(w http.ResponseWriter, r *http.Request, config AppConfig) {
	role, authenticated := "anonymous", false
	if config.Authenticator != nil {
		if user := config.Authenticator.CheckAuth(r); user != nil {
			role, authenticated = user.Role, true
		}
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("mode", js.Str(string(config.Mode))).
		Set("authenticated", js.Bool(authenticated)).
		Set("role", js.Str(role)))
}

// requireRole is the API-style gate: a JSON 401/403 rather than a redirect.
func requireRole(w http.ResponseWriter, r *http.Request, config AppConfig, minimum string) bool {
	if config.Authenticator == nil {
		return true
	}
	user := config.Authenticator.CheckAuth(r)
	if user == nil {
		httpx.WriteError(w, httpx.Error(http.StatusUnauthorized, "Authentication required"))
		return false
	}
	if !auth.RoleAtLeast(user.Role, minimum) {
		httpx.WriteError(w, httpx.Error(http.StatusForbidden, "Forbidden"))
		return false
	}
	return true
}

// ── Middleware ──────────────────────────────────────────────────────────────

// cacheControlMiddleware sets the default for generated responses. It runs
// BEFORE the routes so a handler can still override it — the planner feed does,
// and must keep doing so.
//
// Default deny: the policy answers `private, no-store` for anything it does not
// recognise, so a route added later is uncacheable until somebody classifies it
// deliberately.
func cacheControlMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", CacheControlFor(r.URL.Path, r.URL.Query().Has("v")))
		next.ServeHTTP(w, r)
	})
}

// securityHeadersMiddleware reproduces the framing rules exactly, because both
// exceptions to `DENY` exist for a reason and neither is obvious.
func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		header.Set("Permissions-Policy", "geolocation=(), camera=(), microphone=()")

		path := r.URL.Path
		// The public schedule may be embedded on other sites (?embed=1). Everything
		// else — including the auth-gated planner and editor — stays frame-DENY, so
		// `?embed=1` on a protected page cannot be used to clickjack it.
		schedulePath := path == "/" || path == "/index.html" || path == "/schedule"
		// Uploaded receipts and documents are previewed in a same-origin lightbox
		// iframe in the planner, so they must allow same-origin framing.
		uploadFile := strings.HasPrefix(path, "/receipts/") ||
			strings.HasPrefix(path, "/documents/") ||
			strings.HasPrefix(path, "/api/receipts/") ||
			strings.HasPrefix(path, "/api/documents/")

		switch {
		case schedulePath && r.URL.Query().Get("embed") == "1":
			header.Set("Content-Security-Policy", "frame-ancestors *")
		case uploadFile:
			header.Set("X-Frame-Options", "SAMEORIGIN")
		default:
			header.Set("X-Frame-Options", "DENY")
		}
		next.ServeHTTP(w, r)
	})
}

// corsMiddleware allows cross-origin requests so the editor works when opened as
// a file:// URL.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("Access-Control-Allow-Origin", "*")
		header.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
		header.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			// `res.sendStatus(204)`: Express names the content type even though a
			// 204 carries no body.
			header.Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// trailingSlashMiddleware strips trailing slashes so relative asset paths
// resolve correctly from clean URLs.
func trailingSlashMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/" || !strings.HasSuffix(path, "/") {
			next.ServeHTTP(w, r)
			return
		}
		target := strings.TrimSuffix(path, "/")
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		expressRedirect(w, r, http.StatusMovedPermanently, target)
	})
}

// expressRedirect writes the redirect the way `res.redirect` does, body
// included. The body is not decoration: Express sends one, and a byte
// comparison against the Node server sees it.
func expressRedirect(w http.ResponseWriter, r *http.Request, status int, target string) {
	header := w.Header()
	header.Set("Location", target)
	header.Set("Vary", "Accept")

	// res.format: an HTML client gets a link, anything else gets a sentence.
	var body, contentType string
	if strings.Contains(r.Header.Get("Accept"), "html") {
		contentType = "text/html; charset=utf-8"
		escaped := htmlEscape(target)
		body = "<p>" + http.StatusText(status) + ". Redirecting to <a href=\"" +
			escaped + "\">" + escaped + "</a></p>"
	} else {
		contentType = "text/plain; charset=utf-8"
		body = http.StatusText(status) + ". Redirecting to " + target
	}
	header.Set("Content-Type", contentType)
	header.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write([]byte(body))
	}
}

func htmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// logMiddleware prints one line per failed response, as the Node logger does.
// Only failures: a log line per 200 on an archive that serves thousands of
// images per page view is noise that hides the one line that mattered.
func logMiddleware(config AppConfig, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		if recorder.status >= 400 && config.Logger != nil {
			config.Logger.Printf("[http] %d %s %s (auth-mode: %s)",
				recorder.status, r.Method, r.URL.Path, config.Mode)
		}
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(status int) {
	s.status = status
	s.ResponseWriter.WriteHeader(status)
}

// Unwrap lets http.ResponseController reach the real writer, and lets the
// handlers below find a compressor further up the chain.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// ── Compression ─────────────────────────────────────────────────────────────

// compressMiddleware is `compression({ threshold: 1024 })`.
//
// It buys a lot: schedule.css goes 77 KB → 14 KB and the largest dataset
// 256 KB → 70 KB. The compressed bytes will not match Node's exactly — that is a
// property of the encoder, not of the content — but the decompressed body will,
// and so will the decision about WHETHER to compress, which is the part a client
// can observe in a header.
//
// The decision has to be lazy. Whether a response is compressible depends on its
// Content-Type, and whether it is worth compressing depends on its length;
// neither is known until the handler has started writing.
func compressMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		writer := &compressingWriter{ResponseWriter: w, request: r}
		defer writer.Close()
		next.ServeHTTP(writer, r)
	})
}

// compressingWriter holds the first kilobyte back so it can decide.
type compressingWriter struct {
	http.ResponseWriter
	request *http.Request
	gzip    *gzip.Writer
	pending []byte
	status  int
	decided bool
	passing bool // decided NOT to compress
	wrote   bool
}

func (c *compressingWriter) WriteHeader(status int) {
	if c.wrote {
		return
	}
	c.status = status
	// A 204 or a 304 has no body to compress, and a range response must not be
	// compressed at all: a range of the compressed stream is not what the client
	// asked for.
	if status == http.StatusNoContent || status == http.StatusNotModified ||
		status == http.StatusPartialContent {
		c.decided, c.passing = true, true
		c.flushHeader()
	}
}

// flushHeader sends the status line once, after the compression decision has
// been recorded in the headers.
func (c *compressingWriter) flushHeader() {
	if c.wrote {
		return
	}
	c.wrote = true
	if c.status == 0 {
		c.status = http.StatusOK
	}
	c.ResponseWriter.WriteHeader(c.status)
}

func (c *compressingWriter) Write(b []byte) (int, error) {
	if c.decided {
		return c.writeDecided(b)
	}

	c.pending = append(c.pending, b...)
	header := c.ResponseWriter.Header()

	// A declared length settles it immediately, in either direction.
	if declared := header.Get("Content-Length"); declared != "" {
		if length, err := strconv.Atoi(declared); err == nil && length < compressionThreshold {
			return c.decide(false, b)
		}
	}
	if len(c.pending) < compressionThreshold {
		// Not enough yet to be worth it — hold, and let Close settle it if the
		// response ends here.
		return len(b), nil
	}
	return c.decide(compressibleType(header.Get("Content-Type")), b)
}

// decide records the choice, writes the held-back bytes, and stops buffering.
func (c *compressingWriter) decide(compress bool, b []byte) (int, error) {
	c.decided = true
	if !compress {
		c.passing = true
		c.flushHeader()
		if _, err := c.ResponseWriter.Write(c.pending); err != nil {
			return 0, err
		}
		c.pending = nil
		return len(b), nil
	}

	header := c.ResponseWriter.Header()
	header.Set("Content-Encoding", "gzip")
	// The length of the compressed body is not known yet, and a wrong one is
	// worse than none. Vary matters more than it looks: a cache that stores the
	// gzipped body without it will hand those bytes to a client that cannot read
	// them.
	header.Del("Content-Length")
	header.Set("Vary", joinVary(header.Get("Vary"), "Accept-Encoding"))
	c.flushHeader()

	c.gzip = gzip.NewWriter(c.ResponseWriter)
	if _, err := c.gzip.Write(c.pending); err != nil {
		return 0, err
	}
	c.pending = nil
	return len(b), nil
}

func (c *compressingWriter) writeDecided(b []byte) (int, error) {
	if c.passing {
		c.flushHeader()
		return c.ResponseWriter.Write(b)
	}
	if _, err := c.gzip.Write(b); err != nil {
		return 0, err
	}
	return len(b), nil
}

// Close settles a response that ended before the threshold — the common case for
// a small JSON answer, which is exactly the response compression should leave
// alone.
func (c *compressingWriter) Close() {
	if !c.decided {
		_, _ = c.decide(false, nil)
	}
	if c.gzip != nil {
		_ = c.gzip.Close()
	}
	c.flushHeader()
}

// Unwrap exposes the underlying writer, so serveMount can tell it is already
// being compressed and not do it twice.
func (c *compressingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

const compressionThreshold = 1024

func joinVary(existing, add string) string {
	if existing == "" {
		return add
	}
	for _, field := range strings.Split(existing, ",") {
		if strings.EqualFold(strings.TrimSpace(field), add) {
			return existing
		}
	}
	return existing + ", " + add
}

// compressibleType mirrors the `compressible` package for the types this app
// actually sends. PNG, JPEG, GIF and WebP are already compressed; running them
// through gzip costs CPU and gains nothing.
func compressibleType(contentType string) bool {
	base := strings.TrimSpace(strings.ToLower(contentType))
	if index := strings.IndexByte(base, ';'); index >= 0 {
		base = strings.TrimSpace(base[:index])
	}
	if strings.HasPrefix(base, "text/") {
		return true
	}
	switch base {
	case "application/json", "application/javascript", "application/xml",
		"application/manifest+json", "image/svg+xml", "application/ld+json",
		"application/x-javascript", "application/rss+xml", "application/atom+xml":
		return true
	}
	return false
}

// alreadyCompressing reports whether something up the chain is gzipping this
// response, so a handler that can compress on its own leaves it alone.
func alreadyCompressing(w http.ResponseWriter) bool {
	for {
		switch typed := w.(type) {
		case *compressingWriter, *gzipResponseWriter:
			return true
		case interface{ Unwrap() http.ResponseWriter }:
			w = typed.Unwrap()
		default:
			return false
		}
	}
}
