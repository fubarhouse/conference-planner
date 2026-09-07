package archive

// A Go port of lib/archiveQuality.js — how good the data is, as distinct from
// how much of it there is.
//
// Coverage answers "what is missing". It cannot answer "what is here but
// wrong", because every defect it would need to see sits inside a field that is
// technically filled: a description whose paragraphs were flattened into one
// block, a room called "Location Hall C" because a scrape took the field's
// label along with its value, an `&amp;` that was never decoded. Those all read
// as present and count towards coverage.
//
// Each probe is one defect with a shape specific enough to detect without
// guessing, and each finding names the sessions it applies to, so the output is
// a worklist rather than a score. A probe earns its place by having been found
// in real data at least once.

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"server/internal/paths"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

type probe struct {
	Key    string
	Label  string
	Detail string
	Repair string
	// Find returns the offending sessions; the caller counts them.
	Find func(ev *qualityView) int
	// EventScope probes look at the event record instead.
	EventScope bool
}

type qualityView struct {
	event    *js.Value
	all      []*js.Value
	sessions []*js.Value
}

var (
	entityPattern    = regexp.MustCompile(`&(?:amp|lt|gt|nbsp|quot|#\d+);`)
	truncatedLink    = regexp.MustCompile(`\[[^\]]*(?:…|\.\.\.)\]\(`)
	doubleSlashLink  = regexp.MustCompile(`^https?://[^/]+//`)
	roomCarriesLabel = regexp.MustCompile(`^Location\s+\S`)
)

// The defects, in the order they matter: text fidelity first (it is the part a
// reader actually sees), then structure, then the event's own metadata.
var probes = []probe{
	{
		Key: "flattened", Label: "Flattened descriptions",
		Detail: "a long description with no blank line — the paragraphs the author wrote were " +
			"lost by the scrape, and the text renders as one wall",
		Repair: "re-derive from the session page",
		Find: func(ev *qualityView) int {
			return countMatching(ev.sessions, func(s *js.Value) bool {
				description := s.Get("full_description").Str()
				// String.length is UTF-16 code units, not runes or bytes.
				return utf16Len(description) > 400 && !strings.Contains(description, "\n\n")
			})
		},
	},
	{
		Key: "entities", Label: "Undecoded HTML entities",
		Detail: "text still carrying &amp; / &gt; / &nbsp; — the scrape never decoded them",
		Repair: "re-derive from the session page",
		Find: func(ev *qualityView) int {
			return countMatching(ev.sessions, func(s *js.Value) bool {
				return entityPattern.MatchString(s.Get("full_description").Str())
			})
		},
	},
	{
		Key: "truncated-links", Label: "Truncated link labels",
		Detail: "a Markdown link whose text is an ellipsised URL — the page displayed a shortened " +
			"label and the scrape stored what it saw",
		Repair: "re-derive from the session page",
		Find: func(ev *qualityView) int {
			return countMatching(ev.sessions, func(s *js.Value) bool {
				return truncatedLink.MatchString(s.Get("full_description").Str())
			})
		},
	},
	{
		Key: "boilerplate", Label: "Boilerplate descriptions",
		Detail: "the same short text on many sessions — usually page furniture (a newsletter " +
			"block, a footer) captured because the session itself had no description",
		Repair: "clear them; the sessions have no description",
		Find: func(ev *qualityView) int {
			counts := map[string]int{}
			for _, session := range ev.sessions {
				description := js.Trim(session.Get("full_description").Str())
				if description != "" && utf16Len(description) < 200 {
					counts[description]++
				}
			}
			// Eight is past coincidence: repeated coffee breaks legitimately
			// share a line, but a dozen different talks do not describe
			// themselves identically.
			suspect := map[string]bool{}
			for description, n := range counts {
				if n >= 8 {
					suspect[description] = true
				}
			}
			if len(suspect) == 0 {
				return 0
			}
			return countMatching(ev.sessions, func(s *js.Value) bool {
				return suspect[js.Trim(s.Get("full_description").Str())]
			})
		},
	},
	{
		Key: "double-slash", Label: "Malformed session links",
		Detail: "a doubled slash after the host — every one of these redirects before it resolves",
		Repair: "collapse the slash",
		Find: func(ev *qualityView) int {
			return countMatching(ev.all, func(s *js.Value) bool {
				return doubleSlashLink.MatchString(s.Get("link").Str())
			})
		},
	},
	{
		Key: "room-label", Label: "Rooms carrying a field label",
		Detail: `"Location Hall C" — the scrape took the label and the value together`,
		Repair: "strip the leading label",
		Find: func(ev *qualityView) int {
			return countMatching(ev.all, func(s *js.Value) bool {
				return roomCarriesLabel.MatchString(s.Get("location").Str())
			})
		},
	},
	{
		Key: "sponsor-no-link", Label: "Sponsors with no link",
		Detail:     "a logo with nothing behind it — the sponsor cannot be followed or matched by URL",
		Repair:     "take the link from the sponsors page",
		EventScope: true,
		Find: func(ev *qualityView) int {
			return countMatching(ev.event.Get("sponsors").Items(), func(s *js.Value) bool {
				return !s.Get("link").Text()
			})
		},
	},
	{
		Key: "sponsor-no-image", Label: "Sponsors with no logo",
		Detail:     "recorded by name only — the sponsor grid renders a blank",
		Repair:     "extract logos from a capture of the sponsors page",
		EventScope: true,
		Find: func(ev *qualityView) int {
			return countMatching(ev.event.Get("sponsors").Items(), func(s *js.Value) bool {
				return !s.Get("image").Text()
			})
		},
	},
}

