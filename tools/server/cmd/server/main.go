package main

// server — the archive backend: one HTTP service, and the subcommands that
// build and check what it serves.
//
// This is the first slice of the migration described in docs/go-port.md. It
// deliberately does NOT replace anything: lib/buildCatalog.js still runs on
// boot and after every event write, and this produces the same bytes. The point
// of the first slice is to establish the two things the rest of the port needs
// — JSON output fidelity, and a contract with the browser modules the server
// shares — on a surface small enough to verify completely.
//
//	server catalog            build and write catalog.json
//	server catalog -check     build it and diff against the file on disk

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/auth"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/storage"
	"server/internal/web"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "catalog":
		err = catalogCommand(os.Args[2:])
	case "coverage":
		err = coverageCommand(os.Args[2:])
	case "quality":
		err = qualityCommand(os.Args[2:])
	case "insights":
		err = insightsCommand(os.Args[2:])
	case "serve":
		err = serveCommand(os.Args[2:])
	case "sync":
		err = syncCommand(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `server — the archive backend, in Go

  server catalog [-data DIR] [-check]
        Rebuild catalog.json from the event files on disk.
        -check writes nothing and exits 1 if the file on disk is stale.

  server coverage [-data DIR] [-private DIR] [-today YYYY-MM-DD] [-json]
        What each event is missing, worst first. Reads the curation ledger, so
        gaps you have ignored or snoozed stay quiet. Writes nothing.

  server insights [-data DIR] [-private DIR] [-json]
        The Archive Observatory payload: per-year and per-series tallies,
        speakers, sponsors, credits, topics and provenance. Writes nothing.

  server serve [-data DIR] [-img DIR] [-addr :3001] [-content-only]
        Serve the whole backend: pages, the JSON API, auth, uploads and the
        /data + /img mounts. Configured from the same environment variables
        server.js reads.
        -content-only serves ONLY /data, /img and /schedule.ics — no auth, no
        API, no pages. That is the narrow service a path-routed deployment runs
        beside the Node server during the cutover.

  server sync push|pull|status [-force] [-scope all|data|planner]
        Move content between this installation and its S3 bucket. NOT yet the
        authoritative implementation — see docs/go-port.md before switching.

  server quality [-data DIR] [-json]
        What is here but wrong — flattened descriptions, undecoded entities,
        rooms carrying a field label. Writes nothing.

The data directory is resolved like lib/roots.js does it: -data, else
$DATA_ROOT, else $CONTENT_PATH/public. The private root likewise: -private,
else $PRIVATE_ROOT, else $CONTENT_PATH/private.
`)
}

func catalogCommand(args []string) error {
	flags := flag.NewFlagSet("catalog", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	check := flags.Bool("check", false, "compare with catalog.json on disk instead of writing")
	if err := flags.Parse(args); err != nil {
		return err
	}

	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}

	if *check {
		return checkCatalog(dataDir)
	}

	catalog, err := archive.WriteCatalog(dataDir, time.Now())
	if err != nil {
		// Read-only or permission-denied filesystems (immutable containers, some
		// hosts): degrade cleanly and keep whatever catalog.json is committed —
		// the schedule serves that, and the client falls back to per-file when
		// it is absent. Matches scripts/build-catalog.mjs.
		if isReadOnly(err) {
			fmt.Printf("Cannot write catalog.json (%s: read-only/permission) — leaving the committed copy in place.\n",
				archive.ErrCode(err))
			return nil
		}
		return err
	}

	suffix := ""
	if len(catalog.Skipped) > 0 {
		suffix = fmt.Sprintf(", %d skipped", len(catalog.Skipped))
	}
	fmt.Printf("Wrote %s — %d events%s.\n", filepath.Join(dataDir, "catalog.json"), catalog.Events, suffix)
	for _, skip := range catalog.Skipped {
		fmt.Fprintf(os.Stderr, "  ⚠ skipped %s (%s) — on disk but not readable\n", skip.File, skip.Reason)
	}
	return nil
}

