package web

// The archive and curation API: `/api/archive/*` and `/api/curation/*`.
//
// The readers behind these were ported slices ago. This is the layer that gives
// them an address, a role gate, and — for the expensive one — a memo.

import (
	"context"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/archive/curation"
	"server/internal/httpx"
	"server/internal/js"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ArchiveAPI serves the archive's read endpoints and the curation desk.
type ArchiveAPI struct {
	DataDir   string
	ImgDir    string
	Decisions *curation.DecisionStore
	Albums    *AlbumResolver
	Now       func() time.Time

	insights insightsMemo
}

func (a *ArchiveAPI) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// ── The insights memo ───────────────────────────────────────────────────────

// insightsMemo holds the last built payload, and collapses concurrent builds.
//
// The archive's aggregates cost ~1.6s of CPU and 3.5 MB, and are byte-identical
// for every caller until a dataset changes. Without the memo they were rebuilt
// on every load of the archive page, for nobody's benefit; without the
// single-flight, five readers arriving together after a restart triggered five
// full builds — measured, not assumed — and each of them paid the full cost.
type insightsMemo struct {
	mu       sync.Mutex
	version  string
	payload  *js.Value
	inFlight map[string]*insightsBuild
}

type insightsBuild struct {
	done    chan struct{}
	payload *js.Value
	err     error
}

// get returns the payload for a version, from the memo or from one shared build.
//
// An empty version disables the memo outright — that is the no-catalog case, and
// it is deliberately not cached rather than cached as "unknown".
func (m *insightsMemo) get(version string, build func() (*js.Value, error)) (*js.Value, bool, error) {
	m.mu.Lock()
	if version != "" && m.version == version && m.payload != nil {
		payload := m.payload
		m.mu.Unlock()
		return payload, true, nil
	}
	if existing, running := m.inFlight[version]; running && version != "" {
		m.mu.Unlock()
		<-existing.done
		return existing.payload, true, existing.err
	}

	pending := &insightsBuild{done: make(chan struct{})}
	if m.inFlight == nil {
		m.inFlight = map[string]*insightsBuild{}
	}
	m.inFlight[version] = pending
	m.mu.Unlock()

	pending.payload, pending.err = build()

	m.mu.Lock()
	if pending.err == nil && version != "" {
		m.version, m.payload = version, pending.payload
	}
	delete(m.inFlight, version)
	m.mu.Unlock()
	close(pending.done)

	return pending.payload, false, pending.err
}

// dataVersion identifies the DATA the insights are built from.
//
// The catalog's `generatedAt` is most of it — the server regenerates the catalog
// on every dataset write, so it is exactly the data version this needs. The
// geocache is the rest: the map coordinates come from there, and keying on the
// catalog alone meant `geocode:events` changed the answer without changing the
// key, so a running server kept serving events as unmapped and nothing said why.
//
// Returns "" when there is no catalog, which disables caching rather than
// caching an answer called "unknown".
func (a *ArchiveAPI) dataVersion() string {
	raw, err := os.ReadFile(filepath.Join(a.DataDir, "catalog.json"))
	if err != nil {
		return ""
	}
	catalog, err := js.ParseJSON(raw)
	if err != nil {
		return ""
	}
	generated := catalog.Get("generatedAt").StrVal()
	if generated == "" {
		return ""
	}
	info, err := os.Stat(filepath.Join(a.DataDir, "geocache.json"))
	if err != nil {
		return generated // no geocache → maps are empty for everyone, consistently
	}
	millis := float64(info.ModTime().UnixNano()) / 1e6
	return generated + ":g" + strconv.FormatInt(int64(math.Round(millis)), 10)
}

// handleInsights serves the aggregated archive.
//
// `?v=<token>` is a CONTENT ADDRESS, not a cache-buster: the response is the
// same for every caller holding that token, so the versioned URL is cached hard
// and a decision invalidates it by moving to a new URL. A `?v=` naming an older
// ledger is a client holding a stale URL — answer with what is true now rather
// than 404-ing a page mid-render, and say which version this actually is so the
// client can settle on it.
func (a *ArchiveAPI) handleInsights(w http.ResponseWriter, r *http.Request) {
	ledger := a.Decisions.Read(r.Context())
	token := curation.CurationToken(ledger)
	catalog := a.dataVersion()
	version := ""
	if catalog != "" {
		version = catalog + ":" + token
	}
	w.Header().Set("X-Curation-Version", token)

	parsed := curation.ParseLedger(ledger)
	payload, cached, err := a.insights.get(version, func() (*js.Value, error) {
		built, err := archive.BuildInsights(a.DataDir, parsed.Aliases, parsed.Series)
		if err != nil {
			return nil, err
		}
		built.Set("curationVersion", js.Str(token))
		// The payload is a function of the DATASETS as well as the ledger, which
		// is why the key is `<catalog>:<token>`. The client used to address it by
		// ledger token alone, so a `?v=` URL — held immutable for a year — kept
		// serving the archive as it was before an event was edited. Hand back
		// both halves so the client can address the same content we cached.
		built.Set("dataVersion", archive.StrOrNull(catalog))
		return built, nil
	})
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	if cached {
		w.Header().Set("X-Cache", "hit")
	} else {
		w.Header().Set("X-Cache", "miss")
	}
	httpx.WriteJSON(w, http.StatusOK, payload)
}

// WarmInsights builds the archive once at boot so the first reader is not the
// one paying for it.
//
// The memo lives in this process and dies with it, so every restart and every
// deploy handed somebody a 1.6s wait. Never fatal — insights are a feature, not
// a precondition for serving the site.
func (a *ArchiveAPI) WarmInsights(ctx context.Context) {
	ledger := a.Decisions.Read(ctx)
	catalog := a.dataVersion()
	if catalog == "" {
		// Worth saying out loud rather than silently running 35× slower.
		a.Decisions.Warn("[insights] no catalog.json version — responses will not be cached")
		return
	}
	token := curation.CurationToken(ledger)
	parsed := curation.ParseLedger(ledger)
	started := a.now()
	_, _, err := a.insights.get(catalog+":"+token, func() (*js.Value, error) {
		built, err := archive.BuildInsights(a.DataDir, parsed.Aliases, parsed.Series)
		if err != nil {
			return nil, err
		}
		built.Set("curationVersion", js.Str(token))
		built.Set("dataVersion", archive.StrOrNull(catalog))
		return built, nil
	})
	if err != nil {
		a.Decisions.Warn("[insights] boot warm skipped: %v", err)
		return
	}
	a.Decisions.Warn("[insights] warmed in %dms", a.now().Sub(started).Milliseconds())
}

// ── Routing ─────────────────────────────────────────────────────────────────

// serveArchiveAPI answers if the path is one of ours, and reports whether it did.
func serveArchiveAPI(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	api := config.Archive
	if api == nil {
		return false
	}
	path := r.URL.Path
	query := r.URL.Query()

	switch {
	case path == "/api/health" && isRead(r):
		httpx.WriteJSON(w, http.StatusOK, js.Obj().
			Set("ok", js.Bool(true)).
			Set("app", js.Str("conference-planner-api")).
			Set("version", js.Int(1)))
		return true

	case path == "/api/archive/insights" && isRead(r):
		if requireRole(w, r, config, "editor") {
			api.handleInsights(w, r)
		}
		return true

	case path == "/api/archive/sessions" && isRead(r):
		if requireRole(w, r, config, "editor") {
			api.handleSessions(w, r)
		}
		return true

	case path == "/api/archive/cospeakers" && isRead(r):
		if requireRole(w, r, config, "editor") {
			api.handleCoSpeakers(w, r)
		}
		return true

	case path == "/api/archive/topic" && isRead(r):
		if requireRole(w, r, config, "editor") {
			api.handleTopic(w, r)
		}
		return true

	case path == "/api/archive/album-thumb" && isRead(r):
		// A reader may SEE a cover; only an editor may make this server go and
		// fetch one on demand. The refresh check is inside the handler.
		if requireRole(w, r, config, "viewer") {
			api.handleAlbumThumb(w, r, config)
		}
		return true

	case path == "/api/curation/clusters" && isRead(r):
		if requireRole(w, r, config, "editor") {
			api.handleClusters(w, r)
		}
		return true

	case path == "/api/curation/coverage":
		if !requireRole(w, r, config, "editor") {
			return true
		}
		if r.Method == http.MethodPost {
			api.handleCoverageDecision(w, r)
		} else if isRead(r) {
			api.handleCoverage(w, r)
		} else {
			methodNotAllowed(w, "GET, POST")
		}
		return true

	case path == "/api/curation/series":
		if !requireRole(w, r, config, "editor") {
			return true
		}
		if r.Method == http.MethodPost {
			api.handleSeriesDecision(w, r)
		} else if isRead(r) {
			api.handleSeriesList(w, r)
		} else {
			methodNotAllowed(w, "GET, POST")
		}
		return true

	case path == "/api/curation/merge" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleMerge(w, r)
		}
		return true

	case path == "/api/curation/distinct" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleDistinct(w, r)
		}
		return true

	case path == "/api/curation/undo" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleUndo(w, r)
		}
		return true

	case path == "/api/curation/suggestions":
		if r.Method == http.MethodPost {
			// SUBMIT_ROLE is a viewer because the plan is for this box to be
			// public when the archive is. Today it matches the gate on /archive
			// itself, so it adds no new surface.
			if requireRole(w, r, config, "viewer") {
				api.handleSuggest(w, r, config)
			}
			return true
		}
		if isRead(r) {
			if requireRole(w, r, config, "editor") {
				api.handleSuggestionList(w, r)
			}
			return true
		}
		methodNotAllowed(w, "GET, POST")
		return true

	case path == "/api/curation/suggestions/decide" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleSuggestionDecide(w, r, config)
		}
		return true
	}

	_ = query
	return false
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	httpx.WriteError(w, httpx.Error(http.StatusMethodNotAllowed, "Method Not Allowed"))
}

