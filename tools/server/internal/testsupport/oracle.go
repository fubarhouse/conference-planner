package testsupport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// The oracle: reference outputs, recorded once from the JavaScript and committed.
//
// Every differential test in this package used to run the Node implementation
// live and diff against it. That was the right way to PROVE the port — the
// comparison was against the real thing, over the real archive — and it is the
// wrong way to keep it proven, for one reason: `server.js` and `lib/` are being
// deleted. A test that needs a deleted implementation does not fail, it SKIPS,
// and a suite that skips silently is worse than one that was never written. It
// reports green while checking nothing.
//
// So the reference outputs are captured to testdata/golden/ and committed. The
// tests keep their shape — same cases, same comparisons — and read the recorded
// answer instead of computing it. What changes is what they mean:
//
//   before   "Go agrees with the JavaScript running right now"
//   after    "Go still produces what the JavaScript produced on the day it was
//            replaced"
//
// The first was the acceptance criterion and it has been met. The second is
// regression protection, which is what a test suite is for after a port lands.
//
// Re-record with:
//
//	go test ./... -update-golden      (needs server.js and lib/ restored)
//
// PUT THE PACKAGE PATTERN FIRST. `-update-golden` is not a flag `go test` knows,
// so with `go test -update-golden ./internal/js/` it swallows the pattern as the
// flag's VALUE, falls back to the default package, and re-records something you
// did not ask for. That is not theoretical — it silently overwrote the sync
// recordings once, against a module whose paths had moved, and the corrupted
// answers then looked like a real divergence.
//
// A missing golden is a FAILURE, never a skip. That is the whole point.

// oracleCounter gives each call within one test a stable sequence number, so a
// test making several oracle calls records several distinct files.
var (
	oracleMu      sync.Mutex
	oracleCounter = map[string]int{}
)

// oracleKey names the recording for one call.
//
// Test name plus a sequence number, rather than a hash of the script: the
// scripts embed temporary directory paths that change every run, so a
// content-derived key would never match a recording. The cost is that
// reordering the oracle calls within a test invalidates its recordings, which
// is a re-record rather than a mystery — the file names say which test they
// belong to.
func OracleKey(t *testing.T) string {
	t.Helper()
	oracleMu.Lock()
	defer oracleMu.Unlock()
	name := strings.NewReplacer("/", "_", " ", "_", "'", "", `"`, "", ",", "").Replace(t.Name())
	seq := oracleCounter[name]
	oracleCounter[name] = seq + 1
	if seq == 0 {
		return name
	}
	return fmt.Sprintf("%s#%d", name, seq)
}

// oracle returns the reference bytes for one call.
//
// With -update-golden it runs produce() — which is what executes the JavaScript
// — and records the result. Otherwise it reads the committed file, and fails
// when there is none.
func Oracle(t *testing.T, produce func() []byte) []byte {
	t.Helper()
	key := OracleKey(t)
	path := filepath.Join(GoldenDir(t), key+".txt")

	if *UpdateGolden {
		body := produce()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("recorded %s (%d bytes)", path, len(body))
		return body
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no recorded reference for %s.\n"+
			"  Run `go test -run %s -update-golden` with server.js and lib/ present.\n"+
			"  %v", key, t.Name(), err)
	}
	return body
}

// oracleFile is the same for a whole file of reference output, kept under its
// own name rather than a sequence number — for the large payloads (the insights
// build, the curation clusters) where the name is worth reading in a diff.
func OracleFile(t *testing.T, name string, produce func() []byte) []byte {
	t.Helper()
	path := filepath.Join(GoldenDir(t), name)

	if *UpdateGolden {
		body := produce()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("recorded %s (%d bytes)", path, len(body))
		return body
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no recorded reference at %s.\n"+
			"  Run `go test -run %s -update-golden` with server.js and lib/ present.\n"+
			"  %v", path, t.Name(), err)
	}
	return body
}

// referenceAvailable reports whether the JavaScript implementation is still in
// the tree. Only -update-golden needs it.
func ReferenceAvailable(t *testing.T) bool {
	t.Helper()
	root := RepoRoot(t)
	for _, needed := range []string{"server.js", "lib"} {
		if _, err := os.Stat(filepath.Join(root, needed)); err != nil {
			return false
		}
	}
	return true
}