func coverageCommand(args []string) error {
	flags := flag.NewFlagSet("coverage", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	privateFlag := flags.String("private", "", "PRIVATE_ROOT, for the curation ledger")
	todayFlag := flags.String("today", "", "treat this as today's date (YYYY-MM-DD)")
	asJSON := flags.Bool("json", false, "emit the full structure instead of a summary")
	if err := flags.Parse(args); err != nil {
		return err
	}

	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}
	snoozes := archive.LoadSnoozes(paths.ResolvePrivateRoot(*privateFlag))

	coverage, err := archive.BuildCoverage(dataDir, snoozes, *todayFlag)
	if err != nil {
		return err
	}

	if *asJSON {
		os.Stdout.Write(append(coverage.Encode("  "), '\n'))
		return nil
	}

	totals := coverage.Get("totals")
	fmt.Printf("%d events · %d with open gaps · %d gaps fixable · %d session pages to fetch\n",
		archive.IntOf(totals.Get("events")), archive.IntOf(totals.Get("withGaps")),
		archive.IntOf(totals.Get("fixable")), archive.IntOf(totals.Get("fixableSessions")))
	if snoozed := archive.IntOf(totals.Get("snoozed")); snoozed > 0 {
		fmt.Printf("%d gap(s) ignored or snoozed in the ledger\n", snoozed)
	}
	fmt.Println()

	// Worst first, which is the order BuildCoverage already put them in.
	shown := 0
	for _, event := range coverage.Get("events").Items() {
		if archive.IntOf(event.Get("openCount")) == 0 || shown >= 10 {
			break
		}
		shown++
		fmt.Printf("%3d%%  %-46s %d gap(s)", archive.IntOf(event.Get("score")),
			trimTo(event.Get("label").Str(), 46), archive.IntOf(event.Get("openCount")))
		if pages := archive.IntOf(event.Get("fixableSessions")); pages > 0 {
			fmt.Printf(", %d page(s) to fetch", pages)
		}
		fmt.Println()
	}
	return nil
}

func qualityCommand(args []string) error {
	flags := flag.NewFlagSet("quality", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	asJSON := flags.Bool("json", false, "emit the full structure instead of a summary")
	if err := flags.Parse(args); err != nil {
		return err
	}

	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}
	quality, err := archive.BuildQuality(dataDir)
	if err != nil {
		return err
	}

	if *asJSON {
		os.Stdout.Write(append(quality.Encode("  "), '\n'))
		return nil
	}

	totals := quality.Get("totals")
	fmt.Printf("%d events · %d sessions · %d defects across %d events\n\n",
		archive.IntOf(totals.Get("events")), archive.IntOf(totals.Get("sessions")),
		archive.IntOf(totals.Get("defects")), archive.IntOf(totals.Get("eventsWithDefects")))

	// The probes are the worklist — each one is a defect with a known repair,
	// which is more actionable than a ranked list of events.
	for _, probe := range quality.Get("probes").Items() {
		fmt.Printf("%5d  %-32s in %d event(s)\n",
			archive.IntOf(probe.Get("count")), trimTo(probe.Get("label").Str(), 32),
			archive.IntOf(probe.Get("events")))
		fmt.Printf("       %s\n", probe.Get("repair").Str())
		for i, worst := range probe.Get("worst").Items() {
			if i >= 3 {
				break
			}
			fmt.Printf("         %4d  %s\n", archive.IntOf(worst.Get("count")), worst.Get("name").Str())
		}
	}
	return nil
}

