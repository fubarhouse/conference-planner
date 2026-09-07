package curation

// A Go port of lib/suggestions.js — "tell us about a conference", and the queue
// an editor works through afterwards.
//
// The archive is nineteen years of events that somebody had to know about
// first. This is the box that lets a reader say "you're missing this one"
// without finding an email address.
//
// It lives in CURATION_ROOT rather than getting a root of its own: that
// directory already syncs under the `data/curation/` prefix, and the bucket
// layout should not gain a new top-level prefix for a single JSON file. A lead
// is curation input — it belongs next to the decisions it will turn into. It is
// also PRIVATE: a suggestion carries whatever a stranger chose to type,
// including an email address if they put one in the notes.

import (
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/archive"
	"server/internal/ids"
	"server/internal/js"
	"strings"
	"time"
)

// Free text is capped so one submission cannot become a denial-of-service on
// the reviewer's screen — or on the file. 256 is enough for "it's at $URL, mail
// me at x@y for the programme", which is what the field is for.
const (
	LimitName  = 120
	LimitURL   = 300
	LimitNotes = 256
)

var identityKinds = map[string]bool{"speaker": true, "sponsor": true, "person": true}

var (
	controlChars  = regexp.MustCompile("[\x00-\x1f\x7f]")
	whitespaceRun = regexp.MustCompile(`\s+`)
	schemePrefix  = regexp.MustCompile(`(?i)^([a-z][a-z0-9+.-]*):[/\\]*`)
)

// KindOf reports which sort of suggestion a row is. Rows written before `kind`
// existed are all conference leads.
func KindOf(item *js.Value) string {
	if item.Get("kind").Str() == "identity" {
		return "identity"
	}
	return "event"
}

// CleanField normalises one submitted field: collapse whitespace, strip control
// characters, truncate.
//
// Control characters are removed rather than rejected — a stray one is almost
// always a paste artefact, and refusing the whole submission over it would lose
// a real lead to punish a typo.
func CleanField(value string, max int) string {
	cleaned := controlChars.ReplaceAllString(value, " ")
	cleaned = strings.TrimSpace(whitespaceRun.ReplaceAllString(cleaned, " "))
	return archive.FirstRunes(cleaned, max)
}

