package web

// Uploads — receipts, documents and dataset images — plus the exchange-rate
// proxy and the error pages.
//
// The stored filename is ALWAYS server-generated. Only the extension comes from
// the upload, so a camera's `IMG_9999.jpg` can never land on disk, and neither
// can a name a caller chose. That is a naming decision as much as a security
// one: a receipts directory full of IMG_ files is unreadable a year later.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"server/internal/httpx"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/storage"
	"strconv"
	"strings"
	"time"
)

// UploadAPI stores and removes uploaded files.
type UploadAPI struct {
	ImgDir      string
	ReceiptDir  string
	DocumentDir string
	Objects     storage.ObjectStore // nil when S3 is not configured
	S3Prefix    string
	MaxBytes    int64
	Now         func() time.Time
	Logger      *log.Logger
	// Rates fetches upstream exchange rates. Injected so a test does not reach
	// the internet.
	Rates func(ctx context.Context, url string) (int, []byte, error)
}

func (u *UploadAPI) now() time.Time {
	if u.Now != nil {
		return u.Now()
	}
	return time.Now()
}

func (u *UploadAPI) warn(format string, args ...any) {
	if u.Logger != nil {
		u.Logger.Printf(format, args...)
	}
}

func (u *UploadAPI) maxBytes() int64 {
	if u.MaxBytes > 0 {
		return u.MaxBytes
	}
	return 25 << 20
}

// serveUploadAPI answers if the path is one of ours.
func serveUploadAPI(w http.ResponseWriter, r *http.Request, config AppConfig) bool {
	api := config.Uploads
	if api == nil {
		return false
	}
	path := r.URL.Path

	switch {
	case path == "/api/upload" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleImageUpload(w, r)
		}
		return true

	case path == "/api/receipts" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleStore(w, r, uploadTarget{dir: api.ReceiptDir, top: "receipts", prefix: "receipt"})
		}
		return true

	case path == "/api/documents" && r.Method == http.MethodPost:
		if requireRole(w, r, config, "editor") {
			api.handleStore(w, r, uploadTarget{dir: api.DocumentDir, top: "documents", prefix: "document"})
		}
		return true

	case strings.HasPrefix(path, "/api/receipts/") && r.Method == http.MethodDelete:
		if requireRole(w, r, config, "editor") {
			api.handleRemove(w, r, uploadTarget{dir: api.ReceiptDir, top: "receipts"},
				strings.TrimPrefix(path, "/api/receipts/"))
		}
		return true

	case strings.HasPrefix(path, "/api/documents/") && r.Method == http.MethodDelete:
		if requireRole(w, r, config, "editor") {
			api.handleRemove(w, r, uploadTarget{dir: api.DocumentDir, top: "documents"},
				strings.TrimPrefix(path, "/api/documents/"))
		}
		return true

	case path == "/api/rates" && isRead(r):
		api.handleRates(w, r)
		return true
	}
	return false
}

type uploadTarget struct{ dir, top, prefix string }

// ── Dataset images ──────────────────────────────────────────────────────────

// handleImageUpload stores a logo or sponsor image under the image root.
func (u *UploadAPI) handleImageUpload(w http.ResponseWriter, r *http.Request) {
	file, fields, problem := readUpload(r, u.maxBytes())
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	// `./img/x.png` and `img/x.png` are the same request — the editor writes the
	// first form because that is what a dataset stores.
	relative := strings.TrimPrefix(js.Trim(fields["targetPath"]), "./")
	if relative == "" || !strings.HasPrefix(relative, "img/") {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "targetPath must start with img/"))
		return
	}
	full := paths.SafeJoin(u.ImgDir, strings.TrimPrefix(relative, "img/"))
	if full == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid path"))
		return
	}
	if err := writeFileUnder(full, file.body); err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("ok", js.Bool(true)).
		Set("path", js.Str("./"+relative)))
}

// ── Receipts and documents ──────────────────────────────────────────────────

