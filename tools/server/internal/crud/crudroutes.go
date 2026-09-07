package crud

// The /api/v1 HTTP surface — a Go port of the router in lib/crudApi.js.
//
// One set of handlers serves both domains and every nested collection, driven by
// the registry. The document I/O is injected, exactly as it is in the
// JavaScript: the S3-first planner logic lives in the server, not here, and this
// stays a thing that can be pointed at a temporary directory in a test.
//
//	GET/PUT/POST/DELETE /api/v1/datasets/<path>.json                whole document
//	GET                 /api/v1/datasets/<path>.json/<collection>   list elements
//	POST                /api/v1/datasets/<path>.json/<collection>   create
//	GET/PUT/DELETE      /api/v1/datasets/<path>.json/<collection>/<id>
//	POST                /api/v1/validate[?domain=…]                 verdict only

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"server/internal/httpx"
	"server/internal/js"
	"server/internal/paths"
	"server/internal/schema"
	"sort"
	"strings"
	"time"
)

// DocumentStore is one domain's document I/O.
type DocumentStore interface {
	List() ([]string, error)
	Read(docPath string) ([]byte, error)
	Write(docPath string, body []byte) error
	Remove(docPath string) error
	Validator() *schema.Validator
}

// CrudAPI serves the versioned surface.
type CrudAPI struct {
	Datasets DocumentStore
	Planners DocumentStore
	// Authorize decides whether a request may proceed at a role. Injected so the
	// routes do not have to know how identity is established.
	Authorize func(r *http.Request, minRole string) bool
	Now       func() time.Time
}

func (a *CrudAPI) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

func (a *CrudAPI) storeFor(domain string) (DocumentStore, Domain, bool) {
	switch domain {
	case "datasets":
		return a.Datasets, DomainDataset, a.Datasets != nil
	case "planners":
		return a.Planners, DomainPlanner, a.Planners != nil
	}
	return nil, "", false
}

// Handler mounts the surface at /api/v1/.
func (a *CrudAPI) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/v1/")
		if rest == r.URL.Path {
			httpx.WriteError(w, httpx.Error(http.StatusNotFound, "Not found"))
			return
		}

		if rest == "validate" {
			a.handleValidate(w, r)
			return
		}

		domain, tail, _ := strings.Cut(rest, "/")
		store, domainKey, ok := a.storeFor(domain)
		if !ok {
			httpx.WriteError(w, httpx.Error(http.StatusNotFound,
				"Unknown domain: "+domain+". Expected 'datasets' or 'planners'."))
			return
		}

		if tail == "" {
			a.handleList(w, r, store)
			return
		}

		if err := a.dispatch(w, r, store, domainKey, tail); err != nil {
			httpx.WriteError(w, err)
		}
	})
}

func (a *CrudAPI) dispatch(w http.ResponseWriter, r *http.Request, store DocumentStore,
	domainKey Domain, tail string) *httpx.APIError {

	role := "viewer"
	if r.Method != http.MethodGet {
		role = "editor"
	}
	if a.Authorize != nil && !a.Authorize(r, role) {
		return httpx.Error(http.StatusUnauthorized, "Unauthorized")
	}

	docPath, nested, err := SplitDocPath(tail)
	if err != nil {
		return httpx.Error(http.StatusBadRequest, "Path must reference a .json document")
	}

	switch r.Method {
	case http.MethodGet:
		return a.handleGet(w, store, domainKey, docPath, nested)
	case http.MethodPost:
		return a.handlePost(w, r, store, domainKey, docPath, nested)
	case http.MethodPut:
		return a.handlePut(w, r, store, domainKey, docPath, nested)
	case http.MethodDelete:
		return a.handleDelete(w, store, domainKey, docPath, nested)
	}
	return httpx.Error(http.StatusMethodNotAllowed, "Method not allowed")
}

func (a *CrudAPI) handleList(w http.ResponseWriter, r *http.Request, store DocumentStore) {
	if a.Authorize != nil && !a.Authorize(r, "viewer") {
		httpx.WriteError(w, httpx.Error(http.StatusUnauthorized, "Unauthorized"))
		return
	}
	documents, err := store.List()
	if err != nil {
		httpx.WriteError(w, httpx.Error(http.StatusInternalServerError, err.Error()))
		return
	}
	sort.Strings(documents)
	list := js.Arr()
	for _, name := range documents {
		list.Append(js.Str(name))
	}
	httpx.WriteJSON(w, http.StatusOK, list)
}

