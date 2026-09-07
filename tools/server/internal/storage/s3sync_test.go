package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"sort"
	"strings"
	"testing"
)

// ── A stub bucket ───────────────────────────────────────────────────────────

// ── The harness ─────────────────────────────────────────────────────────────

// syncScenario is one starting state: files on disk, objects in the bucket, and
// a manifest recording what the two last agreed on.
type syncScenario struct {
	name     string
	local    map[string]string // path relative to the content root → contents
	remote   map[string]string // bucket key → contents
	manifest map[string]string // bucket key → ETag
	force    bool
}

// setup builds the scenario on disk and returns the roots.
func (s syncScenario) setup(t *testing.T) (root string, bucket *ts.StubBucket, manifestPath string) {
	t.Helper()
	root = t.TempDir()
	for rel, contents := range s.local {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	bucket = ts.NewStubBucket("test-bucket")
	for key, contents := range s.remote {
		bucket.Seed(key, []byte(contents))
	}

	manifestPath = filepath.Join(root, ".s3-manifest.json")
	if s.manifest != nil {
		resolved := map[string]string{}
		for key, value := range s.manifest {
			// A manifest entry of "=" means "whatever the bucket currently
			// holds", which is how a scenario says the two were last in step.
			if value == "=" {
				resolved[key] = bucket.ETag(key)
			} else {
				resolved[key] = value
			}
		}
		encoded, _ := json.MarshalIndent(resolved, "", "  ")
		if err := os.WriteFile(manifestPath, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, bucket, manifestPath
}

func syncConfigFor(root, manifestPath string, force bool) SyncConfig {
	return SyncConfig{
		Prefix: "",
		Roots: SyncRoots{
			Data:      filepath.Join(root, "public"),
			Img:       filepath.Join(root, "public", "img"),
			Planners:  filepath.Join(root, "private", "planners"),
			Receipts:  filepath.Join(root, "private", "receipts"),
			Documents: filepath.Join(root, "private", "documents"),
			Curation:  filepath.Join(root, "private", "curation"),
		},
		ManifestPath: manifestPath,
		Scope:        "all",
		Force:        force,
	}
}

// protectRepoManifest saves and restores the repository's own manifest around a
// Node run.
//
// This is not tidiness. lib/s3-sync.js resolves MANIFEST_PATH from the module's
// own location — `join(ROOT, '.s3-manifest.json')` — with no way to point it
// somewhere else, so a test that runs the real push writes into the working
// tree. The first version of this file did exactly that and put two invented
// keys into the live manifest. A spurious key is mostly harmless; an OVERWRITTEN
// one is not, because the manifest is what decides whether the next real sync
// sees a conflict or silently takes one side.
//
// The Go port takes the path as configuration for this reason. Making the
// JavaScript honour an env override would be a small, worthwhile change.
func protectRepoManifest(t *testing.T) {
	t.Helper()
	path := filepath.Join(ts.RepoRoot(t), ".s3-manifest.json")
	original, err := os.ReadFile(path)
	existed := err == nil
	t.Cleanup(func() {
		if existed {
			_ = os.WriteFile(path, original, 0o644)
			return
		}
		_ = os.Remove(path)
	})
}

// nodeSync runs the JavaScript push or pull against the stub bucket and returns
// its outcome.
func nodeSync(t *testing.T, operation, root, manifestPath, endpoint string, force bool) map[string]any {
	t.Helper()
	protectRepoManifest(t)

	// Put the scenario's manifest where the module will look for it, so the two
	// implementations really are starting from the same three-way state. The
	// original is restored by protectRepoManifest.
	repoManifest := filepath.Join(ts.RepoRoot(t), ".s3-manifest.json")
	if scenario, err := os.ReadFile(manifestPath); err == nil {
		if err := os.WriteFile(repoManifest, scenario, 0o644); err != nil {
			t.Fatal(err)
		}
	} else if err := os.Remove(repoManifest); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	out := ts.RunNode(t, []string{
		"S3_BUCKET=test-bucket",
		"S3_REGION=us-east-1",
		"S3_PREFIX=",
		"AWS_ENDPOINT_URL_S3=" + endpoint,
		"AWS_ACCESS_KEY_ID=test",
		"AWS_SECRET_ACCESS_KEY=test",
		"CONTENT_PATH=" + root,
		"DATA_ROOT=" + filepath.Join(root, "public"),
		"IMG_ROOT=" + filepath.Join(root, "public", "img"),
		"PRIVATE_ROOT=" + filepath.Join(root, "private"),
	}, `
		const s3 = await import('./scripts/lib/s3-sync.js');
		const [operation, force] = process.argv.slice(1);
		const result = await s3[operation]({ force: force === 'true' });
		process.stdout.write(JSON.stringify(result));
	`, operation, boolText(force))

	var parsed map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		t.Fatalf("node returned %q: %v", out, err)
	}
	return parsed
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// snapshotTree reads every file under a root, for comparing end states.
func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		relative, _ := filepath.Rel(root, path)
		relative = filepath.ToSlash(relative)
		if relative == ".s3-manifest.json" {
			return nil // compared separately; key order differs by construction
		}
		body, readErr := os.ReadFile(path)
		if readErr == nil {
			out[relative] = string(body)
		}
		return nil
	})
	return out
}

