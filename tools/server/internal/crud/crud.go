package crud

// A Go port of the registry-driven CRUD engine — lib/resourceRegistry.js and the
// document mutations in lib/crudApi.js.
//
// One set of operations serves both domains (event datasets, per-user planners)
// and every nested collection, by read-modify-writing the parent document. The
// registry is what makes that possible: each entry maps a URL sub-path to a
// location inside the document and says how to mint an id for a new element.
//
// This is the first slice that WRITES. Everything ported before it produced a
// report, where a mistake is a wrong number on a page; here a mistake is a
// corrupted dataset. So the test does not compare a rendering — it performs the
// same mutation through both implementations and compares the resulting files
// byte for byte.

import (
	"errors"
	"regexp"
	"server/internal/ids"
	"server/internal/js"
	"sort"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

// Domain is which document family a collection lives in.
type Domain string

const (
	DomainDataset Domain = "dataset"
	DomainPlanner Domain = "planner"
)

// MintKind is how a created element gets its id.
type MintKind int

const (
	// MintRandom is makeId(prefix) — `t_1783_ab12`.
	MintRandom MintKind = iota
	// MintSlug is slugId(title) — sponsors key off a slug of their title so the
	// id is meaningful and stable across re-imports.
	MintSlug
)

// Collection describes one addressable array inside a document.
type Collection struct {
	Domain   Domain
	Key      string   // URL sub-path, may contain slashes
	Pointer  []string // property path to the array
	Mint     MintKind
	IDPrefix string
}

func plannerCollection(key string, pointer []string, prefix string) Collection {
	return Collection{Domain: DomainPlanner, Key: key, Pointer: pointer,
		Mint: MintRandom, IDPrefix: prefix}
}

// Registry is every collection the API addresses.
//
// Event `items` (sessions) are excluded on purpose: they have no stable id, so
// per-element CRUD would need a schema and data migration first.
var Registry = []Collection{
	// Sponsors are the only id-addressable nested collection in a dataset.
	{Domain: DomainDataset, Key: "sponsors", Pointer: []string{"event", "sponsors"},
		Mint: MintSlug, IDPrefix: "sponsor"},

	plannerCollection("contacts", []string{"contacts"}, "c"),
	plannerCollection("tasks", []string{"tasks"}, "t"),
	plannerCollection("receipts", []string{"receipts"}, "rc"),

	plannerCollection("personal/outbound-legs", []string{"personal", "outboundLegs"}, "leg"),
	plannerCollection("personal/return-legs", []string{"personal", "returnLegs"}, "leg"),
	plannerCollection("personal/accommodations", []string{"personal", "accommodations"}, "ia"),
	plannerCollection("personal/note-list", []string{"personal", "noteList"}, "note"),
	plannerCollection("personal/tracked-sessions", []string{"personal", "trackedSessions"}, "ts"),
	plannerCollection("personal/itinerary", []string{"personal", "itinerary"}, "it"),
	plannerCollection("personal/documents", []string{"personal", "documents"}, "doc"),
	plannerCollection("personal/budget-items", []string{"personal", "budgetItems"}, "bi"),
	plannerCollection("personal/tickets", []string{"personal", "tickets"}, "tk"),
	plannerCollection("personal/trip-assignments", []string{"personal", "tripAssignments"}, "ta"),
	plannerCollection("personal/local-companions", []string{"personal", "localCompanions"}, "lc"),

	plannerCollection("org/accommodations", []string{"org", "accommodations"}, "ia"),
	plannerCollection("org/swag", []string{"org", "swag"}, "item"),
	plannerCollection("org/deliverables", []string{"org", "deliverables"}, "item"),
	plannerCollection("org/tracked-sessions", []string{"org", "trackedSessions"}, "ts"),
	plannerCollection("org/documents", []string{"org", "documents"}, "doc"),
	plannerCollection("org/budget-items", []string{"org", "budgetItems"}, "bi"),
	plannerCollection("org/tickets", []string{"org", "tickets"}, "tk"),
	plannerCollection("org/itinerary", []string{"org", "itinerary"}, "it"),
	plannerCollection("org/member-itinerary", []string{"org", "memberItinerary"}, "it"),
}

// CollectionKeys lists a domain's sub-paths, for docs and discovery.
func CollectionKeys(domain Domain) []string {
	var keys []string
	for _, entry := range Registry {
		if entry.Domain == domain {
			keys = append(keys, entry.Key)
		}
	}
	return keys
}

// SplitDocPath separates the `.json` document path from the nested resource
// path: "events/x.json/sponsors/acme" becomes the document and "sponsors/acme".
func SplitDocPath(rest string) (docPath, nested string, err error) {
	const marker = ".json"
	index := strings.Index(rest, marker)
	if index < 0 {
		return "", "", ErrNotADocumentPath
	}
	docPath = rest[:index+len(marker)]
	nested = strings.TrimPrefix(rest[index+len(marker):], "/")
	return docPath, nested, nil
}

// MatchCollection resolves a nested path to its descriptor and optional element
// id.
//
// The LONGEST registered key that the path starts with wins, because keys
// contain slashes: "personal/tracked-sessions/ts_1" must not match a
// hypothetical "personal" before it matches the real collection.
func MatchCollection(domain Domain, nested string) (*Collection, string, error) {
	var candidates []Collection
	for _, entry := range Registry {
		if entry.Domain != domain {
			continue
		}
		if nested == entry.Key || strings.HasPrefix(nested, entry.Key+"/") {
			candidates = append(candidates, entry)
		}
	}
	if len(candidates) == 0 {
		return nil, "", ErrUnknownCollection
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return len(candidates[i].Key) > len(candidates[j].Key)
	})
	best := candidates[0]
	if nested == best.Key {
		return &best, "", nil
	}
	return &best, nested[len(best.Key)+1:], nil
}

