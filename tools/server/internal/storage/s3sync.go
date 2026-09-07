package storage

// A Go port of lib/s3-sync.js — the bucket that holds this installation's
// content between deploys.
//
// This is the one module the migration cannot run in parallel. Everything else
// was proven by running both implementations and comparing; two implementations
// of THIS one, pointed at the same bucket, are two writers racing over the same
// objects. So it is ported, tested against a stub bucket, and switched over
// deliberately — never left running beside the original.
//
// The algorithm is separated from the transport for exactly that reason: the
// conflict rules below are the part that decides whether somebody's edit
// survives, and they are testable without a network or an account.

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"server/internal/js"
	"sort"
	"strings"
)

// CurationS3Prefix is the ledger's home in the bucket.
//
// It stays under `data/` even though the file is private on disk: the bucket
// layout is a contract with every existing installation, and moving it would
// orphan the decisions of anyone who upgraded.
const CurationS3Prefix = "data/curation/"

// ObjectStore is the bucket, as this module needs it.
//
// An interface rather than a client, so the sync algorithm can be exercised
// against an in-memory bucket. The conflict rules are the dangerous part and
// they should not need an AWS account to test.
type ObjectStore interface {
	// List returns key → ETag (lowercase, unquoted) for everything under prefix.
	List(ctx context.Context, prefix string) (map[string]string, error)
	Get(ctx context.Context, key string) (body []byte, etag string, err error)
	Put(ctx context.Context, key string, body []byte, contentType string) (etag string, err error)
}

// SyncRoots is where content lives locally.
type SyncRoots struct {
	Data, Img, Planners, Receipts, Documents, Curation string
}

// SyncConfig is one sync's settings.
type SyncConfig struct {
	Prefix       string // the bucket-wide key prefix, may be empty
	Roots        SyncRoots
	ManifestPath string
	UserID       string // "" for single-user
	Scope        string // all | data | planner
	Force        bool
}

// SyncOutcome is what a push or a pull did.
type SyncOutcome struct {
	Moved     []string // pushed, or pulled
	Skipped   []string
	Conflicts []SyncConflict
	Errors    []SyncError
}

// SyncConflict is a file both sides changed, or one side changed behind the
// other's back.
type SyncConflict struct {
	Path         string `json:"path"`
	Reason       string `json:"reason"`
	LocalHash    string `json:"localHash,omitempty"`
	S3ETag       string `json:"s3Etag,omitempty"`
	ManifestETag string `json:"manifestEtag,omitempty"`
}

// SyncError is a file that could not be moved.
type SyncError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// ── Path mapping ────────────────────────────────────────────────────────────

// PlannerS3Prefix scopes planners by user: single-user installs write
// `planners/file.json`, multi-user ones `planners/<uid>/file.json`.
func PlannerS3Prefix(userID string) string {
	if userID != "" {
		return "planners/" + userID + "/"
	}
	return "planners/"
}

// PlannerLocalDir is the on-disk counterpart.
func (c SyncConfig) PlannerLocalDir() string {
	if c.UserID != "" {
		return filepath.Join(c.Roots.Planners, c.UserID)
	}
	return c.Roots.Planners
}

// ToLocalPath maps a bucket sub-path to a file, or "" when it belongs to
// nothing this installation holds.
//
// The curation case MUST come first. The ledger keeps its key under `data/` but
// no longer lives in the public data tree — without this, a pull would write it
// back into the served directory and quietly undo the move that made it private.
func (c SyncConfig) ToLocalPath(sub string) string {
	switch {
	case strings.HasPrefix(sub, CurationS3Prefix):
		return filepath.Join(c.Roots.Curation, strings.TrimPrefix(sub, CurationS3Prefix))
	case strings.HasPrefix(sub, "data/"):
		return filepath.Join(c.Roots.Data, strings.TrimPrefix(sub, "data/"))
	case strings.HasPrefix(sub, "img/"):
		return filepath.Join(c.Roots.Img, strings.TrimPrefix(sub, "img/"))
	case strings.HasPrefix(sub, "receipts/"):
		return filepath.Join(c.Roots.Receipts, strings.TrimPrefix(sub, "receipts/"))
	case strings.HasPrefix(sub, "documents/"):
		return filepath.Join(c.Roots.Documents, strings.TrimPrefix(sub, "documents/"))
	}
	plannerPrefix := PlannerS3Prefix(c.UserID)
	if strings.HasPrefix(sub, plannerPrefix) {
		return filepath.Join(c.PlannerLocalDir(), strings.TrimPrefix(sub, plannerPrefix))
	}
	return ""
}

