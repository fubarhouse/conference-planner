package planner

import (
	"server/internal/js"
	"testing"
)

// A barcamp publishes sessions it never places in a slot. Those are stored with
// `unscheduled: true` and no startTime at all, so there is no DTSTART to build a
// VEVENT from and they must not reach a subscriber's calendar.
//
// SessionToCalEvent already returns nil on an empty start, so this is a guard
// rather than a repair — the behaviour is correct today and these tests are here
// to keep it that way, because the failure mode is silent: a broken entry in a
// downstream calendar client, not an error anybody here would see.
func sessionValue(t *testing.T, raw string) *js.Value {
	t.Helper()
	v, err := js.ParseJSON([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return v
}

func TestUnscheduledSessionProducesNoCalendarEvent(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{
			name: "no startTime key at all, as the schema requires",
			raw:  `{"title":"Entity API beyond the basics","unscheduled":true,"duration":"P45M"}`,
		},
		{
			name: "startTime present but empty",
			raw:  `{"title":"Let's talk dates","startTime":"","duration":"P45M"}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SessionToCalEvent(sessionValue(t, tc.raw), "Europe/Berlin"); got != nil {
				t.Fatalf("expected no calendar event, got %+v", got)
			}
		})
	}
}

func TestPlacedSessionStillProducesACalendarEvent(t *testing.T) {
	// The other half of the contract. A barcamp's keynotes DO carry a time, and
	// dropping them along with the pool would be the obvious over-correction.
	raw := `{"title":"Drupal CMS now and beyond","startTime":"2025-09-12T09:00:00Z",` +
		`"endTime":"2025-09-12T09:50:00Z","speakers":["Cristina Chumillas"]}`
	got := SessionToCalEvent(sessionValue(t, raw), "Europe/Berlin")
	if got == nil {
		t.Fatal("expected a calendar event for a session with a real start time")
	}
	if got.Title != "Drupal CMS now and beyond" {
		t.Fatalf("title = %q", got.Title)
	}
}
