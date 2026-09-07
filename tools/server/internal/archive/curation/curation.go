package curation

// A Go port of the cluster engine in lib/archiveAudit.js — the identity
// reconciliation desk.
//
// It scans the whole archive for speaker and sponsor names that FINGERPRINT the
// same but are spelled differently, and presents each cluster with enough
// context — which events, which years, which talks, which tiers — for a person
// to judge whether it is really one entity.
//
// Identity reconciliation is MAPPING ONLY. A merge records an alias; it never
// rewrites a dataset. The programmes are preserved verbatim, which is the
// project's founding goal, and the alias is applied at read time. That is why
// this file has no write path: recording a decision is the server's job.

import (
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/js"
	"sort"
	"strings"
)

// nameVariant is one spelling of one entity, and where it appears.
type nameVariant struct {
	name       string
	count      int
	ids        []string
	idSeen     map[string]bool
	eventOrder []string
	events     map[string]*js.Value
	roles      []string
	roleSeen   map[string]bool
}

// nameCluster groups the spellings that share a fingerprint.
type nameCluster struct {
	key          string
	variantOrder []string
	variants     map[string]*nameVariant
}

// nameIndex is every cluster of one kind, in first-seen order.
type nameIndex struct {
	order    []string
	clusters map[string]*nameCluster
}

func newNameIndex() *nameIndex {
	return &nameIndex{clusters: map[string]*nameCluster{}}
}

func (n *nameIndex) variant(key, name string) *nameVariant {
	cluster, seen := n.clusters[key]
	if !seen {
		cluster = &nameCluster{key: key, variants: map[string]*nameVariant{}}
		n.clusters[key] = cluster
		n.order = append(n.order, key)
	}
	variant, seen := cluster.variants[name]
	if !seen {
		variant = &nameVariant{
			name: name, events: map[string]*js.Value{},
			idSeen: map[string]bool{}, roleSeen: map[string]bool{},
		}
		cluster.variants[name] = variant
		cluster.variantOrder = append(cluster.variantOrder, name)
	}
	return variant
}

func (v *nameVariant) event(file string, build func() *js.Value) *js.Value {
	if existing, seen := v.events[file]; seen {
		return existing
	}
	created := build()
	v.events[file] = created
	v.eventOrder = append(v.eventOrder, file)
	return created
}

func (v *nameVariant) addID(id string) {
	if id != "" && !v.idSeen[id] {
		v.idSeen[id] = true
		v.ids = append(v.ids, id)
	}
}

func (v *nameVariant) addRole(role string) {
	if !v.roleSeen[role] {
		v.roleSeen[role] = true
		v.roles = append(v.roles, role)
	}
}

// ArchiveScan is everything one pass over the archive found.
type ArchiveScan struct {
	Events       []*js.Value
	Speakers     *nameIndex
	Sponsors     *nameIndex
	People       *nameIndex
	BrokenImages []*js.Value
}