// requireReference fails a recording run that has nothing to record from.
func RequireReference(t *testing.T) {
	t.Helper()
	if *UpdateGolden && !ReferenceAvailable(t) {
		t.Fatal("-update-golden needs server.js and lib/ in the tree; they are the reference")
	}
}

// shortHash is used to name recordings that are keyed by their input rather than
// by their position.
func ShortHash(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:])[:12]
}

// ── Recorded HTTP responses ─────────────────────────────────────────────────

// recordedResponse is a reference server's answer, in a form that survives being
// written to a file and read back years later.
type recordedResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body"`
}

// reference returns the reference server's response for one request.
//
// Under -update-golden it calls produce() — which boots Express and fetches —
// and records the result. Otherwise it replays the recording.
//
// The body is []byte so encoding/json base64s it: the archive serves PNGs and
// gzip streams as well as JSON, and a recording that only round-trips valid
// UTF-8 would quietly corrupt the interesting cases.
func Reference(t *testing.T, name string, produce func() Response) Response {
	t.Helper()
	raw := OracleFile(t, filepath.Join("http", name+".json"), func() []byte {
		got := produce()
		encoded, err := json.MarshalIndent(recordedResponse{
			Status: got.Status, Headers: got.Headers, Body: got.Body,
		}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		return append(encoded, '\n')
	})

	var stored recordedResponse
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("recorded response %s is unreadable: %v", name, err)
	}
	return Response{Status: stored.Status, Headers: stored.Headers, Body: stored.Body}
}

// responseKey names a recording after the request it answers, so the files in
// testdata/golden/http read as a list of what was checked.
func ResponseKey(path string) string {
	cleaned := strings.NewReplacer("/", "_", "?", "~", "&", "+", "=", "-", "%", "",
		" ", "_", ":", "").Replace(strings.TrimPrefix(path, "/"))
	if cleaned == "" {
		cleaned = "root"
	}
	if len(cleaned) > 90 {
		// Long query strings would make unreadable file names; keep the front of
		// it for legibility and a hash for uniqueness.
		cleaned = cleaned[:80] + "-" + ShortHash(path)
	}
	return cleaned
}

// referenceMap records a map of strings — the file trees and bucket contents the
// sync scenarios compare.
//
// These are recorded SEPARATELY from the sync outcome, and that separation is
// the point. The outcome is what the reference reported; this is the state it
// left behind. Comparing Go's resulting tree against a directory the reference
// mutated only works while the reference actually runs, so the state has to be
// recorded too or the comparison silently becomes "Go's tree versus the
// scenario's untouched starting point".
func ReferenceMap(t *testing.T, name string, produce func() map[string]string) map[string]string {
	t.Helper()
	raw := OracleFile(t, filepath.Join("state", name+".json"), func() []byte {
		encoded, err := json.MarshalIndent(produce(), "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		return append(encoded, '\n')
	})
	var stored map[string]string
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("recorded state %s is unreadable: %v", name, err)
	}
	return stored
}

// scenarioKey turns a scenario's prose name into a file name.
func ScenarioKey(name string) string {
	return strings.NewReplacer(" ", "_", ",", "", "'", "", "/", "_").Replace(name)
}

// stampPattern matches the two places a clock reading leaks into a response
// body: the catalog's `generatedAt`, and the `dataVersion` the insights payload
// derives from it (catalog stamp plus the geocache's mtime).
var stampPattern = regexp.MustCompile(
	`"(generatedAt|dataVersion)":\s*"[^"]*"`)

// withoutStamps replaces those readings with a fixed marker.
//
// A recorded response is compared byte for byte, and a timestamp is not
// behaviour — it changes every time the catalog is rebuilt, which is every time
// somebody adds an event to the fixture. Leaving it in would mean re-recording
// the whole corpus for a reason that has nothing to do with the code. Both sides
// are normalised identically, so a real difference anywhere else still shows.
func WithoutStamps(body []byte) []byte {
	return stampPattern.ReplaceAll(body, []byte(`"$1":"<stamp>"`))
}

// Response is one HTTP answer, in the shape both the recordings and the live
// comparisons use.
type Response struct {
	Status  int
	Headers map[string]string
	Body    []byte
}

