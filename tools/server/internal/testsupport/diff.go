package testsupport

import (
	"strconv"
	"strings"
)

// firstDifference reports where two documents part company, with context.
func FirstDifference(got, want string) string {
	gotLines, wantLines := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < len(gotLines) && i < len(wantLines); i++ {
		if gotLines[i] != wantLines[i] {
			return "line " + strconv.Itoa(i+1) + ":\n  go:   " + gotLines[i] + "\n  node: " + wantLines[i]
		}
	}
	return "one is a prefix of the other: " + strconv.Itoa(len(gotLines)) + " vs " + strconv.Itoa(len(wantLines)) + " lines"
}