// ScanArchive reads every dataset the catalog names and collects per-event
// coverage plus the raw name occurrences.
//
// Community credits are scanned but never clustered: they are keyed by
// drupal.org username, so they have no duplicate-spelling problem of their own.
// They are here because an ALIAS reaches them — a name that appears as both a
// speaker and a volunteer is exactly the case where an undo needs to show what
// it is about to un-merge.
func ScanArchive(dataDir, imgDir string) (*ArchiveScan, error) {
	catalogRaw, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return nil, err
	}
	catalog, err := js.ParseJSON(catalogRaw)
	if err != nil {
		return nil, err
	}

	scan := &ArchiveScan{
		Speakers: newNameIndex(), Sponsors: newNameIndex(), People: newNameIndex(),
		Events: nil, BrokenImages: nil,
	}

	imageExists := func(path string) bool {
		relative := strings.TrimPrefix(strings.TrimPrefix(path, "."), "/")
		if relative == "" {
			return false
		}
		_, statErr := os.Stat(filepath.Join(imgDir, filepath.FromSlash(relative)))
		return statErr == nil
	}

	for _, entry := range catalog.Get("events").Items() {
		file := entry.Get("file").Str()
		if file == "" {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(dataDir, filepath.FromSlash(file)))
		if readErr != nil {
			continue
		}
		data, parseErr := js.ParseJSON(raw)
		if parseErr != nil {
			continue
		}

		event := data.Get("event")
		if event == nil {
			event = js.Obj()
		}
		label := archive.JoinNonEmpty(" ", event.Get("designation").Str(),
			event.Get("location").Str(), archive.YearText(event.Get("year")))
		if label == "" {
			label = file
		}
		year := event.Get("year")
		yearValue := js.Str("")
		if js.Truthy(year) {
			yearValue = year
		}
		items := data.Get("items").Items()

		// Coverage: the event's own metadata, then how much detail its sessions
		// carry. Mirrors the CLI's scoring.
		metaFields := []string{"logo", "venue", "location", "dates", "region", "website", "timezone"}
		missingMeta := js.Arr()
		for _, field := range metaFields {
			present := false
			switch field {
			case "logo":
				logo := event.Get("logo")
				present = js.Truthy(logo.Get("image")) || js.Truthy(logo.Get("faIcon"))
			case "dates":
				present = event.Get("startDate").Has() && event.Get("endDate").Has()
			default:
				present = event.Get(field).Has()
			}
			if !present {
				missingMeta.Append(js.Str(field))
			}
		}

		withSpeaker, withTrack, withTime, withDescription := 0, 0, 0, 0
		for _, item := range items {
			speakers := item.Get("speakers")
			if speakers.IsArray() {
				if len(speakers.Items()) > 0 {
					withSpeaker++
				}
			} else if speakers.Has() {
				withSpeaker++
			}
			track := item.Get("track")
			if track.IsArray() {
				if len(track.Items()) > 0 {
					withTrack++
				}
			} else if track.Has() {
				withTrack++
			}
			if item.Get("startTime").Has() {
				withTime++
			}
			if item.Get("full_description").Has() || item.Get("description").Has() {
				withDescription++
			}

			// Speaker occurrences, with the talk title for context.
			for _, speaker := range item.Get("speakers").Items() {
				name := speaker.StrVal()
				if !speaker.IsString() {
					name = speaker.Get("name").StrVal()
				}
				key := archive.Fingerprint(name)
				if key == "" {
					continue
				}
				variant := scan.Speakers.variant(key, name)
				variant.count++
				row := variant.event(file, func() *js.Value {
					return js.Obj().
						Set("label", js.Str(label)).
						Set("year", yearValue).
						Set("file", js.Str(file)).
						Set("talks", js.Arr())
				})
				if title := item.Get("title"); js.Truthy(title) {
					row.Get("talks").Append(js.Str(title.StrVal()))
				}
			}
		}

		if logo := event.Get("logo").Get("image"); js.Truthy(logo) && !imageExists(logo.Str()) {
			scan.BrokenImages = append(scan.BrokenImages, js.Obj().
				Set("event", js.Str(label)).Set("kind", js.Str("logo")).
				Set("title", js.Str(label)).Set("path", js.Str(logo.Str())))
		}

		// Sponsor occurrences, with the tier and logo for context.
		for _, sponsor := range event.Get("sponsors").Items() {
			title := sponsor.Get("title").StrVal()
			if title == "" {
				title = sponsor.Get("id").StrVal()
			}
			if title == "" {
				title = "sponsor"
			}
			if image := sponsor.Get("image"); image.Has() && !imageExists(image.Str()) {
				scan.BrokenImages = append(scan.BrokenImages, js.Obj().
					Set("event", js.Str(label)).Set("kind", js.Str("sponsor")).
					Set("title", js.Str(title)).Set("path", js.Str(image.Str())))
			}
			key := archive.Fingerprint(title)
			if key == "" {
				continue
			}
			variant := scan.Sponsors.variant(key, title)
			variant.count++
			variant.addID(sponsor.Get("id").Str())
			variant.event(file, func() *js.Value {
				return js.Obj().
					Set("label", js.Str(label)).
					Set("year", yearValue).
					Set("file", js.Str(file)).
					Set("tier", js.Str(sponsor.Get("tier").StrVal())).
					Set("image", js.Str(sponsor.Get("image").StrVal()))
			})
		}

		// Community credits, with the role kept so an impact line can say WHICH
		// hat this was.
		for _, person := range event.Get("community").Get("people").Items() {
			name := person.Get("name").StrVal()
			if name == "" {
				name = person.Get("username").StrVal()
			}
			key := archive.Fingerprint(name)
			if key == "" {
				continue
			}
			variant := scan.People.variant(key, name)
			variant.count++
			role := "organiser"
			if person.Get("role").Str() == "volunteer" {
				role = "volunteer"
			}
			variant.addRole(role)
			variant.event(file, func() *js.Value {
				return js.Obj().
					Set("label", js.Str(label)).
					Set("year", yearValue).
					Set("file", js.Str(file))
			})
		}

		metaScore := float64(len(metaFields)-len(missingMeta.Items())) / float64(len(metaFields))
		sessionScore := 0.0
		if len(items) > 0 {
			sessionScore = float64(withSpeaker+withTrack+withTime+withDescription) /
				float64(4*len(items))
		}
		scan.Events = append(scan.Events, js.Obj().
			Set("file", js.Str(file)).
			Set("label", js.Str(label)).
			Set("year", yearValue).
			Set("sessions", js.Int(len(items))).
			Set("missingMeta", missingMeta).
			Set("score", js.Int(jsRound(100*(0.55*metaScore+0.45*sessionScore)))))
	}

	return scan, nil
}

