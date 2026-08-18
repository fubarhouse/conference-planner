import { fileURLToPath } from 'node:url';
import crypto, { createHash } from 'crypto';
import bcrypt from 'bcryptjs';

const SESSION_COOKIE = 'dcs';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_LEVELS = { anonymous: 0, viewer: 1, editor: 2, admin: 3 };

// ── Mode detection ─────────────────────────────────────────────────────────
// Three modes only: open | session | multi
// CDNs (CloudFront, Cloudflare, Fastly) sit in front transparently — the app
// doesn't need to know which one is there.

function detectMode() {
  const e = process.env;
  if (e.AUTH_ENABLED?.trim().toLowerCase() === 'false') return 'open';
  const explicit = e.AUTH_MODE?.trim().toLowerCase();
  if (explicit === 'off' || explicit === 'open') return 'open';
  if (explicit === 'multi') return 'multi';
  if (explicit === 'session') return 'session';
  // Auto-detect from env vars
  if (e.DYNAMODB_USERS_TABLE?.trim()) return 'multi';
  if (e.AUTH_PASSWORD_HASH?.trim()) return 'session';
  return 'open';
}

import { verifyToken as verifySingleUserApiToken } from './singleUserToken.js';

export const AUTH_MODE = detectMode();

/**
 * The one identity in session mode. Session mode has no user table, but the
 * token routes are addressed as /api/users/:id/token, so the single user needs
 * a stable id to be addressed BY. It is not a secret and never a lookup key.
 */
export const SINGLE_USER_ID = 'owner';

// Resolved from this file so it does not depend on the server's cwd.
const FORBIDDEN_PAGE = fileURLToPath(new URL('../app/403.html', import.meta.url));
const DYNAMODB_TABLE = process.env.DYNAMODB_USERS_TABLE?.trim() || '';

const MODE_LABELS = {
  open: 'open (no auth)',
  session: 'server session',
  multi: 'multi-user JWT + RBAC',
};

export function logAuthMode() {
  console.log(`[auth] mode: ${MODE_LABELS[AUTH_MODE] ?? AUTH_MODE}`);
  if (AUTH_MODE === 'open') {
    // Mode detection FAILS OPEN: an unset, empty or misspelled AUTH_PASSWORD_HASH
    // / DYNAMODB_USERS_TABLE lands here silently, and this app serves personal
    // data — trip planners, contacts, uploaded tickets and receipts. Running
    // open is a legitimate choice for a laptop; on a deployed box it is almost
    // certainly a mistake, and one nobody notices until the data is public.
    // Refuse to start unless it was asked for IN WORDS.
    const deployed =
      process.env.NODE_ENV === 'production' || Boolean(process.env.PORT && process.env.HOST);
    const explicit = ['off', 'open'].includes(process.env.AUTH_MODE?.trim().toLowerCase() ?? '');
    if (deployed && !explicit) {
      console.error(
        '[auth] REFUSING TO START: no authentication is configured, but this looks like a\n' +
          '       deployed environment. Personal data (planners, contacts, uploaded receipts\n' +
          '       and documents) would be served to anyone.\n' +
          '       Set AUTH_PASSWORD_HASH (session) or DYNAMODB_USERS_TABLE (multi-user).\n' +
          '       To run without auth deliberately, set AUTH_MODE=open.',
      );
      process.exit(1);
    }
    console.log('[auth] tip: set AUTH_MODE=session and AUTH_PASSWORD_HASH to enable auth');
  }
  if (AUTH_MODE === 'session' && !process.env.SESSION_SECRET?.trim()) {
    console.warn('[auth] SESSION_SECRET not set — sessions will not survive server restarts');
  }
  if (AUTH_MODE === 'multi' && !process.env.JWT_SECRET?.trim()) {
    console.warn('[auth] JWT_SECRET not set — tokens will not survive server restarts');
  }
}

// ── HMAC session token (session mode) ─────────────────────────────────────

let _sessionSecret;
function sessionSecret() {
  if (!_sessionSecret) {
    _sessionSecret = process.env.SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
  }
  return _sessionSecret;
}

function signToken(expMs) {
  const p = String(expMs);
  return `${p}.${crypto.createHmac('sha256', sessionSecret()).update(p).digest('hex')}`;
}

