package archive

import "server/internal/js"

// A Go port of provenanceSummary() from lib/archiveInsights.js — one event's
// provenance, condensed for the archive's Sources view.
//
// Evidence and claim are reported separately because they fail independently: a
// perfect archived capture can still be backing a row it was only inferred to
// support. Collapsing them into one score hides whichever is worse, which is the
// opposite of what a transparency view is for.

// ProvenanceSummary builds the per-event provenance block carried in the
// insights payload.
func ProvenanceSummary(dataset *js.Value) *js.Value {
	sources := dataset.Get("event").Get("sources").Items()
	byID := map[string]*js.Value{}
	for _, source := range sources {
		byID[source.Get("id").Str()] = source
	}

	tiers := js.Obj()
	tierCounts := map[string]int{}
	wayback, stated, undated := 0, 0, 0
	oldestCapture := ""
	for _, source := range sources {
		tier := SourceConfidence(source)
		if _, seen := tierCounts[tier]; !seen {
			tiers.Set(tier, js.Int(0))
		}
		tierCounts[tier]++
		tiers.Set(tier, js.Int(tierCounts[tier]))

		if source.Get("via").Get("provider").Str() == "wayback" {
			wayback++
			// Note this is NOT waybackTimestampToIso: the summary slices the
			// stamp directly and does not clamp a `00` month to January. The two
			// disagree for short stamps, and reproducing the difference is the
			// job here — not fixing it.
			stamp := source.Get("via").Get("timestamp").StrVal()
			if len(stamp) >= 8 {
				iso := stamp[0:4] + "-" + stamp[4:6] + "-" + stamp[6:8]
				if oldestCapture == "" || iso < oldestCapture {
					oldestCapture = iso
				}
			}
		}
		if source.Get("via").Get("provider").Str() == "stated" {
			stated++
		}
		if !source.Get("retrievedAt").Exists() || source.Get("retrievedAt").Str() == "" {
			undated++
		}
	}

	items := dataset.Get("items").Items()
	exact, cited, uncited, agenda, ownPage, sessions := 0, 0, 0, 0, 0, 0
	for _, item := range items {
		// Lunch, registration and the closing drinks are on the schedule but
		// they are not the programme. 384 of them carry a page URL, which put
		// "Registration" in a list headed Session pages.
		if !CountsAsSession(item) {
			agenda++
			continue
		}
		sessions++
		if item.Get("link").StrVal() != "" {
			ownPage++
		}
		switch AttributionStrength(item, byID) {
		case "none":
			uncited++
		case "exact":
			cited++
			exact++
		default:
			cited++
		}
	}

	reach := SourceReach(dataset)

	// Every distinct page this event points at — the registry PLUS the addresses
	// its own records carry. The registry count alone does not compare across
	// events: one scraped from captures has a source per session while one
	// scraped live has three and keeps its session pages in items[].link.
	referenced := map[string]bool{}
	addRef := func(url string) {
		if url != "" {
			referenced[url] = true
		}
	}
	for _, source := range sources {
		addRef(source.Get("url").StrVal())
	}
	for _, item := range items {
		addRef(item.Get("link").StrVal())
		addRef(item.Get("video_url").StrVal())
	}
	event := dataset.Get("event")
	addRef(event.Get("flickr").Get("groupUrl").StrVal())
	addRef(event.Get("videoPlaylist").StrVal())

	list := js.Arr()
	for _, source := range sources {
		list.Append(js.Obj().
			Set("id", js.Str(source.Get("id").StrVal())).
			Set("kind", js.Str(source.Get("kind").StrVal())).
			Set("url", StrOrNull(source.Get("url").StrVal())).
			Set("title", StrOrNull(source.Get("title").StrVal())).
			Set("retrievedAt", StrOrNull(source.Get("retrievedAt").StrVal())).
			Set("tier", js.Str(SourceConfidence(source))).
			Set("stated", js.Bool(source.Get("via").Get("provider").Str() == "stated")).
			Set("records", js.Int(reach[source.Get("id").StrVal()])))
	}

	return js.Obj().
		Set("count", js.Int(len(sources))).
		Set("references", js.Int(len(referenced))).
		Set("tiers", tiers).
		Set("wayback", js.Int(wayback)).
		Set("stated", js.Int(stated)).
		Set("undated", js.Int(undated)).
		Set("oldestCapture", StrOrNull(oldestCapture)).
		Set("exact", js.Int(exact)).
		Set("cited", js.Int(cited)).
		Set("uncited", js.Int(uncited)).
		Set("ownPage", js.Int(ownPage)).
		Set("sessions", js.Int(sessions)).
		Set("agenda", js.Int(agenda)).
		// How many sponsors this page vouches for. A sponsor's OWN website is
		// not provenance — it is the sponsor, and half of them are dead or
		// repointed by now.
		Set("sponsorCount", js.Int(len(event.Get("sponsors").Items()))).
		Set("list", list)
}

func StrOrNull(s string) *js.Value {
	if js.Trim(s) == "" {
		return js.Null()
	}
	return js.Str(s)
}
