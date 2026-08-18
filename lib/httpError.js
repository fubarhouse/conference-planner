// @ts-check
// A thrown error carrying an HTTP status (and optional extra JSON fields), so the
// document-I/O helpers and the generic CRUD engine can signal 400/404/422/… by
// throwing, and one place (sendError in crudApi.js / the route wrappers) turns
// them into responses.
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} message client-facing error message
   * @param {Record<string, any> | null} [extra] extra JSON fields to merge into the response body
   */
  constructor(status, message, extra = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    /** @type {Record<string, any> | undefined} */
    this.extra = extra || undefined;
  }
}
