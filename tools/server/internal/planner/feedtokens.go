package planner

// A Go port of lib/feedTokens.js — calendar subscription tokens.
//
// A calendar client polls unattended: it cannot log in, cannot carry a session
// cookie and cannot refresh anything. So a subscribable URL IS a credential,
// and the only question is how good a credential it is. 256 bits from the
// CSPRNG, and only a SHA-256 hash is ever stored — the plaintext is returned
// once, at creation, and is not recoverable afterwards, so a leaked planner
// file exposes no live subscription.
//
// Tokens are PER SUBSCRIPTION rather than per planner. That is what makes
// show-once acceptable: minting another does not disturb the devices already
// subscribed, and revoking the laptop does not unsubscribe the phone.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"server/internal/archive"
	"server/internal/auth"
	"server/internal/js"
	"time"
)

// FeedsKey is where the subscription list lives on a planner or on global
// settings.
const FeedsKey = "_feeds"

// feedTokenBytes is 256 bits, matching the API tokens.
const feedTokenBytes = 32

// MintFeedToken returns a new secret.
func MintFeedToken() (string, error) {
	buffer := make([]byte, feedTokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// ListFeeds returns every subscription on a record WITHOUT its hash — safe to
// render, which is the whole reason this is a function rather than a field read.
func ListFeeds(owner *js.Value) *js.Value {
	out := js.Arr()
	for _, feed := range owner.Get(FeedsKey).Items() {
		safe := js.Obj()
		for _, key := range feed.Keys() {
			if key == "hash" {
				continue
			}
			safe.Set(key, feed.Get(key))
		}
		out.Append(safe)
	}
	return out
}

// AddFeed adds a subscription, mutating owner, and returns the plaintext token —
// the only moment it exists in this form.
func AddFeed(owner *js.Value, label, id string, now time.Time) (string, *js.Value, error) {
	if owner == nil || !owner.IsObject() {
		return "", nil, errors.New("no record to add a feed to")
	}
	token, err := MintFeedToken()
	if err != nil {
		return "", nil, err
	}
	if label == "" {
		label = "Calendar"
	}
	if id == "" {
		if id, err = randomUUID(); err != nil {
			return "", nil, err
		}
	}

	entry := js.Obj().
		Set("id", js.Str(id)).
		Set("label", js.Str(archive.FirstRunes(label, 60))).
		Set("hash", js.Str(auth.HashToken(token))).
		Set("createdAt", js.Str(archive.ISOMillis(now))).
		Set("lastUsedAt", js.Null()).
		Set("lastAgent", js.Null())

	feeds := owner.Get(FeedsKey)
	if !feeds.IsArray() {
		feeds = js.Arr()
	}
	feeds.Append(entry)
	owner.Set(FeedsKey, feeds)

	safe := js.Obj()
	for _, key := range entry.Keys() {
		if key != "hash" {
			safe.Set(key, entry.Get(key))
		}
	}
	return token, safe, nil
}

// RevokeFeed removes a subscription by its public id, reporting whether
// anything was removed.
func RevokeFeed(owner *js.Value, id string) bool {
	feeds := owner.Get(FeedsKey)
	if !feeds.IsArray() {
		return false
	}
	kept := js.Arr()
	for _, feed := range feeds.Items() {
		if feed.Get("id").Str() != id {
			kept.Append(feed)
		}
	}
	if len(kept.Items()) == len(feeds.Items()) {
		return false
	}
	owner.Set(FeedsKey, kept)
	return true
}

// RevokeAllFeeds drops every subscription — used when the thing they point at
// is deleted.
func RevokeAllFeeds(owner *js.Value) int {
	if owner == nil || !owner.IsObject() {
		return 0
	}
	count := len(owner.Get(FeedsKey).Items())
	owner.Set(FeedsKey, js.Arr())
	return count
}

// FindFeed returns the subscription a token belongs to, or nil.
//
// Compared in constant time over the HASHES: they are fixed-length hex, so the
// comparison never sees a length mismatch and cannot leak through an early
// return. Comparing raw tokens of attacker-controlled length would.
func FindFeed(owner *js.Value, token string) *js.Value {
	feeds := owner.Get(FeedsKey).Items()
	if token == "" || len(feeds) == 0 {
		return nil
	}
	want := []byte(auth.HashToken(token))
	for _, feed := range feeds {
		hash := feed.Get("hash")
		if hash == nil || !hash.IsString() || len(hash.Str()) != len(want) {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hash.Str()), want) == 1 {
			return feed
		}
	}
	return nil
}

// TouchFeed records that a subscription was polled, reporting whether the
// record changed enough to be worth saving.
//
// It keeps a coarse client name and NOT an IP address: "Apple Calendar, last
// seen Tuesday" is enough to notice a token being used from somewhere it should
// not be, without the product accumulating a location history of its reader.
func TouchFeed(owner *js.Value, id, userAgent string, now time.Time) bool {
	var feed *js.Value
	for _, candidate := range owner.Get(FeedsKey).Items() {
		if candidate.Get("id").Str() == id {
			feed = candidate
			break
		}
	}
	if feed == nil {
		return false
	}

	agent := archive.FirstRunes(splitFirst(userAgent, "/"), 40)

	// Calendars poll every few minutes; rewriting the planner (and its S3
	// object) that often would be absurd. An hour's resolution is plenty to
	// spot misuse.
	changed := true
	if previous := feed.Get("lastUsedAt").Str(); previous != "" {
		if parsed, err := time.Parse(time.RFC3339, previous); err == nil {
			changed = now.Sub(parsed) > time.Hour || feed.Get("lastAgent").Str() != agent
		}
	}

	feed.Set("lastUsedAt", js.Str(archive.ISOMillis(now)))
	if agent != "" {
		feed.Set("lastAgent", js.Str(agent))
	}
	return changed
}

func splitFirst(s, sep string) string {
	for i := 0; i+len(sep) <= len(s); i++ {
		if s[i:i+len(sep)] == sep {
			return s[:i]
		}
	}
	return s
}

// randomUUID is crypto.randomUUID(): a version 4 UUID.
func randomUUID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40 // version 4
	buffer[8] = (buffer[8] & 0x3f) | 0x80 // variant 10
	encoded := hex.EncodeToString(buffer)
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" +
		encoded[16:20] + "-" + encoded[20:32], nil
}
