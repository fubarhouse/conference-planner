import express from 'express';
import multer from 'multer';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { resolve, join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';
import * as s3Sync from './lib/s3-sync.js';
import { AUTH_MODE, logAuthMode, bootstrapAdmin, requireAuth, requireRole, serveLoginPage, handleLogin, handleLogout } from './lib/auth.js';
import { handleListUsers, handleGetCurrentUser, handleCreateUser, handleUpdateUser, handleDeleteUser, handleGenerateToken, handleRevokeToken } from './lib/users.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const APP = join(ROOT, 'app');
const DATA_DIR = join(APP, 'data');
const IMG_DIR = join(APP, 'img');
const PLANNER_DIR = join(APP, 'planner');
const RECEIPT_DIR = join(APP, 'receipts');
const DOCUMENT_DIR = join(APP, 'documents');

function guardPath(base, sub) {
  const full = resolve(join(base, sub));
  return full === base || full.startsWith(base + sep) ? full : null;
}

const app = express();

// Trust the first proxy hop (CDN/reverse proxy) for accurate req.ip
app.set('trust proxy', 1);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});

// Allow cross-origin requests so the editor works when opened as a file:// URL
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Strip trailing slashes so relative asset paths resolve correctly from clean URLs
app.use((req, res, next) => {
  if (req.path !== '/' && req.path.endsWith('/')) {
    const qs = req.url.slice(req.path.length);
    return res.redirect(301, req.path.slice(0, -1) + qs);
  }
  next();
});

// Request logger
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400)
      console.error(`[http] ${res.statusCode} ${req.method} ${req.path} (auth-mode: ${AUTH_MODE})`);
  });
  next();
});

// Auth status (always public — lets the UI know what mode is active)
app.get('/api/auth/status', (_, res) => res.json({ mode: AUTH_MODE }));

// Login / logout
app.get('/login', serveLoginPage);
app.post('/login', express.urlencoded({ extended: false }), handleLogin);
app.get('/logout', handleLogout);

// Public HTML routes
app.get('/', (_, res) => res.sendFile(join(APP, 'index.html')));
app.get('/schedule', (_, res) => res.sendFile(join(APP, 'index.html')));

// Protected HTML routes — must come before express.static so .html files are also guarded
app.get('/planner', requireAuth, (_, res) => res.sendFile(join(APP, 'planner.html')));
app.get('/planner.html', requireAuth, (_, res) => res.sendFile(join(APP, 'planner.html')));
app.get('/editor', requireAuth, (_, res) => res.sendFile(join(APP, 'editor.html')));
app.get('/editor.html', requireAuth, (_, res) => res.sendFile(join(APP, 'editor.html')));

// Serve static files (CSS, JS, images — no auth required)
app.use(express.static(APP));

// Health check for connection testing
app.get('/api/health', (_, res) => res.json({ ok: true, app: 'conference-planner-api', version: 1 }));

// User management (multi-user mode only)
app.get('/api/users/me', requireRole('viewer'), handleGetCurrentUser);
app.get('/api/users', requireRole('admin'), handleListUsers);
app.post('/api/users', requireRole('admin'), express.json(), handleCreateUser);
app.put('/api/users/:id', requireRole('admin'), express.json(), handleUpdateUser);
app.delete('/api/users/:id', requireRole('admin'), handleDeleteUser);
app.post('/api/users/:id/token', requireRole('admin'), handleGenerateToken);
app.delete('/api/users/:id/token', requireRole('admin'), handleRevokeToken);

// S3 sync endpoints
function s3Error(res, e) {
  const httpStatus = e.$metadata?.httpStatusCode;
  const awsCode = e.Code ?? e.name ?? e.code;
  console.error('[s3]', awsCode ?? 'error', httpStatus ? `HTTP ${httpStatus}` : '', e.message, e.stack ?? '');
  if (e.code === 'NOT_CONFIGURED') return res.status(503).json({ ok: false, error: e.message });
  const detail = httpStatus ? ` (AWS HTTP ${httpStatus}${awsCode ? `, ${awsCode}` : ''})` : '';
  return res.status(502).json({ ok: false, error: e.message + detail });
}

