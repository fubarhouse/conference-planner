package web

// The calendar-feed routes: check what upstream publishes, and import it.
//
// These are the editor's Sources tab talking to the same code the weekly
// reconciliation runs. That is the whole point of the arrangement — the button
// and the cron job answer the same question the same way, so an import cannot
// behave one way at 3am and another way when a person presses it.
//
// The server is deliberately thin here. It resolves and reads the dataset,
// calls `feedsync`, validates whatever comes back against the schema, and
// writes. It never inspects the diff: only the browser renders that, and passing
// the report through unread means it can gain fields without this file changing.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"server/internal/httpx"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/schema"

	"drupalcon-sync/feedsync"
)

// FeedAPI reconciles a dataset against the calendar feed it names.
type FeedAPI struct {
	DataDir string
	Schemas *schema.SchemaSet
	// Catalog regenerates the read index after a write, as a dataset save does.
	Catalog func(reason string)
	// Now is injected by the tests.
	Now func() time.Time
	// Run is the reconciliation itself. Injected so the handler can be tested
	// without a network, and so there is exactly one place that knows how to
	// reach upstream.
	Run func(feedsync.Request) (*feedsync.Outcome, error)
}

type feedRequest struct {
	// File is the dataset, relative to the data root: "events/…/2026-x.json".
	File string `json:"file"`
	// Mirror adopts the upstream programme wholesale rather than only writing
	// the fields the export owns. Required to add or remove sessions, and so
	// required to import a conference that has none yet.
	Mirror bool `json:"mirror"`
}

// serveFeedAPI answers if the path is one of ours.
func serveFeedAPI(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	api := config.Feed
	if api == nil {
		return false
	}

	switch r.URL.Path {
	case "/api/feed/check":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return true
		}
		// A check writes nothing, but it does make this server fetch a URL on
		// the caller's behalf and report what came back. That is an editor's
		// business, not an anonymous visitor's.
		if requireRole(w, r, config, "editor") {
			api.handle(w, r, false)
		}
		return true

	case "/api/feed/import":
		if r.Method != http.MethodPost {
			methodNotAllowed(w, "POST")
			return true
		}
		if requireRole(w, r, config, "editor") {
			api.handle(w, r, true)
		}
		return true
	}
	return false
}

func (a *FeedAPI) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now().UTC()
}

func (a *FeedAPI) run(req feedsync.Request) (*feedsync.Outcome, error) {
	if a.Run != nil {
		return a.Run(req)
	}
	return feedsync.Run(req)
}

func (a *FeedAPI) handle(w http.ResponseWriter, r *http.Request, apply bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}
	var input feedRequest
	if err := json.Unmarshal(body, &input); err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "invalid request body"))
		return
	}

	docPath := strings.TrimPrefix(strings.TrimSpace(input.File), "/")
	if docPath == "" || !strings.HasSuffix(docPath, ".json") {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "file must be a dataset .json path"))
		return
	}
	// The same whitelist every other data route uses. Without it `file` is a
	// path traversal and a way to make this server fetch arbitrary URLs on
	// behalf of whatever a dataset happened to contain.
	full := paths.SafeJoin(a.DataDir, docPath)
	if full == "" || !strings.HasPrefix(filepath.ToSlash(docPath), "events/") {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "invalid dataset path"))
		return
	}

	raw, err := os.ReadFile(full)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusNotFound, "dataset not found"))
		return
	}

	outcome, err := a.run(feedsync.Request{
		Raw:    raw,
		Path:   full,
		Rel:    docPath,
		Apply:  apply,
		Mirror: input.Mirror,
		Now:    a.now(),
	})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, err.Error()))
		return
	}

	written := false
	if apply && outcome.Wrote() {
		if err := a.write(w, docPath, full, outcome.Dataset); err != nil {
			return // write() has already answered
		}
		written = true
	}

	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("ok", js.Bool(true)).
		Set("written", js.Bool(written)).
		Set("status", js.Str(outcome.Status)).
		Set("note", js.Str(outcome.Note)).
		Set("feedUrl", js.Str(outcome.FeedURL)).
		Set("fetch", js.Str(outcome.Fetch)).
		Set("upstream", js.Int(outcome.Upstream)).
		Set("local", js.Int(outcome.Local)).
		Set("matched", js.Int(outcome.Matched)).
		Set("changed", js.Int(outcome.Changed)).
		Set("added", js.Int(outcome.Added)).
		Set("removed", js.Int(outcome.Removed)).
		Set("drifted", js.Bool(outcome.Drifted)).
		Set("report", reportValue(outcome.Report)))
}

// write validates and saves, answering the request itself on failure.
//
// The validation is not belt-and-braces. An import is the one write to this
// archive that no person reviewed field by field, so it is the write that most
// needs the schema between it and the disk — and refusing here leaves the
// dataset exactly as it was.
func (a *FeedAPI) write(w http.ResponseWriter, docPath, full string, body []byte) error {
	parsed, err := js.ParseJSON(body)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError,
			"the import produced unreadable JSON; nothing was written"))
		return err
	}
	if a.Schemas != nil {
		result := a.Schemas.ValidateDataFile(docPath, parsed)
		if !result.Valid {
			httpx.WriteError(w, &httpx.APIError{
				Status:  http.StatusUnprocessableEntity,
				Message: "the import would not be a valid dataset; nothing was written: " + schema.SummarizeErrors(result.Errors),
				Extra: map[string]any{
					"code":   "validation_failed",
					"errors": result.Errors,
				},
			})
			return errInvalidImport
		}
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return err
	}
	if a.Catalog != nil {
		a.Catalog("feed import: " + docPath)
	}
	return nil
}

var errInvalidImport = httpx.Error(http.StatusUnprocessableEntity, "invalid import")

// reportValue re-parses the reconciliation report so it can be nested in the
// response. It is emitted as `null` rather than dropped when there is nothing to
// report, because the client switches on its presence.
func reportValue(raw []byte) *js.Value {
	if len(raw) == 0 {
		return js.Null()
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return js.Null()
	}
	return parsed
}
