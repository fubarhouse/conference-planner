package web

// The planner API, the dataset read/write routes, and the small admin surface.
//
// `/api/planner/*` predates `/api/v1` and is what the browser client speaks. It
// is kept because it is the shipped contract, and it delegates to the same
// PlannerStore the v1 planners domain uses — so there is one implementation of
// "where does a planner live", not two that drift.

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"server/internal/httpx"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/planner"
	"server/internal/schema"
	"sort"
	"strings"
	"time"
)

// PlannerAPI serves the planner routes and the dataset routes beside them.
type PlannerAPI struct {
	DataDir  string
	Planners func(r *http.Request) *planner.PlannerStore
	Schemas  *schema.SchemaSet
	// Catalog regenerates the read index after a dataset write. Injected so the
	// route layer does not have to know how the catalog is built.
	Catalog func(reason string)
}

// servePlannerAPI answers if the path is one of ours.
func servePlannerAPI(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	api := config.Planner
	if api == nil {
		return false
	}
	path := r.URL.Path

	switch {
	case path == "/api/meta" && isRead(r):
		api.handleMeta(w)
		return true

	case strings.HasPrefix(path, "/api/data/"):
		rest := strings.TrimPrefix(path, "/api/data/")
		switch {
		case isRead(r):
			api.handleDataRead(w, rest)
		case r.Method == http.MethodPut:
			if requireRole(w, r, config, "editor") {
				api.handleDataWrite(w, r, rest)
			}
		default:
			methodNotAllowed(w, "GET, PUT")
		}
		return true

	case path == "/api/planner" && isRead(r):
		if requireRole(w, r, config, "viewer") {
			api.handlePlannerList(w, r)
		}
		return true

	case strings.HasPrefix(path, "/api/planner/"):
		return api.servePlannerPath(w, r, config, strings.TrimPrefix(path, "/api/planner/"))
	}
	return false
}

// servePlannerPath routes everything under /api/planner/.
//
// The feed routes are checked FIRST, and that ordering is load-bearing:
// `feeds` would otherwise be read as a document path.
func (a *PlannerAPI) servePlannerPath(w http.ResponseWriter, r *http.Request,
	config AppConfig, rest string) bool {
	segments := strings.Split(rest, "/")

	// /api/planner/<slug>/feeds and /api/planner/<slug>/feeds/<id>
	if len(segments) >= 2 && segments[1] == "feeds" {
		slug := segments[0]
		switch {
		case len(segments) == 2 && isRead(r):
			if requireRole(w, r, config, "viewer") {
				a.handleFeedList(w, r, slug)
			}
		case len(segments) == 2 && r.Method == http.MethodPost:
			if requireRole(w, r, config, "editor") {
				a.handleFeedCreate(w, r, slug)
			}
		case len(segments) == 3 && r.Method == http.MethodDelete:
			if requireRole(w, r, config, "editor") {
				a.handleFeedRevoke(w, r, slug, segments[2])
			}
		default:
			methodNotAllowed(w, "GET, POST, DELETE")
		}
		return true
	}

	// The calendar feed itself is public — a calendar client cannot log in, so
	// the token IS the credential. Owned by the feed route, not by this one.
	if len(segments) == 2 && segments[1] == "calendar.ics" {
		return false
	}

	switch {
	case isRead(r):
		if requireRole(w, r, config, "viewer") {
			a.handlePlannerRead(w, r, rest)
		}
	case r.Method == http.MethodPut, r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			a.handlePlannerWrite(w, r, rest)
		}
	case r.Method == http.MethodDelete:
		if requireRole(w, r, config, "editor") {
			a.handlePlannerRemove(w, r, rest)
		}
	default:
		methodNotAllowed(w, "GET, PUT, POST, DELETE")
	}
	return true
}

// ── Datasets ────────────────────────────────────────────────────────────────

