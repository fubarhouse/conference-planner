package testsupport

// Test doubles for the object store.
//
// These live here rather than in storage's own test files because two packages
// need them: the sync algorithm's tests, and the admin routes' tests. Go cannot
// import another package's _test.go, and putting a bucket stub in the
// production package would ship it.

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"

	"sync"

	"github.com/aws/smithy-go"
)

// StubBucket is enough of S3 for both implementations to sync against: list,
// get, put, head. It exists so the conflict rules can be tested against the
// REAL client on the Node side without an account, a network, or the risk of
// two implementations meeting over live data.
type StubBucket struct {
	mu      sync.Mutex
	objects map[string][]byte
	name    string
}

func NewStubBucket(name string) *StubBucket {
	return &StubBucket{objects: map[string][]byte{}, name: name}
}

func (b *StubBucket) ETag(key string) string {
	sum := md5.Sum(b.objects[key])
	return hex.EncodeToString(sum[:])
}

func (b *StubBucket) Seed(key string, body []byte) { b.objects[key] = body }

func (b *StubBucket) Snapshot() map[string]string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := map[string]string{}
	for key, body := range b.objects {
		out[key] = string(body)
	}
	return out
}

func (b *StubBucket) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		defer b.mu.Unlock()

		path := strings.TrimPrefix(r.URL.Path, "/")
		bucket, key, _ := strings.Cut(path, "/")
		if bucket != b.name {
			http.Error(w, "no such bucket", http.StatusNotFound)
			return
		}

		switch {
		case r.Method == http.MethodGet && r.URL.Query().Get("list-type") == "2":
			b.list(w, r.URL.Query().Get("prefix"))
		case r.Method == http.MethodGet:
			body, found := b.objects[key]
			if !found {
				http.Error(w, "no such key", http.StatusNotFound)
				return
			}
			w.Header().Set("ETag", `"`+b.ETag(key)+`"`)
			_, _ = w.Write(body)
		case r.Method == http.MethodHead:
			if _, found := b.objects[key]; !found {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("ETag", `"`+b.ETag(key)+`"`)
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPut:
			body := make([]byte, 0)
			buffer := make([]byte, 32*1024)
			for {
				n, err := r.Body.Read(buffer)
				body = append(body, buffer[:n]...)
				if err != nil {
					break
				}
			}
			b.objects[key] = body
			w.Header().Set("ETag", `"`+b.ETag(key)+`"`)
			w.WriteHeader(http.StatusOK)
		default:
			http.Error(w, "unsupported", http.StatusMethodNotAllowed)
		}
	})
}

func (b *StubBucket) list(w http.ResponseWriter, prefix string) {
	keys := make([]string, 0, len(b.objects))
	for key := range b.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)

	var body strings.Builder
	body.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` +
		`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
		`<Name>` + b.name + `</Name><Prefix>` + prefix + `</Prefix>` +
		`<KeyCount>` + strconv.Itoa(len(keys)) + `</KeyCount><MaxKeys>1000</MaxKeys>` +
		`<IsTruncated>false</IsTruncated>`)
	for _, key := range keys {
		body.WriteString(`<Contents><Key>` + key + `</Key>` +
			`<ETag>&quot;` + b.ETag(key) + `&quot;</ETag>` +
			`<Size>` + strconv.Itoa(len(b.objects[key])) + `</Size>` +
			`<LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>`)
	}
	body.WriteString(`</ListBucketResult>`)
	w.Header().Set("Content-Type", "application/xml")
	_, _ = w.Write([]byte(body.String()))
}

// MemoryStore is the same bucket seen through the ObjectStore interface, so the
// Go side of a comparison reads and writes the very same objects the Node side
// does.
type MemoryStore struct{ Bucket *StubBucket }

func (m *MemoryStore) List(_ context.Context, prefix string) (map[string]string, error) {
	m.Bucket.mu.Lock()
	defer m.Bucket.mu.Unlock()
	out := map[string]string{}
	for key := range m.Bucket.objects {
		if strings.HasPrefix(key, prefix) {
			out[key] = m.Bucket.ETag(key)
		}
	}
	return out, nil
}

func (m *MemoryStore) Get(_ context.Context, key string) ([]byte, string, error) {
	m.Bucket.mu.Lock()
	defer m.Bucket.mu.Unlock()
	body, found := m.Bucket.objects[key]
	if !found {
		return nil, "", os.ErrNotExist
	}
	return body, m.Bucket.ETag(key), nil
}

func (m *MemoryStore) Put(_ context.Context, key string, body []byte, _ string) (string, error) {
	m.Bucket.mu.Lock()
	defer m.Bucket.mu.Unlock()
	m.Bucket.objects[key] = body
	return m.Bucket.ETag(key), nil
}

// Read returns one object's body, for a test asserting what a sync left behind.
func (b *StubBucket) Read(key string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.objects[key])
}

// Delete removes an object, so MemoryStore satisfies the optional
// ObjectDeleter the planner and upload routes look for.
//
// Deliberately NOT on the sync algorithm's interface: that never deletes, and a
// stub that can would let a bug there remove data in a test and look fine.
func (m *MemoryStore) Delete(_ context.Context, key string) error {
	m.Bucket.mu.Lock()
	defer m.Bucket.mu.Unlock()
	if _, found := m.Bucket.objects[key]; !found {
		return &StubAPIError{Code: "NoSuchKey"}
	}
	delete(m.Bucket.objects, key)
	return nil
}

// Snapshot is every object, as strings.
func (m *MemoryStore) Snapshot() map[string]string { return m.Bucket.Snapshot() }

// Seed writes an object directly, bypassing the store interface.
func (m *MemoryStore) Seed(key, body string) { m.Bucket.Seed(key, []byte(body)) }

// Read returns one object's body.
func (m *MemoryStore) Read(key string) string { return m.Bucket.Read(key) }

// StubAPIError is an SDK-shaped error with a code.
//
// It has to satisfy smithy.APIError exactly — an ErrorFault of the wrong type
// makes it a plain error, the classifier stops recognising the code, and a test
// then "proves" a classification that would never happen against a real bucket.
type StubAPIError struct{ Code string }

func (e *StubAPIError) Error() string                 { return e.Code }
func (e *StubAPIError) ErrorCode() string             { return e.Code }
func (e *StubAPIError) ErrorMessage() string          { return e.Code }
func (e *StubAPIError) ErrorFault() smithy.ErrorFault { return smithy.FaultServer }

var _ smithy.APIError = (*StubAPIError)(nil)

// NewMemoryStore is a bucket seen through the ObjectStore interface.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{Bucket: NewStubBucket("test-bucket")}
}