// handleStore saves a receipt or a document.
//
// S3-first when configured, so uploads persist across container redeploys,
// with a best-effort disk mirror beside the object.
func (u *UploadAPI) handleStore(w http.ResponseWriter, r *http.Request, target uploadTarget) {
	file, fields, problem := readUpload(r, u.maxBytes())
	if problem != nil {
		httpx.WriteError(w, problem)
		return
	}
	eventFile := js.Trim(fields["eventFile"])
	if eventFile == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "eventFile required"))
		return
	}
	slug := strings.TrimSuffix(eventFile, ".json")
	if paths.SafeJoin(target.dir, slug) == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid path"))
		return
	}

	if u.Objects != nil {
		relative, ok := u.resolveName(slug, fields["fileName"], file.name, target.prefix,
			func(rel string) bool { return u.objectExists(target.top + "/" + rel) })
		if !ok {
			httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Could not allocate filename"))
			return
		}
		_, err := u.Objects.Put(context.Background(), u.uploadKey(target.top, relative),
			file.body, storage.ContentTypeFor(relative))
		if err == nil {
			// Best-effort: a disk failure must not fail an upload that already
			// succeeded in S3.
			if mirrorErr := u.writeDisk(target.dir, relative, file.body); mirrorErr != nil {
				u.warn("[disk] %s mirror write failed: %v", target.top, mirrorErr)
			}
			httpx.WriteJSON(w, http.StatusOK, js.Obj().
				Set("ok", js.Bool(true)).
				Set("path", js.Str(target.top+"/"+relative)))
			return
		}
		if !storage.IsUnavailable(err) {
			httpx.WriteError(w, httpx.Error(http.StatusBadGateway, err.Error()))
			return
		}
		u.warn("[s3] upload unavailable (%v) — saving %s to local disk", err, target.top)
	}

	relative, ok := u.resolveName(slug, fields["fileName"], file.name, target.prefix,
		func(rel string) bool {
			full := paths.SafeJoin(target.dir, rel)
			if full == "" {
				return true // treat invalid as taken, so nothing is written outside the dir
			}
			_, err := os.Stat(full)
			return err == nil
		})
	if !ok {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Could not allocate filename"))
		return
	}
	if err := u.writeDisk(target.dir, relative, file.body); err != nil {
		httpx.WriteError(w, httpx.Error(httpx.StatusOf(err), err.Error()))
		return
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().
		Set("ok", js.Bool(true)).
		Set("path", js.Str(target.top+"/"+relative)))
}

// handleRemove deletes a stored file. A missing file is not an error —
// cleanup is idempotent, and a client retrying a delete should not see a
// failure for work already done.
func (u *UploadAPI) handleRemove(w http.ResponseWriter, r *http.Request,
	target uploadTarget, relative string) {
	if relative == "" || paths.SafeJoin(target.dir, relative) == "" {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid path"))
		return
	}
	if deleter, ok := u.Objects.(storage.ObjectDeleter); ok && u.Objects != nil {
		if err := deleter.Delete(r.Context(), u.uploadKey(target.top, relative)); err != nil &&
			!storage.IsMissingObject(err) && !storage.IsUnavailable(err) {
			httpx.WriteError(w, httpx.Error(http.StatusBadGateway, err.Error()))
			return
		}
	}
	if err := os.Remove(paths.SafeJoin(target.dir, relative)); err != nil &&
		!errors.Is(err, os.ErrNotExist) {
		u.warn("[disk] %s delete failed: %v", target.top, err)
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
}

func (u *UploadAPI) uploadKey(top, relative string) string {
	return strings.TrimSuffix(u.S3Prefix, "/") + "/" + top + "/" + relative
}

func (u *UploadAPI) objectExists(key string) bool {
	full := strings.TrimSuffix(u.S3Prefix, "/") + "/" + key
	keys, err := u.Objects.List(context.Background(), full)
	if err != nil {
		// An unreadable bucket must read as "taken": inventing a free slot here
		// would overwrite whatever is actually there.
		return true
	}
	_, exists := keys[full]
	return exists
}

func (u *UploadAPI) writeDisk(dir, relative string, body []byte) error {
	full := paths.SafeJoin(dir, relative)
	if full == "" {
		return httpx.Error(http.StatusBadRequest, "Invalid path")
	}
	return writeFileUnder(full, body)
}

func writeFileUnder(full string, body []byte) error {
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, body, 0o644)
}

var (
	unsafeNameChars = regexp.MustCompile(`[^a-zA-Z0-9._-]`)
	trimNameEdges   = regexp.MustCompile(`^[._-]+|[._-]+$`)
	fileExtension   = regexp.MustCompile(`\.([a-zA-Z0-9]+)$`)
)

