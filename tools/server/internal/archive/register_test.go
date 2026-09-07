package archive

import "testing"

// The register measure is a rate, and every one of these tests pins a way a rate
// can lie: counting text it cannot read, counting an event that brought almost
// none, or letting a word list match something it was never meant to.

func TestRegisterCountsOnlyEnglishDocuments(t *testing.T) {
	// The English share of this archive's descriptions swings from 70% to 95% by
	// year. If German abstracts were counted as words but could never match an
	// English word list, they would dilute the rate — and the years with the most
	// German text would look like the years with the least energy, purely as an
	// artefact of the denominator.
	german := `Zufriedenheit bei der Arbeit hängt von verschiedenen Faktoren ab, von der
		Ausübung einer sinnvollen Tätigkeit ebenso wie von Möglichkeiten der Mitbestimmung
		und Mitgestaltung, als genossenschaftlich organisierte Firma wollen wir genau dies
		ermöglichen und weiter ausbauen`
	tally := newRegisterTally()
	if tally.Add(german) {
		t.Fatal("a German abstract was counted; it can never match an English word list, so its words would only dilute the rate")
	}
	if tally.Words != 0 || tally.Docs != 0 {
		t.Fatalf("rejected document still contributed: docs=%d words=%d", tally.Docs, tally.Words)
	}
}

func TestRegisterRejectsDocumentsTooShortToHaveARate(t *testing.T) {
	// "we contribute together" is 100% collective voice and says nothing at all.
	tally := newRegisterTally()
	if tally.Add("We contribute together as a community.") {
		t.Fatal("a one-line abstract was counted; a rate over six words is noise")
	}
}

func TestRegisterCountsAnEnglishDocument(t *testing.T) {
	text := `This session is for everyone who wants to contribute to the community and
		help us improve the way we work together, and we will share what we have learned
		about mentoring new people through their first sprint so that you can do the same
		at your own event next year`
	tally := newRegisterTally()
	if !tally.Add(text) {
		t.Fatal("a plainly English paragraph was not counted")
	}
	if tally.Docs != 1 || tally.Words < 40 {
		t.Fatalf("docs=%d words=%d", tally.Docs, tally.Words)
	}
	if got := tally.Counts[indexOfLexicon(t, "collective")]; got == 0 {
		t.Fatal("collective voice scored zero on a paragraph full of it")
	}
}

func TestRegisterNeedsSeveralDocumentsBeforeAnEventCounts(t *testing.T) {
	// One long abstract is one speaker's voice, not an event's register.
	text := `This session is for everyone who wants to contribute to the community and help
		us improve the way we work together and share what we have learned with you all`
	tally := newRegisterTally()
	for i := 0; i < registerMinEventDocs-1; i++ {
		tally.Add(text)
	}
	if tally.Enough() {
		t.Fatalf("an event with %d documents was accepted; the floor is %d",
			registerMinEventDocs-1, registerMinEventDocs)
	}
}

func TestRegisterTokenizerSplitsOnPunctuationAndKeepsApostrophes(t *testing.T) {
	got := registerTokens("Let's write secure Drupal code! Decoupled/headless — really?")
	want := []string{"let's", "write", "secure", "drupal", "code", "decoupled", "headless", "really"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("token %d: got %q want %q (%v)", i, got[i], want[i], got)
		}
	}
}

func TestRegisterUrlsCannotScoreAsLexiconWords(t *testing.T) {
	// 500+ descriptions in this archive carry Wayback rewriting — archive.org
	// URLs, itok= fragments, .html filenames. The tokenizer splits those into
	// pieces ("web", "archive", "org"), and this pins that none of the pieces is
	// a lexicon word: the noise must not be able to move a line.
	junk := registerTokens(
		"https://web.archive.org/web/20260612081609/https://drupalcamp.ruhr/18/en/?itok=vheN5u62")
	for _, tok := range junk {
		for _, lex := range RegisterLexicons {
			if lex.Words[tok] {
				t.Fatalf("URL fragment %q scores in the %q lexicon", tok, lex.Key)
			}
		}
	}
}

func TestRegisterExcludesAudienceLevelWords(t *testing.T) {
	// "beginner" and "newcomer" read as collective-register words and were in the
	// first draft of the list. A CFP form's audience-level field ("Level:
	// Beginner") tokenises straight into them, and templated abstracts jump from
	// ~5% of the corpus to 22% in 2023-2025 — so those two words would have
	// inflated exactly the years the chart claims are the most energetic.
	collective := RegisterLexicons[indexOfLexicon(t, "collective")]
	for _, word := range []string{"beginner", "newcomer", "intermediate", "advanced"} {
		if collective.Words[word] {
			t.Fatalf("%q is back in the collective lexicon; a CFP level field would inflate it", word)
		}
	}
}

func TestRegisterLexiconsAreDisjoint(t *testing.T) {
	// A word in two lists is counted twice and the lines stop being independent.
	seen := map[string]string{}
	for _, lex := range RegisterLexicons {
		for word := range lex.Words {
			if other, dup := seen[word]; dup {
				t.Fatalf("%q is in both %q and %q", word, other, lex.Key)
			}
			seen[word] = lex.Key
		}
	}
}

func TestRegisterLexiconsAllCarryALabelAndNote(t *testing.T) {
	// The note is the caveat shown beside the line, not decoration.
	for _, lex := range RegisterLexicons {
		if lex.Key == "" || lex.Label == "" || lex.Note == "" {
			t.Fatalf("lexicon %+v is missing a key, label or note", lex)
		}
		if len(lex.Words) < 10 {
			t.Fatalf("lexicon %q has only %d words — too few to average out", lex.Key, len(lex.Words))
		}
	}
}

func indexOfLexicon(t *testing.T, key string) int {
	t.Helper()
	for i, lex := range RegisterLexicons {
		if lex.Key == key {
			return i
		}
	}
	t.Fatalf("no lexicon named %q", key)
	return -1
}
