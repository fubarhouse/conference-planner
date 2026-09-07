package archive

// Two on-demand archive queries: who has shared a session with this person, and
// how a keyword moves across twenty years.
//
// A port of `coSpeakers` and `searchTopic` from lib/archiveInsights.js. Both are
// on demand rather than in the insights payload because both are answers about
// ONE thing a reader asked for, and precomputing them for every speaker and
// every possible keyword is not a payload, it is the archive again.

import (
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ── Co-speakers ─────────────────────────────────────────────────────────────

// CoSpeakers is who has shared a session with this person.
//
// Counted per SESSION, not per pairing: two people on one panel is one shared
// session for each of them.
func CoSpeakers(dataDir, name string, facets Facets, decisions Decisions) (*js.Value, error) {
	target := js.Trim(name)
	if target == "" {
		return js.Obj().Set("name", js.Str("")).Set("sessions", js.Int(0)).Set("partners", js.Arr()), nil
	}

	canonical := func(raw string) string {
		if alias := decisions.Aliases.Get(Fingerprint(raw)).StrVal(); alias != "" {
			return alias
		}
		return raw
	}

	type partner struct {
		name     string
		count    int
		sessions *js.Value
	}
	partners := map[string]*partner{}
	var order []string
	shared := 0

	err := eachCatalogEvent(dataDir, func(file string, data *js.Value) {
		event := data.Get("event")
		if !facets.match(file, event, decisions, nil) {
			return
		}
		label := JoinNonEmpty(" ", event.Get("designation").StrVal(),
			event.Get("location").StrVal(), event.Get("year").StrVal())
		year := yearValue(event)

		for _, item := range data.Get("items").Items() {
			if !CountsAsSession(item) {
				continue
			}
			// Deduplicated first: a session listing somebody twice is one
			// appearance, not a collaboration with themselves.
			names, present := canonicalSpeakers(item, canonical, target)
			if len(names) < 2 || !present {
				continue
			}
			shared++
			for _, other := range names {
				if other == target {
					continue
				}
				record, seen := partners[other]
				if !seen {
					record = &partner{name: other, sessions: js.Arr()}
					partners[other] = record
					order = append(order, other)
				}
				record.count++
				// Capped: the list is a sample for a card, and a prolific pairing
				// would otherwise carry hundreds of rows nobody scrolls.
				if len(record.sessions.Items()) < 12 {
					record.sessions.Append(js.Obj().
						Set("title", js.Str(item.Get("title").StrVal())).
						Set("event", js.Str(label)).
						Set("year", year))
				}
			}
		}
	})
	if err != nil {
		return nil, err
	}

	sort.SliceStable(order, func(a, b int) bool {
		left, right := partners[order[a]], partners[order[b]]
		if left.count != right.count {
			return left.count > right.count
		}
		return js.LocaleCompare(left.name, right.name)
	})

	list := js.Arr()
	for _, name := range order {
		record := partners[name]
		list.Append(js.Obj().
			Set("name", js.Str(record.name)).
			Set("count", js.Int(record.count)).
			Set("sessions", record.sessions))
	}
	return js.Obj().
		Set("name", js.Str(target)).
		Set("sessions", js.Int(shared)).
		Set("partners", list), nil
}

// canonicalSpeakers resolves a session's speakers through the aliases, drops
// duplicates and empties, and reports whether the target is among them.
func canonicalSpeakers(item *js.Value, canonical func(string) string, target string) ([]string, bool) {
	var names []string
	seen := map[string]bool{}
	found := false
	for _, raw := range item.Get("speakers").Items() {
		name := canonical(js.Trim(raw.StrVal()))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
		if name == target {
			found = true
		}
	}
	return names, found
}

// ── Topic search ────────────────────────────────────────────────────────────

// TermPattern compiles a keyword as a WHOLE-WORD pattern — the only way the
// chart matches.
//
// The chart plots a term over twenty years, so a substring reading would not be
// a softer answer, it would be a different and wrong one: "ai" inside "maintain"
// and "email" would draw a line about nothing. There is deliberately no
// "contains" option here, unlike the session search where a reader can see the
// rows and judge them.
//
// A multi-word term is still a phrase, joined by "any run of non-word
// characters", so "layout builder" matches "Layout-Builder" and "layout  builder".
//
// Letters and digits are Unicode, not [a-z0-9]. Under the ASCII classes an
// accent counted as a word boundary: "gábor" compiled to "g" + separator +
// "bor", which matched the name but would equally have matched "g bor". `+` and
// `#` stay word characters, so "c++" and "c#" survive as terms.
//
// Go's regexp has no lookaround, so the boundaries are applied by hand around a
// candidate match rather than compiled into the pattern — same rule, checked
// after the fact. Returns nil when the term has no word characters at all.
func TermPattern(term string) *regexp.Regexp {
	words := splitTermWords(strings.ToLower(term))
	if len(words) == 0 {
		return nil
	}
	quoted := make([]string, len(words))
	for index, word := range words {
		quoted[index] = regexp.QuoteMeta(word)
	}
	return regexp.MustCompile(`(?i)` + strings.Join(quoted, `[^\p{L}\p{N}]+`))
}

var termSeparator = regexp.MustCompile(`[^\p{L}\p{N}+#]+`)

func splitTermWords(term string) []string {
	var words []string
	for _, word := range termSeparator.Split(term, -1) {
		if word != "" {
			words = append(words, word)
		}
	}
	return words
}

// matchesTermPattern applies the word boundaries the pattern cannot express.
func matchesTermPattern(pattern *regexp.Regexp, haystack string) bool {
	for _, span := range pattern.FindAllStringIndex(haystack, -1) {
		if isWordBoundary(haystack, span[0], -1) && isWordBoundary(haystack, span[1], +1) {
			return true
		}
	}
	return false
}

// isWordBoundary reports whether the character on the given side of an offset is
// absent or a non-word character.
func isWordBoundary(text string, offset, direction int) bool {
	if direction < 0 {
		if offset == 0 {
			return true
		}
		before, _ := utf8.DecodeLastRuneInString(text[:offset])
		return !isTermWordRune(before)
	}
	if offset >= len(text) {
		return true
	}
	after, _ := utf8.DecodeRuneInString(text[offset:])
	return !isTermWordRune(after)
}

// isTermWordRune is the `[\p{L}\p{N}]` class the pattern's boundaries use.
func isTermWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r)
}

