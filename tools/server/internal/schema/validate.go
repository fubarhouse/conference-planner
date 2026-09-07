package schema

// Schema validation for the write path — a Go equivalent of
// lib/validateDataset.js and lib/validatePlanner.js.
//
// The API validates before it persists, so this is what stands between a bad
// request and a corrupted dataset. It is held to a different standard from the
// rest of the port, and the difference is worth stating plainly:
//
//   - the VERDICT must match ajv's, over every file in the archive and over
//     deliberately-broken variants of them. validate_test.go checks that.
//   - the error TEXT cannot match. ajv's messages are ajv's; another
//     implementation words them differently and no amount of effort makes
//     "must have required property 'title'" come out of a different library.
//
// So the errors this returns carry the same SHAPE — a dot path, a message, a
// keyword — and callers that display them will show different prose. A CI job
// that keys off `valid` is unaffected; one that string-matches a message was
// always coupled to a library version.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// errorPrinter localises the library's messages. It needs a real printer —
// passing nil panics inside x/text.
var errorPrinter = message.NewPrinter(language.English)

// ValidationError is one problem with a document.
type ValidationError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	Keyword string `json:"keyword,omitempty"`
}

// ValidationResult is the verdict and every problem found.
type ValidationResult struct {
	Valid  bool              `json:"valid"`
	Errors []ValidationError `json:"errors"`
}

// Validator holds a compiled schema and its fingerprint.
type Validator struct {
	schema      *jsonschema.Schema
	Fingerprint string
	err         error
}

// SchemaSet is the validators the API needs, compiled once.
type SchemaSet struct {
	Datasets *Validator
	Planners *Validator
	// The editor saves these two through the same route as a dataset, and each
	// has its own schema — see ValidateDataFile.
	Themes   *Validator
	Sponsors *Validator
}

// byFile finds a compiled schema by its file name.
func (s *SchemaSet) byFile(name string) *Validator {
	if s == nil {
		return nil
	}
	switch name {
	case "themes.schema.json":
		return s.Themes
	case "sponsors.schema.json":
		return s.Sponsors
	case "planner.schema.json":
		return s.Planners
	case "event.schema.json":
		return s.Datasets
	}
	return nil
}

var (
	schemaOnce sync.Once
	schemas    *SchemaSet
)

// LoadSchemas compiles the schemas from an app root, once per process.
func LoadSchemas(appRoot string) *SchemaSet {
	schemaOnce.Do(func() {
		schemas = &SchemaSet{
			Datasets: compileSchema(filepath.Join(appRoot, "schemas", "event.schema.json")),
			Planners: compileSchema(filepath.Join(appRoot, "schemas", "planner.schema.json")),
			Themes:   compileSchema(filepath.Join(appRoot, "schemas", "themes.schema.json")),
			Sponsors: compileSchema(filepath.Join(appRoot, "schemas", "sponsors.schema.json")),
		}
	})
	return schemas
}

func compileSchema(path string) *Validator {
	raw, err := os.ReadFile(path)
	if err != nil {
		return &Validator{err: err}
	}

	// The fingerprint is a hash of the FILE BYTES, so a reformat counts as a
	// change. That is the conservative direction, and it is what the JavaScript
	// hashes — a data repo pins this value, and a mismatch has to mean "look",
	// not "probably fine".
	sum := sha256.Sum256(raw)
	fingerprint := hex.EncodeToString(sum[:])[:12]

	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return &Validator{err: err, Fingerprint: fingerprint}
	}

	compiler := jsonschema.NewCompiler()
	// ajv-formats makes `format` an ASSERTION rather than an annotation, and the
	// schemas rely on that: date, date-time and uri are constraints here, not
	// documentation. Without this a malformed startDate would validate.
	compiler.AssertFormat()
	if err := compiler.AddResource("schema.json", document); err != nil {
		return &Validator{err: err, Fingerprint: fingerprint}
	}
	compiled, err := compiler.Compile("schema.json")
	return &Validator{schema: compiled, Fingerprint: fingerprint, err: err}
}

// Validate checks a document.
//
// A schema that failed to compile is reported as a validation failure rather
// than silently passing everything: an API that cannot validate must not accept
// writes, because "we could not check" and "it is fine" are not the same answer.
func (v *Validator) Validate(document *js.Value) ValidationResult {
	if v == nil || v.err != nil {
		message := "schema unavailable"
		if v != nil && v.err != nil {
			message = "schema unavailable: " + v.err.Error()
		}
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Path: "(root)", Message: message, Keyword: "schema"},
		}}
	}

	// The library validates Go values, so the document goes through
	// encoding/json here. That is safe in a way it would not be for WRITING:
	// key order and scalar formatting do not affect what a schema says, and
	// nothing from this path is ever persisted.
	var decoded any
	if err := json.Unmarshal(document.Encode(""), &decoded); err != nil {
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Path: "(root)", Message: "document is not valid JSON", Keyword: "parse"},
		}}
	}

	if err := v.schema.Validate(decoded); err != nil {
		var validationErr *jsonschema.ValidationError
		if ok := asValidationError(err, &validationErr); ok {
			return ValidationResult{Valid: false, Errors: flattenErrors(validationErr)}
		}
		return ValidationResult{Valid: false, Errors: []ValidationError{
			{Path: "(root)", Message: err.Error()},
		}}
	}
	return ValidationResult{Valid: true, Errors: []ValidationError{}}
}

func asValidationError(err error, target **jsonschema.ValidationError) bool {
	validationErr, ok := err.(*jsonschema.ValidationError)
	if ok {
		*target = validationErr
	}
	return ok
}

