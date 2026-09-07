package web

// The S3 admin routes, and the error pages.
//
// These are the buttons in the editor's settings panel: what is configured, can
// we reach it, what differs, and push/pull. Everything they call was ported in
// the bucket-sync slice; this is the address and the gate.

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/httpx"
	"server/internal/js"
	"server/internal/storage"
	"sort"
	"strings"

	"github.com/aws/smithy-go"
)

// AdminAPI serves the sync surface.
type AdminAPI struct {
	Settings storage.S3Settings
	Roots    storage.SyncRoots
	Manifest string
	AppRoot  string
	// Connect opens a store. Injected so a test can supply a stub bucket, and so
	// a misconfigured deployment fails at the request rather than at boot.
	Connect func(ctx context.Context) (storage.ObjectStore, error)
	// UserID scopes a sync in multi-user mode.
	UserID func(r *http.Request) string
}

// serveAdminAPI answers if the path is one of ours.
func serveAdminAPI(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	api := config.Admin
	if api == nil {
		return false
	}

	switch r.URL.Path {
	case "/api/s3/config":
		if !isRead(r) {
			methodNotAllowed(w, "GET")
			return true
		}
		if requireRole(w, r, config, "viewer") {
			api.handleConfig(w)
		}
		return true

	case "/api/s3/test":
		if !isRead(r) {
			methodNotAllowed(w, "GET")
			return true
		}
		// A live AWS call, so anonymous access is both a disclosure and a way to
		// spend somebody else's money.
		if requireRole(w, r, config, "editor") {
			api.handleTest(w, r)
		}
		return true

	case "/api/s3/status":
		if !isRead(r) {
			methodNotAllowed(w, "GET")
			return true
		}
		if requireRole(w, r, config, "viewer") {
			api.handleSync(w, r, "status")
		}
		return true

	case "/api/s3/push":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return true
		}
		if requireRole(w, r, config, "editor") {
			api.handleSync(w, r, "push")
		}
		return true

	case "/api/s3/pull":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return true
		}
		if requireRole(w, r, config, "editor") {
			api.handleSync(w, r, "pull")
		}
		return true
	}
	return false
}

func (a *AdminAPI) handleConfig(w http.ResponseWriter) {
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("bucket", js.Str(a.Settings.Bucket)).
		Set("region", js.Str(a.Settings.Region)).
		Set("prefix", js.Str(a.Settings.Prefix)).
		Set("configured", js.Bool(a.Settings.Bucket != "")))
}

// handleTest is a connectivity probe.
//
// A failure — no bucket, missing credentials, unreachable — is a valid ANSWER,
// not a server error, so this always responds 200 with the result. That is what
// keeps S3 sync an optional feature that never breaks the app when it is not
// configured; callers gate their UI on the `ok` field.
func (a *AdminAPI) handleTest(w http.ResponseWriter, r *http.Request) {
	store, err := a.connect(r.Context())
	if err != nil {
		httpx.WriteJSON(w, http.StatusOK, js.Obj().
			Set("ok", js.Bool(false)).
			Set("code", js.Str(errorCode(err))).
			Set("error", js.Str(err.Error())))
		return
	}
	// One listing is the whole probe: it needs credentials, the bucket to exist,
	// and the region to be right, which is every way this is usually wrong.
	if _, err := store.List(r.Context(), strings.TrimSuffix(a.Settings.Prefix, "/")); err != nil {
		httpx.WriteJSON(w, http.StatusOK, js.Obj().
			Set("ok", js.Bool(false)).
			Set("code", js.Str(errorCode(err))).
			Set("error", js.Str(err.Error())))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("ok", js.Bool(true)).
		Set("bucket", js.Str(a.Settings.Bucket)).
		Set("region", js.Str(a.Settings.Region)).
		Set("prefix", js.Str(a.Settings.Prefix)))
}

// handleSync runs a status, a push or a pull.
func (a *AdminAPI) handleSync(w http.ResponseWriter, r *http.Request, action string) {
	scope, force := "all", false
	if action == "status" {
		scope = syncScope(r.URL.Query().Get("scope"))
	} else {
		body, problem := httpx.ReadBody(r)
		if problem != nil {
			httpx.WriteError(w, problem)
			return
		}
		scope = syncScope(body.Get("scope").StrVal())
		force = body.Get("force").IsTrue()
	}

	store, err := a.connect(r.Context())
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}
	config := storage.SyncConfig{
		Prefix:       a.Settings.Prefix,
		Roots:        a.Roots,
		ManifestPath: a.Manifest,
		UserID:       a.userID(r),
		Scope:        scope,
		Force:        force,
	}

	// A status is a dry run: it reports the state of every file without moving
	// any of them, and its answer is a per-file map rather than an outcome.
	if action == "status" {
		states, err := storage.Status(r.Context(), store, config)
		if err != nil {
			httpx.WriteError(w, httpx.Error(http.StatusBadGateway, err.Error()))
			return
		}
		httpx.WriteJSON(w, http.StatusOK, sortedStringMap(states))
		return
	}

	var outcome storage.SyncOutcome
	if action == "push" {
		outcome, err = storage.Push(r.Context(), store, config)
	} else {
		outcome, err = storage.Pull(r.Context(), store, config)
	}
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadGateway, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, syncOutcomeValue(outcome))
}

