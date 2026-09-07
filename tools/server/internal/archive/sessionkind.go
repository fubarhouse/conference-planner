package archive

// A Go port of app/js/modules/sessionKind.js — is this item a session, or is it
// lunch?
//
// The archive measures a community's PROGRAMME. Coffee breaks, registration and
// the closing drinks belong in the schedule view, but counting them as sessions
// inflates every total and drags the topic vocabulary toward "lunch".
//
// Second implementation, same arrangement as SummarizeSources: the rule is
// pinned by testdata/session-kind-cases.json, which this suite and
// app/js/modules/__tests__/sessionKindContract.test.js both read. The word lists
// are the rule here, so the fixture carries the titles that discriminate rather
// than trying to re-list the vocabulary.

import (
	"regexp"
	"server/internal/js"
	"strings"
)

// Agenda/logistics words. A title is dropped only when EVERY word is a
// logistics or modifier word and at least one is a real logistics word, so a
// single content word rescues it: "Registration" is dropped, "Rethinking Event
// Registration" is kept.
var agendaWords = words(
	"lunch", "breakfast", "dinner", "brunch", "supper", "tea", "coffee", "drinks",
	"refreshments", "snacks", "registration", "checkin", "signin", "welcome",
	"opening", "closing", "remarks", "networking", "social", "party", "afterparty",
	"reception", "photo", "photos", "announcements", "housekeeping", "arrivals",
	"arrival", "doors", "break", "breaks", "pause", "wrapup", "mingling", "icebreaker",
)

var agendaMod = words(
	"morning", "afternoon", "evening", "short", "quick", "group", "mid", "light", "optional",
)

var agendaFiller = words(
	"time", "session", "sessions", "and", "with", "the", "a", "an", "to", "amp",
	"your", "our", "min", "mins", "minute", "minutes", "hr", "hrs", "hour", "hours",
	"am", "pm", "room", "hall",
)

func words(list ...string) map[string]bool {
	out := make(map[string]bool, len(list))
	for _, word := range list {
		out[word] = true
	}
	return out
}

var (
	dropChars    = regexp.MustCompile(`['’.]`)
	punctToSpace = regexp.MustCompile(`[()\[\]{}:;!?"“”]`)
	tokenSplit   = regexp.MustCompile(`[\s&/+,–—]+`)
	digitsOnly   = regexp.MustCompile(`^\d+$`)
)

// IsAgendaTitle reports whether a title is pure agenda/logistics.
func IsAgendaTitle(title string) bool {
	text := strings.ToLower(title)
	text = dropChars.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "-", "")
	text = punctToSpace.ReplaceAllString(text, " ")

	var tokens []string
	for _, word := range tokenSplit.Split(text, -1) {
		if word == "" || digitsOnly.MatchString(word) || agendaFiller[word] {
			continue
		}
		tokens = append(tokens, word)
	}
	if len(tokens) == 0 {
		return false
	}

	sawLogistics := false
	for _, word := range tokens {
		if !agendaWords[word] && !agendaMod[word] {
			return false
		}
		if agendaWords[word] {
			sawLogistics = true
		}
	}
	return sawLogistics
}

// ItemKind answers "what is it" — not "what is it about", which is `track`.
//
// `kind` is the authority when present; `isAgendaItem` is the older spelling of
// `kind: "agenda"` and is still honoured, because most of the archive predates
// the field. Title heuristics are the last resort.
func ItemKind(item *js.Value) string {
	switch raw := strings.ToLower(item.Get("kind").Str()); raw {
	case "session", "workshop", "social", "agenda":
		return raw
	}
	// Only an actual boolean counts, in both directions — a string "true" is not
	// the field, it is a bug in whatever wrote it.
	if flag, ok := item.Get("isAgendaItem").Bool(); ok {
		if flag {
			return "agenda"
		}
		return "session"
	}
	if IsAgendaTitle(item.Get("title").Str()) {
		return "agenda"
	}
	return "session"
}

// IsCancelled reports whether an item was called off. Cancelled items are kept
// as evidence but never counted.
func IsCancelled(item *js.Value) bool {
	flag, ok := item.Get("cancelled").Bool()
	return ok && flag
}

// CountsAsSession reports whether an item is programme content.
func CountsAsSession(item *js.Value) bool {
	if IsCancelled(item) {
		return false
	}
	kind := ItemKind(item)
	return kind == "session" || kind == "workshop"
}