func names(values []any) []string {
	var out []string
	for _, value := range values {
		if text, ok := value.(string); ok {
			out = append(out, text)
		}
	}
	sort.Strings(out)
	return out
}

func sortedCopy(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}

// conflictReasons summarises conflicts as "path:reason", which is the part that
// has to agree — the ETags in them are the same hashes by construction.
func conflictReasons(raw []any) []string {
	var out []string
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, fmt.Sprintf("%v:%v", entry["path"], entry["reason"]))
	}
	sort.Strings(out)
	return out
}

func goConflictReasons(conflicts []SyncConflict) []string {
	var out []string
	for _, conflict := range conflicts {
		out = append(out, conflict.Path+":"+conflict.Reason)
	}
	sort.Strings(out)
	return out
}

// The scenarios. Each is a state both implementations are put into
// independently, and the comparison is over what they did and what they left
// behind.
var syncScenarios = []syncScenario{
	{
		name:  "a fresh push, nothing in the bucket",
		local: map[string]string{"public/events/a.json": `{"a":1}`, "private/planners/p.json": `{"p":1}`},
	},
	{
		name:     "nothing to do — local and remote already agree",
		local:    map[string]string{"public/events/a.json": `{"a":1}`},
		remote:   map[string]string{"data/events/a.json": `{"a":1}`},
		manifest: map[string]string{"data/events/a.json": "="},
	},
	{
		name:     "the bucket moved and local did not",
		local:    map[string]string{"public/events/a.json": `{"a":1}`},
		remote:   map[string]string{"data/events/a.json": `{"a":"changed remotely"}`},
		manifest: map[string]string{"data/events/a.json": "9d4d9d1b0e05e0e0e0e0e0e0e0e0e0e0"},
	},
	{
		name:     "both moved since the manifest",
		local:    map[string]string{"public/events/a.json": `{"a":"changed locally"}`},
		remote:   map[string]string{"data/events/a.json": `{"a":"changed remotely"}`},
		manifest: map[string]string{"data/events/a.json": "9d4d9d1b0e05e0e0e0e0e0e0e0e0e0e0"},
	},
	{
		name:     "both moved, and the operator forced it",
		local:    map[string]string{"public/events/a.json": `{"a":"changed locally"}`},
		remote:   map[string]string{"data/events/a.json": `{"a":"changed remotely"}`},
		manifest: map[string]string{"data/events/a.json": "9d4d9d1b0e05e0e0e0e0e0e0e0e0e0e0"},
		force:    true,
	},
	{
		name: "the bucket holds files this installation does not",
		remote: map[string]string{
			"data/events/b.json":           `{"b":1}`,
			"img/logo.png":                 "not really a png",
			"data/curation/decisions.json": `{"aliases":{}}`,
			"receipts/r1.pdf":              "not really a pdf",
			"unrelated/thing.json":         `{"ignored":true}`,
		},
	},
}

