package planner

// Planner document I/O: S3-first, with local disk as fallback AND mirror.
//
// A port of `plannerRead`/`plannerWrite`/`plannerRemove`/`plannerList` from
// server.js. These are the single source of truth for reading and writing a
// whole planner document: the `/api/planner/*` routes use them, and so does the
// `/api/v1` planners domain, so the fallback logic lives in exactly one place.
//
// The asymmetry is deliberate and load-bearing. S3 is AUTHORITATIVE ON READ,
// because on this infrastructure the container's disk is ephemeral and a planner
// written before the last deploy is not there any more. Disk is a MIRROR on
// write, because a durable, auditable copy beside the object costs nothing and
// has answered "what did this look like before" more than once.
//
// A hard S3 failure is a 502. An unreachable or misconfigured one falls back to
// disk with a warning, which is what keeps a half-configured deployment usable
// rather than 502-ing every read.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/httpx"
	"server/internal/paths"
	"server/internal/schema"
	"server/internal/storage"
	"sort"
	"strings"
)

// PlannerStore is the planner half of the document layer.
type PlannerStore struct {
	LocalDir string              // PRIVATE_ROOT/planner, or PRIVATE_ROOT/planner/<user>
	Objects  storage.ObjectStore // nil when S3 is not configured
	S3Prefix string              // the bucket prefix, without the planners/ part
	UserID   string              // multi-user mode only; "" is the single-user install
	Schema   *schema.Validator
	Logger   *log.Logger
}

func (p *PlannerStore) Validator() *schema.Validator { return p.Schema }

func (p *PlannerStore) warn(format string, args ...any) {
	if p.Logger != nil {
		p.Logger.Printf(format, args...)
	}
}

// key is the object's full path in the bucket.
func (p *PlannerStore) key(docPath string) string {
	return strings.TrimSuffix(p.S3Prefix, "/") + "/" + storage.PlannerS3Prefix(p.UserID) + docPath
}

// userDir is where this caller's planners live locally. In multi-user mode each
// user's files are isolated, mirroring the planners/<user>/ layout in S3.
func (p *PlannerStore) userDir() string {
	if p.UserID != "" {
		return filepath.Join(p.LocalDir, p.UserID)
	}
	return p.LocalDir
}

// Read returns one planner document, S3 first.
func (p *PlannerStore) Read(docPath string) ([]byte, error) {
	if err := requireJSONPath(docPath); err != nil {
		return nil, err
	}
	if p.Objects != nil {
		body, _, err := p.Objects.Get(context.Background(), p.key(docPath))
		switch {
		case err == nil:
			return body, nil
		case storage.IsMissingObject(err):
			return nil, httpx.Error(http.StatusNotFound, "Not found")
		case !storage.IsUnavailable(err):
			return nil, httpx.Error(http.StatusBadGateway, err.Error())
		default:
			p.warn("[s3] read unavailable (%v) — serving planner from local disk", err)
		}
	}
	full := paths.SafeJoin(p.userDir(), docPath)
	if full == "" {
		return nil, httpx.Error(http.StatusBadRequest, "Invalid path")
	}
	body, err := os.ReadFile(full)
	if errors.Is(err, os.ErrNotExist) {
		return nil, httpx.Error(http.StatusNotFound, "Not found")
	}
	if err != nil {
		return nil, httpx.Error(http.StatusInternalServerError, err.Error())
	}
	return body, nil
}

// Write stores a planner, mirroring to disk when S3 took it.
func (p *PlannerStore) Write(docPath string, body []byte) error {
	if err := requireJSONPath(docPath); err != nil {
		return err
	}
	if p.Objects != nil {
		_, err := p.Objects.Put(context.Background(), p.key(docPath), body, "application/json")
		if err == nil {
			// Best-effort: a disk failure must never fail a save that already
			// succeeded in S3.
			if mirrorErr := p.diskWrite(docPath, body); mirrorErr != nil {
				p.warn("[disk] planner mirror write failed: %v", mirrorErr)
			}
			return nil
		}
		if !storage.IsUnavailable(err) {
			return httpx.Error(http.StatusBadGateway, err.Error())
		}
		p.warn("[s3] write unavailable (%v) — saving planner to local disk", err)
	}
	return p.diskWrite(docPath, body)
}

