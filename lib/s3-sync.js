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
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APP = join(ROOT, 'app');
const DATA_DIR = join(APP, 'data');
const PLANNER_DIR = join(APP, 'planner');
const IMG_DIR = join(APP, 'img');
const RECEIPT_DIR = join(APP, 'receipts');
const DOCUMENT_DIR = join(APP, 'documents');
const MANIFEST_PATH = join(ROOT, '.s3-manifest.json');

function awsRegion() {
  return process.env.S3_REGION?.trim()
    || process.env.AWS_REGION?.trim()
    || process.env.AWS_DEFAULT_REGION?.trim()
    || 'us-east-1';
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
  if (!bucket) throw Object.assign(new Error('S3_BUCKET not configured'), { code: 'NOT_CONFIGURED' });
  return bucket;
}

function mkClient() {
  const { region } = cfg();
  const endpoint = process.env.AWS_ENDPOINT_URL_S3?.trim()
    || process.env.AWS_ENDPOINT_URL?.trim()
    || process.env.S3_ENDPOINT?.trim()
    || undefined;
  const isLocal = endpoint && (endpoint.includes('localhost') || endpoint.includes('127.0.0.1'));
  return new S3Client({ region, ...(endpoint ? { endpoint, forcePathStyle: isLocal } : {}) });
}

function stripQuotes(etag) {
  return etag ? etag.replace(/"/g, '').toLowerCase() : null;
}

async function md5(filePath) {
  return createHash('md5').update(await readFile(filePath)).digest('hex');
}

async function readManifest() {
  try { return JSON.parse(await readFile(MANIFEST_PATH, 'utf8')); }
  catch { return {}; }
}

async function saveManifest(m) {
  await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function contentTypeFor(filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const map = {
    json: 'application/json', pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    gpx: 'application/gpx+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function walkAsS3Paths(localDir, s3DirPrefix, allFiles = false) {
  const result = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
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
  if (s3SubPath.startsWith('data/'))      return join(DATA_DIR,     s3SubPath.slice('data/'.length));
  if (s3SubPath.startsWith('img/'))       return join(IMG_DIR,      s3SubPath.slice('img/'.length));
  if (s3SubPath.startsWith('receipts/'))  return join(RECEIPT_DIR,  s3SubPath.slice('receipts/'.length));
  if (s3SubPath.startsWith('documents/')) return join(DOCUMENT_DIR, s3SubPath.slice('documents/'.length));
  const ps3 = plannerS3Prefix(userId);
  if (s3SubPath.startsWith(ps3)) return join(plannerLocalDir(userId), s3SubPath.slice(ps3.length));
  return null;
}

function toS3Key(s3SubPath) { return cfg().prefix + s3SubPath; }

function fromS3Key(key, userId = null) {
  const { prefix } = cfg();
  if (!key.startsWith(prefix)) return null;
  const sub = key.slice(prefix.length);
  if (sub.startsWith('data/'))      return sub;
  if (sub.startsWith('img/'))       return sub;
  if (sub.startsWith('receipts/'))  return sub;
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
    const r = await c.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: globalPrefix, ContinuationToken: token,
    }));
    for (const o of (r.Contents || [])) {
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

export async function getStatus({ userId = null } = {}) {
  const bucket = requireBucket();
  const { prefix } = cfg();
  const plannerPrefix = plannerS3Prefix(userId);
  const [manifest, s3Objects, dataSubPaths, plannerSubPaths, imgSubPaths, receiptSubPaths, documentSubPaths] = await Promise.all([
    readManifest(),
    listS3Objects(bucket, prefix),
    walkAsS3Paths(DATA_DIR, 'data/'),
    walkAsS3Paths(plannerLocalDir(userId), plannerPrefix),
    walkAsS3Paths(IMG_DIR, 'img/', true),
    walkAsS3Paths(RECEIPT_DIR, 'receipts/', true),
    walkAsS3Paths(DOCUMENT_DIR, 'documents/', true),
  ]);
  const allLocal = [...dataSubPaths, ...plannerSubPaths, ...imgSubPaths, ...receiptSubPaths, ...documentSubPaths];
  const result = {};

  for (const sub of allLocal) {
    const key = toS3Key(sub);
    const lp = toLocalPath(sub, userId);
    const localHash = lp ? await md5(lp).catch(() => null) : null;
    const manifestEtag = manifest[key] ?? null;
    const s3Etag = s3Objects[key] ?? null;

    if (!s3Etag && !manifestEtag)                                                   result[sub] = 'local-only';
    else if (!s3Etag)                                                               result[sub] = 'deleted-on-s3';
    else if (localHash === s3Etag)                                                  result[sub] = 'in-sync';
    else if (manifestEtag && localHash !== manifestEtag && s3Etag !== manifestEtag) result[sub] = 'conflict';
    else if (manifestEtag && localHash !== manifestEtag)                            result[sub] = 'local-ahead';
    else if (manifestEtag && s3Etag !== manifestEtag)                               result[sub] = 's3-ahead';
    else                                                                            result[sub] = 'local-only';
  }

  for (const key of Object.keys(s3Objects)) {
    const sub = fromS3Key(key, userId);
    if (!sub || result[sub]) continue;
    result[sub] = 's3-only';
  }

  return result;
}

export async function push({ force = false, userId = null } = {}) {
  const bucket = requireBucket();
  const plannerPrefix = plannerS3Prefix(userId);
  const [manifest, dataSubPaths, plannerSubPaths, imgSubPaths, receiptSubPaths, documentSubPaths] = await Promise.all([
    readManifest(),
    walkAsS3Paths(DATA_DIR, 'data/'),
    walkAsS3Paths(plannerLocalDir(userId), plannerPrefix),
    walkAsS3Paths(IMG_DIR, 'img/', true),
    walkAsS3Paths(RECEIPT_DIR, 'receipts/', true),
    walkAsS3Paths(DOCUMENT_DIR, 'documents/', true),
  ]);
  const allLocal = [...dataSubPaths, ...plannerSubPaths, ...imgSubPaths, ...receiptSubPaths, ...documentSubPaths];
  const s3Objects = await listS3Objects(bucket, cfg().prefix);
  const c = mkClient();
  const pushed = [], skipped = [], conflicts = [], errors = [];

  for (const sub of allLocal) {
    const key = toS3Key(sub);
    const lp = toLocalPath(sub, userId);
    if (!lp) continue;
    try {
      const localHash = await md5(lp);
      const manifestEtag = manifest[key] ?? null;
      const s3Etag = s3Objects[key] ?? null;

      if (localHash === s3Etag) { if (!manifestEtag) manifest[key] = localHash; skipped.push(sub); continue; }

      const bothChanged = !!manifestEtag && localHash !== manifestEtag && !!s3Etag && s3Etag !== manifestEtag;
      const s3Ahead    = !!manifestEtag && localHash === manifestEtag && !!s3Etag && s3Etag !== manifestEtag;

      if ((bothChanged || s3Ahead) && !force) {
        conflicts.push({ path: sub, reason: bothChanged ? 'both-changed' : 's3-ahead', s3Etag, manifestEtag });
        continue;
      }

      await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(lp), ContentType: contentTypeFor(lp) }));
      const head = await c.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      manifest[key] = stripQuotes(head.ETag);
      pushed.push(sub);
    } catch (e) { errors.push({ path: sub, error: e.message }); }
  }

  await saveManifest(manifest);
  return { pushed, skipped, conflicts, errors };
}