// ── Read handlers ───────────────────────────────────────────────────────────

func (a *ArchiveAPI) handleSessions(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	options := archive.SearchOptions{
		// Paged so a broad search ("ai") can be read past its first page.
		// Clamped here rather than trusted: the page size is a client
		// convenience, and an unbounded one would let a caller ask for every
		// match in one response.
		Limit:  maxInt(1, clampedInt(query.Get("limit"), 200, 500)),
		Offset: clampedInt(query.Get("offset"), 0, 100000),
		// Whole words unless asked otherwise.
		Mode:    modeOrExact(query.Get("mode")),
		Series:  facetOrAll(query.Get("series")),
		Region:  facetOrAll(query.Get("region")),
		Country: facetOrAll(query.Get("country")),
		Year:    facetOrAll(query.Get("year")),
		// `video=1` turns the same search into the recordings view: only sessions
		// that were filmed, and an empty query browses them rather than returning
		// nothing.
		HasVideo: query.Get("video") == "1",
	}
	result, err := archive.SearchSessions(a.DataDir, query.Get("q"), options)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, result)
}

func (a *ArchiveAPI) handleCoSpeakers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	result, err := archive.CoSpeakers(a.DataDir, query.Get("name"), archive.Facets{
		Series:  facetOrAll(query.Get("series")),
		Region:  facetOrAll(query.Get("region")),
		Country: facetOrAll(query.Get("country")),
	}, curation.ParseLedger(a.Decisions.Read(r.Context())).Decisions())
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, result)
}

