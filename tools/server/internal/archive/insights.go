package archive

// A Go port of the classification half of lib/archiveInsights.js — the rules
// that turn a programme into a vocabulary, a place and a shape.
//
// These are the Observatory's units of measurement: which words count as
// topics, which macro-region an event belongs to, which country, and how long a
// session was. Scripts depend on them too (backfill-regions, geocode-events),
// so they are the part of archiveInsights.js with the widest blast radius and
// the smallest surface.
//
// The aggregation half — buildInsights, coSpeakers, searchTopic — is NOT here.
// It canonicalises names through fingerprint(), which needs NFKD normalisation
// that Go's standard library does not have. See docs/go-port.md, slice 4b.
//
// The stopword and noise lists below were generated from the JavaScript source
// rather than retyped: a single transcribed word would silently change the
// archive's topic vocabulary, and a diff of 270 words is not something a review
// catches.

import (
	"regexp"
	"server/internal/js"
	"sort"
	"strconv"
	"strings"
)

// Words that carry no topic signal — generic English plus Drupal-conference
// noise ("drupal"/"session" are in every title, so they would swamp the real
// trends), plus agenda filler and common prose words (descriptions are full
// sentences, so this needs to be heavier than titles alone would want).
var stopwords = words(
	"the", "a", "an", "and", "or", "of", "to", "for", "with", "your", "you", "our", "we",
	"it", "is", "are", "be", "in", "on", "at", "by", "from", "as", "how", "what", "why",
	"when", "who", "yours", "this", "that", "these", "those", "into", "out", "up", "down",
	"over", "under", "via", "using", "use", "used", "get", "getting", "make", "making",
	"build", "building", "do", "does", "doing", "let", "lets", "new", "all", "more", "most",
	"best", "good", "great", "better", "than", "then", "them", "they", "i", "my", "me", "us",
	"not", "no", "yes", "can", "will", "just", "like", "about", "across", "through", "within",
	"between", "one", "two", "three", "first", "drupal", "drupalcon", "drupalcamp", "drupals",
	"session", "sessions", "talk", "talks", "keynote", "workshop", "bof", "intro",
	"introduction", "guide", "overview", "part", "vol", "case", "study", "panel", "qa",
	"live", "demo", "lightning", "break", "lunch", "coffee", "tea", "breakfast", "dinner",
	"drinks", "registration", "opening", "closing", "welcome", "networking", "social",
	"party", "sprint", "sprints", "reception", "keynotes", "prenote", "prenotes", "sponsored",
	"room", "hall", "stage", "track", "day", "days", "morning", "afternoon", "evening",
	"lunchbreak", "wrap", "have", "has", "had", "having", "but", "their", "some", "also",
	"been", "being", "were", "he", "she", "his", "her", "hers", "now", "well", "back", "even",
	"still", "way", "ways", "thing", "things", "lot", "lots", "really", "want", "wants",
	"wanted", "need", "needs", "needed", "know", "knows", "see", "look", "looking", "comes",
	"come", "coming", "goes", "going", "take", "takes", "taking", "made", "give", "gives",
	"given", "show", "shows", "showing", "find", "finds", "finding", "help", "helps",
	"helping", "around", "during", "before", "after", "while", "because", "since", "again",
	"once", "other", "others", "each", "any", "many", "much", "every", "own", "such", "would",
	"could", "should", "might", "must", "may", "shall", "people", "work", "works", "working",
	"world", "worlds", "without", "upon", "among", "per", "instead", "due", "able", "youll",
	"youre", "time", "times", "learn", "learning", "learned", "today", "tomorrow",
	"yesterday", "something", "anything", "everything", "nothing", "someone", "everyone",
	"there", "here", "where", "theres", "heres", "wheres", "youve", "weve", "theyre", "isnt",
	"dont", "doesnt", "wont", "cant",
)

// Short tokens are usually noise — but these are real topics worth tracking.
var shortAllow = words("ai", "ux", "ci", "cd", "js", "go", "ml", "ar", "vr", "db", "cms")

// Fragments that only ever appear because descriptions carry URLs and a session
// template ("Key topics include…", "Target audience…"). They form high-frequency
// pairs that are about the CMS's form fields, not the community's interests.
var phraseNoise = words(
	"https", "http", "www", "com", "org", "net", "html", "topics", "topic",
	"include", "includes", "included", "target", "audience", "key", "level",
	"levelbeginner", "levelintermediate", "levaladvanced", "covered", "takeaways",
)

