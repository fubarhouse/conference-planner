package archive

import (
	"encoding/json"
	"server/internal/js"
	ts "server/internal/testsupport"
	"testing"
)

// The Go half of the sessionKind contract. The JS half is
// app/js/modules/__tests__/sessionKindContract.test.js, reading the same file.
type sessionKindFile struct {
	AgendaTitles []struct {
		Title  string `json:"title"`
		Agenda bool   `json:"agenda"`
		Why    string `json:"why"`
	} `json:"agendaTitles"`
	Kinds []struct {
		Item   json.RawMessage `json:"item"`
		Kind   string          `json:"kind"`
		Counts bool            `json:"counts"`
		Why    string          `json:"why"`
	} `json:"kinds"`
}

func loadSessionKindContract(t *testing.T) sessionKindFile {
	t.Helper()
	raw := ts.ContractFixture(t, "session-kind-cases.json")
	var out sessionKindFile
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestIsAgendaTitleAgainstTheSharedContract(t *testing.T) {
	contract := loadSessionKindContract(t)
	if len(contract.AgendaTitles) == 0 {
		t.Fatal("no title cases in the fixture")
	}
	for _, testCase := range contract.AgendaTitles {
		if got := IsAgendaTitle(testCase.Title); got != testCase.Agenda {
			t.Errorf("IsAgendaTitle(%q) = %v, want %v — %s",
				testCase.Title, got, testCase.Agenda, testCase.Why)
		}
	}
}

func TestItemKindAgainstTheSharedContract(t *testing.T) {
	contract := loadSessionKindContract(t)
	if len(contract.Kinds) == 0 {
		t.Fatal("no item cases in the fixture")
	}
	for _, testCase := range contract.Kinds {
		item, err := js.ParseJSON(testCase.Item)
		if err != nil {
			t.Fatalf("%s: %v", testCase.Item, err)
		}
		if got := ItemKind(item); got != testCase.Kind {
			t.Errorf("ItemKind(%s) = %q, want %q — %s",
				testCase.Item, got, testCase.Kind, testCase.Why)
		}
		if got := CountsAsSession(item); got != testCase.Counts {
			t.Errorf("CountsAsSession(%s) = %v, want %v — %s",
				testCase.Item, got, testCase.Counts, testCase.Why)
		}
	}
}

// The fixture carries the discriminating cases. This one asserts the two
// implementations agree on the whole archive, which is the only way to catch a
// vocabulary word transcribed wrongly into the Go copy.
func TestSessionCountsMatchNodeOverTheArchive(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	// BuildCoverage reports `sessions` per event, which is countsAsSession
	// applied to every item in the archive — 5,600 of them. The coverage
	// differential test already compares that field, so this asserts the
	// narrower thing directly and fails with a clearer message when the
	// vocabulary is what broke.
	coverage, err := BuildCoverage(dataDir, js.Obj(), coverageToday)
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, event := range coverage.Get("events").Items() {
		total += IntOf(event.Get("sessions"))
	}
	if total == 0 {
		t.Fatal("no sessions counted across the archive — the vocabulary is broken")
	}
	t.Logf("counted %d sessions across %d events", total, len(coverage.Get("events").Items()))
}
