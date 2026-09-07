package auth

// A Go port of the authentication core from lib/auth.js and
// lib/singleUserToken.js.
//
// This is the slice everything else waits on: every write route and half the
// read routes are gated by it, so nothing else can move until a Go request can
// answer "who is this, and may they?" the same way the Node one does.
//
// The property that makes a cutover possible is INTEROPERABILITY, not just
// equivalence. A session cookie issued by the Node server must verify here and
// vice versa, or every signed-in person is logged out the moment traffic moves
// — and logged out again if it moves back. auth_test.go proves that in both
// directions by running the real JavaScript.
//
// Multi-user mode (DynamoDB + JWT) is deliberately NOT here. It is unused in
// this deployment, it is the only mode needing an AWS dependency, and porting an
// unexercised auth path is how you get an auth path nobody has ever run.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	// SessionCookie is the cookie name. Shared with the Node server by
	// definition: the same browser presents it to both.
	SessionCookie = "dcs"
	// SessionDuration is how long a session lasts.
	SessionDuration = 7 * 24 * time.Hour
	// SingleUserID is the one identity in session mode. Session mode has no user
	// table, but the token routes are addressed as /api/users/:id/token, so the
	// single user needs a stable id to be addressed BY. Not a secret.
	SingleUserID = "owner"
)

// AuthMode is how the server decides who is calling.
type AuthMode string

const (
	ModeOpen    AuthMode = "open"    // no auth; every caller is a synthetic admin
	ModeSession AuthMode = "session" // one password, one identity
	ModeMulti   AuthMode = "multi"   // DynamoDB users + JWT — not ported, see above
)

// roleLevels ranks the roles. Anything unknown is anonymous, which is the safe
// direction: an unrecognised role grants nothing rather than everything.
var roleLevels = map[string]int{"anonymous": 0, "viewer": 1, "editor": 2, "admin": 3}

// Identity is the resolved caller.
type Identity struct {
	UserID   string
	Username string
	Role     string
}

// DetectMode mirrors detectMode(). The order matters: an explicit setting wins,
// then the presence of a users table, then the presence of a password hash, and
// the fallback is open.
//
// Note that it FAILS OPEN — an unset, empty or misspelled AUTH_PASSWORD_HASH
// lands in open mode silently. That is why RefuseToStart exists below.
func DetectMode(env func(string) string) AuthMode {
	lower := func(name string) string { return strings.ToLower(strings.TrimSpace(env(name))) }

	if lower("AUTH_ENABLED") == "false" {
		return ModeOpen
	}
	switch lower("AUTH_MODE") {
	case "off", "open":
		return ModeOpen
	case "multi":
		return ModeMulti
	case "session":
		return ModeSession
	}
	if strings.TrimSpace(env("DYNAMODB_USERS_TABLE")) != "" {
		return ModeMulti
	}
	if strings.TrimSpace(env("AUTH_PASSWORD_HASH")) != "" {
		return ModeSession
	}
	return ModeOpen
}

// RefuseToStart reports whether running in open mode here would be a mistake.
//
// This app serves personal data — trip planners, contacts, uploaded tickets and
// receipts. Running open is a legitimate choice for a laptop; on a deployed box
// it is almost certainly a misconfiguration, and one nobody notices until the
// data is public. So it has to be asked for IN WORDS.
func RefuseToStart(mode AuthMode, env func(string) string) bool {
	if mode != ModeOpen {
		return false
	}
	deployed := env("NODE_ENV") == "production" || (env("PORT") != "" && env("HOST") != "")
	explicit := false
	switch strings.ToLower(strings.TrimSpace(env("AUTH_MODE"))) {
	case "off", "open":
		explicit = true
	}
	return deployed && !explicit
}

// ── Session tokens ──────────────────────────────────────────────────────────