func (a *ArchiveAPI) handleTopic(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	// `year` switches the response from "counts for the chart" to "the sessions
	// themselves, for the drill" — same matcher, one year's worth.
	var year *int
	if raw := query.Get("year"); raw != "" {
		if parsed, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
			year = &parsed
		}
	}
	result, err := archive.SearchTopic(a.DataDir, query.Get("term"), archive.Facets{
		Series:  facetOrAll(query.Get("series")),
		Region:  facetOrAll(query.Get("region")),
		Country: facetOrAll(query.Get("country")),
	}, year, curation.ParseLedger(a.Decisions.Read(r.Context())).Decisions())
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, result)
}

func (a *ArchiveAPI) handleClusters(w http.ResponseWriter, r *http.Request) {
	ledger := curation.ParseLedger(a.Decisions.Read(r.Context()))
	data, err := curation.BuildCurationData(a.DataDir, a.ImgDir, ledger.Decisions(), ledger.DistinctKeys())
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, data)
}

func (a *ArchiveAPI) handleCoverage(w http.ResponseWriter, r *http.Request) {
	ledger := curation.ParseLedger(a.Decisions.Read(r.Context()))
	data, err := archive.BuildCoverage(a.DataDir, ledger.Snoozes, a.now().Format("2006-01-02"))
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, data)
}

func (a *ArchiveAPI) handleSeriesList(w http.ResponseWriter, r *http.Request) {
	ledger := curation.ParseLedger(a.Decisions.Read(r.Context()))
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("series", ledger.Series))
}

// ── Query helpers ───────────────────────────────────────────────────────────

// clampedInt parses a page parameter, clamping to [0, max]. A value that is not
// a number at all falls back to the default rather than to zero.
func clampedInt(raw string, fallback, max int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(leadingInt(raw)))
	if err != nil {
		return fallback
	}
	return minInt(maxInt(parsed, 0), max)
}

// leadingInt mimics parseInt: it reads the leading integer and ignores whatever
// follows, so "20abc" is 20 and "abc" is nothing.
func leadingInt(raw string) string {
	trimmed := strings.TrimSpace(raw)
	end := 0
	if end < len(trimmed) && (trimmed[end] == '-' || trimmed[end] == '+') {
		end++
	}
	for end < len(trimmed) && trimmed[end] >= '0' && trimmed[end] <= '9' {
		end++
	}
	return trimmed[:end]
}

func modeOrExact(raw string) string {
	if raw == "contains" {
		return "contains"
	}
	return "exact"
}

func facetOrAll(raw string) string {
	if raw == "" {
		return "All"
	}
	return raw
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
