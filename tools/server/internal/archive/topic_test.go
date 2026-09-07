package archive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strconv"
	"strings"
	"testing"
)

// The chart plots a term over twenty years, so the boundary rule is the answer,
// not a detail of it: "ai" inside "maintain" would draw a line about nothing.
func TestTermPatternMatchesNode(t *testing.T) {
	type probe struct{ term, text string }
	probes := []probe{
		{"ai", "AI in Drupal"},
		{"ai", "how to maintain a site"},
		{"ai", "send an email"},
		{"ai", "Ai"},
		{"layout builder", "Layout-Builder deep dive"},
		{"layout builder", "layout  builder"},
		{"layout builder", "layoutbuilder"},
		{"c++", "writing c++ bindings"},
		{"c#", "c# for the web"},
		{"drupal", "DrupalCon"},
		{"drupal", "Drupal 11"},
		// The accent case that forced Unicode classes: under ASCII, "gábor"
		// compiled to "g" + separator + "bor" and matched "g bor" too.
		{"gábor", "a talk by Gábor Hojtsy"},
		{"gábor", "g bor"},
		{"café", "caf"},
		{"café", "the café track"},
		{"", "anything at all"},
		{"   ", "anything at all"},
		{"...", "anything at all"},
		{"a.b", "a.b"},
		{"a.b", "a b"},
	}

	payload := js.Arr()
	for _, p := range probes {
		payload.Append(js.Obj().Set("term", js.Str(p.term)).Set("text", js.Str(p.text)))
	}
	out := ts.RunNode(t, nil, `
		const { termPattern } = await import('./scripts/lib/archiveInsights.js');
		const probes = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(probes.map(({ term, text }) => {
			const re = termPattern(term);
			return re ? re.test(String(text).toLowerCase()) : null;
		})));
	`, string(payload.Encode("")))

	var want []*bool
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, p := range probes {
		pattern := TermPattern(p.term)
		if want[i] == nil {
			if pattern != nil {
				t.Errorf("TermPattern(%q) compiled, node returned null", p.term)
			}
			continue
		}
		if pattern == nil {
			t.Errorf("TermPattern(%q) = nil, node compiled a pattern", p.term)
			continue
		}
		got := matchesTermPattern(pattern, strings.ToLower(p.text))
		if got != *want[i] {
			t.Errorf("term %q against %q = %v, node = %v", p.term, p.text, got, *want[i])
		}
	}
}

// The whole topic answer, over the real archive, compared byte for byte.
func TestSearchTopicMatchesNode(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}
	private := t.TempDir()

	cases := []struct {
		name   string
		term   string
		facets Facets
		year   *int
	}{
		{"a common term", "drupal", DefaultFacets(), nil},
		{"a phrase", "layout builder", DefaultFacets(), nil},
		{"a term nothing matches", "zzzznotathing", DefaultFacets(), nil},
		{"an empty term", "", DefaultFacets(), nil},
		{"scoped to a series", "accessibility", Facets{"DrupalCon", "All", "All"}, nil},
		{"scoped to a region", "ai", Facets{"All", "Europe", "All"}, nil},
		{"the year drill", "performance", DefaultFacets(), intPtr(2024)},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := SearchTopic(dataDir, testCase.term, testCase.facets,
				testCase.year, LoadDecisions(private))
			if err != nil {
				t.Fatal(err)
			}
			yearArg := "null"
			if testCase.year != nil {
				yearArg = strconv.Itoa(*testCase.year)
			}
			want := ts.RunNode(t, []string{"PRIVATE_ROOT=" + private}, `
				const { searchTopic } = await import('./scripts/lib/archiveInsights.js');
				const [dataDir, term, series, region, country, year] = process.argv.slice(1);
				const out = await searchTopic(dataDir, term, series, region, country,
					{ year: year === 'null' ? null : Number(year) });
				process.stdout.write(JSON.stringify(out, null, 2));
			`, dataDir, testCase.term, testCase.facets.Series, testCase.facets.Region,
				testCase.facets.Country, yearArg)

			if string(got.Encode("  ")) != want {
				t.Errorf("topic %q differs:\n%s", testCase.term,
					ts.FirstDifference(string(got.Encode("  ")), want))
			}
		})
	}
}