// Push, compared. The categories and the resulting bucket must agree.
func TestPushMatchesTheNodeImplementation(t *testing.T) {
	for _, scenario := range syncScenarios {
		t.Run(scenario.name, func(t *testing.T) {
			// Node first, against its own copy of the world.
			nodeRoot, nodeBucket, nodeManifest := scenario.setup(t)
			server := httptest.NewServer(nodeBucket.Handler())
			defer server.Close()
			want := nodeSync(t, "push", nodeRoot, nodeManifest, server.URL, scenario.force)

			// Go second, against an identical one.
			goRoot, goBucket, goManifest := scenario.setup(t)
			outcome, err := Push(context.Background(), &ts.MemoryStore{Bucket: goBucket},
				syncConfigFor(goRoot, goManifest, scenario.force))
			if err != nil {
				t.Fatal(err)
			}

			compareStringSets(t, "pushed", sortedCopy(outcome.Moved), names(want["pushed"].([]any)))
			compareStringSets(t, "skipped", sortedCopy(outcome.Skipped), names(want["skipped"].([]any)))
			compareStringSets(t, "conflicts", goConflictReasons(outcome.Conflicts),
				conflictReasons(want["conflicts"].([]any)))
			if len(outcome.Errors) != len(want["errors"].([]any)) {
				t.Errorf("errors: go %+v, node %v", outcome.Errors, want["errors"])
			}

			compareStringMaps(t, "the bucket afterwards", goBucket.Snapshot(),
				ts.ReferenceMap(t, "push_bucket_"+ts.ScenarioKey(scenario.name), nodeBucket.Snapshot))
		})
	}
}

// Pull, compared. Here the resulting FILES are the thing that matters.
func TestPullMatchesTheNodeImplementation(t *testing.T) {
	for _, scenario := range syncScenarios {
		t.Run(scenario.name, func(t *testing.T) {
			nodeRoot, nodeBucket, nodeManifest := scenario.setup(t)
			server := httptest.NewServer(nodeBucket.Handler())
			defer server.Close()
			want := nodeSync(t, "pull", nodeRoot, nodeManifest, server.URL, scenario.force)

			goRoot, goBucket, goManifest := scenario.setup(t)
			outcome, err := Pull(context.Background(), &ts.MemoryStore{Bucket: goBucket},
				syncConfigFor(goRoot, goManifest, scenario.force))
			if err != nil {
				t.Fatal(err)
			}

			compareStringSets(t, "pulled", sortedCopy(outcome.Moved), names(want["pulled"].([]any)))
			compareStringSets(t, "skipped", sortedCopy(outcome.Skipped), names(want["skipped"].([]any)))
			compareStringSets(t, "conflicts", goConflictReasons(outcome.Conflicts),
				conflictReasons(want["conflicts"].([]any)))

			compareStringMaps(t, "the files afterwards", snapshotTree(t, goRoot),
				ts.ReferenceMap(t, "pull_tree_"+ts.ScenarioKey(scenario.name), func() map[string]string {
					return snapshotTree(t, nodeRoot)
				}))
		})
	}
}

func compareStringSets(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s: go %v, node %v", label, got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s: go %v, node %v", label, got, want)
			return
		}
	}
}

func compareStringMaps(t *testing.T, label string, got, want map[string]string) {
	t.Helper()
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s: [%s] go %q, node %q", label, key, got[key], value)
		}
	}
	for key := range got {
		if _, found := want[key]; !found {
			t.Errorf("%s: go has an extra entry [%s]", label, key)
		}
	}
}

// ── The pure mapping ────────────────────────────────────────────────────────

