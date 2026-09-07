package web

// The page routing table.
//
// Split from pages.go so the ADDRESSES are readable in one screen: which
// sections exist, which are gated, and which old addresses still resolve. The
// mechanics of serving a page live next door.

import (
	"net/http"
	"net/url"
	"server/internal/auth"
	"strings"
)

// servePageRoute answers if the path names a page, and reports whether it did.
func servePageRoute(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	pages := config.Pages
	path := r.URL.Path

	// Public HTML routes. `/` is HOME — a real page, not an alias for the
	// schedule. That was the last inconsistency in the nav: "Home" and "Schedule"
	// pointed at the same document, so one of the five items said nothing.
	switch path {
	case "/":
		pages.SendPage(w, r, "home.html", true)
		return true
	case "/home.html":
		canonicalRedirect(w, r, "/")
		return true

	// The schedule section is path-addressed, like the planner and the archive.
	// Served deep even though it is one segment: the client pushState()s to
	// /schedules/<slug> when you pick a schedule, and without a base every
	// relative fetch after that would resolve against the NEW path.
	case "/schedules":
		pages.SendPage(w, r, "index.html", true)
		return true

	// The old singular address, and the file form, both land on the section.
	case "/schedule", "/index.html":
		canonicalRedirect(w, r, "/schedules")
		return true

	// "Observatory" is superseded by "Archive". Old links keep working — a
	// rename should never be a 404 for anyone who bookmarked the section.
	case "/observatory", "/observatory.html":
		expressRedirect(w, r, http.StatusMovedPermanently, "/archive")
		return true

	case "/planner.html":
		canonicalRedirect(w, r, "/planner")
		return true
	case "/archive.html":
		canonicalRedirect(w, r, "/archive")
		return true
	case "/curation.html":
		canonicalRedirect(w, r, "/curation")
		return true
	case "/editor.html":
		canonicalRedirect(w, r, "/editor")
		return true

	// Gated sections. The archive is a first-class section, not an editor
	// overlay; it is gated for now because its data source requires the editor
	// role, and opening it to the public means relaxing that endpoint too.
	case "/planner":
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "planner.html", false)
		}
		return true
	case "/archive":
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "archive.html", true)
		}
		return true
	case "/curation":
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "curation.html", false)
		}
		return true
	case "/editor":
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "editor.html", false)
		}
		return true
	}

	// /observatory/<kind>/<slug> keeps its shape across the rename.
	if rest, found := strings.CutPrefix(path, "/observatory/"); found {
		if segments := strings.Split(rest, "/"); len(segments) == 2 &&
			segments[0] != "" && segments[1] != "" {
			expressRedirect(w, r, http.StatusMovedPermanently, "/archive/"+rest)
			return true
		}
	}

	// The planner is path-addressed the same way:
	//   /planner/<slug>         that planner, on its default tab
	//   /planner/<slug>/<tab>   that planner, on that tab
	// The client resolves the slug against its own stored planners, so there is
	// no server-side registry — and no reason to 404 on a slug this server has
	// never heard of, since a planner can live only in the browser.
	if rest, found := strings.CutPrefix(path, "/planner/"); found {
		segments := strings.Split(rest, "/")
		// REGISTERED BEFORE the tab route in the original, and that ordering is
		// load-bearing: `calendar.ics` matches `:tab`, so the other way round a
		// calendar client would follow a 302 to /login, receive HTML, and quietly
		// show an empty calendar with no error anyone would ever see.
		if len(segments) == 2 && segments[1] == "calendar.ics" {
			return false // the feed route owns this; not a page
		}
		if len(segments) >= 1 && len(segments) <= 2 && segments[0] != "" {
			if requireAuth(w, r, config) {
				pages.SendPage(w, r, "planner.html", false)
			}
			return true
		}
	}

	// /schedules/<slug>, and its subscription feed, which the feed route owns.
	if rest, found := strings.CutPrefix(path, "/schedules/"); found {
		segments := strings.Split(rest, "/")
		if len(segments) == 2 &&
			(segments[1] == "calendar.ics" || segments[1] == "subscribe") {
			return false
		}
		if len(segments) == 1 && segments[0] != "" {
			pages.SendPage(w, r, "index.html", true)
			return true
		}
	}

	// Every drill-down is addressable, and serves the same page at every depth.
	if deepArchivePath(path) {
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "archive.html", false)
		}
		return true
	}
	if deepEditorPath(path) {
		if requireAuth(w, r, config) {
			pages.SendPage(w, r, "editor.html", false)
		}
		return true
	}
	return false
}

// requireAuth is the PAGE gate: it redirects a browser to the login form rather
// than answering with JSON, which is the difference between this and
// requireRole. Reports whether the request may proceed.
func requireAuth(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	if config.Mode == auth.ModeOpen || config.Authenticator == nil {
		return true
	}
	if user := config.Authenticator.CheckAuth(r); user != nil {
		return true
	}
	next := r.URL.RequestURI()
	if next == "" {
		next = "/planner"
	}
	expressRedirect(w, r, http.StatusFound, "/login?next="+url.QueryEscape(next))
	return false
}
