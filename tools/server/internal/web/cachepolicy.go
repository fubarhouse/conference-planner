package web

// A Go port of lib/cachePolicy.js — what may be cached, by whom, and for how
// long.
//
// One place decides this, rather than each route and each CDN behaviour having
// an opinion. The rule is DEFAULT DENY: anything unrecognised gets
// `private, no-store`. A caching mistake on a private path leaks one person's
// data to the next visitor, so an unclassified path must fail closed — the cost
// of getting it wrong the other way is only a slow response.
//
// The full reasoning for each value lives in the JavaScript and is not repeated
// here; what matters for the port is that the rules, their ORDER, and the
// default are identical. Order is load-bearing twice over: NEVER is checked
// first so a mistake in the public rules cannot expose a private path, and the
// public rules are first-match.

import "regexp"

const (
	// Immutable in practice: content that is added, not edited, at a given URL.
	policyLong = "public, max-age=86400, stale-while-revalidate=604800"
	// Changes on a dataset write; readers should see it within a minute.
	policyData = "public, max-age=60, stale-while-revalidate=300"
	// Expensive, identical for everyone, served on an UNVERSIONED url — so it
	// must be revalidated rather than held for a window a CDN cannot be told to
	// forget.
	policyComputed = "public, no-cache"
	// The same content at a content-addressed url (`?v=<token>`): a new token is
	// a new URL, so caching hard harms nobody.
	policyVersioned = "public, max-age=31536000, immutable"
	// Code and HTML: cached, but briefly and without serving stale. Assets
	// cannot be fingerprinted here (no bundler), so 60s bounds the window in
	// which a visitor can hold a mixture of old and new modules.
	policyRevalidate = "public, max-age=60, must-revalidate"
	// Never store, never share.
	policyPrivate = "private, no-store"
)

// Policies exposes the values by name, matching the POLICIES export.
var Policies = map[string]string{
	"LONG": policyLong, "DATA": policyData, "COMPUTED": policyComputed,
	"VERSIONED": policyVersioned, "REVALIDATE": policyRevalidate, "PRIVATE": policyPrivate,
}

// Never cacheable, however public the path looks. Checked FIRST.
var neverCache = []*regexp.Regexp{
	regexp.MustCompile(`^/planner/`), // includes /planner/<slug>/calendar.ics
	regexp.MustCompile(`^/api/auth/`),
	regexp.MustCompile(`^/api/health$`),
	regexp.MustCompile(`^/login$`),
	regexp.MustCompile(`^/logout$`),
	regexp.MustCompile(`^/receipts/`),
	regexp.MustCompile(`^/documents/`),
}

// Public but expensive — the archive's aggregates.
var computedRules = []*regexp.Regexp{
	regexp.MustCompile(`^/api/archive/(insights|sessions|topic)$`),
}

// Paths whose responses are the same for every caller. First match wins.
var publicRules = []struct {
	pattern *regexp.Regexp
	policy  string
}{
	{regexp.MustCompile(`^/(js|css)/`), policyRevalidate},
	{regexp.MustCompile(`^/(fonts|img)/`), policyLong},
	{regexp.MustCompile(`^/(favicon\.\w+|manifest\.webmanifest|robots\.txt)$`), policyLong},
	{regexp.MustCompile(`^/data/`), policyData},
	{regexp.MustCompile(`^/api/meta$`), policyData},
	{regexp.MustCompile(`^/api/data/`), policyData},
	{regexp.MustCompile(`^/schedules/[^/]+/(calendar\.ics|subscribe)$`), policyData},
	{regexp.MustCompile(`^/schedule\.ics$`), policyData},
	{regexp.MustCompile(`^/(schedules|home\.html|index\.html)?$`), policyRevalidate},
	{regexp.MustCompile(`^/schedules/[^/]+$`), policyRevalidate},
}

// CacheControlFor returns a Cache-Control value for a path — never empty, so a
// caller cannot forget to set one.
//
// `versioned` says the request carried a content token (`?v=`). It upgrades
// ONLY the computed paths: a token means something on a path that publishes
// one and nothing anywhere else, so a stray `?v=` cannot buy a year of caching
// for an unrelated response.
func CacheControlFor(pathname string, versioned bool) string {
	for _, pattern := range neverCache {
		if pattern.MatchString(pathname) {
			return policyPrivate
		}
	}
	for _, pattern := range computedRules {
		if pattern.MatchString(pathname) {
			if versioned {
				return policyVersioned
			}
			return policyComputed
		}
	}
	for _, rule := range publicRules {
		if rule.pattern.MatchString(pathname) {
			return rule.policy
		}
	}
	return policyPrivate
}