// Session-level fields whose completeness is worth tracking over time.
var qualityFields = []struct {
	Key  string
	Have func(*js.Value) bool
}{
	{"descriptions", func(s *js.Value) bool { return s.Get("full_description").Text() }},
	{"speakers", func(s *js.Value) bool { return len(s.Get("speakers").Items()) > 0 }},
	{"tracks", func(s *js.Value) bool { return len(s.Get("track").Items()) > 0 }},
	{"rooms", func(s *js.Value) bool { return s.Get("location").Text() }},
	{"recordings", func(s *js.Value) bool { return s.Get("video_url").Text() }},
}

// Event-level metadata, the same way.
var qualityMeta = []struct {
	Key  string
	Have func(*js.Value) bool
}{
	{"sponsors", func(e *js.Value) bool { return len(e.Get("sponsors").Items()) > 0 }},
	{"coordinates", func(e *js.Value) bool {
		_, lat := e.Get("latitude").Number()
		_, lon := e.Get("longitude").Number()
		return lat && lon
	}},
	{"attendance", func(e *js.Value) bool {
		_, ok := e.Get("attendance").Get("count").Number()
		return ok
	}},
	{"community credits", func(e *js.Value) bool { return e.Get("community").Exists() }},
	{"photo album", func(e *js.Value) bool { return e.Get("flickr").Get("groupUrl").Text() }},
}

var eras = [][2]int{{2007, 2012}, {2013, 2017}, {2018, 2021}, {2022, 2030}}

type qualityEvent struct {
	file     string
	name     string
	year     int
	series   string
	sessions int
	fields   map[string]int
	meta     map[string]int
	findings []qualityFinding
	defects  int
}

type qualityFinding struct {
	key, label, repair string
	count              int
}

