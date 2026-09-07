package archive

import (
	"encoding/json"
	"testing"

	ts "server/internal/testsupport"
)

// nodeSearch runs the JavaScript search with the same query and options.
func nodeSearch(t *testing.T, dataDir, query string, options SearchOptions) string {
	t.Helper()
	optionsJSON, err := json.Marshal(map[string]any{
		"limit": options.Limit, "offset": options.Offset, "mode": options.Mode,
		"series": options.Series, "region": options.Region,
		"country": options.Country, "year": options.Year, "hasVideo": options.HasVideo,
	})
	if err != nil {
		t.Fatal(err)
	}
	return ts.RunNode(t, nil, `
		import { searchSessions } from './lib/archiveSessions.js';
		const [dataDir, query, options] = process.argv.slice(1);
		const result = await searchSessions(dataDir, query, JSON.parse(options));
		process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	`, dataDir, query, string(optionsJSON))
}

// Search is the most-used read path in the archive, and its trend chart, its
// breakdown rail and its paging all read from the same answer. Every query
// below is compared whole.
func TestSearchIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}

	cases := []struct {
		name    string
		query   string
		options func(SearchOptions) SearchOptions
	}{
		{name: "a common term", query: "layout builder"},
		{name: "a two-letter term, whole words", query: "ai"},
		{name: "the same term as a substring", query: "ai",
			options: func(o SearchOptions) SearchOptions { o.Mode = "contains"; return o }},
		{name: "two terms, which mean OR", query: "views, paragraphs"},
		{name: "a term with an accent", query: "café"},
		{name: "a speaker's name", query: "hojtsy"},
		// ⚠ NOT NODE PARITY ANY MORE. Node answered an empty query with an empty
		// result set; this now browses, so that clearing the search box returns
		// you to "everything in this scope" instead of a dead end. Its recording
		// was re-made from Go and is a recorded answer, not a parity check.
		// Every other case below is still what Node said.
		{name: "nothing at all", query: ""},
		// Still parity, and the guard on the case above: a single letter is
		// below the term threshold and yields no terms either, but the reader
		// typed it — so it must NOT browse.
		{name: "one letter, which is below the threshold", query: "a"},
		{name: "no matches anywhere", query: "zzzzqqqq"},
		{name: "paged", query: "drupal",
			options: func(o SearchOptions) SearchOptions { o.Offset = 50; o.Limit = 10; return o }},
		{name: "scoped to a series", query: "accessibility",
			options: func(o SearchOptions) SearchOptions { o.Series = "DrupalCon"; return o }},
		{name: "scoped to a region", query: "testing",
			options: func(o SearchOptions) SearchOptions { o.Region = "EMEA"; return o }},
		{name: "scoped to a year", query: "performance",
			options: func(o SearchOptions) SearchOptions { o.Year = "2024"; return o }},
		{name: "browsing the recordings", query: "",
			options: func(o SearchOptions) SearchOptions { o.HasVideo = true; o.Limit = 25; return o }},
		{name: "searching the recordings", query: "barcelona",
			options: func(o SearchOptions) SearchOptions { o.HasVideo = true; return o }},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			options := DefaultSearchOptions()
			if testCase.options != nil {
				options = testCase.options(options)
			}

			want := nodeSearch(t, dataDir, testCase.query, options)
			got, err := SearchSessions(dataDir, testCase.query, options)
			if err != nil {
				t.Fatal(err)
			}
			gotText := string(append(got.Encode("  "), '\n'))

			if gotText != want {
				ts.WriteArtefacts(t, []byte(gotText), []byte(want))
				t.Fatalf("results differ\n%s", ts.FirstDifference(gotText, want))
			}
			t.Logf("%d matches", IntOf(got.Get("total")))
		})
	}
}

