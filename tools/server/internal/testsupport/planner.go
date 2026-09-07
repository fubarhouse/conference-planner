package testsupport

import (
	"os"
	"path/filepath"
	"testing"

	"server/internal/paths"
)

// plannerDir is the real one, which is where the fixtures worth testing against
// live: sixteen planners with actual trips in them.
// PlannerDir is a real planner directory to read fixtures from, or "" when
// this checkout has none.
func PlannerDir(t *testing.T) string {
	t.Helper()
	root := paths.ResolvePrivateRoot("")
	if root == "" {
		fallback := filepath.Join(RepoRoot(t), "..", "conference-planner-data", "private")
		if _, err := os.Stat(fallback); err == nil {
			abs, _ := filepath.Abs(fallback)
			root = abs
		}
	}
	if root == "" {
		return ""
	}
	dir := filepath.Join(root, "planners")
	if _, err := os.Stat(dir); err != nil {
		return ""
	}
	return dir
}
