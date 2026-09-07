package planner

// A Go port of the trip half of lib/tripFeed.js and the planner entity mappers
// in app/js/modules/plannerCalendar.js — the whole-trip .ics.
//
// This is a person's travel: flights, hotels, the sessions they are going to.
// It is served on a token-gated URL, which means the feed itself is a
// credential, and booking references are redacted from it for that reason — a
// leaked link exposes the schedule, never the PNR.

import (
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/js"
	"server/internal/paths"
	"strings"
)

// travelModeLabels are the labels legs are titled with. The leading emoji is
// stripped by LegToCalEvent, but it has to be here to be stripped — the label
// is the string the client shows, and the .ics title is derived from it.
var travelModeLabels = map[string]string{
	"flight":    "✈ Flight",
	"train":     "🚂 Train",
	"bus":       "🚌 Bus",
	"ferry":     "⛴ Ferry",
	"car":       "🚗 Transfer",
	"taxi":      "🚕 Taxi",
	"rideshare": "📱 Rideshare",
	"other":     "↔ Other",
}

// ItineraryItemToCalEvent maps an itinerary item or a hosted event — they share
// one shape: title, date, optional time, optional location. No time means
// all-day.
func ItineraryItemToCalEvent(item *js.Value, timezone string) *CalEvent {
	date := item.Get("date")
	if !js.Truthy(date) {
		return nil
	}
	title := js.Trim(paths.FirstNonEmpty(
		js.String(item.Get("title")), js.String(item.Get("name")), "Itinerary item"))
	clock := js.Trim(js.String(item.Get("time")))
	endClock := js.Trim(js.String(item.Get("endTime")))

	event := &CalEvent{
		Title:    title,
		Start:    WallTime{Date: js.String(date), Time: clock},
		AllDay:   clock == "",
		Location: js.Trim(js.String(item.Get("location"))),
		// The item's notes land in the .ics DESCRIPTION.
		Description: js.Trim(paths.FirstNonEmpty(
			js.String(item.Get("notes")), js.String(item.Get("description")))),
		Timezone: js.Trim(paths.FirstNonEmpty(js.String(item.Get("timezone")), timezone)),
	}
	// An explicit finishing time gives the event a real end; without one the
	// VEVENT builder falls back to a default duration.
	if clock != "" && endClock != "" {
		event.End = &WallTime{Date: js.String(date), Time: endClock}
	}
	return event
}

// LegToCalEvent maps a travel leg. Start is departure, end is arrival, falling
// back to the departure date when no arrival date is set.
//
// includeRefs controls whether booking references reach the event body: on for
// a deliberate local download, OFF for the public subscription feed.
func LegToCalEvent(leg *js.Value, direction string, includeRefs bool) *CalEvent {
	if !js.Truthy(leg.Get("date")) {
		return nil
	}

	mode := js.String(leg.Get("mode"))
	label, known := travelModeLabels[mode]
	if !known {
		label = paths.FirstNonEmpty(mode, "Travel")
	}
	// Strip the leading emoji and its space: "✈ Flight" becomes "Flight".
	label = js.Trim(stripLeadingToken(label))

	route := archive.JoinNonEmpty(" → ", js.String(leg.Get("from")), js.String(leg.Get("to")))
	title := label
	if route != "" {
		title = label + ": " + route
	}

	departTime := js.Trim(js.String(leg.Get("departTime")))
	arriveTime := js.Trim(js.String(leg.Get("arriveTime")))

	var descriptionParts []string
	if includeRefs && js.Truthy(leg.Get("ref")) {
		descriptionParts = append(descriptionParts, "Ref: "+js.String(leg.Get("ref")))
	}
	if includeRefs && js.Truthy(leg.Get("confirmation")) {
		descriptionParts = append(descriptionParts,
			"Confirmation: "+js.String(leg.Get("confirmation")))
	}
	if direction != "" {
		descriptionParts = append(descriptionParts, "Direction: "+direction)
	}

	event := &CalEvent{
		Title:       title,
		Start:       WallTime{Date: js.String(leg.Get("date")), Time: departTime},
		AllDay:      departTime == "",
		Location:    js.Trim(js.String(leg.Get("from"))),
		Description: strings.Join(descriptionParts, "\n"),
	}
	if departTime != "" {
		event.End = &WallTime{
			Date: paths.FirstNonEmpty(js.String(leg.Get("arriveDate")), js.String(leg.Get("date"))),
			Time: paths.FirstNonEmpty(arriveTime, departTime),
		}
	}
	return event
}