func insightsCommand(args []string) error {
	flags := flag.NewFlagSet("insights", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	privateFlag := flags.String("private", "", "PRIVATE_ROOT, for the curation ledger")
	asJSON := flags.Bool("json", false, "emit the full payload instead of a summary")
	if err := flags.Parse(args); err != nil {
		return err
	}
	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}
	decisions := archive.LoadDecisions(paths.ResolvePrivateRoot(*privateFlag))
	payload, err := archive.BuildInsights(dataDir, decisions.Aliases, decisions.Series)
	if err != nil {
		return err
	}
	if *asJSON {
		os.Stdout.Write(append(payload.Encode("  "), '\n'))
		return nil
	}
	stats := payload.Get("stats")
	fmt.Printf("%d events · %d sessions (%d workshops, %d socials) · %d hours of programme\n",
		archive.IntOf(stats.Get("events")), archive.IntOf(stats.Get("sessions")),
		archive.IntOf(stats.Get("workshops")), archive.IntOf(stats.Get("socials")),
		archive.IntOf(stats.Get("minutes"))/60)
	fmt.Printf("%d speakers · %d sponsors across %d slots · %d%% metadata coverage\n\n",
		archive.IntOf(stats.Get("speakers")), archive.IntOf(stats.Get("sponsors")),
		archive.IntOf(stats.Get("sponsorSlots")), archive.IntOf(stats.Get("coverage")))
	fmt.Println("top topics")
	for i, topic := range payload.Get("topics").Items() {
		if i >= 8 {
			break
		}
		fmt.Printf("  %5d  %s\n", archive.IntOf(topic.Get("total")), topic.Get("term").Str())
	}
	return nil
}

func serveCommand(args []string) error {
	flags := flag.NewFlagSet("serve", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	imgFlag := flags.String("img", "", "IMG_ROOT (defaults to <data>/img)")
	addr := flags.String("addr", ":3001", "address to listen on")
	contentOnly := flags.Bool("content-only", false,
		"serve only /data, /img and /schedule.ics — no auth, API or pages")
	if err := flags.Parse(args); err != nil {
		return err
	}
	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}
	imgDir := *imgFlag
	if imgDir == "" {
		imgDir = os.Getenv("IMG_ROOT")
	}
	if imgDir == "" {
		imgDir = filepath.Join(dataDir, "img")
	}

	// `-content-only` is the narrow service: /data, /img and /schedule.ics with
	// no auth, no API and no pages. It is what the path-routed deployment runs
	// beside the Node server today, and it stays available so that arrangement
	// keeps working through the cutover.
	var handler http.Handler
	logger := log.New(os.Stderr, "", log.LstdFlags)
	roots := web.ResolveBackendRoots(dataDir, imgDir)

	if *contentOnly {
		handler = web.NewServer([]web.Mount{{Prefix: "/data", Dir: dataDir}, {Prefix: "/img", Dir: imgDir}})
		fmt.Printf("server (content only) → http://localhost%s\n  /data → %s\n  /img  → %s\n",
			*addr, dataDir, imgDir)
	} else {
		mode := auth.DetectMode(os.Getenv)
		// Running open on a deployed box is almost certainly a misconfiguration,
		// and one nobody notices until the data is public. So it has to be asked
		// for in words.
		if auth.RefuseToStart(mode, os.Getenv) {
			return fmt.Errorf("refusing to start in open mode on a deployed host: " +
				"set AUTH_MODE=open to say you meant it, or configure AUTH_PASSWORD_HASH")
		}
		var archive *web.ArchiveAPI
		handler, archive = web.NewBackend(roots, logger)
		web.WarmInsights(archive, 500*time.Millisecond)

		fmt.Printf("server → http://localhost%s\n"+
			"  auth    %s\n  app     %s\n  data    %s\n  img     %s\n  private %s\n",
			*addr, mode, roots.App, roots.Data, roots.Img, orNone(roots.Private))
	}

	server := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return server.ListenAndServe()
}

func orNone(value string) string {
	if value == "" {
		return "(none — nothing written yet)"
	}
	return value
}

