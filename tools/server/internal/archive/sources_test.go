package archive

import (
	"encoding/json"
	"server/internal/js"
	ts "server/internal/testsupport"
	"testing"
)

// The Go half of the cross-language contract. The JS half is
// app/js/modules/__tests__/sourcesSummaryContract.test.js, reading the same
// file. Neither suite owns the rule; the fixture does.
type contractFile struct {
	Summaries []struct {
		Name     string          `json:"name"`
		Dataset  json.RawMessage `json:"dataset"`
		Expected struct {
			Count         int            `json:"count"`
			Kinds         map[string]int `json:"kinds"`
			KindOrder     []string       `json:"kindOrder"`
			Wayback       bool           `json:"wayback"`
			Stated        int            `json:"stated"`
			OldestCapture *string        `json:"oldestCapture"`
			RetrievedFrom *string        `json:"retrievedFrom"`
			RetrievedTo   *string        `json:"retrievedTo"`
		} `json:"expected"`
	} `json:"summaries"`
	WaybackTimestamps []struct {
		Input    string  `json:"input"`
		Expected *string `json:"expected"`
	} `json:"waybackTimestamps"`
}

func loadContract(t *testing.T) contractFile {
	t.Helper()
	raw := ts.ContractFixture(t, "sources-cases.json")
	var out contractFile
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func TestSummarizeSourcesAgainstTheSharedContract(t *testing.T) {
	contract := loadContract(t)
	if len(contract.Summaries) == 0 {
		t.Fatal("no cases in the fixture")
	}

	for _, testCase := range contract.Summaries {
		t.Run(testCase.Name, func(t *testing.T) {
			dataset, err := js.ParseJSON(testCase.Dataset)
			if err != nil {
				t.Fatal(err)
			}
			got := SummarizeSources(dataset)
			want := testCase.Expected

			if got.Count != want.Count {
				t.Errorf("count = %d, want %d", got.Count, want.Count)
			}
			if got.Wayback != want.Wayback {
				t.Errorf("wayback = %v, want %v", got.Wayback, want.Wayback)
			}
			if got.Stated != want.Stated {
				t.Errorf("stated = %d, want %d", got.Stated, want.Stated)
			}
			if got.OldestCapture != orEmpty(want.OldestCapture) {
				t.Errorf("oldestCapture = %q, want %q", got.OldestCapture, orEmpty(want.OldestCapture))
			}
			if got.RetrievedFrom != orEmpty(want.RetrievedFrom) {
				t.Errorf("retrievedFrom = %q, want %q", got.RetrievedFrom, orEmpty(want.RetrievedFrom))
			}
			if got.RetrievedTo != orEmpty(want.RetrievedTo) {
				t.Errorf("retrievedTo = %q, want %q", got.RetrievedTo, orEmpty(want.RetrievedTo))
			}
			if len(got.Kinds) != len(want.Kinds) {
				t.Errorf("kinds = %v, want %v", got.Kinds, want.Kinds)
			}
			for kind, count := range want.Kinds {
				if got.Kinds[kind] != count {
					t.Errorf("kinds[%q] = %d, want %d", kind, got.Kinds[kind], count)
				}
			}
			// Order is part of the contract: catalog.json carries `kinds` in
			// first-seen order, and a Go map ranged over would emit it in a
			// different one on every run.
			if want.KindOrder != nil {
				if len(got.KindOrder) != len(want.KindOrder) {
					t.Fatalf("kind order = %v, want %v", got.KindOrder, want.KindOrder)
				}
				for i, kind := range want.KindOrder {
					if got.KindOrder[i] != kind {
						t.Errorf("kind order = %v, want %v", got.KindOrder, want.KindOrder)
						break
					}
				}
			}
		})
	}
}

func TestWaybackTimestampToISOAgainstTheSharedContract(t *testing.T) {
	for _, testCase := range loadContract(t).WaybackTimestamps {
		if got := WaybackTimestampToISO(testCase.Input); got != orEmpty(testCase.Expected) {
			t.Errorf("WaybackTimestampToISO(%q) = %q, want %q",
				testCase.Input, got, orEmpty(testCase.Expected))
		}
	}
}

func TestSummaryValueKeyOrderMatchesTheCatalog(t *testing.T) {
	dataset, err := js.ParseJSON([]byte(`{"event":{"sources":[
		{"kind":"schedule","retrievedAt":"2026-01-01"},
		{"kind":"video","via":{"provider":"wayback","timestamp":"20130826155852"}}
	]}}`))
	if err != nil {
		t.Fatal(err)
	}
	got := string(SummarizeSources(dataset).Value().Encode("  "))
	want := `{
  "count": 2,
  "kinds": {
    "schedule": 1,
    "video": 1
  },
  "wayback": true,
  "stated": 0,
  "oldestCapture": "2013-08-26",
  "retrievedFrom": "2026-01-01",
  "retrievedTo": "2026-01-01"
}`
	if got != want {
		t.Errorf("got:\n%s\nwant:\n%s", got, want)
	}
}

// The three functions provenanceSummary() leans on, added to the same contract.
type sourcesExtras struct {
	Confidence []struct {
		Source json.RawMessage `json:"source"`
		Tier   string          `json:"tier"`
		Why    string          `json:"why"`
	} `json:"confidence"`
	Attribution []struct {
		Record   json.RawMessage `json:"record"`
		Sources  json.RawMessage `json:"sources"`
		Strength string          `json:"strength"`
		Why      string          `json:"why"`
	} `json:"attribution"`
	Reach struct {
		Dataset  json.RawMessage `json:"dataset"`
		Expected map[string]int  `json:"expected"`
	} `json:"reach"`
}

func loadExtras(t *testing.T) sourcesExtras {
	t.Helper()
	raw := ts.ContractFixture(t, "sources-cases.json")
	var out sourcesExtras
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSourceConfidenceAgainstTheSharedContract(t *testing.T) {
	extras := loadExtras(t)
	if len(extras.Confidence) == 0 {
		t.Fatal("no confidence cases in the fixture")
	}
	for _, testCase := range extras.Confidence {
		source, err := js.ParseJSON(testCase.Source)
		if err != nil {
			t.Fatal(err)
		}
		if got := SourceConfidence(source); got != testCase.Tier {
			t.Errorf("SourceConfidence(%s) = %q, want %q — %s",
				testCase.Source, got, testCase.Tier, testCase.Why)
		}
	}
}

func TestAttributionStrengthAgainstTheSharedContract(t *testing.T) {
	extras := loadExtras(t)
	if len(extras.Attribution) == 0 {
		t.Fatal("no attribution cases in the fixture")
	}
	for _, testCase := range extras.Attribution {
		record, err := js.ParseJSON(testCase.Record)
		if err != nil {
			t.Fatal(err)
		}
		sources, err := js.ParseJSON(testCase.Sources)
		if err != nil {
			t.Fatal(err)
		}
		byID := map[string]*js.Value{}
		for _, source := range sources.Items() {
			byID[source.Get("id").Str()] = source
		}
		if got := AttributionStrength(record, byID); got != testCase.Strength {
			t.Errorf("AttributionStrength(%s) = %q, want %q — %s",
				testCase.Record, got, testCase.Strength, testCase.Why)
		}
	}
}

func TestSourceReachAgainstTheSharedContract(t *testing.T) {
	extras := loadExtras(t)
	dataset, err := js.ParseJSON(extras.Reach.Dataset)
	if err != nil {
		t.Fatal(err)
	}
	got := SourceReach(dataset)
	if len(got) != len(extras.Reach.Expected) {
		t.Fatalf("reach = %v, want %v", got, extras.Reach.Expected)
	}
	for id, want := range extras.Reach.Expected {
		if got[id] != want {
			t.Errorf("reach[%q] = %d, want %d", id, got[id], want)
		}
	}
}
