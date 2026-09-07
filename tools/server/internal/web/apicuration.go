package web

// The curation desk's WRITE endpoints, and the album-cover resolver.
//
// Every one of these records a judgement in the ledger and hands back a fresh
// curation token. The token is not bookkeeping: the caller re-reads the archive
// at a NEW URL rather than asking a CDN to forget the old one, which is the only
// invalidation that works through a cache nobody controls.
//
// Nothing here rewrites a dataset. An alias, a series lineage, a snooze and a
// distinct ruling are all read-time lenses over programmes that stay byte-identical
// — that is the whole point of the archive, and the reason the ledger is private
// and the datasets are not.

import (
	"net/http"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/archive/curation"
	"server/internal/auth"
	"server/internal/httpx"
	"server/internal/js"
	"sync"
)

// decided renders the standard answer: it worked, and here is the version you
// should now be reading at.
func decided(w http.ResponseWriter, ledger *curation.Ledger, extra func(*js.Value)) {
	body := js.Obj().
		Set("ok", js.Bool(true)).
		Set("version", js.Str(curation.CurationToken(ledger.Serialize())))
	if extra != nil {
		extra(body)
	}
	httpx.WriteJSON(w, http.StatusOK, body)
}

// handleMerge maps a cluster's spellings to a canonical name.
//
// RECORDED ONLY — a private alias that the archive applies at READ TIME. The
// original programmes are preserved verbatim.
func (a *ArchiveAPI) handleMerge(w http.ResponseWriter, r *http.Request) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	// Accept a pre-computed `key` (the Curation Studio has one) OR a raw `name`
	// to fingerprint here (the archive's "map to another identity"). Both resolve
	// to the same read-time alias.
	key := body.Get("key").StrVal()
	if key == "" {
		if name := body.Get("name").StrVal(); name != "" {
			key = archive.Fingerprint(name)
		}
	}
	canonical := body.Get("canonical").StrVal()
	if key == "" || canonical == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "key/name + canonical required"))
		return
	}
	next, err := a.Decisions.Save(r.Context(),
		curation.Decision{Type: "alias", Key: key, Canonical: canonical})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	decided(w, next, nil)
}

// handleDistinct rules that a cluster is genuinely two different people.
func (a *ArchiveAPI) handleDistinct(w http.ResponseWriter, r *http.Request) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	key := body.Get("key").StrVal()
	if key == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "key required"))
		return
	}
	next, err := a.Decisions.Save(r.Context(), curation.Decision{Type: "distinct", Key: key})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	decided(w, next, nil)
}

// handleUndo takes a decision back: un-mark a `distinct` and its cluster
// resurfaces; drop an `alias` and the spellings separate again.
//
// Nothing else needs reverting — the decision only ever existed in the ledger.
func (a *ArchiveAPI) handleUndo(w http.ResponseWriter, r *http.Request) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	kind, key := body.Get("type").StrVal(), body.Get("key").StrVal()
	if kind == "" || key == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "type and key required"))
		return
	}
	next, err := a.Decisions.Remove(r.Context(), curation.Decision{Type: kind, Key: key})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	decided(w, next, nil)
}

// handleCoverageDecision ignores a gap for ever, snoozes it until a date, or
// (with no state) reopens it.
func (a *ArchiveAPI) handleCoverageDecision(w http.ResponseWriter, r *http.Request) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	file, check := body.Get("file").StrVal(), body.Get("check").StrVal()
	if file == "" || check == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "file and check required"))
		return
	}
	state := body.Get("state").StrVal()
	if state != "" && state != "ignored" && state != "later" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest,
			`state must be "ignored", "later" or omitted`))
		return
	}
	next, err := a.Decisions.Save(r.Context(), curation.Decision{
		Type:  "coverage",
		Key:   archive.SnoozeKey(file, check),
		State: state,
		Until: body.Get("until").StrVal(),
		Note:  body.Get("note").StrVal(),
	})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	decided(w, next, nil)
}

