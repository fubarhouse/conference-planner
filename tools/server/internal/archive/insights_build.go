package archive

// A Go port of buildInsights() from lib/archiveInsights.js — the Archive
// Observatory payload.
//
// Aggregates the whole 19-year archive into viz-ready stats: events and
// sessions per year and per series, speakers and sponsors with the years they
// appeared, tier mix, community credits, topic trends, and per-event provenance.
// Curation aliases are applied, so tallies get CLEANER as identities are
// reconciled — the payoff loop for the Curation Studio.
//
// This is the largest single thing ported, and its shape is entirely dictated by
// what the client reads. Insertion order, absent-versus-null, and the exact sort
// comparators are all part of the contract; the differential test compares the
// whole payload byte for byte.

import (
	"math"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/js"
	"sort"
	"strconv"
)

const (
	yearMin = 2007
	yearMax = 2026
)

// yearTotals is one row of the per-year and per-series tallies.
// yearTotals is one year's column in the Observatory's timeline.
//
// events/sessions/minutes describe how much CONFERENCE there was. The three
// after them describe how much of it the archive actually holds, which is a
// different question and the one the homepage charts answer: a year with 200
// sessions and no descriptions is a worse record than one with 50 and all of
// them.
type yearTotals struct {
	events, sessions, minutes int
	// videos counts session-level recordings, not events that have any — the
	// question is how many talks can still be watched.
	videos int
	// described counts programme items carrying a full_description.
	described int
	// albums counts EVENTS with a photo album, since an album is per event.
	albums int
}

func itoa(n int) string { return strconv.Itoa(n) }

// Placeholder "speakers" — not real people, so they stay out of the tallies.
var placeholderSpeaker = regexp.MustCompile(`(?i)^(tba|tbd|to be (announced|confirmed|determined)|n/?a|unknown)$`)

// tierOrder is the sponsor ladder. Anything unrecognised sorts after all of it.
var tierOrder = []string{"Platinum", "Diamond", "Gold", "Silver", "Bronze"}

// titleYear is one session as the topic engine sees it.
type titleYear struct {
	Text                    string
	Year                    int
	Series, Region, Country string
	Described               bool
	// Which event this came from. The topic engine does not care, but the
	// register measure is a rate PER EVENT — pooling a year's text lets one
	// large DrupalCon speak for the year — so it needs the grouping key.
	File string
}

// counter is an insertion-ordered string→int tally, because the JSON objects
// these become preserve the order keys were first seen in.
type counter struct {
	order  []string
	counts map[string]int
}

func newCounter() *counter { return &counter{counts: map[string]int{}} }

func (c *counter) add(key string, n int) {
	if _, seen := c.counts[key]; !seen {
		c.order = append(c.order, key)
	}
	c.counts[key] += n
}

// eventRef is one appearance of a speaker, sponsor or organiser at one event.
type eventRef struct {
	file  string
	value *js.Value
	year  int
	// Speaker rows accumulate as more of their sessions are seen.
	n       int
	minutes int
	lengths *counter
	talks   []string
}

// personRecord is a speaker or an organiser across the whole archive.
type personRecord struct {
	name, username, role string
	appearances          int
	years                []int
	yearSeen             map[int]bool
	order                []string // event files, in first-seen order
	events               map[string]*eventRef
}

func newPersonRecord() *personRecord {
	return &personRecord{yearSeen: map[int]bool{}, events: map[string]*eventRef{}}
}

func (p *personRecord) addYear(year int) {
	if year != 0 && !p.yearSeen[year] {
		p.yearSeen[year] = true
		p.years = append(p.years, year)
	}
}

func (p *personRecord) ref(file string, build func() *eventRef) *eventRef {
	if existing, seen := p.events[file]; seen {
		return existing
	}
	created := build()
	p.events[file] = created
	p.order = append(p.order, file)
	return created
}

// detail renders a record's per-event rows, sorted by year — a stable sort, so
// events sharing a year keep the order they were read in.
func (p *personRecord) detail() *js.Value {
	refs := make([]*eventRef, 0, len(p.order))
	for _, file := range p.order {
		refs = append(refs, p.events[file])
	}
	sort.SliceStable(refs, func(i, j int) bool { return refs[i].year < refs[j].year })
	out := js.Arr()
	for _, ref := range refs {
		out.Append(ref.value)
	}
	return out
}