// resolveName derives the stored filename.
//
// The base is the client's `fileName` — a sensible name derived from the
// description, like "conference-pass" — or, when that is absent, an
// autogenerated `<prefix>-<timestamp>`. Collisions get a `-2`, `-3`, … suffix so
// nothing is ever overwritten.
func (u *UploadAPI) resolveName(slug, fileName, originalName, prefix string,
	exists func(string) bool) (string, bool) {
	extension := ""
	if match := fileExtension.FindStringSubmatch(originalName); match != nil {
		extension = strings.ToLower(match[1])
	}
	base := trimNameEdges.ReplaceAllString(unsafeNameChars.ReplaceAllString(fileName, "_"), "")
	if base == "" {
		base = prefix
		if base == "" {
			base = "file"
		}
		base += "-" + u.now().Format("20060102-150405")
	}
	withExtension := func(name string) string {
		if extension == "" {
			return name
		}
		return name + "." + extension
	}

	candidate := withExtension(base)
	for suffix := 2; suffix < 1000; suffix++ {
		relative := slug + "/" + candidate
		if !exists(relative) {
			return relative, true
		}
		candidate = withExtension(base + "-" + strconv.Itoa(suffix))
	}
	return "", false
}

// ── Multipart reading ───────────────────────────────────────────────────────

type uploadedFile struct {
	name string
	body []byte
}

// readUpload pulls the single `file` part and the text fields beside it.
//
// Streamed through a limit rather than buffered whole: `multipart.ReadForm`
// would happily spool a caller's several gigabytes to a temp directory first.
func readUpload(r *http.Request, maxBytes int64) (*uploadedFile, map[string]string, *httpx.APIError) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, nil, httpx.Error(http.StatusBadRequest, "Expected a multipart upload")
	}
	fields := map[string]string{}
	var file *uploadedFile

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, httpx.Error(http.StatusBadRequest, err.Error())
		}
		if part.FormName() == "file" && part.FileName() != "" {
			body, err := io.ReadAll(io.LimitReader(part, maxBytes+1))
			part.Close()
			if err != nil {
				return nil, nil, httpx.Error(http.StatusBadRequest, err.Error())
			}
			if int64(len(body)) > maxBytes {
				// A rejected upload is the client's problem, not a server fault.
				return nil, nil, httpx.Error(http.StatusRequestEntityTooLarge, "File too large")
			}
			file = &uploadedFile{name: part.FileName(), body: body}
			continue
		}
		value, err := io.ReadAll(io.LimitReader(part, 64<<10))
		part.Close()
		if err != nil {
			return nil, nil, httpx.Error(http.StatusBadRequest, err.Error())
		}
		fields[part.FormName()] = string(value)
	}

	if file == nil {
		return nil, nil, httpx.Error(http.StatusBadRequest, "No file received")
	}
	return file, fields, nil
}

// ── Exchange rates ──────────────────────────────────────────────────────────

var (
	currencyCode = regexp.MustCompile(`^[A-Z]{3}$`)
	isoDate      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// handleRates proxies Frankfurter so the browser call is same-origin.
func (u *UploadAPI) handleRates(w http.ResponseWriter, r *http.Request) {
	base := strings.ToUpper(r.URL.Query().Get("base"))
	date := js.Trim(r.URL.Query().Get("date"))
	if !currencyCode.MatchString(base) {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid currency code"))
		return
	}
	if date != "" && !isoDate.MatchString(date) {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest, "Invalid date format, expected YYYY-MM-DD"))
		return
	}

	path := "/latest"
	if date != "" {
		path = "/" + date
	}
	status, body, err := u.fetchRates(r.Context(), "https://api.frankfurter.app"+path+"?base="+base)
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadGateway, err.Error()))
		return
	}
	if status < 200 || status > 299 {
		httpx.WriteError(w, httpx.Error(http.StatusBadGateway, "Upstream "+strconv.Itoa(status)))
		return
	}
	// Historical rates never change — cache them for a year; current rates
	// expire in an hour.
	if date != "" {
		w.Header().Set("Cache-Control", "public, max-age=31536000")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Passed through as received: this is a proxy, and re-encoding somebody
	// else's JSON is a way to change it by accident.
	if !json.Valid(body) {
		httpx.WriteError(w, httpx.Error(http.StatusBadGateway, "Upstream sent invalid JSON"))
		return
	}
	_, _ = w.Write(body)
}

func (u *UploadAPI) fetchRates(ctx context.Context, url string) (int, []byte, error) {
	if u.Rates != nil {
		return u.Rates(ctx, url)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, body, err
}