function verifyToken(raw) {
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot < 0) return false;
  const p = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const exp = crypto.createHmac('sha256', sessionSecret()).update(p).digest('hex');
  try {
    const a = Buffer.from(sig.padEnd(64, '0').slice(0, 64), 'hex');
    const b = Buffer.from(exp, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  return Date.now() < parseInt(p, 10);
}

// ── JWT (multi mode) ───────────────────────────────────────────────────────

let _jwtKey;
function jwtKey() {
  if (!_jwtKey) {
    const s =
      process.env.JWT_SECRET?.trim() ||
      process.env.SESSION_SECRET?.trim() ||
      crypto.randomBytes(32).toString('hex');
    _jwtKey = new TextEncoder().encode(s);
  }
  return _jwtKey;
}

async function signJWT(payload) {
  const { SignJWT } = await import('jose');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(jwtKey());
}

async function verifyJWT(token) {
  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(token, jwtKey());
  return payload;
}

// ── DynamoDB (multi mode only, lazy-loaded) ────────────────────────────────

let _dynamo;
async function getDynamoDB() {
  if (!_dynamo) {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const {
      DynamoDBDocumentClient,
      GetCommand,
      PutCommand,
      UpdateCommand,
      DeleteCommand,
      QueryCommand,
      ScanCommand,
    } = await import('@aws-sdk/lib-dynamodb');
    const region =
      process.env.AWS_REGION?.trim() ||
      process.env.AWS_DEFAULT_REGION?.trim() ||
      process.env.S3_REGION?.trim() ||
      'us-east-1';
    const endpoint =
      process.env.AWS_ENDPOINT_URL_DYNAMODB?.trim() ||
      process.env.AWS_ENDPOINT_URL?.trim() ||
      undefined;
    const client = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) });
    _dynamo = {
      db: DynamoDBDocumentClient.from(client),
      GetCommand,
      PutCommand,
      UpdateCommand,
      DeleteCommand,
      QueryCommand,
      ScanCommand,
    };
  }
  return _dynamo;
}

// ── User CRUD ──────────────────────────────────────────────────────────────

export async function getUserByUsername(username) {
  const { db, QueryCommand } = await getDynamoDB();
  const r = await db.send(
    new QueryCommand({
      TableName: DYNAMODB_TABLE,
      IndexName: 'username-index',
      KeyConditionExpression: 'username = :u',
      ExpressionAttributeValues: { ':u': username },
      Limit: 1,
    }),
  );
  return r.Items?.[0] ?? null;
}

export async function getUserById(userId) {
  const { db, GetCommand } = await getDynamoDB();
  const r = await db.send(new GetCommand({ TableName: DYNAMODB_TABLE, Key: { user_id: userId } }));
  return r.Item ?? null;
}

export async function listUsers() {
  const { db, ScanCommand } = await getDynamoDB();
  const r = await db.send(new ScanCommand({ TableName: DYNAMODB_TABLE }));
  return (r.Items ?? []).map(({ password_hash, token_hash, ...u }) => u);
}

