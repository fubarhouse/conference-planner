package js

import (
	"errors"
	"time"
)

// errBadDate is what an unparseable timestamp yields — the caller decides what
// to do about it, which is usually "leave the field out".
var errBadDate = errors.New("unparseable date")

// parseJSDate accepts the ISO forms the datasets hold. `new Date(x)` is far more
// permissive than this, but every startTime in the archive is a Z-stamped
// ISO 8601 instant and inventing a looser parser would only invent
// disagreements.
// ParseDate is `new Date(iso)` for the layouts this archive actually holds.
func ParseDate(iso string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339Nano, time.RFC3339,
		"2006-01-02T15:04:05.000Z", "2006-01-02T15:04:05Z",
		"2006-01-02T15:04Z", "2006-01-02T15:04:05", "2006-01-02",
	} {
		if parsed, err := time.Parse(layout, iso); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, errBadDate
}