// Facets are the geographic and series filters every archive query shares.
type Facets struct{ Series, Region, Country string }

// DefaultFacets is "everything".
func DefaultFacets() Facets {
	return Facets{Series: "All", Region: "All", Country: "All"}
}

// match reports whether one event passes the facets.
//
// `geo` is the geocache, used only for the country fallback; nil skips the
// derivation, which is what the co-speaker query wants (it filters on the stored
// country field alone, as the JavaScript does).
func (f Facets) match(file string, event *js.Value, decisions Decisions, geo *js.Value) bool {
	if f.Series != "" && f.Series != "All" && seriesFor(file, event, decisions) != f.Series {
		return false
	}
	if f.Region != "" && f.Region != "All" && RegionOf(event) != f.Region {
		return false
	}
	if f.Country == "" || f.Country == "All" {
		return true
	}
	country := event.Get("country").StrVal()
	if country == "" && geo != nil {
		display := geo.Get(event.Get("location").StrVal()).Get("display").StrVal()
		country = DeriveCountry(event.Get("region").StrVal(), display)
	}
	return country == f.Country
}

// seriesFor is the per-event lineage mapping: what an event BELONGS to, which is
// not always what it was called.
func seriesFor(file string, event *js.Value, decisions Decisions) string {
	if mapped := decisions.Series.Get(file).StrVal(); mapped != "" {
		return mapped
	}
	if designation := event.Get("designation").StrVal(); designation != "" {
		return designation
	}
	return "Other"
}

