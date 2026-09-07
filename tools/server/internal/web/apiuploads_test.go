package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/auth"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strings"
	"testing"
	"time"
)

func uploadTestApp(t *testing.T, root string) (*httptest.Server, *UploadAPI) {
	t.Helper()
	appRoot := filepath.Join(ts.RepoRoot(t), "app")
	authenticator := &auth.Authenticator{Mode: auth.ModeOpen, Signer: auth.NewSessionSigner("test-secret")}
	uploads := &UploadAPI{
		ImgDir:      filepath.Join(root, "img"),
		ReceiptDir:  filepath.Join(root, "receipts"),
		DocumentDir: filepath.Join(root, "documents"),
		MaxBytes:    1 << 20,
		Now:         func() time.Time { return time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC) },
		Rates: func(_ context.Context, url string) (int, []byte, error) {
			return 200, []byte(`{"base":"EUR","rates":{"GBP":0.85},"url":"` + url + `"}`), nil
		},
	}
	server := httptest.NewServer(NewApp(AppConfig{
		Mode:          auth.ModeOpen,
		Authenticator: authenticator,
		Uploads:       uploads,
		Login: &auth.LoginService{Mode: auth.ModeOpen, Signer: authenticator.Signer,
			AppRoot: appRoot, Limiter: auth.NewLoginRateLimiter()},
	}))
	t.Cleanup(server.Close)
	return server, uploads
}

// postUpload sends a multipart form the way the browser client does.
func postUpload(t *testing.T, client *http.Client, url, fileName string,
	body []byte, fields map[string]string) ts.Response {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if fileName != "" {
		part, err := writer.CreateFormFile("file", fileName)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	request, err := http.NewRequest(http.MethodPost, url, &buffer)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return ts.Response{Status: resp.StatusCode, Body: payload,
		Headers: map[string]string{"Cache-Control": resp.Header.Get("Cache-Control")}}
}

// The stored name is ALWAYS server-generated. This is the rule that keeps a
// caller from choosing where their bytes land.
func TestUploadNamesAreServerGenerated(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	cases := []struct {
		name         string
		originalName string
		fileName     string
		wantPath     string
	}{
		{"a described upload keeps its description",
			"IMG_9999.jpg", "conference-pass", "receipts/events/e/conference-pass.jpg"},
		{"no description gets a timestamp",
			"IMG_9999.jpg", "", "receipts/events/e/receipt-20260304-050607.jpg"},
		// Only the EXTENSION is taken from the upload — never the name, and never
		// a path. The separators become underscores, and the leading run of dots
		// and underscores is then stripped entirely, so `../../etc/passwd` lands
		// as a flat `etc_passwd`.
		{"a traversal in the client's name is neutralised",
			"x.png", "../../etc/passwd", "receipts/events/e/etc_passwd.png"},
		{"a slash in the client's name is neutralised",
			"x.png", "a/b/c", "receipts/events/e/a_b_c.png"},
		{"a name that is only punctuation falls back",
			"x.png", "...", "receipts/events/e/receipt-20260304-050607.png"},
		{"no extension is fine", "noext", "thing", "receipts/events/e/thing"},
		{"a two-part extension keeps only the last",
			"archive.tar.gz", "backup", "receipts/events/e/backup.gz"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resp := postUpload(t, client, server.URL+"/api/receipts", testCase.originalName,
				[]byte("bytes"), map[string]string{
					"eventFile": "events/e.json",
					"fileName":  testCase.fileName,
				})
			if resp.Status != 200 {
				t.Fatalf("status = %d: %s", resp.Status, resp.Body)
			}
			var out struct{ Path string }
			if err := json.Unmarshal(resp.Body, &out); err != nil {
				t.Fatal(err)
			}
			if out.Path != testCase.wantPath {
				t.Errorf("path = %q, want %q", out.Path, testCase.wantPath)
			}
			// And it is really there, under the receipts root.
			full := filepath.Join(root, strings.TrimPrefix(out.Path, "receipts/"))
			if _, err := os.Stat(filepath.Join(root, "receipts",
				strings.TrimPrefix(out.Path, "receipts/"))); err != nil {
				t.Errorf("not written where the response said (%s): %v", full, err)
			}
		})
	}

	// Nothing escaped the upload root.
	escaped := filepath.Join(filepath.Dir(root), "etc")
	if _, err := os.Stat(escaped); err == nil {
		t.Error("an upload escaped its root")
	}
}