// stripLeadingToken is `.replace(/^\S+\s/, ”)` — the first run of non-space
// characters and the space after it, and only when both are there.
func stripLeadingToken(s string) string {
	for i, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\f' || r == '\v' {
			if i == 0 {
				return s // starts with a space: \S+ cannot match
			}
			return s[i+len(string(r)):]
		}
	}
	return s
}

// AccommodationToCalEvent maps a stay to a single multi-day all-day event
// spanning check-in to check-out.
func AccommodationToCalEvent(stay *js.Value) *CalEvent {
	checkIn := js.Trim(js.String(stay.Get("checkIn")))
	if checkIn == "" {
		return nil
	}
	checkOut := paths.FirstNonEmpty(js.Trim(js.String(stay.Get("checkOut"))), checkIn)
	name := js.Trim(paths.FirstNonEmpty(js.String(stay.Get("name")), "Accommodation"))
	return &CalEvent{
		Title:    "Stay: " + name,
		Start:    WallTime{Date: checkIn},
		End:      &WallTime{Date: checkOut},
		AllDay:   true,
		Location: js.Trim(js.String(stay.Get("location"))),
	}
}

// TripInclude toggles each category of the trip. All on by default.
type TripInclude struct{ Travel, Stays, Items, Hosted, Sessions bool }

// AllTripCategories is the default: everything.
func AllTripCategories() TripInclude {
	return TripInclude{Travel: true, Stays: true, Items: true, Hosted: true, Sessions: true}
}

// BuildTripCalEvents aggregates a personal trip into calendar entries — travel
// legs, stays, itinerary items, hosted events and tracked sessions.
//
// Each entry carries a stable UID (`<entity>@<planner-uuid>`) so a re-import or
// a subscription refresh UPDATES rather than duplicates.
func BuildTripCalEvents(planner *js.Value, allSessions map[string]*js.Value, timezone string,
	include TripInclude, redactRefs bool) []*CalEvent {

	personal := planner.Get("personal")
	if personal == nil {
		personal = js.Obj()
	}
	namespace := paths.FirstNonEmpty(planner.Get("_id").Str(), "planner")

	var out []*CalEvent
	add := func(event *CalEvent, uidBase string) {
		if event != nil {
			event.UID = uidBase + "@" + namespace
			out = append(out, event)
		}
	}
	// An id that is absent interpolates as the string "undefined", and two
	// entities without ids therefore share a UID. That is the existing
	// behaviour and it is already in people's calendars.
	idOf := func(entity *js.Value) string {
		if id := entity.Get("id"); id.Exists() {
			return js.String(id)
		}
		return "undefined"
	}

	if include.Travel {
		for _, leg := range personal.Get("outboundLegs").Items() {
			add(LegToCalEvent(leg, "Outbound", !redactRefs), "leg-"+idOf(leg))
		}
		for _, leg := range personal.Get("returnLegs").Items() {
			add(LegToCalEvent(leg, "Return", !redactRefs), "leg-"+idOf(leg))
		}
		if js.Truthy(personal.Get("showLocalTravel")) {
			for _, leg := range personal.Get("localLegs").Items() {
				add(LegToCalEvent(leg, "Local", !redactRefs), "leg-"+idOf(leg))
			}
		}
	}
	if include.Stays {
		for _, stay := range personal.Get("accommodations").Items() {
			add(AccommodationToCalEvent(stay), "accom-"+idOf(stay))
		}
	}
	if include.Items {
		for _, item := range personal.Get("itinerary").Items() {
			add(ItineraryItemToCalEvent(item, timezone), "item-"+idOf(item))
		}
	}
	if include.Hosted {
		for _, hosted := range personal.Get("hostedEvents").Items() {
			// A hosted event's `description` is carried in as `notes`, which is
			// the field the itinerary mapper reads first.
			merged := js.Obj()
			for _, key := range hosted.Keys() {
				merged.Set(key, hosted.Get(key))
			}
			merged.Set("notes", hosted.Get("description"))
			add(ItineraryItemToCalEvent(merged, timezone), "hosted-"+idOf(hosted))
		}
	}
	if include.Sessions {
		for _, tracked := range personal.Get("trackedSessions").Items() {
			sessionID := tracked.Get("sessionId").Str()
			if session, found := allSessions[sessionID]; found {
				add(SessionToCalEvent(session, timezone), "session-"+sessionID)
			}
		}
	}
	return out
}