// ToClusters turns a raw occurrence index into cluster objects, keeping only
// genuine clusters — more than one spelling — and applying the decisions.
//
// A recorded ALIAS resolves a cluster. The test used to be "every spelling in
// the data IS the canonical", which never becomes true: an alias is a read-time
// mapping and the datasets keep their original spellings on purpose. So a
// cluster stayed flagged after it had been decided, and the headline count could
// not go down however much curation was done — 115 merges, same 128 clusters.
func ToClusters(index *nameIndex, aliases *js.Value, distinct map[string]bool, kind string) *js.Value {
	type ranked struct {
		value    *js.Value
		variants int
		total    int
	}
	var rows []ranked

	for _, key := range index.order {
		if distinct[key] {
			continue
		}
		// Recording an alias is what "resolved" means; the decisions log is
		// where it goes to be reviewed or undone.
		if canonical := aliases.Get(key); canonical.Exists() && canonical.Str() != "" {
			continue
		}
		cluster := index.clusters[key]
		if len(cluster.variantOrder) < 2 {
			continue
		}

		type variantRow struct {
			value *js.Value
			count int
		}
		var variantRows []variantRow
		for _, name := range cluster.variantOrder {
			variant := cluster.variants[name]
			ids := js.Arr()
			for _, id := range variant.ids {
				ids.Append(js.Str(id))
			}
			events := js.Arr()
			for _, file := range variant.eventOrder {
				events.Append(variant.events[file])
			}
			variantRows = append(variantRows, variantRow{
				value: js.Obj().
					Set("name", js.Str(variant.name)).
					Set("count", js.Int(variant.count)).
					Set("ids", ids).
					Set("events", events),
				count: variant.count,
			})
		}
		sort.SliceStable(variantRows, func(i, j int) bool {
			return variantRows[i].count > variantRows[j].count
		})

		variants := js.Arr()
		total := 0
		files := map[string]bool{}
		for _, row := range variantRows {
			variants.Append(row.value)
			total += row.count
			for _, event := range row.value.Get("events").Items() {
				files[event.Get("file").Str()] = true
			}
		}

		rows = append(rows, ranked{
			value: js.Obj().
				Set("key", js.Str(key)).
				Set("kind", js.Str(kind)).
				Set("canonical", js.Str(variantRows[0].value.Get("name").Str())).
				Set("variants", variants).
				Set("eventCount", js.Int(len(files))).
				Set("total", js.Int(total)),
			variants: len(variantRows),
			total:    total,
		})
	}

	// Messiest first: most spellings, then most appearances.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].variants != rows[j].variants {
			return rows[i].variants > rows[j].variants
		}
		return rows[i].total > rows[j].total
	})

	out := js.Arr()
	for _, row := range rows {
		out.Append(row.value)
	}
	return out
}

