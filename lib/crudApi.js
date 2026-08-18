// Generic, registry-driven CRUD engine for the versioned /api/v1 surface.
//
// One set of handlers serves BOTH domains (event `datasets`, per-user `planners`)
// and every nested collection in lib/resourceRegistry.js, by read-modify-writing
// the parent document. It's built as a factory that receives injected document I/O
// (matching this repo's DI convention) so the S3-first planner logic and the
// dataset/catalog logic stay in server.js and this module stays pure and testable.
//
// URL shape (document paths always end in `.json`, which disambiguates the split):
//   GET/PUT/POST/DELETE /api/v1/datasets/<path>.json                — whole document
//   GET                 /api/v1/datasets/<path>.json/<collection>   — list elements
//   POST                /api/v1/datasets/<path>.json/<collection>   — create element
//   GET/PUT/DELETE      /api/v1/datasets/<path>.json/<collection>/<id>
//   …and the same under /planners/<file>.json/<collection>[/id]

import express from 'express';
import { REGISTRY, resolveArray, ensureArray } from './resourceRegistry.js';
import { HttpError } from './httpError.js';

const DOMAIN_KEY = { datasets: 'dataset', planners: 'planner' };

function sendError(res, e) {
  if (e instanceof HttpError) {
    return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
  }
  console.error('[v1]', e);
  return res.status(500).json({ error: e.message });
}

// Wrap an async handler so any throw (incl. HttpError) becomes a JSON response.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

// Split the wildcard tail into the `.json` document path and the remaining nested
// resource path (e.g. "events/x.json/sponsors/acme" → { docPath, nested }).
function splitDocPath(rest) {
  const marker = '.json';
  const idx = rest.indexOf(marker);
  if (idx < 0) throw new HttpError(400, 'Path must reference a .json document');
  const docPath = rest.slice(0, idx + marker.length);
  let nested = rest.slice(idx + marker.length);
  if (nested.startsWith('/')) nested = nested.slice(1);
  return { docPath, nested };
}

// Resolve a nested path to its registry descriptor + optional element id. Matches
// the longest registered key that the nested path starts with (collection keys can
// contain slashes, e.g. "personal/outbound-legs"). Throws 404 for an unknown one.
function matchCollection(domainKey, nested) {
  const desc = REGISTRY.filter(
    (r) => r.domain === domainKey && (nested === r.key || nested.startsWith(`${r.key}/`)),
  ).sort((a, b) => b.key.length - a.key.length)[0];
  if (!desc) throw new HttpError(404, `Unknown collection: ${nested}`);
  const id = nested === desc.key ? null : nested.slice(desc.key.length + 1);
  return { desc, id };
}

function parseBody(req) {
  if (req.body == null || req.body === '') return null;
  if (typeof req.body !== 'string') return req.body;
  try {
    return JSON.parse(req.body);
  } catch (e) {
    throw new HttpError(400, `Invalid JSON: ${e.message}`);
  }
}