// BuildPlannerFeedIcs renders a whole trip.
//
// redactRefs is not a parameter: this feed is always the public one, and a
// booking reference has no business in a URL somebody can forward.
func BuildPlannerFeedIcs(planner *js.Value, dataDir, dtStamp string) string {
	var eventFiles []string
	for _, file := range planner.Get("_eventFiles").Items() {
		if name := file.Str(); name != "" {
			eventFiles = append(eventFiles, name)
		}
	}
	if len(eventFiles) == 0 {
		if single := planner.Get("_eventFile").Str(); single != "" {
			eventFiles = []string{single}
		}
	}

	sessions, timezone := loadEventSessions(eventFiles, dataDir)
	events := BuildTripCalEvents(planner, sessions, timezone, AllTripCategories(), true)

	calName := js.Trim(planner.Get("_displayName").Str())
	if calName == "" {
		calName = "My trip"
	}
	// 6h refresh — a change lands in the attendee's calendar within hours; the
	// in-app Now/Next covers the live minute-by-minute layer.
	return BuildIcsCalendar(events, calName, dtStamp, 0, 360)
}

// loadEventSessions loads every associated event's sessions, keyed by the id the
// client derives, plus the first timezone found.
func loadEventSessions(eventFiles []string, dataDir string) (map[string]*js.Value, string) {
	sessions := map[string]*js.Value{}
	timezone := ""
	for _, file := range eventFiles {
		path := resolveDatasetPath(file, dataDir)
		if path == "" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			// Skip a corrupt dataset, keep the rest.
			continue
		}
		if timezone == "" {
			timezone = data.Get("event").Get("timezone").Str()
		}
		for _, item := range data.Get("items").Items() {
			id := MakeSessionID(item)
			if _, seen := sessions[id]; !seen {
				// `Array.find` returns the FIRST match, so a duplicate id must
				// not displace the session already holding it.
				sessions[id] = item
			}
		}
	}
	return sessions, timezone
}

// resolveDatasetPath finds a dataset a planner refers to.
//
// A planner stores the nested path ("events/ddd/2025-leuven.json"). Older
// planners saved a flattened name, so those are mapped back through the catalog
// — mirroring the client's resolveEventFile.
func resolveDatasetPath(file, dataDir string) string {
	if direct := paths.SafeJoin(dataDir, file); direct != "" {
		if _, err := os.Stat(direct); err == nil {
			return direct
		}
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return ""
	}
	catalog, err := js.ParseJSON(raw)
	if err != nil {
		return ""
	}
	for _, entry := range catalog.Get("events").Items() {
		known := entry.Get("file").Str()
		if known == "" {
			continue
		}
		flattened := strings.ReplaceAll(strings.TrimPrefix(known, "events/"), "/", "-")
		if flattened != file {
			continue
		}
		if path := paths.SafeJoin(dataDir, known); path != "" {
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}
	return ""
}

// FoundPlanner is a planner and where it was read from.
type FoundPlanner struct {
	Planner *js.Value
	Path    string
	File    string
}

// FindPlannerByID finds the planner whose `_id` matches, scanning the planner
// directory and one level of per-user subdirectories.
//
// Deliberately NOT cached here, unlike the Node version's 60-second index. That
// cache exists so an unauthenticated poller cannot amplify a request into a full
// directory scan; a cache in a component that does not yet own the route would
// be a second answer to that question, and the wrong place to decide it. When
// this backs the live route it needs one — with a test for the stale-mapping
// path, which the original handles by invalidating.
func FindPlannerByID(uuid, plannerDir string) *FoundPlanner {
	if uuid == "" {
		return nil
	}
	var candidates []string

	entries, err := os.ReadDir(plannerDir)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			candidates = append(candidates, filepath.Join(plannerDir, entry.Name()))
			continue
		}
		if entry.IsDir() {
			sub, err := os.ReadDir(filepath.Join(plannerDir, entry.Name()))
			if err != nil {
				continue
			}
			for _, file := range sub {
				if !file.IsDir() && strings.HasSuffix(file.Name(), ".json") {
					candidates = append(candidates,
						filepath.Join(plannerDir, entry.Name(), file.Name()))
				}
			}
		}
	}

	for _, path := range candidates {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		planner, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		if planner.Get("_id").Str() == uuid {
			return &FoundPlanner{Planner: planner, Path: path, File: filepath.Base(path)}
		}
	}
	return nil
}
