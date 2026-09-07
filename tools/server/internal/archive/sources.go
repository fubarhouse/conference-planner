package archive

// A Go port of summarizeSources() from app/js/modules/sources.js.
//
// This is the first place the port meets the problem the whole codebase is
// organised against: sources.js is deliberately ONE implementation, imported by
// the browser, by lib/ through a shim, and by the scripts. A Go copy is a
// second implementation of the same schema, and nothing but discipline keeps
// the two agreeing.
//
// The discipline here is a shared fixture. testdata/sources-cases.json is read
// by BOTH sides — sources_test.go and app/js/modules/__tests__/sourcesSummary
// contract test — so a change to the rule on either side fails the other's
// build. Extend the fixture when you extend the rule; that file is the contract,
// not this comment.
//
// See docs/go-port.md.

import (
	"regexp"
	"server/internal/js"
	"strings"
	"time"
)

// SourceSummary is the digest of an event's provenance that goes into the
// catalog: enough for the archive to filter on — everything from archive.org,
// everything unsourced, everything not verified since a given year — without
// loading 126 datasets to answer.
type SourceSummary struct {
	Count         int
	KindOrder     []string // first-seen order, which is what the JS object preserves
	Kinds         map[string]int
	Wayback       bool
	Stated        int
	OldestCapture string // "" means null
	RetrievedFrom string
	RetrievedTo   string
}

// SummarizeSources mirrors summarizeSources(dataset) exactly, including the
// order `kinds` comes out in.
func SummarizeSources(dataset *js.Value) SourceSummary {
	summary := SourceSummary{Kinds: map[string]int{}}

	sources := dataset.Get("event").Get("sources").Items()
	summary.Count = len(sources)

	var captures, retrieved []string
	for _, source := range sources {
		if kind := source.Get("kind").Str(); kind != "" {
			if _, seen := summary.Kinds[kind]; !seen {
				summary.KindOrder = append(summary.KindOrder, kind)
			}
			summary.Kinds[kind]++
		}
		switch source.Get("via").Get("provider").Str() {
		case "stated":
			summary.Stated++
		case "wayback":
			summary.Wayback = true
			if iso := WaybackTimestampToISO(source.Get("via").Get("timestamp").Str()); iso != "" {
				captures = append(captures, iso)
			}
		}
		// String(...).slice(0, 10) — a datetime is accepted and cut to its date.
		if at := source.Get("retrievedAt").Str(); at != "" {
			retrieved = append(retrieved, FirstRunes(at, 10))
		}
	}

	sortStrings(captures)
	sortStrings(retrieved)
	if len(captures) > 0 {
		summary.OldestCapture = captures[0]
	}
	if len(retrieved) > 0 {
		summary.RetrievedFrom = retrieved[0]
		summary.RetrievedTo = retrieved[len(retrieved)-1]
	}
	return summary
}

// Value renders the summary the way the catalog carries it.
func (s SourceSummary) Value() *js.Value {
	kinds := js.Obj()
	for _, kind := range s.KindOrder {
		kinds.Set(kind, js.Int(s.Kinds[kind]))
	}
	orNull := func(s string) *js.Value {
		if s == "" {
			return js.Null()
		}
		return js.Str(s)
	}
	return js.Obj().
		Set("count", js.Int(s.Count)).
		Set("kinds", kinds).
		Set("wayback", js.Bool(s.Wayback)).
		Set("stated", js.Int(s.Stated)).
		Set("oldestCapture", orNull(s.OldestCapture)).
		Set("retrievedFrom", orNull(s.RetrievedFrom)).
		Set("retrievedTo", orNull(s.RetrievedTo))
}

var waybackStamp = regexp.MustCompile(`^\d{4,14}$`)

// WaybackTimestampToISO mirrors waybackTimestampToIso(). Returns "" for null.
//
// The clamping is not cosmetic: a short stamp pads to month/day `00`, and
// "2013-00-00" is not a date. JS checks that with Date.parse; time.Parse is the
// equivalent, and it is equally strict about day 32 or month 13.
func WaybackTimestampToISO(timestamp string) string {
	if !waybackStamp.MatchString(timestamp) {
		return ""
	}
	padded := timestamp + strings.Repeat("0", 14-len(timestamp))
	year, month, day := padded[0:4], padded[4:6], padded[6:8]
	if month == "00" {
		month = "01"
	}
	if day == "00" {
		day = "01"
	}
	iso := year + "-" + month + "-" + day
	if _, err := time.Parse("2006-01-02", iso); err != nil {
		return ""
	}
	return iso
}

func FirstRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// sortStrings sorts by code point. JS's default Array.prototype.sort compares
// UTF-16 code units, which differs from this only above the BMP — and these are
// ISO dates.
func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// ── Confidence, attribution and reach ───────────────────────────────────────
//
// Three more rules ported from app/js/modules/sources.js, all pinned by the
// same shared fixture as SummarizeSources.

// SourceConfidence is the tier a source sits in.
//
// `accepted` sits below `verified` on purpose. Policy is a decision that a
// check is unnecessary, not the check — collapsing the two would let a few
// hundred auto-stamped rows report as human-confirmed, which is precisely the
// overstatement the provenance system exists to prevent.
func SourceConfidence(source *js.Value) string {
	if source.Get("verifiedAt").Exists() && source.Get("verifiedAt").Str() != "" {
		if source.Get("verifiedBy").Str() == "policy" {
			return "accepted"
		}
		return "verified"
	}
	provider := source.Get("via").Get("provider").Str()
	if provider == "stated" {
		return "stated"
	}
	if source.Get("capture").Exists() || provider == "wayback" {
		return "captured"
	}
	return "live"
}

// AttributionStrength says whether a record's attribution is evidence or
// inference.
//
// `exact` means the record's own link IS the source's address — the session was
// read from that specific page. `page` means it was attributed to a page the
// whole dataset came from, which is true of how the archive was assembled but
// is not a record about that row.
func AttributionStrength(record *js.Value, byID map[string]*js.Value) string {
	refs := record.Get("sourceIds").Items()
	if len(refs) == 0 {
		return "none"
	}
	if link := js.Trim(record.Get("link").Str()); link != "" {
		for _, ref := range refs {
			source := byID[ref.Str()]
			if url := source.Get("url"); url.Exists() && url.Str() == link {
				return "exact"
			}
		}
	}
	return "page"
}

// SourceReach counts how many records cite each source. Verification effort
// should follow reach: a source 300 sessions rest on is worth an afternoon; one
// cited by a single row is worth a minute.
func SourceReach(dataset *js.Value) map[string]int {
	reach := map[string]int{}
	bump := func(record *js.Value) {
		for _, ref := range record.Get("sourceIds").Items() {
			reach[ref.Str()]++
		}
	}
	event := dataset.Get("event")
	bump(event)
	bump(event.Get("attendance"))
	bump(event.Get("community"))
	for _, person := range event.Get("community").Get("people").Items() {
		bump(person)
	}
	for _, sponsor := range event.Get("sponsors").Items() {
		bump(sponsor)
	}
	for _, item := range dataset.Get("items").Items() {
		bump(item)
	}
	return reach
}