// Collisions get a suffix so nothing is ever overwritten — a second receipt for
// the same trip must not silently replace the first.
func TestUploadCollisionsGetASuffix(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	var paths []string
	for range 3 {
		resp := postUpload(t, client, server.URL+"/api/receipts", "x.png", []byte("bytes"),
			map[string]string{"eventFile": "events/e.json", "fileName": "pass"})
		if resp.Status != 200 {
			t.Fatalf("status = %d: %s", resp.Status, resp.Body)
		}
		var out struct{ Path string }
		if err := json.Unmarshal(resp.Body, &out); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, out.Path)
	}
	want := []string{
		"receipts/events/e/pass.png",
		"receipts/events/e/pass-2.png",
		"receipts/events/e/pass-3.png",
	}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("paths = %v, want %v", paths, want)
	}
}

func TestUploadRefusals(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	cases := []struct {
		name, url, fileName string
		fields              map[string]string
		body                []byte
		status              int
		expect              string
	}{
		{"no file", server.URL + "/api/receipts", "",
			map[string]string{"eventFile": "events/e.json"}, nil, 400, "No file received"},
		{"no eventFile", server.URL + "/api/receipts", "x.png",
			map[string]string{}, []byte("x"), 400, "eventFile required"},
		{"too large", server.URL + "/api/receipts", "x.png",
			map[string]string{"eventFile": "events/e.json"},
			bytes.Repeat([]byte("x"), (1<<20)+1), 413, ""},
		{"an image needs an img/ target", server.URL + "/api/upload", "x.png",
			map[string]string{"targetPath": "data/evil.json"}, []byte("x"), 400,
			"targetPath must start with img/"},
		{"an image target cannot traverse", server.URL + "/api/upload", "x.png",
			map[string]string{"targetPath": "img/../../evil.png"}, []byte("x"), 400,
			"Invalid path"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			resp := postUpload(t, client, testCase.url, testCase.fileName, testCase.body, testCase.fields)
			if resp.Status != testCase.status {
				t.Errorf("status = %d, want %d: %.200s", resp.Status, testCase.status, resp.Body)
			}
			if testCase.expect != "" && !strings.Contains(string(resp.Body), testCase.expect) {
				t.Errorf("body %.200s does not contain %q", resp.Body, testCase.expect)
			}
		})
	}
}

// A dataset image lands where the dataset will point at it.
func TestImageUploadStoresUnderTheImageRoot(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	// The editor sends `./img/…` because that is the form a dataset stores.
	resp := postUpload(t, client, server.URL+"/api/upload", "logo.png", []byte("PNG"),
		map[string]string{"targetPath": "./img/logos/drupalcamp.png"})
	if resp.Status != 200 {
		t.Fatalf("status = %d: %s", resp.Status, resp.Body)
	}
	var out struct{ Path string }
	if err := json.Unmarshal(resp.Body, &out); err != nil {
		t.Fatal(err)
	}
	if out.Path != "./img/logos/drupalcamp.png" {
		t.Errorf("path = %q", out.Path)
	}
	written, err := os.ReadFile(filepath.Join(root, "img", "logos", "drupalcamp.png"))
	if err != nil || string(written) != "PNG" {
		t.Errorf("file = %q %v", written, err)
	}
}

// Deleting is idempotent: a client retrying a cleanup should not see a failure
// for work already done.
func TestUploadDeleteIsIdempotent(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	resp := postUpload(t, client, server.URL+"/api/receipts", "x.png", []byte("bytes"),
		map[string]string{"eventFile": "events/e.json", "fileName": "pass"})
	if resp.Status != 200 {
		t.Fatalf("upload = %d: %s", resp.Status, resp.Body)
	}

	for range 2 {
		deleted := deleteURL(t, client, server.URL+"/api/receipts/events/e/pass.png")
		if deleted.Status != 200 {
			t.Errorf("delete = %d: %s", deleted.Status, deleted.Body)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "receipts", "events", "e", "pass.png")); err == nil {
		t.Error("the file is still there")
	}
	// A traversal in the delete path is refused rather than followed.
	if bad := deleteURL(t, client, server.URL+"/api/receipts/../../../etc/passwd"); bad.Status == 200 {
		t.Errorf("a traversal delete was accepted: %d", bad.Status)
	}
}