// handleValidate answers 200 whether or not the document is valid.
//
// The REQUEST succeeded; the verdict is in the body. A 422 here would conflate
// "your document is wrong" with "your call was wrong", and a CI job cannot tell
// those apart from a status code. Writes still 422, because there the document
// being wrong genuinely is the request failing.
func (a *CrudAPI) handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.WriteError(w, httpx.Error(http.StatusMethodNotAllowed, "Method not allowed"))
		return
	}
	if a.Authorize != nil && !a.Authorize(r, "viewer") {
		httpx.WriteError(w, httpx.Error(http.StatusUnauthorized, "Unauthorized"))
		return
	}

	domain := r.URL.Query().Get("domain")
	if domain == "" {
		domain = "datasets"
	}
	store, _, ok := a.storeFor(domain)
	if !ok {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest,
			"Unknown domain: "+domain+". Expected 'datasets' or 'planners'."))
		return
	}

	body, err := httpx.ReadBody(r)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if body == nil {
		httpx.WriteError(w, httpx.Error(http.StatusBadRequest,
			"Body required: send the document to validate"))
		return
	}

	result := store.Validator().Validate(body)
	out := result.Value().
		Set("domain", js.Str(domain)).
		// Lets a data repo pin the schema it validated against and notice when
		// it moves, instead of meeting a tightened rule as a mass failure.
		Set("schemaFingerprint", js.Str(store.Validator().Fingerprint))
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (a *CrudAPI) handleGet(w http.ResponseWriter, store DocumentStore,
	domainKey Domain, docPath, nested string) *httpx.APIError {

	if nested == "" {
		raw, err := store.Read(docPath)
		if err != nil {
			return httpx.NotFoundOr(err)
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(raw)
		return nil
	}

	collection, id, err := MatchCollection(domainKey, nested)
	if err != nil {
		return httpx.Error(http.StatusNotFound, "Unknown collection: "+nested)
	}
	document, apiErr := a.readParsed(store, docPath)
	if apiErr != nil {
		return apiErr
	}
	array := ResolveArray(document, collection.Pointer)
	if array == nil {
		array = js.Arr()
	}
	if id == "" {
		httpx.WriteJSON(w, http.StatusOK, array)
		return nil
	}
	index := FindElement(array, id)
	if index < 0 {
		return httpx.Error(http.StatusNotFound, "No "+collection.Key+" with id "+id)
	}
	httpx.WriteJSON(w, http.StatusOK, array.Items()[index])
	return nil
}

func (a *CrudAPI) handlePost(w http.ResponseWriter, r *http.Request, store DocumentStore,
	domainKey Domain, docPath, nested string) *httpx.APIError {

	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}

	if nested == "" {
		if apiErr := a.persist(store, docPath, body); apiErr != nil {
			return apiErr
		}
		httpx.WriteJSON(w, http.StatusCreated,
			js.Obj().Set("ok", js.Bool(true)).Set("path", js.Str(docPath)))
		return nil
	}

	collection, id, matchErr := MatchCollection(domainKey, nested)
	if matchErr != nil {
		return httpx.Error(http.StatusNotFound, "Unknown collection: "+nested)
	}
	if id != "" {
		return httpx.Error(http.StatusMethodNotAllowed,
			"Cannot POST to a specific element; use PUT")
	}
	if body == nil || !body.IsObject() {
		return httpx.Error(http.StatusBadRequest, "Body must be a JSON object")
	}

	document, apiErr := a.readParsed(store, docPath)
	if apiErr != nil {
		return apiErr
	}
	array := EnsureArray(document, collection.Pointer)
	element := body
	if element.Get("id").Str() == "" {
		element.Set("id", js.Str(collection.MintID(element, a.now())))
	}
	array.Append(element)

	if apiErr := a.persist(store, docPath, document); apiErr != nil {
		return apiErr
	}
	httpx.WriteJSON(w, http.StatusCreated, element)
	return nil
}

func (a *CrudAPI) handlePut(w http.ResponseWriter, r *http.Request, store DocumentStore,
	domainKey Domain, docPath, nested string) *httpx.APIError {

	body, err := httpx.ReadBody(r)
	if err != nil {
		return err
	}

	if nested == "" {
		if apiErr := a.persist(store, docPath, body); apiErr != nil {
			return apiErr
		}
		httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)).Set("path", js.Str(docPath)))
		return nil
	}

	collection, id, matchErr := MatchCollection(domainKey, nested)
	if matchErr != nil {
		return httpx.Error(http.StatusNotFound, "Unknown collection: "+nested)
	}
	if id == "" {
		return httpx.Error(http.StatusMethodNotAllowed,
			"Cannot PUT a whole collection; PUT an element or POST to create")
	}
	if body == nil || !body.IsObject() {
		return httpx.Error(http.StatusBadRequest, "Body must be a JSON object")
	}

	document, apiErr := a.readParsed(store, docPath)
	if apiErr != nil {
		return apiErr
	}
	array := ResolveArray(document, collection.Pointer)
	index := -1
	if array != nil {
		index = FindElement(array, id)
	}
	if index < 0 {
		return httpx.Error(http.StatusNotFound, "No "+collection.Key+" with id "+id)
	}
	// The id is the address, not part of the payload: a PUT that carried a
	// different one would move the element rather than replace it.
	body.Set("id", js.Str(id))
	ReplaceElement(array, index, body)

	if apiErr := a.persist(store, docPath, document); apiErr != nil {
		return apiErr
	}
	httpx.WriteJSON(w, http.StatusOK, body)
	return nil
}