// DecisionImpact says what a recorded decision actually covers.
//
// A log row can say `kim pepper → Kim Pepper` without saying that the mapping
// merged a conference speaker with an event volunteer. Undo is only reversible
// in the trivial sense unless you can see what you are reversing, so every row
// carries the spellings the key resolves and the weight behind them.
func DecisionImpact(scan *ArchiveScan, keys []string) *js.Value {
	out := js.Obj()
	for _, key := range keys {
		variants := js.Arr()
		seenVariant := map[string]bool{}
		files := map[string]bool{}
		roles := js.Arr()
		seenRole := map[string]bool{}
		talks, sponsorships, credits := 0, 0, 0

		take := func(index *nameIndex, add func(int)) {
			cluster, found := index.clusters[key]
			if !found {
				return
			}
			for _, name := range cluster.variantOrder {
				variant := cluster.variants[name]
				// One person can be a speaker AND a volunteer under the same
				// spelling, so the list is deduplicated across all three.
				if !seenVariant[variant.name] {
					seenVariant[variant.name] = true
					variants.Append(js.Str(variant.name))
				}
				add(variant.count)
				for _, file := range variant.eventOrder {
					files[file] = true
				}
				for _, role := range variant.roles {
					if !seenRole[role] {
						seenRole[role] = true
						roles.Append(js.Str(role))
					}
				}
			}
		}
		take(scan.Speakers, func(n int) { talks += n })
		take(scan.Sponsors, func(n int) { sponsorships += n })
		take(scan.People, func(n int) { credits += n })

		out.Set(key, js.Obj().
			Set("variants", variants).
			Set("talks", js.Int(talks)).
			Set("sponsorships", js.Int(sponsorships)).
			Set("credits", js.Int(credits)).
			Set("events", js.Int(len(files))).
			Set("roles", roles))
	}
	return out
}

// BuildCurationData is the full payload the curation desk reads.
func BuildCurationData(dataDir, imgDir string, decisions archive.Decisions, distinctKeys []string) (*js.Value, error) {
	scan, err := ScanArchive(dataDir, imgDir)
	if err != nil {
		return nil, err
	}

	distinct := map[string]bool{}
	for _, key := range distinctKeys {
		distinct[key] = true
	}

	speakerClusters := ToClusters(scan.Speakers, decisions.Aliases, distinct, "speaker")
	sponsorClusters := ToClusters(scan.Sponsors, decisions.Aliases, distinct, "sponsor")

	totalScore := 0
	for _, event := range scan.Events {
		totalScore += archive.IntOf(event.Get("score"))
	}
	divisor := len(scan.Events)
	if divisor == 0 {
		divisor = 1
	}

	brokenImages := js.Arr()
	for _, image := range scan.BrokenImages {
		brokenImages.Append(image)
	}

	// Worst first, so the desk opens on the events that need the most.
	events := append([]*js.Value(nil), scan.Events...)
	sort.SliceStable(events, func(i, j int) bool {
		return archive.IntOf(events[i].Get("score")) < archive.IntOf(events[j].Get("score"))
	})
	eventList := js.Arr()
	for _, event := range events {
		eventList.Append(event)
	}

	distinctList := js.Arr()
	for _, key := range distinctKeys {
		distinctList.Append(js.Str(key))
	}

	var impactKeys []string
	for _, key := range decisions.Aliases.Keys() {
		impactKeys = append(impactKeys, key)
	}
	impactKeys = append(impactKeys, distinctKeys...)

	return js.Obj().
		Set("stats", js.Obj().
			Set("events", js.Int(len(scan.Events))).
			Set("avgCoverage", js.Int(jsRound(float64(totalScore)/float64(divisor)))).
			Set("brokenImages", js.Int(len(scan.BrokenImages))).
			Set("speakerClusters", js.Int(len(speakerClusters.Items()))).
			Set("sponsorClusters", js.Int(len(sponsorClusters.Items())))).
		Set("speakerClusters", speakerClusters).
		Set("sponsorClusters", sponsorClusters).
		Set("brokenImages", brokenImages).
		Set("events", eventList).
		Set("decisions", js.Obj().
			Set("aliases", decisions.Aliases).
			Set("distinct", distinctList)).
		Set("impact", DecisionImpact(scan, impactKeys)), nil
}

// jsRound is Math.round: halves go UP, not away from zero. The difference only
// shows on negatives, which scores are not — but the two are not the same
// function and it is cheaper to say so than to remember.
func jsRound(value float64) int {
	return int(mathFloor(value + 0.5))
}

func mathFloor(value float64) float64 {
	truncated := float64(int64(value))
	if value < 0 && value != truncated {
		return truncated - 1
	}
	return truncated
}