// syncCommand is the bucket sync. It refuses to run without an explicit
// subcommand, because `server sync` reading as either direction is exactly the
// kind of ambiguity that costs somebody their edits.
func syncCommand(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: server sync push|pull|status [flags]")
	}
	operation := args[0]

	flags := flag.NewFlagSet("sync", flag.ExitOnError)
	dataFlag := flags.String("data", "", "archive DATA_ROOT")
	privateFlag := flags.String("private", "", "PRIVATE_ROOT")
	scope := flags.String("scope", "all", "all, data or planner")
	force := flags.Bool("force", false, "overwrite the other side on a conflict")
	manifest := flags.String("manifest", "", "path to the sync manifest")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}

	dataDir, err := paths.ResolveDataRoot(*dataFlag)
	if err != nil {
		return err
	}
	privateRoot := paths.ResolvePrivateRoot(*privateFlag)
	if privateRoot == "" {
		return errors.New("no private root: set PRIVATE_ROOT or CONTENT_PATH")
	}
	manifestPath := *manifest
	if manifestPath == "" {
		manifestPath = filepath.Join(privateRoot, ".s3-manifest.json")
	}

	settings := storage.ReadS3Settings(os.Getenv)
	store, err := storage.NewS3Store(context.Background(), settings)
	if err != nil {
		return err
	}

	config := storage.SyncConfig{
		Prefix: settings.Prefix,
		Roots: storage.SyncRoots{
			Data:      dataDir,
			Img:       filepath.Join(dataDir, "img"),
			Planners:  filepath.Join(privateRoot, "planners"),
			Receipts:  filepath.Join(privateRoot, "receipts"),
			Documents: filepath.Join(privateRoot, "documents"),
			Curation:  filepath.Join(privateRoot, "curation"),
		},
		ManifestPath: manifestPath,
		Scope:        *scope,
		Force:        *force,
	}

	ctx := context.Background()
	var outcome storage.SyncOutcome
	var verb string
	switch operation {
	case "push":
		outcome, err = storage.Push(ctx, store, config)
		verb = "pushed"
	case "pull":
		outcome, err = storage.Pull(ctx, store, config)
		verb = "pulled"
	case "status":
		// Status is a pull that writes nothing: the same comparison, reported.
		remote, listErr := store.List(ctx, config.Prefix)
		if listErr != nil {
			return listErr
		}
		fmt.Printf("bucket %s · %d object(s) under %q\n", settings.Bucket, len(remote), config.Prefix)
		fmt.Printf("manifest %s · %d entry(ies)\n", manifestPath, len(storage.ReadManifest(manifestPath)))
		return nil
	default:
		return fmt.Errorf("unknown sync operation %q: want push, pull or status", operation)
	}
	if err != nil {
		return err
	}

	fmt.Printf("%d %s · %d skipped · %d conflict(s) · %d error(s)\n",
		len(outcome.Moved), verb, len(outcome.Skipped),
		len(outcome.Conflicts), len(outcome.Errors))
	for _, conflict := range outcome.Conflicts {
		fmt.Printf("  conflict %-12s %s\n", conflict.Reason, conflict.Path)
	}
	for _, syncErr := range outcome.Errors {
		fmt.Fprintf(os.Stderr, "  error %s: %s\n", syncErr.Path, syncErr.Error)
	}
	if len(outcome.Conflicts) > 0 {
		fmt.Println("\nnothing was overwritten — re-run with -force once you know which copy you want")
	}
	return nil
}

func trimTo(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	return string(runes[:max-1]) + "…"
}

// checkCatalog answers "is the committed catalog what the datasets say it
// should be" — which is a question CI can ask and a deploy can act on, and the
// one this port has to keep answering `yes` to while both implementations exist.
func checkCatalog(dataDir string) error {
	built, err := archive.BuildCatalog(dataDir, time.Now())
	if err != nil {
		return err
	}
	onDisk, err := os.ReadFile(filepath.Join(dataDir, "catalog.json"))
	if err != nil {
		return err
	}
	parsed, err := js.ParseJSON(onDisk)
	if err != nil {
		return fmt.Errorf("catalog.json on disk does not parse: %w", err)
	}

	// generatedAt is a timestamp, not a fact about the datasets; comparing it
	// would report every catalog as stale one nanosecond after it was built.
	want := archive.StripGeneratedAt(parsed).Encode("  ")
	got := archive.StripGeneratedAt(built.Value).Encode("  ")
	if bytes.Equal(want, got) {
		fmt.Printf("catalog.json is up to date — %d events.\n", built.Events)
		return nil
	}
	fmt.Fprintf(os.Stderr, "catalog.json is stale — rebuild it (%d events on disk).\n", built.Events)
	os.Exit(1)
	return nil
}

func isReadOnly(err error) bool {
	return errors.Is(err, syscall.EROFS) ||
		errors.Is(err, syscall.EACCES) ||
		errors.Is(err, syscall.EPERM)
}
