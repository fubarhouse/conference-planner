package curation

// The curation ledger's WRITE side, and the store that keeps it alive across
// deploys.
//
// A port of the ledger half of lib/archiveAudit.js plus the `decisionsStore`
// in server.js.
//
// The ledger is S3-first for the reason planners and uploads are: on a container
// filesystem, a decision made between two syncs does not survive the next
// deploy. Reconciliation is slow human work and this file is its only record —
// the datasets are never rewritten — so it is written through on every decision
// and read back on every request, rather than left for the bulk sync to notice.
//
// Local disk keeps a mirror: it is the fallback when S3 is not configured or is
// unreachable, and — because the read falls back to it — it is also how an
// existing on-disk ledger migrates into S3 on the first write.

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/js"
	"server/internal/storage"
	"strings"
	"sync"
)

// Ledger is the mutable ledger: the four maps a decision can land in.
//
// Held as ordered *Values rather than Go maps because it is serialised back to
// the same file the JavaScript reads and writes, and key order is part of that
// file's identity.
type Ledger struct {
	Aliases  *js.Value // fingerprint → canonical display name
	Distinct *js.Value // array of cluster keys ruled "genuinely not the same"
	Snoozes  *js.Value // "<file>::<check>" → { state, until, note }
	Series   *js.Value // event file → the series it belongs to
}

// ParseLedger is a tolerant parse — a missing or malformed ledger is an empty
// one, never an error.
func ParseLedger(raw string) *Ledger {
	empty := &Ledger{Aliases: js.Obj(), Distinct: js.Arr(), Snoozes: js.Obj(), Series: js.Obj()}
	parsed, err := js.ParseJSON([]byte(raw))
	if err != nil {
		return empty
	}
	// An ARRAY is typeof 'object' and truthy in JavaScript, so a ledger holding
	// `"series": []` would otherwise survive as an array and break every lookup
	// on it. Same guard, same reason.
	object := func(key string) *js.Value {
		value := parsed.Get(key)
		if value == nil || !value.IsObject() {
			return js.Obj()
		}
		return value
	}
	distinct := parsed.Get("distinct")
	if !distinct.IsArray() {
		distinct = js.Arr()
	}
	return &Ledger{
		Aliases:  object("aliases"),
		Distinct: distinct,
		Snoozes:  object("snoozes"),
		Series:   object("series"),
	}
}

// Serialize writes the ledger the way the JavaScript does, key order and
// trailing newline included.
func (l *Ledger) Serialize() string {
	document := js.Obj().
		Set("aliases", orEmptyObject(l.Aliases)).
		Set("distinct", orEmptyArray(l.Distinct)).
		Set("snoozes", orEmptyObject(l.Snoozes)).
		Set("series", orEmptyObject(l.Series))
	return string(document.Encode("  ")) + "\n"
}

func orEmptyObject(v *js.Value) *js.Value {
	if v == nil {
		return js.Obj()
	}
	return v
}

func orEmptyArray(v *js.Value) *js.Value {
	if v == nil {
		return js.Arr()
	}
	return v
}

// DistinctKeys is the distinct list as strings, for the readers that want a set.
func (l *Ledger) DistinctKeys() []string {
	var out []string
	for _, key := range orEmptyArray(l.Distinct).Items() {
		out = append(out, key.Str())
	}
	return out
}

// Decisions returns the read-side view the builders take.
func (l *Ledger) Decisions() archive.Decisions {
	return archive.Decisions{
		Aliases: orEmptyObject(l.Aliases),
		Series:  orEmptyObject(l.Series),
		Snoozes: orEmptyObject(l.Snoozes),
	}
}

// Decision is one judgement to record.
type Decision struct {
	Type      string // alias | distinct | coverage | series
	Key       string
	Canonical string
	State     string // coverage: ignored | later, or "" to reopen
	Until     string
	Note      string
}

// Apply records one decision. Pure — takes a ledger, returns the next one.
func (l *Ledger) Apply(decision Decision) *Ledger {
	next := l.clone()
	switch {
	case decision.Type == "alias" && decision.Key != "":
		canonical := decision.Canonical
		if canonical == "" {
			canonical = decision.Key
		}
		next.Aliases.Set(decision.Key, js.Str(canonical))

	case decision.Type == "distinct" && decision.Key != "":
		for _, existing := range next.Distinct.Items() {
			if existing.Str() == decision.Key {
				return next
			}
		}
		next.Distinct.Append(js.Str(decision.Key))

	// A coverage decision with no state is the "open this back up" case: drop the
	// record rather than storing a third state meaning "never mind".
	case decision.Type == "coverage" && decision.Key != "":
		if decision.State == "" {
			next.Snoozes.Delete(decision.Key)
			break
		}
		record := js.Obj().Set("state", js.Str(decision.State))
		if decision.Until != "" {
			record.Set("until", js.Str(decision.Until))
		}
		if decision.Note != "" {
			record.Set("note", js.Str(decision.Note))
		}
		next.Snoozes.Set(decision.Key, record)

	// Clearing is sending no canonical — an event that belongs to no wider series
	// is the normal case, so it is an absence rather than a stored "none".
	case decision.Type == "series" && decision.Key != "":
		if decision.Canonical == "" {
			next.Series.Delete(decision.Key)
		} else {
			next.Series.Set(decision.Key, js.Str(decision.Canonical))
		}
	}
	return next
}