// SearchTopic searches title + full_description across the archive for one
// keyword or phrase.
//
// The chart asks for every year and needs only counts; the drill asks for ONE
// year and needs the sessions themselves — who spoke, at which event, what it
// was about. Same matcher either way, so a drill can never disagree with the
// point that opened it.
func SearchTopic(dataDir, term string, facets Facets, onlyYear *int, decisions Decisions) (*js.Value, error) {
	pattern := TermPattern(term)
	if pattern == nil {
		return js.Obj().Set("term", js.Str(term)).Set("byYear", js.Obj()).Set("sessions", js.Arr()), nil
	}

	geo := js.Obj()
	if raw, err := os.ReadFile(filepath.Join(dataDir, "geocache.json")); err == nil {
		if parsed, err := js.ParseJSON(raw); err == nil {
			geo = parsed
		}
	}

	detail := onlyYear != nil
	byYear, byYearDescribed := js.Obj(), js.Obj()
	sessions := js.Arr()

	err := eachCatalogEvent(dataDir, func(file string, data *js.Value) {
		event := data.Get("event")
		year := intOrZero(event.Get("year").StrVal())
		if year == 0 {
			return
		}
		if !facets.match(file, event, decisions, geo) {
			return
		}
		label := JoinNonEmpty(" ", event.Get("designation").StrVal(),
			event.Get("location").StrVal(), event.Get("year").StrVal())
		var coords *Coords
		if detail {
			coords = CoordsFor(event, geo)
		}
		key := strconv.Itoa(year)

		for _, item := range data.Get("items").Items() {
			if !CountsAsSession(item) {
				continue
			}
			haystack := strings.ToLower(item.Get("title").StrVal() + " " +
				item.Get("full_description").StrVal())
			if !matchesTermPattern(pattern, haystack) {
				continue
			}
			bump(byYear, key)
			// The same split the mined index carries: matches among sessions that
			// HAVE a description, so a custom keyword's share is measured against
			// the same readable population as a mined one.
			if item.Get("full_description").Text() {
				bump(byYearDescribed, key)
			}
			if detail && year != *onlyYear {
				continue
			}
			if len(sessions.Items()) >= 800 {
				continue
			}
			sessions.Append(topicSession(item, event, file, label, year, coords, detail))
		}
	})
	if err != nil {
		return nil, err
	}

	out := js.Obj().
		Set("term", js.Str(term)).
		Set("byYear", byYear).
		Set("byYearDescribed", byYearDescribed).
		Set("sessions", sessions)
	if detail {
		out.Set("year", js.Int(*onlyYear))
	} else {
		out.Set("year", js.Null())
	}
	return out, nil
}

func topicSession(item, event *js.Value, file, label string, year int, coords *Coords, detail bool) *js.Value {
	if !detail {
		return js.Obj().Set("year", js.Int(year)).Set("title", js.Str(item.Get("title").StrVal()))
	}
	row := js.Obj().
		Set("year", js.Int(year)).
		Set("title", js.Str(item.Get("title").StrVal())).
		Set("description", js.Str(item.Get("full_description").StrVal())).
		Set("speakers", js.Str(joinValues(item.Get("speakers"), ", "))).
		Set("location", js.Str(item.Get("location").StrVal())).
		Set("startTime", js.Str(item.Get("startTime").StrVal())).
		Set("link", js.Str(item.Get("link").StrVal())).
		Set("video", js.Str(item.Get("video_url").StrVal())).
		Set("event", js.Str(label)).
		Set("series", js.Str(event.Get("designation").StrVal())).
		Set("region", js.Str(event.Get("regionCode").StrVal())).
		Set("country", js.Str(event.Get("country").StrVal())).
		Set("city", js.Str(event.Get("location").StrVal())).
		Set("file", js.Str(file))
	// `undefined` for a missing coordinate, which JSON.stringify omits — so an
	// unmapped event has no lat/lon keys at all rather than a pair of nulls.
	if coords != nil {
		row.Set("lat", number(coords.Lat)).Set("lon", number(coords.Lon))
	}
	return row
}

// ── Shared walking ──────────────────────────────────────────────────────────

// eachCatalogEvent reads every dataset the catalog names, in catalog order.
//
// A dataset that will not parse is skipped rather than fatal: one bad file must
// not take the whole archive's answer with it.
func eachCatalogEvent(dataDir string, visit func(file string, data *js.Value)) error {
	raw, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return err
	}
	catalog, err := js.ParseJSON(raw)
	if err != nil {
		return err
	}
	for _, entry := range catalog.Get("events").Items() {
		file := entry.Get("file").StrVal()
		if file == "" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(file)))
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(body)
		if err != nil {
			continue
		}
		visit(file, data)
	}
	return nil
}

func bump(counts *js.Value, key string) {
	current, _ := counts.Get(key).Number()
	counts.Set(key, js.Int(int(current)+1))
}

func joinValues(list *js.Value, separator string) string {
	var parts []string
	for _, item := range list.Items() {
		parts = append(parts, item.StrVal())
	}
	return strings.Join(parts, separator)
}

// yearValue is the event's year as a number, or null — `Number(x) || null` in
// the original, so a zero year is null too.
func yearValue(event *js.Value) *js.Value {
	if year := intOrZero(event.Get("year").StrVal()); year != 0 {
		return js.Int(year)
	}
	return js.Null()
}

func intOrZero(s string) int {
	value, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return value
}