// SessionSigner issues and checks the session cookie's value.
//
// The token is `<expiry-in-ms>.<hmac-sha256-hex>` — not a JWT. Its whole
// content is an expiry, because in session mode there is only one identity to
// be; the signature is what makes the expiry trustworthy.
type SessionSigner struct{ secret []byte }

// NewSessionSigner takes the shared secret. An empty secret is the caller's
// decision to make — the Node side falls back to random bytes, which means
// sessions do not survive a restart, and the same is true here.
func NewSessionSigner(secret string) *SessionSigner {
	return &SessionSigner{secret: []byte(secret)}
}

func (s *SessionSigner) sign(payload string) string {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(payload))
	return hex.EncodeToString(mac.Sum(nil))
}

// Issue mints a token that expires at the given time.
func (s *SessionSigner) Issue(expiry time.Time) string {
	payload := strconv.FormatInt(expiry.UnixMilli(), 10)
	return payload + "." + s.sign(payload)
}

// Verify reports whether a token is well-formed, correctly signed and unexpired.
//
// The signature comparison mirrors the original's padding trick: the candidate
// is padded to 64 hex characters and truncated to 64 before decoding, so a
// short or long signature still produces an equal-length buffer and the
// comparison cannot leak the expected length through timing.
func (s *SessionSigner) Verify(raw string, now time.Time) bool {
	dot := strings.Index(raw, ".")
	if dot < 0 {
		return false
	}
	payload, signature := raw[:dot], raw[dot+1:]

	padded := signature
	if len(padded) < 64 {
		padded += strings.Repeat("0", 64-len(padded))
	}
	padded = padded[:64]

	got, err := hex.DecodeString(padded)
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(s.sign(payload))
	if err != nil || subtle.ConstantTimeCompare(got, want) != 1 {
		return false
	}

	// parseInt stops at the first non-digit and yields NaN for no digits at all,
	// which compares false against any time. strconv is stricter, so a payload
	// JavaScript would read as "1234abc" → 1234 has to be handled explicitly.
	expiry, ok := parseIntPrefix(payload)
	if !ok {
		return false
	}
	return now.UnixMilli() < expiry
}

// parseIntPrefix is JavaScript's parseInt(s, 10): leading whitespace and sign,
// then digits, stopping at the first character that is not one.
func parseIntPrefix(s string) (int64, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	end := 0
	if end < len(s) && (s[end] == '+' || s[end] == '-') {
		end++
	}
	digits := end
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == digits {
		return 0, false
	}
	value, err := strconv.ParseInt(s[:end], 10, 64)
	return value, err == nil
}

// SetCookie writes the session cookie exactly as the Node server does.
func (s *SessionSigner) SetCookie(w http.ResponseWriter, value string, production bool) {
	cookie := SessionCookie + "=" + urlQueryEscape(value) +
		"; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
		strconv.Itoa(int(SessionDuration.Seconds()))
	if production {
		cookie += "; Secure"
	}
	w.Header().Set("Set-Cookie", cookie)
}

// ClearCookie expires the session cookie.
func ClearCookie(w http.ResponseWriter) {
	w.Header().Set("Set-Cookie", SessionCookie+"=; Path=/; HttpOnly; Max-Age=0")
}

// ParseCookies mirrors the hand-rolled parser in lib/auth.js, including its
// tolerance: a value that will not percent-decode is kept as it arrived rather
// than dropping the cookie.
func ParseCookies(header string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(header, ";") {
		eq := strings.Index(part, "=")
		if eq < 0 {
			continue
		}
		name := strings.TrimSpace(part[:eq])
		value := strings.TrimSpace(part[eq+1:])
		if decoded, err := urlQueryUnescape(value); err == nil {
			out[name] = decoded
		} else {
			out[name] = value
		}
	}
	return out
}

// ── Passwords ───────────────────────────────────────────────────────────────

