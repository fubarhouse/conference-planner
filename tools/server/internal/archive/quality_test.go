package archive

import (
	"os"
	"os/exec"
	"path/filepath"
	ts "server/internal/testsupport"
	"strconv"
	"strings"
	"testing"
)

func nodeQuality(t *testing.T, dataDir string) ([]byte, bool) {
	t.Helper()
	root := ts.RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "lib", "archiveQuality.js")); err != nil {
		return nil, false
	}
	if _, err := exec.LookPath("node"); err != nil {
		return nil, false
	}

	script := `
		import { buildQuality } from './scripts/lib/archiveQuality.js';
		const quality = await buildQuality(process.argv[1]);
		process.stdout.write(JSON.stringify(quality, null, 2) + '\n');
	`
	cmd := exec.Command("node", "--input-type=module", "--eval", script, dataDir)
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if asExitError(err, &exit) {
			t.Fatalf("node quality failed: %s", strings.TrimSpace(string(exit.Stderr)))
		}
		t.Fatalf("node quality failed: %v", err)
	}
	return out, true
}

func TestQualityIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}

	want, ok := nodeQuality(t, dataDir)
	if !ok {
		t.Skip("node or lib/archiveQuality.js unavailable")
	}

	got, err := BuildQuality(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	gotBytes := append(got.Encode("  "), '\n')

	if string(gotBytes) != string(want) {
		ts.WriteArtefacts(t, gotBytes, want)
		t.Fatalf("Go and Node quality reports differ — artefacts written, diff them")
	}
	totals := got.Get("totals")
	t.Logf("byte-identical: %d events, %d sessions, %d defects",
		IntOf(totals.Get("events")), IntOf(totals.Get("sessions")), IntOf(totals.Get("defects")))
}

// String.length is UTF-16 code units. A description of 399 emoji is 798 by that
// measure and 399 by Go's rune count, which would put the two implementations on
// opposite sides of the flattened-description threshold.
func TestUTF16LengthMatchesJavaScript(t *testing.T) {
	cases := []struct {
		text string
		want int
	}{
		{"", 0},
		{"plain ascii", 11},
		{"Gábor Hojtsy", 12}, // BMP, one unit each
		{"日本語", 3},           // still BMP
		{"🎉", 2},             // astral: a surrogate pair
		{"a🎉b", 4},
	}
	for _, testCase := range cases {
		if got := utf16Len(testCase.text); got != testCase.want {
			t.Errorf("utf16Len(%q) = %d, want %d", testCase.text, got, testCase.want)
		}
	}

	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable for the cross-check")
	}
	// And confirm against the real thing rather than against my arithmetic.
	for _, testCase := range cases {
		out, err := exec.Command("node", "--input-type=module", "--eval",
			`process.stdout.write(String(process.argv[1].length))`, testCase.text).Output()
		if err != nil {
			t.Fatal(err)
		}
		if string(out) != strconv.Itoa(testCase.want) {
			t.Errorf("node says %q.length = %s, fixture says %d", testCase.text, out, testCase.want)
		}
	}
}

func TestPercentagesRenderLikeJavaScriptNumbers(t *testing.T) {
	cases := []struct {
		part, whole int
		want        string
	}{
		{0, 0, "0"},    // guard: no sessions
		{1, 1, "100"},  // whole numbers carry no decimal point
		{1, 3, "33.3"}, // one decimal place
		{2, 3, "66.7"},
		{873, 1000, "87.3"},
		{1, 8, "12.5"},
		{0, 7, "0"},
	}
	for _, testCase := range cases {
		got := string(pctValue(testCase.part, testCase.whole).Encode("  "))
		if got != testCase.want {
			t.Errorf("pct(%d, %d) = %s, want %s", testCase.part, testCase.whole, got, testCase.want)
		}
	}
}

func TestEventsWithNoSessionsAreExcluded(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Only agenda items: not a programme, so not in the quality report at all.
	write("events/agenda-only.json", `{"event":{"designation":"A","location":"B","startDate":"2020-01-01"},
		"items":[{"title":"Lunch"},{"title":"Registration"}]}`)
	write("events/real.json", `{"event":{"designation":"C","location":"D","startDate":"2020-01-01"},
		"items":[{"title":"A talk","full_description":"x"}]}`)

	quality, err := BuildQuality(dir)
	if err != nil {
		t.Fatal(err)
	}
	events := quality.Get("events").Items()
	if len(events) != 1 || events[0].Get("name").Str() != "C D 2020" {
		t.Fatalf("events = %s", quality.Get("events").Encode("  "))
	}
}

func TestBoilerplateNeedsEightOccurrences(t *testing.T) {
	build := func(copies int) int {
		dir := t.TempDir()
		items := ""
		for i := 0; i < copies; i++ {
			if i > 0 {
				items += ","
			}
			items += `{"title":"Talk ` + strconv.Itoa(i) + `","full_description":"Join our mailing list."}`
		}
		full := filepath.Join(dir, "events", "e.json")
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		body := `{"event":{"designation":"E","location":"F","startDate":"2020-01-01"},"items":[` + items + `]}`
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		quality, err := BuildQuality(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, probe := range quality.Get("probes").Items() {
			if probe.Get("key").Str() == "boilerplate" {
				return IntOf(probe.Get("count"))
			}
		}
		return 0
	}

	// Seven repeated coffee-break lines are coincidence; eight is a pattern.
	if got := build(7); got != 0 {
		t.Errorf("7 copies flagged %d — below the threshold nothing should fire", got)
	}
	if got := build(8); got != 8 {
		t.Errorf("8 copies flagged %d, want all 8", got)
	}
}
