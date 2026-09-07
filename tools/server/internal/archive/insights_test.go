package archive

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	ts "server/internal/testsupport"
	"strconv"
	"strings"
	"testing"
)

// These helpers have no fixture and need none: the archive itself is the
// fixture. Every title, every region string and every duration in it goes
// through both implementations and the results are compared. 7,891 sessions is
// a better test of a 270-word stoplist than any hand-written case list.

type helperResults struct {
	Tokens   [][]string `json:"tokens"`
	Bigrams  [][]string `json:"bigrams"`
	Regions  []string   `json:"regions"`
	Derived  []string   `json:"derived"`
	Country  []string   `json:"country"`
	Minutes  []int      `json:"minutes"`
	Buckets  []string   `json:"buckets"`
	Coords   []string   `json:"coords"`
	Topics   string     `json:"topics"`
	Titles   []string   `json:"titles"`
	Regional []string   `json:"regional"`
}

// nodeHelpers runs the JavaScript originals over the whole archive and returns
// their answers.
func nodeHelpers(t *testing.T, dataDir string) (helperResults, bool) {
	t.Helper()
	root := ts.RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "lib", "archiveInsights.js")); err != nil {
		return helperResults{}, false
	}
	if _, err := exec.LookPath("node"); err != nil {
		return helperResults{}, false
	}

	script := `
		import { readFile, readdir } from 'node:fs/promises';
		import { join } from 'node:path';
		import {
			titleTokens, titleBigrams, buildTopics, deriveRegion, deriveCountry,
			lengthBucket, sessionMinutes,
		} from './scripts/lib/archiveInsights.js';

		const dataDir = process.argv[1];
		async function walk(dir, out = []) {
			for (const e of await readdir(dir, { withFileTypes: true })) {
				const p = join(dir, e.name);
				if (e.isDirectory()) await walk(p, out);
				else if (e.name.endsWith('.json')) out.push(p);
			}
			return out;
		}
		const files = (await walk(join(dataDir, 'events'))).sort();
		let geo = {};
		try { geo = JSON.parse(await readFile(join(dataDir, 'geocache.json'), 'utf8')); } catch {}

		const out = {
			tokens: [], bigrams: [], regions: [], derived: [], country: [],
			minutes: [], buckets: [], coords: [], titles: [], regional: [],
		};
		const topicInput = [];
		for (const path of files) {
			let data;
			try { data = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
			const ev = data.event || {};
			out.derived.push(deriveRegion(ev));
			out.regional.push(String(ev.region || ''));
			out.country.push(deriveCountry(ev.region, geo?.[String(ev.location || '').trim()]?.display));
			const year = Number(String(ev.startDate || '').slice(0, 4)) || 0;
			for (const item of data.items || []) {
				const title = String(item.title || '');
				out.titles.push(title);
				out.tokens.push(titleTokens(title));
				out.bigrams.push(titleBigrams(title));
				const mins = sessionMinutes(item);
				out.minutes.push(mins);
				out.buckets.push(lengthBucket(mins));
				topicInput.push({ text: title + ' ' + String(item.full_description || ''), year });
			}
		}
		out.topics = JSON.stringify(buildTopics(topicInput, 24));
		process.stdout.write(JSON.stringify(out));
	`
	cmd := exec.Command("node", "--input-type=module", "--eval", script, dataDir)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if asExitError(err, &exit) {
			t.Fatalf("node helpers failed: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		t.Fatalf("node helpers failed: %v", err)
	}
	var parsed helperResults
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	return parsed, true
}

