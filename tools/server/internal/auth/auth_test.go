package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"server/internal/js"
	ts "server/internal/testsupport"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testSecret = "6b4f8ab10b88cba10012b2dfe9ba19224cf7c85570a2cbc2bf7e9e239d71e542"

// The property a cutover depended on: a cookie issued by one server is accepted
// by the other. Without it, moving traffic logs everyone out — and moving it
// back logs them out again.
//
// Both halves are anchored to a FIXED expiry rather than `now + 1h`, and that is
// not tidiness. Recorded against a moving clock, the reference token would carry
// an expiry an hour after the recording — the test would pass on the day it was
// written and start failing the next, for no reason anyone could act on. A fixed
// expiry makes the recording a permanent vector.
//
// It also makes the second direction real. Asking the reference "is this fresh
// token Go just made valid?" records the answer `true` and then replays `true`
// forever, whatever Go later produces. Comparing the token ITSELF against the one
// the reference produced for the same expiry cannot go vacuous: the bytes either
// match or they do not.
func TestSessionTokensInteroperateWithNode(t *testing.T) {
	ts.RequireReference(t)
	signer := NewSessionSigner(testSecret)

	// 2030-01-01T00:00:00Z — comfortably beyond any clock this runs on, so the
	// token is unexpired whenever the suite is run.
	expiry := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	verifyAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	// The reference issues. lib/auth.js does not export its signer, so the token
	// is built the way the module builds it — same secret, same shape.
	nodeToken := strings.TrimSpace(ts.RunNode(t,
		[]string{"SESSION_SECRET=" + testSecret, "EXPIRY_MS=" + strconv.Itoa(int(expiry.UnixMilli()))}, `
		import crypto from 'crypto';
		const expMs = process.env.EXPIRY_MS;
		const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(expMs).digest('hex');
		process.stdout.write(expMs + '.' + sig);
	`))
	if !signer.Verify(nodeToken, verifyAt) {
		t.Errorf("Go rejected a token issued by the reference: %q", nodeToken)
	}

	// And Go issues the same bytes for the same expiry, which is what made the
	// cookies interchangeable in the first place.
	if got := signer.Issue(expiry); got != nodeToken {
		t.Errorf("Go issued a different token:\n  go:  %q\n  ref: %q", got, nodeToken)
	}

	// An expired token is refused whoever signed it.
	if signer.Verify(nodeToken, expiry.Add(time.Second)) {
		t.Error("an expired token was accepted")
	}
}

func TestSessionTokenRejections(t *testing.T) {
	signer := NewSessionSigner(testSecret)
	now := time.Unix(1700000000, 0)

	valid := signer.Issue(now.Add(time.Hour))
	if !signer.Verify(valid, now) {
		t.Fatal("a freshly issued token should verify")
	}

	cases := map[string]string{
		"empty":              "",
		"no separator":       "12345",
		"expired":            signer.Issue(now.Add(-time.Second)),
		"tampered payload":   "9" + valid,
		"tampered signature": valid[:strings.Index(valid, ".")+1] + strings.Repeat("a", 64),
		"short signature":    valid[:strings.Index(valid, ".")+5],
		"non-hex signature":  valid[:strings.Index(valid, ".")+1] + strings.Repeat("z", 64),
		"no digits":          "abc." + strings.Repeat("0", 64),
	}
	for name, token := range cases {
		if signer.Verify(token, now) {
			t.Errorf("%s: accepted %q", name, token)
		}
	}

	// A different secret must not verify — the whole point of the signature.
	if NewSessionSigner("other").Verify(valid, now) {
		t.Error("a token verified under the wrong secret")
	}
}

// bcryptjs writes the hashes already in the environment. If Go could not read
// them, a migration would mean re-deriving a password.
func TestBcryptHashesFromNodeVerifyInGo(t *testing.T) {
	const password = "correct horse battery staple"
	out := ts.RunNode(t, nil, `
		const bcrypt = (await import('bcryptjs')).default;
		const pw = process.argv[1];
		process.stdout.write(JSON.stringify({
			b: await bcrypt.hash(pw, 10),
			a: (await bcrypt.hash(pw, 10)).replace('$2b$', '$2a$'),
		}));
	`, password)

	var hashes map[string]string
	if err := json.Unmarshal([]byte(out), &hashes); err != nil {
		t.Fatal(err)
	}
	for variant, hash := range hashes {
		if !VerifyPassword(hash, password) {
			t.Errorf("$2%s$ hash from bcryptjs did not verify in Go: %s", variant, hash)
		}
		if VerifyPassword(hash, password+"!") {
			t.Errorf("$2%s$ hash verified the WRONG password", variant)
		}
	}
}

