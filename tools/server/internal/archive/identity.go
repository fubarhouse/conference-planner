package archive

// A Go port of normName() and fingerprint() from lib/archiveAudit.js — how the
// archive decides that two spellings are the same entity.
//
// These are the highest-stakes functions ported so far. Everything else here
// produces a report; these produce an identity. The curation ledger is keyed by
// fingerprint, read-time canonicalisation looks names up by it, and the cluster
// view groups by it — so a Go copy that disagreed by one character would not
// merely report something wrong, it would decide that a person is two people.
//
// Hence the only non-stdlib dependency in this module. `.normalize('NFKD')` is
// what turns "Gábor Hojtsy" into "gabor hojtsy" so it collides with
// "Hojtsy Gábor"; Go has no NFKD in the standard library, and a hand-rolled
// fold would be wrong for exactly the name it had not anticipated.
// golang.org/x/text is vendored so the build stays offline.

import (
	"regexp"
	"server/internal/js"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

var (
	// Company suffixes, dropped so "Acquia Inc." and "acquia" agree.
	companySuffix = regexp.MustCompile(`\b(inc|incorporated|ltd|limited|llc|gmbh|b\.?v|pty|co)\b`)
	nonAlnumRun   = regexp.MustCompile(`[^a-z0-9]+`)
)

// NormName collapses a name for de-duplication: lowercase, strip accents, drop
// company suffixes and punctuation. "Acquia Inc." and "acquia" both become
// "acquia".
//
// The step order is load-bearing and matches the original exactly: lowercase
// first (so the suffix pattern can be case-sensitive), then decompose, then
// remove the combining marks the decomposition exposed, then suffixes, then
// everything that is not a lowercase letter or digit becomes a space.
func NormName(s string) string {
	lowered := strings.ToLower(s)
	decomposed := norm.NFKD.String(lowered)

	// Drop the combining marks NFKD just separated out — U+0300..U+036F, the
	// same range the JavaScript strips.
	var stripped strings.Builder
	stripped.Grow(len(decomposed))
	for _, r := range decomposed {
		if r >= 0x0300 && r <= 0x036F {
			continue
		}
		stripped.WriteRune(r)
	}

	withoutSuffix := companySuffix.ReplaceAllString(stripped.String(), "")
	return js.Trim(nonAlnumRun.ReplaceAllString(withoutSuffix, " "))
}

// Fingerprint is a stronger de-dup key: NormName with its words SORTED, so
// word-order variants collide too. "Gábor Hojtsy" and "Hojtsy Gábor" both
// fingerprint to "gabor hojtsy", which is common with reversed given/family
// name order.
//
// Sorting is byte-wise here and code-unit-wise in JavaScript, which would
// differ above ASCII — but NormName has already replaced every non-ASCII rune
// with a space, so by this point there is nothing left to disagree about.
func Fingerprint(s string) string {
	words := strings.Fields(NormName(s))
	sort.Strings(words)
	return strings.Join(words, " ")
}
