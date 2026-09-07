package testsupport

// Helpers for comparing generated calendars.
//
// A feed carries a DTSTAMP of the moment it was built, so two runs of the same
// build differ in exactly one line. Normalising it is what lets the rest be
// compared byte for byte.

import (
	"strings"
)

// normaliseStamp replaces the generated DTSTAMP lines so two runs can be
// compared on everything else.
func NormaliseStamp(ics string) string {
	lines := strings.Split(ics, "\r\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "DTSTAMP:") {
			lines[i] = "DTSTAMP:<generated>"
		}
	}
	return strings.Join(lines, "\r\n")
}
func FirstLines(s string, n int) string {
	lines := strings.Split(s, "\r\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}