// Co-speakers, over the real archive, including a name that appears nowhere.
func TestCoSpeakersMatchesNode(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	private := t.TempDir()

	// Pick a name the archive actually has, so the comparison is not two empty
	// answers agreeing with each other.
	name := busiestSpeaker(t, dataDir)
	if name == "" {
		t.Skip("no multi-speaker sessions in this archive")
	}
	t.Logf("comparing co-speakers for %q", name)

	for _, testCase := range []struct {
		label  string
		name   string
		facets Facets
	}{
		{"a real name", name, DefaultFacets()},
		{"a name nobody has", "Nobody At All", DefaultFacets()},
		{"an empty name", "", DefaultFacets()},
		{"scoped to a region", name, Facets{"All", "Europe", "All"}},
	} {
		t.Run(testCase.label, func(t *testing.T) {
			got, err := CoSpeakers(dataDir, testCase.name, testCase.facets, LoadDecisions(private))
			if err != nil {
				t.Fatal(err)
			}
			want := ts.RunNode(t, []string{"PRIVATE_ROOT=" + private}, `
				const { coSpeakers } = await import('./scripts/lib/archiveInsights.js');
				const [dataDir, name, series, region, country] = process.argv.slice(1);
				const out = await coSpeakers(dataDir, name, { series, region, country });
				process.stdout.write(JSON.stringify(out, null, 2));
			`, dataDir, testCase.name, testCase.facets.Series, testCase.facets.Region,
				testCase.facets.Country)

			if string(got.Encode("  ")) != want {
				t.Errorf("differs:\n%s", ts.FirstDifference(string(got.Encode("  ")), want))
			}
		})
	}
}

// busiestSpeaker finds a name that shares sessions, so the comparison has
// something to compare.
func busiestSpeaker(t *testing.T, dataDir string) string {
	t.Helper()
	counts := map[string]int{}
	best, bestCount := "", 0
	_ = eachCatalogEvent(dataDir, func(_ string, data *js.Value) {
		for _, item := range data.Get("items").Items() {
			if !CountsAsSession(item) {
				continue
			}
			speakers := item.Get("speakers").Items()
			if len(speakers) < 2 {
				continue
			}
			for _, speaker := range speakers {
				name := js.Trim(speaker.StrVal())
				if name == "" {
					continue
				}
				counts[name]++
				if counts[name] > bestCount || (counts[name] == bestCount && name < best) {
					best, bestCount = name, counts[name]
				}
			}
		}
	})
	return best
}

// An alias must move a co-speaker's name, because that is the whole point of the
// reconciliation desk: two spellings are one person.
func TestCoSpeakersAppliesAliases(t *testing.T) {
	dataDir := t.TempDir()
	writeJSON := func(name string, body string) {
		full := filepath.Join(dataDir, name)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeJSON("catalog.json", `{"events":[{"file":"events/e.json"}]}`)
	writeJSON("events/e.json", `{
		"event": {"designation":"DrupalCamp","location":"Somewhere","year":2024},
		"items": [
			{"title":"A talk","speakers":["gábor hojtsy","Angie Byron"]},
			{"title":"Another","speakers":["Gábor Hojtsy","Angie Byron"]}
		]
	}`)

	// Without the alias the two spellings are two different partners.
	plain, err := CoSpeakers(dataDir, "Angie Byron", DefaultFacets(),
		Decisions{Aliases: js.Obj(), Series: js.Obj(), Snoozes: js.Obj()})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(plain.Get("partners").Items()); got != 2 {
		t.Errorf("unaliased partners = %d, want 2: %s", got, plain.Encode(""))
	}

	// With it, they are one person with two sessions.
	aliases := js.Obj().Set(Fingerprint("gábor hojtsy"), js.Str("Gábor Hojtsy"))
	merged, err := CoSpeakers(dataDir, "Angie Byron", DefaultFacets(),
		Decisions{Aliases: aliases, Series: js.Obj(), Snoozes: js.Obj()})
	if err != nil {
		t.Fatal(err)
	}
	partners := merged.Get("partners").Items()
	if len(partners) != 1 {
		t.Fatalf("aliased partners = %d, want 1: %s", len(partners), merged.Encode(""))
	}
	if name := partners[0].Get("name").Str(); name != "Gábor Hojtsy" {
		t.Errorf("partner name = %q", name)
	}
	if count, _ := partners[0].Get("count").Number(); count != 2 {
		t.Errorf("partner count = %v, want 2", count)
	}
}

func intPtr(v int) *int { return &v }
