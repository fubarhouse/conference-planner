package archive

// A Go port of lib/archiveSessions.js — session search across the whole
// archive.
//
// The insights payload deliberately carries no session titles or descriptions:
// it is a compact index of term membership, and adding 6,500 descriptions to it
// would multiply a payload the client already downloads in full. Searching text
// therefore happens here, over the datasets on disk, and returns only matches.

import (
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"sort"
	"strings"
	"time"
)

// nonWord is every run of characters that is neither a letter nor a number, in
// any script — the JavaScript uses \p{L} and \p{N} with the unicode flag, and
// an ASCII-only class here would split "Gábor" and "日本語" differently.
var nonWord = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// wordText reduces searchable text to space-separated words, padded at both
// ends.
//
// This is how whole-word matching is done without regex lookbehind (Safari only
// grew it in 16.4): a term wrapped in spaces can only match on word boundaries.
// " ai " is in " artificial intelligence ai the good " and is NOT in
// " maintain the standard ".
func wordText(value string) string {
	return " " + strings.TrimSpace(nonWord.ReplaceAllString(strings.ToLower(value), " ")) + " "
}

// MatchesTerm reports whether a haystack matches a term under a mode.
//
// `contains` is the original rule: substring matching is what makes a phrase
// like "display suite" behave as a reader expects. Its cost is that a short term
// has no word boundary — "ai" matches "maintain", "email" and "available", and a
// search for it returned 2,824 sessions of which a handful were about AI.
// `exact` is the answer, chosen per search rather than per term, because only
// the person typing knows which they meant.
func MatchesTerm(haystack, term, mode string) bool {
	if mode != "exact" {
		return strings.Contains(strings.ToLower(haystack), term)
	}
	trimmed := strings.TrimSpace(wordText(term))
	if trimmed == "" {
		return false
	}
	return strings.Contains(wordText(haystack), " "+trimmed+" ")
}

// jsOrEmpty is `value || ”` — the raw string, NOT a trimmed one.
//
// The distinction cost a comparison: search copies `item.full_description` into
// its results untouched, and a description in the archive ends with a trailing
// space. Reading it through the trimming accessor produced a result that was
// right in every way a person would notice and wrong by one byte.
func jsOrEmpty(v *js.Value) string {
	if !js.Truthy(v) {
		return ""
	}
	return js.String(v)
}

// SpeakerNames splits a dataset's comma-joined speaker list.
func SpeakerNames(joined string) []string {
	var out []string
	for _, part := range strings.Split(joined, ",") {
		if name := strings.TrimSpace(part); name != "" {
			out = append(out, name)
		}
	}
	return out
}

// tally is an insertion-ordered counter with a stable iteration order.
type tally struct {
	order  []string
	counts map[string]int
}

func newTally() *tally { return &tally{counts: map[string]int{}} }

func (t *tally) bump(key string) {
	if key == "" {
		return
	}
	if _, seen := t.counts[key]; !seen {
		t.order = append(t.order, key)
	}
	t.counts[key]++
}

// RankTally is one breakdown list: how many MATCHES fell in each bucket, and how
// big that bucket is in the searched scope.
//
// The count alone was being read as "how many results are on the page", which it
// never was — the list is capped while the tallies count every match. The
// denominator answers the question that makes the number useful: 55 of Gábor's
// 210 talks are about this. A share, not a raw tally that can only be compared
// to itself.
func RankTally(counts, totals *tally, limit int) *js.Value {
	type row struct {
		name         string
		count, total int
	}
	rows := make([]row, 0, len(counts.order))
	for _, name := range counts.order {
		total, has := totals.counts[name]
		if !has {
			total = counts.counts[name]
		}
		rows = append(rows, row{name, counts.counts[name], total})
	}
	// Matches descending — the subject is what was searched for — then by name,
	// so equal counts keep a stable order between requests instead of following
	// file-read order.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].count != rows[j].count {
			return rows[i].count > rows[j].count
		}
		return js.LocaleCompare(rows[i].name, rows[j].name)
	})
	if limit > 0 && len(rows) > limit {
		rows = rows[:limit]
	}

	out := js.Arr()
	for _, item := range rows {
		out.Append(js.Obj().
			Set("name", js.Str(item.name)).
			Set("count", js.Int(item.count)).
			Set("total", js.Int(item.total)))
	}
	return out
}