var (
	// Anything that is not a lowercase letter, digit, + or # is a separator.
	// Note that this makes every non-ASCII letter a separator too — "Gábor"
	// tokenises to "bor". That is the existing behaviour, not an improvement to
	// make here.
	tokenSeparator = regexp.MustCompile(`[^a-z0-9+#]+`)
	allDigits      = regexp.MustCompile(`^\d+$`)
	durationISO    = regexp.MustCompile(`(?i)^P(\d+)M$`)
	// "Online"/"Global"/etc. are placeless — Nominatim happily matches them to a
	// random building, so they are never mapped.
	placeless = regexp.MustCompile(`(?i)^(online|global|virtual|remote|worldwide|anywhere|tbd|tba|n/?a)$`)
	continent = regexp.MustCompile(`(?i)^((north |south |latin )?america|europe|asia|africa|oceania|global)$`)
)

// TitleTokens splits a title into distinct, meaningful topic tokens, deduped
// and in first-seen order.
func TitleTokens(title string) []string {
	var out []string
	seen := map[string]bool{}
	for _, raw := range tokenSeparator.Split(strings.ToLower(title), -1) {
		if raw == "" || allDigits.MatchString(raw) {
			continue
		}
		if len(raw) < 3 && !shortAllow[raw] {
			continue
		}
		if stopwords[raw] {
			continue
		}
		if !seen[raw] {
			seen[raw] = true
			out = append(out, raw)
		}
	}
	return out
}

// TitleBigrams returns adjacent word pairs, so the vocabulary can carry phrases
// as well as words — community interest is often two words ("layout builder",
// "site building") and a unigram vocabulary can only ever show the halves.
//
// Pairs are built from the RAW word sequence and then rejected if either half
// is a stopword, so "the display" never becomes a term while "display suite"
// does.
func TitleBigrams(title string) []string {
	var words []string
	for _, word := range tokenSeparator.Split(strings.ToLower(title), -1) {
		if word != "" {
			words = append(words, word)
		}
	}

	var out []string
	seen := map[string]bool{}
	for i := 0; i+1 < len(words); i++ {
		a, b := words[i], words[i+1]
		if stopwords[a] || stopwords[b] || phraseNoise[a] || phraseNoise[b] {
			continue
		}
		if allDigits.MatchString(a) || allDigits.MatchString(b) {
			continue
		}
		if (len(a) < 3 && !shortAllow[a]) || (len(b) < 3 && !shortAllow[b]) {
			continue
		}
		pair := a + " " + b
		if !seen[pair] {
			seen[pair] = true
			out = append(out, pair)
		}
	}
	return out
}

// TopicSession is one session as buildTopics sees it: some text and a year.
type TopicSession struct {
	Text string
	Year int
}

// Topic is a term with its total mentions and a per-year count.
type Topic struct {
	Term   string
	Total  int
	ByYear map[int]int
	// years in first-seen order, because the JSON object that carries ByYear
	// preserves insertion order and the payload is compared byte for byte.
	YearOrder []int
}

// BuildTopics is keyword-frequency-over-time from session text: the top topN
// terms, each with a per-year count — the shape the Observatory line chart
// plots as a share of that year's sessions.
func BuildTopics(sessions []TopicSession, topN int) []Topic {
	var order []string
	terms := map[string]*Topic{}
	for _, session := range sessions {
		if session.Year == 0 {
			continue
		}
		for _, term := range TitleTokens(session.Text) {
			record, seen := terms[term]
			if !seen {
				record = &Topic{Term: term, ByYear: map[int]int{}}
				terms[term] = record
				order = append(order, term)
			}
			record.Total++
			if _, seenYear := record.ByYear[session.Year]; !seenYear {
				record.YearOrder = append(record.YearOrder, session.Year)
			}
			record.ByYear[session.Year]++
		}
	}

	ranked := make([]Topic, 0, len(order))
	for _, term := range order {
		ranked = append(ranked, *terms[term])
	}
	// Stable, so terms with the same total keep first-seen order — which is what
	// JavaScript's sort does and what the payload records.
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Total > ranked[j].Total })
	if topN > 0 && len(ranked) > topN {
		ranked = ranked[:topN]
	}
	return ranked
}

// ── Regions ─────────────────────────────────────────────────────────────────
//
// Four macro-regions partition the whole inhabited globe with no gaps. EMEA is
// deliberately ONE region and not a locally-invented EUR/MEA split: these are an
// international standard used far outside this project, and a bucket the rest of
// the world does not recognise makes the archive's numbers incomparable with
// everyone else's.

