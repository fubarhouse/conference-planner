import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, dirname, relative } from 'path';
import {
  ROOT,
  DATA_ROOT,
  IMG_ROOT,
  PLANNER_ROOT,
  RECEIPT_ROOT,
  DOCUMENT_ROOT,
  CURATION_ROOT,
} from './roots.js';

// Local disk layout comes from lib/roots.js. Only the LOCAL side of the mapping
// below is configurable — the S3 prefixes ('data/', 'img/', 'receipts/',
// 'documents/', 'planners/') are the bucket's layout and must not move with it,
// or every existing installation's objects become unreachable.
const DATA_DIR = DATA_ROOT;
const PLANNER_DIR = PLANNER_ROOT;
const IMG_DIR = IMG_ROOT;
const RECEIPT_DIR = RECEIPT_ROOT;
const DOCUMENT_DIR = DOCUMENT_ROOT;
const MANIFEST_PATH = join(ROOT, '.s3-manifest.json');

// The curation ledger's S3 home. Stays under `data/` even though the file is now
// private on disk — see toLocalPath and DECISIONS_SUBPATH below.
const CURATION_S3_PREFIX = 'data/curation/';

function awsRegion() {
  return (
    process.env.S3_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    process.env.AWS_DEFAULT_REGION?.trim() ||
    'us-east-1'
  );
}

function cfg() {
  return {
    bucket: process.env.S3_BUCKET?.trim() || '',
    region: awsRegion(),
    prefix: process.env.S3_PREFIX?.trim() || '',
  };
}

function requireBucket() {
  const { bucket } = cfg();
  if (!bucket)
    throw Object.assign(new Error('S3_BUCKET not configured'), { code: 'NOT_CONFIGURED' });
  return bucket;
}

function mkClient() {
  const { region } = cfg();
  const endpoint =
    process.env.AWS_ENDPOINT_URL_S3?.trim() ||
    process.env.AWS_ENDPOINT_URL?.trim() ||
    process.env.S3_ENDPOINT?.trim() ||
    undefined;
  const isLocal = endpoint && (endpoint.includes('localhost') || endpoint.includes('127.0.0.1'));
  return new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: isLocal } : {}) });
}