func TestDetectModeMatchesNode(t *testing.T) {
	// Each case is the environment as a flat list of KEY=VALUE.
	cases := [][]string{
		{},
		{"AUTH_PASSWORD_HASH=$2b$12$x"},
		{"DYNAMODB_USERS_TABLE=users"},
		{"DYNAMODB_USERS_TABLE=users", "AUTH_PASSWORD_HASH=$2b$12$x"},
		{"AUTH_MODE=open"},
		{"AUTH_MODE=off"},
		{"AUTH_MODE=session"},
		{"AUTH_MODE=multi"},
		{"AUTH_MODE=SESSION"},
		{"AUTH_MODE=  session  "},
		{"AUTH_MODE=nonsense", "AUTH_PASSWORD_HASH=$2b$12$x"},
		{"AUTH_ENABLED=false", "AUTH_PASSWORD_HASH=$2b$12$x"},
		{"AUTH_ENABLED=FALSE", "DYNAMODB_USERS_TABLE=users"},
		{"AUTH_ENABLED=true", "AUTH_PASSWORD_HASH=$2b$12$x"},
		{"AUTH_PASSWORD_HASH=   "},
	}

	for _, environment := range cases {
		payload := js.Arr()
		for _, entry := range environment {
			payload.Append(js.Str(entry))
		}
		// The module reads process.env at import time, so each case needs a
		// fresh process with only that environment set.
		got := ts.RunNode(t, append(environment,
			// Clear anything the developer's own .env might have set.
			"AUTH_MODE="+valueOf(environment, "AUTH_MODE"),
			"AUTH_ENABLED="+valueOf(environment, "AUTH_ENABLED"),
			"AUTH_PASSWORD_HASH="+valueOf(environment, "AUTH_PASSWORD_HASH"),
			"DYNAMODB_USERS_TABLE="+valueOf(environment, "DYNAMODB_USERS_TABLE"),
		), `
			const { AUTH_MODE } = await import('./lib/auth.js');
			process.stdout.write(AUTH_MODE);
		`)

		lookup := func(name string) string { return valueOf(environment, name) }
		if want := AuthMode(strings.TrimSpace(got)); DetectMode(lookup) != want {
			t.Errorf("env %v: Go says %q, node says %q", environment, DetectMode(lookup), want)
		}
	}
}

func valueOf(environment []string, name string) string {
	for _, entry := range environment {
		if key, value, found := strings.Cut(entry, "="); found && key == name {
			return value
		}
	}
	return ""
}

func TestRefuseToStartOnlyWhenDeployedAndImplicit(t *testing.T) {
	env := func(pairs ...string) func(string) string {
		return func(name string) string { return valueOf(pairs, name) }
	}
	cases := []struct {
		name string
		mode AuthMode
		env  func(string) string
		want bool
	}{
		{"laptop, no auth", ModeOpen, env(), false},
		{"production, no auth, implicit", ModeOpen, env("NODE_ENV=production"), true},
		{"production, no auth, asked for", ModeOpen, env("NODE_ENV=production", "AUTH_MODE=open"), false},
		{"production, no auth, AUTH_MODE=off", ModeOpen, env("NODE_ENV=production", "AUTH_MODE=off"), false},
		{"PORT and HOST set", ModeOpen, env("PORT=3000", "HOST=example.org"), true},
		{"PORT alone is a laptop", ModeOpen, env("PORT=3000"), false},
		{"production with a session", ModeSession, env("NODE_ENV=production"), false},
	}
	for _, testCase := range cases {
		if got := RefuseToStart(testCase.mode, testCase.env); got != testCase.want {
			t.Errorf("%s: RefuseToStart = %v, want %v", testCase.name, got, testCase.want)
		}
	}
}