var RegionCodes = []string{"EMEA", "APAC", "AMER", "LATAM"}

var RegionLabels = map[string]string{
	"EMEA":  "Europe, Middle East & Africa",
	"APAC":  "Asia-Pacific",
	"AMER":  "North America",
	"LATAM": "Latin America",
}

// Tested in this order, first match wins: LATAM before AMER ("Latin America"
// contains "America"), EMEA_MEA before APAC ("Georgia"/"Turkey" straddle).
var regionPatterns = []struct {
	code    string
	pattern *regexp.Regexp
}{
	{"LATAM", regexp.MustCompile(`(?i)\b(latin america|south america|central america|caribbean|latam|mexico|méxico|colombia|brazil|brasil|argentina|chile|peru|perú|uruguay|ecuador|bolivia|venezuela|paraguay|costa rica|guatemala|panama|cuba|dominican|honduras|nicaragua|el salvador|puerto rico|belize|jamaica|trinidad)\b`)},
	{"EMEA", regexp.MustCompile(`(?i)\b(middle east|africa|uae|united arab emirates|dubai|abu dhabi|saudi|qatar|kuwait|bahrain|oman|yemen|israel|palestine|jordan|lebanon|syria|iraq|iran|egypt|morocco|tunisia|algeria|libya|sudan|nigeria|kenya|ghana|south africa|ethiopia|tanzania|uganda|senegal|cameroon|ivory coast|côte d'ivoire|rwanda|zambia|zimbabwe|angola|mozambique|botswana|namibia|mali|mauritius)\b`)},
	{"APAC", regexp.MustCompile(`(?i)\b(asia|pacific|oceania|australia|new zealand|aotearoa|japan|nippon|china|india|singapore|korea|indonesia|thailand|malaysia|philippines|taiwan|vietnam|hong kong|pakistan|bangladesh|sri lanka|nepal|myanmar|cambodia|laos|mongolia|fiji|papua new guinea|brunei|kazakhstan|uzbekistan)\b`)},
	{"AMER", regexp.MustCompile(`(?i)\b(north america|usa|u\.s\.a|united states|america|canada)\b`)},
	{"EMEA", regexp.MustCompile(`(?i)\b(europe|european|netherlands|nederland|holland|belgium|belgi|germany|deutschland|austria|österreich|czech|cesko|czechia|denmark|danmark|united kingdom|great britain|britain|england|scotland|wales|northern ireland|ireland|eire|france|hungary|magyar|spain|espana|españa|italy|italia|poland|polska|switzerland|schweiz|suisse|greece|hellas|norway|norge|sweden|sverige|finland|suomi|portugal|iceland|luxembourg|slovakia|slovenia|croatia|serbia|bosnia|montenegro|macedonia|albania|kosovo|bulgaria|romania|lithuania|latvia|estonia|ukraine|belarus|moldova|malta|cyprus|monaco|liechtenstein|andorra|san marino|russia|turkey|türkiye|georgia|armenia|azerbaijan)\b`)},
}

// Placeless (online) events fall back to the organising community's home region.
var seriesRegion = map[string]string{
	"DrupalCon":                 "AMER",
	"DrupalCon Europe":          "EMEA",
	"DrupalSouth":               "APAC",
	"DrupalSouth Community Day": "APAC",
	"Drupal Downunder":          "APAC",
	"DrupalJam":                 "EMEA",
	"DrupalGov":                 "AMER",
	"Drupal Dev Days":           "EMEA",
}

// DeriveRegion is the pure derivation, ignoring any authored regionCode. The
// free-text `region` field is more reliable than the geocoded coordinates,
// which occasionally false-match (Athens→Georgia, Nara→DC).
func DeriveRegion(event *js.Value) string {
	region := event.Get("region").Str()
	for _, candidate := range regionPatterns {
		if candidate.pattern.MatchString(region) {
			return candidate.code
		}
	}
	return seriesRegion[js.Trim(event.Get("designation").Str())]
}

// RegionOf prefers an authored regionCode, as long as it is still a valid code —
// a legacy "EUR"/"MEA" re-derives to EMEA.
func RegionOf(event *js.Value) string {
	code := strings.ToUpper(event.Get("regionCode").Str())
	for _, valid := range RegionCodes {
		if code == valid {
			return code
		}
	}
	return DeriveRegion(event)
}

