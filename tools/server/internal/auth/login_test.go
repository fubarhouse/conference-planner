package auth

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	ts "server/internal/testsupport"
	"strconv"
	"strings"
	"testing"
	"time"
)

// bcryptHash asks bcryptjs for a hash of a password, so the Go side is tested
// against the shape the deployment actually holds.
func bcryptHash(t *testing.T, password string) string {
	t.Helper()
	return strings.TrimSpace(ts.RunNode(t, nil, `
		const bcrypt = (await import('bcryptjs')).default;
		process.stdout.write(await bcrypt.hash(process.argv[1], 10));
	`, password))
}

func newLoginService(t *testing.T, hash string) *LoginService {
	t.Helper()
	return &LoginService{
		Mode:         ModeSession,
		Signer:       NewSessionSigner(testSecret),
		PasswordHash: hash,
		AppRoot:      filepath.Join(ts.RepoRoot(t), "app"),
		Limiter:      NewLoginRateLimiter(),
	}
}

// startNodeAuthServer boots the Express app in session mode with a known
// password, so both sign-in surfaces can be driven with the same credential.
func startNodeAuthServer(t *testing.T, hash string) (string, bool) {
	t.Helper()
	root := ts.RepoRoot(t)
	if _, err := os.Stat(filepath.Join(root, "node_modules", "express")); err != nil {
		return "", false
	}
	if _, err := exec.LookPath("node"); err != nil {
		return "", false
	}

	dataDir := ts.ArchiveDir(t)
	if dataDir == "" {
		return "", false
	}

	for attempt := 0; attempt < 3; attempt++ {
		if base, started := tryStartNodeAuthServer(t, root, dataDir, hash); started {
			return base, true
		}
		t.Logf("auth server did not come up on attempt %d — retrying on another port", attempt+1)
	}
	t.Fatal("node auth server did not become ready after three attempts")
	return "", false
}

func tryStartNodeAuthServer(t *testing.T, root, dataDir, hash string) (string, bool) {
	t.Helper()
	port := ts.FreePort(t)
	cmd := exec.Command("node", "server.js")
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"PORT="+strconv.Itoa(port),
		"NODE_ENV=development",
		"AUTH_MODE=session",
		"AUTH_ENABLED=true",
		"AUTH_PASSWORD_HASH="+hash,
		"SESSION_SECRET="+testSecret,
		"DATA_ROOT="+dataDir,
		"IMG_ROOT="+filepath.Join(dataDir, "img"),
		"PRIVATE_ROOT="+t.TempDir(),
		"S3_BUCKET=",
	)
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