func (p *personRecord) sortedYears() *js.Value {
	// [...set].sort() with no comparator: JavaScript sorts numbers AS STRINGS.
	// Four-digit years compare the same either way, which is the only reason
	// this is safe — and the reason it is worth a comment rather than a guess.
	years := append([]int(nil), p.years...)
	sort.Slice(years, func(i, j int) bool { return itoa(years[i]) < itoa(years[j]) })
	out := js.Arr()
	for _, year := range years {
		out.Append(js.Int(year))
	}
	return out
}

// BuildInsights reads the whole archive and returns the Observatory payload.
func BuildInsights(dataDir string, aliases, seriesOf *js.Value) (*js.Value, error) {
	catalogRaw, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return nil, err
	}
	catalog, err := js.ParseJSON(catalogRaw)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, entry := range catalog.Get("events").Items() {
		if file := entry.Get("file").Str(); file != "" {
			files = append(files, file)
		}
	}

	// Curation aliases apply to the DISPLAY name. The datasets are never
	// rewritten; this is a read-time mapping keyed by fingerprint.
	canon := func(name string) string {
		if mapped := aliases.Get(Fingerprint(name)); mapped.Exists() && mapped.Str() != "" {
			return mapped.Str()
		}
		return name
	}

	geo := js.Obj()
	if raw, err := os.ReadFile(filepath.Join(dataDir, "geocache.json")); err == nil {
		if parsed, err := js.ParseJSON(raw); err == nil {
			geo = parsed
		}
	}

	perYear := map[int]*yearTotals{}
	perSeriesOrder := []string{}
	perSeries := map[string]*yearTotals{}
	speakers := map[string]*personRecord{}
	speakerOrder := []string{}
	sponsors := map[string]*personRecord{}
	sponsorOrder := []string{}
	sponsorTiers := map[string]map[string]bool{}
	sponsorTierOrder := map[string][]string{}
	tiers := newCounter()
	regions := newCounter()
	regionSet := map[string]bool{}
	countrySet := map[string]bool{}
	var countryOrder []string
	yearEvents := map[int]*js.Value{}
	var yearEventOrder []int
	seriesEvents := js.Obj()
	var titleYears []titleYear
	credits := map[string]*personRecord{}
	var creditOrder []string

	sessions, workshops, socials, minutes, sponsorSlots := 0, 0, 0, 0, 0
	coverageSum, coverageN, creditedEvents := 0, 0, 0

	bumpYear := func(year int, field string, n int) {
		if year == 0 {
			return
		}
		row, seen := perYear[year]
		if !seen {
			row = &yearTotals{}
			perYear[year] = row
		}
		switch field {
		case "events":
			row.events += n
		case "sessions":
			row.sessions += n
		case "minutes":
			row.minutes += n
		case "videos":
			row.videos += n
		case "described":
			row.described += n
		case "albums":
			row.albums += n
		}
	}

	for _, file := range files {
		raw, err := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(file)))
		if err != nil {
			continue
		}
		data, err := js.ParseJSON(raw)
		if err != nil {
			continue
		}
		event := data.Get("event")
		if event == nil {
			event = js.Obj()
		}

		year := jsNumberOrZero(event.Get("year").StrVal())
		// An event's SERIES is what it belongs to, which is not always what it
		// was called: two DrupalSouth editions were marketed as Drupal Down
		// Under. The mapping is per event and lives in the curation ledger, so
		// datasets stay byte-identical.
		series := seriesOf.Get(file).Str()
		if series == "" {
			series = event.Get("designation").StrVal()
		}
		if series == "" {
			series = "Other"
		}
		label := JoinNonEmpty(" ",
			event.Get("designation").Str(), event.Get("location").Str(), YearText(event.Get("year")))
		if label == "" {
			label = file
		}
		community := event.Get("community").Get("people").Items()
		if len(community) > 0 {
			creditedEvents++
		}
		coords := CoordsFor(event, geo)
		region := RegionOf(event)
		country := event.Get("country").StrVal()
		if country == "" {
			country = DeriveCountry(event.Get("region").Str(),
				geo.Get(event.Get("location").StrVal()).Get("display").Str())
		}

		album := StrOrNull(event.Get("flickr").Get("groupUrl").StrVal())
		albumProvider := StrOrNull(event.Get("flickr").Get("provider").StrVal())
		startDate := StrOrNull(event.Get("startDate").StrVal())

		for _, person := range community {
			username := person.Get("username").StrVal()
			if username == "" {
				continue
			}
			role := "organiser"
			if person.Get("role").Str() == "volunteer" {
				role = "volunteer"
			}
			key := role + ":" + username
			record, seen := credits[key]
			if !seen {
				record = newPersonRecord()
				record.username = username
				record.role = role
				record.name = username
				if name := person.Get("name").StrVal(); name != "" {
					record.name = name
				}
				credits[key] = record
				creditOrder = append(creditOrder, key)
			}
			if person.Get("name").Exists() && record.name == username {
				record.name = person.Get("name").StrVal()
			}
			// The username is untouched: it is the identity and the URL.
			record.name = canon(record.name)
			record.addYear(year)
			record.ref(file, func() *eventRef {
				row := js.Obj().
					Set("label", js.Str(label)).
					Set("year", intOrNull(year)).
					Set("series", js.Str(series)).
					Set("region", js.Str(region)).
					Set("country", js.Str(country)).
					Set("file", js.Str(file)).
					Set("album", album).
					Set("albumProvider", albumProvider).
					Set("startDate", startDate)
				addCoords(row, coords)
				return &eventRef{file: file, value: row, year: year}
			})
		}

		if region != "" {
			regionSet[region] = true
		}
		if country != "" && !countrySet[country] {
			countrySet[country] = true
			countryOrder = append(countryOrder, country)
		}

		allItems := data.Get("items").Items()
		var items []*js.Value
		for _, item := range allItems {
			if CountsAsSession(item) {
				items = append(items, item)
			}
		}
		sessions += len(items)
		// The mix inside the programme. Workshops are part of `sessions`;
		// socials sit outside it, which is why they are counted separately.
		for _, item := range items {
			if ItemKind(item) == "workshop" {
				workshops++
			}
		}
		for _, item := range allItems {
			if ItemKind(item) == "social" && !item.Get("cancelled").IsTrue() {
				socials++
			}
		}

		eventMinutes := 0
		eventLengths := newCounter()
		for _, item := range items {
			itemMinutes := SessionMinutes(item)
			eventMinutes += itemMinutes
			if bucket := LengthBucket(itemMinutes); bucket != "" {
				eventLengths.add(bucket, 1)
			}
		}
		minutes += eventMinutes

		bumpYear(year, "events", 1)
		bumpYear(year, "sessions", len(items))
		bumpYear(year, "minutes", eventMinutes)

		// How much of the programme survives as something you can read or watch.
		// Counted over `items` — the programme — so agenda rows and socials do
		// not flatter the ratio by being trivially undescribed.
		videos, described := 0, 0
		for _, item := range items {
			if item.Get("video_url").Text() {
				videos++
			}
			if item.Get("full_description").Text() {
				described++
			}
		}
		bumpYear(year, "videos", videos)
		bumpYear(year, "described", described)
		// One album per event, not per session: `album` is the event's own
		// flickr.groupUrl, which is what the Photo albums view lists.
		if album.Has() {
			bumpYear(year, "albums", 1)
		}

		if _, seen := perSeries[series]; !seen {
			perSeries[series] = &yearTotals{}
			perSeriesOrder = append(perSeriesOrder, series)
		}
		perSeries[series].events++
		perSeries[series].sessions += len(items)

		if event.Get("region").Has() {
			regions.add(event.Get("region").StrVal(), 1)
		}

		if year != 0 {
			list, seen := yearEvents[year]
			if !seen {
				list = js.Arr()
				yearEvents[year] = list
				yearEventOrder = append(yearEventOrder, year)
			}
			row := js.Obj().
				Set("label", js.Str(label)).
				Set("series", js.Str(series)).
				Set("region", js.Str(region)).
				Set("country", js.Str(country)).
				Set("sessions", js.Int(len(items))).
				Set("minutes", js.Int(eventMinutes)).
				// Per event, not just per year, so "What survives" answers under a
				// facet too. The year totals cannot be re-derived once a series or
				// region filter is applied — only the event rows can.
				Set("videos", js.Int(videos)).
				Set("described", js.Int(described)).
				Set("lengths", eventLengths.value()).
				// Only when the organisers reported one. An absent figure has to
				// stay absent all the way to the chart, so coverage can be
				// stated instead of a missing event quietly reading as a
				// zero-attendance one.
				Set("attendance", numberOrNull(event.Get("attendance").Get("count"))).
				Set("file", js.Str(file)).
				Set("album", album).
				Set("albumProvider", albumProvider).
				Set("startDate", startDate).
				Set("sources", ProvenanceSummary(data))
			addCoords(row, coords)
			list.Append(row)
		}

		seriesRow := js.Obj().
			Set("label", js.Str(label)).
			Set("year", intOrNull(year)).
			Set("region", js.Str(region)).
			Set("country", js.Str(country)).
			Set("location", js.Str(event.Get("location").StrVal())).
			Set("sessions", js.Int(len(items)))
		addCoords(seriesRow, coords)
		if existing := seriesEvents.Get(series); existing.Exists() {
			existing.Append(seriesRow)
		} else {
			seriesEvents.Set(series, js.Arr(seriesRow))
		}

		// Rough coverage (mirrors the audit's spirit): meta presence.
		metaHit := 0
		for _, field := range []string{"logo", "venue", "location", "region", "website", "timezone"} {
			if field == "logo" {
				logo := event.Get("logo")
				if logo.Get("image").Text() || logo.Get("faIcon").Text() {
					metaHit++
				}
				continue
			}
			if event.Get(field).Has() {
				metaHit++
			}
		}
		coverageSum += int(math.Round(100 * float64(metaHit) / 6))
		coverageN++

		for _, session := range items {
			if year != 0 && session.Get("title").Has() {
				titleYears = append(titleYears, titleYear{
					Text:    session.Get("title").StrVal() + " " + session.Get("full_description").StrVal(),
					Year:    year,
					Series:  series,
					Region:  region,
					Country: country,
					// Whether this session brought a description with it. A
					// title-only session can still match a keyword but offers
					// far less surface, so a year where half the programme has
					// no description under-reports every topic.
					Described: session.Get("full_description").Has(),
					File:      file,
				})
			}
			for _, speaker := range session.Get("speakers").Items() {
				rawName := speaker.StrVal()
				if !speaker.IsString() {
					rawName = speaker.Get("name").StrVal()
				}
				if rawName == "" || placeholderSpeaker.MatchString(rawName) {
					continue
				}
				name := canon(rawName)
				record, seen := speakers[name]
				if !seen {
					record = newPersonRecord()
					record.name = name
					speakers[name] = record
					speakerOrder = append(speakerOrder, name)
				}
				record.appearances++
				record.addYear(year)
				ref := record.ref(file, func() *eventRef {
					row := js.Obj().
						Set("label", js.Str(label)).
						Set("year", intOrNull(year)).
						Set("series", js.Str(series)).
						Set("region", js.Str(region)).
						Set("country", js.Str(country)).
						Set("file", js.Str(file)).
						Set("n", js.Int(0)).
						Set("minutes", js.Int(0)).
						Set("lengths", js.Obj()).
						Set("talks", js.Arr())
					addCoords(row, coords)
					return &eventRef{file: file, value: row, year: year, lengths: newCounter()}
				})
				ref.n++
				// Minutes THIS speaker stood up for, so the client can ask how
				// long a slot a first-time speaker gets compared with someone
				// who has spoken before.
				sessionLength := SessionMinutes(session)
				ref.minutes += sessionLength
				if bucket := LengthBucket(sessionLength); bucket != "" {
					ref.lengths.add(bucket, 1)
				}
				if session.Get("title").Has() {
					ref.talks = append(ref.talks, session.Get("title").StrVal())
				}
				ref.value.Set("n", js.Int(ref.n))
				ref.value.Set("minutes", js.Int(ref.minutes))
				ref.value.Set("lengths", ref.lengths.value())
				talks := js.Arr()
				for _, talk := range ref.talks {
					talks.Append(js.Str(talk))
				}
				ref.value.Set("talks", talks)
			}
		}

		for _, sponsor := range event.Get("sponsors").Items() {
			title := sponsor.Get("title").StrVal()
			if title == "" {
				title = sponsor.Get("id").StrVal()
			}
			if title == "" {
				title = "sponsor"
			}
			title = canon(title)
			sponsorSlots++
			record, seen := sponsors[title]
			if !seen {
				record = newPersonRecord()
				record.name = title
				sponsors[title] = record
				sponsorOrder = append(sponsorOrder, title)
				sponsorTiers[title] = map[string]bool{}
			}
			record.addYear(year)
			record.ref(file, func() *eventRef {
				row := js.Obj().
					Set("label", js.Str(label)).
					Set("year", intOrNull(year)).
					Set("series", js.Str(series)).
					Set("region", js.Str(region)).
					Set("country", js.Str(country)).
					Set("tier", js.Str(sponsor.Get("tier").StrVal()))
				addCoords(row, coords)
				return &eventRef{file: file, value: row, year: year}
			})
			if sponsor.Get("tier").Has() {
				tier := sponsor.Get("tier").StrVal()
				if !sponsorTiers[title][tier] {
					sponsorTiers[title][tier] = true
					sponsorTierOrder[title] = append(sponsorTierOrder[title], tier)
				}
				tiers.add(tier, 1)
			}
		}
	}

	// ── The payload ─────────────────────────────────────────────────────────

	years := js.Arr()
	for year := yearMin; year <= yearMax; year++ {
		row := perYear[year]
		if row == nil {
			row = &yearTotals{}
		}
		years.Append(js.Obj().
			Set("year", js.Int(year)).
			Set("events", js.Int(row.events)).
			Set("sessions", js.Int(row.sessions)).
			Set("minutes", js.Int(row.minutes)).
			Set("videos", js.Int(row.videos)).
			Set("described", js.Int(row.described)).
			Set("albums", js.Int(row.albums)))
	}

	speakerList := js.Arr()
	sortedSpeakers := append([]string(nil), speakerOrder...)
	sort.SliceStable(sortedSpeakers, func(i, j int) bool {
		a, b := speakers[sortedSpeakers[i]], speakers[sortedSpeakers[j]]
		if a.appearances != b.appearances {
			return a.appearances > b.appearances
		}
		return len(a.events) > len(b.events)
	})
	for _, name := range sortedSpeakers {
		record := speakers[name]
		speakerList.Append(js.Obj().
			Set("name", js.Str(record.name)).
			Set("appearances", js.Int(record.appearances)).
			Set("events", js.Int(len(record.events))).
			Set("years", record.sortedYears()).
			Set("detail", record.detail()))
	}

	sponsorList := js.Arr()
	sortedSponsors := append([]string(nil), sponsorOrder...)
	sort.SliceStable(sortedSponsors, func(i, j int) bool {
		return len(sponsors[sortedSponsors[i]].events) > len(sponsors[sortedSponsors[j]].events)
	})
	for _, title := range sortedSponsors {
		record := sponsors[title]
		tierList := js.Arr()
		for _, tier := range sponsorTierOrder[title] {
			tierList.Append(js.Str(tier))
		}
		sponsorList.Append(js.Obj().
			Set("title", js.Str(record.name)).
			Set("events", js.Int(len(record.events))).
			Set("years", record.sortedYears()).
			Set("tiers", tierList).
			Set("detail", record.detail()))
	}

	rank := func(tier string) int {
		for i, known := range tierOrder {
			if known == tier {
				return i
			}
		}
		return 99
	}
	tierRows := append([]string(nil), tiers.order...)
	sort.SliceStable(tierRows, func(i, j int) bool {
		a, b := rank(tierRows[i]), rank(tierRows[j])
		if a != b {
			return a < b
		}
		return tiers.counts[tierRows[i]] > tiers.counts[tierRows[j]]
	})
	tierValue := js.Arr()
	for _, tier := range tierRows {
		tierValue.Append(js.Obj().Set("tier", js.Str(tier)).Set("count", js.Int(tiers.counts[tier])))
	}

	seriesRows := append([]string(nil), perSeriesOrder...)
	sort.SliceStable(seriesRows, func(i, j int) bool {
		return perSeries[seriesRows[i]].events > perSeries[seriesRows[j]].events
	})
	seriesValue := js.Arr()
	for _, name := range seriesRows {
		seriesValue.Append(js.Obj().
			Set("name", js.Str(name)).
			Set("events", js.Int(perSeries[name].events)).
			Set("sessions", js.Int(perSeries[name].sessions)))
	}

	creditRows := append([]string(nil), creditOrder...)
	sort.SliceStable(creditRows, func(i, j int) bool {
		a, b := credits[creditRows[i]], credits[creditRows[j]]
		if len(a.events) != len(b.events) {
			return len(a.events) > len(b.events)
		}
		return js.LocaleCompare(a.name, b.name)
	})
	creditPeople := js.Arr()
	for _, key := range creditRows {
		record := credits[key]
		creditPeople.Append(js.Obj().
			Set("username", js.Str(record.username)).
			Set("name", js.Str(record.name)).
			Set("role", js.Str(record.role)).
			Set("events", js.Int(len(record.events))).
			Set("years", record.sortedYears()).
			Set("detail", record.detail()))
	}

	regionRows := append([]string(nil), regions.order...)
	sort.SliceStable(regionRows, func(i, j int) bool {
		return regions.counts[regionRows[i]] > regions.counts[regionRows[j]]
	})
	regionValue := js.Arr()
	for _, name := range regionRows {
		regionValue.Append(js.Obj().Set("name", js.Str(name)).Set("count", js.Int(regions.counts[name])))
	}

	facetRegions := js.Arr()
	for _, code := range RegionCodes {
		if regionSet[code] {
			facetRegions.Append(js.Str(code))
		}
	}
	sortedCountries := append([]string(nil), countryOrder...)
	sort.SliceStable(sortedCountries, func(i, j int) bool {
		return js.LocaleCompare(sortedCountries[i], sortedCountries[j])
	})
	facetCountries := js.Arr()
	for _, country := range sortedCountries {
		facetCountries.Append(js.Str(country))
	}

	lengthBucketValue := js.Arr()
	for _, bucket := range LengthBuckets {
		row := js.Obj().Set("key", js.Str(bucket.Key)).Set("label", js.Str(bucket.Label))
		// JSON.stringify(Infinity) is null, and the client reads this list.
		if bucket.Max == noMax {
			row.Set("max", js.Null())
		} else {
			row.Set("max", js.Int(bucket.Max))
		}
		lengthBucketValue.Append(row)
	}

	yearEventsValue := js.Obj()
	for _, year := range yearEventOrder {
		yearEventsValue.Set(itoa(year), yearEvents[year])
	}

	coverage := 0
	if coverageN > 0 {
		coverage = int(math.Round(float64(coverageSum) / float64(coverageN)))
	}

	payload := js.Obj().
		Set("stats", js.Obj().
			Set("events", js.Int(len(files))).
			Set("series", js.Int(len(perSeries))).
			Set("yearMin", js.Int(yearMin)).
			Set("yearMax", js.Int(yearMax)).
			Set("sessions", js.Int(sessions)).
			Set("workshops", js.Int(workshops)).
			Set("socials", js.Int(socials)).
			Set("minutes", js.Int(minutes)).
			Set("speakers", js.Int(len(speakers))).
			Set("sponsors", js.Int(len(sponsors))).
			Set("sponsorSlots", js.Int(sponsorSlots)).
			Set("coverage", js.Int(coverage))).
		Set("years", years).
		// Shipped with the data so the chart's labels and the tallies behind
		// them cannot drift: one definition, in the file that does the bucketing.
		Set("lengthBuckets", lengthBucketValue).
		Set("series", seriesValue).
		Set("tiers", tierValue).
		// `coverage` is deliberately reported: credits exist for a handful of
		// events so far, and a bare ranking would imply the rest had nobody
		// running them.
		Set("credits", js.Obj().
			Set("coverage", js.Obj().
				Set("withCredits", js.Int(creditedEvents)).
				Set("events", js.Int(len(files)))).
			Set("people", creditPeople)).
		Set("regions", regionValue).
		Set("facetRegions", facetRegions).
		Set("facetCountries", facetCountries).
		Set("speakers", speakerList).
		Set("sponsors", sponsorList)

	addTopicsPayload(payload, titleYears, perSeries, perSeriesOrder)
	addRegisterPayload(payload, titleYears)

	payload.Set("yearEvents", yearEventsValue)
	payload.Set("seriesEvents", seriesEvents)
	return payload, nil
}

