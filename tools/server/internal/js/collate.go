package js

// String.prototype.localeCompare, as used by the sorts in the archive.
//
// This is not the pedantry it looks like. `credits.people` sorts by event count
// then by name, and the archive has thirteen people with four events each —
// so the comparator decides the order of a visible leaderboard. Go's `<` is a
// byte comparison, which puts "Drupal Association" ahead of "ajits" because
// 'D' is 0x44 and 'a' is 0x61. localeCompare does not: at primary strength case
// is not a distinction, so it sorts between "davesparks" and "fubarhouse".
//
// The Unicode Collation Algorithm is what localeCompare implements, and
// x/text/collate is that algorithm — the same one, from the same data. It was
// already a dependency for NFKD, so this costs vendored tables and nothing
// else. Whether it agrees with V8 in practice is not taken on trust: the
// differential tests compare orderings over every name and country in the
// archive.

import (
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	collatorOnce sync.Once
	collator     *collate.Collator
)

// LocaleCompare reports whether a sorts before b, the way
// `a.localeCompare(b) < 0` does.
//
// The English root locale is used because that is what Node resolves an
// argument-less localeCompare to here. A different default locale would reorder
// a handful of accented names — which is a real difference between machines,
// and one the archive should not inherit; pinning it is deliberate.
func LocaleCompare(a, b string) bool {
	collatorOnce.Do(func() { collator = collate.New(language.English) })
	return collator.CompareString(a, b) < 0
}