// handleSeriesDecision records what an event BELONGED to, which is not always
// what it was called.
//
// Editor-only, unlike the identity suggestions anyone may propose: this changes
// how the archive groups itself, which is an editorial judgement rather than a
// reader's correction.
func (a *ArchiveAPI) handleSeriesDecision(w http.ResponseWriter, r *http.Request) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	key := js.Trim(body.Get("file").StrVal())
	if key == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "file required"))
		return
	}
	// Only a real event may be mapped, so a typo cannot quietly create a lineage
	// entry for a dataset that does not exist.
	known, err := a.catalogHasFile(key)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, "Could not read the catalog."))
		return
	}
	if !known {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "No such event in the catalog."))
		return
	}
	// An empty `series` clears the mapping — the event goes back to its own
	// designation, which is the normal state for most of the archive.
	next, err := a.Decisions.Save(r.Context(), curation.Decision{
		Type: "series", Key: key, Canonical: js.Trim(body.Get("series").StrVal()),
	})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	decided(w, next, func(body *js.Value) { body.Set("series", next.Series) })
}

func (a *ArchiveAPI) catalogHasFile(file string) (bool, error) {
	catalog, err := readJSONFile(a.DataDir, "catalog.json")
	if err != nil {
		return false, err
	}
	for _, entry := range catalog.Get("events").Items() {
		if entry.Get("file").StrVal() == file {
			return true, nil
		}
	}
	return false, nil
}

// ── The suggestion queue ────────────────────────────────────────────────────

// handleSuggest takes a reader's lead, or a proposed identity mapping.
//
// Two things arrive here, and they share the queue, the rate limit and the
// private store because both are claims awaiting review. They differ only in
// what a reviewer is being asked.
func (a *ArchiveAPI) handleSuggest(w http.ResponseWriter, r *http.Request, config AppConfig) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	by := usernameOf(r, config)
	store := a.suggestions()

	if body.Get("kind").StrVal() == "identity" {
		item, duplicate, refusal, err := store.AddIdentity(curation.IdentityInput{
			Type:  body.Get("idType").StrVal(),
			From:  body.Get("from").StrVal(),
			To:    body.Get("to").StrVal(),
			Notes: body.Get("notes").StrVal(),
		}, by)
		a.finishSuggestion(w, item, duplicate, refusal, err)
		return
	}

	item, refusal, err := store.Add(curation.SuggestionInput{
		Name:  body.Get("name").StrVal(),
		URL:   body.Get("url").StrVal(),
		Notes: body.Get("notes").StrVal(),
	}, by)
	a.finishSuggestion(w, item, false, refusal, err)
}

func (a *ArchiveAPI) finishSuggestion(w http.ResponseWriter, item *js.Value,
	duplicate bool, refusal string, err error) {
	if refusal != "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, refusal))
		return
	}
	if err != nil {
		// The reader gets one sentence, not a file path: this box is the public
		// face of the archive and its errors should not describe its disk.
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError,
			"Could not save that. Try again shortly."))
		return
	}
	body := js.Obj().Set("ok", js.Bool(true)).Set("id", js.Str(item.Get("id").Str()))
	if duplicate {
		body.Set("duplicate", js.Bool(true))
	}
	httpx.WriteJSON(w, http.StatusCreated, body)
}

func (a *ArchiveAPI) handleSuggestionList(w http.ResponseWriter, _ *http.Request) {
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("items", a.suggestions().List()))
}