// addTopicsPayload appends topic trends overall and per series, plus the
// ordered series list for the filter. EVERY series is included, with no
// session-count threshold, so no conference is ever excluded from the chart or
// its scope dropdown.
func addTopicsPayload(payload *js.Value, titleYears []titleYear, perSeries map[string]*yearTotals, order []string) {
	// A deep vocabulary, not just the top handful, so the chart's "add a
	// keyword" typeahead can plot any reasonably common term per scope.
	const vocabDepth = 150

	toSessions := func(rows []titleYear) []TopicSession {
		out := make([]TopicSession, 0, len(rows))
		for _, row := range rows {
			out = append(out, TopicSession{Text: row.Text, Year: row.Year})
		}
		return out
	}

	all := BuildTopics(toSessions(titleYears), vocabDepth)

	seriesList := append([]string(nil), order...)
	sort.SliceStable(seriesList, func(i, j int) bool {
		return perSeries[seriesList[i]].sessions > perSeries[seriesList[j]].sessions
	})

	topicsBySeries := js.Obj().Set("All", topicsValue(all))
	for _, name := range seriesList {
		var scoped []titleYear
		for _, row := range titleYears {
			if row.Series == name {
				scoped = append(scoped, row)
			}
		}
		topicsBySeries.Set(name, topicsValue(BuildTopics(toSessions(scoped), vocabDepth)))
	}

	// Titled-sessions-per-year per scope — the denominator for the chart's
	// "share %", so a series' trend is measured against ITS OWN sessions.
	sessBy := js.Obj().Set("All", js.Obj())
	for _, name := range seriesList {
		sessBy.Set(name, js.Obj())
	}
	bump := func(scope *js.Value, year int) {
		key := itoa(year)
		current := 0
		if existing := scope.Get(key); existing.Exists() {
			current = IntOf(existing)
		}
		scope.Set(key, js.Int(current+1))
	}
	for _, row := range titleYears {
		bump(sessBy.Get("All"), row.Year)
		if scope := sessBy.Get(row.Series); scope.Exists() {
			bump(scope, row.Year)
		}
	}

	// Words and phrases. Bigrams are counted separately because they are an
	// order of magnitude rarer than unigrams — ranked together they would never
	// survive a shared top-N cut, and the phrases are exactly what makes the
	// vocabulary interesting.
	var vocab []string
	for _, topic := range BuildTopics(toSessions(titleYears), 400) {
		vocab = append(vocab, topic.Term)
	}

	pairs := newCounter()
	for _, row := range titleYears {
		if row.Year == 0 {
			continue
		}
		for _, bigram := range TitleBigrams(row.Text) {
			pairs.add(bigram, 1)
		}
	}
	var phrases []string
	for _, pair := range pairs.order {
		// A pair seen four times is a coincidence, not a topic.
		if pairs.counts[pair] >= 5 {
			phrases = append(phrases, pair)
		}
	}
	sort.SliceStable(phrases, func(i, j int) bool {
		return pairs.counts[phrases[i]] > pairs.counts[phrases[j]]
	})
	// 400 keeps genuinely specific phrases in reach — the vocabulary is only an
	// index of ints per session, so a longer tail costs little.
	if len(phrases) > 400 {
		phrases = phrases[:400]
	}
	vocab = append(vocab, phrases...)

	index := map[string]int{}
	for i, term := range vocab {
		index[term] = i
	}

	topicSessions := js.Arr()
	for _, row := range titleYears {
		if row.Year == 0 {
			continue
		}
		terms := js.Arr()
		for _, token := range append(TitleTokens(row.Text), TitleBigrams(row.Text)...) {
			if i, ok := index[token]; ok {
				terms.Append(js.Int(i))
			}
		}
		// [year, series, region, country, termIndices, described] — positional
		// to keep the payload small.
		topicSessions.Append(js.Arr(
			js.Int(row.Year), js.Str(row.Series), js.Str(row.Region), js.Str(row.Country),
			terms, js.Int(boolToInt(row.Described))))
	}

	vocabValue := js.Arr()
	for _, term := range vocab {
		vocabValue.Append(js.Str(term))
	}
	topicSeries := js.Arr(js.Str("All"))
	for _, name := range seriesList {
		topicSeries.Append(js.Str(name))
	}

	payload.
		Set("topics", topicsValue(all)).
		Set("topicsBySeries", topicsBySeries).
		Set("topicSeries", topicSeries).
		Set("topicSessionsByYear", sessBy).
		Set("topicVocab", vocabValue).
		Set("topicSessions", topicSessions)
}

