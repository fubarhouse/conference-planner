// Package httpx is the small shared vocabulary of this server's HTTP layer: an
// error that carries a status, and the two functions that put a JSON body on the
// wire.
//
// It exists because three packages need the same answer to "how does a failure
// become a response" — the document stores, the CRUD engine and the route
// handlers — and an error type defined in any one of them would make the other
// two depend on it for no other reason.
package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"server/internal/js"
)

// APIError carries a status alongside a message.
type APIError struct {
	Status  int
	Message string
	Extra   map[string]any
}

func (e *APIError) Error() string { return e.Message }

func Error(status int, message string) *APIError {
	return &APIError{Status: status, Message: message}
}

func ReadBody(r *http.Request) (*js.Value, *APIError) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		return nil, Error(http.StatusBadRequest, "Could not read body")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	document, parseErr := js.ParseJSON(raw)
	if parseErr != nil {
		return nil, Error(http.StatusBadRequest, "Invalid JSON: "+parseErr.Error())
	}
	return document, nil
}

func WriteJSON(w http.ResponseWriter, status int, value *js.Value) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(value.Encode(""))
}

func WriteError(w http.ResponseWriter, err *APIError) {
	body := js.Obj().Set("error", js.Str(err.Message))
	for key, value := range err.Extra {
		switch typed := value.(type) {
		case string:
			body.Set(key, js.Str(typed))
		case json.RawMessage:
			if parsed, parseErr := js.ParseJSON(typed); parseErr == nil {
				body.Set(key, parsed)
			}
		}
	}
	WriteJSON(w, err.Status, body)
}

func NotFoundOr(err error) *APIError {
	if errors.Is(err, os.ErrNotExist) {
		return Error(http.StatusNotFound, "Not found")
	}
	return Error(http.StatusInternalServerError, err.Error())
}

// StatusOf is the status an error carries, or 500.
func StatusOf(err error) int {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return http.StatusInternalServerError
}