// BuildQuality reads every dataset once and reports both halves: how complete
// it is, and what is wrong with what is there.
func BuildQuality(dataDir string) (*js.Value, error) {
	files, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		return nil, err
	}
	eventsRoot := filepath.Join(dataDir, "events") + string(filepath.Separator)

	var events []qualityEvent
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			// A dataset that will not parse is the validator's problem.
			continue
		}

		event := data.Get("event")
		if event == nil {
			event = js.Obj()
		}
		all := data.Get("items").Items()
		var sessions []*js.Value
		for _, item := range all {
			if CountsAsSession(item) {
				sessions = append(sessions, item)
			}
		}
		if len(sessions) == 0 {
			continue
		}

		ev := &qualityView{event: event, all: all, sessions: sessions}
		var findings []qualityFinding
		defects := 0
		for _, p := range probes {
			if hits := p.Find(ev); hits > 0 {
				findings = append(findings, qualityFinding{p.Key, p.Label, p.Repair, hits})
				defects += hits
			}
		}

		startYear := FirstRunes(event.Get("startDate").Str(), 4)
		fields := map[string]int{}
		for _, field := range qualityFields {
			fields[field.Key] = countMatching(sessions, field.Have)
		}
		meta := map[string]int{}
		for _, m := range qualityMeta {
			meta[m.Key] = boolToInt(m.Have(event))
		}

		events = append(events, qualityEvent{
			file: strings.TrimSuffix(
				filepath.ToSlash(strings.TrimPrefix(path, eventsRoot)), ".json"),
			name: js.Trim(
				orQuestionMark(event.Get("designation").Str()) + " " +
					orQuestionMark(event.Get("location").Str()) + " " + startYear),
			year:     jsNumberOrZero(startYear),
			series:   orQuestionMark(event.Get("designation").Str()),
			sessions: len(sessions),
			fields:   fields,
			meta:     meta,
			findings: findings,
			defects:  defects,
		})
	}

	totalSessions := 0
	for _, event := range events {
		totalSessions += event.sessions
	}

	fieldTotals := js.Arr()
	for _, field := range qualityFields {
		have := 0
		for _, event := range events {
			have += event.fields[field.Key]
		}
		fieldTotals.Append(js.Obj().
			Set("key", js.Str(field.Key)).
			Set("have", js.Int(have)).
			Set("total", js.Int(totalSessions)).
			Set("pct", pctValue(have, totalSessions)))
	}

	metaTotals := js.Arr()
	for _, m := range qualityMeta {
		have := 0
		for _, event := range events {
			have += event.meta[m.Key]
		}
		metaTotals.Append(js.Obj().
			Set("key", js.Str(m.Key)).
			Set("have", js.Int(have)).
			Set("total", js.Int(len(events))).
			Set("pct", pctValue(have, len(events))))
	}

	eraTotals := js.Arr()
	for _, era := range eras {
		var group []qualityEvent
		for _, event := range events {
			if event.year >= era[0] && event.year <= era[1] {
				group = append(group, event)
			}
		}
		if len(group) == 0 {
			continue
		}
		sessions, descriptions, recordings, sponsors := 0, 0, 0, 0
		for _, event := range group {
			sessions += event.sessions
			descriptions += event.fields["descriptions"]
			recordings += event.fields["recordings"]
			sponsors += event.meta["sponsors"]
		}
		label := strconv.Itoa(era[0]) + "–"
		if era[1] == 2030 {
			label += "now"
		} else {
			label += strconv.Itoa(era[1])
		}
		eraTotals.Append(js.Obj().
			Set("label", js.Str(label)).
			Set("events", js.Int(len(group))).
			Set("sessions", js.Int(sessions)).
			Set("descriptions", pctValue(descriptions, sessions)).
			Set("recordings", pctValue(recordings, sessions)).
			Set("sponsors", js.Int(sponsors)))
	}

	// Series, in first-seen order before the sort — a Map preserves insertion
	// order, and the sort below is stable, so ties keep it.
	type seriesRow struct {
		series                                     string
		events, sessions, descriptions, recordings int
	}
	var seriesOrder []string
	seriesRows := map[string]*seriesRow{}
	for _, event := range events {
		row, seen := seriesRows[event.series]
		if !seen {
			row = &seriesRow{series: event.series}
			seriesRows[event.series] = row
			seriesOrder = append(seriesOrder, event.series)
		}
		row.events++
		row.sessions += event.sessions
		row.descriptions += event.fields["descriptions"]
		row.recordings += event.fields["recordings"]
	}
	ordered := make([]*seriesRow, 0, len(seriesOrder))
	for _, key := range seriesOrder {
		ordered = append(ordered, seriesRows[key])
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].sessions > ordered[j].sessions })

	seriesValue := js.Arr()
	for _, row := range ordered {
		seriesValue.Append(js.Obj().
			Set("series", js.Str(row.series)).
			Set("events", js.Int(row.events)).
			Set("sessions", js.Int(row.sessions)).
			Set("descriptions", js.Int(row.descriptions)).
			Set("recordings", js.Int(row.recordings)).
			Set("descPct", pctValue(row.descriptions, row.sessions)).
			Set("vidPct", pctValue(row.recordings, row.sessions)))
	}

	probeValue := js.Arr()
	totalDefects := 0
	for _, p := range probes {
		type hit struct {
			file, name string
			count      int
		}
		var hits []hit
		count := 0
		for _, event := range events {
			for _, finding := range event.findings {
				if finding.key == p.Key {
					hits = append(hits, hit{event.file, event.name, finding.count})
					count += finding.count
				}
			}
		}
		if count == 0 {
			continue
		}
		totalDefects += count
		sort.SliceStable(hits, func(i, j int) bool { return hits[i].count > hits[j].count })
		worst := js.Arr()
		for _, h := range hits {
			worst.Append(js.Obj().
				Set("file", js.Str(h.file)).
				Set("name", js.Str(h.name)).
				Set("count", js.Int(h.count)))
		}
		probeValue.Append(js.Obj().
			Set("key", js.Str(p.Key)).
			Set("label", js.Str(p.Label)).
			Set("detail", js.Str(p.Detail)).
			Set("repair", js.Str(p.Repair)).
			Set("count", js.Int(count)).
			Set("events", js.Int(len(hits))).
			Set("worst", worst))
	}

	// Worst first, then by name.
	sort.SliceStable(events, func(i, j int) bool {
		if events[i].defects != events[j].defects {
			return events[i].defects > events[j].defects
		}
		return js.LocaleCompare(events[i].name, events[j].name)
	})

	eventsValue := js.Arr()
	withDefects := 0
	for _, event := range events {
		if event.defects > 0 {
			withDefects++
		}
		fields := js.Obj()
		for _, field := range qualityFields {
			fields.Set(field.Key, js.Int(event.fields[field.Key]))
		}
		meta := js.Obj()
		for _, m := range qualityMeta {
			meta.Set(m.Key, js.Int(event.meta[m.Key]))
		}
		findings := js.Arr()
		for _, finding := range event.findings {
			findings.Append(js.Obj().
				Set("key", js.Str(finding.key)).
				Set("label", js.Str(finding.label)).
				Set("repair", js.Str(finding.repair)).
				Set("count", js.Int(finding.count)))
		}
		eventsValue.Append(js.Obj().
			Set("file", js.Str(event.file)).
			Set("name", js.Str(event.name)).
			Set("year", js.Int(event.year)).
			Set("series", js.Str(event.series)).
			Set("sessions", js.Int(event.sessions)).
			Set("fields", fields).
			Set("meta", meta).
			Set("findings", findings).
			Set("defects", js.Int(event.defects)))
	}

	return js.Obj().
		Set("events", eventsValue).
		Set("probes", probeValue).
		Set("fields", fieldTotals).
		Set("meta", metaTotals).
		Set("eras", eraTotals).
		Set("series", seriesValue).
		Set("totals", js.Obj().
			Set("events", js.Int(len(events))).
			Set("sessions", js.Int(totalSessions)).
			Set("defects", js.Int(totalDefects)).
			Set("eventsWithDefects", js.Int(withDefects))), nil
}

func countMatching(values []*js.Value, pred func(*js.Value) bool) int {
	n := 0
	for _, value := range values {
		if pred(value) {
			n++
		}
	}
	return n
}

// utf16Len counts UTF-16 code units, which is what JavaScript's String.length
// reports. Runes outside the BMP count as two — an emoji in a description would
// otherwise put the Go and Node sides on different sides of the 400-character
// threshold.
func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// pctValue is `Math.round(1000 * part / whole) / 10` — one decimal place,
// rendered the way JSON.stringify renders a number: 87.3, but 100 not 100.0.
func pctValue(part, whole int) *js.Value {
	if whole == 0 {
		return js.Int(0)
	}
	rounded := math.Round(1000*float64(part)/float64(whole)) / 10
	if rounded == math.Trunc(rounded) {
		return js.Int(int(rounded))
	}
	return js.Literal(strconv.FormatFloat(rounded, 'f', -1, 64))
}

func orQuestionMark(s string) string {
	if s == "" {
		return "?"
	}
	return s
}

// jsNumberOrZero is `Number(text) || 0`.
func jsNumberOrZero(text string) int {
	n, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return int(n)
}