function stripQuotes(etag) {
  return etag ? etag.replace(/"/g, '').toLowerCase() : null;
}

async function md5(filePath) {
  return createHash('md5')
    .update(await readFile(filePath))
    .digest('hex');
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveManifest(m) {
  await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function contentTypeFor(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    json: 'application/json',
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    gpx: 'application/gpx+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function walkAsS3Paths(localDir, s3DirPrefix, allFiles = false) {
  const result = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (allFiles || e.name.endsWith('.json'))
        result.push(s3DirPrefix + relative(localDir, full).replace(/\\/g, '/'));
    }
  }
  await walk(localDir);
  return result;
}

// userId scoping:
//   single-user: planners/file.json  ↔  planner/file.json
//   multi-user:  planners/{uid}/file.json  ↔  planner/{uid}/file.json

function plannerS3Prefix(userId) {
  return userId ? `planners/${userId}/` : 'planners/';
}

function plannerLocalDir(userId) {
  return userId ? join(PLANNER_DIR, userId) : PLANNER_DIR;
}

function toLocalPath(s3SubPath, userId = null) {
  // MUST precede the `data/` case. The ledger keeps its S3 key under `data/` —
  // the bucket layout is a contract with every existing installation — but it no
  // longer lives in the public data tree locally. Without this, a pull would
  // happily write it back into DATA_DIR and quietly undo the move.
  if (s3SubPath.startsWith(CURATION_S3_PREFIX))
    return join(CURATION_ROOT, s3SubPath.slice(CURATION_S3_PREFIX.length));
  if (s3SubPath.startsWith('data/')) return join(DATA_DIR, s3SubPath.slice('data/'.length));
  if (s3SubPath.startsWith('img/')) return join(IMG_DIR, s3SubPath.slice('img/'.length));
  if (s3SubPath.startsWith('receipts/'))
    return join(RECEIPT_DIR, s3SubPath.slice('receipts/'.length));
  if (s3SubPath.startsWith('documents/'))
    return join(DOCUMENT_DIR, s3SubPath.slice('documents/'.length));
  const ps3 = plannerS3Prefix(userId);
  if (s3SubPath.startsWith(ps3)) return join(plannerLocalDir(userId), s3SubPath.slice(ps3.length));
  return null;
}

function toS3Key(s3SubPath) {
  return cfg().prefix + s3SubPath;
}

function fromS3Key(key, userId = null) {
  const { prefix } = cfg();
  if (!key.startsWith(prefix)) return null;
  const sub = key.slice(prefix.length);
  if (sub.startsWith('data/')) return sub;
  if (sub.startsWith('img/')) return sub;
  if (sub.startsWith('receipts/')) return sub;
  if (sub.startsWith('documents/')) return sub;
  const ps3 = plannerS3Prefix(userId);
  if (sub.startsWith(ps3)) return sub;
  return null;
}

async function listS3Objects(bucket, globalPrefix) {
  const c = mkClient();
  const map = {};
  let token;
  do {
    const r = await c.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: globalPrefix,
        ContinuationToken: token,
      }),
    );
    for (const o of r.Contents || []) {
      map[o.Key] = stripQuotes(o.ETag);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return map;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function testConnection() {
  const bucket = requireBucket();
  const { region } = cfg();
  await mkClient().send(new HeadBucketCommand({ Bucket: bucket }));
  return { bucket, region };
}

// ── Sync scope ────────────────────────────────────────────────────────────────
// Content areas grouped by origin: the editor owns event datasets + sponsor
// images; the planner owns planner state + its receipt/document uploads. `scope`
// ('all' | 'data' | 'planner') limits a sync to one side so the planner and the
// editor only push/pull their own content. Returns [localDir, s3SubPrefix, allFiles].
function contentWalks(userId, scope = 'all') {
  const editor = scope === 'all' || scope === 'data';
  const planner = scope === 'all' || scope === 'planner';
  const walks = [];
  if (editor) {
    walks.push([DATA_DIR, 'data/', false]);
    walks.push([IMG_DIR, 'img/', true]);
    // Walked separately because the ledger left the public data tree on disk but
    // kept its S3 key under `data/`. Dropping this would make the bulk sync stop
    // seeing a file it still lists in the bucket, so every status call would
    // report it as s3-only and a pull would try to "restore" it.
    walks.push([CURATION_ROOT, CURATION_S3_PREFIX, false]);
  }
  if (planner) {
    walks.push([plannerLocalDir(userId), plannerS3Prefix(userId), false]);
    walks.push([RECEIPT_DIR, 'receipts/', true]);
    walks.push([DOCUMENT_DIR, 'documents/', true]);
  }
  return walks;
}

// Whether an S3 sub-path belongs to `scope` (mirrors contentWalks) — used to
// filter the S3 object listing when detecting s3-only / s3-ahead files.
function subInScope(sub, scope, userId) {
  if (scope === 'all') return true;
  const editor = sub.startsWith('data/') || sub.startsWith('img/');
  const planner =
    sub.startsWith(plannerS3Prefix(userId)) ||
    sub.startsWith('receipts/') ||
    sub.startsWith('documents/');
  return scope === 'data' ? editor : planner;
}

export async function getStatus({ userId = null, scope = 'all' } = {}) {
  const bucket = requireBucket();
  const { prefix } = cfg();
  const walks = contentWalks(userId, scope);
  const [manifest, s3Objects, ...subPathLists] = await Promise.all([
    readManifest(),
    listS3Objects(bucket, prefix),
    ...walks.map(([dir, pfx, all]) => walkAsS3Paths(dir, pfx, all)),
  ]);
  const allLocal = subPathLists.flat();
  const result = {};

  for (const sub of allLocal) {
    const key = toS3Key(sub);
    const lp = toLocalPath(sub, userId);
    const localHash = lp ? await md5(lp).catch(() => null) : null;
    const manifestEtag = manifest[key] ?? null;
    const s3Etag = s3Objects[key] ?? null;

    if (!s3Etag && !manifestEtag) result[sub] = 'local-only';
    else if (!s3Etag) result[sub] = 'deleted-on-s3';
    else if (localHash === s3Etag) result[sub] = 'in-sync';
    else if (manifestEtag && localHash !== manifestEtag && s3Etag !== manifestEtag)
      result[sub] = 'conflict';
    else if (manifestEtag && localHash !== manifestEtag) result[sub] = 'local-ahead';
    else if (manifestEtag && s3Etag !== manifestEtag) result[sub] = 's3-ahead';
    else result[sub] = 'local-only';
  }

  for (const key of Object.keys(s3Objects)) {
    const sub = fromS3Key(key, userId);
    if (!sub || result[sub]) continue;
    if (!subInScope(sub, scope, userId)) continue;
    result[sub] = 's3-only';
  }

  return result;
}

export async function push({ force = false, userId = null, scope = 'all' } = {}) {
  const bucket = requireBucket();
  const walks = contentWalks(userId, scope);
  const [manifest, ...subPathLists] = await Promise.all([
    readManifest(),
    ...walks.map(([dir, pfx, all]) => walkAsS3Paths(dir, pfx, all)),
  ]);
  const allLocal = subPathLists.flat();
  const s3Objects = await listS3Objects(bucket, cfg().prefix);
  const c = mkClient();
  const pushed = [],
    skipped = [],
    conflicts = [],
    errors = [];

  for (const sub of allLocal) {
    const key = toS3Key(sub);
    const lp = toLocalPath(sub, userId);
    if (!lp) continue;
    try {
      const localHash = await md5(lp);
      const manifestEtag = manifest[key] ?? null;
      const s3Etag = s3Objects[key] ?? null;

      if (localHash === s3Etag) {
        if (!manifestEtag) manifest[key] = localHash;
        skipped.push(sub);
        continue;
      }

      const bothChanged =
        !!manifestEtag && localHash !== manifestEtag && !!s3Etag && s3Etag !== manifestEtag;
      const s3Ahead =
        !!manifestEtag && localHash === manifestEtag && !!s3Etag && s3Etag !== manifestEtag;

      if ((bothChanged || s3Ahead) && !force) {
        conflicts.push({
          path: sub,
          reason: bothChanged ? 'both-changed' : 's3-ahead',
          s3Etag,
          manifestEtag,
        });
        continue;
      }

      await c.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: await readFile(lp),
          ContentType: contentTypeFor(lp),
        }),
      );
      const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      manifest[key] = stripQuotes(head.ETag);
      pushed.push(sub);
    } catch (e) {
      errors.push({ path: sub, error: e.message });
    }
  }

  await saveManifest(manifest);
  return { pushed, skipped, conflicts, errors };
}