// handleMeta lists every event's headline fields, for the editor's picker.
func (a *PlannerAPI) handleMeta(w http.ResponseWriter) {
	files, err := collectEventFiles(filepath.Join(a.DataDir, "events"), a.DataDir)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	out := js.Arr()
	for _, file := range files {
		full := paths.SafeJoin(a.DataDir, file)
		if full == "" {
			continue
		}
		raw, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		parsed, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		event := parsed.Get("event")
		// A dataset whose `event` is missing, an array, or not an object at all
		// is skipped rather than reported as a row of empty strings.
		if event == nil || !event.IsObject() {
			continue
		}
		out.Append(js.Obj().
			Set("file", js.Str(file)).
			Set("designation", js.Str(js.Trim(event.Get("designation").StrVal()))).
			Set("location", js.Str(js.Trim(event.Get("location").StrVal()))).
			Set("year", js.Str(js.Trim(event.Get("year").StrVal()))).
			Set("region", js.Str(js.Trim(event.Get("region").StrVal()))).
			Set("venue", js.Str(js.Trim(event.Get("venue").StrVal()))).
			// Absent means enabled: only an explicit `false` turns an event off.
			Set("enabled", js.Bool(!isExplicitlyFalse(event.Get("enabled")))))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func isExplicitlyFalse(v *js.Value) bool {
	value, ok := v.Bool()
	return ok && !value
}

func (a *PlannerAPI) handleDataRead(w http.ResponseWriter, docPath string) {
	full := paths.SafeJoin(a.DataDir, docPath)
	if full == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid path"))
		return
	}
	raw, err := os.ReadFile(full)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusNotFound, "Not found"))
		return
	}
	// Sent verbatim: the file's own formatting is part of the dataset, and
	// re-encoding it here would hand the editor a document that differs from
	// what is on disk before anybody has edited anything.
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(raw)
}

// handleDataWrite receives raw JSON text, to preserve formatting.
//
// Schema-validated, not just parsed. This route once checked only that the body
// was parseable, so the editor could save a dataset the schema rejects — a
// `"startDate": "2025-13-28T25:00:00Z"` was written happily and then failed
// validation in CI, after it had been committed. The browser validator is more
// permissive than this one, so the client cannot be the only gate.
func (a *PlannerAPI) handleDataWrite(w http.ResponseWriter, r *http.Request, docPath string) {
	if !strings.HasSuffix(docPath, ".json") {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "JSON files only"))
		return
	}
	full := paths.SafeJoin(a.DataDir, docPath)
	if full == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid path"))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}
	parsed, err := js.ParseJSON(body)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}

	result := a.Schemas.ValidateDataFile(docPath, parsed)
	if !result.Valid {
		// 422 matches /api/v1. `error` carries a readable summary because the
		// editor shows it verbatim — a bare code would tell the person nothing
		// to fix.
		httpx.WriteError(w, &httpx.APIError{
			Status:  http.StatusUnprocessableEntity,
			Message: schema.SummarizeErrors(result.Errors),
			Extra: map[string]any{
				"code":   "validation_failed",
				"errors": result.Errors,
			},
		})
		return
	}

	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
	// After the response: the editor waits for its save, not for the read index.
	if a.Catalog != nil {
		a.Catalog("data write: " + docPath)
	}
}

// ── Planners ────────────────────────────────────────────────────────────────

