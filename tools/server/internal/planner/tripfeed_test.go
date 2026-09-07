package planner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

func nodePlannerIcs(t *testing.T, path, dataDir string) string {
	t.Helper()
	return ts.RunNode(t, nil, `
		import { readFile } from 'node:fs/promises';
		import { buildPlannerFeedIcs } from './lib/tripFeed.js';
		const [path, dataDir] = process.argv.slice(1);
		const planner = JSON.parse(await readFile(path, 'utf8'));
		process.stdout.write(await buildPlannerFeedIcs(planner, { dataDir }));
	`, path, dataDir)
}

// Every real planner, through both implementations. These are trips with
// flights, hotels and tracked sessions in them — the shapes a synthetic fixture
// would not think to include.
func TestPlannerFeedIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	planners := ts.PlannerDir(t)
	if dataDir == "" || planners == "" {
		t.Skip("no archive or planner directory found")
	}

	entries, err := os.ReadDir(planners)
	if err != nil {
		t.Fatal(err)
	}

	checked, vevents := 0, 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(planners, entry.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		planner, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		// Only actual planners: the directory also holds global settings and a
		// tombstone list.
		if !planner.Get("personal").Exists() && !planner.Get("_eventFile").Exists() {
			continue
		}

		want := nodePlannerIcs(t, path, dataDir)
		got := BuildPlannerFeedIcs(planner, dataDir, feedStamp)

		if ts.NormaliseStamp(got) != ts.NormaliseStamp(want) {
			t.Errorf("%s: feeds differ\n--- go ---\n%s\n--- node ---\n%s",
				entry.Name(), ts.FirstLines(got, 30), ts.FirstLines(want, 30))
			return
		}
		checked++
		vevents += strings.Count(got, "BEGIN:VEVENT")
	}

	if checked == 0 {
		t.Skip("no planners with trips in them")
	}
	t.Logf("byte-identical across %d planner feeds, %d VEVENTs", checked, vevents)
}

// A leaked feed URL exposes the schedule. It must never expose a booking.
func TestPlannerFeedRedactsBookingReferences(t *testing.T) {
	planner, err := js.ParseJSON([]byte(`{
		"_id": "abc-123",
		"_displayName": "A trip",
		"personal": {
			"outboundLegs": [{
				"id": "L1", "mode": "flight", "date": "2026-09-27",
				"from": "Melbourne", "to": "Amsterdam",
				"departTime": "09:00", "arriveTime": "18:00",
				"ref": "PNR-SECRET", "confirmation": "CONF-SECRET"
			}]
		}
	}`))
	if err != nil {
		t.Fatal(err)
	}

	feed := BuildPlannerFeedIcs(planner, t.TempDir(), feedStamp)
	for _, secret := range []string{"PNR-SECRET", "CONF-SECRET", "Ref:", "Confirmation:"} {
		if strings.Contains(feed, secret) {
			t.Errorf("the public feed leaked %q", secret)
		}
	}
	if !strings.Contains(feed, "Direction: Outbound") {
		t.Error("the direction should still be there — it is not a credential")
	}
	if !strings.Contains(feed, "SUMMARY:Flight: Melbourne → Amsterdam") {
		t.Errorf("the leg title is wrong:\n%s", feed)
	}

	// A deliberate local download is a different question, and keeps them.
	withRefs := BuildTripCalEvents(planner, nil, "", AllTripCategories(), false)
	if !strings.Contains(withRefs[0].Description, "Ref: PNR-SECRET") {
		t.Error("a local export should keep the booking reference")
	}
}

