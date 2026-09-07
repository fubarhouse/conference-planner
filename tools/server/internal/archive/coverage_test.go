package archive

import (
	"os"
	"os/exec"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

// The pinned date. Coverage depends on "has this event finished yet", so a
// floating today would make the Go and Node runs disagree the moment one of
// them crossed midnight — and would quietly change the expected output of this
// test every day.
const coverageToday = "2026-06-01"

// nodeCoverage asks the Node implementation for the same structure, with the
// same ledger and the same idea of today.
func nodeCoverage(t *testing.T, dataDir, privateRoot string) ([]byte, bool) {
	t.Helper()
	root := ts.RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "lib", "archiveCoverage.js")); err != nil {
		return nil, false
	}
	if _, err := exec.LookPath("node"); err != nil {
		return nil, false
	}

	script := `
		import { buildCoverage } from './scripts/lib/archiveCoverage.js';
		const [dataDir, today] = process.argv.slice(1);
		const coverage = await buildCoverage(dataDir, undefined, { today });
		process.stdout.write(JSON.stringify(coverage, null, 2) + '\n');
	`
	cmd := exec.Command("node", "--input-type=module", "--eval", script, dataDir, coverageToday)
	cmd.Dir = root
	// lib/roots.js resolves CURATION_ROOT from the environment, and buildCoverage
	// reads the ledger through it. Both sides must be told the same private root
	// or they disagree about which gaps are snoozed.
	cmd.Env = append(os.Environ(), "PRIVATE_ROOT="+privateRoot)
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if asExitError(err, &exit) {
			t.Fatalf("node coverage failed: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		t.Fatalf("node coverage failed: %v", err)
	}
	return out, true
}

func TestCoverageIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}
	// An empty private root: no ledger, so nothing is snoozed. The snoozed path
	// is covered by TestCoverageHonoursTheLedger below, which is where a
	// synthetic ledger can be controlled.
	privateRoot := t.TempDir()

	want, ok := nodeCoverage(t, dataDir, privateRoot)
	if !ok {
		t.Skip("node or lib/archiveCoverage.js unavailable")
	}

	got, err := BuildCoverage(dataDir, LoadSnoozes(privateRoot), coverageToday)
	if err != nil {
		t.Fatal(err)
	}
	gotBytes := append(got.Encode("  "), '\n')

	if string(gotBytes) != string(want) {
		ts.WriteArtefacts(t, gotBytes, want)
		t.Fatalf("Go and Node coverage differ — artefacts written, diff them")
	}
	t.Logf("byte-identical over %d events", IntOf(got.Get("totals").Get("events")))
}

// The ledger is the whole reason this report is usable twice, so the snoozed
// path needs its own equivalence check rather than riding on an empty one.
func TestCoverageHonoursTheLedger(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}

	// Pick a real event and snooze two of its checks: one forever, one until a
	// date that has already passed (so it must read as open again).
	files, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil || len(files) == 0 {
		t.Skip("no datasets")
	}
	slashed := filepath.ToSlash(files[0])
	file := slashed[strings.Index(slashed, "events/"):]

	privateRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(privateRoot, "curation"), 0o755); err != nil {
		t.Fatal(err)
	}
	ledger := `{"snoozes":{
		"` + file + `::videos": {"state":"ignored","note":"never recorded"},
		"` + file + `::descriptions": {"state":"later","until":"2020-01-01"}
	}}`
	if err := os.WriteFile(filepath.Join(privateRoot, "curation", "decisions.json"),
		[]byte(ledger), 0o644); err != nil {
		t.Fatal(err)
	}

	want, ok := nodeCoverage(t, dataDir, privateRoot)
	if !ok {
		t.Skip("node unavailable")
	}
	got, err := BuildCoverage(dataDir, LoadSnoozes(privateRoot), coverageToday)
	if err != nil {
		t.Fatal(err)
	}
	if string(append(got.Encode("  "), '\n')) != string(want) {
		ts.WriteArtefacts(t, append(got.Encode("  "), '\n'), want)
		t.Fatal("Go and Node coverage differ with a ledger in play")
	}

	// And assert the behaviour directly, so a future change that makes both
	// implementations wrong in the same way still fails something.
	for _, event := range got.Get("events").Items() {
		if event.Get("file").Str() != file {
			continue
		}
		for _, check := range event.Get("checks").Items() {
			switch check.Get("key").Str() {
			case "videos":
				if check.Get("open").IsTrue() {
					t.Error("an ignored check is never open")
				}
			case "descriptions":
				if IntOf(check.Get("missing")) > 0 && !check.Get("open").IsTrue() {
					t.Error("a snooze whose date has passed is open again")
				}
			}
		}
	}
}

func TestIsOpen(t *testing.T) {
	cases := []struct {
		name   string
		ledger string
		want   bool
	}{
		{"no snooze", `null`, true},
		{"ignored is forever", `{"state":"ignored"}`, false},
		{"later, date in the future", `{"state":"later","until":"2030-01-01"}`, false},
		{"later, date passed", `{"state":"later","until":"2020-01-01"}`, true},
		{"later, date today", `{"state":"later","until":"2026-06-01"}`, true},
		{"later, no date", `{"state":"later"}`, true},
		{"unknown state", `{"state":"whatever"}`, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := js.ParseJSON([]byte(testCase.ledger))
			if err != nil {
				t.Fatal(err)
			}
			snooze := parsed
			if parsed.IsNull() {
				snooze = nil
			}
			if got := IsOpen(snooze, coverageToday); got != testCase.want {
				t.Errorf("IsOpen = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestPendingChecksAreNotGapsBeforeTheEvent(t *testing.T) {
	dir := t.TempDir()
	full := filepath.Join(dir, "events", "future.json")
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	// An event that has not happened: no recordings, no attendance, no photos —
	// none of which are gaps yet.
	dataset := `{"event":{"designation":"Future","location":"Somewhere","year":"2030",
		"startDate":"2030-05-01","endDate":"2030-05-02"},
		"items":[{"title":"A talk","link":"https://example.org/a","full_description":"x",
		"speakers":["Someone"],"track":["t"]}]}`
	if err := os.WriteFile(full, []byte(dataset), 0o644); err != nil {
		t.Fatal(err)
	}

	coverage, err := BuildCoverage(dir, js.Obj(), coverageToday)
	if err != nil {
		t.Fatal(err)
	}
	event := coverage.Get("events").Items()[0]

	pending := map[string]bool{}
	for _, check := range event.Get("checks").Items() {
		if check.Get("pending").IsTrue() {
			pending[check.Get("key").Str()] = true
			if check.Get("open").IsTrue() {
				t.Errorf("%s is pending and must not also be open", check.Get("key").Str())
			}
		}
	}
	for _, key := range []string{"videos", "attendance", "photos"} {
		if !pending[key] {
			t.Errorf("%s should be pending for an event in 2030", key)
		}
	}
	// And the score must not be dragged down by facts that cannot exist yet.
	if score := IntOf(event.Get("score")); score < 60 {
		t.Errorf("score = %d — a future event is being marked down for not having happened", score)
	}
}
