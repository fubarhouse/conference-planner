package curation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

// The cleaning and URL rules are what stand between a stranger's input and an
// editor's screen, so they are compared against the JavaScript directly.
func TestSuggestionCleaningMatchesNode(t *testing.T) {
	inputs := []string{
		"  DrupalJam  2026  ",
		"tabs\tand\nnewlines",
		"a control\x01character",
		strings.Repeat("x", 200),
		"",
		"   ",
		"Café Ölsson",
		"emoji 🎉 survive",
	}
	payload := js.Arr()
	for _, input := range inputs {
		payload.Append(js.Str(input))
	}
	out := ts.RunNode(t, nil, `
		const inputs = JSON.parse(process.argv[1]);
		// clean() is not exported; validateSuggestion exposes it through the
		// cleaned name it returns.
		const { validateSuggestion } = await import('./lib/suggestions.js');
		process.stdout.write(JSON.stringify(inputs.map((name) => {
			const r = validateSuggestion({ name, notes: 'x' });
			return r.value ? r.value.name : '';
		})));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, input := range inputs {
		if got := CleanField(input, LimitName); got != want[i] {
			t.Errorf("CleanField(%q) = %q, node = %q", input, got, want[i])
		}
	}
}

// The URL rule exists because an editor clicks these links.
func TestSafeURLMatchesNode(t *testing.T) {
	inputs := []string{
		"https://drupaljam.nl", "http://example.org/path?a=b", "drupaljam.nl",
		"javascript:alert(1)", "data:text/html,<script>", "not a url at all",
		"", "  https://example.org/  ", "HTTPS://EXAMPLE.ORG/Path",
		"ftp://example.org/file", "//example.org", "https://example.org:8443/x",
		// `new URL()` is forgiving about the slashes after a scheme; Go's parser
		// is not, so every shape a reader might paste is pinned here.
		"https:///example.org", "https:////example.org/a", "https:example.org",
		"https:/example.org", `\\example.org`, "///example.org",
	}
	payload := js.Arr()
	for _, input := range inputs {
		payload.Append(js.Str(input))
	}
	out := ts.RunNode(t, nil, `
		const { safeUrl } = await import('./lib/suggestions.js');
		const inputs = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(inputs.map(safeUrl)));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, input := range inputs {
		got := SafeURL(input)
		if got != want[i] {
			t.Errorf("SafeURL(%q) = %q, node = %q", input, got, want[i])
		}
		// Whatever the two agree on, a script URL must never survive.
		lowered := strings.ToLower(got)
		if strings.HasPrefix(lowered, "javascript:") || strings.HasPrefix(lowered, "data:") {
			t.Errorf("SafeURL(%q) returned an executable URL: %q", input, got)
		}
	}
}