// ToS3Key adds the installation-wide prefix.
func (c SyncConfig) ToS3Key(sub string) string { return c.Prefix + sub }

// FromS3Key strips the prefix and reports the sub-path, or "" for a key this
// installation does not own.
func (c SyncConfig) FromS3Key(key string) string {
	if !strings.HasPrefix(key, c.Prefix) {
		return ""
	}
	sub := strings.TrimPrefix(key, c.Prefix)
	for _, known := range []string{"data/", "img/", "receipts/", "documents/"} {
		if strings.HasPrefix(sub, known) {
			return sub
		}
	}
	if strings.HasPrefix(sub, PlannerS3Prefix(c.UserID)) {
		return sub
	}
	return ""
}

// contentWalk is one local tree and where it lives in the bucket.
type contentWalk struct {
	dir      string
	prefix   string
	allFiles bool // false means only *.json
}

// ContentWalks groups the content by origin: the editor owns event datasets and
// sponsor images; the planner owns planner state and its uploads. `scope` limits
// a sync to one side so the two do not push each other's work.
func (c SyncConfig) ContentWalks() []contentWalk {
	editor := c.Scope == "" || c.Scope == "all" || c.Scope == "data"
	planner := c.Scope == "" || c.Scope == "all" || c.Scope == "planner"

	var walks []contentWalk
	if editor {
		walks = append(walks,
			contentWalk{c.Roots.Data, "data/", false},
			contentWalk{c.Roots.Img, "img/", true},
			// Walked separately because the ledger left the public data tree on
			// disk but kept its key under `data/`. Dropping this would make the
			// bulk sync stop seeing a file it still lists in the bucket, so every
			// status call would report it as S3-only and a pull would try to
			// "restore" it.
			contentWalk{c.Roots.Curation, CurationS3Prefix, false},
		)
	}
	if planner {
		walks = append(walks,
			contentWalk{c.PlannerLocalDir(), PlannerS3Prefix(c.UserID), false},
			contentWalk{c.Roots.Receipts, "receipts/", true},
			contentWalk{c.Roots.Documents, "documents/", true},
		)
	}
	return walks
}

// SubInScope mirrors ContentWalks, for filtering the bucket listing.
func (c SyncConfig) SubInScope(sub string) bool {
	if c.Scope == "" || c.Scope == "all" {
		return true
	}
	editor := strings.HasPrefix(sub, "data/") || strings.HasPrefix(sub, "img/")
	planner := strings.HasPrefix(sub, PlannerS3Prefix(c.UserID)) ||
		strings.HasPrefix(sub, "receipts/") || strings.HasPrefix(sub, "documents/")
	if c.Scope == "data" {
		return editor
	}
	return planner
}

// WalkAsS3Paths lists a tree as bucket sub-paths.
func WalkAsS3Paths(localDir, s3Prefix string, allFiles bool) []string {
	var out []string
	_ = filepath.WalkDir(localDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return fs.SkipAll
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if !allFiles && !strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}
		relative, relErr := filepath.Rel(localDir, path)
		if relErr != nil {
			return nil
		}
		out = append(out, s3Prefix+filepath.ToSlash(relative))
		return nil
	})
	return out
}

// ContentTypeFor is the type an object is stored with. Deliberately the same
// small table the JavaScript carries, rather than the operating system's.
func ContentTypeFor(path string) string {
	switch strings.ToLower(strings.TrimPrefix(filepath.Ext(path), ".")) {
	case "json":
		return "application/json"
	case "pdf":
		return "application/pdf"
	case "jpg", "jpeg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "svg":
		return "image/svg+xml"
	case "gpx":
		return "application/gpx+xml"
	}
	return "application/octet-stream"
}

// FileMD5 is the hash both sides compare, and the one S3 reports as an ETag for
// a single-part upload.
func FileMD5(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := md5.Sum(body)
	return hex.EncodeToString(sum[:]), nil
}

// StripQuotes normalises an ETag: S3 quotes them and casing varies.
func StripQuotes(etag string) string {
	return strings.ToLower(strings.ReplaceAll(etag, `"`, ""))
}

// ── The manifest ────────────────────────────────────────────────────────────

// Manifest records the ETag each key had when this installation last agreed
// with the bucket. It is the third opinion that makes conflict detection
// possible: with only local and remote you can tell they differ, not who moved.
type Manifest map[string]string

