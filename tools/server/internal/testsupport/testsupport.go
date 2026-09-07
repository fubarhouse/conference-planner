// Package testsupport holds what the tests in every package share: where the
// repository is, where the frozen archive is, and the recorded answers the
// JavaScript implementation gave before it was deleted.
//
// It is a normal package rather than a _test.go file because Go's test files are
// per-package and these helpers are needed by a dozen of them. Nothing in the
// production build imports it.
//
// The recordings and the fixture archive live at the MODULE root
// (tools/server/testdata), not in each package's own testdata directory. That
// is deliberate: there is one corpus of reference answers and one frozen
// archive, and copying either per-package would mean fourteen places to
// re-record. Paths are resolved by walking up to go.mod, so a test finds them
// from whatever directory it runs in.
package testsupport

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// UpdateGolden re-records the reference answers from the JavaScript
// implementation. It needs server.js and lib/ restored from git history — see
// docs/go-port.md.
var UpdateGolden = flag.Bool("update-golden", false,
	"re-record the reference outputs from the JavaScript implementation")

var (
	rootOnce sync.Once
	rootDir  string
	rootErr  error
)

// ModuleRoot is tools/server, found by walking up for go.mod.
func ModuleRoot(t *testing.T) string {
	t.Helper()
	rootOnce.Do(func() {
		dir, err := os.Getwd()
		if err != nil {
			rootErr = err
			return
		}
		for {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				rootDir = dir
				return
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				rootErr = fmt.Errorf("no go.mod above %s", dir)
				return
			}
			dir = parent
		}
	})
	if rootErr != nil {
		t.Fatal(rootErr)
	}
	return rootDir
}

// RepoRoot is the repository itself — two levels above the module.
func RepoRoot(t *testing.T) string {
	t.Helper()
	return filepath.Dir(filepath.Dir(ModuleRoot(t)))
}

// AppRoot is app/, which the page and schema tests read.
func AppRoot(t *testing.T) string {
	t.Helper()
	return filepath.Join(RepoRoot(t), "app")
}

// GoldenDir is the one corpus of recorded reference answers.
func GoldenDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(ModuleRoot(t), "testdata", "golden")
}

// ArchiveDir is the archive the tests read: a frozen fixture, committed under
// testdata/fixture.
//
// It used to be the live archive, which was right while the port was being
// PROVEN — differential testing over real data is what found the double-shifted
// DrupalCon exports and the grid-scrape column shift. It is wrong for keeping
// the port proven: the reference answers are now recorded files, and a recording
// taken over live data goes stale the moment somebody edits a dataset.
//
// ARCHIVE_DIR still points this at a real archive, which is how the recordings
// were made and how a full-archive comparison can be run again if the reference
// is ever restored.
func ArchiveDir(t *testing.T) string {
	t.Helper()
	if override := strings.TrimSpace(os.Getenv("ARCHIVE_DIR")); override != "" {
		if _, err := os.Stat(filepath.Join(override, "events")); err == nil {
			return override
		}
		t.Fatalf("ARCHIVE_DIR=%s has no events/ directory", override)
	}
	fixture := filepath.Join(ModuleRoot(t), "testdata", "fixture")
	if _, err := os.Stat(filepath.Join(fixture, "events")); err != nil {
		t.Fatalf("the fixture archive is missing from %s: %v", fixture, err)
	}
	return fixture
}

// ContractFixture is a shared case file, read from the module's own testdata.
//
// These are the fixtures BOTH implementations read — the Go test here and the
// JavaScript test in app/js/modules/__tests__ — so that changing a rule in one
// language fails the other's build. There is one copy, at the module root, and
// packages find it through here rather than each keeping a `testdata` of its
// own.
func ContractFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(ModuleRoot(t), "testdata", name))
	if err != nil {
		t.Fatalf("shared contract fixture %s: %v", name, err)
	}
	return raw
}