export function createV1Router(deps) {
  const { requireRole, datasets, planners } = deps;
  const io = { datasets, planners };
  const router = express.Router();
  const textBody = express.text({ type: () => true, limit: '10mb' });

  async function readParsed(api, docPath, req) {
    const raw = await api.read(docPath, req);
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(500, 'Stored document is not valid JSON');
    }
  }

  // Validate the whole (possibly mutated) document, then persist it pretty-printed.
  async function persist(api, docPath, obj, req) {
    const { valid, errors } = api.validate(obj);
    if (!valid) {
      throw new HttpError(422, 'validation_failed', {
        message: 'Document failed schema validation',
        errors,
      });
    }
    return api.write(docPath, `${JSON.stringify(obj, null, 2)}\n`, req);
  }

  // Validate a document WITHOUT storing it: POST /api/v1/validate[?domain=…].
  //
  // The point is a data repository that lives outside this app. It holds the
  // files; the app holds the schema that defines what a valid file is. This is
  // how the two meet without the data repo vendoring a copy of the schema that
  // silently goes stale.
  //
  // Answers 200 whether or not the document is valid. The REQUEST succeeded — the
  // verdict is `valid` in the body. A 422 here would conflate "your document is
  // wrong" with "your call was wrong", and a CI job cannot tell those apart from
  // a status code alone. (Writes still 422, because there the document being
  // wrong genuinely is the request failing.)
  //
  // Read-only and side-effect free, so `viewer` is the right bar: it needs no
  // more privilege than fetching the schema from /schemas/, which is already
  // public — the role is here for rate limiting and consistency, not secrecy.
  router.post(
    '/validate',
    requireRole('viewer'),
    textBody,
    wrap(async (req, res) => {
      const domain = String(req.query.domain || 'datasets');
      const api = io[domain];
      if (!api) {
        throw new HttpError(400, `Unknown domain: ${domain}. Expected 'datasets' or 'planners'.`);
      }
      const body = parseBody(req);
      if (body == null) throw new HttpError(400, 'Body required: send the document to validate');
      const { valid, errors } = api.validate(body);
      res.json({
        valid,
        errors,
        domain,
        // Lets a data repo pin the schema it validated against and notice when it
        // moves, instead of discovering a tightened rule as a mass failure.
        schemaFingerprint: api.schemaFingerprint ?? null,
      });
    }),
  );

  for (const domain of ['datasets', 'planners']) {
    const domainKey = DOMAIN_KEY[domain];
    const api = io[domain];

    // List documents in the domain.
    router.get(
      `/${domain}`,
      requireRole('viewer'),
      wrap(async (req, res) => res.json(await api.list(req))),
    );

    // Read: whole document, a collection, or a single element.
    router.get(
      `/${domain}/*`,
      requireRole('viewer'),
      wrap(async (req, res) => {
        const { docPath, nested } = splitDocPath(req.params[0]);
        if (!nested) return res.type('application/json').send(await api.read(docPath, req));
        const { desc, id } = matchCollection(domainKey, nested);
        const doc = await readParsed(api, docPath, req);
        const arr = resolveArray(doc, desc.pointer) || [];
        if (id == null) return res.json(arr);
        const el = arr.find((x) => x && x.id === id);
        if (!el) throw new HttpError(404, `No ${desc.key} with id ${id}`);
        res.json(el);
      }),
    );

    // Create: a whole document, or an element appended to a collection.
    router.post(
      `/${domain}/*`,
      requireRole('editor'),
      textBody,
      wrap(async (req, res) => {
        const { docPath, nested } = splitDocPath(req.params[0]);
        const body = parseBody(req);
        if (!nested) {
          await persist(api, docPath, body, req);
          return res.status(201).json({ ok: true, path: docPath });
        }
        const { desc, id } = matchCollection(domainKey, nested);
        if (id != null) throw new HttpError(405, 'Cannot POST to a specific element; use PUT');
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new HttpError(400, 'Body must be a JSON object');
        const doc = await readParsed(api, docPath, req);
        const arr = ensureArray(doc, desc.pointer);
        const el = { ...body };
        el.id = typeof el.id === 'string' && el.id ? el.id : desc.mintId(el);
        arr.push(el);
        await persist(api, docPath, doc, req);
        res.status(201).json(el);
      }),
    );

    // Replace: a whole document, or a single element (id preserved).
    router.put(
      `/${domain}/*`,
      requireRole('editor'),
      textBody,
      wrap(async (req, res) => {
        const { docPath, nested } = splitDocPath(req.params[0]);
        const body = parseBody(req);
        if (!nested) {
          await persist(api, docPath, body, req);
          return res.json({ ok: true, path: docPath });
        }
        const { desc, id } = matchCollection(domainKey, nested);
        if (id == null)
          throw new HttpError(
            405,
            'Cannot PUT a whole collection; PUT an element or POST to create',
          );
        if (!body || typeof body !== 'object' || Array.isArray(body))
          throw new HttpError(400, 'Body must be a JSON object');
        const doc = await readParsed(api, docPath, req);
        const arr = resolveArray(doc, desc.pointer);
        const i = arr ? arr.findIndex((x) => x && x.id === id) : -1;
        if (i < 0) throw new HttpError(404, `No ${desc.key} with id ${id}`);
        const el = { ...body, id };
        arr[i] = el;
        await persist(api, docPath, doc, req);
        res.json(el);
      }),
    );

    // Delete: a whole document, or a single element.
    router.delete(
      `/${domain}/*`,
      requireRole('editor'),
      wrap(async (req, res) => {
        const { docPath, nested } = splitDocPath(req.params[0]);
        if (!nested) {
          await api.remove(docPath, req);
          return res.json({ ok: true });
        }
        const { desc, id } = matchCollection(domainKey, nested);
        if (id == null) throw new HttpError(405, 'Cannot DELETE a whole collection');
        const doc = await readParsed(api, docPath, req);
        const arr = resolveArray(doc, desc.pointer);
        const i = arr ? arr.findIndex((x) => x && x.id === id) : -1;
        if (i < 0) throw new HttpError(404, `No ${desc.key} with id ${id}`);
        arr.splice(i, 1);
        await persist(api, docPath, doc, req);
        res.json({ ok: true });
      }),
    );
  }

  return router;
}