func (a *PlannerAPI) handlePlannerList(w http.ResponseWriter, r *http.Request) {
	names, err := a.Planners(r).List()
	if err != nil {
		writePlannerError(w, err)
		return
	}
	out := js.Arr()
	for _, name := range names {
		out.Append(js.Str(name))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (a *PlannerAPI) handlePlannerRead(w http.ResponseWriter, r *http.Request, docPath string) {
	body, err := a.Planners(r).Read(docPath)
	if err != nil {
		writePlannerError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(body)
}

// handlePlannerWrite parses and schema-validates, then hands the RAW body to the
// store — so a planner round-trips through this server byte-identically.
func (a *PlannerAPI) handlePlannerWrite(w http.ResponseWriter, r *http.Request, docPath string) {
	if !strings.HasSuffix(docPath, ".json") {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "JSON files only"))
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}
	parsed, err := js.ParseJSON(body)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}
	if validator := a.Schemas.Planner(); validator != nil {
		if result := validator.Validate(parsed); !result.Valid {
			httpx.WriteError(w, &httpx.APIError{
				Status:  http.StatusUnprocessableEntity,
				Message: "validation_failed",
				Extra: map[string]any{
					"message": "Planner failed schema validation",
					"errors":  result.Errors,
				},
			})
			return
		}
	}
	if err := a.Planners(r).Write(docPath, body); err != nil {
		writePlannerError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
}

func (a *PlannerAPI) handlePlannerRemove(w http.ResponseWriter, r *http.Request, docPath string) {
	if err := a.Planners(r).Remove(docPath); err != nil {
		writePlannerError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
}

// writePlannerError renders the store's status-carrying failures.
func writePlannerError(w http.ResponseWriter, err error) {
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) {
		httpx.WriteError(w, apiErr)
		return
	}
	httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
}

// ── Calendar feed tokens ────────────────────────────────────────────────────

// readPlannerForFeeds loads the document a feed belongs to.
//
// One response for "no such planner" and every other failure: a caller probing
// slugs must not learn which trips exist.
func (a *PlannerAPI) readPlannerForFeeds(r *http.Request, slug string) (string, *js.Value, error) {
	relPath := slug + ".json"
	body, err := a.Planners(r).Read(relPath)
	if err != nil {
		return "", nil, httpx.Error(http.StatusNotFound, "Planner not found")
	}
	document, err := js.ParseJSON(body)
	if err != nil {
		return "", nil, httpx.Error(http.StatusNotFound, "Planner not found")
	}
	return relPath, document, nil
}

func (a *PlannerAPI) handleFeedList(w http.ResponseWriter, r *http.Request, slug string) {
	_, document, err := a.readPlannerForFeeds(r, slug)
	if err != nil {
		writePlannerError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("feeds", planner.ListFeeds(document)))
}

// handleFeedCreate issues a subscription token.
//
// The response is the ONE and only time the plaintext leaves this process —
// only its hash is stored, so a lost link is reissued rather than recovered.
func (a *PlannerAPI) handleFeedCreate(w http.ResponseWriter, r *http.Request, slug string) {
	relPath, document, err := a.readPlannerForFeeds(r, slug)
	if err != nil {
		writePlannerError(w, err)
		return
	}
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	token, entry, err := planner.AddFeed(document, body.Get("label").StrVal(), "", time.Now())
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	if err := a.Planners(r).Write(relPath, encodePlanner(document)); err != nil {
		writePlannerError(w, err)
		return
	}
	out := js.Obj()
	for _, key := range entry.Keys() {
		out.Set(key, entry.Get(key))
	}
	out.Set("token", js.Str(token)).
		Set("url", js.Str("/planner/"+url.PathEscape(slug)+"/calendar.ics?k="+token)).
		Set("note", js.Str("Copy this link now — it cannot be shown again."))
	httpx.WriteJSON(w, http.StatusOK, out)
}

// handleFeedRevoke retires a token.
//
// Revocation is a single act that reaches S3 — the old scheme deleted the token
// locally and asked the reader to remember to push, which is the wrong latency
// for retiring a leaked credential.
func (a *PlannerAPI) handleFeedRevoke(w http.ResponseWriter, r *http.Request, slug, id string) {
	relPath, document, err := a.readPlannerForFeeds(r, slug)
	if err != nil {
		writePlannerError(w, err)
		return
	}
	if !planner.RevokeFeed(document, id) {
		httpx.WriteError(w, httpx.Error(http.StatusNotFound, "No such feed"))
		return
	}
	if err := a.Planners(r).Write(relPath, encodePlanner(document)); err != nil {
		writePlannerError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
}

// encodePlanner writes a planner back at indent 2, which is what the JavaScript
// writes and what the client expects to read.
func encodePlanner(planner *js.Value) []byte {
	return planner.Encode("  ")
}

// collectEventFiles lists every dataset under events/, relative to the data
// root, sorted — the order the editor's picker shows them in.
func collectEventFiles(eventsDir, dataDir string) ([]string, error) {
	paths, err := paths.DatasetFiles(eventsDir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, path := range paths {
		relative, err := filepath.Rel(dataDir, path)
		if err != nil {
			continue
		}
		out = append(out, filepath.ToSlash(relative))
	}
	sort.Slice(out, func(a, b int) bool { return js.LocaleCompare(out[a], out[b]) })
	return out, nil
}
