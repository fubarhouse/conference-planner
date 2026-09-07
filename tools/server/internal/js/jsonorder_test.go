package js

import (
	"strings"
	"testing"
)

func TestIntegerKeysSerialiseInNumericOrder(t *testing.T) {
	// ES orders integer-like keys first and ascending, whatever order they were
	// inserted in. Every per-year map in the Observatory payload depends on it.
	node := Obj()
	for _, year := range []string{"2011", "2007", "2026", "2009"} {
		node.Set(year, Int(1))
	}
	node.Set("total", Int(4))
	node.Set("2008", Int(1))

	want := `{"2007":1,"2008":1,"2009":1,"2011":1,"2026":1,"total":4}`
	if got := string(node.Encode("")); got != want {
		t.Errorf("got  %s\nwant %s", got, want)
	}
}

func TestIsArrayIndexKey(t *testing.T) {
	cases := map[string]bool{
		"0": true, "7": true, "2026": true, "4294967294": true,
		"":           false, // not a key JS would treat as an index
		"01":         false, // would stringify back as "1"
		"-1":         false,
		"1.5":        false,
		"2026a":      false,
		"4294967295": false, // the boundary is exclusive
		"total":      false,
	}
	for key, want := range cases {
		if got := IsArrayIndexKey(key); got != want {
			t.Errorf("IsArrayIndexKey(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestEmptyIndentIsCompact(t *testing.T) {
	value, err := ParseJSON([]byte(`{"a":[1,2],"b":{"c":"d"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := string(value.Encode("")); got != `{"a":[1,2],"b":{"c":"d"}}` {
		t.Errorf("compact encode = %s", got)
	}
	// And the indented form still breaks lines.
	if !strings.Contains(string(value.Encode("  ")), "\n") {
		t.Error("an indented encode should be multi-line")
	}
}
