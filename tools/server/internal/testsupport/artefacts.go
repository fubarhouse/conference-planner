package testsupport

import (
	"os"
	"path/filepath"
	"testing"
)

// WriteArtefacts drops both sides of a failed comparison in a temp directory
// and logs a diff command, so a byte difference in a megabyte of JSON is one
// paste away from being readable.
func WriteArtefacts(t *testing.T, got, want []byte) {
	t.Helper()
	dir := t.TempDir()
	gotPath := filepath.Join(dir, "catalog.go.json")
	wantPath := filepath.Join(dir, "catalog.node.json")
	_ = os.WriteFile(gotPath, got, 0o644)
	_ = os.WriteFile(wantPath, want, 0o644)
	t.Logf("diff %s %s", wantPath, gotPath)
}