// ReadManifest loads it. A missing or unreadable manifest is an empty one —
// which degrades to "everything looks new", never to a silent overwrite.
func ReadManifest(path string) Manifest {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Manifest{}
	}
	parsed, err := js.ParseJSON(raw)
	if err != nil {
		return Manifest{}
	}
	out := Manifest{}
	for _, key := range parsed.Keys() {
		out[key] = parsed.Get(key).Str()
	}
	return out
}

// SaveManifest writes it, in the JavaScript's format.
func SaveManifest(path string, manifest Manifest) error {
	keys := make([]string, 0, len(manifest))
	for key := range manifest {
		keys = append(keys, key)
	}
	// A Go map has no order and the JavaScript object has insertion order, so
	// neither side can be reproduced from the other. Sorted: stable across runs,
	// which is what makes the file diffable and a re-save a no-op.
	sort.Strings(keys)
	document := js.Obj()
	for _, key := range keys {
		document.Set(key, js.Str(manifest[key]))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, document.Encode("  "), 0o644)
}

// ── Push and pull ───────────────────────────────────────────────────────────

// Push sends local content to the bucket.
//
// The conflict rules are the point of this function, and they are asymmetric on
// purpose:
//
//	both-changed  local and remote each moved since the manifest → refuse
//	s3-ahead      local is unchanged but remote moved             → refuse
//
// Either way somebody else's work would be lost, so the default is to stop and
// say so. `force` is the operator saying they know which copy they want.
func Push(ctx context.Context, store ObjectStore, config SyncConfig) (SyncOutcome, error) {
	manifest := ReadManifest(config.ManifestPath)
	remote, err := store.List(ctx, config.Prefix)
	if err != nil {
		return SyncOutcome{}, err
	}

	var outcome SyncOutcome
	for _, walk := range config.ContentWalks() {
		for _, sub := range WalkAsS3Paths(walk.dir, walk.prefix, walk.allFiles) {
			key := config.ToS3Key(sub)
			localPath := config.ToLocalPath(sub)
			if localPath == "" {
				continue
			}

			localHash, hashErr := FileMD5(localPath)
			if hashErr != nil {
				outcome.Errors = append(outcome.Errors,
					SyncError{Path: sub, Error: hashErr.Error()})
				continue
			}
			manifestETag := manifest[key]
			remoteETag := remote[key]

			if localHash == remoteETag {
				if manifestETag == "" {
					manifest[key] = localHash
				}
				outcome.Skipped = append(outcome.Skipped, sub)
				continue
			}

			bothChanged := manifestETag != "" && localHash != manifestETag &&
				remoteETag != "" && remoteETag != manifestETag
			s3Ahead := manifestETag != "" && localHash == manifestETag &&
				remoteETag != "" && remoteETag != manifestETag

			if (bothChanged || s3Ahead) && !config.Force {
				reason := "s3-ahead"
				if bothChanged {
					reason = "both-changed"
				}
				outcome.Conflicts = append(outcome.Conflicts, SyncConflict{
					Path: sub, Reason: reason, S3ETag: remoteETag, ManifestETag: manifestETag,
				})
				continue
			}

			body, readErr := os.ReadFile(localPath)
			if readErr != nil {
				outcome.Errors = append(outcome.Errors, SyncError{Path: sub, Error: readErr.Error()})
				continue
			}
			etag, putErr := store.Put(ctx, key, body, ContentTypeFor(localPath))
			if putErr != nil {
				outcome.Errors = append(outcome.Errors, SyncError{Path: sub, Error: putErr.Error()})
				continue
			}
			manifest[key] = StripQuotes(etag)
			outcome.Moved = append(outcome.Moved, sub)
		}
	}

	if err := SaveManifest(config.ManifestPath, manifest); err != nil {
		return outcome, err
	}
	return outcome, nil
}

