package planner

import (
	"encoding/json"
	"os"
	"os/exec"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

// The stamp is pinned so both sides agree. DTSTAMP is "when this file was
// generated", which is genuinely different on two runs — comparing it would
// only ever prove that time passes.
const feedStamp = "20260101T000000Z"

// nodeScheduleIcs renders one event's feed with the JavaScript builders.
func nodeScheduleIcs(t *testing.T, dataDir, eventParam string) (string, bool) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		return "", false
	}
	out := ts.RunNode(t, nil, `
		import { buildEventScheduleIcs } from './lib/tripFeed.js';
		const [dataDir, eventParam] = process.argv.slice(1);
		const result = await buildEventScheduleIcs(eventParam, { dataDir });
		process.stdout.write(JSON.stringify(result ? result.ics : null));
	`, dataDir, eventParam)

	var ics *string
	if err := json.Unmarshal([]byte(out), &ics); err != nil {
		t.Fatalf("node returned %q: %v", out, err)
	}
	if ics == nil {
		return "", false
	}
	return *ics, true
}

// Every event in the archive, through both implementations. An .ics is a
// contract with software that reconciles on UIDs and folds lines at fixed
// widths, so "close enough" is not a category here.
func TestScheduleFeedIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found — set DATA_ROOT or CONTENT_PATH")
	}
	if _, err := os.Stat(ts.RepoRoot(t) + "/lib/tripFeed.js"); err != nil {
		t.Skip("lib/tripFeed.js unavailable")
	}

	catalogRaw, err := os.ReadFile(dataDir + "/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := js.ParseJSON(catalogRaw)
	if err != nil {
		t.Fatal(err)
	}

	checked, events := 0, 0
	for _, entry := range catalog.Get("events").Items() {
		file := entry.Get("file").Str()
		if file == "" {
			continue
		}
		want, ok := nodeScheduleIcs(t, dataDir, file)
		if !ok {
			t.Errorf("%s: node produced no feed", file)
			continue
		}
		feed := BuildEventScheduleIcs(file, dataDir, feedStamp)
		if feed == nil {
			t.Errorf("%s: Go produced no feed", file)
			continue
		}
		if ts.NormaliseStamp(feed.ICS) != ts.NormaliseStamp(want) {
			t.Errorf("%s: feeds differ\n--- go ---\n%s\n--- node ---\n%s",
				file, ts.FirstLines(feed.ICS, 24), ts.FirstLines(want, 24))
			return // one full diff is enough to work from
		}
		checked++
		events += strings.Count(feed.ICS, "BEGIN:VEVENT")
	}
	if checked == 0 {
		t.Fatal("no events were compared")
	}
	t.Logf("byte-identical across %d event feeds, %d VEVENTs", checked, events)
}

// The whitelist is the only thing between this route and the file system.
func TestScheduleFeedWhitelistsTheEventParameter(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	for _, param := range []string{
		"", "nope.json", "../server.js", "../../etc/passwd",
		"events/../server.js", "/etc/passwd", "catalog.json",
	} {
		if feed := BuildEventScheduleIcs(param, dataDir, feedStamp); feed != nil {
			t.Errorf("%q produced a feed from %s", param, feed.Path)
		}
	}

	// The flattened form of a real dataset is accepted, because old links use it.
	if feed := BuildEventScheduleIcs("drupalcon-eu-2026-rotterdam.json", dataDir, feedStamp); feed == nil {
		t.Error("the flattened dataset name should resolve")
	}
}

