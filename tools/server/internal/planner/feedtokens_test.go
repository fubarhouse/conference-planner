package planner

import (
	"server/internal/js"
	"strings"
	"testing"
	"time"
)

func TestFeedTokenLifecycle(t *testing.T) {
	owner, err := js.ParseJSON([]byte(`{"name":"Trip"}`))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	token, entry, err := AddFeed(owner, "Phone", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(token) != 64 {
		t.Errorf("token is %d hex characters, want 64 (256 bits)", len(token))
	}
	// The plaintext is returned once and never stored.
	if strings.Contains(string(owner.Encode("")), token) {
		t.Fatal("the plaintext token was written into the record")
	}
	if entry.Get("hash").Exists() {
		t.Error("the returned entry should carry no hash")
	}
	if entry.Get("label").Str() != "Phone" {
		t.Errorf("label = %q", entry.Get("label").Str())
	}

	// It can be found by its token, and only by its token.
	found := FindFeed(owner, token)
	if found == nil {
		t.Fatal("the feed was not found by its own token")
	}
	// One character different. Flipped rather than set, because a token that
	// already ended in the chosen character would not be a near miss at all.
	nearMiss := token[:63] + map[bool]string{true: "0", false: "1"}[token[63] == '1']
	if FindFeed(owner, nearMiss) != nil {
		t.Error("a near-miss token matched")
	}
	if FindFeed(owner, "") != nil {
		t.Error("an empty token matched")
	}

	// A second subscription does not disturb the first.
	second, _, err := AddFeed(owner, "Laptop", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(ListFeeds(owner).Items()) != 2 {
		t.Fatalf("expected two subscriptions, got %s", ListFeeds(owner).Encode(""))
	}
	if FindFeed(owner, token) == nil || FindFeed(owner, second) == nil {
		t.Error("both tokens should still resolve")
	}

	// ListFeeds is safe to render.
	if strings.Contains(string(ListFeeds(owner).Encode("")), "hash") {
		t.Error("ListFeeds leaked a hash")
	}

	// Revoking one leaves the other subscribed.
	id := found.Get("id").Str()
	if !RevokeFeed(owner, id) {
		t.Error("revoking an existing feed should report a change")
	}
	if RevokeFeed(owner, id) {
		t.Error("revoking it twice should report no change")
	}
	if FindFeed(owner, token) != nil {
		t.Error("a revoked token still resolves")
	}
	if FindFeed(owner, second) == nil {
		t.Error("revoking the laptop unsubscribed the phone")
	}

	if count := RevokeAllFeeds(owner); count != 1 {
		t.Errorf("RevokeAllFeeds reported %d", count)
	}
	if len(ListFeeds(owner).Items()) != 0 {
		t.Error("subscriptions survived RevokeAllFeeds")
	}
}

func TestAddFeedDefaultsAndLimits(t *testing.T) {
	owner := js.Obj()
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

	_, entry, err := AddFeed(owner, "", "", now)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Get("label").Str() != "Calendar" {
		t.Errorf("an unlabelled feed should be called Calendar, got %q", entry.Get("label").Str())
	}
	if id := entry.Get("id").Str(); len(id) != 36 || strings.Count(id, "-") != 4 {
		t.Errorf("id = %q, want a UUID", id)
	}

	_, long, err := AddFeed(owner, strings.Repeat("x", 200), "", now)
	if err != nil {
		t.Fatal(err)
	}
	if len([]rune(long.Get("label").Str())) != 60 {
		t.Errorf("a long label should be cut to 60, got %d", len([]rune(long.Get("label").Str())))
	}

	if _, _, err := AddFeed(js.Arr(), "x", "", now); err == nil {
		t.Error("adding a feed to a non-record should fail")
	}
}

// Calendars poll every few minutes. Rewriting the planner — and its S3 object —
// that often would be absurd, so a touch only reports a change worth saving.
func TestTouchFeedReportsOnlyMeaningfulChanges(t *testing.T) {
	owner := js.Obj()
	start := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	_, entry, err := AddFeed(owner, "Phone", "", start)
	if err != nil {
		t.Fatal(err)
	}
	id := entry.Get("id").Str()

	if !TouchFeed(owner, id, "Apple Calendar/1.0", start) {
		t.Error("the first poll should be worth saving")
	}
	if TouchFeed(owner, id, "Apple Calendar/1.1", start.Add(5*time.Minute)) {
		t.Error("a poll five minutes later, same client, should not be worth saving")
	}
	if !TouchFeed(owner, id, "Apple Calendar/1.0", start.Add(2*time.Hour)) {
		t.Error("a poll two hours later should be worth saving")
	}
	if !TouchFeed(owner, id, "Thunderbird/2.0", start.Add(2*time.Hour+time.Minute)) {
		t.Error("a different client should be worth saving — that is the leak signal")
	}

	feed := FindFeedByID(owner, id)
	// The agent is coarse on purpose: the product does not accumulate a location
	// history of its reader.
	if got := feed.Get("lastAgent").Str(); got != "Thunderbird" {
		t.Errorf("lastAgent = %q, want the client name without its version", got)
	}

	if TouchFeed(owner, "no-such-id", "x", start) {
		t.Error("touching an unknown id reported a change")
	}
}

// FindFeedByID is a test helper: the production lookup is by token.
func FindFeedByID(owner *js.Value, id string) *js.Value {
	for _, feed := range owner.Get(FeedsKey).Items() {
		if feed.Get("id").Str() == id {
			return feed
		}
	}
	return nil
}
