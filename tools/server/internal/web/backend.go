package web

// Building the whole backend from the environment.
//
// Every slice of this port has been provable on its own; this is the one place
// that says how they fit together, and it reads the same variables `server.js`
// reads so an installation configured for the Node server needs no new ones.
//
// Deliberately one function with no cleverness in it. The wiring is the part a
// person will read when something is not reachable, and a registry or a plugin
// system would hide exactly the thing they came here to find.

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/archive"
	"server/internal/archive/curation"
	"server/internal/auth"
	"server/internal/crud"
	"server/internal/paths"
	"server/internal/planner"
	"server/internal/schema"
	"server/internal/storage"
	"strings"
	"time"
)

// BackendRoots is where everything lives on disk.
type BackendRoots struct {
	App      string // app/ — pages, schemas, partials
	Data     string // DATA_ROOT
	Img      string // IMG_ROOT
	Private  string // PRIVATE_ROOT — planners, uploads, the curation ledger
	Manifest string // the sync manifest
}

// ResolveBackendRoots follows lib/roots.js.
func ResolveBackendRoots(dataDir, imgDir string) BackendRoots {
	private := paths.ResolvePrivateRoot("")
	if private == "" {
		// Not a fatal condition: an installation that has never written a planner
		// has no private root yet, and the first write creates it.
		private = paths.FirstNonEmpty(os.Getenv("PRIVATE_ROOT"), paths.EnvJoin("CONTENT_PATH", "private"))
	}
	app := strings.TrimSpace(os.Getenv("APP_ROOT"))
	if app == "" {
		// The datasets live under app/data in the default layout, so the app root
		// is the data root's parent unless somebody has moved one of them.
		app = filepath.Dir(dataDir)
	}
	return BackendRoots{
		App:      app,
		Data:     dataDir,
		Img:      imgDir,
		Private:  private,
		Manifest: filepath.Join(dataDir, ".s3-manifest.json"),
	}
}