func TestParseCookiesMatchesNode(t *testing.T) {
	headers := []string{
		"dcs=abc",
		"dcs=abc; other=1",
		"  dcs = abc  ; x=y",
		"dcs=a%20b",
		"dcs=%E2%9C%93",
		"dcs=%zz",  // undecodable — kept as-is rather than dropped
		"novalue",  // no '=' at all
		"dcs=",     //
		"a=1; a=2", // last wins
		"dcs=a=b",  // '=' inside the value
	}

	payload := js.Arr()
	for _, header := range headers {
		payload.Append(js.Str(header))
	}
	out := ts.RunNode(t, nil, `
		const headers = JSON.parse(process.argv[1]);
		const parse = (cookie) => {
			const out = {};
			for (const part of (cookie || '').split(';')) {
				const eq = part.indexOf('=');
				if (eq < 0) continue;
				const k = part.slice(0, eq).trim();
				try { out[k] = decodeURIComponent(part.slice(eq + 1).trim()); }
				catch { out[k] = part.slice(eq + 1).trim(); }
			}
			return out;
		};
		process.stdout.write(JSON.stringify(headers.map(parse)));
	`, string(payload.Encode("")))

	var want []map[string]string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, header := range headers {
		got := ParseCookies(header)
		if len(got) != len(want[i]) {
			t.Errorf("%q: got %v, node %v", header, got, want[i])
			continue
		}
		for key, value := range want[i] {
			if got[key] != value {
				t.Errorf("%q: [%s] = %q, node = %q", header, key, got[key], value)
			}
		}
	}
}

// A token issued by the reference must still verify here — the stored hash is
// what an installation already has on disk, and a migration that could not read
// it would mean reissuing a credential.
//
// The token AND the file it was stored in are both recorded. Recording only the
// token would leave the verification reading a temporary file that no longer
// exists, which fails rather than lying — but fails for the wrong reason, and
// the point is to keep checking that Go reads the reference's format.
func TestAPITokenVerifiesOneIssuedByNode(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, ".api-token.json")

	issued := strings.TrimSpace(ts.RunNode(t, []string{"API_TOKEN_FILE=" + tokenFile}, `
		import { readFileSync } from 'node:fs';
		const { issueToken } = await import('./lib/singleUserToken.js');
		const token = issueToken();
		// Both halves: the plaintext the caller was handed, and the record left
		// behind for it to be checked against.
		process.stdout.write(JSON.stringify({
			token,
			stored: readFileSync(process.env.API_TOKEN_FILE, 'utf8'),
		}));
	`))
	var reference struct{ Token, Stored string }
	if err := json.Unmarshal([]byte(issued), &reference); err != nil {
		t.Fatal(err)
	}
	token := reference.Token
	if token == "" || reference.Stored == "" {
		t.Fatal("the reference issued an empty token")
	}
	// Put the reference's own file on disk, exactly as it wrote it.
	if err := os.WriteFile(tokenFile, []byte(reference.Stored), 0o600); err != nil {
		t.Fatal(err)
	}

	if !VerifyAPIToken(tokenFile, token) {
		t.Error("Go rejected a token issued by Node")
	}
	if VerifyAPIToken(tokenFile, token+"0") {
		t.Error("a token with an extra character verified")
	}
	if VerifyAPIToken(tokenFile, "") {
		t.Error("an empty token verified")
	}
	if VerifyAPIToken(filepath.Join(dir, "absent.json"), token) {
		t.Error("a token verified against a file that does not exist")
	}

	// A corrupt file must read as "no token", never as "any token".
	if err := os.WriteFile(tokenFile, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if VerifyAPIToken(tokenFile, token) {
		t.Error("a corrupt token file accepted a token")
	}
}

