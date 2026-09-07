package planner

// A Go port of buildEventScheduleIcs() from lib/tripFeed.js — the public
// calendar feed of an entire event's programme, for the schedule page's
// "subscribe to all sessions".
//
// No token: it is the same public data the schedule already shows. The event
// parameter is whitelisted against the catalog, which is what stops it being a
// way to read arbitrary files.

import (
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/js"
	"server/internal/paths"
	"strings"
	"time"
	"unicode/utf16"
)

// MakeSessionID derives the id the client derives, from the same three fields.
//
// The interpolation of an ABSENT field matters: JavaScript renders undefined as
// the string "undefined", so a session with no location has that word in the
// middle of its id. Reproduced exactly, because these ids are the UIDs already
// sitting in subscribers' calendars — a "tidier" id would silently duplicate
// every session on every device.
func MakeSessionID(session *js.Value) string {
	part := func(key string) string {
		value := session.Get(key)
		if !value.Exists() {
			return "undefined"
		}
		return js.String(value)
	}
	return replacePerUTF16Unit(part("startTime") + "-" + part("location") + "-" + part("title"))
}

// replacePerUTF16Unit is `.replace(/[^a-zA-Z0-9-]/g, '-')` applied the way
// JavaScript applies it: per UTF-16 CODE UNIT, not per rune.
//
// A surrogate pair is two units, so an emoji becomes TWO dashes. Go's regexp
// works on runes and produced one — a single character of difference in the UID
// of one session out of 8,884, which is exactly the kind of thing that silently
// duplicates an entry in somebody's calendar rather than updating it. Found by
// the byte comparison; it would never have been found by reading.
func replacePerUTF16Unit(s string) string {
	units := utf16.Encode([]rune(s))
	out := make([]uint16, len(units))
	for i, unit := range units {
		switch {
		case unit >= 'a' && unit <= 'z',
			unit >= 'A' && unit <= 'Z',
			unit >= '0' && unit <= '9',
			unit == '-':
			out[i] = unit
		default:
			out[i] = '-'
		}
	}
	return string(utf16.Decode(out))
}

// ScheduleFeed is a rendered feed and the dataset it came from.
type ScheduleFeed struct {
	ICS  string
	Path string
}

// BuildEventScheduleIcs renders one event's whole programme, or nil when the
// parameter names nothing in the catalog.
func BuildEventScheduleIcs(eventParam, dataDir, dtStamp string) *ScheduleFeed {
	if eventParam == "" {
		return nil
	}
	catalogRaw, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return nil
	}
	catalog, err := js.ParseJSON(catalogRaw)
	if err != nil {
		return nil
	}

	// The whitelist: the request must name a known catalog dataset, nested or
	// flattened. Anything else is not a 404 for politeness — it is the only
	// thing standing between this route and the file system.
	flatten := func(file string) string {
		return strings.ReplaceAll(strings.TrimPrefix(file, "events/"), "/", "-")
	}
	match := ""
	for _, entry := range catalog.Get("events").Items() {
		file := entry.Get("file").Str()
		if file == "" {
			continue
		}
		if file == eventParam || flatten(file) == eventParam {
			match = file
			break
		}
	}
	if match == "" {
		return nil
	}

	path := paths.SafeJoin(dataDir, match)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	data, err := js.ParseJSON(raw)
	if err != nil {
		return nil
	}

	meta := data.Get("event")
	if meta == nil {
		meta = js.Obj()
	}
	timezone := meta.Get("timezone").Str()

	geocache := js.Obj()
	if cached, err := os.ReadFile(filepath.Join(dataDir, "geocache.json")); err == nil {
		if parsed, err := js.ParseJSON(cached); err == nil {
			geocache = parsed
		}
	}

	place := archive.JoinNonEmpty(", ", jsTrimIfSet(meta.Get("venue")), jsTrimIfSet(meta.Get("location")))

	// The dataset's own coordinates, else the geocode cache — so a session gets
	// a real map pin rather than a blank.
	var coords *Geo
	if lat, okLat := meta.Get("latitude").Number(); okLat {
		if lon, okLon := meta.Get("longitude").Number(); okLon {
			coords = &Geo{Lat: lat, Lon: lon}
		}
	}
	if coords == nil {
		cached := geocache.Get(js.Trim(meta.Get("location").StrVal()))
		if lat, ok := cached.Get("lat").Number(); ok {
			lon, _ := cached.Get("lon").Number()
			coords = &Geo{Lat: lat, Lon: lon}
		}
	}

	// Tag items with the same session id the client derives, then map through
	// the shared builder so the feed and the schedule-page download produce
	// identical VEVENTs.
	var items []*js.Value
	for _, item := range data.Get("items").Items() {
		tagged := js.Obj()
		for _, key := range item.Keys() {
			tagged.Set(key, item.Get(key))
		}
		tagged.Set("id", js.Str(MakeSessionID(item)))
		items = append(items, tagged)
	}

	events := ScheduleSessionsToCalEvents(items, timezone, place, coords, match)
	calName := archive.JoinNonEmpty(" ",
		meta.Get("designation").Str(), meta.Get("location").Str(), archive.YearText(meta.Get("year")))
	if calName == "" {
		calName = "Schedule"
	}

	// 12h refresh — a published programme changes far less often than a live trip.
	return &ScheduleFeed{
		ICS:  BuildIcsCalendar(events, calName, dtStamp, 0, 720),
		Path: path,
	}
}

// jsTrimIfSet is the `x && String(x).trim()` filter the original applies before
// joining the venue and the city.
func jsTrimIfSet(v *js.Value) string {
	if v == nil || !v.Text() {
		return ""
	}
	return js.Trim(js.String(v))
}

// DefaultDTStamp is the stamp used when a caller supplies none.
func DefaultDTStamp() string { return NowStamp(time.Now()) }