func (p *PlannerStore) diskWrite(docPath string, body []byte) error {
	full := paths.SafeJoin(p.userDir(), docPath)
	if full == "" {
		return httpx.Error(http.StatusBadRequest, "Invalid path")
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return httpx.Error(http.StatusInternalServerError, err.Error())
	}
	if err := os.WriteFile(full, body, 0o644); err != nil {
		return httpx.Error(http.StatusInternalServerError, err.Error())
	}
	return nil
}

// Remove deletes a planner, and its local mirror.
func (p *PlannerStore) Remove(docPath string) error {
	if err := requireJSONPath(docPath); err != nil {
		return err
	}
	// Deleting is not part of ObjectStore: the sync algorithm never removes an
	// object, and widening its interface for one caller would put a destructive
	// method on every stub that only ever needed to read. A store that CAN delete
	// says so by implementing ObjectDeleter.
	if deleter, ok := p.Objects.(storage.ObjectDeleter); ok && p.Objects != nil {
		err := deleter.Delete(context.Background(), p.key(docPath))
		if err == nil {
			// A missing mirror is fine; only real failures are worth a line.
			if mirrorErr := p.diskRemove(docPath); mirrorErr != nil &&
				httpx.StatusOf(mirrorErr) != http.StatusNotFound {
				p.warn("[disk] planner mirror delete failed: %v", mirrorErr)
			}
			return nil
		}
		if storage.IsMissingObject(err) {
			return httpx.Error(http.StatusNotFound, "Not found")
		}
		if !storage.IsUnavailable(err) {
			return httpx.Error(http.StatusBadGateway, err.Error())
		}
		p.warn("[s3] delete unavailable (%v) — deleting planner from local disk", err)
	}
	return p.diskRemove(docPath)
}

func (p *PlannerStore) diskRemove(docPath string) error {
	full := paths.SafeJoin(p.userDir(), docPath)
	if full == "" {
		return httpx.Error(http.StatusBadRequest, "Invalid path")
	}
	err := os.Remove(full)
	if errors.Is(err, os.ErrNotExist) {
		return httpx.Error(http.StatusNotFound, "Not found")
	}
	if err != nil {
		return httpx.Error(http.StatusInternalServerError, err.Error())
	}
	return nil
}

// List names every planner this caller has.
//
// No mkdir here. This is a READ, and it used to create the planner directory as
// a side effect — which fails outright on the read-only filesystem this path
// exists to support (immutable container, S3 authoritative), turning a listing
// into a 500. Writes still create what they need on the way past.
func (p *PlannerStore) List() ([]string, error) {
	if p.Objects != nil {
		prefix := p.key("")
		keys, err := p.Objects.List(context.Background(), prefix)
		if err == nil {
			var out []string
			for key := range keys {
				name := strings.TrimPrefix(key, prefix)
				if name != "" && strings.HasSuffix(name, ".json") {
					out = append(out, name)
				}
			}
			sort.Strings(out)
			return out, nil
		}
		if !storage.IsUnavailable(err) {
			return nil, httpx.Error(http.StatusBadGateway, err.Error())
		}
		p.warn("[s3] list unavailable (%v) — listing planners from local disk", err)
	}

	entries, err := os.ReadDir(p.userDir())
	if errors.Is(err, os.ErrNotExist) {
		// No local mirror is a legitimate state, not an error: with S3
		// authoritative the disk may hold nothing, and a fresh install has
		// written no planner yet. Either way the honest answer is "none".
		return []string{}, nil
	}
	if err != nil {
		return nil, httpx.Error(http.StatusInternalServerError, err.Error())
	}
	out := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			out = append(out, entry.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

func requireJSONPath(docPath string) error {
	if !strings.HasSuffix(docPath, ".json") {
		return httpx.Error(http.StatusBadRequest, "JSON files only")
	}
	return nil
}