var countryCanon = map[string]string{
	"netherlands": "Netherlands", "belgium": "Belgium", "japan": "Japan",
	"india": "India", "singapore": "Singapore", "new zealand": "New Zealand",
	"australia": "Australia", "greece": "Greece", "germany": "Germany",
	"austria": "Austria", "france": "France", "spain": "Spain",
	"ireland": "Ireland", "united kingdom": "United Kingdom", "denmark": "Denmark",
	"hungary": "Hungary", "colombia": "Colombia", "czechia": "Czechia",
}

var countryEnglish = map[string]string{
	"nederland": "Netherlands", "españa": "Spain", "日本": "Japan",
	"česko": "Czechia", "österreich": "Austria", "magyarország": "Hungary",
	"danmark": "Denmark", "deutschland": "Germany", "éire / ireland": "Ireland",
	"belgië / belgique / belgien": "Belgium", "new zealand / aotearoa": "New Zealand",
}

var countrySplit = regexp.MustCompile(`[–\-/]`)

// DeriveCountry reads a country out of the free-text region, else out of the
// geocoder's display name. Continents are not countries and are kept out.
func DeriveCountry(regionStr, geoDisplay string) string {
	for _, part := range countrySplit.Split(regionStr, -1) {
		if country, ok := countryCanon[strings.ToLower(js.Trim(part))]; ok {
			return country
		}
	}
	if geoDisplay == "" {
		return ""
	}
	parts := strings.Split(geoDisplay, ",")
	last := js.Trim(parts[len(parts)-1])
	english, ok := countryEnglish[strings.ToLower(last)]
	if !ok {
		english = last
	}
	if continent.MatchString(english) {
		return ""
	}
	return english
}

// ── Session shape ───────────────────────────────────────────────────────────

// LengthBucket is one slot shape a programme is actually built from. The
// archive holds 51 distinct durations but they pile up at six shapes, and
// boundaries sit BETWEEN the clusters — a 50-minute talk belongs with the 45s,
// not with the hours, so a programme running 50-minute slots does not read as
// an hour of content it never had.
type LengthBucketDef struct {
	Key, Label string
	Max        int // math.MaxInt for the open-ended bucket
}

const noMax = int(^uint(0) >> 1)

var LengthBuckets = []LengthBucketDef{
	{"lightning", "Lightning · ≤20 min", 20},
	{"half", "Half hour · 21–35", 35},
	{"short", "45 min · 36–50", 50},
	{"hour", "An hour · 51–70", 70},
	{"workshop", "Workshop · 71–120", 120},
	{"day", "Half day or more", noMax},
}

// LengthBucket returns the bucket a length falls in, or "" for a session with
// no duration recorded.
func LengthBucket(minutes int) string {
	if minutes <= 0 {
		return ""
	}
	for _, bucket := range LengthBuckets {
		if minutes <= bucket.Max {
			return bucket.Key
		}
	}
	return LengthBuckets[len(LengthBuckets)-1].Key
}

// SessionMinutes reads a session's length. Every item in the archive stores
// `P<n>M` — ISO-8601 with a minutes component and nothing else — so this parses
// that and refuses to guess at anything it has not seen. A wrong number here
// would quietly inflate a headline figure, which is worse than reporting
// nothing.
func SessionMinutes(item *js.Value) int {
	match := durationISO.FindStringSubmatch(js.Trim(item.Get("duration").Str()))
	if match == nil {
		return 0
	}
	minutes, err := strconv.Atoi(match[1])
	if err != nil {
		return 0
	}
	return minutes
}

// Coords is an event's position, or nil when it has none to draw.
type Coords struct{ Lat, Lon float64 }

// CoordsFor resolves an event's coordinates: the dataset's own lat/lon, else
// the geocode cache. Every drill that draws a map has to agree about which
// events HAVE a place — a topic drill that mapped "Online" would put a keyword
// on a random building.
func CoordsFor(event *js.Value, geo *js.Value) *Coords {
	location := js.Trim(event.Get("location").Str())
	if placeless.MatchString(location) {
		return nil
	}
	lat, hasLat := event.Get("latitude").Number()
	lon, hasLon := event.Get("longitude").Number()
	if hasLat && hasLon {
		return &Coords{Lat: lat, Lon: lon}
	}
	cached := geo.Get(location)
	if cachedLat, ok := cached.Get("lat").Number(); ok {
		cachedLon, _ := cached.Get("lon").Number()
		return &Coords{Lat: cachedLat, Lon: cachedLon}
	}
	return nil
}
