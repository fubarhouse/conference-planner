package archive

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

type identityFile struct {
	Cases []struct {
		Input       string `json:"input"`
		NormName    string `json:"normName"`
		Fingerprint string `json:"fingerprint"`
		Why         string `json:"why"`
	} `json:"cases"`
}

func TestIdentityAgainstTheSharedContract(t *testing.T) {
	raw := ts.ContractFixture(t, "identity-cases.json")
	var contract identityFile
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	if len(contract.Cases) == 0 {
		t.Fatal("no cases in the fixture")
	}

	for _, testCase := range contract.Cases {
		if got := NormName(testCase.Input); got != testCase.NormName {
			t.Errorf("NormName(%q) = %q, want %q — %s",
				testCase.Input, got, testCase.NormName, testCase.Why)
		}
		if got := Fingerprint(testCase.Input); got != testCase.Fingerprint {
			t.Errorf("Fingerprint(%q) = %q, want %q — %s",
				testCase.Input, got, testCase.Fingerprint, testCase.Why)
		}
	}
}

// The fixture carries the cases that discriminate. This carries every name the
// archive actually holds — thousands of speakers, sponsors and volunteers,
// including the accented ones NFKD exists for. An identity function is only as
// good as its worst real input.
func TestIdentityMatchesNodeOverEveryNameInTheArchive(t *testing.T) {
	dataDir := ts.ArchiveDir(t)

	// Collect every name, in a stable order, from the Go side.
	files, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	seen := map[string]bool{}
	add := func(name string) {
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		for _, item := range data.Get("items").Items() {
			for _, speaker := range item.Get("speakers").Items() {
				if speaker.IsString() {
					add(strings.TrimSpace(speaker.Str()))
				} else {
					add(strings.TrimSpace(speaker.Get("name").Str()))
				}
			}
		}
		event := data.Get("event")
		for _, sponsor := range event.Get("sponsors").Items() {
			add(strings.TrimSpace(sponsor.Get("title").Str()))
			add(strings.TrimSpace(sponsor.Get("id").Str()))
		}
		for _, person := range event.Get("community").Get("people").Items() {
			add(strings.TrimSpace(person.Get("name").Str()))
			add(strings.TrimSpace(person.Get("username").Str()))
		}
	}
	// The fixture archive, not the live one — but still enough real names, with
	// the accents and the punctuation that make this function worth testing.
	if len(names) < 100 {
		t.Fatalf("only found %d names — the walk is wrong", len(names))
	}

	payload, err := json.Marshal(names)
	if err != nil {
		t.Fatal(err)
	}
	out := ts.RunNode(t, nil, `
		import { normName, fingerprint } from './scripts/lib/archiveAudit.js';
		const names = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(names.map((n) => [normName(n), fingerprint(n)])));
	`, string(payload))
	var want [][2]string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}

	mismatches := 0
	for i, name := range names {
		gotNorm, gotPrint := NormName(name), Fingerprint(name)
		if gotNorm != want[i][0] || gotPrint != want[i][1] {
			mismatches++
			if mismatches <= 10 {
				t.Errorf("%q:\n  go:   norm=%q fp=%q\n  node: norm=%q fp=%q",
					name, gotNorm, gotPrint, want[i][0], want[i][1])
			}
		}
	}
	if mismatches > 10 {
		t.Errorf("… and %d more", mismatches-10)
	}
	t.Logf("matched %d distinct names", len(names))
}
