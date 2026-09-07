package archive

// The curation ledger, read side only.
//
// Snoozes live beside the identity decisions in PRIVATE_ROOT/curation because
// they are the same kind of fact: a judgement a person made about the archive
// that must outlive the container. A tool that reports gaps has to read them or
// it re-reports every gap somebody has already ruled on.
//
// Read only, deliberately. Writing decisions is the server's job — it has the
// S3-backed store and the identity of whoever made the call.

import (
	"os"
	"path/filepath"
	"server/internal/js"
)

// Decisions is the read side of the curation ledger.
type Decisions struct {
	Aliases *js.Value // fingerprint → canonical display name
	Series  *js.Value // event file → the series it belongs to
	Snoozes *js.Value // "<file>::<check>" → { state, until }
}

// LoadDecisions reads the whole ledger. A missing or malformed one is empty,
// never an error — matching parseDecisions() in lib/archiveAudit.js. The
// alternative is a reporting tool that refuses to run because of a file it only
// consults.
func LoadDecisions(privateRoot string) Decisions {
	empty := Decisions{Aliases: js.Obj(), Series: js.Obj(), Snoozes: js.Obj()}
	if privateRoot == "" {
		return empty
	}
	raw, err := os.ReadFile(filepath.Join(privateRoot, "curation", "decisions.json"))
	if err != nil {
		return empty
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return empty
	}
	// An array is typeof 'object' in JS, so the Node side guards against a
	// ledger holding `"snoozes": []` surviving as an array and breaking every
	// lookup. Same guard, same reason.
	object := func(key string) *js.Value {
		value := parsed.Get(key)
		if value == nil || !value.IsObject() {
			return js.Obj()
		}
		return value
	}
	return Decisions{
		Aliases: object("aliases"),
		Series:  object("series"),
		Snoozes: object("snoozes"),
	}
}

// LoadSnoozes returns the `snoozes` map from the ledger, or an empty object.
//
// A missing or malformed ledger is an empty one, never an error — matching
// parseDecisions() in lib/archiveAudit.js. The alternative is a reporting tool
// that refuses to run because of a file it only consults.
func LoadSnoozes(privateRoot string) *js.Value { return LoadDecisions(privateRoot).Snoozes }
