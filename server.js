import express from 'express';
import multer from 'multer';
import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { resolve, join, dirname, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DATA_DIR = join(ROOT, 'data');
const IMG_DIR = join(ROOT, 'img');
const PLANNER_DIR = join(ROOT, 'planner');
const RECEIPT_DIR   = join(ROOT, 'receipts');
const DOCUMENT_DIR  = join(ROOT, 'documents');

function guardPath(base, sub) {
  const full = resolve(join(base, sub));
  return full === base || full.startsWith(base + sep) ? full : null;
}

const app = express();

// Allow cross-origin requests so the editor works when opened as a file:// URL
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files (the editor app itself)
app.use(express.static(ROOT));

// Health check for connection testing
app.get('/api/health', (_, res) => res.json({ ok: true }));

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

// Read a data file
app.get('/api/data/:file', async (req, res) => {
  const target = guardPath(DATA_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    const raw = await readFile(target, 'utf8');
    res.type('json').send(raw);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Write a data file — receives raw JSON text to preserve formatting
app.put('/api/data/:file', express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  if (!req.params.file.endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(DATA_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    JSON.parse(req.body); // validate before writing
    await writeFile(target, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// List planner files on disk
app.get('/api/planner', async (_, res) => {
  try {
    await mkdir(PLANNER_DIR, { recursive: true });
    const files = await readdir(PLANNER_DIR);
    res.json(files.filter((f) => f.endsWith('.json')));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a planner file
app.get('/api/planner/:file', async (req, res) => {
  if (!req.params.file.endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(PLANNER_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    const raw = await readFile(target, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: e.message });
  }
});

// Write a planner file
app.put('/api/planner/:file', express.text({ type: 'application/json', limit: '10mb' }), async (req, res) => {
  if (!req.params.file.endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(PLANNER_DIR, req.params.file);
  if (!target) return res.status(400).json({ error: 'Invalid path' });
  try {
    JSON.parse(req.body); // validate before writing
    await mkdir(PLANNER_DIR, { recursive: true });
    await writeFile(target, req.body, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Delete a planner file
app.delete('/api/planner/:file', async (req, res) => {
  if (!req.params.file.endsWith('.json')) return res.status(400).json({ error: 'JSON files only' });
  const target = guardPath(PLANNER_DIR, req.params.file);
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
app.post('/api/upload', upload.single('file'), async (req, res) => {
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
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/receipts',  upload.single('file'), async (req, res) => {
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

app.post('/api/documents', upload.single('file'), async (req, res) => {
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
app.listen(PORT, () => {
  console.log(`Conference schedule editor & planner server → http://localhost:${PORT}`);
  console.log(`  editor.html → http://localhost:${PORT}/editor.html`);
  console.log(`  planner.html → http://localhost:${PORT}/editor.html`);
});