// The sign-in flow, compared against the real Express one: same statuses, same
// redirect, same cookie shape — and, crucially, cookies each accepts from the
// other.
func TestLoginFlowMatchesTheNodeServer(t *testing.T) {
	const password = "a test password"
	hash := bcryptHash(t, password)

	// The reference server runs only while recording. Every assertion below is a
	// property of the sign-in flow, not a diff against Node, so they hold on
	// their own — the one genuinely cross-implementation property (a cookie
	// issued by one being accepted by the other) is pinned as a token vector in
	// TestSessionTokensInteroperateWithNode, which does not need a live server.
	nodeBase := ""
	if *ts.UpdateGolden {
		ts.RequireReference(t)
		base, ok := startNodeAuthServer(t, hash)
		if !ok {
			t.Fatal("-update-golden needs the reference server to start")
		}
		nodeBase = base
	}

	service := newLoginService(t, hash)
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			service.HandleLogin(w, r)
			return
		}
		service.ServeLoginPage(w, r)
	})
	mux.HandleFunc("/logout", service.HandleLogout)
	goServer := httptest.NewServer(mux)
	defer goServer.Close()

	client := &http.Client{
		Timeout:       30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	post := func(base string, form url.Values) *http.Response {
		resp, err := client.PostForm(base+"/login", form)
		if err != nil {
			t.Fatalf("POST %s/login: %v", base, err)
		}
		return resp
	}

	// The page itself.
	for _, base := range servers(nodeBase, goServer.URL) {
		resp, err := client.Get(base + "/login")
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s GET /login = %d", base, resp.StatusCode)
		}
		if !strings.Contains(string(body), `name="password"`) {
			t.Errorf("%s GET /login did not render the form", base)
		}
		if strings.Contains(string(body), "<!--") && strings.Contains(string(body), "-->") {
			// Placeholders must be filled, not shipped.
			for _, marker := range []string{"USERNAME_FIELD", "ERROR", "PWD_AUTOFOCUS", "MODE"} {
				if strings.Contains(string(body), marker) {
					t.Errorf("%s GET /login leaked the %s placeholder", base, marker)
				}
			}
		}
	}

	// Wrong password.
	for _, base := range servers(nodeBase, goServer.URL) {
		resp := post(base, url.Values{"password": {"wrong"}})
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s wrong password = %d, want 401", base, resp.StatusCode)
		}
		if !strings.Contains(string(body), "Incorrect password.") {
			t.Errorf("%s wrong password did not say so", base)
		}
		if resp.Header.Get("Set-Cookie") != "" {
			t.Errorf("%s set a cookie on a failed sign-in", base)
		}
	}

	// Right password: both redirect and both set a cookie the OTHER accepts.
	cookies := map[string]string{}
	for name, base := range namedServers(nodeBase, goServer.URL) {
		resp := post(base, url.Values{"password": {password}})
		resp.Body.Close()
		if resp.StatusCode != http.StatusFound {
			t.Errorf("%s correct password = %d, want 302", name, resp.StatusCode)
		}
		if got := resp.Header.Get("Location"); got != "/planner" {
			t.Errorf("%s redirected to %q, want /planner", name, got)
		}
		cookie := resp.Header.Get("Set-Cookie")
		for _, attribute := range []string{"Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=604800"} {
			if !strings.Contains(cookie, attribute) {
				t.Errorf("%s cookie is missing %s: %q", name, attribute, cookie)
			}
		}
		value, _, _ := strings.Cut(strings.TrimPrefix(cookie, SessionCookie+"="), ";")
		cookies[name] = value
	}

	signer := NewSessionSigner(testSecret)
	for name, value := range cookies {
		if !signer.Verify(value, time.Now()) {
			t.Errorf("Go rejected the cookie issued by %s", name)
		}
	}

	// `next` is honoured, and an off-site one is not.
	for _, base := range servers(nodeBase, goServer.URL) {
		resp := post(base, url.Values{"password": {password}, "next": {"/editor"}})
		resp.Body.Close()
		if got := resp.Header.Get("Location"); got != "/editor" {
			t.Errorf("%s next=/editor → %q", base, got)
		}
		resp = post(base, url.Values{"password": {password}, "next": {"//evil.example/"}})
		resp.Body.Close()
		if got := resp.Header.Get("Location"); got != "/planner" {
			t.Errorf("%s open redirect: next=//evil.example → %q", base, got)
		}
	}
}

func TestLoginPageRendersTheSharedTemplate(t *testing.T) {
	service := newLoginService(t, "")

	single := service.RenderLogin("", false)
	if strings.Contains(single, `name="username"`) {
		t.Error("session mode should have no username field")
	}
	if !strings.Contains(single, `autocomplete="current-password" autofocus required`) {
		t.Error("the password field should take focus when it is the only field")
	}
	// The element, not the class: the template's own stylesheet defines
	// .lf-error whether or not an error is being shown.
	if strings.Contains(single, `<p class="lf-error"`) {
		t.Error("no error was passed, so none should be rendered")
	}
	if !strings.Contains(single, "server session") {
		t.Error("the mode badge should name the mode")
	}

	multi := service.RenderLogin("Nope.", true)
	if !strings.Contains(multi, `name="username"`) {
		t.Error("multi mode should render a username field")
	}
	if strings.Contains(multi, `autocomplete="current-password" autofocus`) {
		t.Error("the username field takes focus in multi mode, not the password")
	}
	if !strings.Contains(multi, `<p class="lf-error"><i class="fas fa-circle-exclamation"></i>Nope.</p>`) {
		t.Error("the error was not rendered")
	}

	for _, marker := range []string{"USERNAME_FIELD", "ERROR", "PWD_AUTOFOCUS", "MODE"} {
		if strings.Contains(multi, marker) || strings.Contains(single, marker) {
			t.Errorf("the %s placeholder survived rendering", marker)
		}
	}
}

