// Package paths is where files are, and whether we may touch them.
//
// Small on purpose. It holds the two questions every other package asks about
// the filesystem — "where is the content root?" and "does this request stay
// inside it?" — and nothing else. They live together because the answer to the
// second depends on the first, and because a traversal guard that three packages
// each implement slightly differently is how one of them ends up wrong.
package paths

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// safeJoin refuses a path that escapes the base — the same guard the Node
// version applies before every dataset read.
func SafeJoin(base, sub string) string {
	full := filepath.Clean(filepath.Join(base, filepath.FromSlash(sub)))
	if full == base || strings.HasPrefix(full, base+string(filepath.Separator)) {
		return full
	}
	return ""
}

// datasetFiles walks events/ for *.json. Unlike the catalog's collector this
// keeps index.json and friends — the Node original does too, and a file that
// does not parse as a dataset is skipped later anyway.
func DatasetFiles(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipAll
			}
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// ResolvePrivateRoot follows lib/roots.js: PRIVATE_ROOT, else
// CONTENT_PATH/private. Returns "" when neither is set, which reads as an
// archive with no decisions recorded.
func ResolvePrivateRoot(explicit string) string {
	for _, candidate := range []string{
		explicit,
		os.Getenv("PRIVATE_ROOT"),
		EnvJoin("CONTENT_PATH", "private"),
	} {
		if candidate == "" {
			continue
		}
		if abs, err := filepath.Abs(candidate); err == nil {
			if info, err := os.Stat(abs); err == nil && info.IsDir() {
				return abs
			}
		}
	}
	return ""
}
func EnvJoin(name, sub string) string {
	if value := os.Getenv(name); value != "" {
		return filepath.Join(value, sub)
	}
	return ""
}

// resolveDataRoot follows the same precedence as lib/roots.js: an explicit path
// wins, then DATA_ROOT, then CONTENT_PATH/public. One rule for where content
// lives, whichever language is asking.
func ResolveDataRoot(explicit string) (string, error) {
	candidates := []string{explicit, os.Getenv("DATA_ROOT")}
	if content := os.Getenv("CONTENT_PATH"); content != "" {
		candidates = append(candidates, filepath.Join(content, "public"))
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		if info, err := os.Stat(abs); err == nil && info.IsDir() {
			return abs, nil
		}
	}
	return "", errors.New("no data directory: pass -data, or set DATA_ROOT or CONTENT_PATH")
}
func FirstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