// flattenErrors walks the causes tree and returns the leaves, which are the
// specific failures rather than the "doesn't match the schema" summaries above
// them.
func flattenErrors(err *jsonschema.ValidationError) []ValidationError {
	var out []ValidationError
	var walk func(node *jsonschema.ValidationError)
	walk = func(node *jsonschema.ValidationError) {
		if len(node.Causes) == 0 {
			out = append(out, ValidationError{
				Path:    ErrorPath(node.InstanceLocation),
				Message: node.ErrorKind.LocalizedString(errorPrinter),
				Keyword: keywordOf(node),
			})
			return
		}
		for _, cause := range node.Causes {
			walk(cause)
		}
	}
	walk(err)
	if out == nil {
		out = []ValidationError{}
	}
	return out
}

var numericSegment = regexp.MustCompile(`^\d+$`)

// ErrorPath renders an instance location the way the callers already speak it:
// ajv 6's dot form, ".items[3].title", which the CLI, the API payloads and the
// editor all expect. ajv 8 emits a JSON Pointer and the JavaScript rebuilds the
// dot form from it; this does the same from the location segments.
func ErrorPath(location []string) string {
	if len(location) == 0 {
		return "(root)"
	}
	var out strings.Builder
	for _, segment := range location {
		if numericSegment.MatchString(segment) {
			out.WriteString("[" + segment + "]")
			continue
		}
		out.WriteString("." + segment)
	}
	return out.String()
}

func keywordOf(node *jsonschema.ValidationError) string {
	// The keyword is the last segment of the schema location — good enough for
	// the shape callers expect, and honest about where it came from.
	location := node.SchemaURL
	if index := strings.LastIndex(location, "/"); index >= 0 {
		return location[index+1:]
	}
	return ""
}

// Value renders a result the way the API returns it.
func (r ValidationResult) Value() *js.Value {
	errors := js.Arr()
	for _, item := range r.Errors {
		entry := js.Obj().Set("path", js.Str(item.Path)).Set("message", js.Str(item.Message))
		if item.Keyword != "" {
			entry.Set("keyword", js.Str(item.Keyword))
		}
		errors.Append(entry)
	}
	return js.Obj().Set("valid", js.Bool(r.Valid)).Set("errors", errors)
}

func (r ValidationResult) String() string {
	if r.Valid {
		return "valid"
	}
	return fmt.Sprintf("invalid (%d error(s))", len(r.Errors))
}

// ── Picking a schema by path ────────────────────────────────────────────────
//
// A port of lib/validateDataFile.js. `/api/data/*` is not only event datasets:
// the editor also saves themes.json and sponsors.json, which have their own
// schemas. Validating everything as an event would reject those outright and
// break saving from the editor.

// byBasename are the files with a schema of their own.
var byBasename = map[string]string{
	"themes.json":   "themes.schema.json",
	"sponsors.json": "sponsors.schema.json",
}

// generatedFiles are derived artifacts — no authored schema to hold them to.
// Holding them to the event schema would reject legitimate writes.
var generatedFiles = map[string]bool{
	"catalog.json": true, "geocache.json": true, "album-thumbs.json": true,
}

// DataFileResult is a validation with the schema that produced it.
type DataFileResult struct {
	ValidationResult
	Schema  string
	Skipped bool
}

// ValidateDataFile picks the right schema for a path under the data root and
// validates against it.
func (s *SchemaSet) ValidateDataFile(relPath string, document *js.Value) DataFileResult {
	base := relPath
	if index := strings.LastIndex(base, "/"); index >= 0 {
		base = base[index+1:]
	}

	if generatedFiles[base] {
		return DataFileResult{
			ValidationResult: ValidationResult{Valid: true},
			Skipped:          true,
		}
	}
	if schemaFile, special := byBasename[base]; special {
		validator := s.byFile(schemaFile)
		if validator == nil {
			// No compiled schema for a file that names one is a broken checkout,
			// not a licence to write anything: refuse rather than wave it through.
			return DataFileResult{
				ValidationResult: ValidationResult{Valid: false, Errors: []ValidationError{{
					Path: "(root)", Message: "no compiled schema for " + schemaFile,
				}}},
				Schema: schemaFile,
			}
		}
		return DataFileResult{ValidationResult: validator.Validate(document), Schema: schemaFile}
	}
	if s.Datasets == nil {
		return DataFileResult{ValidationResult: ValidationResult{Valid: true}, Skipped: true}
	}
	return DataFileResult{
		ValidationResult: s.Datasets.Validate(document),
		Schema:           "event.schema.json",
	}
}

// Planner is the planner schema, or nil when this checkout has none.
func (s *SchemaSet) Planner() *Validator {
	if s == nil {
		return nil
	}
	return s.Planners
}

// SummarizeErrors is a one-line summary for a human.
//
// The editor shows this verbatim, so a bare "validation_failed" would tell the
// person nothing about what to fix.
func SummarizeErrors(errors []ValidationError) string {
	if len(errors) == 0 {
		return "Schema validation failed"
	}
	var parts []string
	for index, item := range errors {
		if index == 3 {
			break
		}
		path := item.Path
		if path == "" {
			path = "(root)"
		}
		parts = append(parts, strings.TrimSpace(path+" "+item.Message))
	}
	more := ""
	if len(errors) > 3 {
		more = " (and " + strconv.Itoa(len(errors)-3) + " more)"
	}
	return "Schema validation failed: " + strings.Join(parts, "; ") + more
}