export async function pull({ force = false, userId = null, scope = 'all' } = {}) {
  const bucket = requireBucket();
  const walks = contentWalks(userId, scope);
  const [manifest, ...subPathLists] = await Promise.all([
    readManifest(),
    ...walks.map(([dir, pfx, all]) => walkAsS3Paths(dir, pfx, all)),
  ]);
  const localSet = new Set(subPathLists.flat());
  const s3Objects = await listS3Objects(bucket, cfg().prefix);
  const c = mkClient();
  const pulled = [],
    skipped = [],
    conflicts = [],
    errors = [];

  for (const [key, s3Etag] of Object.entries(s3Objects)) {
    const sub = fromS3Key(key, userId);
    if (!sub) continue;
    if (!subInScope(sub, scope, userId)) continue;
    const lp = toLocalPath(sub, userId);
    if (!lp) continue;
    try {
      const manifestEtag = manifest[key] ?? null;
      const localHash = localSet.has(sub) ? await md5(lp).catch(() => null) : null;

      if (localHash === s3Etag) {
        if (!manifestEtag) manifest[key] = localHash;
        skipped.push(sub);
        continue;
      }

      const bothChanged =
        !!manifestEtag && !!localHash && localHash !== manifestEtag && s3Etag !== manifestEtag;
      const localAhead =
        !!manifestEtag && !!localHash && localHash !== manifestEtag && s3Etag === manifestEtag;

      if ((bothChanged || localAhead) && !force) {
        conflicts.push({
          path: sub,
          reason: bothChanged ? 'both-changed' : 'local-ahead',
          localHash,
          s3Etag,
          manifestEtag,
        });
        continue;
      }

      const resp = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      await mkdir(dirname(lp), { recursive: true });
      await writeFile(lp, Buffer.concat(chunks));
      manifest[key] = stripQuotes(resp.ETag ?? s3Etag);
      pulled.push(sub);
    } catch (e) {
      errors.push({ path: sub, error: e.message });
    }
  }

  await saveManifest(manifest);
  return { pulled, skipped, conflicts, errors };
}

