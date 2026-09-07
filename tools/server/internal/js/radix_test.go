package js

import (
	"encoding/json"
	"math"
	"testing"

	ts "server/internal/testsupport"
)

// The radix conversion is compared against V8 itself, over values chosen to
// exercise the parts that are easy to get wrong: a fraction that terminates, one
// that repeats, one that carries into the integer part, and the mtimes the feed
// ETags are actually built from.
func TestNumberToStringRadixMatchesV8(t *testing.T) {
	values := []float64{
		0, 1, 35, 36, 1295, 1296,
		0.5, 0.1, 0.0001,
		1788073648084.7666, 1788073648000, 1234567890123.25,
		math.Nextafter(1, 2),
		0.9999999999999999,
		1e15, 4503599627370495,
	}

	payload, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	// V8 itself is the oracle here — this is a LANGUAGE behaviour, not the
	// deleted server — but the answer is recorded like every other reference so
	// the suite needs nothing installed to run.
	out := ts.RunNode(t, nil, `
		const values = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(
			values.map((v) => [v.toString(36), v.toString(16)])));
	`, string(payload))

	var want [][2]string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, value := range values {
		if got := JSNumberToStringRadix(value, 36); got != want[i][0] {
			t.Errorf("(%v).toString(36) = %q, node = %q", value, got, want[i][0])
		}
		if got := JSNumberToStringRadix(value, 16); got != want[i][1] {
			t.Errorf("(%v).toString(16) = %q, node = %q", value, got, want[i][1])
		}
	}
}

func TestNumberToStringRadixEdges(t *testing.T) {
	if got := JSNumberToStringRadix(math.NaN(), 36); got != "NaN" {
		t.Errorf("NaN = %q", got)
	}
	if got := JSNumberToStringRadix(math.Inf(1), 36); got != "Infinity" {
		t.Errorf("+Inf = %q", got)
	}
	if got := JSNumberToStringRadix(-1.5, 16); got != "-1.8" {
		t.Errorf("-1.5 base 16 = %q", got)
	}
}
