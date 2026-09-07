package storage

// Which S3 failures mean "carry on with local disk", and which mean "stop".
//
// A port of `s3Unavailable` in server.js. This distinction is the difference
// between a deployment that degrades and one that loses an edit: a request that
// falls back to disk on a CREDENTIALS error is doing the right thing, and one
// that falls back on a genuine write rejection has quietly told somebody their
// decision was saved when it was not.
//
// The Node version matches on `e.name`, `e.code`, `e.$metadata.httpStatusCode`
// and the message text. The Go SDK models the same conditions as typed API
// errors, so the codes are matched by name and the two families that have no
// code — networking and credentials — by their own error types.

import (
	"errors"
	"net"
	"strings"

	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// ErrNoBucket is declared in s3sync.go, where the sync algorithm that raises it
// lives. It counts as "unavailable" here: sync being off is a reason to use
// local disk, not a reason to fail a request.

// unavailableCodes are the API error codes that mean the bucket cannot answer
// right now, or is misconfigured: not that the object is absent.
var unavailableCodes = map[string]bool{
	"InvalidAccessKeyId":    true,
	"SignatureDoesNotMatch": true,
	"NoSuchBucket":          true,
	"NotFound":              true,
	"PermanentRedirect":     true,
	"AccessDenied":          true,
	"AllAccessDisabled":     true,
}

// IsUnavailable reports whether an error means "fall back to local disk".
func IsUnavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrNoBucket) {
		return true
	}

	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		if unavailableCodes[apiError.ErrorCode()] {
			return true
		}
	}

	// A redirect or a forbidden is a misconfiguration — the wrong region, or
	// credentials that cannot see this bucket — and both are recoverable by
	// serving from disk while somebody fixes the environment.
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) {
		if status := responseError.HTTPStatusCode(); status == 301 || status == 403 {
			return true
		}
	}

	// Credentials that cannot be resolved at all: no metadata service, no
	// environment, no profile.
	var credentialsError interface{ ProviderName() string }
	if errors.As(err, &credentialsError) {
		return true
	}
	if strings.Contains(strings.ToLower(err.Error()), "credential") {
		return true
	}

	// Networking: unreachable, refused, DNS, timeout.
	var netError net.Error
	if errors.As(err, &netError) {
		return true
	}
	var dnsError *net.DNSError
	var opError *net.OpError
	return errors.As(err, &dnsError) || errors.As(err, &opError)
}

// IsMissingObject reports the one condition that is NOT a failure: no object at
// that key yet.
//
// Kept separate from IsUnavailable because they lead to different places. A
// missing object falls through to disk and may be migrated up on the next write;
// an unavailable bucket falls through to disk and must be logged, because
// something is wrong.
func IsMissingObject(err error) bool {
	if err == nil {
		return false
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		return apiError.ErrorCode() == "NoSuchKey"
	}
	return false
}
