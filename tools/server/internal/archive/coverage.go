package archive

// A Go port of lib/archiveCoverage.js — what each event is missing, and whether
// anyone still wants to be told.
//
// The audit scores coverage; a score is not a worklist. This turns the same
// scan into per-event, per-check rows with a count, a fixable count and a
// state. The state is what makes it usable twice: some gaps will never close —
// DrupalCon Barcelona 2007 has no session recordings and never will — so a
// check can be ignored or snoozed, and both live in the curation ledger.
//
// The Node implementation remains authoritative. coverage_test.go runs both
// over the real archive and diffs the JSON.

import (
	"math"
	"os"
	"path/filepath"
	"server/internal/js"
	"server/internal/paths"
	"sort"
	"strconv"
	"strings"
	"time"
)

// check is one thing an event can be missing.
//
// `fixable` counts the subset actionable today — a session with no description
// but WITH a link is a scrape away; one with neither needs a human who was in
// the room.
type check struct {
	Key    string
	Label  string
	Detail string
	// After marks a check only answerable once the event has happened. Nothing
	// is recorded, counted or photographed in advance; before then it is
	// pending, not missing.
	After bool
	// Fetchable marks a gap a scrape could close, and Gap says whether a given
	// session has it. Together they drive fixableSessions.
	Fetchable bool
	Gap       func(session *js.Value) bool
	Test      func(ev *eventView, geo *js.Value) result
}

type result struct{ missing, total, fixable int }

// eventView is a dataset reduced to what the checks ask about.
type eventView struct {
	event    *js.Value
	sessions []*js.Value
}

func (e *eventView) sponsors() []*js.Value { return e.event.Get("sponsors").Items() }
func (e *eventView) people() []*js.Value {
	return e.event.Get("community").Get("people").Items()
}

// countSessions applies a predicate over the event's sessions.
func countSessions(sessions []*js.Value, pred func(*js.Value) bool) []*js.Value {
	var out []*js.Value
	for _, session := range sessions {
		if pred(session) {
			out = append(out, session)
		}
	}
	return out
}

func noDescription(s *js.Value) bool { return !s.Get("full_description").Text() }
func noVideo(s *js.Value) bool       { return !s.Get("video_url").Text() }