func TestClassificationHelpersMatchNodeOverTheArchive(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}
	want, ok := nodeHelpers(t, dataDir)
	if !ok {
		t.Skip("node or lib/archiveInsights.js unavailable")
	}

	files, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		t.Fatal(err)
	}
	geo := js.Obj()
	if raw, err := os.ReadFile(filepath.Join(dataDir, "geocache.json")); err == nil {
		if parsed, err := js.ParseJSON(raw); err == nil {
			geo = parsed
		}
	}

	var got helperResults
	var topicInput []TopicSession
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		event := data.Get("event")
		if event == nil {
			event = js.Obj()
		}
		got.Derived = append(got.Derived, DeriveRegion(event))
		got.Regional = append(got.Regional, event.Get("region").Str())
		display := geo.Get(strings.TrimSpace(event.Get("location").Str())).Get("display").Str()
		got.Country = append(got.Country, DeriveCountry(event.Get("region").Str(), display))

		year := jsNumberOrZero(FirstRunes(event.Get("startDate").Str(), 4))
		for _, item := range data.Get("items").Items() {
			title := item.Get("title").Str()
			got.Titles = append(got.Titles, title)
			got.Tokens = append(got.Tokens, TitleTokens(title))
			got.Bigrams = append(got.Bigrams, TitleBigrams(title))
			minutes := SessionMinutes(item)
			got.Minutes = append(got.Minutes, minutes)
			got.Buckets = append(got.Buckets, LengthBucket(minutes))
			topicInput = append(topicInput, TopicSession{
				Text: title + " " + item.Get("full_description").Str(),
				Year: year,
			})
		}
	}

	if len(got.Titles) != len(want.Titles) {
		t.Fatalf("walked %d items, node walked %d — the two are not looking at the same archive",
			len(got.Titles), len(want.Titles))
	}

	mismatches := 0
	report := func(what string, index int, gotValue, wantValue any) {
		mismatches++
		if mismatches <= 10 {
			context := ""
			if index < len(want.Titles) {
				context = want.Titles[index]
			}
			t.Errorf("%s[%d] for %q:\n  go:   %v\n  node: %v", what, index, context, gotValue, wantValue)
		}
	}

	for i := range want.Tokens {
		if !equalStrings(got.Tokens[i], want.Tokens[i]) {
			report("tokens", i, got.Tokens[i], want.Tokens[i])
		}
		if !equalStrings(got.Bigrams[i], want.Bigrams[i]) {
			report("bigrams", i, got.Bigrams[i], want.Bigrams[i])
		}
		if got.Minutes[i] != want.Minutes[i] {
			report("minutes", i, got.Minutes[i], want.Minutes[i])
		}
		if got.Buckets[i] != want.Buckets[i] {
			report("bucket", i, got.Buckets[i], want.Buckets[i])
		}
	}
	for i := range want.Derived {
		if got.Derived[i] != want.Derived[i] {
			t.Errorf("deriveRegion[%d] for region %q: go %q, node %q",
				i, want.Regional[i], got.Derived[i], want.Derived[i])
		}
		if got.Country[i] != want.Country[i] {
			t.Errorf("deriveCountry[%d] for region %q: go %q, node %q",
				i, want.Regional[i], got.Country[i], want.Country[i])
		}
	}
	if mismatches > 10 {
		t.Errorf("… and %d more mismatches", mismatches-10)
	}

	// The vocabulary itself: the top 24 terms over every title and description
	// in the archive, with their per-year counts.
	topics := BuildTopics(topicInput, 24)
	gotTopics := topicsJSON(topics)
	if gotTopics != want.Topics {
		t.Errorf("buildTopics differs:\n  go:   %s\n  node: %s", gotTopics, want.Topics)
	}

	t.Logf("matched %d titles, %d events, and the top-24 vocabulary",
		len(want.Titles), len(want.Derived))
}

// topicsJSON renders the topic list the way JSON.stringify does, so the two can
// be compared as text — including byYear key order, which is insertion order on
// both sides.
func topicsJSON(topics []Topic) string {
	list := js.Arr()
	for _, topic := range topics {
		byYear := js.Obj()
		for _, year := range topic.YearOrder {
			byYear.Set(strconv.Itoa(year), js.Int(topic.ByYear[year]))
		}
		list.Append(js.Obj().
			Set("term", js.Str(topic.Term)).
			Set("total", js.Int(topic.Total)).
			Set("byYear", byYear))
	}
	return string(list.Encode(""))
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLengthBucketBoundaries(t *testing.T) {
	cases := []struct {
		minutes int
		want    string
	}{
		{0, ""}, {-5, ""},
		{20, "lightning"}, {21, "half"},
		{35, "half"}, {36, "short"},
		// A 50-minute talk belongs with the 45s, not with the hours.
		{50, "short"}, {51, "hour"},
		{70, "hour"}, {71, "workshop"},
		{120, "workshop"}, {121, "day"},
		{600, "day"},
	}
	for _, testCase := range cases {
		if got := LengthBucket(testCase.minutes); got != testCase.want {
			t.Errorf("LengthBucket(%d) = %q, want %q", testCase.minutes, got, testCase.want)
		}
	}
}

func TestRegionOfPrefersAuthoredCodeButRejectsLegacyOnes(t *testing.T) {
	parse := func(body string) *js.Value {
		value, err := js.ParseJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := RegionOf(parse(`{"regionCode":"apac","region":"Germany"}`)); got != "APAC" {
		t.Errorf("an authored code wins and is upper-cased: %q", got)
	}
	// A legacy EUR/MEA is not a valid code any more, so it re-derives.
	if got := RegionOf(parse(`{"regionCode":"EUR","region":"Germany"}`)); got != "EMEA" {
		t.Errorf("legacy code should re-derive to EMEA, got %q", got)
	}
	// Placeless events fall back to the organising community's home region.
	if got := RegionOf(parse(`{"region":"Online","designation":"DrupalSouth"}`)); got != "APAC" {
		t.Errorf("placeless DrupalSouth should be APAC, got %q", got)
	}
	if got := RegionOf(parse(`{"region":"Latin America"}`)); got != "LATAM" {
		t.Errorf("LATAM must be tested before AMER, got %q", got)
	}
}

func TestCoordsForSkipsPlacelessEvents(t *testing.T) {
	geo, err := js.ParseJSON([]byte(`{"Online":{"lat":1,"lon":2},"Munich":{"lat":48.1,"lon":11.5}}`))
	if err != nil {
		t.Fatal(err)
	}
	parse := func(body string) *js.Value {
		value, err := js.ParseJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := CoordsFor(parse(`{"location":"Online"}`), geo); got != nil {
		t.Errorf("a placeless event must never be mapped, got %+v", got)
	}
	if got := CoordsFor(parse(`{"location":"Munich"}`), geo); got == nil || got.Lat != 48.1 {
		t.Errorf("geocache miss: %+v", got)
	}
	if got := CoordsFor(parse(`{"location":"Munich","latitude":1,"longitude":2}`), geo); got.Lat != 1 {
		t.Errorf("the dataset's own coordinates win: %+v", got)
	}
}