// RunNode returns what the JavaScript implementation answers for a case.
//
// It no longer runs it. The answer comes from testdata/golden/, recorded from
// the real thing while it was still in the tree. With -update-golden it does run
// it, and records what it said.
//
// The signature is unchanged from when this executed Node, because every call
// site still means the same thing: "what does the reference say?".
func RunNode(t *testing.T, env []string, script string, args ...string) string {
	t.Helper()
	return string(Oracle(t, func() []byte {
		if _, err := exec.LookPath("node"); err != nil {
			t.Fatal("node is unavailable, and -update-golden needs it")
		}
		cmd := exec.Command("node", append([]string{"--input-type=module", "--eval", script}, args...)...)
		cmd.Dir = RepoRoot(t)
		cmd.Env = append(os.Environ(), env...)
		out, err := cmd.Output()
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				t.Fatalf("node: %s", strings.TrimSpace(string(exit.Stderr)))
			}
			t.Fatal(err)
		}
		return out
	}))
}

// FixedModTime is arbitrary but must never change: every recorded ETag encodes
// it.
var FixedModTime = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

// CopyArchive copies the archive somewhere writable, with every file's
// modification time PINNED.
//
// The pinning is what makes an ETag reproducible. Both implementations derive
// their tag from size and mtime, and `cp` stamps the copy with the time it ran —
// so without this, every run would produce different tags and no recorded
// response could ever match one.
func CopyArchive(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	if err := exec.Command("cp", "-r", src+"/.", dst).Run(); err != nil {
		t.Fatal(err)
	}
	PinModTimes(t, dst)
	return dst
}

// PinModTimes stamps every file under root with FixedModTime.
func PinModTimes(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		return os.Chtimes(path, FixedModTime, FixedModTime)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// ── The reference server ────────────────────────────────────────────────────

// ReferenceBase boots the JavaScript server for a recording run, and returns ""
// otherwise — the caller reads recordings instead.
//
// Nothing SKIPS on the absence of Node. A test whose recording is missing fails,
// loudly, naming the command that would create it.
func ReferenceBase(t *testing.T, dataDir, privateRoot string) string {
	t.Helper()
	if !*UpdateGolden {
		return ""
	}
	RequireReference(t)
	base, ok := startReferenceServer(t, dataDir, privateRoot)
	if !ok {
		t.Fatal("-update-golden needs the reference server to start")
	}
	// The reference rebuilds catalog.json on boot, stamping it with a fresh
	// `generatedAt` and a fresh mtime. Left alone, the recording would capture
	// THAT catalog — and every later replay, serving the committed one, would
	// differ in both the body and the ETag for a reason that is not a
	// regression. It reads the file per request, so restoring the fixture's copy
	// now puts both implementations back on the same bytes.
	restoreFixtureCatalog(t, dataDir)
	return base
}

func restoreFixtureCatalog(t *testing.T, dataDir string) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(ArchiveDir(t), "catalog.json"))
	if err != nil {
		return // an archive without one has nothing to restore
	}
	if err := os.WriteFile(filepath.Join(dataDir, "catalog.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	PinModTimes(t, dataDir)
}

// FreePort finds a port nothing is listening on.
//
// Inherently a race: the listener is closed before the port is handed over, so
// another test can take it in between. Callers retry rather than trusting it.
func FreePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return port
}

func startReferenceServer(t *testing.T, dataDir, privateRoot string) (string, bool) {
	t.Helper()
	root := RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "server.js")); err != nil {
		return "", false
	}
	for attempt := 0; attempt < 3; attempt++ {
		if base, started := tryStartReferenceServer(t, root, dataDir, privateRoot); started {
			return base, true
		}
		t.Logf("the reference server did not come up on attempt %d — retrying", attempt+1)
	}
	return "", false
}

func tryStartReferenceServer(t *testing.T, root, dataDir, privateRoot string) (string, bool) {
	t.Helper()
	port := FreePort(t)
	cmd := exec.Command("node", "server.js")
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"PORT="+strconv.Itoa(port),
		"NODE_ENV=development",
		"AUTH_MODE=open",
		"AUTH_ENABLED=false",
		"DATA_ROOT="+dataDir,
		"IMG_ROOT="+filepath.Join(dataDir, "img"),
		"PRIVATE_ROOT="+privateRoot,
		"S3_BUCKET=",
	)
	if testing.Verbose() {
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	base := "http://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(base + "/healthz")
		if err == nil {
			resp.Body.Close()
			return base, true
		}
		if cmd.ProcessState != nil && cmd.ProcessState.Exited() {
			return "", false // the port was taken: try another
		}
		time.Sleep(100 * time.Millisecond)
	}
	return "", false
}