// The rate proxy validates its inputs before it reaches upstream, and caches
// history far longer than today.
func TestRatesProxy(t *testing.T) {
	root := t.TempDir()
	server, _ := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	latest := getBody(t, client, server.URL+"/api/rates?base=eur")
	if latest.Status != 200 {
		t.Fatalf("latest = %d: %s", latest.Status, latest.Body)
	}
	// Lowercase in, uppercase upstream: the client should not have to care.
	if !strings.Contains(string(latest.Body), "base=EUR") {
		t.Errorf("upstream url = %s", latest.Body)
	}
	if latest.Headers["Cache-Control"] != "public, max-age=3600" {
		t.Errorf("latest Cache-Control = %q", latest.Headers["Cache-Control"])
	}

	// Historical rates never change.
	historical := getBody(t, client, server.URL+"/api/rates?base=EUR&date=2024-05-01")
	if historical.Headers["Cache-Control"] != "public, max-age=31536000" {
		t.Errorf("historical Cache-Control = %q", historical.Headers["Cache-Control"])
	}
	if !strings.Contains(string(historical.Body), "/2024-05-01?") {
		t.Errorf("upstream url = %s", historical.Body)
	}

	for _, bad := range []string{
		"?base=EURO", "?base=", "?base=E1R", "?base=EUR&date=01-05-2024", "?base=EUR&date=yesterday",
	} {
		if resp := getBody(t, client, server.URL+"/api/rates"+bad); resp.Status != 400 {
			t.Errorf("%s = %d, want 400: %s", bad, resp.Status, resp.Body)
		}
	}
}

// An upstream that fails is a 502, not a 200 with nonsense in it.
func TestRatesProxyReportsUpstreamFailure(t *testing.T) {
	root := t.TempDir()
	server, uploads := uploadTestApp(t, root)
	client := &http.Client{Timeout: 30 * time.Second}

	uploads.Rates = func(context.Context, string) (int, []byte, error) {
		return 503, []byte("upstream is down"), nil
	}
	if resp := getBody(t, client, server.URL+"/api/rates?base=EUR"); resp.Status != 502 {
		t.Errorf("= %d, want 502: %s", resp.Status, resp.Body)
	}

	// And an upstream that returns something that is not JSON at all must not be
	// passed through as though it were.
	uploads.Rates = func(context.Context, string) (int, []byte, error) {
		return 200, []byte("<html>error page</html>"), nil
	}
	if resp := getBody(t, client, server.URL+"/api/rates?base=EUR"); resp.Status != 502 {
		t.Errorf("non-JSON upstream = %d, want 502: %s", resp.Status, resp.Body)
	}
}

// The base-name derivation is a security rule, so it is pinned against the
// JavaScript that owns it rather than against my reading of the regexes.
func TestUploadBaseNameMatchesNode(t *testing.T) {
	names := []string{
		"conference-pass", "../../etc/passwd", "a/b/c", "...", "___", "  spaced  out  ",
		"Ünïcodé Ñame", "file.name.with.dots", "-leading-dash", "trailing-dash-",
		"", "..", "._-mixed-_.", "CAPS and 123",
	}
	payload := js.Arr()
	for _, name := range names {
		payload.Append(js.Str(name))
	}
	out := ts.RunNode(t, nil, `
		const names = JSON.parse(process.argv[1]);
		// The two lines from resolveUploadName in server.js that derive the base.
		const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
		process.stdout.write(JSON.stringify(names.map(
			(n) => sanitize(n).replace(/^[._-]+|[._-]+$/g, ''))));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	uploads := &UploadAPI{Now: func() time.Time { return time.Unix(0, 0).UTC() }}
	for i, name := range names {
		// resolveName falls back to a timestamp when the base is empty, so the
		// derivation is read back out of the resolved path.
		relative, ok := uploads.resolveName("s", name, "x.png", "receipt",
			func(string) bool { return false })
		if !ok {
			t.Fatalf("%q: could not allocate a name", name)
		}
		got := strings.TrimSuffix(strings.TrimPrefix(relative, "s/"), ".png")
		if want[i] == "" {
			// Both fall back; the shape of the fallback is asserted elsewhere.
			if !strings.HasPrefix(got, "receipt-") {
				t.Errorf("%q: expected a generated name, got %q", name, got)
			}
			continue
		}
		if got != want[i] {
			t.Errorf("base of %q = %q, node = %q", name, got, want[i])
		}
	}
}