export async function pull({ force = false, userId = null } = {}) {
  const bucket = requireBucket();
  const plannerPrefix = plannerS3Prefix(userId);
  const [manifest, dataSubPaths, plannerSubPaths, imgSubPaths, receiptSubPaths, documentSubPaths] = await Promise.all([
    readManifest(),
    walkAsS3Paths(DATA_DIR, 'data/'),
    walkAsS3Paths(plannerLocalDir(userId), plannerPrefix),
    walkAsS3Paths(IMG_DIR, 'img/', true),
    walkAsS3Paths(RECEIPT_DIR, 'receipts/', true),
    walkAsS3Paths(DOCUMENT_DIR, 'documents/', true),
  ]);
  const localSet = new Set([...dataSubPaths, ...plannerSubPaths, ...imgSubPaths, ...receiptSubPaths, ...documentSubPaths]);
  const s3Objects = await listS3Objects(bucket, cfg().prefix);
  const c = mkClient();
  const pulled = [], skipped = [], conflicts = [], errors = [];

  for (const [key, s3Etag] of Object.entries(s3Objects)) {
    const sub = fromS3Key(key, userId);
    if (!sub) continue;
    const lp = toLocalPath(sub, userId);
    if (!lp) continue;
    try {
      const manifestEtag = manifest[key] ?? null;
      const localHash = localSet.has(sub) ? await md5(lp).catch(() => null) : null;

      if (localHash === s3Etag) { if (!manifestEtag) manifest[key] = localHash; skipped.push(sub); continue; }

      const bothChanged = !!manifestEtag && !!localHash && localHash !== manifestEtag && s3Etag !== manifestEtag;
      const localAhead  = !!manifestEtag && !!localHash && localHash !== manifestEtag && s3Etag === manifestEtag;

      if ((bothChanged || localAhead) && !force) {
        conflicts.push({ path: sub, reason: bothChanged ? 'both-changed' : 'local-ahead', localHash, s3Etag, manifestEtag });
        continue;
      }

      const resp = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks = [];
      for await (const chunk of resp.Body) chunks.push(chunk);
      await mkdir(dirname(lp), { recursive: true });
      await writeFile(lp, Buffer.concat(chunks));
      manifest[key] = stripQuotes(resp.ETag ?? s3Etag);
      pulled.push(sub);
    } catch (e) { errors.push({ path: sub, error: e.message }); }
  }

  await saveManifest(manifest);
  return { pulled, skipped, conflicts, errors };
}

// ── Planner direct CRUD (bypasses local filesystem) ──────────────────────────

function safePlannerPath(filename) {
  if (!filename || filename.split('/').some(s => s === '..' || s === '.')) return null;
  return filename;
}

export async function listPlannerFiles({ userId = null } = {}) {
  const bucket = requireBucket();
  const { prefix } = cfg();
  const s3Prefix = prefix + plannerS3Prefix(userId);
  const objects = await listS3Objects(bucket, s3Prefix);
  return Object.keys(objects)
    .map(key => key.slice(s3Prefix.length))
    .filter(f => f.endsWith('.json'));
}

export async function getPlanner(filename, { userId = null } = {}) {
  if (!safePlannerPath(filename)) throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  const resp = await mkClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of resp.Body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function putPlanner(filename, content, { userId = null } = {}) {
  if (!safePlannerPath(filename)) throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  await mkClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: 'application/json' }));
}

export async function deletePlanner(filename, { userId = null } = {}) {
  if (!safePlannerPath(filename)) throw Object.assign(new Error('Invalid path'), { code: 'INVALID_PATH' });
  const bucket = requireBucket();
  const key = toS3Key(plannerS3Prefix(userId) + filename);
  await mkClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
