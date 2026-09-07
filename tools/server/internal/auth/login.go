package auth

// The sign-in surface: the login page, the login and logout handlers, the
// password re-check, and the rate limiter in front of them.
//
// The page itself is app/partials/login.html, read at runtime rather than
// compiled in — the same file lib/auth.js reads. A login screen maintained as
// two copies is a login screen that will disagree with itself, and this one is
// the single page a visitor sees before they have any reason to trust the site.

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	loginWindow      = 15 * time.Minute
	loginMaxAttempts = 10
)

var modeLabels = map[AuthMode]string{
	ModeOpen:    "open (no auth)",
	ModeSession: "server session",
	ModeMulti:   "multi-user JWT + RBAC",
}

// LoginRateLimiter allows ten attempts per IP per fifteen minutes, cleared on a
// successful sign-in.
//
// In memory and per process, exactly as the Node one is. That is a real
// limitation — two backend pods mean twice the attempts — but it is the
// limitation that exists today, and changing it during a port would mean the
// two implementations no longer answer the same question.
type LoginRateLimiter struct {
	mu       sync.Mutex
	attempts map[string]*loginAttempt
	Now      func() time.Time
}

type loginAttempt struct {
	count   int
	resetAt time.Time
}

func NewLoginRateLimiter() *LoginRateLimiter {
	return &LoginRateLimiter{attempts: map[string]*loginAttempt{}}
}

func (l *LoginRateLimiter) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

// Exceeded records an attempt and reports whether the caller is over the limit.
func (l *LoginRateLimiter) Exceeded(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	entry, seen := l.attempts[ip]
	if !seen || now.After(entry.resetAt) {
		entry = &loginAttempt{resetAt: now.Add(loginWindow)}
	}
	entry.count++
	l.attempts[ip] = entry
	return entry.count > loginMaxAttempts
}

// Clear forgets an IP's attempts, called on a successful sign-in.
func (l *LoginRateLimiter) Clear(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}

// LoginService is everything the sign-in routes need.
type LoginService struct {
	Mode         AuthMode
	Signer       *SessionSigner
	PasswordHash string
	AppRoot      string // where app/partials/login.html lives
	Production   bool
	Limiter      *LoginRateLimiter
	Now          func() time.Time

	templateOnce sync.Once
	template     string
	templateErr  error
}

func (s *LoginService) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// RenderLogin fills the shared template.
func (s *LoginService) RenderLogin(errorMessage string, multiUser bool) string {
	s.templateOnce.Do(func() {
		raw, err := os.ReadFile(filepath.Join(s.AppRoot, "partials", "login.html"))
		s.template, s.templateErr = string(raw), err
	})
	if s.templateErr != nil {
		// The page cannot be rendered, but the reason must not be a blank screen
		// with a 200 on it.
		return "<!DOCTYPE html><title>Sign in</title><p>The sign-in page is unavailable.</p>"
	}

	usernameField := ""
	autofocus := " autofocus"
	if multiUser {
		usernameField = "\n      <div class=\"lf-field\">\n" +
			"        <label class=\"lf-label\" for=\"uname\">Username</label>\n" +
			"        <input id=\"uname\" class=\"lf-input\" type=\"text\" name=\"username\"\n" +
			"          autocomplete=\"username\" autofocus required>\n" +
			"      </div>"
		autofocus = ""
	}
	errorBlock := ""
	if errorMessage != "" {
		errorBlock = `<p class="lf-error"><i class="fas fa-circle-exclamation"></i>` +
			errorMessage + `</p>`
	}

	page := strings.Replace(s.template, "<!--USERNAME_FIELD-->", usernameField, 1)
	page = strings.Replace(page, "<!--ERROR-->", errorBlock, 1)
	page = strings.Replace(page, "<!--PWD_AUTOFOCUS-->", autofocus, 1)
	return strings.Replace(page, "<!--MODE-->", modeLabels[s.Mode], 1)
}

func (s *LoginService) sendHTML(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// ServeLoginPage handles GET /login.
func (s *LoginService) ServeLoginPage(w http.ResponseWriter, r *http.Request) {
	if s.Mode == ModeOpen {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	s.sendHTML(w, http.StatusOK, s.RenderLogin("", s.Mode == ModeMulti))
}

// HandleLogin handles POST /login.
func (s *LoginService) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if s.Mode == ModeOpen {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if err := r.ParseForm(); err != nil {
		s.sendHTML(w, http.StatusBadRequest, s.RenderLogin("Bad request.", false))
		return
	}

	if s.Limiter.Exceeded(clientIP(r)) {
		s.sendHTML(w, http.StatusTooManyRequests,
			s.RenderLogin("Too many attempts. Try again in 15 minutes.", false))
		return
	}

	if s.Mode != ModeSession {
		// Multi mode is not ported; refusing beats guessing at an identity.
		s.sendHTML(w, http.StatusUnauthorized, s.RenderLogin("Sign-in is unavailable.", true))
		return
	}

	password := r.PostFormValue("password")
	if s.PasswordHash == "" || !VerifyPassword(s.PasswordHash, password) {
		s.sendHTML(w, http.StatusUnauthorized, s.RenderLogin("Incorrect password.", false))
		return
	}

	s.Limiter.Clear(clientIP(r))
	s.Signer.SetCookie(w, s.Signer.Issue(s.now().Add(SessionDuration)), s.Production)
	http.Redirect(w, r, safeNext(r), http.StatusFound)
}

// HandleVerifyPassword re-checks the password without disturbing the session —
// the client-side planner lock uses it.
func (s *LoginService) HandleVerifyPassword(w http.ResponseWriter, r *http.Request) {
	writeJSON := func(status int, body map[string]any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}

	if s.Mode == ModeOpen {
		writeJSON(http.StatusOK, map[string]any{"ok": true, "mode": "open"})
		return
	}
	if s.Limiter.Exceeded(clientIP(r)) {
		writeJSON(http.StatusTooManyRequests,
			map[string]any{"ok": false, "error": "Too many attempts. Try again later."})
		return
	}

	password := ""
	if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		var body struct {
			Password string `json:"password"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		password = body.Password
	} else if err := r.ParseForm(); err == nil {
		password = r.PostFormValue("password")
	}

	if s.Mode != ModeSession || s.PasswordHash == "" || !VerifyPassword(s.PasswordHash, password) {
		writeJSON(http.StatusUnauthorized, map[string]any{"ok": false})
		return
	}
	s.Limiter.Clear(clientIP(r))
	writeJSON(http.StatusOK, map[string]any{"ok": true, "mode": "session"})
}

// HandleLogout clears the cookie and returns to the front page.
func (s *LoginService) HandleLogout(w http.ResponseWriter, r *http.Request) {
	ClearCookie(w)
	http.Redirect(w, r, "/", http.StatusFound)
}

// safeNext resolves where to send someone after signing in.
//
// The check is the original's, and it is the one that matters: a destination
// must start with a single slash. `//evil.example` is a protocol-relative URL —
// it looks like a path and navigates to another origin — which is how a login
// form becomes an open redirect.
func safeNext(r *http.Request) string {
	next := r.URL.Query().Get("next")
	if next == "" {
		next = r.PostFormValue("next")
	}
	if strings.HasPrefix(next, "/") && !strings.HasPrefix(next, "//") {
		return next
	}
	return "/planner"
}

// clientIP is Express's req.ip: the socket address, since `trust proxy` is not
// enabled on the Node side either. Behind an ingress that means the rate limit
// is per ingress rather than per visitor — true of the Node server today, and
// not something to change silently during a port.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
