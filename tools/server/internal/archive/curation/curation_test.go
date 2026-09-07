package curation

import (
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
)

// nodeCurationData runs the JavaScript curation build with a given ledger.
func nodeCurationData(t *testing.T, dataDir, imgDir, privateRoot string) string {
	t.Helper()
	return ts.RunNode(t, []string{
		"DATA_ROOT=" + dataDir,
		"IMG_ROOT=" + imgDir,
		"PRIVATE_ROOT=" + privateRoot,
	}, `
		import { buildCurationData } from './scripts/lib/archiveAudit.js';
		const [dataDir, imgDir] = process.argv.slice(1);
		const payload = await buildCurationData(dataDir, imgDir);
		process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
	`, dataDir, imgDir)
}

// The curation desk's whole payload, over the real archive: coverage scores,
// broken images, both cluster lists with their context, and the impact of every
// recorded decision.
func TestCurationDataIsByteIdenticalToTheNodeImplementation(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	// buildCurationData takes the IMG root as its `appDir` and resolves
	// `./img/...` paths against it.
	imgDir := filepath.Dir(filepath.Join(dataDir, "img"))
	privateRoot := t.TempDir() // no ledger: nothing merged, nothing marked distinct

	want := nodeCurationData(t, dataDir, imgDir, privateRoot)
	decisions := archive.LoadDecisions(privateRoot)
	got, err := BuildCurationData(dataDir, imgDir, decisions, nil)
	if err != nil {
		t.Fatal(err)
	}

	gotText := string(append(got.Encode("  "), '\n'))
	if gotText != want {
		ts.WriteArtefacts(t, []byte(gotText), []byte(want))
		t.Fatalf("payloads differ\n%s", ts.FirstDifference(gotText, want))
	}
	stats := got.Get("stats")
	t.Logf("byte-identical: %d events, %d broken images, %d speaker clusters, %d sponsor clusters",
		archive.IntOf(stats.Get("events")), archive.IntOf(stats.Get("brokenImages")),
		archive.IntOf(stats.Get("speakerClusters")), archive.IntOf(stats.Get("sponsorClusters")))
}

// Recording an alias is what "resolved" means, and the headline count has to go
// down when one is recorded — the bug the JavaScript comment describes at
// length, and the reason the test is here rather than trusted.
func TestRecordedDecisionsResolveClusters(t *testing.T) {
	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		t.Skip("no archive checkout found")
	}
	imgDir := filepath.Dir(filepath.Join(dataDir, "img"))

	plain, err := BuildCurationData(dataDir, imgDir, archive.LoadDecisions(t.TempDir()), nil)
	if err != nil {
		t.Fatal(err)
	}
	clusters := plain.Get("speakerClusters").Items()
	if len(clusters) == 0 {
		t.Skip("no speaker clusters in this archive")
	}
	before := len(clusters)
	key := clusters[0].Get("key").Str()

	// An alias resolves it.
	privateRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(privateRoot, "curation"), 0o755); err != nil {
		t.Fatal(err)
	}
	ledger := `{"aliases":{"` + key + `":"Canonical Name"}}`
	if err := os.WriteFile(filepath.Join(privateRoot, "curation", "decisions.json"),
		[]byte(ledger), 0o644); err != nil {
		t.Fatal(err)
	}
	merged, err := BuildCurationData(dataDir, imgDir, archive.LoadDecisions(privateRoot), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(merged.Get("speakerClusters").Items()); got != before-1 {
		t.Errorf("after an alias: %d clusters, want %d", got, before-1)
	}
	// And the impact line says what it covered, so an undo can be read.
	impact := merged.Get("impact").Get(key)
	if !impact.Exists() || archive.IntOf(impact.Get("talks")) == 0 {
		t.Errorf("impact for %q = %s", key, impact.Encode(""))
	}
	if len(impact.Get("variants").Items()) < 2 {
		t.Errorf("an impact row should name every spelling it resolves: %s",
			impact.Get("variants").Encode(""))
	}

	// Marking a cluster distinct also takes it off the list, without an alias.
	distinct, err := BuildCurationData(dataDir, imgDir, archive.LoadDecisions(t.TempDir()), []string{key})
	if err != nil {
		t.Fatal(err)
	}
	if got := len(distinct.Get("speakerClusters").Items()); got != before-1 {
		t.Errorf("after marking distinct: %d clusters, want %d", got, before-1)
	}
}

// A cluster needs more than one spelling to be a cluster at all.
func TestSingleSpellingIsNotACluster(t *testing.T) {
	index := newNameIndex()
	only := index.variant("gabor hojtsy", "Gábor Hojtsy")
	only.count = 3
	only.event("events/a.json", func() *js.Value { return js.Obj().Set("file", js.Str("events/a.json")) })

	if got := ToClusters(index, js.Obj(), nil, "speaker"); len(got.Items()) != 0 {
		t.Errorf("one spelling produced %d clusters", len(got.Items()))
	}

	// A second spelling of the same fingerprint makes it one.
	second := index.variant("gabor hojtsy", "Hojtsy Gábor")
	second.count = 1
	second.event("events/b.json", func() *js.Value { return js.Obj().Set("file", js.Str("events/b.json")) })

	clusters := ToClusters(index, js.Obj(), nil, "speaker")
	if len(clusters.Items()) != 1 {
		t.Fatalf("two spellings produced %d clusters", len(clusters.Items()))
	}
	cluster := clusters.Items()[0]
	// The most-used spelling leads, because it is the one to merge onto.
	if cluster.Get("canonical").Str() != "Gábor Hojtsy" {
		t.Errorf("canonical = %q, want the commonest spelling", cluster.Get("canonical").Str())
	}
	if archive.IntOf(cluster.Get("total")) != 4 || archive.IntOf(cluster.Get("eventCount")) != 2 {
		t.Errorf("cluster = %s", cluster.Encode(""))
	}
}

func TestJSRound(t *testing.T) {
	for value, want := range map[float64]int{
		0.4: 0, 0.5: 1, 1.5: 2, 2.5: 3, 99.4: 99, 99.5: 100, 0: 0,
	} {
		if got := jsRound(value); got != want {
			t.Errorf("jsRound(%v) = %d, want %d", value, got, want)
		}
	}
}

var _ = strings.TrimSpace