func (a *AdminAPI) connect(ctx context.Context) (storage.ObjectStore, error) {
	if a.Connect != nil {
		return a.Connect(ctx)
	}
	return storage.NewS3Store(ctx, a.Settings)
}

func (a *AdminAPI) userID(r *http.Request) string {
	if a.UserID == nil {
		return ""
	}
	return a.UserID(r)
}

// syncScope limits a sync to one side: `data` is the editor's, `planner` is the
// trip's. Anything else is everything.
func syncScope(value string) string {
	if value == "data" || value == "planner" {
		return value
	}
	return "all"
}

// syncOutcomeValue renders an outcome as the JSON the settings panel reads.
func syncOutcomeValue(outcome storage.SyncOutcome) *js.Value {
	list := func(items []string) *js.Value {
		out := js.Arr()
		for _, item := range items {
			out.Append(js.Str(item))
		}
		return out
	}
	conflicts := js.Arr()
	for _, conflict := range outcome.Conflicts {
		entry := js.Obj().Set("path", js.Str(conflict.Path)).Set("reason", js.Str(conflict.Reason))
		// Set in a FIXED order. Ranging a map here would emit these three keys in
		// a different order on every call, and this response is compared byte for
		// byte against the JavaScript's.
		for _, field := range [][2]string{
			{"localHash", conflict.LocalHash},
			{"s3Etag", conflict.S3ETag},
			{"manifestEtag", conflict.ManifestETag},
		} {
			if field[1] != "" {
				entry.Set(field[0], js.Str(field[1]))
			}
		}
		conflicts.Append(entry)
	}
	failures := js.Arr()
	for _, item := range outcome.Errors {
		failures.Append(js.Obj().Set("path", js.Str(item.Path)).Set("error", js.Str(item.Error)))
	}
	return js.Obj().
		Set("ok", js.Bool(len(outcome.Errors) == 0)).
		Set("moved", list(outcome.Moved)).
		Set("skipped", list(outcome.Skipped)).
		Set("conflicts", conflicts).
		Set("errors", failures)
}

// sortedStringMap renders a map with its keys in a stable order.
//
// JavaScript would emit these in insertion order, which is the archive's walk
// order and is not reproducible here. Sorted is both stable and easier to read
// in a settings panel that lists a few hundred files.
func sortedStringMap(values map[string]string) *js.Value {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := js.Obj()
	for _, key := range keys {
		out.Set(key, js.Str(values[key]))
	}
	return out
}

// errorCode names a failure the way the JavaScript does: the SDK's code when
// there is one, and a generic marker when there is not.
func errorCode(err error) string {
	if errors.Is(err, storage.ErrNoBucket) {
		return "NOT_CONFIGURED"
	}
	var coded smithy.APIError
	if errors.As(err, &coded) {
		return coded.ErrorCode()
	}
	return "ERROR"
}

// ── Error pages ─────────────────────────────────────────────────────────────

// notFoundPage answers an unrouted request.
//
// Content negotiation matters more than the page does: an API client asked for
// JSON and must keep getting JSON, or error handling in the app breaks. Only a
// request that actually wants HTML gets HTML.
func (a *AdminAPI) notFoundPage(w http.ResponseWriter, r *http.Request) bool {
	if !wantsHTML(r) || a.AppRoot == "" {
		return false
	}
	body, err := os.ReadFile(filepath.Join(a.AppRoot, "404.html"))
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "text/html; charset=UTF-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write(body)
	return true
}

// wantsHTML reports whether this request would rather have a page than JSON.
//
// Anything under /api/ is a client, whatever its Accept header says — a fetch()
// with a default Accept would otherwise be handed a 404 page and fail on
// "Unexpected token '<'".
func wantsHTML(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	accept := r.Header.Get("Accept")
	if accept == "" {
		return false
	}
	// Express's `req.accepts(['html','json'])` picks by q-value and by the order
	// the client listed them. The common cases are all that matter here: a
	// browser sends text/html first, a fetch sends */* or application/json.
	for _, entry := range strings.Split(accept, ",") {
		media := strings.TrimSpace(strings.SplitN(entry, ";", 2)[0])
		switch media {
		case "text/html", "application/xhtml+xml":
			return true
		case "application/json":
			return false
		}
	}
	return false
}