export async function createUser({ username, passwordHash, role = 'viewer' }) {
  const { db, PutCommand } = await getDynamoDB();
  const user_id = crypto.randomUUID();
  await db.send(
    new PutCommand({
      TableName: DYNAMODB_TABLE,
      Item: {
        user_id,
        username,
        password_hash: passwordHash,
        role,
        created_at: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(user_id)',
    }),
  );
  return { user_id, username, role };
}

export async function updateUser(userId, { role }) {
  const { db, UpdateCommand } = await getDynamoDB();
  await db.send(
    new UpdateCommand({
      TableName: DYNAMODB_TABLE,
      Key: { user_id: userId },
      UpdateExpression: 'SET #r = :r',
      ExpressionAttributeNames: { '#r': 'role' },
      ExpressionAttributeValues: { ':r': role },
      ConditionExpression: 'attribute_exists(user_id)',
    }),
  );
}

export async function updateUserToken(userId, tokenHash) {
  const { db, UpdateCommand } = await getDynamoDB();
  if (tokenHash === null) {
    await db.send(
      new UpdateCommand({
        TableName: DYNAMODB_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'REMOVE token_hash',
        ConditionExpression: 'attribute_exists(user_id)',
      }),
    );
  } else {
    await db.send(
      new UpdateCommand({
        TableName: DYNAMODB_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'SET token_hash = :h',
        ExpressionAttributeValues: { ':h': tokenHash },
        ConditionExpression: 'attribute_exists(user_id)',
      }),
    );
  }
}

export async function deleteUser(userId) {
  const { db, DeleteCommand } = await getDynamoDB();
  await db.send(
    new DeleteCommand({
      TableName: DYNAMODB_TABLE,
      Key: { user_id: userId },
      ConditionExpression: 'attribute_exists(user_id)',
    }),
  );
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

export async function bootstrapAdmin() {
  if (AUTH_MODE !== 'multi') return;
  const username = process.env.ADMIN_USERNAME?.trim();
  const hash = process.env.AUTH_PASSWORD_HASH?.trim();
  if (!username || !hash) {
    console.warn('[auth] ADMIN_USERNAME or AUTH_PASSWORD_HASH not set — no admin bootstrapped');
    return;
  }
  const existing = await getUserByUsername(username).catch(() => null);
  if (existing) return;
  await createUser({ username, passwordHash: hash, role: 'admin' });
  console.log(`[auth] bootstrapped admin user: ${username}`);
}

// ── Cookie utilities ───────────────────────────────────────────────────────

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    try {
      out[k] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[k] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function setCookie(res, value) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`,
  );
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

// ── Bearer token (multi mode) ──────────────────────────────────────────────

async function verifyBearerToken(token) {
  const hash = createHash('sha256').update(token).digest('hex');
  const { db, ScanCommand } = await getDynamoDB();
  const r = await db.send(
    new ScanCommand({
      TableName: DYNAMODB_TABLE,
      FilterExpression: 'token_hash = :h',
      ExpressionAttributeValues: { ':h': hash },
      Limit: 1,
    }),
  );
  return r.Items?.[0] ?? null;
}

// ── Auth check ─────────────────────────────────────────────────────────────

export async function checkAuth(req) {
  if (AUTH_MODE === 'multi') {
    // Bearer token for headless/API clients
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const user = await verifyBearerToken(authHeader.slice(7)).catch(() => null);
      if (user) return { user_id: user.user_id, username: user.username, role: user.role };
    }
    // JWT session cookie
    const raw = parseCookies(req)[SESSION_COOKIE] ?? '';
    if (!raw) return null;
    try {
      const payload = await verifyJWT(raw);
      return { user_id: payload.user_id, username: payload.username, role: payload.role };
    } catch {
      return null;
    }
  }

  if (AUTH_MODE === 'session') {
    // Bearer token for headless/API clients, same as multi mode. There is one
    // identity here, so a valid token IS that identity — it carries a stable
    // user_id so /api/users/:id/token has something to address.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      if (verifySingleUserApiToken(authHeader.slice(7))) {
        return { user_id: SINGLE_USER_ID, username: 'owner', role: 'admin' };
      }
      return null;
    }
    const raw = parseCookies(req)[SESSION_COOKIE] ?? '';
    if (verifyToken(raw)) return { user_id: SINGLE_USER_ID, username: 'owner', role: 'admin' };
    return null;
  }

  return { role: 'admin' }; // open mode — synthetic admin
}

function redirectToLogin(req, res) {
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || '/planner')}`);
}

// ── Middleware ─────────────────────────────────────────────────────────────

export async function requireAuth(req, res, next) {
  if (AUTH_MODE === 'open') return next();
  try {
    const user = await checkAuth(req);
    if (user) {
      req.user = user;
      return next();
    }
  } catch {
    /* fall through */
  }
  redirectToLogin(req, res);
}

export function requireRole(minRole) {
  const minLevel = ROLE_LEVELS[minRole] ?? 0;
  return async (req, res, next) => {
    if (AUTH_MODE === 'open') {
      req.user = { role: 'admin' };
      return next();
    }
    try {
      const user = await checkAuth(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      if ((ROLE_LEVELS[user.role] ?? 0) < minLevel) {
        // A signed-in person who lacks the role gets a page they can read and
        // act on; an API client gets the JSON it is parsing for. Deciding by
        // what the caller ASKED for keeps both honest.
        const wantsHtml = !req.path.startsWith('/api/') && req.accepts(['html', 'json']) === 'html';
        if (wantsHtml) return res.status(403).sendFile(FORBIDDEN_PAGE);
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

// ── Route handlers ─────────────────────────────────────────────────────────

export function serveLoginPage(req, res) {
  if (AUTH_MODE === 'open') return res.redirect('/');
  res.send(renderLogin({ multiUser: AUTH_MODE === 'multi' }));
}

// ── Login rate limiter (in-memory, no deps) ───────────────────────────────
// 10 attempts per 15-minute window per IP. Clears on successful login.

const _loginAttempts = new Map();

function rateLimitExceeded(ip) {
  const now = Date.now();
  let entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 15 * 60 * 1000 };
  }
  entry.count++;
  _loginAttempts.set(ip, entry);
  return entry.count > 10;
}

function clearRateLimit(ip) {
  _loginAttempts.delete(ip);
}

export async function handleLogin(req, res) {
  if (AUTH_MODE === 'open') return res.redirect('/');

  if (rateLimitExceeded(req.ip)) {
    return res
      .status(429)
      .send(renderLogin({ error: 'Too many attempts. Try again in 15 minutes.' }));
  }

  const nextUrl = String(req.query?.next ?? req.body?.next ?? '/planner');
  const dest = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/planner';

  if (AUTH_MODE === 'multi') {
    const username = String(req.body?.username ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!username || !password)
      return res
        .status(401)
        .send(renderLogin({ error: 'Username and password required.', multiUser: true }));
    const user = await getUserByUsername(username).catch(() => null);
    const valid = user && (await bcrypt.compare(password, user.password_hash).catch(() => false));
    if (!valid)
      return res
        .status(401)
        .send(renderLogin({ error: 'Invalid username or password.', multiUser: true }));
    clearRateLimit(req.ip);
    setCookie(
      res,
      await signJWT({ user_id: user.user_id, username: user.username, role: user.role }),
    );
    return res.redirect(dest);
  }

  // session mode
  const password = String(req.body?.password ?? '');
  const hash = process.env.AUTH_PASSWORD_HASH?.trim() ?? '';
  const valid = hash && (await bcrypt.compare(password, hash).catch(() => false));
  if (!valid) return res.status(401).send(renderLogin({ error: 'Incorrect password.' }));
  clearRateLimit(req.ip);
  setCookie(res, signToken(Date.now() + SESSION_MS));
  res.redirect(dest);
}

// JSON password re-verification for the client-side planner lock (soft privacy
// lock). Confirms the current credential without disturbing the active session.
export async function handleVerifyPassword(req, res) {
  if (AUTH_MODE === 'open') return res.json({ ok: true, mode: 'open' });
  if (rateLimitExceeded(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }
  const password = String(req.body?.password ?? '');
  if (AUTH_MODE === 'multi') {
    const username = String(req.user?.username ?? '');
    const user = username ? await getUserByUsername(username).catch(() => null) : null;
    const valid = user && (await bcrypt.compare(password, user.password_hash).catch(() => false));
    if (!valid) return res.status(401).json({ ok: false });
    clearRateLimit(req.ip);
    return res.json({ ok: true, mode: 'multi' });
  }
  // session mode — single shared password hash
  const hash = process.env.AUTH_PASSWORD_HASH?.trim() ?? '';
  const valid = hash && (await bcrypt.compare(password, hash).catch(() => false));
  if (!valid) return res.status(401).json({ ok: false });
  clearRateLimit(req.ip);
  return res.json({ ok: true, mode: 'session' });
}

export function handleLogout(req, res) {
  clearCookie(res);
  res.redirect('/');
}

// ── Login page ─────────────────────────────────────────────────────────────

function renderLogin({ error = '', multiUser = false } = {}) {
  const usernameField = multiUser
    ? `
      <div class="lf-field">
        <label class="lf-label" for="uname">Username</label>
        <input id="uname" class="lf-input" type="text" name="username"
          autocomplete="username" autofocus required>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — Conference Planner</title>
  <link rel="icon" href="/img/app-icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
  <!-- /css/app.css was linked here and DELETED during the legacy prune, so
       every sign-in fetched a 404. The two CDN links went with it: this page
       pulled IBM Plex from Google Fonts and the whole Font Awesome bundle for a
       single decorative glyph, on the one page a visitor sees before they have
       any reason to trust the site. Everything below is inline or self-hosted.
       Converting the page to the design system proper is still a separate job —
       see brand/DECISIONS.md. -->
  <link rel="stylesheet" href="/css/foundation.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100dvh;
      display: flex; flex-direction: column;
      font-family: var(--font-body, system-ui, sans-serif);
    }

    /* ── Hero: full aurora header ── */
    .lp-hero {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 3.5rem 1.5rem 5rem;
      text-align: center;
      position: relative;
    }
    .lp-logo {
      width: 72px; height: 72px;
      border-radius: 18px;
      font-size: 1.75rem;
      margin-bottom: 1.25rem;
    }
    /* These were white, for a dark hero background that lived in the deleted
       /css/app.css — so since the legacy prune the sign-in page has rendered
       its own title in white on a white page. Invisible, on the one screen a
       visitor cannot skip. Ink tokens, on the paper that is actually there. */
    .lp-title {
      font-family: var(--font-display, Georgia, serif);
      font-size: clamp(1.5rem, 5vw, 2rem);
      font-weight: 600; letter-spacing: -0.015em;
      color: var(--ink-0, #1a1e1b); margin: 0 0 0.375rem;
    }
    .lp-sub {
      font-size: 0.9375rem; font-weight: 400;
      color: var(--ink-1, #4c524a); margin: 0;
    }

    /* ── Form zone ── */
    .lp-zone {
      flex: 1; background: #f2f2f7;
      display: flex; align-items: flex-start; justify-content: center;
      padding: 0 1rem 3rem;
    }

    /* Card lifts over the hero bottom edge */
    .lp-card {
      background: #fff;
      border-radius: 1.25rem;
      box-shadow: 0 4px 32px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06);
      padding: 2rem;
      width: 100%; max-width: 380px;
      margin-top: -2.5rem;
      position: relative;
    }
    .lp-card-title {
      font-size: 1.0625rem; font-weight: 700;
      color: #111827; margin: 0 0 1.5rem;
    }

    /* Fields */
    .lf-field { margin-bottom: 1rem; }
    .lf-label {
      display: block; font-size: 0.8125rem; font-weight: 500;
      color: #374151; margin-bottom: 0.375rem;
    }
    .lf-input {
      display: block; width: 100%; height: 2.75rem;
      border: 1.5px solid #e5e7eb; border-radius: 0.625rem;
      padding: 0 0.875rem; font-size: 0.9375rem;
      font-family: inherit; outline: none; background: #fff; color: #111;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .lf-input:focus {
      border-color: var(--accent, #0078bf);
      box-shadow: 0 0 0 3px rgba(0,120,191,0.15);
    }

    /* Submit */
    .lf-btn {
      margin-top: 0.25rem; width: 100%; height: 2.75rem;
      background: var(--accent, #0078bf); color: #fff;
      border: none; border-radius: 0.625rem;
      font-size: 0.9375rem; font-weight: 600;
      font-family: inherit; cursor: pointer;
      transition: background 0.15s, transform 0.1s;
    }
    .lf-btn:hover  { background: #005fa3; }
    .lf-btn:active { transform: scale(0.98); }

    /* Error */
    .lf-error {
      display: flex; align-items: center; gap: 0.5rem;
      margin-top: 0.875rem; padding: 0.625rem 0.875rem;
      background: #fef2f2; border: 1px solid #fecaca;
      border-radius: 0.5rem; font-size: 0.8125rem; color: #dc2626;
    }

    /* Mode badge */
    .lf-mode {
      margin-top: 1.5rem; font-size: 0.6875rem;
      color: #9ca3af; text-align: center; letter-spacing: 0.01em;
    }

    @media (prefers-color-scheme: dark) {
      .lp-zone { background: #000; }
      .lp-card { background: #1c1c1e; box-shadow: 0 4px 32px rgba(0,0,0,0.5); }
      .lp-card-title { color: #f9fafb; }
      .lf-label { color: #d1d5db; }
      .lf-input { background: #2c2c2e; border-color: #3a3a3c; color: #f9fafb; }
      .lf-input:focus { border-color: var(--accent, #0a84ff); box-shadow: 0 0 0 3px rgba(10,132,255,0.2); }
      .lf-error { background: rgba(220,38,38,0.12); border-color: rgba(220,38,38,0.3); }
      .lf-mode { color: #6b7280; }
    }
  </style>
</head>
<body>
  <div class="lp-hero header-shell">
    <div class="header-logo brand-drupalsouth lp-logo">
      
    </div>
    <h1 class="lp-title">Conference Planner</h1>
    <p class="lp-sub">Sign in to continue</p>
  </div>

  <div class="lp-zone">
    <div class="lp-card">
      <p class="lp-card-title">Welcome back</p>
      <form method="POST" action="/login" autocomplete="on">
        <input type="hidden" name="next" value="">
        ${usernameField}
        <div class="lf-field">
          <label class="lf-label" for="pwd">Password</label>
          <input id="pwd" class="lf-input" type="password" name="password"
            autocomplete="current-password"${multiUser ? '' : ' autofocus'} required>
        </div>
        ${error ? `<p class="lf-error"><i class="fas fa-circle-exclamation"></i>${error}</p>` : ''}
        <button class="lf-btn" type="submit">
          <i class="fas fa-arrow-right-to-bracket" style="margin-right:0.5rem"></i>Sign in
        </button>
      </form>
      <p class="lf-mode">${MODE_LABELS[AUTH_MODE] ?? AUTH_MODE}</p>
    </div>
  </div>

  <script>
    const p = new URLSearchParams(location.search).get('next');
    if (p) document.querySelector('[name=next]').value = p;
  </script>
</body>
</html>`;
}