// The two matching modes are the whole reason `mode` exists, and the bug that
// produced it: "ai" reaching inside "maintain" returned 2,810 sessions of which
// a handful were about AI.
func TestMatchesTerm(t *testing.T) {
	const haystack = "Maintaining available email systems with AI, naturally"

	if !MatchesTerm(haystack, "ai", "exact") {
		t.Error("the standalone word should match in exact mode")
	}
	if MatchesTerm("Maintaining available email systems", "ai", "exact") {
		t.Error("exact mode must not reach inside maintain, available or email")
	}
	if !MatchesTerm("Maintaining available email systems", "ai", "contains") {
		t.Error("contains mode should reach inside — that is what it is for")
	}
	// A phrase behaves the way a reader expects under both.
	if !MatchesTerm("All about the display suite module", "display suite", "exact") {
		t.Error("a phrase should match on word boundaries")
	}
	// Punctuation is a boundary, so a trailing comma does not hide a word.
	if !MatchesTerm("about AI, naturally", "ai", "exact") {
		t.Error("punctuation should not hide a word")
	}
	// A real limitation of whole-word matching, shared by both implementations
	// and worth knowing about: \p{L} matches CJK characters, so "導入の事例" is
	// ONE word with no boundaries inside it, and a term that is part of it
	// cannot match in exact mode. Japanese titles are effectively
	// contains-only. Asserted because it is the behaviour, not because it is
	// desirable — changing it is a product decision, not a port decision.
	if MatchesTerm("Drupal 導入の事例", "導入", "exact") {
		t.Error("exact mode cannot see inside a run of CJK — if this now passes, the rule changed")
	}
	if !MatchesTerm("Drupal 導入の事例", "導入", "contains") {
		t.Error("contains mode should still find it")
	}
	if MatchesTerm("anything", "", "exact") {
		t.Error("an empty term should match nothing")
	}
}

func TestSpeakerNames(t *testing.T) {
	got := SpeakerNames("  Gábor Hojtsy , Kim Pepper ,, ")
	if len(got) != 2 || got[0] != "Gábor Hojtsy" || got[1] != "Kim Pepper" {
		t.Errorf("SpeakerNames = %#v", got)
	}
	if len(SpeakerNames("")) != 0 {
		t.Error("an empty list should split to nothing")
	}
}

// A year-only session must sort among its year rather than above everything —
// the `year * 1e10` trap the original comment describes.
func TestSearchWhenPlacesYearOnlySessionsMidYear(t *testing.T) {
	timed := searchWhen("2024-03-15T09:00:00Z", 2024)
	yearOnly := searchWhen("", 2024)
	laterYear := searchWhen("", 2025)

	if yearOnly <= 0 {
		t.Fatal("a year-only session should still be placed")
	}
	if yearOnly > laterYear {
		t.Error("2024 should sort below 2025")
	}
	// Mid-year, so it lands among its own year's timed sessions rather than
	// above every one of them.
	if yearOnly < timed {
		t.Log("March 2024 sorts above mid-2024, as expected")
	}
	if searchWhen("", 0) != 0 {
		t.Error("a session with neither should sort last")
	}
}

// An empty box and an unusable query both produce zero terms, and they must not
// behave alike: clearing the search is a request to see everything in scope,
// while a single letter is something the reader typed and meant.
func TestEmptyQueryBrowsesButAShortOneDoesNot(t *testing.T) {
	dataDir := ts.ArchiveDir(t)

	browse, err := SearchSessions(dataDir, "", DefaultSearchOptions())
	if err != nil {
		t.Fatal(err)
	}
	if IntOf(browse.Get("total")) == 0 {
		t.Fatal("an empty query returned nothing; clearing the search box would be a dead end")
	}

	// Below the two-rune term threshold, so also no terms — but not a browse.
	short, err := SearchSessions(dataDir, "a", DefaultSearchOptions())
	if err != nil {
		t.Fatal(err)
	}
	if IntOf(short.Get("total")) != 0 {
		t.Fatalf("a one-letter query returned %d results; it must not be read as “show me everything”",
			IntOf(short.Get("total")))
	}

	// Whitespace is an empty box that has been typed in, not a query.
	spaces, err := SearchSessions(dataDir, "   ", DefaultSearchOptions())
	if err != nil {
		t.Fatal(err)
	}
	if IntOf(spaces.Get("total")) != IntOf(browse.Get("total")) {
		t.Fatalf("whitespace gave %d, empty gave %d", IntOf(spaces.Get("total")), IntOf(browse.Get("total")))
	}
}

// Browsing still obeys the facets — it is a listing of the current scope, not a
// dump of the archive.
func TestBrowsingRespectsTheFacets(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	all, err := SearchSessions(dataDir, "", DefaultSearchOptions())
	if err != nil {
		t.Fatal(err)
	}
	options := DefaultSearchOptions()
	options.Series = "DrupalCon"
	scoped, err := SearchSessions(dataDir, "", options)
	if err != nil {
		t.Fatal(err)
	}
	if IntOf(scoped.Get("total")) == 0 {
		t.Fatal("browsing a series returned nothing")
	}
	if IntOf(scoped.Get("total")) >= IntOf(all.Get("total")) {
		t.Fatalf("the series filter did not narrow the browse: %d vs %d",
			IntOf(scoped.Get("total")), IntOf(all.Get("total")))
	}
}
