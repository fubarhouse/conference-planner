package storage

// The S3 transport behind the sync algorithm.
//
// Deliberately thin. Everything that decides whether somebody's edit survives
// lives in s3sync.go and is tested against a stub bucket; this file is the part
// that needs an account, and it is kept small enough to read in one sitting.
//
// The SDK is here rather than a hand-rolled SigV4 signer because signing is the
// kind of thing that fails silently and intermittently — a request that works in
// every test and not against a bucket with a dot in its name.

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// S3Store is an ObjectStore backed by a real bucket.
type S3Store struct {
	client *s3.Client
	bucket string
}

// S3Settings is what the environment says about the bucket.
type S3Settings struct {
	Bucket   string
	Region   string
	Prefix   string
	Endpoint string
}

// ReadS3Settings mirrors cfg() and the endpoint resolution in lib/s3-sync.js,
// including the fallbacks — an installation configured for the Node server must
// need no new variables to run this one.
func ReadS3Settings(env func(string) string) S3Settings {
	first := func(names ...string) string {
		for _, name := range names {
			if value := strings.TrimSpace(env(name)); value != "" {
				return value
			}
		}
		return ""
	}
	region := first("S3_REGION", "AWS_REGION", "AWS_DEFAULT_REGION")
	if region == "" {
		region = "us-east-1"
	}
	return S3Settings{
		Bucket:   strings.TrimSpace(env("S3_BUCKET")),
		Region:   region,
		Prefix:   strings.TrimSpace(env("S3_PREFIX")),
		Endpoint: first("AWS_ENDPOINT_URL_S3", "AWS_ENDPOINT_URL", "S3_ENDPOINT"),
	}
}

// NewS3Store connects. It returns ErrNoBucket when nothing is configured, which
// callers treat as "sync is off" rather than as a failure.
func NewS3Store(ctx context.Context, settings S3Settings) (*S3Store, error) {
	if settings.Bucket == "" {
		return nil, ErrNoBucket
	}

	options := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(settings.Region)}
	// Static credentials when they are in the environment, so a container with
	// no metadata service still works — the same shape the Node client gets from
	// its default chain.
	if key, secret := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY"); key != "" && secret != "" {
		options = append(options, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(key, secret, os.Getenv("AWS_SESSION_TOKEN"))))
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if settings.Endpoint == "" {
			return
		}
		o.BaseEndpoint = aws.String(settings.Endpoint)
		// Path style for a local endpoint: `bucket.localhost` does not resolve,
		// and this is the same condition the JavaScript applies.
		if strings.Contains(settings.Endpoint, "localhost") ||
			strings.Contains(settings.Endpoint, "127.0.0.1") {
			o.UsePathStyle = true
		}
	})
	return &S3Store{client: client, bucket: settings.Bucket}, nil
}

// List returns every key under a prefix with its ETag, following continuation
// tokens — a bucket with more than a thousand objects is the normal case here,
// not an edge one.
func (s *S3Store) List(ctx context.Context, prefix string) (map[string]string, error) {
	out := map[string]string{}
	var token *string
	for {
		page, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: token,
		})
		if err != nil {
			return nil, err
		}
		for _, object := range page.Contents {
			if object.Key == nil {
				continue
			}
			etag := ""
			if object.ETag != nil {
				etag = StripQuotes(*object.ETag)
			}
			out[*object.Key] = etag
		}
		if page.IsTruncated == nil || !*page.IsTruncated {
			return out, nil
		}
		token = page.NextContinuationToken
	}
}

// Get fetches an object and its ETag.
func (s *S3Store) Get(ctx context.Context, key string) ([]byte, string, error) {
	response, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, "", err
	}
	etag := ""
	if response.ETag != nil {
		etag = StripQuotes(*response.ETag)
	}
	return body, etag, nil
}

// Put stores an object and returns the ETag the bucket assigned.
//
// The ETag comes from the PUT response rather than a follow-up HEAD: it is the
// same value, and a second round trip per object is a real cost when the
// archive has three thousand images in it. (The Node version does HEAD after
// every PUT. Worth revisiting there.)
func (s *S3Store) Put(ctx context.Context, key string, body []byte, contentType string) (string, error) {
	response, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", err
	}
	if response.ETag == nil {
		// Fall back to asking, rather than recording an empty ETag — a manifest
		// entry of "" would make the next sync think the object had changed.
		head, headErr := s.client.HeadObject(ctx, &s3.HeadObjectInput{
			Bucket: aws.String(s.bucket),
			Key:    aws.String(key),
		})
		if headErr != nil || head.ETag == nil {
			return "", headErr
		}
		return StripQuotes(*head.ETag), nil
	}
	return StripQuotes(*response.ETag), nil
}

// ObjectDeleter is the optional half of ObjectStore: a store that can remove an
// object as well as read and write one.
//
// Separate because the sync algorithm never deletes — it reconciles two sides by
// copying, and a bug in it should not be able to remove somebody's data. Only
// the planner routes, where a person explicitly deleted a trip, need this.
type ObjectDeleter interface {
	Delete(ctx context.Context, key string) error
}

// Delete removes one object.
func (s *S3Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	return err
}
