import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { issueToken, revokeToken } from './singleUserToken.js';
import {
  AUTH_MODE,
  SINGLE_USER_ID,
  getUserByUsername,
  getUserById,
  createUser,
  updateUser,
  updateUserToken,
  deleteUser,
  listUsers,
} from './auth.js';

function notAvailable(res) {
  res
    .status(501)
    .json({ error: 'User management requires multi-user mode (set DYNAMODB_USERS_TABLE)' });
}

/**
 * Tokens work in session mode too — one account is still an account. Open mode
 * is refused on purpose: it has no identity to bind a token to, so a token
 * would assert something the server never checks.
 */
function tokensNotAvailable(res) {
  res.status(501).json({
    error:
      'API tokens need authentication. Set AUTH_PASSWORD_HASH (single user) or DYNAMODB_USERS_TABLE (multi-user).',
  });
}

// GET /api/users — list all users (Admin)
export async function handleListUsers(req, res) {
  if (AUTH_MODE !== 'multi') return notAvailable(res);
  try {
    res.json(await listUsers());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// GET /api/users/me — current user's profile (any authenticated)
export function handleGetCurrentUser(req, res) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(req.user);
}

// POST /api/users — create a user (Admin)
export async function handleCreateUser(req, res) {
  if (AUTH_MODE !== 'multi') return notAvailable(res);
  const { username, password, role = 'viewer' } = req.body ?? {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (!['viewer', 'editor', 'admin'].includes(role))
    return res.status(400).json({ error: 'role must be viewer, editor, or admin' });

  const existing = await getUserByUsername(String(username)).catch(() => null);
  if (existing) return res.status(409).json({ error: 'Username already taken' });

  try {
    const passwordHash = await bcrypt.hash(String(password), 12);
    const user = await createUser({ username: String(username), passwordHash, role });
    res.status(201).json(user);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// PUT /api/users/:id — update role (Admin)
export async function handleUpdateUser(req, res) {
  if (AUTH_MODE !== 'multi') return notAvailable(res);
  const { id } = req.params;
  const { role } = req.body ?? {};
  if (!role || !['viewer', 'editor', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be viewer, editor, or admin' });
  }
  // Prevent an admin from demoting themselves
  if (req.user?.user_id === id && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role' });
  }
  try {
    await updateUser(id, { role });
    res.json({ ok: true });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: e.message });
  }
}

// POST /api/users/:id/token — generate bearer token, returns plain token once (Admin)
export async function handleGenerateToken(req, res) {
  if (AUTH_MODE === 'open') return tokensNotAvailable(res);
  if (AUTH_MODE === 'session') {
    // One identity, so the only addressable id is its own. Anything else is a
    // caller reaching for a user that cannot exist here.
    if (req.params.id !== SINGLE_USER_ID) return res.status(404).json({ error: 'User not found' });
    return res.json({
      token: issueToken(),
      note: 'Save this token now — it will not be shown again.',
    });
  }
  const user = await getUserById(req.params.id).catch(() => null);
  if (!user) return res.status(404).json({ error: 'User not found' });
  try {
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await updateUserToken(req.params.id, hash);
    res.json({ token, note: 'Save this token now — it will not be shown again.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// DELETE /api/users/:id/token — revoke bearer token (Admin)
export async function handleRevokeToken(req, res) {
  if (AUTH_MODE === 'open') return tokensNotAvailable(res);
  if (AUTH_MODE === 'session') {
    if (req.params.id !== SINGLE_USER_ID) return res.status(404).json({ error: 'User not found' });
    revokeToken();
    return res.json({ ok: true });
  }
  try {
    await updateUserToken(req.params.id, null);
    res.json({ ok: true });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: e.message });
  }
}

// DELETE /api/users/:id — delete a user (Admin)
export async function handleDeleteUser(req, res) {
  if (AUTH_MODE !== 'multi') return notAvailable(res);
  const { id } = req.params;
  if (req.user?.user_id === id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    await deleteUser(id);
    res.json({ ok: true });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException')
      return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: e.message });
  }
}