// VerifyPassword checks a password against a bcrypt hash.
//
// bcryptjs writes `$2a$` and `$2b$` hashes and x/crypto/bcrypt reads both, so
// the hash already in the environment keeps working — which matters, because
// the alternative is asking someone to re-derive their password hash during a
// migration.
func VerifyPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// ── The single-user API token ───────────────────────────────────────────────

// APIToken is the stored record: only ever a hash.
type APIToken struct {
	Hash      string `json:"hash"`
	CreatedAt string `json:"createdAt"`
}

// HashToken is the stored form of a bearer token.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ReadAPIToken loads the record, or nil. A corrupt file must read as "no
// token", never as "any token".
func ReadAPIToken(path string) *APIToken {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var record APIToken
	if err := json.Unmarshal(raw, &record); err != nil || record.Hash == "" {
		return nil
	}
	return &record
}

// VerifyAPIToken reports whether a bearer token matches the stored one,
// comparing hashes so the comparison is over equal-length inputs whatever the
// caller sent.
func VerifyAPIToken(path, token string) bool {
	record := ReadAPIToken(path)
	if record == nil || token == "" {
		return false
	}
	got, err := hex.DecodeString(HashToken(token))
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(record.Hash)
	if err != nil || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ── Resolving a request ─────────────────────────────────────────────────────

// Authenticator answers "who is this?" for a request.
type Authenticator struct {
	Mode         AuthMode
	Signer       *SessionSigner
	APITokenFile string
	Now          func() time.Time
}

// CheckAuth resolves the caller, or nil for an unauthenticated one.
//
// Open mode returns a synthetic admin, matching the Node server: there is no
// identity to establish, and every route behaves as though the owner is calling.
func (a *Authenticator) CheckAuth(r *http.Request) *Identity {
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}

	switch a.Mode {
	case ModeOpen:
		return &Identity{Role: "admin"}

	case ModeSession:
		// A bearer token IS the single identity — there is only one to be. Note
		// that presenting a BAD one is refused outright rather than falling
		// through to the cookie: a client that sent a token meant to be
		// authenticated by it, and silently treating it as anonymous hides a
		// revoked or mistyped token behind a working browser session.
		if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			if VerifyAPIToken(a.APITokenFile, strings.TrimPrefix(header, "Bearer ")) {
				return &Identity{UserID: SingleUserID, Username: "owner", Role: "admin"}
			}
			return nil
		}
		raw := ParseCookies(r.Header.Get("Cookie"))[SessionCookie]
		if raw != "" && a.Signer.Verify(raw, now()) {
			return &Identity{UserID: SingleUserID, Username: "owner", Role: "admin"}
		}
		return nil
	}

	// Multi mode is not ported; refusing is the only honest answer.
	return nil
}

// RoleAtLeast reports whether a role meets a minimum.
func RoleAtLeast(role, minimum string) bool {
	return roleLevels[role] >= roleLevels[minimum]
}

// urlQueryEscape and urlQueryUnescape are encodeURIComponent/decodeURIComponent,
// which are NOT url.QueryEscape/QueryUnescape.
//
// The difference is a space: encodeURIComponent writes %20, QueryEscape writes
// `+`. A session value containing a space would round-trip through Go as a plus
// sign and stop matching its signature — and session values are base-ish hex
// today, so nothing would fail until the day one is not.
func urlQueryEscape(s string) string {
	const safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if strings.IndexByte(safe, s[i]) >= 0 {
			out.WriteByte(s[i])
			continue
		}
		out.WriteString("%")
		out.WriteString(strings.ToUpper(hex.EncodeToString([]byte{s[i]})))
	}
	return out.String()
}

func urlQueryUnescape(s string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			out.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) {
			return "", errBadEscape
		}
		decoded, err := hex.DecodeString(s[i+1 : i+3])
		if err != nil {
			return "", errBadEscape
		}
		out.Write(decoded)
		i += 2
	}
	return out.String(), nil
}

var errBadEscape = errors.New("malformed percent-encoding")