func TestMakeSessionIDMatchesTheClient(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node unavailable")
	}
	sessions := []string{
		`{"startTime":"2026-09-28T07:00:00Z","location":"Room 1","title":"A talk"}`,
		`{"startTime":"2026-09-28T07:00:00Z","title":"No location"}`,
		`{"startTime":"2026-09-28T07:00:00Z","location":"","title":"Empty location"}`,
		`{"startTime":"2026-09-28T07:00:00Z","location":"Hall A/B","title":"Slashes & things"}`,
		`{"title":"No start"}`,
		`{"startTime":"2026-09-28T07:00:00Z","location":"Zaal 1","title":"Café — naïve"}`,
	}

	payload := js.Arr()
	for _, session := range sessions {
		parsed, err := js.ParseJSON([]byte(session))
		if err != nil {
			t.Fatal(err)
		}
		payload.Append(parsed)
	}
	out := ts.RunNode(t, nil, `
		const sessions = JSON.parse(process.argv[1]);
		const makeSessionId = (s) =>
			`+"`${s.startTime}-${s.location}-${s.title}`"+`.replace(/[^a-zA-Z0-9-]/g, '-');
		process.stdout.write(JSON.stringify(sessions.map(makeSessionId)));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, session := range sessions {
		parsed, _ := js.ParseJSON([]byte(session))
		if got := MakeSessionID(parsed); got != want[i] {
			t.Errorf("%s\n  go:   %q\n  node: %q", session, got, want[i])
		}
	}
}

func TestIcsLineFoldingCountsUTF16Units(t *testing.T) {
	// 72 units is the first fold, then 71 per continuation.
	short := strings.Repeat("a", 72)
	if foldIcsLine(short) != short {
		t.Error("a 72-character line should not be folded")
	}
	long := strings.Repeat("a", 73)
	if want := strings.Repeat("a", 72) + "\r\n " + "a"; foldIcsLine(long) != want {
		t.Errorf("73 characters folded to %q", foldIcsLine(long))
	}

	// An astral character is two units, so a line of 36 of them is 72 units and
	// must not fold — the property a rune-based implementation would get wrong.
	astral := strings.Repeat("🎉", 36)
	if foldIcsLine(astral) != astral {
		t.Error("36 astral characters are 72 UTF-16 units and should not fold")
	}
	if !strings.Contains(foldIcsLine(strings.Repeat("🎉", 37)), "\r\n ") {
		t.Error("37 astral characters are 74 units and should fold")
	}
}

func TestIcsEscapingAndDurations(t *testing.T) {
	if got := escapeIcsText(`a,b;c\d` + "\ne"); got != `a\,b\;c\\d\ne` {
		t.Errorf("escapeIcsText = %q", got)
	}
	// The backslash is escaped first, or the escapes introduced after it would
	// themselves be escaped.
	if got := escapeIcsText(`\,`); got != `\\\,` {
		t.Errorf("escapeIcsText(%q) = %q", `\,`, got)
	}
	for minutes, want := range map[int]string{360: "PT6H", 720: "PT12H", 90: "PT90M", 0: "PT1M"} {
		if got := icsDuration(minutes); got != want {
			t.Errorf("icsDuration(%d) = %q, want %q", minutes, got, want)
		}
	}
}

func TestIcsInstantResolvesZones(t *testing.T) {
	// September in Amsterdam is CEST (+02:00).
	if got := icsInstant(WallTime{Date: "2026-09-28", Time: "09:00"}, "Europe/Amsterdam"); got != "20260928T070000Z" {
		t.Errorf("summer = %s", got)
	}
	// January is CET (+01:00) — a fixed offset would get one of these wrong.
	if got := icsInstant(WallTime{Date: "2026-01-15", Time: "09:00"}, "Europe/Amsterdam"); got != "20260115T080000Z" {
		t.Errorf("winter = %s", got)
	}
	// No zone, or one that does not exist, stays floating.
	if got := icsInstant(WallTime{Date: "2026-01-15", Time: "09:00"}, ""); got != "20260115T090000" {
		t.Errorf("floating = %s", got)
	}
	if got := icsInstant(WallTime{Date: "2026-01-15", Time: "09:00"}, "Mars/Olympus"); got != "20260115T090000" {
		t.Errorf("unknown zone = %s", got)
	}
}

func TestAddMinutesRollsOverMidnight(t *testing.T) {
	got := AddMinutes(WallTime{Date: "2026-01-31", Time: "23:30"}, 45)
	if got.Date != "2026-02-01" || got.Time != "00:15" {
		t.Errorf("AddMinutes = %+v", got)
	}
	if next := nextDay("2026-12-31"); next != "20270101" {
		t.Errorf("nextDay = %s", next)
	}
}