func TestLoginRateLimiter(t *testing.T) {
	now := time.Unix(1700000000, 0)
	limiter := NewLoginRateLimiter()
	limiter.Now = func() time.Time { return now }

	// Ten attempts are allowed; the eleventh is not.
	for i := 1; i <= 10; i++ {
		if limiter.Exceeded("10.0.0.1") {
			t.Fatalf("attempt %d was refused", i)
		}
	}
	if !limiter.Exceeded("10.0.0.1") {
		t.Error("the eleventh attempt should be refused")
	}

	// Another address is unaffected.
	if limiter.Exceeded("10.0.0.2") {
		t.Error("the limit should be per address")
	}

	// A successful sign-in clears it.
	limiter.Clear("10.0.0.1")
	if limiter.Exceeded("10.0.0.1") {
		t.Error("clearing should reset the count")
	}

	// And the window expires.
	limiter.Now = func() time.Time { return now.Add(16 * time.Minute) }
	for i := 0; i < 10; i++ {
		if limiter.Exceeded("10.0.0.2") {
			t.Fatal("the window should have reset")
		}
	}
}

func TestLoginIsRateLimitedAfterTenAttempts(t *testing.T) {
	service := newLoginService(t, bcryptHash(t, "right"))
	for i := 0; i < 10; i++ {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/login",
			strings.NewReader("password=wrong"))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		service.HandleLogin(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d, want 401", i+1, recorder.Code)
		}
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader("password=wrong"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	service.HandleLogin(recorder, request)
	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("the eleventh attempt = %d, want 429", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "Too many attempts") {
		t.Error("the 429 should say why")
	}
}

func TestVerifyPassword(t *testing.T) {
	const password = "hunter2"
	service := newLoginService(t, bcryptHash(t, password))

	call := func(body string) (int, map[string]any) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/auth/verify", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		service.HandleVerifyPassword(recorder, request)
		var parsed map[string]any
		_ = json.Unmarshal(recorder.Body.Bytes(), &parsed)
		return recorder.Code, parsed
	}

	status, body := call(`{"password":"hunter2"}`)
	if status != http.StatusOK || body["ok"] != true || body["mode"] != "session" {
		t.Errorf("correct password → %d %v", status, body)
	}
	status, body = call(`{"password":"nope"}`)
	if status != http.StatusUnauthorized || body["ok"] != false {
		t.Errorf("wrong password → %d %v", status, body)
	}

	open := &LoginService{Mode: ModeOpen, Limiter: NewLoginRateLimiter()}
	recorder := httptest.NewRecorder()
	open.HandleVerifyPassword(recorder,
		httptest.NewRequest(http.MethodPost, "/api/auth/verify", strings.NewReader("{}")))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"mode":"open"`) {
		t.Errorf("open mode → %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLogoutClearsTheCookie(t *testing.T) {
	service := newLoginService(t, "")
	recorder := httptest.NewRecorder()
	service.HandleLogout(recorder, httptest.NewRequest(http.MethodGet, "/logout", nil))

	if recorder.Code != http.StatusFound || recorder.Header().Get("Location") != "/" {
		t.Errorf("logout → %d %q", recorder.Code, recorder.Header().Get("Location"))
	}
	if got := recorder.Header().Get("Set-Cookie"); got != "dcs=; Path=/; HttpOnly; Max-Age=0" {
		t.Errorf("logout cookie = %q", got)
	}
}

// servers lists the implementations to assert against: always Go, and the
// reference too while it is being recorded from.
func servers(nodeBase, goBase string) []string {
	if nodeBase == "" {
		return []string{goBase}
	}
	return []string{nodeBase, goBase}
}

func namedServers(nodeBase, goBase string) map[string]string {
	out := map[string]string{"go": goBase}
	if nodeBase != "" {
		out["reference"] = nodeBase
	}
	return out
}