func TestTripEntityMappers(t *testing.T) {
	parse := func(body string) *js.Value {
		v, err := js.ParseJSON([]byte(body))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}

	// An itinerary item with no time is all-day.
	item := ItineraryItemToCalEvent(parse(`{"date":"2026-09-28","title":"Coffee"}`), "Europe/Amsterdam")
	if !item.AllDay || item.End != nil {
		t.Errorf("a timeless item should be all-day: %+v", item)
	}
	// With a time and an end time it is a real interval.
	timed := ItineraryItemToCalEvent(
		parse(`{"date":"2026-09-28","title":"Lunch","time":"12:00","endTime":"13:00"}`), "")
	if timed.AllDay || timed.End == nil || timed.End.Time != "13:00" {
		t.Errorf("a timed item should carry its end: %+v", timed)
	}
	// The item's own zone wins over the trip's.
	zoned := ItineraryItemToCalEvent(
		parse(`{"date":"2026-09-28","title":"x","time":"09:00","timezone":"Asia/Tokyo"}`),
		"Europe/Amsterdam")
	if zoned.Timezone != "Asia/Tokyo" {
		t.Errorf("timezone = %q", zoned.Timezone)
	}
	if ItineraryItemToCalEvent(parse(`{"title":"No date"}`), "") != nil {
		t.Error("an item with no date should map to nothing")
	}

	// The mode label loses its emoji.
	leg := LegToCalEvent(parse(`{"date":"2026-09-27","mode":"train","from":"A","to":"B"}`), "", true)
	if leg.Title != "Train: A → B" {
		t.Errorf("title = %q", leg.Title)
	}
	if !leg.AllDay {
		t.Error("a leg with no departure time is all-day")
	}
	// An unknown mode is used as-is; a missing one becomes Travel.
	if got := LegToCalEvent(parse(`{"date":"2026-01-01","mode":"hovercraft"}`), "", true).Title; got != "hovercraft" {
		t.Errorf("unknown mode title = %q", got)
	}
	if got := LegToCalEvent(parse(`{"date":"2026-01-01"}`), "", true).Title; got != "Travel" {
		t.Errorf("missing mode title = %q", got)
	}

	// A stay spans check-in to check-out, all-day.
	stay := AccommodationToCalEvent(parse(`{"checkIn":"2026-09-27","checkOut":"2026-10-01","name":"Hotel"}`))
	if !stay.AllDay || stay.Title != "Stay: Hotel" || stay.End.Date != "2026-10-01" {
		t.Errorf("stay = %+v", stay)
	}
	// No check-out means a single night.
	single := AccommodationToCalEvent(parse(`{"checkIn":"2026-09-27"}`))
	if single.End.Date != "2026-09-27" || single.Title != "Stay: Accommodation" {
		t.Errorf("single-night stay = %+v", single)
	}
	if AccommodationToCalEvent(parse(`{"name":"No dates"}`)) != nil {
		t.Error("a stay with no check-in should map to nothing")
	}
}

func TestLocalLegsAreOptOut(t *testing.T) {
	body := `{"_id":"p","personal":{"localLegs":[{"id":"L","date":"2026-09-28","mode":"taxi"}]%s}}`
	off, err := js.ParseJSON([]byte(strings.Replace(body, "%s", "", 1)))
	if err != nil {
		t.Fatal(err)
	}
	if events := BuildTripCalEvents(off, nil, "", AllTripCategories(), true); len(events) != 0 {
		t.Errorf("local legs are hidden unless showLocalTravel is set, got %d", len(events))
	}

	on, err := js.ParseJSON([]byte(strings.Replace(body, "%s", `,"showLocalTravel":true`, 1)))
	if err != nil {
		t.Fatal(err)
	}
	events := BuildTripCalEvents(on, nil, "", AllTripCategories(), true)
	if len(events) != 1 || !strings.Contains(events[0].Description, "Direction: Local") {
		t.Errorf("events = %+v", events)
	}
}

func TestFindPlannerByID(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		full := filepath.Join(dir, rel)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.json", `{"_id":"uuid-a","_displayName":"A"}`)
	write("someone/b.json", `{"_id":"uuid-b","_displayName":"B"}`)
	write("c.json", `{not json`)
	write("notes.txt", `ignored`)

	if found := FindPlannerByID("uuid-a", dir); found == nil || found.File != "a.json" {
		t.Errorf("root planner: %+v", found)
	}
	// One level of per-user subdirectory is scanned, for multi-user mode.
	if found := FindPlannerByID("uuid-b", dir); found == nil || found.File != "b.json" {
		t.Errorf("per-user planner: %+v", found)
	}
	if FindPlannerByID("uuid-nope", dir) != nil {
		t.Error("an unknown id resolved to something")
	}
	if FindPlannerByID("", dir) != nil {
		t.Error("an empty id resolved to something")
	}
	if FindPlannerByID("uuid-a", filepath.Join(dir, "absent")) != nil {
		t.Error("a missing directory resolved to something")
	}
}

func TestStripLeadingToken(t *testing.T) {
	cases := map[string]string{
		"✈ Flight":   "Flight",
		"🚗 Transfer": "Transfer",
		"Travel":     "Travel", // no space: nothing to strip
		" Leading":   " Leading",
		"a b c":      "b c",
		"":           "",
	}
	for input, want := range cases {
		if got := stripLeadingToken(input); got != want {
			t.Errorf("stripLeadingToken(%q) = %q, want %q", input, got, want)
		}
	}
}

var _ = json.Marshal