// NewBackend assembles the server.
func NewBackend(roots BackendRoots, logger *log.Logger) (http.Handler, *ArchiveAPI) {
	mode := auth.DetectMode(os.Getenv)
	signer := auth.NewSessionSigner(os.Getenv("SESSION_SECRET"))
	authenticator := &auth.Authenticator{
		Mode:         mode,
		Signer:       signer,
		APITokenFile: filepath.Join(roots.Private, "api-token.json"),
	}
	schemas := schema.LoadSchemas(roots.App)

	// S3 is optional everywhere it appears. A store that will not open is not a
	// startup failure — the whole design is that a half-configured deployment
	// degrades to local disk rather than refusing to serve.
	settings := storage.ReadS3Settings(os.Getenv)
	var objects storage.ObjectStore
	if settings.Bucket != "" {
		store, err := storage.NewS3Store(context.Background(), settings)
		if err != nil {
			logger.Printf("[s3] could not open the bucket (%v) — running on local disk", err)
		} else {
			objects = store
		}
	}

	curationRoot := filepath.Join(roots.Private, "curation")
	decisions := &curation.DecisionStore{
		CurationRoot: curationRoot,
		Objects:      objects,
		S3Prefix:     settings.Prefix,
		Logger:       logger,
	}
	archiveAPI := &ArchiveAPI{
		DataDir:   roots.Data,
		ImgDir:    roots.Img,
		Decisions: decisions,
		Albums:    &AlbumResolver{DataDir: roots.Data},
	}

	// In multi-user mode planner files are isolated per user, mirroring the
	// planners/<uid>/ layout in S3. Resolved per request because it depends on
	// who is calling.
	plannerFor := func(r *http.Request) *planner.PlannerStore {
		userID := ""
		if mode == auth.ModeMulti && authenticator != nil {
			if user := authenticator.CheckAuth(r); user != nil {
				userID = user.UserID
			}
		}
		return &planner.PlannerStore{
			LocalDir: filepath.Join(roots.Private, "planner"),
			Objects:  objects,
			S3Prefix: settings.Prefix,
			UserID:   userID,
			Schema:   schemas.Planners,
			Logger:   logger,
		}
	}

	provenance := NewProvenance(roots.App, os.Getenv)
	datasets := &crud.DiskStore{Root: roots.Data, Schema: schemas.Datasets, Extension: ".json"}

	config := AppConfig{
		Mounts: []Mount{
			{Prefix: "/data", Dir: roots.Data},
			{Prefix: "/img", Dir: roots.Img},
		},
		Mode:          mode,
		Authenticator: authenticator,
		Logger:        logger,
		Login: &auth.LoginService{
			Mode:         mode,
			Signer:       signer,
			PasswordHash: os.Getenv("AUTH_PASSWORD_HASH"),
			AppRoot:      roots.App,
			Production:   os.Getenv("NODE_ENV") == "production",
			Limiter:      auth.NewLoginRateLimiter(),
		},
		Pages: &PageServer{
			AppRoot:      roots.App,
			Provenance:   provenance,
			PublicOrigin: os.Getenv("PUBLIC_ORIGIN"),
		},
		Archive: archiveAPI,
		Planner: &PlannerAPI{
			DataDir:  roots.Data,
			Schemas:  schemas,
			Planners: plannerFor,
			// Regenerated after every dataset write, so the read index never
			// describes an archive that no longer exists. In the background: the
			// editor is waiting for its save, not for the index.
			Catalog: func(reason string) {
				go func() {
					if _, err := archive.WriteCatalog(roots.Data, time.Now()); err != nil {
						logger.Printf("[catalog] regeneration after %s failed: %v", reason, err)
					}
				}()
			},
		},
		Feed: &FeedAPI{
			DataDir: roots.Data,
			Schemas: schemas,
			// Same index regeneration a hand save triggers: an import that
			// changed the programme has changed what the archive lists.
			Catalog: func(reason string) {
				go func() {
					if _, err := archive.WriteCatalog(roots.Data, time.Now()); err != nil {
						logger.Printf("[catalog] regeneration after %s failed: %v", reason, err)
					}
				}()
			},
		},
		Uploads: &UploadAPI{
			ImgDir:      roots.Img,
			ReceiptDir:  filepath.Join(roots.Private, "receipts"),
			DocumentDir: filepath.Join(roots.Private, "documents"),
			Objects:     objects,
			S3Prefix:    settings.Prefix,
			Logger:      logger,
		},
		Admin: &AdminAPI{
			Settings: settings,
			Roots: storage.SyncRoots{
				Data:      roots.Data,
				Img:       roots.Img,
				Planners:  filepath.Join(roots.Private, "planner"),
				Receipts:  filepath.Join(roots.Private, "receipts"),
				Documents: filepath.Join(roots.Private, "documents"),
				Curation:  curationRoot,
			},
			Manifest: roots.Manifest,
			AppRoot:  roots.App,
			Connect: func(ctx context.Context) (storage.ObjectStore, error) {
				if objects != nil {
					return objects, nil
				}
				return storage.NewS3Store(ctx, settings)
			},
			UserID: func(r *http.Request) string {
				if mode != auth.ModeMulti || authenticator == nil {
					return ""
				}
				if user := authenticator.CheckAuth(r); user != nil {
					return user.UserID
				}
				return ""
			},
		},
		Crud: &crud.CrudAPI{
			Datasets: datasets,
			Planners: &requestlessPlannerStore{resolve: plannerFor},
			Authorize: func(r *http.Request, minRole string) bool {
				if authenticator == nil {
					return true
				}
				user := authenticator.CheckAuth(r)
				return user != nil && auth.RoleAtLeast(user.Role, minRole)
			},
		},
	}
	return NewApp(config), archiveAPI
}

// requestlessPlannerStore adapts the per-request planner store to the CRUD
// engine's DocumentStore, which has no request to hand it.
//
// Single-user is the only mode the v1 planners domain supports today — the
// engine's interface predates multi-user, and inventing a user here would be
// worse than serving the shared one: it would silently read somebody else's
// trips. In multi-user mode this is the single-user root, which is empty.
type requestlessPlannerStore struct {
	resolve func(*http.Request) *planner.PlannerStore
}

func (s *requestlessPlannerStore) store() *planner.PlannerStore {
	return s.resolve(&http.Request{})
}

func (s *requestlessPlannerStore) List() ([]string, error)        { return s.store().List() }
func (s *requestlessPlannerStore) Read(p string) ([]byte, error)  { return s.store().Read(p) }
func (s *requestlessPlannerStore) Write(p string, b []byte) error { return s.store().Write(p, b) }
func (s *requestlessPlannerStore) Remove(p string) error          { return s.store().Remove(p) }
func (s *requestlessPlannerStore) Validator() *schema.Validator   { return s.store().Validator() }

// WarmInsights builds the archive shortly after boot, so the first reader is not
// the one paying for it. Never fatal — insights are a feature, not a
// precondition for serving the site.
func WarmInsights(api *ArchiveAPI, delay time.Duration) {
	go func() {
		time.Sleep(delay)
		api.WarmInsights(context.Background())
	}()
}