// SafeURL returns a URL worth storing, or "".
//
// Only http(s) survives. `javascript:` and `data:` are the reason: this string
// is rendered as a link in the curation tool, and an editor clicking a lead
// should not be able to run a stranger's script. A bare host is upgraded rather
// than refused, because "drupaljam.nl" is what people actually type.
func SafeURL(value string) string {
	raw := CleanField(value, LimitURL)
	if raw == "" {
		return ""
	}
	// `new URL()` tolerates any run of slashes (or backslashes) after the scheme
	// of an http(s) URL and treats them all as the authority separator, so
	// "//example.org" and "https:///example.org" both name a host. Go's parser
	// reads the extras as a path and reports no host at all, so the run is
	// normalised to exactly "//" before parsing.
	var candidate string
	if match := schemePrefix.FindStringSubmatch(raw); match != nil {
		scheme := strings.ToLower(match[1])
		if scheme != "http" && scheme != "https" {
			return ""
		}
		candidate = scheme + "://" + raw[len(match[0]):]
	} else {
		candidate = "https://" + strings.TrimLeft(raw, `/\`)
	}
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	// `URL.href` normalises: a bare host gains a trailing slash, and the scheme
	// and host are lowercased. Reproduced so a lead stored by either
	// implementation reads the same.
	return archive.FirstRunes(normalisedHref(parsed), LimitURL)
}

func normalisedHref(parsed *url.URL) string {
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String()
}

// SuggestionInput is a submitted conference lead.
type SuggestionInput struct{ Name, URL, Notes string }

// IdentityInput is a proposed identity mapping.
type IdentityInput struct{ Type, From, To, Notes string }

// ValidateSuggestion cleans a submission or explains why it cannot be stored.
func ValidateSuggestion(input SuggestionInput) (SuggestionInput, string) {
	cleaned := SuggestionInput{
		Name:  CleanField(input.Name, LimitName),
		URL:   SafeURL(input.URL),
		Notes: CleanField(input.Notes, LimitNotes),
	}
	if cleaned.Name == "" {
		return cleaned, "A conference name is required."
	}
	// Something has to be followable. A name with no link and no note is a lead
	// nobody can act on, and it would sit in the queue forever.
	if cleaned.URL == "" && cleaned.Notes == "" {
		return cleaned, "Add a link or a note so this can be followed up."
	}
	if input.URL != "" && cleaned.URL == "" {
		return cleaned, "That link could not be read as a web address."
	}
	return cleaned, ""
}

// ValidateIdentitySuggestion checks a proposed mapping.
//
// This is a PROPOSAL, not a decision: nothing is aliased until an editor
// approves it, so validation only has to establish that the claim is
// well-formed and could mean something.
func ValidateIdentitySuggestion(input IdentityInput) (IdentityInput, string) {
	cleaned := IdentityInput{
		Type:  strings.TrimSpace(input.Type),
		From:  CleanField(input.From, LimitName),
		To:    CleanField(input.To, LimitName),
		Notes: CleanField(input.Notes, LimitNotes),
	}
	if !identityKinds[cleaned.Type] {
		return cleaned, "Unknown identity type."
	}
	if cleaned.From == "" || cleaned.To == "" {
		return cleaned, "Both names are required."
	}
	// Mapping a name onto itself is a no-op that would sit in the queue looking
	// like work. Case and punctuation differences ARE meaningful — "gábor
	// hojtsy" onto "Gábor Hojtsy" is the whole point — so only an exact match
	// is rejected.
	if cleaned.From == cleaned.To {
		return cleaned, "That is already the same name."
	}
	return cleaned, ""
}

// SuggestionStore is the queue on disk.
type SuggestionStore struct {
	Dir string // CURATION_ROOT
	Now func() time.Time
}

func (s *SuggestionStore) path() string { return filepath.Join(s.Dir, "suggestions.json") }

func (s *SuggestionStore) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// List returns the queue, newest first. No file yet is the normal first run,
// not an error.
func (s *SuggestionStore) List() *js.Value {
	raw, err := os.ReadFile(s.path())
	if err != nil {
		return js.Arr()
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return js.Arr()
	}
	items := parsed.Get("items")
	if !items.IsArray() {
		return js.Arr()
	}
	return items
}

func (s *SuggestionStore) save(items *js.Value) error {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return err
	}
	document := js.Obj().Set("items", items)
	return os.WriteFile(s.path(), append(document.Encode("  "), '\n'), 0o644)
}

// append records a row at the top — the queue is read from there.
func (s *SuggestionStore) append(fields *js.Value, by string) (*js.Value, error) {
	item := js.Obj().Set("id", js.Str(ids.MakeID("tip", s.now())))
	for _, key := range fields.Keys() {
		item.Set(key, fields.Get(key))
	}
	item.Set("status", js.Str("new"))
	item.Set("at", js.Str(archive.ISOMillis(s.now())))
	if by != "" {
		item.Set("by", js.Str(by))
	}

	items := s.List()
	next := js.Arr(item)
	for _, existing := range items.Items() {
		next.Append(existing)
	}
	return item, s.save(next)
}

// Add records a conference lead.
func (s *SuggestionStore) Add(input SuggestionInput, by string) (*js.Value, string, error) {
	cleaned, problem := ValidateSuggestion(input)
	if problem != "" {
		return nil, problem, nil
	}
	item, err := s.append(js.Obj().
		Set("kind", js.Str("event")).
		Set("name", js.Str(cleaned.Name)).
		Set("url", js.Str(cleaned.URL)).
		Set("notes", js.Str(cleaned.Notes)), by)
	return item, "", err
}

// AddIdentity records a proposed mapping for review.
//
// `name` carries the from-name so every queue row — lead or mapping — has one
// field to show as its headline, and the list, filter and badge code needs no
// special case.
func (s *SuggestionStore) AddIdentity(input IdentityInput, by string) (item *js.Value, duplicate bool, problem string, err error) {
	cleaned, problem := ValidateIdentitySuggestion(input)
	if problem != "" {
		return nil, false, problem, nil
	}

	// The same claim twice is one claim. Without this, clicking Map twice — or
	// a reader repeating what somebody already proposed — puts two identical
	// rows in front of the reviewer.
	for _, existing := range s.List().Items() {
		if KindOf(existing) == "identity" &&
			existing.Get("status").Str() == "new" &&
			existing.Get("idType").Str() == cleaned.Type &&
			existing.Get("name").Str() == cleaned.From &&
			existing.Get("to").Str() == cleaned.To {
			return existing, true, "", nil
		}
	}

	created, err := s.append(js.Obj().
		Set("kind", js.Str("identity")).
		Set("idType", js.Str(cleaned.Type)).
		Set("name", js.Str(cleaned.From)).
		Set("to", js.Str(cleaned.To)).
		Set("url", js.Str("")).
		Set("notes", js.Str(cleaned.Notes)), by)
	return created, false, "", err
}

// Decide actions or dismisses one lead.
//
// A decision is recorded, never deleted. "Dismissed" is an answer — it says
// somebody looked — and losing it means the next reviewer re-reads the same
// lead. Re-deciding is allowed so a dismissal can be taken back.
func (s *SuggestionStore) Decide(id, status, by string) (*js.Value, string, error) {
	switch status {
	case "new", "actioned", "dismissed":
	default:
		return nil, "Unknown status.", nil
	}

	items := s.List()
	var item *js.Value
	for _, candidate := range items.Items() {
		if candidate.Get("id").Str() == id {
			item = candidate
			break
		}
	}
	if item == nil {
		return nil, "No such suggestion.", nil
	}

	item.Set("status", js.Str(status))
	if status == "new" {
		item.Delete("decidedAt")
		item.Delete("decidedBy")
	} else {
		item.Set("decidedAt", js.Str(archive.ISOMillis(s.now())))
		if by != "" {
			item.Set("decidedBy", js.Str(by))
		}
	}
	return item, "", s.save(items)
}

// OpenCount is how many are waiting — the number the curation tab badges.
func (s *SuggestionStore) OpenCount() int {
	count := 0
	for _, item := range s.List().Items() {
		if item.Get("status").Str() == "new" {
			count++
		}
	}
	return count
}
