package archive

import "strings"

// PROGRAMME REGISTER — what the archive can and cannot say about "the vibe".
//
// There is no sentiment-bearing text in this archive. No comments, no feedback
// forms, no reviews: nothing where anybody said how they FELT. What there is is
// ~9,000 session descriptions, and those are ad copy — written to sell a talk,
// uniformly upbeat. Scoring them for positivity produces a flat line near
// "positive" that means nothing at all.
//
// So this measures ORIENTATION, not affect: what the programme is pointed at.
// Four word-lists, counted per 1,000 words. Collective and Forward-looking are
// the "energy" pair; Legacy and Strain are the drag.
//
// WHY NOT JUST COUNT THINGS PER YEAR. Every count in this archive — events,
// sessions, sponsors, first-appearances of a series — tracks INGEST ORDER rather
// than history. A natality run over the corpus reported twelve new series in
// 2011 and a dip to eight events in 2018; both are artefacts of what has been
// scraped so far. Per-event ratios are the only coverage-robust shape, which is
// why this normalises by words within an event and the client takes a median
// ACROSS events rather than pooling a year's text.
//
// THREE CONTROLS, EACH OF WHICH THE TREND SURVIVED:
//
//  1. Language. The English share of descriptions swings from 70% to 95% by
//     year, and the years with the most German/Dutch/Polish text were exactly
//     the years the raw rates looked lowest — a purely mechanical dilution.
//     Non-English documents are dropped rather than diluted.
//  2. Event weight. One large DrupalCon can carry a whole year (2013 alone
//     brought 140k words). Rates are per event; the client takes the median.
//  3. CFP boilerplate. Templated abstracts — "synopsis / prerequisites /
//     learning objectives / outline" — jump from ~5% of descriptions to 22% in
//     2023-2025, across 7-10 events a year, so a structured-CFP fashion could
//     plausibly have manufactured the whole rise. Removing every templated and
//     artefact-laden description leaves the trend intact or slightly STRONGER
//     (collective voice in 2024 goes up, not down). The boilerplate contaminates
//     which words are DISTINCTIVE to a year; it does not drive these rates. So
//     documents are not dropped for it — dropping them would discard real text
//     to fix a problem that measurement showed was not there.
//
// WHAT IS DELIBERATELY NOT IN THE LISTS. "beginner" and "newcomer" read as
// collective-register words and were in the first draft, but a CFP form's
// audience-level field ("Level: Beginner") tokenises straight into them, which
// would inflate exactly the template-heavy years. They are out. The trend holds
// without them, and holds again under a stricter list of unambiguous
// collective-action words only (2010 → 2024 still rises by about half).
//
// This measures the register of the PROGRAMME, which is a proxy for the energy
// of the community, not a reading of it. The UI is labelled accordingly.

// Lexicon is one named word-list plotted as one line.
type Lexicon struct {
	Key   string
	Label string
	// Note is the honest caveat shown next to the line, not decoration.
	Note  string
	Words map[string]bool
}

func lexWords(list string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(list) {
		out[w] = true
	}
	return out
}

// RegisterLexicons are ordered: the two "energy" lines first, so the default
// selection is the pair that answers "is there more of it than there used to be".
var RegisterLexicons = []Lexicon{
	{
		Key:   "collective",
		Label: "Collective voice",
		Note:  "How much the programme speaks as a group rather than to an audience",
		Words: lexWords(`we our us together community communities contribute contributing
			contributor contributors contribution contributions sprint sprints mentor
			mentors mentoring volunteer volunteers volunteering everyone share sharing
			help helping join joining collaborate collaborating collaboration welcome
			welcoming`),
	},
	{
		Key:   "forward",
		Label: "Forward-looking",
		Note:  "Language about what is coming rather than what exists",
		Words: lexWords(`new future next upcoming roadmap initiative initiatives modern
			innovation innovative opportunity opportunities growth adopt adopting
			adoption emerging vision ahead improve improving improvement faster better
			rethink reimagine`),
	},
	{
		Key:   "legacy",
		Label: "Legacy & migration",
		Note:  "Effort pointed backwards — peaks with Drupal 7 end-of-life in 2022",
		Words: lexWords(`legacy migrate migrating migration migrations upgrade upgrading
			upgrades deprecated deprecation sunset maintain maintaining maintenance
			backport backporting port porting outdated obsolete debt`),
	},
	{
		Key:   "strain",
		Label: "Strain",
		Note:  "Difficulty and risk — peaks in 2020",
		Words: lexWords(`problem problems challenge challenges challenging difficult
			difficulty struggle struggling pain painful fail failing failure failures
			risk risks risky issue issues crisis burnout pressure fear worry mistake
			mistakes wrong broken`),
	},
}

// englishMarkers are function words common enough that any English paragraph
// carries several, and rare enough in the archive's other languages that a
// German or Polish abstract will not clear the bar by accident.
var englishMarkers = lexWords(`the of and to in a is for with that you your this are
	on it as we will how what`)

// registerTokens lowercases and splits on anything that is not an ASCII letter
// or an apostrophe. Non-ASCII words fragment, which does not matter: the
// documents they come from are dropped by the English test a line later.
func registerTokens(text string) []string {
	var out []string
	var buf strings.Builder
	for _, r := range text {
		switch {
		case r >= 'a' && r <= 'z':
			buf.WriteRune(r)
		case r >= 'A' && r <= 'Z':
			buf.WriteRune(r + 32)
		case r == '\'':
			buf.WriteRune(r)
		default:
			if buf.Len() > 0 {
				out = append(out, buf.String())
				buf.Reset()
			}
		}
	}
	if buf.Len() > 0 {
		out = append(out, buf.String())
	}
	return out
}

// Minimum evidence for one document and one event. A 24-word abstract has no
// stable rate in it, and an event with a handful of readable sessions would
// swing a year's median on noise.
const (
	registerMinDocWords   = 25
	registerMinDocMarkers = 5
	registerMinEventDocs  = 8
	registerMinEventWords = 2000
)

// isEnglishDoc reports whether a document has enough English function words to
// be counted. Short documents are rejected outright: five markers out of twenty
// words says nothing.
func isEnglishDoc(tokens []string) bool {
	if len(tokens) < registerMinDocWords {
		return false
	}
	seen := map[string]bool{}
	for _, t := range tokens {
		if englishMarkers[t] {
			seen[t] = true
		}
	}
	return len(seen) >= registerMinDocMarkers
}

// RegisterTally is one event's readable text, counted.
type RegisterTally struct {
	Docs   int
	Words  int
	Counts []int // parallel to RegisterLexicons
}

func newRegisterTally() *RegisterTally {
	return &RegisterTally{Counts: make([]int, len(RegisterLexicons))}
}

// Add folds one session's text in, and reports whether it counted.
func (t *RegisterTally) Add(text string) bool {
	tokens := registerTokens(text)
	if !isEnglishDoc(tokens) {
		return false
	}
	t.Docs++
	t.Words += len(tokens)
	for _, tok := range tokens {
		for i, lex := range RegisterLexicons {
			if lex.Words[tok] {
				t.Counts[i]++
			}
		}
	}
	return true
}

// Enough reports whether this event brought sufficient text to carry a rate.
func (t *RegisterTally) Enough() bool {
	return t.Docs >= registerMinEventDocs && t.Words >= registerMinEventWords
}