func TestValidationMessagesMatchNode(t *testing.T) {
	cases := []SuggestionInput{
		{Name: "DrupalJam", URL: "https://drupaljam.nl"},
		{Name: "", URL: "https://drupaljam.nl"},
		{Name: "DrupalJam"},
		{Name: "DrupalJam", URL: "javascript:alert(1)"},
		{Name: "DrupalJam", Notes: "ask Karl"},
	}
	payload := js.Arr()
	for _, input := range cases {
		payload.Append(js.Obj().
			Set("name", js.Str(input.Name)).
			Set("url", js.Str(input.URL)).
			Set("notes", js.Str(input.Notes)))
	}
	out := ts.RunNode(t, nil, `
		const { validateSuggestion } = await import('./lib/suggestions.js');
		const inputs = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(inputs.map((i) => validateSuggestion(i).error || '')));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, input := range cases {
		if _, problem := ValidateSuggestion(input); problem != want[i] {
			t.Errorf("%+v: go %q, node %q", input, problem, want[i])
		}
	}
}

func TestIdentitySuggestionValidation(t *testing.T) {
	cases := []struct {
		input IdentityInput
		want  string
	}{
		{IdentityInput{Type: "speaker", From: "gábor hojtsy", To: "Gábor Hojtsy"}, ""},
		{IdentityInput{Type: "sponsor", From: "acquia", To: "Acquia"}, ""},
		{IdentityInput{Type: "nonsense", From: "a", To: "b"}, "Unknown identity type."},
		{IdentityInput{Type: "speaker", From: "", To: "b"}, "Both names are required."},
		{IdentityInput{Type: "speaker", From: "a", To: ""}, "Both names are required."},
		// Case and punctuation differences are the whole point, so only an
		// exact match is a no-op.
		{IdentityInput{Type: "speaker", From: "Same", To: "Same"}, "That is already the same name."},
	}
	for _, testCase := range cases {
		if _, problem := ValidateIdentitySuggestion(testCase.input); problem != testCase.want {
			t.Errorf("%+v: got %q, want %q", testCase.input, problem, testCase.want)
		}
	}
}

// The queue's whole lifecycle, and the file it leaves behind.
func TestSuggestionQueueLifecycle(t *testing.T) {
	dir := t.TempDir()
	clock := time.Unix(1700000000, 0).UTC()
	store := &SuggestionStore{Dir: dir, Now: func() time.Time { return clock }}

	if len(store.List().Items()) != 0 || store.OpenCount() != 0 {
		t.Fatal("a fresh queue should be empty, not an error")
	}

	first, problem, err := store.Add(SuggestionInput{
		Name: "DrupalCamp Somewhere", URL: "drupalcamp.example", Notes: "heard about it",
	}, "karl")
	if err != nil || problem != "" {
		t.Fatalf("add = %q %v", problem, err)
	}
	if !strings.HasPrefix(first.Get("id").Str(), "tip_") {
		t.Errorf("id = %q", first.Get("id").Str())
	}
	if first.Get("url").Str() != "https://drupalcamp.example/" {
		t.Errorf("a bare host should be upgraded and normalised, got %q", first.Get("url").Str())
	}
	if first.Get("by").Str() != "karl" || first.Get("status").Str() != "new" {
		t.Errorf("row = %s", first.Encode(""))
	}

	// Newest first: the queue is read from the top.
	second, _, err := store.Add(SuggestionInput{Name: "Another", Notes: "later"}, "")
	if err != nil {
		t.Fatal(err)
	}
	items := store.List().Items()
	if len(items) != 2 || items[0].Get("id").Str() != second.Get("id").Str() {
		t.Error("a new lead should go to the top of the queue")
	}
	// An anonymous submission carries no `by` at all rather than an empty one.
	if items[0].Get("by").Exists() {
		t.Error("an anonymous lead should have no by field")
	}
	if store.OpenCount() != 2 {
		t.Errorf("open count = %d", store.OpenCount())
	}

	// A decision is recorded, and can be taken back.
	decided, problem, err := store.Decide(first.Get("id").Str(), "actioned", "karl")
	if err != nil || problem != "" {
		t.Fatalf("decide = %q %v", problem, err)
	}
	if decided.Get("decidedAt").Str() == "" || decided.Get("decidedBy").Str() != "karl" {
		t.Errorf("decided row = %s", decided.Encode(""))
	}
	if store.OpenCount() != 1 {
		t.Errorf("open count after a decision = %d", store.OpenCount())
	}

	reopened, _, err := store.Decide(first.Get("id").Str(), "new", "karl")
	if err != nil {
		t.Fatal(err)
	}
	// Reopening drops the decision fields rather than leaving a stale date.
	if reopened.Get("decidedAt").Exists() || reopened.Get("decidedBy").Exists() {
		t.Errorf("a reopened row still carries its decision: %s", reopened.Encode(""))
	}

	if _, problem, _ := store.Decide("no-such-id", "actioned", ""); problem != "No such suggestion." {
		t.Errorf("unknown id = %q", problem)
	}
	if _, problem, _ := store.Decide(first.Get("id").Str(), "nonsense", ""); problem != "Unknown status." {
		t.Errorf("unknown status = %q", problem)
	}

	// The file on disk, checked as a file rather than through the JavaScript.
	//
	// This used to hand the path to Node and ask how many items it could read
	// back — a genuine cross-implementation property, and one that cannot outlive
	// the implementation it compared against. Recorded as a reference answer it
	// would replay the constant "2" forever, whatever this code went on to write.
	// So it is asserted here instead: the format is pinned (a trailing newline,
	// two-space indent, an `items` array), which is what the round trip was
	// really checking.
	raw, err := os.ReadFile(filepath.Join(dir, "suggestions.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(raw), "}\n") {
		t.Error("the queue file should end with a newline, as the JavaScript wrote it")
	}
	reparsed, err := js.ParseJSON(raw)
	if err != nil {
		t.Fatalf("the queue file is not valid JSON: %v", err)
	}
	stored := reparsed.Get("items")
	if !stored.IsArray() || len(stored.Items()) != 2 {
		t.Errorf("read back %s", raw)
	}
	// Byte-identical through the encoder, so two processes writing this file in
	// turn cannot reformat it back and forth.
	if rewritten := string(js.Obj().Set("items", stored).Encode("  ")) + "\n"; rewritten != string(raw) {
		t.Errorf("the file is not stable through a round trip:\n got %s\nwant %s", rewritten, raw)
	}
}

// The same claim twice is one claim.
func TestIdentitySuggestionsDeduplicate(t *testing.T) {
	dir := t.TempDir()
	store := &SuggestionStore{Dir: dir, Now: func() time.Time { return time.Unix(1700000000, 0) }}
	input := IdentityInput{Type: "speaker", From: "gábor hojtsy", To: "Gábor Hojtsy"}

	first, duplicate, problem, err := store.AddIdentity(input, "karl")
	if err != nil || problem != "" || duplicate {
		t.Fatalf("first = %v %q %v", duplicate, problem, err)
	}
	second, duplicate, _, err := store.AddIdentity(input, "karl")
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate || second.Get("id").Str() != first.Get("id").Str() {
		t.Error("the same claim twice should return the open row, not add another")
	}
	if len(store.List().Items()) != 1 {
		t.Errorf("queue has %d rows", len(store.List().Items()))
	}

	// Once it has been decided, the same claim can be proposed again.
	if _, _, err := store.Decide(first.Get("id").Str(), "dismissed", ""); err != nil {
		t.Fatal(err)
	}
	_, duplicate, _, err = store.AddIdentity(input, "karl")
	if err != nil {
		t.Fatal(err)
	}
	if duplicate {
		t.Error("a decided claim should not block a fresh one")
	}
	if len(store.List().Items()) != 2 {
		t.Errorf("queue has %d rows", len(store.List().Items()))
	}
}
