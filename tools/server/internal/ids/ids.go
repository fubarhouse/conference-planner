// Package ids generates the identifiers this application hands out.
//
// A port of lib/makeId.js. It is its own package because two very different
// callers need it — the CRUD engine minting element ids, and the suggestion
// queue minting a lead's id — and because the FORMAT is a contract with
// plannerStorage.js in the browser, which the JavaScript kept in step by hand,
// in a comment.
package ids

import (
	"crypto/rand"
	"encoding/binary"
	"strconv"
	"strings"
	"time"
)

// MakeID mints `<prefix>_<millis>_<5 random base-36 chars>`, matching makeId()
// and, through it, makeItemId() in the browser — so an id minted through the API
// is indistinguishable from one the planner UI creates.
func MakeID(prefix string, now time.Time) string {
	if prefix == "" {
		prefix = "item"
	}
	return prefix + "_" + strconv.FormatInt(now.UnixMilli(), 10) + "_" + RandomBase36(5)
}

// RandomBase36 is `Math.random().toString(36).slice(2, 7)` in effect: five
// characters of the alphabet that produces. Crypto-random here rather than
// Math.random, which is a deliberate difference — the ids are not secrets, but
// there is no reason for a server to mint them from a predictable source.
func RandomBase36(length int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return strings.Repeat("0", length)
	}
	value := binary.BigEndian.Uint64(buffer)
	out := make([]byte, length)
	for i := range out {
		out[i] = alphabet[value%36]
		value /= 36
	}
	return string(out)
}