// addRegisterPayload emits one row per EVENT that brought enough readable
// English text to carry a rate — see register.go for what this measures and the
// three controls it survived.
//
// Rows are per event rather than per year because the client re-aggregates them
// under the series/region/country facets, exactly as it does with topicSessions,
// and because the year figure is a median ACROSS events: pooling a year's words
// would let one large event speak for a whole year.
func addRegisterPayload(payload *js.Value, titleYears []titleYear) {
	type eventText struct {
		year                    int
		series, region, country string
		tally                   *RegisterTally
	}
	byFile := map[string]*eventText{}
	var order []string // first-seen order, so the payload is deterministic
	for _, row := range titleYears {
		if row.Year == 0 || row.File == "" {
			continue
		}
		ev, seen := byFile[row.File]
		if !seen {
			ev = &eventText{year: row.Year, series: row.Series, region: row.Region,
				country: row.Country, tally: newRegisterTally()}
			byFile[row.File] = ev
			order = append(order, row.File)
		}
		ev.tally.Add(row.Text)
	}

	lexicons := js.Arr()
	for _, lex := range RegisterLexicons {
		lexicons.Append(js.Obj().
			Set("key", js.Str(lex.Key)).
			Set("label", js.Str(lex.Label)).
			Set("note", js.Str(lex.Note)))
	}

	events := js.Arr()
	for _, file := range order {
		ev := byFile[file]
		if !ev.tally.Enough() {
			continue
		}
		counts := js.Arr()
		for _, n := range ev.tally.Counts {
			counts.Append(js.Int(n))
		}
		// [year, series, region, country, words, docs, counts] — positional, to
		// keep the payload small, like topicSessions.
		events.Append(js.Arr(
			js.Int(ev.year), js.Str(ev.series), js.Str(ev.region), js.Str(ev.country),
			js.Int(ev.tally.Words), js.Int(ev.tally.Docs), counts))
	}

	payload.
		Set("registerLexicons", lexicons).
		Set("registerEvents", events)
}

