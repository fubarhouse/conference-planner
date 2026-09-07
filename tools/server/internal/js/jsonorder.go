package js

// JSON that comes out byte-for-byte the way JSON.stringify(value, null, 2) put
// it in.
//
// This is the load-bearing detail of porting anything in this archive to Go.
// encoding/json sorts map keys alphabetically and escapes <, > and & — so a Go
// rewrite of a file the Node side writes produces a diff on every line even
// when every value is identical, and the two implementations can never be
// compared. Both properties matter here: catalog.json carries `kinds` in
// first-seen order, and event titles are full of ampersands.
//
// So values keep their order, scalars are copied verbatim from the source
// bytes, and the encoder escapes exactly what JavaScript escapes: the quote,
// the backslash, and control characters. Nothing else.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

type valueKind int

const (
	kindLiteral valueKind = iota // number, bool, null — kept as source text
	kindString
	kindObject
	kindArray
)

// Value is one JSON value that remembers the order it was written in.
type Value struct {
	kind valueKind

	keys []string
	obj  map[string]*Value
	arr  []*Value

	str string
	lit string
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

// Obj builds an empty object. Keys appear in the order Set is first called.
func Obj() *Value { return &Value{kind: kindObject, obj: map[string]*Value{}} }

// Arr builds an array.
func Arr(items ...*Value) *Value { return &Value{kind: kindArray, arr: items} }

// Str builds a string.
func Str(s string) *Value { return &Value{kind: kindString, str: s} }

// Int builds a number.
func Int(n int) *Value { return &Value{kind: kindLiteral, lit: strconv.Itoa(n)} }

// Bool builds a boolean.
func Bool(b bool) *Value { return &Value{kind: kindLiteral, lit: strconv.FormatBool(b)} }

// Null builds null. JavaScript writes `null` for an absent date here rather
// than omitting the key, and the client reads it, so it has to be emitted.
func Null() *Value { return &Value{kind: kindLiteral, lit: "null"} }

// orderedKeys returns an object's keys in the order JavaScript serialises them.
//
// This is not insertion order, and the difference is easy to miss: ES orders
// integer-like keys FIRST, ascending, and only then the rest in insertion
// order. `{ byYear: {} }` filled 2011, 2012, … 2007 comes back out of
// JSON.stringify as 2007, 2008, … 2011 — which is why every per-year map in the
// Observatory payload sorts itself without anyone asking.
//
// A Go map would have randomised these; insertion order would have been stably
// wrong. Both look right until they are diffed against the original.
func (v *Value) orderedKeys() []string {
	var indexes, rest []string
	for _, key := range v.keys {
		if IsArrayIndexKey(key) {
			indexes = append(indexes, key)
		} else {
			rest = append(rest, key)
		}
	}
	if len(indexes) == 0 {
		return v.keys
	}
	sort.Slice(indexes, func(i, j int) bool {
		a, _ := strconv.ParseUint(indexes[i], 10, 64)
		b, _ := strconv.ParseUint(indexes[j], 10, 64)
		return a < b
	})
	return append(indexes, rest...)
}

// IsArrayIndexKey applies the ECMAScript rule: a key is an array index when
// ToString(ToUint32(key)) === key and the value is below 2^32-1. So "2007"
// qualifies, "01" does not (it would stringify back as "1"), and neither does
// "-1" or "1.5".
func IsArrayIndexKey(key string) bool {
	if key == "" || len(key) > 10 {
		return false
	}
	if key != "0" && key[0] == '0' {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < 4294967295
}

// Set assigns a key, appending it if new and keeping its position if not.
func (v *Value) Set(key string, child *Value) *Value {
	if v.kind != kindObject {
		return v
	}
	if _, seen := v.obj[key]; !seen {
		v.keys = append(v.keys, key)
	}
	v.obj[key] = child
	return v
}

// Append adds to an array.
func (v *Value) Append(child *Value) { v.arr = append(v.arr, child) }

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

// Get returns a child of an object, or nil.
func (v *Value) Get(key string) *Value {
	if v == nil || v.kind != kindObject {
		return nil
	}
	return v.obj[key]
}

// Str returns the string value, or "" for anything else.
func (v *Value) Str() string {
	if v == nil || v.kind != kindString {
		return ""
	}
	return v.str
}

// Items returns array elements, or nil.
func (v *Value) Items() []*Value {
	if v == nil || v.kind != kindArray {
		return nil
	}
	return v.arr
}

// IsTrue reports whether the value is literally `true`.
func (v *Value) IsTrue() bool { return v != nil && v.kind == kindLiteral && v.lit == "true" }

// Bool returns the boolean value and whether it was one. The second result
// matters: `typeof x === 'boolean'` is load-bearing in sessionKind.js, where a
// present `false` means something different from an absent field.
func (v *Value) Bool() (bool, bool) {
	if v == nil || v.kind != kindLiteral || (v.lit != "true" && v.lit != "false") {
		return false, false
	}
	return v.lit == "true", true
}

// Number returns the numeric value and whether it is a finite number, matching
// Number.isFinite() — which is false for a string that looks like a number.
func (v *Value) Number() (float64, bool) {
	if v == nil || v.kind != kindLiteral {
		return 0, false
	}
	n, err := strconv.ParseFloat(v.lit, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	return n, true
}

// Text mirrors the archive's `text()` helper: String(value || ”).trim() is
// non-empty. Note that 0 and false are falsy in JS and so read as empty here.
func (v *Value) Text() bool {
	if v == nil {
		return false
	}
	switch v.kind {
	case kindString:
		return Trim(v.str) != ""
	case kindLiteral:
		switch v.lit {
		case "null", "false", "0":
			return false
		}
		if n, ok := v.Number(); ok && n == 0 {
			return false
		}
		return true
	}
	// Arrays and objects stringify to something non-empty ("[object Object]",
	// or the joined elements) — but nothing in the archive calls text() on one.
	return true
}

// Exists reports whether a value is present. `undefined` in the JS sense —
// pickEventFields skips a key whose value is undefined, but keeps an explicit
// null, so absence and null are different things here.
func (v *Value) Exists() bool { return v != nil }

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// ParseJSON decodes into an order-preserving tree.
func ParseJSON(data []byte) (*Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	value, err := parseFrom(dec, tok)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing data after top-level value")
	}
	return value, nil
}

func parseValue(dec *json.Decoder) (*Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return parseFrom(dec, tok)
}

func parseFrom(dec *json.Decoder, tok json.Token) (*Value, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			out := Obj()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				child, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.Set(key, child)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return out, nil
		case '[':
			out := Arr()
			for dec.More() {
				child, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.Append(child)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return out, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %q", t)
	case string:
		return Str(t), nil
	case json.Number:
		return &Value{kind: kindLiteral, lit: t.String()}, nil
	case bool:
		return Bool(t), nil
	case nil:
		return Null(), nil
	}
	return nil, fmt.Errorf("unsupported token %T", tok)
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

// Encode renders the tree exactly as JSON.stringify(value, null, indent) would.
//
// An EMPTY indent means compact — no newlines, no space after `:` or `,` —
// because that is what JSON.stringify(value) with no spacer produces. Emitting
// zero-indented but still line-broken JSON would look close enough to pass a
// glance and fail every byte comparison.
func (v *Value) Encode(indent string) []byte {
	var sb strings.Builder
	if indent == "" {
		encodeCompact(&sb, v)
	} else {
		encodeValue(&sb, v, indent, 0)
	}
	return []byte(sb.String())
}

func encodeCompact(sb *strings.Builder, v *Value) {
	switch v.kind {
	case kindString:
		encodeJSString(sb, v.str)
	case kindLiteral:
		sb.WriteString(v.lit)
	case kindObject:
		sb.WriteByte('{')
		for i, key := range v.orderedKeys() {
			if i > 0 {
				sb.WriteByte(',')
			}
			encodeJSString(sb, key)
			sb.WriteByte(':')
			encodeCompact(sb, v.obj[key])
		}
		sb.WriteByte('}')
	case kindArray:
		sb.WriteByte('[')
		for i, child := range v.arr {
			if i > 0 {
				sb.WriteByte(',')
			}
			encodeCompact(sb, child)
		}
		sb.WriteByte(']')
	}
}

func encodeValue(sb *strings.Builder, v *Value, indent string, depth int) {
	switch v.kind {
	case kindString:
		encodeJSString(sb, v.str)
	case kindLiteral:
		sb.WriteString(v.lit)
	case kindObject:
		if len(v.keys) == 0 {
			sb.WriteString("{}")
			return
		}
		keys := v.orderedKeys()
		sb.WriteString("{\n")
		for i, key := range keys {
			writeIndent(sb, indent, depth+1)
			encodeJSString(sb, key)
			sb.WriteString(": ")
			encodeValue(sb, v.obj[key], indent, depth+1)
			if i < len(keys)-1 {
				sb.WriteByte(',')
			}
			sb.WriteByte('\n')
		}
		writeIndent(sb, indent, depth)
		sb.WriteByte('}')
	case kindArray:
		if len(v.arr) == 0 {
			sb.WriteString("[]")
			return
		}
		sb.WriteString("[\n")
		for i, child := range v.arr {
			writeIndent(sb, indent, depth+1)
			encodeValue(sb, child, indent, depth+1)
			if i < len(v.arr)-1 {
				sb.WriteByte(',')
			}
			sb.WriteByte('\n')
		}
		writeIndent(sb, indent, depth)
		sb.WriteByte(']')
	}
}

func writeIndent(sb *strings.Builder, indent string, depth int) {
	for i := 0; i < depth; i++ {
		sb.WriteString(indent)
	}
}

// encodeJSString escapes what JSON.stringify escapes and nothing more.
func encodeJSString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// StrVal mirrors str() from lib/archiveAudit.js: a string is trimmed, null and
// absent become "", and anything else is stringified first.
//
// Deliberately NOT the same as Text(): str(0) is "0" and therefore truthy to
// has(), while text(0) is false because it models String(value || ”). The two
// helpers coexist in the JavaScript and the difference is load-bearing wherever
// a numeric field is tested for presence.
func (v *Value) StrVal() string {
	if v == nil {
		return ""
	}
	switch v.kind {
	case kindString:
		return Trim(v.str)
	case kindLiteral:
		if v.lit == "null" {
			return ""
		}
		return Trim(v.lit)
	}
	return ""
}

// Raw is the value's source text, UNTRIMMED: a string's contents, or a
// literal's digits. "" for null, arrays, objects and absent values.
//
// Distinct from StrVal, which trims — and the distinction matters in both
// directions. A hash compared for equality must not be trimmed, and a year read
// for display must not be either, because trimming is a behaviour the JavaScript
// applies in some places and not others.
func (v *Value) Raw() string {
	if v == nil {
		return ""
	}
	switch v.kind {
	case kindString:
		return v.str
	case kindLiteral:
		if v.lit == "null" {
			return ""
		}
		return v.lit
	}
	return ""
}

// Has mirrors has() from lib/archiveAudit.js.
func (v *Value) Has() bool { return v.StrVal() != "" }

// Trim is String.prototype.trim().
//
// Not strings.TrimSpace, and the difference is one real character in this
// archive: a talk titled "Intro to Singularity Grid System" ends with U+FEFF,
// which JavaScript's WhiteSpace production includes and Go's unicode.IsSpace
// does not. The reverse also holds — Go trims U+0085 (NEL) and JavaScript does
// not — so neither is a superset of the other and neither can substitute.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ',
		0x00A0, // NBSP
		0xFEFF, // ZWNBSP / BOM
		0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// IsArray reports whether the value is an array. `Array.isArray(x)` in the
// original, where an absent field and a field holding a string must both read
// as "no list here" rather than throwing.
func (v *Value) IsArray() bool { return v != nil && v.kind == kindArray }

// delete removes a key, keeping the order of the rest. `delete obj.k` in the
// original, which the suggestion queue uses to take a decision back.
func (v *Value) delete(key string) {
	if v == nil || v.kind != kindObject {
		return
	}
	if _, present := v.obj[key]; !present {
		return
	}
	delete(v.obj, key)
	for i, existing := range v.keys {
		if existing == key {
			v.keys = append(v.keys[:i], v.keys[i+1:]...)
			return
		}
	}
}

// ── Type predicates ─────────────────────────────────────────────────────────
//
// The kind is private, so callers ask questions about a value rather than
// comparing its representation. Each of these has a nil case that answers the
// same as the absent-value case, because a missing key and a key holding the
// wrong type are the same thing to every caller here: not what I asked for.

// IsObject reports whether this is a JSON object.
//
// Note what it excludes. An ARRAY is `typeof 'object'` in JavaScript, so the
// ledger and the feed records both guard with this rather than a truthiness
// check — a stored `"snoozes": []` would otherwise survive as an array and
// break every lookup on it.
func (v *Value) IsObject() bool { return v != nil && v.kind == kindObject }

// IsString reports whether this is a JSON string.
func (v *Value) IsString() bool { return v != nil && v.kind == kindString }

// IsNumber reports whether this is a JSON number — a literal that is not `true`,
// `false` or `null`.
func (v *Value) IsNumber() bool {
	if v == nil || v.kind != kindLiteral {
		return false
	}
	switch v.lit {
	case "true", "false", "null":
		return false
	}
	return true
}

// IsNull reports whether this is JSON `null`, as distinct from absent.
func (v *Value) IsNull() bool { return v != nil && v.kind == kindLiteral && v.lit == "null" }

// Keys is the object's keys in the order they will be encoded.
//
// A copy: the slice is the document's own ordering, and a caller ranging over it
// while writing to the document would otherwise be mutating what it is reading.
func (v *Value) Keys() []string {
	if !v.IsObject() {
		return nil
	}
	out := make([]string, len(v.keys))
	copy(out, v.keys)
	return out
}

// Len is the number of items in an array, or of keys in an object.
func (v *Value) Len() int {
	if v == nil {
		return 0
	}
	switch v.kind {
	case kindArray:
		return len(v.arr)
	case kindObject:
		return len(v.keys)
	}
	return 0
}

// Delete removes a key, keeping the order of the rest.
func (v *Value) Delete(key string) { v.delete(key) }

// ── JavaScript coercion ─────────────────────────────────────────────────────
//
// These live here rather than beside their callers because they need the
// representation: what `String(x)` and `if (x)` do to a value depends on its
// type, and the type is private.

// String is String(value) for the shapes a session field can hold. An ARRAY
// joins with commas — `track` is an array in every dataset, and String(['a','b'])
// is "a,b", which is what ends up in the description.
func String(v *Value) string {
	if v == nil {
		return ""
	}
	switch v.kind {
	case kindString:
		return v.str
	case kindLiteral:
		if v.lit == "null" {
			return ""
		}
		return v.lit
	case kindArray:
		parts := make([]string, 0, len(v.arr))
		for _, item := range v.arr {
			parts = append(parts, String(item))
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// Truthy is JavaScript truthiness: everything is true except null, undefined,
// false, 0, NaN and the empty string. Arrays and objects are ALWAYS true,
// however empty they are, which is the whole point of having this rather than
// testing the stringified value.
func Truthy(v *Value) bool {
	if v == nil {
		return false
	}
	switch v.kind {
	case kindString:
		return v.str != ""
	case kindLiteral:
		if v.lit == "null" || v.lit == "false" {
			return false
		}
		if n, ok := v.Number(); ok {
			return n != 0
		}
		return true
	}
	return true // arrays and objects
}

// RemoveAt deletes the element at an index.
func (v *Value) RemoveAt(index int) {
	if !v.IsArray() || index < 0 || index >= len(v.arr) {
		return
	}
	v.arr = append(v.arr[:index], v.arr[index+1:]...)
}

// SetAt overwrites the element at an index.
func (v *Value) SetAt(index int, element *Value) {
	if !v.IsArray() || index < 0 || index >= len(v.arr) {
		return
	}
	v.arr[index] = element
}

// Literal builds a number from source text that the CALLER has already
// rendered.
//
// The rendering stays with the caller on purpose. Two places in this codebase
// format a float for JSON and they disagree — one uses 'f' and one uses 'g' —
// because each matches a different JavaScript call site, and collapsing them
// into one constructor here would silently change one of the two. This holds the
// representation; what the digits should be is domain knowledge.
func Literal(text string) *Value { return &Value{kind: kindLiteral, lit: text} }