func TestCheckAuthResolvesTheCaller(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, ".api-token.json")
	signer := NewSessionSigner(testSecret)
	now := time.Unix(1700000000, 0)

	// A token file with a known secret.
	const secretToken = "0123456789abcdef"
	record, _ := json.Marshal(APIToken{Hash: HashToken(secretToken), CreatedAt: "2026-01-01"})
	if err := os.WriteFile(tokenFile, record, 0o600); err != nil {
		t.Fatal(err)
	}

	session := &Authenticator{
		Mode: ModeSession, Signer: signer, APITokenFile: tokenFile,
		Now: func() time.Time { return now },
	}
	open := &Authenticator{Mode: ModeOpen}

	request := func(headers map[string]string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/api/anything", nil)
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		return r
	}

	if identity := open.CheckAuth(request(nil)); identity == nil || identity.Role != "admin" {
		t.Error("open mode should resolve a synthetic admin")
	}
	if session.CheckAuth(request(nil)) != nil {
		t.Error("session mode with no credentials should resolve nobody")
	}

	valid := signer.Issue(now.Add(time.Hour))
	if identity := session.CheckAuth(request(map[string]string{
		"Cookie": SessionCookie + "=" + valid,
	})); identity == nil || identity.UserID != SingleUserID {
		t.Error("a valid session cookie should resolve the owner")
	}
	if session.CheckAuth(request(map[string]string{
		"Cookie": SessionCookie + "=" + signer.Issue(now.Add(-time.Hour)),
	})) != nil {
		t.Error("an expired cookie resolved someone")
	}

	if identity := session.CheckAuth(request(map[string]string{
		"Authorization": "Bearer " + secretToken,
	})); identity == nil || identity.Role != "admin" {
		t.Error("a valid bearer token should resolve the owner")
	}
	// A BAD bearer token is refused outright rather than falling through to the
	// cookie: the caller meant to authenticate with it, and silently ignoring it
	// hides a revoked token behind a working browser session.
	if session.CheckAuth(request(map[string]string{
		"Authorization": "Bearer wrong",
		"Cookie":        SessionCookie + "=" + valid,
	})) != nil {
		t.Error("a bad bearer token fell through to the cookie")
	}

	// Multi mode is not ported and must refuse rather than guess.
	multi := &Authenticator{Mode: ModeMulti, Signer: signer}
	if multi.CheckAuth(request(map[string]string{"Cookie": SessionCookie + "=" + valid})) != nil {
		t.Error("multi mode should refuse, not fall back to session semantics")
	}
}

func TestRoleAtLeast(t *testing.T) {
	cases := []struct {
		role, minimum string
		want          bool
	}{
		{"admin", "editor", true},
		{"editor", "editor", true},
		{"viewer", "editor", false},
		{"anonymous", "viewer", false},
		{"viewer", "viewer", true},
		{"admin", "admin", true},
		{"editor", "admin", false},
		{"", "viewer", false},
		{"nonsense", "viewer", false},
		{"nonsense", "anonymous", true}, // unknown ranks as anonymous, which meets anonymous
	}
	for _, testCase := range cases {
		if got := RoleAtLeast(testCase.role, testCase.minimum); got != testCase.want {
			t.Errorf("RoleAtLeast(%q, %q) = %v, want %v",
				testCase.role, testCase.minimum, got, testCase.want)
		}
	}
}

func TestSetCookieMatchesNode(t *testing.T) {
	signer := NewSessionSigner(testSecret)
	recorder := httptest.NewRecorder()
	signer.SetCookie(recorder, "1700000000000.abcdef", false)
	got := recorder.Header().Get("Set-Cookie")
	want := "dcs=1700000000000.abcdef; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800"
	if got != want {
		t.Errorf("Set-Cookie = %q\n          want %q", got, want)
	}

	production := httptest.NewRecorder()
	signer.SetCookie(production, "x", true)
	if !strings.HasSuffix(production.Header().Get("Set-Cookie"), "; Secure") {
		t.Error("production cookie is missing Secure")
	}

	cleared := httptest.NewRecorder()
	ClearCookie(cleared)
	if got := cleared.Header().Get("Set-Cookie"); got != "dcs=; Path=/; HttpOnly; Max-Age=0" {
		t.Errorf("cleared cookie = %q", got)
	}
}

// encodeURIComponent is not url.QueryEscape: the difference is a space, which
// becomes %20 rather than a plus sign.
func TestURLComponentEncodingMatchesJavaScript(t *testing.T) {
	inputs := []string{"a b", "a+b", "café", "a/b?c=d&e", "~_.-!*'()", "✓", ""}
	payload := js.Arr()
	for _, input := range inputs {
		payload.Append(js.Str(input))
	}
	out := ts.RunNode(t, nil, `
		const inputs = JSON.parse(process.argv[1]);
		process.stdout.write(JSON.stringify(inputs.map(encodeURIComponent)));
	`, string(payload.Encode("")))

	var want []string
	if err := json.Unmarshal([]byte(out), &want); err != nil {
		t.Fatal(err)
	}
	for i, input := range inputs {
		if got := urlQueryEscape(input); got != want[i] {
			t.Errorf("encode(%q) = %q, node = %q", input, got, want[i])
		}
		if round, err := urlQueryUnescape(want[i]); err != nil || round != input {
			t.Errorf("decode(%q) = %q (err %v), want %q", want[i], round, err, input)
		}
	}
}