func TestPathMappingMatchesNode(t *testing.T) {
	subs := []string{
		"data/events/a.json", "data/catalog.json", "img/logos/x.png",
		"receipts/r.pdf", "documents/d.pdf", "planners/p.json",
		"data/curation/decisions.json", // must NOT land in the public tree
		"unrelated/x.json", "", "data/", "planners/other/p.json",
	}

	root := "/tmp/roots"
	config := syncConfigFor(root, "", false)

	payload := js.Arr()
	for _, sub := range subs {
		payload.Append(js.Str(sub))
	}
	out := ts.RunNode(t, []string{
		"CONTENT_PATH=" + root,
		"DATA_ROOT=" + filepath.Join(root, "public"),
		"IMG_ROOT=" + filepath.Join(root, "public", "img"),
		"PRIVATE_ROOT=" + filepath.Join(root, "private"),
		"S3_BUCKET=test-bucket",
		"S3_PREFIX=",
	}, `
		const { __testing } = await import('./scripts/lib/s3-sync.js').then((m) => ({ __testing: m }));
		// toLocalPath is not exported, so the mapping is reproduced from the
		// roots the module resolves — the same rule, read from the same env.
		const { DATA_ROOT, IMG_ROOT, PRIVATE_ROOT, CURATION_ROOT } = await import('./scripts/lib/roots.js');
		const { join } = await import('node:path');
		const subs = JSON.parse(process.argv[1]);
		const CURATION_S3_PREFIX = 'data/curation/';
		const toLocalPath = (s) => {
			if (s.startsWith(CURATION_S3_PREFIX)) return join(CURATION_ROOT, s.slice(CURATION_S3_PREFIX.length));
			if (s.startsWith('data/')) return join(DATA_ROOT, s.slice(5));
			if (s.startsWith('img/')) return join(IMG_ROOT, s.slice(4));
			if (s.startsWith('receipts/')) return join(PRIVATE_ROOT, 'receipts', s.slice(9));
			if (s.startsWith('documents/')) return join(PRIVATE_ROOT, 'documents', s.slice(10));
			if (s.startsWith('planners/')) return join(PRIVATE_ROOT, 'planners', s.slice(9));
			return null;
		};
		process.stdout.write(JSON.stringify(subs.map(toLocalPath)));
	`, string(payload.Encode("")))

	var want []*string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatalf("node returned %q: %v", out, err)
	}
	for i, sub := range subs {
		got := config.ToLocalPath(sub)
		expected := ""
		if want[i] != nil {
			expected = *want[i]
		}
		if got != expected {
			t.Errorf("ToLocalPath(%q) = %q, node = %q", sub, got, expected)
		}
	}

	// The curation ledger is the case that matters most: its key lives under
	// data/ but its file must not.
	ledger := config.ToLocalPath("data/curation/decisions.json")
	if strings.Contains(ledger, filepath.Join("public", "curation")) {
		t.Errorf("the ledger would be written into the served tree: %s", ledger)
	}
	if !strings.Contains(ledger, filepath.Join("private", "curation")) {
		t.Errorf("the ledger should land in the private tree, got %s", ledger)
	}
}

func TestScopeFiltering(t *testing.T) {
	for _, testCase := range []struct {
		scope, sub string
		want       bool
	}{
		{"all", "data/events/a.json", true},
		{"all", "receipts/r.pdf", true},
		{"data", "data/events/a.json", true},
		{"data", "img/x.png", true},
		{"data", "planners/p.json", false},
		{"data", "receipts/r.pdf", false},
		{"planner", "planners/p.json", true},
		{"planner", "receipts/r.pdf", true},
		{"planner", "documents/d.pdf", true},
		{"planner", "data/events/a.json", false},
	} {
		config := SyncConfig{Scope: testCase.scope}
		if got := config.SubInScope(testCase.sub); got != testCase.want {
			t.Errorf("scope %q, %q = %v, want %v",
				testCase.scope, testCase.sub, got, testCase.want)
		}
	}
}

func TestContentTypeAndETagHelpers(t *testing.T) {
	for path, want := range map[string]string{
		"a.json": "application/json", "b.PDF": "application/pdf",
		"c.jpeg": "image/jpeg", "d.png": "image/png", "e.svg": "image/svg+xml",
		"f.gpx": "application/gpx+xml", "g.bin": "application/octet-stream", "h": "application/octet-stream",
	} {
		if got := ContentTypeFor(path); got != want {
			t.Errorf("ContentTypeFor(%q) = %q, want %q", path, got, want)
		}
	}
	if got := StripQuotes(`"ABC123"`); got != "abc123" {
		t.Errorf("StripQuotes = %q", got)
	}
}