// ── Planner direct CRUD (bypasses local filesystem) ──────────────────────────

function safePlannerPath(filename) {
  if (!filename || filename.split('/').some((s) => s === '..' || s === '.')) return null;
  return filename;
}

export async function listPlannerFiles({ userId = null } = {}) {
  const bucket = requireBucket();
  const { prefix } = cfg();
  const s3Prefix = prefix + plannerS3Prefix(userId);
  const objects = await listS3Objects(bucket, s3Prefix);
  return Object.keys(objects)
    .map((key) => key.slice(s3Prefix.length))
    .filter((f) => f.endsWith('.json'));
}

export async function getPlanner(filename, { userId = null } = {}) {
  if (!safePlannerPath(filename))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  const resp = await mkClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function putPlanner(filename, content, { userId = null } = {}) {
  if (!safePlannerPath(filename))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  await mkClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: 'application/json',
    }),
  );
}

export async function deletePlanner(filename, { userId = null } = {}) {
  if (!safePlannerPath(filename))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  await mkClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// ── Receipt / document blob CRUD (bypasses local filesystem) ──────────────────
// Receipt and document uploads are binary blobs stored under the top-level
// `receipts/` and `documents/` S3 prefixes — the same layout the sync walker
// mirrors. Like the planner CRUD above, these hit S3 directly so an S3-backed
// deployment persists uploads across container redeploys instead of stranding
// them on ephemeral container disk.

function safeUploadPath(subPath) {
  if (
    !subPath ||
    (!subPath.startsWith('receipts/') && !subPath.startsWith('documents/')) ||
    subPath.split('/').some((s) => s === '..' || s === '.' || s === '')
  )
    return null;
  return subPath;
}

// True/false whether the object exists — used for upload-name collision checks.
export async function uploadExists(subPath) {
  if (!safeUploadPath(subPath))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  try {
    await mkClient().send(new HeadObjectCommand({ Bucket: bucket, Key: toS3Key(subPath) }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

export async function putUpload(subPath, body) {
  if (!safeUploadPath(subPath))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  await mkClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: toS3Key(subPath),
      Body: body,
      ContentType: contentTypeFor(subPath),
    }),
  );
}

export async function getUpload(subPath) {
  if (!safeUploadPath(subPath))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const resp = await mkClient().send(
    new GetObjectCommand({ Bucket: bucket, Key: toS3Key(subPath) }),
  );
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return { body: Buffer.concat(chunks), contentType: resp.ContentType || contentTypeFor(subPath) };
}

export async function deleteUpload(subPath) {
  if (!safeUploadPath(subPath))
    throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  await mkClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: toS3Key(subPath) }));
}

// ── Curation decisions (one small JSON, read and written directly) ────────────
// The curation ledger (CURATION_ROOT/decisions.json) is the archive's identity
// ledger: the
// aliases that merge speaker/sponsor spellings at read time. It is written by a
// human working through clusters, one decision at a time, and it is the only
// record of that work — the datasets themselves are never rewritten.
//
// The bulk sync walks DATA_DIR, so the file eventually reaches S3. "Eventually"
// is not durability: on a container filesystem a deploy between a decision and
// the next sync loses it. So this object gets the same S3-first treatment as
// planners and uploads — written through on every decision, read back on every
// request — rather than relying on a sweep to catch up.

// Unchanged by the move to a private local root: this is a BUCKET key, and every
// existing installation's object already lives here.
const DECISIONS_SUBPATH = CURATION_S3_PREFIX + 'decisions.json';

/** @returns {Promise<string|null>} the file's contents, or null if absent. */
export async function getDecisions() {
  const bucket = requireBucket();
  try {
    const resp = await mkClient().send(
      new GetObjectCommand({ Bucket: bucket, Key: toS3Key(DECISIONS_SUBPATH) }),
    );
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

export async function putDecisions(content) {
  const bucket = requireBucket();
  const r = await mkClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: toS3Key(DECISIONS_SUBPATH),
      Body: content,
      ContentType: 'application/json',
    }),
  );
  return { etag: stripQuotes(r.ETag) };
}