app.get('/api/s3/config', (_, res) => {
  const bucket = process.env.S3_BUCKET?.trim() || '';
  res.json({
    bucket,
    region: process.env.S3_REGION?.trim() || 'us-east-1',
    prefix: process.env.S3_PREFIX?.trim() || '',
    configured: !!bucket,
  });
});

app.get('/api/s3/test', async (_, res) => {
  try { res.json({ ok: true, ...(await s3Sync.testConnection()) }); }
  catch (e) { s3Error(res, e); }
});

app.get('/api/s3/status', requireRole('viewer'), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try { res.json(await s3Sync.getStatus({ userId })); }
  catch (e) { s3Error(res, e); }
});

app.post('/api/s3/push', requireRole('editor'), express.json(), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try { res.json(await s3Sync.push({ force: !!req.body?.force, userId })); }
  catch (e) { s3Error(res, e); }
});

app.post('/api/s3/pull', requireRole('editor'), express.json(), async (req, res) => {
  const userId = AUTH_MODE === 'multi' ? req.user?.user_id : null;
  try { res.json(await s3Sync.pull({ force: !!req.body?.force, userId })); }
  catch (e) { s3Error(res, e); }
});

// Metadata summary — returns event metadata for all dataset files (no items arrays)
app.get('/api/meta', async (_, res) => {
  try {
    const indexRaw = await readFile(join(DATA_DIR, 'index.json'), 'utf8');
    const index = JSON.parse(indexRaw);
    const files = (Array.isArray(index?.files) ? index.files : [])
      .map((e) => (typeof e === 'string' ? e : e?.file))
      .filter((f) => f && f.endsWith('.json') && f !== 'index.json');
    const metas = await Promise.all(
      files.map(async (file) => {
        try {
          const target = guardPath(DATA_DIR, file);
          if (!target) return null;
          const raw = await readFile(target, 'utf8');
          const parsed = JSON.parse(raw);
          if (!parsed?.event || typeof parsed.event !== 'object' || Array.isArray(parsed.event)) return null;
          const m = parsed.event;
          return {
            file,
            designation: String(m.designation || '').trim(),
            location: String(m.location || '').trim(),
            year: String(m.year || '').trim(),
            region: String(m.region || '').trim(),
            venue: String(m.venue || '').trim(),
            enabled: m.enabled !== false,
          };
        } catch {
          return null;
        }
      })
    );
    res.json(metas.filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a data file (supports subdirectory paths like events/drupalcon/us/2025-atlanta.json)
app.get('/api/data/*', async (req, res) => {
  const target = guardPath(DATA_DIR, req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    const raw = await readFile(target, 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Write a data file — receives raw JSON text to preserve formatting
app.put('/api/data/*', requireRole('editor'), express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(DATA_DIR, req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    JSON.parse(req.body); // validate before writing
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// In multi-user mode planner files live under planner/{user_id}/ so each user's
// files are isolated locally, mirroring the planners/{user_id}/ layout in S3.
function userPlannerDir(req) {
  return AUTH_MODE === 'multi' && req.user?.user_id
    ? join(PLANNER_DIR, req.user.user_id)
    : PLANNER_DIR;
}

function s3Configured() { return !!process.env.S3_BUCKET?.trim(); }
function plannerUserId(req) { return AUTH_MODE === 'multi' ? req.user?.user_id : null; }

// List planner files
app.get('/api/planner', requireRole('viewer'), async (req, res) => {
  if (s3Configured()) {
    try { return res.json(await s3Sync.listPlannerFiles({ userId: plannerUserId(req) })); }
    catch (e) { return s3Error(res, e); }
  }
  const dir = userPlannerDir(req);
  try {
    await mkdir(dir, { recursive: true });
    res.json((await readdir(dir)).filter((f) => f.endsWith('.json')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Read a planner file
app.get('/api/planner/*', requireRole('viewer'), async (req, res) => {
  if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  if (s3Configured()) {
    try { return res.type('application/json').send(await s3Sync.getPlanner(req.params[0], { userId: plannerUserId(req) })); }
    catch (e) {
      if (e.name === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
      return s3Error(res, e);
    }
  }
  const target = guardPath(userPlannerDir(req), req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try { res.type('application/json').send(await readFile(target, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Write a planner file (PUT for existing clients, POST for flush-from-browser)
async function handlePlannerWrite(req, res) {
  if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  try { JSON.parse(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (s3Configured()) {
    try { return res.json({ ok: true, ...(await s3Sync.putPlanner(req.params[0], req.body, { userId: plannerUserId(req) })) }); }
    catch (e) { return s3Error(res, e); }
  }
  const target = guardPath(userPlannerDir(req), req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}
app.put('/api/planner/*',  requireRole('editor'), express.text({ type: 'application/json', limit: '10mb' }), handlePlannerWrite);
app.post('/api/planner/*', requireRole('editor'), express.text({ type: 'application/json', limit: '10mb' }), handlePlannerWrite);

// Delete a planner file
app.delete('/api/planner/*', requireRole('editor'), async (req, res) => {
  if (!req.params[0].endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  if (s3Configured()) {
    try { return res.json({ ok: true, ...(await s3Sync.deletePlanner(req.params[0], { userId: plannerUserId(req) })) }); }
    catch (e) {
      if (e.name === 'NoSuchKey') return res.status(404).json({ error: 'Not found' });
      return s3Error(res, e);
    }
  }
  const target = guardPath(userPlannerDir(req), req.params[0]);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await unlink(target);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Upload an image into img/
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const targetRelative = String(req.body.targetPath || '').trim().replace(/^\.\//, '');
  if (!targetRelative || !targetRelative.startsWith('img/')) {
    return res.status(400).json({ error: 'targetPath must start with img/' });
  }
  const target = guardPath(IMG_DIR, targetRelative.slice(4)); // strip "img/"
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.file.buffer);
    res.json({ ok: true, path: `./${targetRelative}` });
  } catch (e) {
    console.error('[upload]', e.message, e.stack ?? '');
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/receipts', requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const eventFile = String(req.body.eventFile || '').trim();
  if (!eventFile) return res.status(400).json({ error: 'eventFile required' });
  const slug = eventFile.endsWith('.json') ? eventFile.slice(0, -5) : eventFile;
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = guardPath(RECEIPT_DIR, join(slug, safeName));
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.file.buffer);
    res.json({ ok: true, path: `receipts/${slug}/${safeName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/documents', requireRole('editor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const eventFile = String(req.body.eventFile || '').trim();
  if (!eventFile) return res.status(400).json({ error: 'eventFile required' });
  const slug = eventFile.endsWith('.json') ? eventFile.slice(0, -5) : eventFile;
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const target = guardPath(DOCUMENT_DIR, join(slug, safeName));
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, req.file.buffer);
    res.json({ ok: true, path: `documents/${slug}/${safeName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy exchange rates from Frankfurter so the browser call is same-origin.
// date param: 'YYYY-MM-DD' for historical lookup, omit for latest rates.
app.get('/api/rates', async (req, res) => {
  const base = String(req.query.base || '').toUpperCase();
  const date = String(req.query.date || '').trim();
  if (!/^[A-Z]{3}$/.test(base)) return res.status(400).json({ error: 'Invalid currency code' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format, expected YYYY-MM-DD' });
  try {
    const path = date ? `/${date}` : '/latest';
    const upstream = await fetch(`https://api.frankfurter.app${path}?base=${base}`);
    if (!upstream.ok) return res.status(502).json({ error: `Upstream ${upstream.status}` });
    const data = await upstream.json();
    // Historical rates never change — cache them for a year; current rates expire in 1h.
    res.set('Cache-Control', date ? 'public, max-age=31536000' : 'public, max-age=3600').json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, async () => {
  logAuthMode();
  await bootstrapAdmin().catch(e => console.error('[auth] bootstrap error:', e.message));
  console.log(`Conference schedule editor & planner server → http://localhost:${PORT}`);
  console.log(`  schedule → http://localhost:${PORT}/schedule`);
  console.log(`  planner → http://localhost:${PORT}/planner`);
  console.log(`  editor  → http://localhost:${PORT}/editor`);
});