func (a *CrudAPI) handleDelete(w http.ResponseWriter, store DocumentStore,
	domainKey Domain, docPath, nested string) *httpx.APIError {

	if nested == "" {
		if err := store.Remove(docPath); err != nil {
			return httpx.NotFoundOr(err)
		}
		httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
		return nil
	}

	collection, id, matchErr := MatchCollection(domainKey, nested)
	if matchErr != nil {
		return httpx.Error(http.StatusNotFound, "Unknown collection: "+nested)
	}
	if id == "" {
		return httpx.Error(http.StatusMethodNotAllowed, "Cannot DELETE a whole collection")
	}

	document, apiErr := a.readParsed(store, docPath)
	if apiErr != nil {
		return apiErr
	}
	array := ResolveArray(document, collection.Pointer)
	index := -1
	if array != nil {
		index = FindElement(array, id)
	}
	if index < 0 {
		return httpx.Error(http.StatusNotFound, "No "+collection.Key+" with id "+id)
	}
	RemoveElement(array, index)

	if apiErr := a.persist(store, docPath, document); apiErr != nil {
		return apiErr
	}
	httpx.WriteJSON(w, http.StatusOK, js.Obj().Set("ok", js.Bool(true)))
	return nil
}

func (a *CrudAPI) readParsed(store DocumentStore, docPath string) (*js.Value, *httpx.APIError) {
	raw, err := store.Read(docPath)
	if err != nil {
		return nil, httpx.NotFoundOr(err)
	}
	document, parseErr := js.ParseJSON(raw)
	if parseErr != nil {
		return nil, httpx.Error(http.StatusInternalServerError, "Stored document is not valid JSON")
	}
	return document, nil
}

// persist validates the whole document and only then writes it. The validation
// is not advisory: this is the last point at which a bad write can be refused.
func (a *CrudAPI) persist(store DocumentStore, docPath string, document *js.Value) *httpx.APIError {
	if document == nil {
		return httpx.Error(http.StatusBadRequest, "Body required")
	}
	result := store.Validator().Validate(document)
	if !result.Valid {
		errorList := result.Value().Get("errors")
		return &httpx.APIError{
			Status:  422,
			Message: "validation_failed",
			Extra: map[string]any{
				"message": "Document failed schema validation",
				"errors":  json.RawMessage(errorList.Encode("")),
			},
		}
	}
	if err := store.Write(docPath, EncodeDocument(document)); err != nil {
		return httpx.Error(http.StatusInternalServerError, err.Error())
	}
	return nil
}

// ── A disk-backed store ─────────────────────────────────────────────────────

// DiskStore is documents in a directory tree.
type DiskStore struct {
	Root      string
	Schema    *schema.Validator
	Extension string // ".json"
}

func (s *DiskStore) Validator() *schema.Validator { return s.Schema }

func (s *DiskStore) resolve(docPath string) (string, error) {
	full := paths.SafeJoin(s.Root, docPath)
	if full == "" {
		return "", os.ErrNotExist
	}
	return full, nil
}

func (s *DiskStore) List() ([]string, error) {
	var out []string
	err := filepath.WalkDir(s.Root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipAll
			}
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return nil
		}
		relative, relErr := filepath.Rel(s.Root, path)
		if relErr != nil {
			return nil
		}
		out = append(out, filepath.ToSlash(relative))
		return nil
	})
	return out, err
}

func (s *DiskStore) Read(docPath string) ([]byte, error) {
	full, err := s.resolve(docPath)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(full)
}

func (s *DiskStore) Write(docPath string, body []byte) error {
	full, err := s.resolve(docPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, body, 0o644)
}

func (s *DiskStore) Remove(docPath string) error {
	full, err := s.resolve(docPath)
	if err != nil {
		return err
	}
	return os.Remove(full)
}