// SearchOptions mirrors the query parameters exactly, including the "All"
// sentinel, so a filtered search and a filtered dashboard mean the same thing.
type SearchOptions struct {
	Limit, Offset                 int
	Mode                          string // contains | exact
	Series, Region, Country, Year string
	HasVideo                      bool
}

// DefaultSearchOptions are what an unspecified search means.
func DefaultSearchOptions() SearchOptions {
	return SearchOptions{
		Limit: 200,
		// Whole words by default. Substring matching is the more surprising rule
		// of the two, and `ai` returned 2,810 sessions of which a handful were
		// about AI.
		Mode:   "exact",
		Series: "All", Region: "All", Country: "All", Year: "All",
	}
}

type searchResult struct {
	value   *js.Value
	when    float64
	title   string
	year    int
	matched []string
	series  string
	region  string
	country string
	city    string
	speaker string
	event   string
}

// SearchSessions returns every session whose title, description or speaker
// matches the query, newest first.
func SearchSessions(dataDir, query string, options SearchOptions) (*js.Value, error) {
	mode := "exact"
	if options.Mode == "contains" {
		mode = "contains"
	}
	from := options.Offset
	if from < 0 {
		from = 0
	}

	normalised := strings.TrimSpace(strings.ToLower(query))
	// Commas mean OR: "layout builder, paragraphs" finds sessions matching
	// either, and the trend chart plots one line per term so they compare.
	var terms []string
	for _, part := range strings.Split(normalised, ",") {
		if term := strings.TrimSpace(part); len([]rune(term)) >= 2 {
			terms = append(terms, term)
		}
	}
	// NO QUERY MEANS BROWSE, not "no results". The video view has always worked
	// this way — "show me everything that was filmed" is a reasonable first
	// question — and the session view needs it for the same reason plus one
	// more: with the facets right there, clearing the box is how you get back
	// from a search to "everything in this scope". Returning an empty set made
	// that a dead end, so the only way out of a search was the Back button.
	//
	// It is safe to open up because the response is paged and the facets still
	// apply: this is a listing, not an unbounded dump.
	//
	// AN EMPTY BOX AND AN UNUSABLE QUERY ARE NOT THE SAME THING. A single letter
	// is below the two-rune term threshold and so also yields no terms — but the
	// reader typed it and meant something by it. Browsing there would answer
	// "a" with all ten thousand sessions, so only a genuinely empty query
	// browses; anything typed but unusable still returns nothing.
	browsing := len(terms) == 0 && strings.TrimSpace(normalised) == ""

	if len(terms) == 0 && !browsing {
		return js.Obj().
			Set("query", js.Str(normalised)).
			Set("terms", js.Arr()).
			Set("total", js.Int(0)).
			Set("offset", js.Int(from)).
			Set("byYear", js.Obj()).
			Set("byTerm", js.Obj()).
			Set("results", js.Arr()), nil
	}

	files, err := searchDatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		return nil, err
	}

	wanted := func(selected, actual string) bool {
		return selected == "All" || selected == "" || actual == selected
	}

	var results []searchResult
	// Denominators: every session the search COULD have matched in this scope,
	// tallied in the same pass. Without them a breakdown row can only be
	// compared to the other rows, never to the archive it came from.
	pool := map[string]*tally{
		"series": newTally(), "region": newTally(), "country": newTally(),
		"city": newTally(), "speakers": newTally(),
	}
	poolEvents := map[string]bool{}

	for _, path := range files {
		raw, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		data, parseErr := js.ParseJSON(raw)
		if parseErr != nil {
			continue // a malformed dataset must not break the whole search
		}
		event := data.Get("event")
		if event == nil {
			event = js.Obj()
		}

		// Facet the EVENT once rather than every session inside it.
		designation := event.Get("designation").Str()
		regionCode := event.Get("regionCode").Str()
		country := event.Get("country").Str()
		year := YearText(event.Get("year"))
		if !wanted(options.Series, designation) || !wanted(options.Region, regionCode) ||
			!wanted(options.Country, country) || !wanted(options.Year, year) {
			continue
		}

		label := JoinNonEmpty(" ", designation, event.Get("location").Str(), year)
		file := path
		if index := strings.Index(filepath.ToSlash(path), "events/"); index >= 0 {
			file = filepath.ToSlash(path)[index:]
		}
		city := event.Get("location").Str()

		for _, item := range data.Get("items").Items() {
			// Lunch and morning tea are not search results. The dashboard has
			// always excluded them; search did not, so the same archive answered
			// "how many sessions" and "which sessions" differently.
			if !CountsAsSession(item) {
				continue
			}
			var speakerList []string
			for _, speaker := range item.Get("speakers").Items() {
				speakerList = append(speakerList, js.String(speaker))
			}
			speakers := strings.Join(speakerList, ", ")

			// Counted BEFORE the match test — this is the pool the search ran over.
			pool["series"].bump(designation)
			pool["region"].bump(regionCode)
			pool["country"].bump(country)
			pool["city"].bump(city)
			for _, name := range SpeakerNames(speakers) {
				pool["speakers"].bump(name)
			}
			poolEvents[label] = true

			video := js.Trim(jsOrEmpty(item.Get("video_url")))
			if options.HasVideo && video == "" {
				continue
			}

			// The event's own name is part of the haystack on the video view:
			// "barcelona" is a search someone will type, and it is the event
			// that has the place, not the session.
			haystack := jsOrEmpty(item.Get("title")) + " " +
				jsOrEmpty(item.Get("full_description")) + " " + speakers
			if options.HasVideo {
				haystack += " " + label
			}

			var matched []string
			if !browsing {
				for _, term := range terms {
					if MatchesTerm(haystack, term, mode) {
						matched = append(matched, term)
					}
				}
				if len(matched) == 0 {
					continue
				}
			}

			sessionYear := jsNumberOrZero(year)
			if sessionYear == 0 {
				sessionYear = jsNumberOrZero(FirstRunes(jsOrEmpty(item.Get("startTime")), 4))
			}

			track := ""
			if tracks := item.Get("track").Items(); len(tracks) > 0 {
				track = js.String(tracks[0])
			}

			matchedValue := js.Arr()
			for _, term := range matched {
				matchedValue.Append(js.Str(term))
			}
			title := jsOrEmpty(item.Get("title"))
			if title == "" {
				title = "Untitled session"
			}

			row := js.Obj().
				Set("matched", matchedValue).
				Set("title", js.Str(title)).
				Set("description", js.Str(jsOrEmpty(item.Get("full_description")))).
				Set("speakers", js.Str(speakers)).
				Set("track", js.Str(track)).
				Set("location", js.Str(jsOrEmpty(item.Get("location")))).
				Set("startTime", js.Str(jsOrEmpty(item.Get("startTime")))).
				Set("year", intOrNull(sessionYear)).
				Set("event", js.Str(label)).
				Set("series", js.Str(designation)).
				Set("region", js.Str(regionCode)).
				Set("country", js.Str(country)).
				Set("city", js.Str(city)).
				Set("file", js.Str(file)).
				Set("link", js.Str(jsOrEmpty(item.Get("link")))).
				Set("video", js.Str(video)).
				// For the video card: a recording's length is the session's.
				Set("minutes", js.Int(SessionMinutes(item)))

			results = append(results, searchResult{
				value: row, when: searchWhen(jsOrEmpty(item.Get("startTime")), sessionYear),
				title: title, year: sessionYear, matched: matched,
				series: designation, region: regionCode, country: country,
				city: city, speaker: speakers, event: label,
			})
		}
	}

	// Newest first, and genuinely chronological: by the session's own start
	// time, so an event's days and slots fall in order and the events cluster
	// without a separate sort.
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].when != results[j].when {
			return results[i].when > results[j].when
		}
		return js.LocaleCompare(results[i].title, results[j].title)
	})

	// Counted over EVERY match, before the page limit — a histogram built from
	// the returned slice would under-report the older years, which is exactly
	// the part of the trend people are looking at.
	byYear := js.Obj()
	byTerm := js.Obj()
	for _, term := range terms {
		byTerm.Set(term, js.Obj())
	}
	for _, result := range results {
		if result.year == 0 {
			continue
		}
		key := itoa(result.year)
		byYear.Set(key, js.Int(IntOf(byYear.Get(key))+1))
		// A session matching two terms counts once for each — the lines answer
		// "how much was X talked about", not "which bucket is this in".
		for _, term := range result.matched {
			scope := byTerm.Get(term)
			scope.Set(key, js.Int(IntOf(scope.Get(key))+1))
		}
	}

	hits := map[string]*tally{
		"series": newTally(), "region": newTally(), "country": newTally(),
		"city": newTally(), "speakers": newTally(),
	}
	hitEvents := map[string]bool{}
	minYear, maxYear, haveYear := 0, 0, false
	for _, result := range results {
		hits["series"].bump(result.series)
		hits["region"].bump(result.region)
		hits["country"].bump(result.country)
		hits["city"].bump(result.city)
		for _, name := range SpeakerNames(result.speaker) {
			hits["speakers"].bump(name)
		}
		hitEvents[result.event] = true
		if result.year != 0 {
			if !haveYear || result.year < minYear {
				minYear = result.year
			}
			if !haveYear || result.year > maxYear {
				maxYear = result.year
			}
			haveYear = true
		}
	}

	span := js.Null()
	if haveYear {
		span = js.Obj().Set("min", js.Int(minYear)).Set("max", js.Int(maxYear))
	}
	breakdown := js.Obj().
		Set("series", RankTally(hits["series"], pool["series"], 0)).
		Set("region", RankTally(hits["region"], pool["region"], 0)).
		Set("country", RankTally(hits["country"], pool["country"], 0)).
		Set("city", RankTally(hits["city"], pool["city"], 12)).
		Set("speakers", RankTally(hits["speakers"], pool["speakers"], 10)).
		Set("events", js.Int(len(hitEvents))).
		Set("eventsTotal", js.Int(len(poolEvents))).
		Set("span", span)

	page := js.Arr()
	for i := from; i < len(results) && i < from+options.Limit; i++ {
		page.Append(results[i].value)
	}
	termsValue := js.Arr()
	for _, term := range terms {
		termsValue.Append(js.Str(term))
	}

	return js.Obj().
		Set("query", js.Str(normalised)).
		Set("terms", termsValue).
		Set("mode", js.Str(mode)).
		Set("facets", js.Obj().
			Set("series", js.Str(options.Series)).
			Set("region", js.Str(options.Region)).
			Set("country", js.Str(options.Country)).
			Set("year", js.Str(options.Year))).
		Set("total", js.Int(len(results))).
		Set("offset", js.Int(from)).
		Set("byYear", byYear).
		Set("byTerm", byTerm).
		Set("breakdown", breakdown).
		Set("results", page), nil
}

// searchWhen places a session in time.
//
// Year-only sessions must sort AMONG their year, not above everything. The
// obvious fallback — year × 1e10 — produces a number an order of magnitude
// larger than any real epoch millisecond, so one dataset imported without times
// would silently take over the top of every search. Mid-year is the honest
// guess.
func searchWhen(startTime string, year int) float64 {
	if parsed, err := js.ParseDate(startTime); err == nil {
		return float64(parsed.UnixMilli())
	}
	if year != 0 {
		return float64(time.Date(year, time.June, 1, 0, 0, 0, 0, time.UTC).UnixMilli())
	}
	return 0
}

// searchDatasetFiles walks the events tree. Unlike the catalog's collector it
// keeps every .json, which is what the original does.
func searchDatasetFiles(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipAll
			}
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}
