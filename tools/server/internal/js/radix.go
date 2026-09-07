package js

// Number.prototype.toString(radix) for a non-integer, which is what the feed
// ETag is built from.
//
// The Node route stamps `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`,
// and `mtimeMs` is a FLOAT — 1788073648084.7666, not an integer count of
// milliseconds. Base 36 of that has a fractional part ("mtfgvsus.rlj"), so an
// implementation that rounded to whole milliseconds first would produce a
// different tag for every file in the archive and turn every conditional
// request into a full fetch.
//
// This is V8's DoubleToRadixCString: emit fractional digits until the remaining
// value is below half an ULP of the original, rounding the last digit and
// propagating any carry back through the buffer — including, at the extreme,
// into the integer part.

import (
	"math"
	"strings"
)

const radixChars = "0123456789abcdefghijklmnopqrstuvwxyz"

// JSNumberToStringRadix renders a finite float the way JavaScript renders it in
// a non-decimal radix.
func JSNumberToStringRadix(value float64, radix int) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}

	negative := math.Signbit(value)
	value = math.Abs(value)

	integer := math.Floor(value)
	fraction := value - integer

	// Half an ULP: below this, a digit carries no information the double
	// actually holds.
	delta := 0.5 * (math.Nextafter(value, math.Inf(1)) - value)
	if smallest := math.Nextafter(0, math.Inf(1)); delta < smallest {
		delta = smallest
	}

	var fractionDigits []byte
	if fraction >= delta {
		for {
			fraction *= float64(radix)
			delta *= float64(radix)
			digit := int(fraction)
			fractionDigits = append(fractionDigits, radixChars[digit])
			fraction -= float64(digit)

			// Round the final digit, and carry if that overflows it.
			if fraction > 0.5 || (fraction == 0.5 && digit&1 == 1) {
				if fraction+delta > 1 {
					integer += roundUpFraction(fractionDigits, radix)
					break
				}
			}
			if fraction < delta {
				break
			}
		}
	}

	// The integer part. Every value this is used on is well under 2^53, where a
	// float64 holds integers exactly, so plain arithmetic is exact here.
	var integerDigits []byte
	if integer == 0 {
		integerDigits = []byte{'0'}
	}
	for integer > 0 {
		remainder := math.Mod(integer, float64(radix))
		integerDigits = append(integerDigits, radixChars[int(remainder)])
		integer = math.Floor(integer / float64(radix))
	}
	for left, right := 0, len(integerDigits)-1; left < right; left, right = left+1, right-1 {
		integerDigits[left], integerDigits[right] = integerDigits[right], integerDigits[left]
	}

	var out strings.Builder
	if negative {
		out.WriteByte('-')
	}
	out.Write(integerDigits)
	if len(fractionDigits) > 0 {
		out.WriteByte('.')
		out.Write(fractionDigits)
	}
	return out.String()
}

// roundUpFraction increments the last fractional digit, carrying leftwards.
// Returns 1 when the carry runs off the front, which the caller adds to the
// integer part.
func roundUpFraction(digits []byte, radix int) float64 {
	for i := len(digits) - 1; i >= 0; i-- {
		position := strings.IndexByte(radixChars, digits[i])
		if position+1 < radix {
			digits[i] = radixChars[position+1]
			return 0
		}
		digits[i] = '0'
	}
	return 1
}