// ResolveArray navigates a pointer and returns the array there, or nil.
//
// Nil is not an error: it lets a caller tell "no such collection on this
// document" from "empty collection", which are different answers.
func ResolveArray(doc *js.Value, pointer []string) *js.Value {
	node := doc
	for _, segment := range pointer {
		if node == nil || !node.IsObject() {
			return nil
		}
		node = node.Get(segment)
	}
	if node.IsArray() {
		return node
	}
	return nil
}

// EnsureArray creates the intermediate objects and the array if they are
// absent, then returns it — so a collection can be populated even on a document
// that predates the field.
func EnsureArray(doc *js.Value, pointer []string) *js.Value {
	node := doc
	for _, segment := range pointer[:len(pointer)-1] {
		child := node.Get(segment)
		if child == nil || !child.IsObject() {
			child = js.Obj()
			node.Set(segment, child)
		}
		node = child
	}
	last := pointer[len(pointer)-1]
	array := node.Get(last)
	if !array.IsArray() {
		array = js.Arr()
		node.Set(last, array)
	}
	return array
}

// FindElement returns the index of the element with an id, or -1.
func FindElement(array *js.Value, id string) int {
	for i, element := range array.Items() {
		if element != nil && element.Get("id").Str() == id {
			return i
		}
	}
	return -1
}

// RemoveElement deletes by index.
func RemoveElement(array *js.Value, index int) { array.RemoveAt(index) }

// ReplaceElement overwrites by index.
func ReplaceElement(array *js.Value, index int, element *js.Value) { array.SetAt(index, element) }

// ── Ids ─────────────────────────────────────────────────────────────────────

var (
	slugCombining = regexp.MustCompile("[̀-ͯ]")
	slugNonAlnum  = regexp.MustCompile(`[^a-z0-9]+`)
	slugEdges     = regexp.MustCompile(`^-+|-+$`)
)

// SlugID mirrors slugId(): sponsors key off a slug of their title rather than a
// random id, matching what the editor's own normaliseSponsorId produces. A blank
// title falls back to a random id so a created sponsor always has a usable one.
func SlugID(text, fallbackPrefix string, now time.Time) string {
	lowered := strings.ToLower(text)
	decomposed := norm.NFKD.String(lowered)
	stripped := slugCombining.ReplaceAllString(decomposed, "")
	slug := slugEdges.ReplaceAllString(slugNonAlnum.ReplaceAllString(stripped, "-"), "")
	if slug == "" {
		if fallbackPrefix == "" {
			fallbackPrefix = "sponsor"
		}
		return ids.MakeID(fallbackPrefix, now)
	}
	return slug
}

// MintID gives a new element its id, following the collection's rule.
func (c *Collection) MintID(element *js.Value, now time.Time) string {
	if c.Mint == MintSlug {
		return SlugID(element.Get("title").Str(), c.IDPrefix, now)
	}
	return ids.MakeID(c.IDPrefix, now)
}

// ── Writing ─────────────────────────────────────────────────────────────────

// EncodeDocument renders a document the way the API persists it:
// `JSON.stringify(obj, null, 2) + '\n'`.
//
// Note that this does NOT preserve the file's own indent, unlike the archive
// tooling. That is not an oversight — the Node API round-trips through
// JSON.parse and JSON.stringify, so a one-space dataset saved through the API
// comes back two-space. Matching the API means matching that, and the tooling
// and the API genuinely do differ here.
func EncodeDocument(doc *js.Value) []byte {
	return append(doc.Encode("  "), '\n')
}

var (
	// ErrNotADocumentPath is a path with no `.json` in it.
	ErrNotADocumentPath = errors.New("path must reference a .json document")
	// ErrUnknownCollection is a nested path that matches no registry entry.
	ErrUnknownCollection = errors.New("unknown collection")
)
