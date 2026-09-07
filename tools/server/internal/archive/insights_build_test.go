package archive

import (
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"testing"
)

// The whole Observatory payload — stats, years, series, tiers, credits,
// regions, facets, speakers, sponsors, topics, per-year and per-series event
// lists, and a provenance summary per event.
//
// This used to shell out to lib/archiveInsights.js and compare byte for byte.
// It no longer can: that function has been deleted, Go is the only
// implementation, and the rest of this suite moved to recorded answers when
// server.js went (see testsupport/oracle.go). This test was the one left
// behind — and it had been SILENTLY SKIPPING, because its guard looked for
// `lib/archiveInsights.js` while the file had moved to `scripts/lib/`. It
// reported success while checking nothing, which is the exact failure the
// oracle pattern exists to prevent.
//
// The recording was taken at the moment the two implementations were verified
// identical over the full 204-event archive — 14,523,649 bytes each, byte for
// byte — so the frozen answer IS the ported answer, even though Go produces it
// now. What the test means has changed accordingly:
//
//	before   "Go agrees with the JavaScript running right now"  (not actually running)
//	after    "Go still produces what it produced when parity was last proven"
//
// Re-record with `go test ./internal/archive/ -update-golden` — pattern FIRST,
// see oracle.go — and say in the commit why the payload changed.
func TestInsightsMatchTheRecordedPayload(t *testing.T) {
	dataDir := ts.ArchiveDir(t)

	build := func() []byte {
		got, err := BuildInsights(dataDir, js.Obj(), js.Obj())
		if err != nil {
			t.Fatal(err)
		}
		return append(got.Encode("  "), '\n')
	}

	want := ts.OracleFile(t, "insights-fixture.json", build)
	gotBytes := build()

	if string(gotBytes) != string(want) {
		ts.WriteArtefacts(t, gotBytes, want)
		t.Fatalf("insights payload differs from the recording — artefacts written, diff them")
	}

	got, err := BuildInsights(dataDir, js.Obj(), js.Obj())
	if err != nil {
		t.Fatal(err)
	}
	stats := got.Get("stats")
	t.Logf("matches the recording: %d events, %d sessions, %d speakers, %d sponsors, %d topic sessions",
		IntOf(stats.Get("events")), IntOf(stats.Get("sessions")),
		IntOf(stats.Get("speakers")), IntOf(stats.Get("sponsors")),
		len(got.Get("topicSessions").Items()))
}

// The aliases are the whole point of the payload — tallies get cleaner as
// identities are reconciled — so the ledger path needs its own equivalence
// check rather than riding on an empty one.
func TestInsightsApplyCurationAliases(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}

	// Take a real speaker and map their fingerprint to a new display name.
	plain, err := BuildInsights(dataDir, js.Obj(), js.Obj())
	if err != nil {
		t.Fatal(err)
	}
	speakers := plain.Get("speakers").Items()
	if len(speakers) == 0 {
		t.Skip("no speakers in the archive")
	}
	original := speakers[0].Get("name").Str()
	key := Fingerprint(original)

	privateRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(privateRoot, "curation"), 0o755); err != nil {
		t.Fatal(err)
	}
	ledger := `{"aliases":{"` + key + `":"CANONICAL NAME"},"series":{"events/drupalcon/eu/2026-rotterdam.json":"Renamed Series"}}`
	if err := os.WriteFile(filepath.Join(privateRoot, "curation", "decisions.json"),
		[]byte(ledger), 0o644); err != nil {
		t.Fatal(err)
	}

	decisions := LoadDecisions(privateRoot)
	got, err := BuildInsights(dataDir, decisions.Aliases, decisions.Series)
	if err != nil {
		t.Fatal(err)
	}

	// This case is NOT recorded. Its input is derived from the fixture at run
	// time — the alias key is the fingerprint of whichever speaker happens to
	// sort first — so a recording would pin an answer to an ordering rather
	// than to the behaviour. The assertions below are the whole test, and they
	// were always the part that could catch a fault the old byte-comparison
	// could not: two implementations agreeing on the same wrong answer.
	renamed := false
	for _, speaker := range got.Get("speakers").Items() {
		if speaker.Get("name").Str() == "CANONICAL NAME" {
			renamed = true
		}
		if speaker.Get("name").Str() == original && original != "CANONICAL NAME" {
			t.Errorf("%q survived an alias that should have renamed it", original)
		}
	}
	if !renamed {
		t.Error("the alias did not reach the speaker list")
	}
	series := false
	for _, row := range got.Get("series").Items() {
		if row.Get("name").Str() == "Renamed Series" {
			series = true
		}
	}
	if !series {
		t.Error("the per-event series override did not reach the series list")
	}
}

func TestProvenanceSummaryShape(t *testing.T) {
	dataset, err := js.ParseJSON([]byte(`{
		"event": {
			"sources": [
				{"id":"a","kind":"schedule","url":"https://example.org/schedule","retrievedAt":"2026-01-01"},
				{"id":"b","kind":"video","via":{"provider":"wayback","timestamp":"20130826155852"}},
				{"id":"c","kind":"stats","title":"reported at the closing session","via":{"provider":"stated"}}
			],
			"sponsors": [{"title":"Acme"}],
			"flickr": {"groupUrl":"https://flickr.example/album"}
		},
		"items": [
			{"title":"A talk","link":"https://example.org/schedule","sourceIds":["a"]},
			{"title":"Another","link":"https://example.org/other","sourceIds":["a"]},
			{"title":"Uncited"},
			{"title":"Lunch"}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	summary := ProvenanceSummary(dataset)

	checks := map[string]int{
		"count":        3,
		"wayback":      1,
		"stated":       1,
		"undated":      2, // b and c carry no retrievedAt
		"exact":        1, // the item whose own link IS source a's url
		"cited":        2,
		"uncited":      1,
		"ownPage":      2,
		"sessions":     3, // Lunch is agenda
		"agenda":       1,
		"sponsorCount": 1,
		// the schedule url, the one other item link, and the album — the
		// duplicate link counts once
		"references": 3,
	}
	for key, want := range checks {
		if got := IntOf(summary.Get(key)); got != want {
			t.Errorf("%s = %d, want %d", key, got, want)
		}
	}
	if got := summary.Get("oldestCapture").Str(); got != "2013-08-26" {
		t.Errorf("oldestCapture = %q", got)
	}
	// Tiers keep first-seen order, and the tier rules are the ones from sources.js.
	if got := string(summary.Get("tiers").Encode("")); got != `{"live":1,"captured":1,"stated":1}` {
		t.Errorf("tiers = %s", got)
	}
	if got := IntOf(summary.Get("list").Items()[0].Get("records")); got != 2 {
		t.Errorf("reach for source a = %d, want 2", got)
	}
}