// checks, in the order a person would work through them: can this event be read
// at all, then what it says, then what surrounds it.
var checks = []check{
	{
		Key: "sessions", Label: "Sessions", Detail: "the programme itself",
		Test: func(ev *eventView, _ *js.Value) result {
			return result{missing: boolToInt(len(ev.sessions) == 0), total: 1}
		},
	},
	{
		Key: "descriptions", Label: "Descriptions",
		Detail: "what each session was about — feeds search and the topic charts",
		// Scrapable: the session page is where this field came from in the first place.
		Fetchable: true,
		Gap:       noDescription,
		Test: func(ev *eventView, _ *js.Value) result {
			missing := countSessions(ev.sessions, noDescription)
			return result{
				missing: len(missing),
				total:   len(ev.sessions),
				fixable: len(countSessions(missing, func(s *js.Value) bool { return s.Get("link").Text() })),
			}
		},
	},
	{
		Key: "speakers", Label: "Speakers", Detail: "who gave each session",
		Test: func(ev *eventView, _ *js.Value) result {
			missing := countSessions(ev.sessions, func(s *js.Value) bool {
				return len(s.Get("speakers").Items()) == 0
			})
			return result{missing: len(missing), total: len(ev.sessions)}
		},
	},
	{
		Key: "videos", Label: "Recordings", Detail: "the session on video",
		After: true, Fetchable: true, Gap: noVideo,
		Test: func(ev *eventView, _ *js.Value) result {
			missing := countSessions(ev.sessions, noVideo)
			return result{
				missing: len(missing),
				total:   len(ev.sessions),
				fixable: len(countSessions(missing, func(s *js.Value) bool { return s.Get("link").Text() })),
			}
		},
	},
	{
		Key: "tracks", Label: "Tracks", Detail: "the organisers’ own grouping",
		Test: func(ev *eventView, _ *js.Value) result {
			missing := countSessions(ev.sessions, func(s *js.Value) bool {
				return len(s.Get("track").Items()) == 0
			})
			return result{missing: len(missing), total: len(ev.sessions)}
		},
	},
	{
		Key: "links", Label: "Session links",
		Detail: "the page each session came from — what everything else is backfilled through",
		Test: func(ev *eventView, _ *js.Value) result {
			missing := countSessions(ev.sessions, func(s *js.Value) bool { return !s.Get("link").Text() })
			return result{missing: len(missing), total: len(ev.sessions)}
		},
	},
	{
		Key: "sponsors", Label: "Sponsors", Detail: "who paid for it",
		Test: func(ev *eventView, _ *js.Value) result {
			return result{missing: boolToInt(len(ev.sponsors()) == 0), total: 1}
		},
	},
	{
		Key: "credits", Label: "Community credits",
		Detail: "organisers and volunteers from the drupal.org event page",
		Test: func(ev *eventView, _ *js.Value) result {
			return result{missing: boolToInt(len(ev.people()) == 0), total: 1}
		},
	},
	{
		Key: "attendance", Label: "Attendance", After: true,
		Detail: "the final headcount, as the organisers reported it",
		Test: func(ev *eventView, _ *js.Value) result {
			_, ok := ev.event.Get("attendance").Get("count").Number()
			return result{missing: boolToInt(!ok), total: 1}
		},
	},
	{
		Key: "photos", Label: "Photo album", After: true, Detail: "the event’s own photos",
		Test: func(ev *eventView, _ *js.Value) result {
			flickr := ev.event.Get("flickr")
			has := flickr.Get("groupUrl").Text() || flickr.Get("url").Text()
			return result{missing: boolToInt(!has), total: 1}
		},
	},
	{
		Key: "place", Label: "Place",
		Detail: "venue and coordinates — without them the event is off every map",
		Test: func(ev *eventView, geo *js.Value) result {
			_, own := ev.event.Get("latitude").Number()
			_, cached := geo.Get(ev.event.Get("location").Str()).Get("lat").Number()
			missing := boolToInt(!ev.event.Get("venue").Text()) + boolToInt(!own && !cached)
			return result{missing: missing, total: 2}
		},
	},
	// ── Provenance ──────────────────────────────────────────────────────────
	//
	// Where the archive's claim that every fact is traceable currently is not —
	// and unlike a missing description, nobody sees these by reading a page.
	//
	// Undated sources are deliberately NOT a check: most cannot be dated at all,
	// and a check every event fails is one nobody reads.
	{
		Key: "sponsorSource", Label: "Sponsor listing",
		Detail: "the page that said who sponsored this — sponsors otherwise fall back to the schedule",
		Test: func(ev *eventView, _ *js.Value) result {
			if len(ev.sponsors()) == 0 {
				return result{}
			}
			listed := false
			for _, source := range ev.event.Get("sources").Items() {
				if source.Get("kind").Str() == "sponsors" && source.Get("url").Exists() &&
					source.Get("url").Text() {
					listed = true
					break
				}
			}
			// Fixable today: the sponsors exist and somebody can go and find the page.
			return result{missing: boolToInt(!listed), total: 1, fixable: boolToInt(!listed)}
		},
	},
	{
		Key: "unsourced", Label: "Unsourced records",
		Detail: "sessions, sponsors or people citing nothing at all",
		Test: func(ev *eventView, _ *js.Value) result {
			records := append([]*js.Value{}, ev.sessions...)
			records = append(records, ev.sponsors()...)
			records = append(records, ev.people()...)
			if len(records) == 0 {
				return result{}
			}
			bare := 0
			for _, record := range records {
				if len(record.Get("sourceIds").Items()) == 0 {
					bare++
				}
			}
			return result{missing: bare, total: len(records)}
		},
	},
}