// Pull brings bucket content down.
//
// The mirror of Push, with the conflict rules pointing the other way:
//
//	both-changed  both moved since the manifest      → refuse
//	local-ahead   local moved and remote did not     → refuse
func Pull(ctx context.Context, store ObjectStore, config SyncConfig) (SyncOutcome, error) {
	manifest := ReadManifest(config.ManifestPath)

	local := map[string]bool{}
	for _, walk := range config.ContentWalks() {
		for _, sub := range WalkAsS3Paths(walk.dir, walk.prefix, walk.allFiles) {
			local[sub] = true
		}
	}

	remote, err := store.List(ctx, config.Prefix)
	if err != nil {
		return SyncOutcome{}, err
	}
	keys := make([]string, 0, len(remote))
	for key := range remote {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	var outcome SyncOutcome
	for _, key := range keys {
		remoteETag := remote[key]
		sub := config.FromS3Key(key)
		if sub == "" || !config.SubInScope(sub) {
			continue
		}
		localPath := config.ToLocalPath(sub)
		if localPath == "" {
			continue
		}

		manifestETag := manifest[key]
		localHash := ""
		if local[sub] {
			if hash, err := FileMD5(localPath); err == nil {
				localHash = hash
			}
		}

		if localHash != "" && localHash == remoteETag {
			if manifestETag == "" {
				manifest[key] = localHash
			}
			outcome.Skipped = append(outcome.Skipped, sub)
			continue
		}

		bothChanged := manifestETag != "" && localHash != "" &&
			localHash != manifestETag && remoteETag != manifestETag
		localAhead := manifestETag != "" && localHash != "" &&
			localHash != manifestETag && remoteETag == manifestETag

		if (bothChanged || localAhead) && !config.Force {
			reason := "local-ahead"
			if bothChanged {
				reason = "both-changed"
			}
			outcome.Conflicts = append(outcome.Conflicts, SyncConflict{
				Path: sub, Reason: reason, LocalHash: localHash,
				S3ETag: remoteETag, ManifestETag: manifestETag,
			})
			continue
		}

		body, etag, getErr := store.Get(ctx, key)
		if getErr != nil {
			outcome.Errors = append(outcome.Errors, SyncError{Path: sub, Error: getErr.Error()})
			continue
		}
		if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
			outcome.Errors = append(outcome.Errors, SyncError{Path: sub, Error: err.Error()})
			continue
		}
		if err := os.WriteFile(localPath, body, 0o644); err != nil {
			outcome.Errors = append(outcome.Errors, SyncError{Path: sub, Error: err.Error()})
			continue
		}
		if etag == "" {
			etag = remoteETag
		}
		manifest[key] = StripQuotes(etag)
		outcome.Moved = append(outcome.Moved, sub)
	}

	if err := SaveManifest(config.ManifestPath, manifest); err != nil {
		return outcome, err
	}
	return outcome, nil
}

// ErrNoBucket is the configuration error, kept distinct so a caller can tell
// "not set up" from "went wrong".
var ErrNoBucket = errors.New("S3_BUCKET not configured")

// Status reports what a sync WOULD do, per file, without moving anything.
//
// A port of getStatus() in lib/s3-sync.js. This is the preview behind the
// settings panel's list, and it is the only honest way to look before pushing:
// the states it names are the same ones Push and Pull act on, derived from the
// same three facts — the local hash, the manifest's record of the last agreed
// state, and what the bucket holds now.
func Status(ctx context.Context, store ObjectStore, config SyncConfig) (map[string]string, error) {
	manifest := ReadManifest(config.ManifestPath)
	objects, err := store.List(ctx, config.Prefix)
	if err != nil {
		return nil, err
	}

	result := map[string]string{}
	for _, walk := range config.ContentWalks() {
		for _, sub := range WalkAsS3Paths(walk.dir, walk.prefix, walk.allFiles) {
			key := config.ToS3Key(sub)
			localHash := ""
			if local := config.ToLocalPath(sub); local != "" {
				if hash, err := FileMD5(local); err == nil {
					localHash = hash
				}
			}
			manifestETag, hasManifest := manifest[key]
			s3ETag, onS3 := objects[key]

			switch {
			case !onS3 && !hasManifest:
				result[sub] = "local-only"
			case !onS3:
				// The manifest remembers agreeing on it, and it is gone: somebody
				// deleted it in the bucket.
				result[sub] = "deleted-on-s3"
			case localHash == s3ETag:
				result[sub] = "in-sync"
			case hasManifest && localHash != manifestETag && s3ETag != manifestETag:
				// Both sides moved since the last agreement. Neither is safe to
				// overwrite without somebody looking.
				result[sub] = "conflict"
			case hasManifest && localHash != manifestETag:
				result[sub] = "local-ahead"
			case hasManifest && s3ETag != manifestETag:
				result[sub] = "s3-ahead"
			default:
				result[sub] = "local-only"
			}
		}
	}

	for key := range objects {
		sub := config.FromS3Key(key)
		if sub == "" || result[sub] != "" || !config.SubInScope(sub) {
			continue
		}
		result[sub] = "s3-only"
	}
	return result, nil
}