// Drop takes one decision back. Pure.
func (l *Ledger) Drop(decision Decision) *Ledger {
	next := l.clone()
	if decision.Key == "" {
		return next
	}
	switch decision.Type {
	case "alias":
		next.Aliases.Delete(decision.Key)
	case "distinct":
		kept := js.Arr()
		for _, existing := range next.Distinct.Items() {
			if existing.Str() != decision.Key {
				kept.Append(existing)
			}
		}
		next.Distinct = kept
	case "coverage":
		next.Snoozes.Delete(decision.Key)
	case "series":
		next.Series.Delete(decision.Key)
	}
	return next
}

// clone copies the ledger so Apply and Drop can stay pure, matching the object
// spreads in the JavaScript.
func (l *Ledger) clone() *Ledger {
	copyObject := func(source *js.Value) *js.Value {
		out := js.Obj()
		for _, key := range orEmptyObject(source).Keys() {
			out.Set(key, source.Get(key))
		}
		return out
	}
	distinct := js.Arr()
	for _, key := range orEmptyArray(l.Distinct).Items() {
		distinct.Append(key)
	}
	return &Ledger{
		Aliases:  copyObject(l.Aliases),
		Distinct: distinct,
		Snoozes:  copyObject(l.Snoozes),
		Series:   copyObject(l.Series),
	}
}

// CurationToken is a short content hash of the ledger.
//
// Content-addressed on purpose: every instance behind the load balancer derives
// the SAME token from the same bytes, which an mtime cannot promise and an S3
// ETag only promises while S3 is the source.
//
// Hashed through parse→serialize so the token names the DECISIONS, not the file:
// a re-indented ledger, and a missing one versus an empty one, are the same
// archive and must not look like two versions of it.
func CurationToken(text string) string {
	sum := sha1.Sum([]byte(ParseLedger(text).Serialize()))
	return hex.EncodeToString(sum[:])[:12]
}

// ── The store ───────────────────────────────────────────────────────────────

// DecisionStore reads and writes the ledger, S3-first when configured.
type DecisionStore struct {
	CurationRoot string
	Objects      storage.ObjectStore // nil when S3 is not configured
	S3Prefix     string
	Logger       *log.Logger

	mu sync.Mutex
}

func (d *DecisionStore) diskPath() string {
	return filepath.Join(d.CurationRoot, "decisions.json")
}

func (d *DecisionStore) objectKey() string {
	return strings.TrimSuffix(d.S3Prefix, "/") + "/curation/decisions.json"
}

// Read returns the ledger text, preferring S3.
//
// No object yet falls through to disk, which may hold decisions made before this
// became S3-first. The next write pushes them up.
func (d *DecisionStore) Read(ctx context.Context) string {
	if d.Objects != nil {
		body, _, err := d.Objects.Get(ctx, d.objectKey())
		switch {
		case err == nil:
			return string(body)
		case !storage.IsMissingObject(err):
			d.Warn("[s3] read unavailable (%v) — reading decisions from local disk", err)
		}
	}
	raw, err := os.ReadFile(d.diskPath())
	if err != nil {
		return ""
	}
	return string(raw)
}

// Write stores the ledger, S3 first and disk as a mirror.
func (d *DecisionStore) Write(ctx context.Context, text string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.Objects != nil {
		if _, err := d.Objects.Put(ctx, d.objectKey(), []byte(text), "application/json"); err == nil {
			// Best-effort mirror: a disk failure must never fail a decision that
			// S3 has already accepted.
			if err := d.writeDisk(text); err != nil {
				d.Warn("[disk] decisions mirror write failed: %v", err)
			}
			return nil
		} else if !storage.IsUnavailable(err) {
			return err
		} else {
			d.Warn("[s3] write unavailable (%v) — saving decisions to local disk", err)
		}
	}
	return d.writeDisk(text)
}

func (d *DecisionStore) writeDisk(text string) error {
	if err := os.MkdirAll(filepath.Dir(d.diskPath()), 0o755); err != nil {
		return err
	}
	return os.WriteFile(d.diskPath(), []byte(text), 0o644)
}

func (d *DecisionStore) Warn(format string, args ...any) {
	if d.Logger != nil {
		d.Logger.Printf(format, args...)
	}
}

// Save records a decision and returns the ledger it produced.
func (d *DecisionStore) Save(ctx context.Context, decision Decision) (*Ledger, error) {
	next := ParseLedger(d.Read(ctx)).Apply(decision)
	return next, d.Write(ctx, next.Serialize())
}

// Remove takes a decision back and returns the ledger it produced.
func (d *DecisionStore) Remove(ctx context.Context, decision Decision) (*Ledger, error) {
	next := ParseLedger(d.Read(ctx)).Drop(decision)
	return next, d.Write(ctx, next.Serialize())
}