// handleSuggestionDecide actions or dismisses one queued claim.
//
// Approving an IDENTITY suggestion is the moment the alias is actually written —
// that is the whole point of the queue. The alias goes in FIRST, then the row is
// marked: if the second write fails the suggestion stays 'new' and re-approving
// is idempotent (the same alias, written again), whereas the other order could
// mark a mapping done that never landed.
func (a *ArchiveAPI) handleSuggestionDecide(w http.ResponseWriter, r *http.Request, config AppConfig) {
	body, problem := httpx.ReadBody(r)
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	id, status := body.Get("id").StrVal(), body.Get("status").StrVal()
	if id == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "id required"))
		return
	}

	store := a.suggestions()
	version := ""
	if status == "actioned" {
		for _, pending := range store.List().Items() {
			if pending.Get("id").Str() != id || curation.KindOf(pending) != "identity" {
				continue
			}
			next, err := a.Decisions.Save(r.Context(), curation.Decision{
				Type:      "alias",
				Key:       archive.Fingerprint(pending.Get("name").StrVal()),
				Canonical: pending.Get("to").StrVal(),
			})
			if err != nil {
				httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
				return
			}
			version = curation.CurationToken(next.Serialize())
			break
		}
	}

	item, refusal, err := store.Decide(id, status, usernameOf(r, config))
	if refusal != "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, refusal))
		return
	}
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	out := js.Obj().Set("ok", js.Bool(true)).Set("item", item)
	if version != "" {
		out.Set("version", js.Str(version))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (a *ArchiveAPI) suggestions() *curation.SuggestionStore {
	return &curation.SuggestionStore{Dir: a.Decisions.CurationRoot, Now: a.now}
}

func usernameOf(r *http.Request, config AppConfig) string {
	if config.Authenticator == nil {
		return ""
	}
	if user := config.Authenticator.CheckAuth(r); user != nil {
		return user.Username
	}
	return ""
}

// ── Album covers ────────────────────────────────────────────────────────────

// AlbumResolver caches the allowlist and the covers between requests.
//
// The allowlist is the security property: the endpoint resolves what is in the
// datasets, never what a caller asks for, so it cannot be used to make this
// server fetch an address of somebody else's choosing.
type AlbumResolver struct {
	DataDir string

	mu    sync.Mutex
	allow map[string]bool
	cache *js.Value
}

func (a *ArchiveAPI) handleAlbumThumb(w http.ResponseWriter, r *http.Request, config AppConfig) {
	if a.Albums == nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, "no album resolver"))
		return
	}
	url := r.URL.Query().Get("url")

	a.Albums.mu.Lock()
	defer a.Albums.mu.Unlock()

	if a.Albums.allow == nil {
		a.Albums.allow, _ = archive.KnownAlbums(a.Albums.DataDir)
	}
	if !a.Albums.allow[url] {
		// A newly added album is worth one re-read before refusing.
		a.Albums.allow, _ = archive.KnownAlbums(a.Albums.DataDir)
		if !a.Albums.allow[url] {
			httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Unknown album"))
			return
		}
	}
	if a.Albums.cache == nil {
		a.Albums.cache = archive.LoadThumbCache(a.Albums.DataDir)
	}

	// `refresh=1` re-asks the host — how you clear a miss that was really a
	// rate-limit, without waiting for it to age out. Editors only: a reader
	// should not be able to make this server fetch on demand.
	refresh := r.URL.Query().Get("refresh") == "1" && callerIsEditor(r, config)
	before := a.Albums.cache.Get(url).Get("at").StrVal()

	thumb, cached := archive.ResolveThumb(url, a.Albums.cache, archive.ThumbOptions{Refresh: refresh})
	if a.Albums.cache.Get(url).Get("at").StrVal() != before {
		if err := archive.SaveThumbCache(a.Albums.DataDir, a.Albums.cache); err != nil {
			a.Decisions.Warn("[album-thumb] cache write failed: %v", err)
		}
	}

	// A cover is worth caching for a day; the ABSENCE of one is not. An empty
	// answer is usually temporary — a rate-limit, a slow host — and caching it
	// for a day means the card stays blank long after the server can resolve it,
	// with no way for the reader to tell that from a broken feature.
	if thumb != "" {
		w.Header().Set("Cache-Control", "public, max-age=86400")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("thumb", js.Str(thumb)).
		Set("cached", js.Bool(cached)))
}

// callerIsEditor checks the LEVEL rather than one role name — an admin is an
// editor's superior, not a stranger to it.
func callerIsEditor(r *http.Request, config AppConfig) bool {
	if config.Authenticator == nil {
		return true
	}
	user := config.Authenticator.CheckAuth(r)
	return user != nil && auth.RoleAtLeast(user.Role, "editor")
}

func readJSONFile(dir, name string) (*js.Value, error) {
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil, err
	}
	return js.ParseJSON(raw)
}
