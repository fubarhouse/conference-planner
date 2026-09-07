package storage

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"net/http/httptest"
	ts "server/internal/testsupport"
	"testing"
)

// The transport, exercised through the REAL client against the stub bucket.
//
// s3sync_test.go proves the algorithm with an in-memory store; this proves the
// part that store stands in for — signing, path-style addressing, pagination
// and ETag handling all actually work.
func TestS3StoreAgainstAStubBucket(t *testing.T) {
	bucket := ts.NewStubBucket("test-bucket")
	server := httptest.NewServer(bucket.Handler())
	defer server.Close()

	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")

	store, err := NewS3Store(context.Background(), S3Settings{
		Bucket: "test-bucket", Region: "us-east-1", Endpoint: server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// An empty bucket lists as nothing, not as an error.
	listing, err := store.List(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing) != 0 {
		t.Errorf("an empty bucket listed %d objects", len(listing))
	}

	// Put returns the ETag the bucket assigned, which must be the MD5 the sync
	// algorithm compares against.
	body := []byte(`{"a":1}`)
	etag, err := store.Put(ctx, "data/events/a.json", body, "application/json")
	if err != nil {
		t.Fatal(err)
	}
	if etag != md5Hex(body) {
		t.Errorf("Put returned %q, want the content MD5 %q", etag, md5Hex(body))
	}

	// And it comes back the same way through both List and Get.
	listing, err = store.List(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if listing["data/events/a.json"] != etag {
		t.Errorf("List reported %q, want %q", listing["data/events/a.json"], etag)
	}

	fetched, fetchedETag, err := store.Get(ctx, "data/events/a.json")
	if err != nil {
		t.Fatal(err)
	}
	if string(fetched) != string(body) {
		t.Errorf("Get returned %q", fetched)
	}
	if fetchedETag != etag {
		t.Errorf("Get reported ETag %q, want %q", fetchedETag, etag)
	}

	// A prefix filters the listing.
	if _, err := store.Put(ctx, "img/logo.png", []byte("png"), "image/png"); err != nil {
		t.Fatal(err)
	}
	listing, err = store.List(ctx, "data/")
	if err != nil {
		t.Fatal(err)
	}
	if len(listing) != 1 {
		t.Errorf("a data/ listing returned %d objects, want 1", len(listing))
	}

	if _, _, err := store.Get(ctx, "no/such/key"); err == nil {
		t.Error("fetching a missing key should fail")
	}
}

// The whole sync, over the real client: the algorithm and the transport
// together, which is the combination that will run in production.
func TestPushAndPullThroughTheRealClient(t *testing.T) {
	bucket := ts.NewStubBucket("test-bucket")
	server := httptest.NewServer(bucket.Handler())
	defer server.Close()

	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	store, err := NewS3Store(context.Background(), S3Settings{
		Bucket: "test-bucket", Region: "us-east-1", Endpoint: server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}

	scenario := syncScenario{
		local: map[string]string{
			"public/events/a.json":    `{"a":1}`,
			"public/img/logo.png":     "a png, honestly",
			"private/planners/p.json": `{"p":1}`,
			"private/receipts/r.pdf":  "a pdf, honestly",
		},
	}
	root, _, manifestPath := scenario.setup(t)
	config := syncConfigFor(root, manifestPath, false)

	pushed, err := Push(context.Background(), store, config)
	if err != nil {
		t.Fatal(err)
	}
	if len(pushed.Moved) != 4 || len(pushed.Errors) != 0 {
		t.Fatalf("push moved %v with errors %v", pushed.Moved, pushed.Errors)
	}

	// Pushing again moves nothing: the manifest and the bucket now agree.
	again, err := Push(context.Background(), store, config)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Moved) != 0 || len(again.Skipped) != 4 {
		t.Errorf("a second push moved %v and skipped %v", again.Moved, again.Skipped)
	}

	// Into an empty tree, a pull restores everything byte for byte.
	restoreRoot := t.TempDir()
	restoreConfig := syncConfigFor(restoreRoot, restoreRoot+"/.s3-manifest.json", false)
	pulled, err := Pull(context.Background(), store, restoreConfig)
	if err != nil {
		t.Fatal(err)
	}
	if len(pulled.Moved) != 4 {
		t.Fatalf("pull moved %v", pulled.Moved)
	}
	original := snapshotTree(t, root)
	restored := snapshotTree(t, restoreRoot)
	for path, contents := range original {
		if restored[path] != contents {
			t.Errorf("%s: restored %q, original %q", path, restored[path], contents)
		}
	}

	// The content type follows the extension, which is what a browser fetching
	// an image straight from the bucket depends on.
	if got := ContentTypeFor("logo.png"); got != "image/png" {
		t.Errorf("ContentTypeFor(png) = %q", got)
	}
}

func TestReadS3SettingsFallbacks(t *testing.T) {
	env := func(pairs map[string]string) func(string) string {
		return func(name string) string { return pairs[name] }
	}

	settings := ReadS3Settings(env(map[string]string{}))
	if settings.Region != "us-east-1" || settings.Bucket != "" {
		t.Errorf("empty environment = %+v", settings)
	}

	settings = ReadS3Settings(env(map[string]string{"AWS_REGION": "eu-west-1"}))
	if settings.Region != "eu-west-1" {
		t.Errorf("AWS_REGION fallback = %q", settings.Region)
	}
	settings = ReadS3Settings(env(map[string]string{
		"S3_REGION": "ap-southeast-2", "AWS_REGION": "eu-west-1",
	}))
	if settings.Region != "ap-southeast-2" {
		t.Errorf("S3_REGION should win, got %q", settings.Region)
	}
	settings = ReadS3Settings(env(map[string]string{"S3_ENDPOINT": "http://localhost:9000"}))
	if settings.Endpoint != "http://localhost:9000" {
		t.Errorf("S3_ENDPOINT fallback = %q", settings.Endpoint)
	}
	settings = ReadS3Settings(env(map[string]string{"S3_BUCKET": "  spaced  "}))
	if settings.Bucket != "spaced" {
		t.Errorf("the bucket name should be trimmed, got %q", settings.Bucket)
	}

	if _, err := NewS3Store(context.Background(), S3Settings{}); err != ErrNoBucket {
		t.Errorf("no bucket configured should report ErrNoBucket, got %v", err)
	}
}

func md5Hex(body []byte) string {
	sum := md5.Sum(body)
	return hex.EncodeToString(sum[:])
}