func topicsValue(topics []Topic) *js.Value {
	out := js.Arr()
	for _, topic := range topics {
		byYear := js.Obj()
		for _, year := range topic.YearOrder {
			byYear.Set(itoa(year), js.Int(topic.ByYear[year]))
		}
		out.Append(js.Obj().
			Set("term", js.Str(topic.Term)).
			Set("total", js.Int(topic.Total)).
			Set("byYear", byYear))
	}
	return out
}

// value renders an insertion-ordered tally as a JSON object.
func (c *counter) value() *js.Value {
	out := js.Obj()
	for _, key := range c.order {
		out.Set(key, js.Int(c.counts[key]))
	}
	return out
}

// addCoords attaches lat/lon only when the event has them. `lat: undefined` is
// omitted entirely by JSON.stringify, and the client tells "no coordinates"
// from "coordinates of zero" by the key's absence.
func addCoords(row *js.Value, coords *Coords) {
	if coords == nil {
		return
	}
	row.Set("lat", number(coords.Lat)).Set("lon", number(coords.Lon))
}

func number(f float64) *js.Value {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return js.Int(int(f))
	}
	return js.Literal(strconv.FormatFloat(f, 'f', -1, 64))
}

func intOrNull(n int) *js.Value {
	if n == 0 {
		return js.Null()
	}
	return js.Int(n)
}

func numberOrNull(v *js.Value) *js.Value {
	if n, ok := v.Number(); ok {
		return number(n)
	}
	return js.Null()
}