// SnoozeKey is `<file>::<check>` — one state per gap, not per event: videos may
// be hopeless while descriptions are not.
func SnoozeKey(file, check string) string { return file + "::" + check }

// IsOpen reports whether a check is still asking to be looked at. `ignored` is
// forever, `later` until its date passes.
func IsOpen(snooze *js.Value, today string) bool {
	if snooze == nil || !snooze.Exists() {
		return true
	}
	switch snooze.Get("state").Str() {
	case "ignored":
		return false
	case "later":
		until := snooze.Get("until").Str()
		return until == "" || until <= today
	}
	return true
}

// BuildCoverage returns per-event coverage, worst first.
func BuildCoverage(dataDir string, snoozes *js.Value, today string) (*js.Value, error) {
	if today == "" {
		today = time.Now().UTC().Format("2006-01-02")
	}

	files, err := paths.DatasetFiles(filepath.Join(dataDir, "events"))
	if err != nil {
		return nil, err
	}

	geo := js.Obj()
	if raw, err := os.ReadFile(filepath.Join(dataDir, "geocache.json")); err == nil {
		if parsed, err := js.ParseJSON(raw); err == nil {
			geo = parsed
		}
		// A broken geocache reads as no geocache — every event unmapped, which
		// is the truth about what we can place.
	}

	type built struct {
		value     *js.Value
		openCount int
		score     int
		label     string
		fixable   int
		fixableSn int
		hasGaps   bool
	}
	var rows []built

	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}

		// The path from `events/` down, which is how the ledger keys a snooze.
		file := path
		if idx := strings.Index(filepath.ToSlash(path), "events/"); idx >= 0 {
			file = filepath.ToSlash(path)[idx:]
		}

		ev := &eventView{event: data.Get("event")}
		if ev.event == nil {
			ev.event = js.Obj()
		}
		for _, item := range data.Get("items").Items() {
			if CountsAsSession(item) {
				ev.sessions = append(ev.sessions, item)
			}
		}

		label := JoinNonEmpty(" ",
			ev.event.Get("designation").Str(),
			ev.event.Get("location").Str(),
			YearText(ev.event.Get("year")),
		)
		if label == "" {
			label = file
		}

		// Has the event finished? A conference six weeks away has no recordings,
		// no attendance figure and no photo album — reporting those as gaps put a
		// future event at the top of a worklist nobody could action.
		ends := FirstRunes(orString(ev.event.Get("endDate").Str(), ev.event.Get("startDate").Str()), 10)
		ended := ends == "" || ends < today

		checkValues := js.Arr()
		openCount, fixable := 0, 0
		openKeys := map[string]bool{}
		var pending []string

		for _, c := range checks {
			r := c.Test(ev, geo)
			snooze := snoozes.Get(SnoozeKey(file, c.Key))
			isPending := c.After && !ended
			pct := 100
			if r.total != 0 {
				pct = int(math.Round(float64(r.total-r.missing) / float64(r.total) * 100))
			}
			open := !isPending && r.missing > 0 && IsOpen(snooze, today)
			if open {
				openCount++
				fixable += r.fixable
				openKeys[c.Key] = true
			}
			if isPending {
				pending = append(pending, c.Label)
			}

			snoozeValue := js.Null()
			if snooze.Exists() {
				snoozeValue = snooze
			}
			checkValues.Append(js.Obj().
				Set("key", js.Str(c.Key)).
				Set("label", js.Str(c.Label)).
				Set("detail", js.Str(c.Detail)).
				Set("missing", js.Int(r.missing)).
				Set("total", js.Int(r.total)).
				Set("fixable", js.Int(r.fixable)).
				Set("pct", js.Int(pct)).
				Set("snooze", snoozeValue).
				Set("pending", js.Bool(isPending)).
				Set("open", js.Bool(open)))
		}

		// SESSIONS whose page would be visited: the union, so the same page is
		// not counted twice. This is the number of fetches, and the honest
		// headline — `fixable` above counts GAPS, of which one session can have
		// two.
		fixableSessions := 0
		for _, session := range ev.sessions {
			if !session.Get("link").Text() {
				continue
			}
			for _, c := range checks {
				if c.Fetchable && openKeys[c.Key] && c.Gap(session) {
					fixableSessions++
					break
				}
			}
		}

		// Scored over what CAN be answered today. Averaging in a pending check
		// would score an unheld conference against a recording that cannot exist.
		score, scored := 0, 0
		for i, c := range checks {
			if c.After && !ended {
				continue
			}
			score += IntOf(checkValues.Items()[i].Get("pct"))
			scored++
			_ = c
		}
		if scored > 0 {
			score = int(math.Round(float64(score) / float64(scored)))
		} else {
			score = 100
		}

		pendingValue := js.Arr()
		for _, label := range pending {
			pendingValue.Append(js.Str(label))
		}

		rows = append(rows, built{
			value: js.Obj().
				Set("file", js.Str(file)).
				Set("label", js.Str(label)).
				Set("year", yearNumber(ev.event.Get("year"))).
				Set("series", js.Str(ev.event.Get("designation").Str())).
				Set("sessions", js.Int(len(ev.sessions))).
				Set("checks", checkValues).
				Set("openCount", js.Int(openCount)).
				Set("fixable", js.Int(fixable)).
				Set("fixableSessions", js.Int(fixableSessions)).
				Set("score", js.Int(score)).
				Set("pending", pendingValue),
			openCount: openCount,
			score:     score,
			label:     label,
			fixable:   fixable,
			fixableSn: fixableSessions,
			hasGaps:   openCount > 0,
		})
	}

	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].openCount != rows[j].openCount {
			return rows[i].openCount > rows[j].openCount
		}
		if rows[i].score != rows[j].score {
			return rows[i].score < rows[j].score
		}
		return js.LocaleCompare(rows[i].label, rows[j].label)
	})

	events := js.Arr()
	totals := struct{ withGaps, fixable, fixableSessions int }{}
	for _, row := range rows {
		events.Append(row.value)
		if row.hasGaps {
			totals.withGaps++
		}
		totals.fixable += row.fixable
		totals.fixableSessions += row.fixableSn
	}

	checkList := js.Arr()
	for _, c := range checks {
		checkList.Append(js.Obj().
			Set("key", js.Str(c.Key)).
			Set("label", js.Str(c.Label)).
			Set("detail", js.Str(c.Detail)))
	}

	return js.Obj().
		Set("events", events).
		Set("checks", checkList).
		Set("totals", js.Obj().
			Set("events", js.Int(len(rows))).
			Set("withGaps", js.Int(totals.withGaps)).
			Set("fixable", js.Int(totals.fixable)).
			Set("fixableSessions", js.Int(totals.fixableSessions)).
			Set("snoozed", js.Int(snoozes.Len()))), nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func IntOf(v *js.Value) int {
	n, _ := v.Number()
	return int(n)
}

func orString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func JoinNonEmpty(sep string, parts ...string) string {
	var kept []string
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, sep)
}

// YearText renders `year` the way template interpolation would — it is a string
// in some datasets and a number in others.
func YearText(v *js.Value) string {
	if v == nil {
		return ""
	}
	return v.Raw()
}

// yearNumber mirrors `Number(year) || null`: a numeric string becomes a number,
// anything unparseable — and zero — becomes null.
func yearNumber(v *js.Value) *js.Value {
	text := strings.TrimSpace(YearText(v))
	if text == "" {
		return js.Null()
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil || n == 0 || math.IsNaN(n) || math.IsInf(n, 0) {
		return js.Null()
	}
	if n == math.Trunc(n) {
		return js.Int(int(n))
	}
	return js.Literal(strconv.FormatFloat(n, 'g', -1, 64))
}
