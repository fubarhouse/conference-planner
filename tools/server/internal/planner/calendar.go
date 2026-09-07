package planner

// A Go port of the iCalendar builders in app/js/modules/plannerCalendar.js —
// the fifth and last browser module the backend depends on.
//
// The client uses these to build a download and the server uses them to build a
// subscription, and the point of sharing them was that the two produce the same
// VEVENTs. Porting them means that guarantee now spans two languages, so the
// output is compared byte for byte against the JavaScript over every event in
// the archive.
//
// Several things here are deliberately reproduced rather than improved:
// the timezone conversion resolves its offset at the wall time read as UTC (not
// at the local instant), line folding counts UTF-16 code units, and an absent
// field becomes the string "undefined" in a session id. Each is a behaviour the
// existing feeds already have, and a subscriber's calendar reconciles on the
// UIDs those rules produce.

import (
	"server/internal/archive"
	"server/internal/js"
	"server/internal/paths"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// defaultEventMinutes is how long an event runs when it has no end.
const defaultEventMinutes = 60

// WallTime is a calendar date and, optionally, a time of day — a wall-clock
// reading, not an instant.
type WallTime struct {
	Date string // YYYY-MM-DD
	Time string // HH:MM, empty for an all-day event
}

// Geo is a map pin.
type Geo struct {
	Lat, Lon float64
	Label    string
}

// CalEvent is one thing on a calendar, before it becomes a VEVENT.
type CalEvent struct {
	Title       string
	Start       WallTime
	End         *WallTime
	AllDay      bool
	Location    string
	Description string
	URL         string
	Timezone    string
	Geo         *Geo
	UID         string
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// escapeIcsText escapes an iCalendar TEXT value. Order matters: the backslash
// first, or the escapes introduced below would themselves be escaped.
func escapeIcsText(text string) string {
	text = strings.ReplaceAll(text, `\`, `\\`)
	text = strings.ReplaceAll(text, "\r\n", `\n`)
	text = strings.ReplaceAll(text, "\r", `\n`)
	text = strings.ReplaceAll(text, "\n", `\n`)
	text = strings.ReplaceAll(text, ",", `\,`)
	return strings.ReplaceAll(text, ";", `\;`)
}

// icsDate turns YYYY-MM-DD into YYYYMMDD.
func icsDate(date string) string { return strings.ReplaceAll(date, "-", "") }

// icsDateTime is the floating form, YYYYMMDDTHHMMSS.
func icsDateTime(w WallTime) string {
	hour, minute := "00", "00"
	parts := strings.Split(w.Time, ":")
	if len(parts) > 0 && parts[0] != "" {
		hour = parts[0]
	}
	if len(parts) > 1 && parts[1] != "" {
		minute = parts[1]
	}
	return icsDate(w.Date) + "T" + padTo2(hour) + padTo2(minute) + "00"
}

// padTo2 is String(n).padStart(2, '0') on a value that is already a string —
// which is what the original does, so "7" becomes "07" and "123" stays "123".
func padTo2(s string) string {
	if len(s) < 2 {
		return strings.Repeat("0", 2-len(s)) + s
	}
	return s
}

// AddMinutes adds minutes to a wall time using UTC arithmetic, so no local
// timezone can drift it, rolling across midnight when needed.
func AddMinutes(w WallTime, minutes int) WallTime {
	year, month, day := splitDate(w.Date)
	hour, minute := splitTime(w.Time)
	t := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC).
		Add(time.Duration(minutes) * time.Minute)
	return WallTime{
		Date: strconv.Itoa(t.Year()) + "-" + pad2(int(t.Month())) + "-" + pad2(t.Day()),
		Time: pad2(t.Hour()) + ":" + pad2(t.Minute()),
	}
}

func splitDate(date string) (int, int, int) {
	parts := strings.Split(date, "-")
	get := func(i int) int {
		if i < len(parts) {
			n, _ := strconv.Atoi(parts[i])
			return n
		}
		return 0
	}
	return get(0), get(1), get(2)
}

func splitTime(clock string) (int, int) {
	if clock == "" {
		clock = "00:00"
	}
	parts := strings.Split(clock, ":")
	get := func(i int) int {
		if i < len(parts) {
			n, _ := strconv.Atoi(parts[i])
			return n
		}
		return 0
	}
	return get(0), get(1)
}

// icsInstant turns a wall time in an IANA zone into an absolute UTC stamp.
// With no zone — or an unknown one — it returns the FLOATING form, preserving
// the behaviour a trip with no known timezone already has.
//
// The offset is resolved the way the JavaScript resolves it: at the wall time
// READ AS UTC, not at the instant the wall time denotes. Those differ by an hour
// for a couple of hours a year around a DST boundary. Reproduced rather than
// corrected, because the UIDs and times already in subscribers' calendars were
// produced by this rule, and a port is the wrong moment to move an event.
func icsInstant(w WallTime, timezone string) string {
	if timezone == "" {
		return icsDateTime(w)
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return icsDateTime(w)
	}

	year, month, day := splitDate(w.Date)
	hour, minute := splitTime(w.Time)
	wall := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)

	local := wall.In(location)
	asUTC := time.Date(local.Year(), local.Month(), local.Day(),
		local.Hour(), local.Minute(), local.Second(), 0, time.UTC)
	instant := wall.Add(-asUTC.Sub(wall))

	return strconv.Itoa(instant.Year()) + pad2(int(instant.Month())) + pad2(instant.Day()) +
		"T" + pad2(instant.Hour()) + pad2(instant.Minute()) + pad2(instant.Second()) + "Z"
}

// nextDay is the exclusive DTEND for an all-day span: iCalendar all-day DTEND is
// the day AFTER the last day.
func nextDay(date string) string {
	return icsDate(AddMinutes(WallTime{Date: date, Time: "00:00"}, 24*60).Date)
}

// SessionToCalEvent maps one session to a calendar entry, or nil when it has no
// start time to place it at.
func SessionToCalEvent(session *js.Value, timezone string) *CalEvent {
	startISO := session.Get("startTime").Str()
	if startISO == "" {
		return nil
	}
	start := wallTimeOf(startISO, timezone)
	if start == nil {
		return nil
	}

	var speakers []string
	for _, speaker := range session.Get("speakers").Items() {
		name := speaker.Str()
		if !speaker.IsString() {
			name = speaker.Get("name").Str()
		}
		if name != "" {
			speakers = append(speakers, name)
		}
	}

	link := js.Trim(session.Get("link").Str())
	video := js.Trim(session.Get("video_url").Str())

	// A readable description: the abstract, then who is speaking, the track, and
	// the links — so the calendar item is more than a title.
	var parts []string
	body := js.Trim(paths.FirstNonEmpty(
		session.Get("full_description").Str(),
		session.Get("description").Str(),
		session.Get("abstract").Str(),
	))
	if body != "" {
		parts = append(parts, body)
	}
	if len(speakers) > 0 {
		label := "Speaker"
		if len(speakers) > 1 {
			label = "Speakers"
		}
		parts = append(parts, label+": "+strings.Join(speakers, ", "))
	}
	// `if (session.track)` is a TRUTHINESS test, and an empty array is truthy in
	// JavaScript. So a session with `track: []` — and the archive has many —
	// gets a bare "Track: " line with nothing after it. Reproduced rather than
	// tidied: these descriptions are already in subscribers' calendars.
	if track := session.Get("track"); js.Truthy(track) {
		parts = append(parts, "Track: "+js.Trim(js.String(track)))
	}
	if link != "" {
		parts = append(parts, link)
	}
	if video != "" && video != link {
		parts = append(parts, "Recording: "+video)
	}

	event := &CalEvent{
		Title:       js.Trim(orDefault(session.Get("title").Str(), "Session")),
		Start:       *start,
		Location:    js.Trim(session.Get("location").Str()),
		Description: strings.Join(parts, "\n\n"),
		URL:         paths.FirstNonEmpty(link, video),
		Timezone:    js.Trim(timezone),
	}
	if endISO := session.Get("endTime").Str(); endISO != "" {
		event.End = wallTimeOf(endISO, timezone)
	}
	return event
}

// wallTimeOf reads an ISO instant and renders it as a wall time in a zone —
// `new Date(iso)` followed by toLocaleDateString('en-CA') and
// toLocaleTimeString('en-GB', { hour12: false }).
func wallTimeOf(iso, timezone string) *WallTime {
	instant, err := js.ParseDate(iso)
	if err != nil {
		return nil
	}
	location := time.UTC
	if timezone != "" {
		if loaded, err := time.LoadLocation(timezone); err == nil {
			location = loaded
		} else {
			// An unknown zone falls back to the process zone, which is what
			// toLocaleString does when its timeZone option is absent.
			location = time.Local
		}
	} else {
		location = time.Local
	}
	local := instant.In(location)
	return &WallTime{
		Date: strconv.Itoa(local.Year()) + "-" + pad2(int(local.Month())) + "-" + pad2(local.Day()),
		Time: pad2(local.Hour()) + ":" + pad2(local.Minute()),
	}
}

// ScheduleSessionsToCalEvents maps raw session items to calendar entries for a
// whole-event schedule, shared by the subscription feed and the client's
// "export selected" download so the two stay identical.
func ScheduleSessionsToCalEvents(sessions []*js.Value, timezone, place string, coords *Geo, uidBase string) []*CalEvent {
	var out []*CalEvent
	for _, session := range sessions {
		event := SessionToCalEvent(session, timezone)
		if event == nil {
			continue
		}
		room := event.Location

		// A session can be somewhere else entirely — an awards ceremony in a
		// theatre across town, a sprint in a sponsor's office. `venue` says so,
		// and then the event's own place must NOT be appended: naming two
		// buildings sends people to the wrong one.
		var offsite *js.Value
		if venue := session.Get("venue"); venue.Exists() && js.Trim(venue.Get("name").Str()) != "" {
			offsite = venue
		}
		where := place
		if offsite != nil {
			where = archive.JoinNonEmpty(", ", offsite.Get("name").Str(), offsite.Get("address").Str())
		}
		event.Location = archive.JoinNonEmpty(" · ", room, where)
		if event.Location == "" {
			event.Location = paths.FirstNonEmpty(room, where)
		}

		// Coordinates follow the same rule: an offsite session uses its own, and
		// with none it gets NO pin. Inheriting the event's would put a marker on
		// the wrong building with every appearance of being right.
		var pin *Geo
		if offsite != nil {
			if lat, okLat := offsite.Get("latitude").Number(); okLat {
				if lon, okLon := offsite.Get("longitude").Number(); okLon {
					pin = &Geo{Lat: lat, Lon: lon}
				}
			}
		} else if lat, okLat := session.Get("latitude").Number(); okLat {
			if lon, okLon := session.Get("longitude").Number(); okLon {
				pin = &Geo{Lat: lat, Lon: lon}
			}
		} else {
			pin = coords
		}
		if pin != nil {
			label := event.Location
			if label == "" {
				label = where
			}
			event.Geo = &Geo{Lat: pin.Lat, Lon: pin.Lon, Label: label}
		}

		if offsite != nil {
			// The venue's own page is worth carrying: a subscriber who cannot
			// find the door wants the link, not the address they already failed
			// to find.
			if url := offsite.Get("url").Str(); url != "" && event.URL == "" {
				event.URL = url
			}
			if note := offsite.Get("note").Str(); note != "" {
				event.Description = archive.JoinNonEmpty("\n\n", event.Description, note)
			}
		}

		event.UID = "session-" + session.Get("id").Str() + "@" + uidBase
		out = append(out, event)
	}
	return out
}

// BuildVevent renders one VEVENT.
func BuildVevent(event *CalEvent, uid, dtStamp string, alarmMinutes int) string {
	lines := []string{"BEGIN:VEVENT", "UID:" + uid, "DTSTAMP:" + dtStamp}

	if event.AllDay {
		endDate := nextDay(event.Start.Date)
		if event.End != nil && event.End.Date != "" {
			endDate = nextDay(event.End.Date)
		}
		lines = append(lines,
			"DTSTART;VALUE=DATE:"+icsDate(event.Start.Date),
			"DTEND;VALUE=DATE:"+endDate)
	} else {
		end := AddMinutes(event.Start, defaultEventMinutes)
		if event.End != nil {
			end = *event.End
		}
		lines = append(lines,
			"DTSTART:"+icsInstant(event.Start, event.Timezone),
			"DTEND:"+icsInstant(end, event.Timezone))
	}

	lines = append(lines, "SUMMARY:"+escapeIcsText(event.Title))
	if event.Location != "" {
		lines = append(lines, "LOCATION:"+escapeIcsText(event.Location))
	}
	if event.Description != "" {
		lines = append(lines, "DESCRIPTION:"+escapeIcsText(event.Description))
	}
	if event.URL != "" {
		// A URI, not TEXT — commas and semicolons are not escaped here.
		lines = append(lines, "URL:"+stripNewlines(event.URL))
	}
	if event.Geo != nil {
		lat, lon := jsNumberString(event.Geo.Lat), jsNumberString(event.Geo.Lon)
		lines = append(lines, "GEO:"+lat+";"+lon)
		// Apple Calendar draws a real map pin from this structured property.
		label := js.Trim(stripQuotesAndNewlines(paths.FirstNonEmpty(
			event.Geo.Label, event.Location, event.Title)))
		lines = append(lines,
			`X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="`+label+
				`";X-APPLE-RADIUS=100;X-TITLE="`+label+`":geo:`+lat+","+lon)
	}
	if alarmMinutes > 0 {
		lines = append(lines,
			"BEGIN:VALARM", "ACTION:DISPLAY",
			"DESCRIPTION:"+escapeIcsText(event.Title),
			"TRIGGER:-PT"+strconv.Itoa(alarmMinutes)+"M",
			"END:VALARM")
	}
	lines = append(lines, "END:VEVENT")

	for i, line := range lines {
		lines[i] = foldIcsLine(line)
	}
	return strings.Join(lines, "\r\n")
}

// foldIcsLine folds content lines per RFC 5545.
//
// It counts UTF-16 code units, because the original counts String.length. That
// is not the octet count the RFC actually specifies — the comment in the
// JavaScript says as much, and folds conservatively at 72 to stay under it —
// but a Go port that folded on bytes or runes would put the continuation in a
// different place and every multi-byte description would differ.
func foldIcsLine(line string) string {
	units := utf16.Encode([]rune(line))
	if len(units) <= 72 {
		return line
	}
	var out []string
	out = append(out, string(utf16.Decode(units[:72])))
	rest := units[72:]
	for len(rest) > 0 {
		size := 71
		if len(rest) < size {
			size = len(rest)
		}
		out = append(out, string(utf16.Decode(rest[:size])))
		rest = rest[size:]
	}
	return strings.Join(out, "\r\n ")
}

// icsDuration is an iCalendar DURATION for whole minutes — PT6H when it divides
// into hours, else PT90M.
func icsDuration(minutes int) string {
	if minutes < 1 {
		minutes = 1
	}
	if minutes%60 == 0 {
		return "PT" + strconv.Itoa(minutes/60) + "H"
	}
	return "PT" + strconv.Itoa(minutes) + "M"
}

// BuildIcsCalendar wraps calendar entries in a VCALENDAR.
//
// refreshMinutes adds the subscription auto-refresh hints, which Apple and
// Outlook honour and Google ignores in favour of its own polling.
func BuildIcsCalendar(events []*CalEvent, calName, dtStamp string, alarmMinutes, refreshMinutes int) string {
	rendered := make([]string, 0, len(events))
	for i, event := range events {
		uid := event.UID
		if uid == "" {
			uid = strconv.Itoa(i) + "@planner"
		}
		rendered = append(rendered, BuildVevent(event, uid, dtStamp, alarmMinutes))
	}

	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//conference-planner//" + escapeIcsText(calName) + "//EN",
		"X-WR-CALNAME:" + escapeIcsText(calName),
	}
	if refreshMinutes > 0 {
		lines = append(lines,
			"REFRESH-INTERVAL;VALUE=DURATION:"+icsDuration(refreshMinutes),
			"X-PUBLISHED-TTL:"+icsDuration(refreshMinutes))
	}
	lines = append(lines, strings.Join(rendered, "\r\n"), "END:VCALENDAR")
	return strings.Join(lines, "\r\n")
}

// NowStamp is the DTSTAMP the builders use when the caller supplies none.
func NowStamp(now time.Time) string {
	return icsDateTime(WallTime{
		Date: strconv.Itoa(now.UTC().Year()) + "-" + pad2(int(now.UTC().Month())) + "-" + pad2(now.UTC().Day()),
		Time: pad2(now.UTC().Hour()) + ":" + pad2(now.UTC().Minute()),
	}) + "Z"
}

func stripNewlines(s string) string {
	return strings.NewReplacer("\r", "", "\n", "").Replace(s)
}

func stripQuotesAndNewlines(s string) string {
	return strings.NewReplacer(`"`, "", "\r", "", "\n", "").Replace(s)
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// jsNumberString renders a number the way template interpolation does: an
// integral value carries no decimal point.
func jsNumberString(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

type errorString string

func (e errorString) Error() string { return string(e) }
