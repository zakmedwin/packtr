/**
 * PacktRite - Cloudflare Worker v5 (gap check)
 * =============================================
 * KV Namespace binding: PACKTR_KV
 * Environment variables required:
 *   ANTHROPIC_API_KEY - your Anthropic API key
 *   ADMIN_SECRET      - any secret string for first-time setup
 *   INVITE_CODE       - code friends need to create an account
 *
 * v5 changes (adds to v4; the current app keeps working):
 *   - New POST /api/ai/gaps: "What am I forgetting?". The app sends the trip's list, outfits,
 *     closet, My Items and forecast as plain fields; the worker caps them, writes the prompt
 *     itself and returns {items:[{item, category, reason, source}]} (at most 8).
 *   - /api/ai/suggest no longer accepts a free-form prompt from the app. It still answers the
 *     older app with 14 suggestions, but writes that prompt itself from the trip fields.
 *   - AI answers get more room (max_tokens 1000 -> 2000, gap check 4000). Claude Haiku 5.5 thinks
 *     before answering and that counts toward the limit, so 1000 could run out before any answer.
 *     An empty reply now says whether it ran out of room, and the reason is logged.
 *
 * v4 changes (same API as v3, so the current app keeps working):
 *   - Each trip is stored in its own KV record (trip:<id>) instead of one shared "trips" record,
 *     so two devices or two people saving at once can't wipe each other's trips.
 *   - One-time automatic move from the old "trips" record. The old record is left untouched,
 *     and a full copy is also saved as backup:legacy-trips:<time> (kept forever).
 *   - Automatic backups: before a trip, closet, My Items or profile is overwritten or deleted,
 *     the previous version is saved (at most one every 15 minutes per record, last 30 kept,
 *     deleted trips kept 90 days). New endpoints to list and restore them.
 *   - Admin-only full export: GET /api/admin/export (everything except passwords and sessions).
 *   - Revoking a share link now really revokes it, and only a trip's owner can change
 *     who it's shared with or create/revoke its link.
 *   - Optional stale-copy protection: if the app sends _baseUpdatedAt and the trip changed
 *     on another device since, the save is refused with 409 instead of overwriting.
 *   - Sign-in and sign-up: 5 free wrong tries per device, then growing waits (1/5/15/30/60 min).
 *   - AI calls report a real error (502) instead of silently returning nothing; prompt length capped.
 *   - Server errors no longer return internal details.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const BACKUP_MIN_GAP_MS = 15 * 60 * 1000;      // at most one backup per record every 15 min
const BACKUP_KEEP = 30;                         // keep the last 30 per record
const BACKUP_TTL_SECONDS = 60 * 60 * 24 * 60;   // routine backups expire after 60 days
const DELETED_TTL_SECONDS = 60 * 60 * 24 * 90;  // deleted trips kept 90 days
const MAX_PROMPT_CHARS = 6000;
const GAP_PROMPT_CHARS = 12000;               // gap check prompt cap (written by the worker)
const LOCK_STEPS_MIN = [1, 5, 15, 30, 60];      // waits after the 5th, 6th, ... wrong try
const FREE_TRIES = 5;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...(err.extra || {}) }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  }
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const m = request.method;

  if (path === '/api/auth/register'      && m === 'POST')   return handleRegister(request, env);
  if (path === '/api/auth/login'         && m === 'POST')   return handleLogin(request, env);
  if (path === '/api/auth/logout'        && m === 'POST')   return handleLogout(request, env);
  if (path === '/api/auth/me'            && m === 'GET')    return handleMe(request, env);
  if (path === '/api/users/lookup'       && m === 'GET')    return handleLookupUser(request, env, url);
  if (path === '/api/users'              && m === 'GET')    return handleGetUsers(request, env);
  if (path === '/api/users'              && m === 'POST')   return handleCreateUser(request, env);
  if (/^\/api\/users\/[^/]+\/self$/.test(path) && m === 'PUT')    return handleUpdateSelf(request, env, path);
  if (/^\/api\/users\/[^/]+\/self$/.test(path) && m === 'DELETE') return handleDeleteSelf(request, env, path);
  if (path.startsWith('/api/users/')     && m === 'PUT')    return handleUpdateUser(request, env, path);
  if (path.startsWith('/api/users/')     && m === 'DELETE') return handleDeleteUser(request, env, path);
  if (path.startsWith('/api/shared/')    && m === 'GET')    return handleGetSharedTrip(request, env, path);
  if (path === '/api/trips'              && m === 'GET')    return handleGetTrips(request, env);
  if (path === '/api/trips'              && m === 'POST')   return handleCreateTrip(request, env);
  if (path.startsWith('/api/trips/')     && m === 'GET')    return handleGetTrip(request, env, path);
  if (path.startsWith('/api/trips/')     && m === 'PUT')    return handleUpdateTrip(request, env, path);
  if (path.startsWith('/api/trips/')     && m === 'DELETE') return handleDeleteTrip(request, env, path);
  if (path === '/api/templates'          && m === 'GET')    return handleGetTemplates(request, env);
  if (path === '/api/templates'          && m === 'POST')   return handleSaveTemplate(request, env);
  if (path.startsWith('/api/templates/') && m === 'DELETE') return handleDeleteTemplate(request, env, path);
  if (path.startsWith('/api/closet')     && m === 'GET')    return handleGetUserRecord(request, env, path, 'closet', []);
  if (path.startsWith('/api/closet')     && m === 'PUT')    return handleSaveUserRecord(request, env, path, 'closet');
  if (path.startsWith('/api/library')    && m === 'GET')    return handleGetUserRecord(request, env, path, 'library', []);
  if (path.startsWith('/api/library')    && m === 'PUT')    return handleSaveUserRecord(request, env, path, 'library');
  if (path.startsWith('/api/profile')    && m === 'GET')    return handleGetProfile(request, env);
  if (path.startsWith('/api/profile')    && m === 'PUT')    return handleSaveProfile(request, env);
  if (path === '/api/backups'            && m === 'GET')    return handleListBackups(request, env, url);
  if (path === '/api/backups/restore'    && m === 'POST')   return handleRestoreBackup(request, env);
  if (path === '/api/admin/export'       && m === 'GET')    return handleAdminExport(request, env);
  if (path === '/api/ai/suggest'         && m === 'POST')   return handleAISuggest(request, env);
  if (path === '/api/ai/gaps'            && m === 'POST')   return handleAIGaps(request, env);
  if (path === '/api/ai/weather'         && m === 'POST')   return handleAIWeather(request, env);
  if (path === '/api/setup'              && m === 'POST')   return handleSetup(request, env);
  return json({ error: 'Not found' }, 404);
}

// ── PASSWORD HASHING (PBKDF2-SHA256, 100k iterations) ── unchanged from v3

async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    keyMaterial, 256
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = btoa(String.fromCharCode(...new Uint8Array(bits)));
  return `${saltB64}:${hashB64}`;
}

async function verifyPassword(password, stored) {
  try {
    const [saltB64, hashB64] = stored.split(':');
    const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
    const expectedHash = atob(hashB64);
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
      keyMaterial, 256
    );
    const actualHash = String.fromCharCode(...new Uint8Array(bits));
    if (actualHash.length !== expectedHash.length) return false;
    let diff = 0;
    for (let i = 0; i < actualHash.length; i++) diff |= actualHash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

// ── WRONG-GUESS LIMITS ──

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function checkLock(env, kind, request) {
  const key = `rl:${kind}:${clientIp(request)}`;
  const raw = await env.PACKTR_KV.get(key);
  const rec = raw ? JSON.parse(raw) : { fails: 0, until: 0 };
  if (rec.until && Date.now() < rec.until) {
    const mins = Math.ceil((rec.until - Date.now()) / 60000);
    throw new HttpError(429, `Too many wrong tries. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`);
  }
  return { key, rec };
}

async function recordFail(env, lock) {
  const rec = lock.rec;
  rec.fails = (rec.fails || 0) + 1;
  if (rec.fails >= FREE_TRIES) {
    const step = Math.min(rec.fails - FREE_TRIES, LOCK_STEPS_MIN.length - 1);
    rec.until = Date.now() + LOCK_STEPS_MIN[step] * 60000;
  }
  await env.PACKTR_KV.put(lock.key, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 });
}

async function clearFails(env, lock) {
  if (lock.rec.fails) await env.PACKTR_KV.delete(lock.key);
}

// ── SESSIONS ──

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(env, userId) {
  const token = randomToken();
  await env.PACKTR_KV.put('session:' + token, JSON.stringify({ userId, createdAt: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

function readToken(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.replace('Bearer ', '').trim();
}

async function loadUsers(env) {
  const raw = await env.PACKTR_KV.get('users');
  return raw ? JSON.parse(raw) : [];
}

async function authenticate(request, env) {
  const token = readToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Please sign in again.');
  const sessionRaw = await env.PACKTR_KV.get('session:' + token);
  if (!sessionRaw) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  const { userId } = JSON.parse(sessionRaw);
  const users = await loadUsers(env);
  const user = users.find(u => u.id === userId);
  if (!user) {
    await env.PACKTR_KV.delete('session:' + token);
    throw new HttpError(401, 'Account not found. Please sign in again.');
  }
  return { user, users, token };
}

async function requireAdmin(request, env) {
  const ctx = await authenticate(request, env);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Admin required');
  return ctx;
}

function safeUser(u) {
  const { passwordHash, pin, ...rest } = u;
  return rest;
}

function publicUser(u) {
  return { id: u.id, name: u.name, initials: u.initials };
}

// ── REGISTER / LOGIN / LOGOUT / ME ──

async function handleRegister(request, env) {
  const lock = await checkLock(env, 'register', request);
  const { name, email, password, inviteCode } = await request.json();

  const expectedCode = env.INVITE_CODE || '';
  if (!expectedCode || inviteCode !== expectedCode) {
    await recordFail(env, lock);
    return json({ error: 'Invalid invite code. Ask Zak for the code to join PacktRite.' }, 403);
  }
  if (!name || !email || !password) return json({ error: 'Name, email and password are required.' }, 400);
  if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Please enter a valid email address.' }, 400);

  const users = await loadUsers(env);
  if (users.find(u => u.email?.toLowerCase() === email.toLowerCase())) {
    return json({ error: 'An account with that email already exists.' }, 409);
  }

  const newUser = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    passwordHash: await hashPassword(password),
    role: 'user',
    initials: name.trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
    showPersonalCare: false,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  await env.PACKTR_KV.put('users', JSON.stringify(users));
  await clearFails(env, lock);

  const token = await createSession(env, newUser.id);
  return json({ ok: true, user: safeUser(newUser), token }, 201);
}

async function handleLogin(request, env) {
  const lock = await checkLock(env, 'login', request);
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: 'Email and password are required.' }, 400);

  const users = await loadUsers(env);
  const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase());
  const valid = !!(user && user.passwordHash && await verifyPassword(password, user.passwordHash));
  if (!valid) {
    await recordFail(env, lock);
    return json({ error: 'Incorrect email or password.' }, 401);
  }
  await clearFails(env, lock);
  const token = await createSession(env, user.id);
  return json({ ok: true, user: safeUser(user), token });
}

async function handleLogout(request, env) {
  const token = readToken(request);
  if (/^[a-f0-9]{64}$/.test(token)) await env.PACKTR_KV.delete('session:' + token);
  return json({ ok: true });
}

async function handleMe(request, env) {
  const { user } = await authenticate(request, env);
  return json({ ok: true, user: safeUser(user) });
}

// ── SELF-UPDATE ──

async function handleUpdateSelf(request, env, path) {
  const { user, users } = await authenticate(request, env);
  const userId = path.split('/')[3];
  if (userId !== user.id) return json({ error: 'Forbidden' }, 403);
  const idx = users.findIndex(u => u.id === user.id);
  if (idx === -1) return json({ error: 'User not found' }, 404);
  const { name, email, password, showPersonalCare } = await request.json();
  if (name) users[idx].name = name.trim();
  if (email) {
    const taken = users.find(u => u.id !== user.id && u.email?.toLowerCase() === email.toLowerCase());
    if (taken) return json({ error: 'That email is already in use.' }, 409);
    users[idx].email = email.toLowerCase().trim();
  }
  if (password) {
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400);
    users[idx].passwordHash = await hashPassword(password);
  }
  if (typeof showPersonalCare === 'boolean') users[idx].showPersonalCare = showPersonalCare;
  users[idx].updatedAt = new Date().toISOString();
  await env.PACKTR_KV.put('users', JSON.stringify(users));
  return json(safeUser(users[idx]));
}

async function handleDeleteSelf(request, env, path) {
  const { user, users, token } = await authenticate(request, env);
  const userId = path.split('/')[3];
  if (userId !== user.id) return json({ error: 'Forbidden' }, 403);
  await env.PACKTR_KV.put('users', JSON.stringify(users.filter(u => u.id !== user.id)));
  const trips = await loadAccessibleTrips(env, user);
  for (const t of trips) {
    if (t.ownerId === user.id) await deleteTripRecord(env, t);
  }
  await env.PACKTR_KV.delete('closet:' + user.id);
  await env.PACKTR_KV.delete('library:' + user.id);
  await env.PACKTR_KV.delete('profile:' + user.id);
  await env.PACKTR_KV.delete('idx:' + user.id);
  await env.PACKTR_KV.delete('session:' + token);
  return json({ ok: true });
}

// ── TRIP STORAGE (v4: one record per trip) ──
//   trip:<id>   the trip itself; KV metadata { o: ownerId, s: sharedWith }
//   idx:<user>  list of trip ids the user owns or has been shared (helps right after a save,
//               since KV listings can lag up to a minute)

let migratedThisIsolate = false;

async function ensureMigrated(env) {
  if (migratedThisIsolate) return;
  if (await env.PACKTR_KV.get('meta:v4-migrated')) { migratedThisIsolate = true; return; }
  const legacyRaw = await env.PACKTR_KV.get('trips');
  if (legacyRaw) {
    // Keep a permanent copy of the old record before doing anything. The "trips" record itself is left untouched.
    await env.PACKTR_KV.put('backup:legacy-trips:' + new Date().toISOString(), legacyRaw);
    const legacy = JSON.parse(legacyRaw);
    for (const trip of legacy) {
      if (!trip || !trip.id) continue;
      // Never overwrite a trip that already exists in the new format.
      if (!(await env.PACKTR_KV.get('trip:' + trip.id))) await writeTrip(env, trip);
      await addToIndexes(env, trip);
    }
  }
  await env.PACKTR_KV.put('meta:v4-migrated', new Date().toISOString());
  migratedThisIsolate = true;
}

function tripMeta(trip, lastBackup) {
  const md = { o: trip.ownerId, s: (trip.sharedWith || []).slice(0, 20) };
  if (lastBackup) md.b = lastBackup;
  return md;
}

async function writeTrip(env, trip, lastBackup) {
  await env.PACKTR_KV.put('trip:' + trip.id, JSON.stringify(trip), { metadata: tripMeta(trip, lastBackup) });
}

async function readTrip(env, id) {
  const raw = await env.PACKTR_KV.get('trip:' + id);
  return raw ? JSON.parse(raw) : null;
}

async function addToIndexes(env, trip) {
  const ids = [trip.ownerId, ...(trip.sharedWith || [])].filter(Boolean);
  for (const uid of ids) {
    const raw = await env.PACKTR_KV.get('idx:' + uid);
    const list = raw ? JSON.parse(raw) : [];
    if (!list.includes(trip.id)) {
      list.push(trip.id);
      await env.PACKTR_KV.put('idx:' + uid, JSON.stringify(list));
    }
  }
}

async function removeFromIndex(env, userId, tripId) {
  const raw = await env.PACKTR_KV.get('idx:' + userId);
  if (!raw) return;
  const list = JSON.parse(raw).filter(id => id !== tripId);
  await env.PACKTR_KV.put('idx:' + userId, JSON.stringify(list));
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.PACKTR_KV.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

function canAccess(trip, user) {
  return trip.ownerId === user.id || (trip.sharedWith || []).includes(user.id);
}

async function loadAccessibleTrips(env, user) {
  await ensureMigrated(env);
  const ids = new Set();
  const idxRaw = await env.PACKTR_KV.get('idx:' + user.id);
  if (idxRaw) JSON.parse(idxRaw).forEach(id => ids.add(id));
  for (const k of await listAll(env, 'trip:')) {
    const md = k.metadata || {};
    if (md.o === user.id || (md.s || []).includes(user.id) || !k.metadata) ids.add(k.name.slice(5));
  }
  const trips = [];
  for (const id of ids) {
    const t = await readTrip(env, id);
    if (t && canAccess(t, user)) trips.push(t);
  }
  return trips;
}

async function deleteTripRecord(env, trip) {
  await env.PACKTR_KV.put(`bak:deleted:${trip.id}:${new Date().toISOString()}`, JSON.stringify(trip),
    { expirationTtl: DELETED_TTL_SECONDS, metadata: { o: trip.ownerId, n: tripName(trip) } });
  await env.PACKTR_KV.delete('trip:' + trip.id);
  for (const uid of [trip.ownerId, ...(trip.sharedWith || [])]) await removeFromIndex(env, uid, trip.id);
}

function tripName(trip) {
  return String(trip.tripName || trip.destination || 'Trip').slice(0, 80);
}

// ── BACKUPS ──
//   bak:<kind>:<id>:<ISO time>  previous version, taken before an overwrite.
//   The time of the last backup is kept in the record's own KV metadata (b), so a normal save
//   costs no extra reads or listings; a listing only happens when a backup is actually taken.

async function backupBeforeWrite(env, kind, id, previousRaw, lastBackup, meta) {
  if (!previousRaw) return lastBackup || null;
  if (lastBackup && Date.now() - Date.parse(lastBackup) < BACKUP_MIN_GAP_MS) return lastBackup;
  const prefix = `bak:${kind}:${id}:`;
  const now = new Date().toISOString();
  await env.PACKTR_KV.put(prefix + now, previousRaw, { expirationTtl: BACKUP_TTL_SECONDS, metadata: meta || {} });
  const keys = (await listAll(env, prefix)).map(k => k.name).sort();
  const excess = keys.length - BACKUP_KEEP;
  for (let i = 0; i < excess; i++) await env.PACKTR_KV.delete(keys[i]);
  return now;
}

async function readWithMeta(env, key) {
  const { value, metadata } = await env.PACKTR_KV.getWithMetadata(key);
  return { raw: value, last: (metadata && metadata.b) || null };
}

async function writeUserRecord(env, kind, userId, data) {
  const key = `${kind}:${userId}`;
  const cur = await readWithMeta(env, key);
  const b = await backupBeforeWrite(env, kind, userId, cur.raw, cur.last);
  await env.PACKTR_KV.put(key, typeof data === 'string' ? data : JSON.stringify(data), { metadata: b ? { b } : {} });
}

async function handleListBackups(request, env, url) {
  const { user } = await authenticate(request, env);
  const kind = url.searchParams.get('kind') || 'trip';
  let prefix;
  if (kind === 'trip') {
    const id = url.searchParams.get('id') || '';
    const trip = await readTrip(env, id);
    if (!trip || !canAccess(trip, user)) return json({ error: 'Not found' }, 404);
    prefix = `bak:trip:${id}:`;
  } else if (kind === 'deleted') {
    const keys = await listAll(env, 'bak:deleted:');
    return json(keys.filter(k => (k.metadata || {}).o === user.id)
      .map(k => ({ key: k.name, savedAt: k.name.split(':').slice(3).join(':'), name: (k.metadata || {}).n || 'Trip' }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
  } else if (['closet', 'library', 'profile'].includes(kind)) {
    prefix = `bak:${kind}:${user.id}:`;
  } else {
    return json({ error: 'Unknown backup kind' }, 400);
  }
  const keys = await listAll(env, prefix);
  return json(keys.map(k => ({ key: k.name, savedAt: k.name.slice(prefix.length) }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
}

async function handleRestoreBackup(request, env) {
  const { user } = await authenticate(request, env);
  const { key } = await request.json();
  if (typeof key !== 'string' || !key.startsWith('bak:')) return json({ error: 'Invalid backup' }, 400);
  const raw = await env.PACKTR_KV.get(key);
  if (!raw) return json({ error: 'That backup has expired or no longer exists.' }, 404);
  const [, kind, id] = key.split(':');

  if (kind === 'trip' || kind === 'deleted') {
    const backup = JSON.parse(raw);
    const cur = await readWithMeta(env, 'trip:' + id);
    const current = cur.raw ? JSON.parse(cur.raw) : null;
    if (kind === 'trip' && (!current || !canAccess(current, user))) return json({ error: 'Forbidden' }, 403);
    if (kind === 'deleted' && backup.ownerId !== user.id) return json({ error: 'Forbidden' }, 403);
    const b = current ? await backupBeforeWrite(env, 'trip', id, cur.raw, null, { n: tripName(current) }) : null;
    // Owner and sharing always follow the current record, so a restore can't change who sees the trip.
    const restored = { ...backup, id,
      ownerId: current ? current.ownerId : backup.ownerId,
      sharedWith: current ? (current.sharedWith || []) : (backup.sharedWith || []),
      updatedAt: new Date().toISOString(), restoredFrom: key };
    if (current && current.shareToken) restored.shareToken = current.shareToken; else delete restored.shareToken;
    await writeTrip(env, restored, b);
    await addToIndexes(env, restored);
    return json(restored);
  }
  if (['closet', 'library', 'profile'].includes(kind)) {
    if (id !== user.id) return json({ error: 'Forbidden' }, 403);
    // Always back up the current version before a restore (ignores the 15-minute gap).
    const cur = await readWithMeta(env, `${kind}:${user.id}`);
    const b = await backupBeforeWrite(env, kind, user.id, cur.raw, null);
    await env.PACKTR_KV.put(`${kind}:${user.id}`, raw, { metadata: b ? { b } : {} });
    return json({ ok: true, data: JSON.parse(raw) });
  }
  return json({ error: 'Invalid backup' }, 400);
}

async function handleAdminExport(request, env) {
  await requireAdmin(request, env);
  await ensureMigrated(env);
  const out = { exportedAt: new Date().toISOString(), users: [], trips: [], templates: [], closet: {}, library: {}, profile: {} };
  out.users = (await loadUsers(env)).map(u => { const { passwordHash, pin, ...rest } = u; return rest; });
  for (const k of await listAll(env, 'trip:')) {
    const t = await env.PACKTR_KV.get(k.name);
    if (t) out.trips.push(JSON.parse(t));
  }
  const tpl = await env.PACKTR_KV.get('templates');
  out.templates = tpl ? JSON.parse(tpl) : [];
  for (const kind of ['closet', 'library', 'profile']) {
    for (const k of await listAll(env, kind + ':')) {
      const v = await env.PACKTR_KV.get(k.name);
      if (v) out[kind][k.name.slice(kind.length + 1)] = JSON.parse(v);
    }
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { ...CORS, 'Content-Type': 'application/json',
    'Content-Disposition': `attachment; filename="packtrite-backup-${out.exportedAt.slice(0, 10)}.json"` } });
}

// ── SHARED TRIP (read-only, no auth) ──

async function handleGetSharedTrip(request, env, path) {
  const token = path.split('/').pop();
  if (!/^[a-f0-9]{16,128}$/.test(token || '')) return json({ error: 'Invalid share token' }, 400);
  await ensureMigrated(env);
  // Share tokens are indexed so a lookup doesn't need to scan every trip.
  const tripId = await env.PACKTR_KV.get('share:' + token);
  let trip = tripId ? await readTrip(env, tripId) : null;
  if (!trip) {
    // Links made before v4 have no index entry yet: scan once and remember.
    for (const k of await listAll(env, 'trip:')) {
      const t = await readTrip(env, k.name.slice(5));
      if (t && t.shareToken === token) { trip = t; await env.PACKTR_KV.put('share:' + token, t.id); break; }
    }
  }
  if (!trip || trip.shareToken !== token) return json({ error: 'Trip not found or share link has been revoked.' }, 404);
  const { ownerId, sharedWith, shareToken, ...safeTripData } = trip;
  return json({ ...safeTripData });
}

// ── USERS ──

async function handleGetUsers(request, env) {
  const { user, users } = await authenticate(request, env);
  if (user.role === 'admin') {
    return json(users.map(u => {
      const { passwordHash, pin, ...rest } = u;
      return { ...rest, hasPassword: !!passwordHash };
    }));
  }
  const trips = await loadAccessibleTrips(env, user);
  const ids = new Set([user.id]);
  trips.forEach(t => { ids.add(t.ownerId); (t.sharedWith || []).forEach(id => ids.add(id)); });
  return json(users.filter(u => ids.has(u.id)).map(publicUser));
}

async function handleLookupUser(request, env, url) {
  const { users } = await authenticate(request, env);
  const email = (url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return json({ error: 'Email required' }, 400);
  const match = users.find(u => u.email?.toLowerCase() === email);
  if (!match) return json({ error: 'No PacktRite account found with that email.' }, 404);
  return json(publicUser(match));
}

async function handleCreateUser(request, env) {
  const { user: admin, users } = await requireAdmin(request, env);
  const { name, email, password, role, showPersonalCare } = await request.json();
  if (!name) return json({ error: 'Name is required' }, 400);

  let passwordHash;
  if (password) {
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
    passwordHash = await hashPassword(password);
  }
  if (email && users.find(u => u.email?.toLowerCase() === email.toLowerCase())) {
    return json({ error: 'Email already in use' }, 409);
  }

  const newUser = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: email?.toLowerCase().trim() || '',
    passwordHash,
    role: role || 'user',
    initials: name.trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
    showPersonalCare: !!showPersonalCare,
    createdAt: new Date().toISOString(),
    createdBy: admin.id,
  };
  users.push(newUser);
  await env.PACKTR_KV.put('users', JSON.stringify(users));
  return json(safeUser(newUser), 201);
}

async function handleUpdateUser(request, env, path) {
  const { users } = await requireAdmin(request, env);
  const userId = path.split('/').pop();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return json({ error: 'User not found' }, 404);
  const { name, password, email, role, showPersonalCare } = await request.json();
  if (name) users[idx].name = name.trim();
  if (email) users[idx].email = email.toLowerCase().trim();
  if (password) {
    if (password.length < 6) return json({ error: 'Password must be at least 6 characters' }, 400);
    users[idx].passwordHash = await hashPassword(password);
    delete users[idx].pin;
  }
  if (role) users[idx].role = role;
  if (typeof showPersonalCare === 'boolean') users[idx].showPersonalCare = showPersonalCare;
  users[idx].updatedAt = new Date().toISOString();
  await env.PACKTR_KV.put('users', JSON.stringify(users));
  return json(safeUser(users[idx]));
}

async function handleDeleteUser(request, env, path) {
  const { user: admin, users } = await requireAdmin(request, env);
  const userId = path.split('/').pop();
  if (userId === admin.id) return json({ error: "Can't delete yourself" }, 400);
  // Their trips are left in place (and still in backups); only the account goes.
  await env.PACKTR_KV.put('users', JSON.stringify(users.filter(u => u.id !== userId)));
  return json({ ok: true });
}

// ── TRIPS ──

async function handleGetTrips(request, env) {
  const { user } = await authenticate(request, env);
  return json(await loadAccessibleTrips(env, user));
}

async function handleGetTrip(request, env, path) {
  const { user } = await authenticate(request, env);
  await ensureMigrated(env);
  const trip = await readTrip(env, path.split('/').pop());
  if (!trip) return json({ error: 'Not found' }, 404);
  if (!canAccess(trip, user)) return json({ error: 'Forbidden' }, 403);
  return json(trip);
}

async function handleCreateTrip(request, env) {
  const { user } = await authenticate(request, env);
  await ensureMigrated(env);
  const body = await request.json();
  delete body._baseUpdatedAt;
  let id = typeof body.id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(body.id) ? body.id : crypto.randomUUID();
  const existing = await readTrip(env, id);
  if (existing) {
    // Same trip sent twice by the owner (e.g. a retry): treat as a save. Anyone else gets a fresh id.
    if (existing.ownerId === user.id) return json(existing, 200);
    id = crypto.randomUUID();
  }
  const sharedWith = Array.isArray(body.sharedWith) ? body.sharedWith.filter(s => typeof s === 'string') : [];
  const now = new Date().toISOString();
  const trip = { createdAt: now, ...body, id, sharedWith, ownerId: user.id, updatedAt: now };
  await writeTrip(env, trip);
  await addToIndexes(env, trip);
  if (trip.shareToken) await env.PACKTR_KV.put('share:' + trip.shareToken, trip.id);
  return json(trip, 201);
}

async function handleUpdateTrip(request, env, path) {
  const { user } = await authenticate(request, env);
  await ensureMigrated(env);
  const tripId = path.split('/').pop();
  const { raw: currentRaw, last: lastBackup } = await readWithMeta(env, 'trip:' + tripId);
  if (!currentRaw) return json({ error: 'Not found' }, 404);
  const current = JSON.parse(currentRaw);
  if (!canAccess(current, user)) return json({ error: 'Forbidden' }, 403);
  const body = await request.json();

  // Stale-copy protection (only when the app sends the version it started from).
  const base = body._baseUpdatedAt;
  delete body._baseUpdatedAt;
  if (base && current.updatedAt && base !== current.updatedAt) {
    throw new HttpError(409, 'This trip was changed on another device. Reload to get the latest version.', { trip: current });
  }

  const isOwner = current.ownerId === user.id;
  // The app always sends the whole trip, so the body replaces the record (this is what makes
  // "Revoke" work: a missing shareToken now really removes it).
  const next = { ...body, id: tripId, ownerId: current.ownerId, createdAt: current.createdAt || body.createdAt,
    updatedAt: new Date().toISOString() };
  if (isOwner) {
    next.sharedWith = Array.isArray(body.sharedWith) ? body.sharedWith.filter(s => typeof s === 'string') : [];
    if (!body.shareToken) delete next.shareToken;
  } else {
    // Only the owner decides who sees the trip.
    next.sharedWith = current.sharedWith || [];
    if (current.shareToken) next.shareToken = current.shareToken; else delete next.shareToken;
  }

  const b = await backupBeforeWrite(env, 'trip', tripId, currentRaw, lastBackup, { n: tripName(current) });
  await writeTrip(env, next, b);

  // Keep the share-link index and per-user lists in step.
  if (current.shareToken && current.shareToken !== next.shareToken) await env.PACKTR_KV.delete('share:' + current.shareToken);
  if (next.shareToken && next.shareToken !== current.shareToken) await env.PACKTR_KV.put('share:' + next.shareToken, tripId);
  const removed = (current.sharedWith || []).filter(id => !next.sharedWith.includes(id));
  for (const uid of removed) await removeFromIndex(env, uid, tripId);
  if (next.sharedWith.some(id => !(current.sharedWith || []).includes(id))) await addToIndexes(env, next);

  return json(next);
}

async function handleDeleteTrip(request, env, path) {
  const { user } = await authenticate(request, env);
  await ensureMigrated(env);
  const trip = await readTrip(env, path.split('/').pop());
  if (!trip) return json({ error: 'Not found' }, 404);
  if (trip.ownerId !== user.id) return json({ error: 'Only the owner can delete' }, 403);
  if (trip.shareToken) await env.PACKTR_KV.delete('share:' + trip.shareToken);
  await deleteTripRecord(env, trip);
  return json({ ok: true });
}

// ── TEMPLATES ── unchanged from v3

async function handleGetTemplates(request, env) {
  await authenticate(request, env);
  const raw = await env.PACKTR_KV.get('templates');
  return json(raw ? JSON.parse(raw) : []);
}

async function handleSaveTemplate(request, env) {
  const { user } = await authenticate(request, env);
  const body = await request.json();
  const template = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...body, createdBy: user.id };
  const raw = await env.PACKTR_KV.get('templates');
  const templates = raw ? JSON.parse(raw) : [];
  templates.push(template);
  await env.PACKTR_KV.put('templates', JSON.stringify(templates));
  return json(template, 201);
}

async function handleDeleteTemplate(request, env, path) {
  const { user } = await authenticate(request, env);
  const tplId = path.split('/').pop();
  const raw = await env.PACKTR_KV.get('templates');
  const templates = raw ? JSON.parse(raw) : [];
  const tpl = templates.find(t => t.id === tplId);
  if (!tpl) return json({ error: 'Not found' }, 404);
  if (tpl.createdBy !== user.id && user.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  await env.PACKTR_KV.put('templates', JSON.stringify(templates.filter(t => t.id !== tplId)));
  return json({ ok: true });
}

// ── CLOSET / LIBRARY / PROFILE (now backed up before each overwrite) ──

async function handleGetUserRecord(request, env, path, kind, empty) {
  const { user } = await authenticate(request, env);
  if (path.split('/').pop() !== user.id) return json({ error: 'Forbidden' }, 403);
  const raw = await env.PACKTR_KV.get(`${kind}:${user.id}`);
  return json(raw ? JSON.parse(raw) : empty);
}

async function handleSaveUserRecord(request, env, path, kind) {
  const { user } = await authenticate(request, env);
  if (path.split('/').pop() !== user.id) return json({ error: 'Forbidden' }, 403);
  await writeUserRecord(env, kind, user.id, await request.json());
  return json({ ok: true });
}

async function handleGetProfile(request, env) {
  const { user } = await authenticate(request, env);
  const raw = await env.PACKTR_KV.get('profile:' + user.id);
  return json(raw ? JSON.parse(raw) : {});
}

async function handleSaveProfile(request, env) {
  const { user } = await authenticate(request, env);
  await writeUserRecord(env, 'profile', user.id, await request.json());
  return json({ ok: true });
}

// ── AI ──

async function handleAISuggest(request, env) {
  // Kept for the older app. Any "prompt" it sends is ignored; the worker writes its own.
  await authenticate(request, env);
  const body = await request.json().catch(() => ({}));
  const clip = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').slice(0, n);
  const prompt =
    'Travel packing assistant. Generate 14 specific packing suggestions tailored to this trip.' +
    '\n\nDestination: ' + clip(body.destination, 120) +
    '\nType: ' + (clip(body.type, 40) || 'leisure') +
    (body.reason ? '\nReason: ' + clip(body.reason, 200) : '') +
    (body.weatherSummary ? '\nWeather: ' + clip(body.weatherSummary, 400) : '') +
    '\n\nReturn ONLY a JSON array of 14 strings. No preamble.';
  return callAI(env, prompt);
}

async function handleAIGaps(request, env) {
  await authenticate(request, env);
  const d = cleanGapData(await request.json().catch(() => ({})));
  const text = await askAI(env, buildGapPrompt(d, GAP_PROMPT_CHARS), 4000, GAP_PROMPT_CHARS);
  const items = parseGapItems(text, d.categories);
  if (!items) throw new HttpError(502, 'The check came back unreadable. Please try again.');
  return json({ items });
}

async function handleAIWeather(request, env) {
  await authenticate(request, env);
  const { destination, weatherSummary, packingList } = await request.json();
  const prompt = `Packing expert. 4-6 specific actionable recommendations.\n\nDestination: ${destination}\nWeather: ${weatherSummary}\nPacking list: ${packingList}\n\nReturn ONLY JSON array: [{"icon":"emoji","title":"title","text":"recommendation"}]. No preamble.`;
  return callAI(env, prompt);
}

async function askAI(env, prompt, maxTokens, maxChars) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: maxTokens || 1000,
      messages: [{ role: 'user', content: String(prompt).slice(0, maxChars || MAX_PROMPT_CHARS) }] }),
  });
  if (!res.ok) {
    console.error('AI error', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, 'AI suggestions are unavailable right now.');
  }
  const data = await res.json();
  const text = data.content?.map(c => c.text || '').join('') || '';
  if (!text) {
    console.error('AI empty reply', data.stop_reason, JSON.stringify(data.usage || {}));
    throw new HttpError(502, data.stop_reason === 'max_tokens' ? 'AI ran out of room before answering.' : 'AI returned no suggestions.');
  }
  return text;
}

async function callAI(env, prompt) {
  // 2000, not 1000: the model thinks before it answers, and that thinking counts toward this limit.
  return json({ result: await askAI(env, prompt, 2000, MAX_PROMPT_CHARS) });
}

// ── GAP CHECK: shared code (the app and the worker carry identical copies) ──
// cleanGapData caps every field, buildGapPrompt writes the prompt, parseGapItems
// turns the AI's reply into at most 6 safe {item, category, reason, source} rows.
function gapClip(v, n) { return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); }
function gapList(a, maxItems, maxLen) { return (Array.isArray(a) ? a : []).map(x => gapClip(x, maxLen)).filter(Boolean).slice(0, maxItems); }
function cleanGapData(b) {
  b = (b && typeof b === 'object') ? b : {};
  const cats = gapList(b.categories, 24, 40);
  if (!cats.some(c => c.toLowerCase() === 'misc')) cats.push('Misc');
  return {
    destination: gapClip(b.destination, 120),
    itinerary: gapList(b.itinerary, 10, 120),
    type: gapClip(b.type, 40),
    reason: gapClip(b.reason, 200),
    dates: gapClip(b.dates, 80),
    days: Math.max(0, Math.min(90, parseInt(b.days, 10) || 0)),
    weather: gapList(b.weather, 20, 80),
    categories: cats,
    packing: (Array.isArray(b.packing) ? b.packing : []).slice(0, 24)
      .map(c => ({ category: gapClip(c && c.category, 40), items: gapList(c && c.items, 100, 70) }))
      .filter(c => c.category),
    outfits: gapList(b.outfits, 40, 160),
    myItems: gapList(b.myItems, 80, 70),
    closet: gapList(b.closet, 150, 70),
  };
}
function gapFit(lines, budget, sep) {
  // Keep whole lines until the budget runs out, then say how many were left out.
  const out = []; let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (used + l.length + sep.length > budget) { out.push('(+' + (lines.length - i) + ' more)'); break; }
    out.push(l); used += l.length + sep.length;
  }
  return out.join(sep);
}
function buildGapPrompt(d, maxChars) {
  const rules =
    'You check a traveler\'s packing list and find what they are forgetting for this specific trip.\n\n' +
    'RULES\n' +
    '- Suggest only things that are missing AND that this trip actually needs. At most 6; fewer is better. If nothing important is missing, return [].\n' +
    '- Read the FORECAST day by day: rain, storms, snow, heat and cold nights should drive suggestions (umbrella, rain shell, warm layer, sun protection), unless the list already covers them.\n' +
    '- Never suggest anything already on the packing list or in the planned outfits, even in other words, or when something listed already covers the same need.\n' +
    '- Check MY ITEMS first: things the traveler usually packs that fit this trip but are not on the list are the likeliest misses.\n' +
    '- When a clothing piece is missing, pick one from CLOSET and use its exact name.\n' +
    '- Flag a quantity shortfall only when it is clear (for example 2 shirts for 7 days), as an item like "3 more shirts".\n' +
    '- Think about the forecast, the purpose and planned outfits, travel documents, chargers and adapters, and toiletries.\n' +
    '- "category" must be exactly one of: ' + d.categories.join(', ') + '.\n' +
    '- "reason" is one short phrase under 12 words tied to this trip. When the suggestion is because of the weather, the reason must name the weather and the days or city, like "Rain Tue and Wed" or "Lows near 40°F in Paris".\n' +
    '- "source" is "my-items" if from MY ITEMS, "closet" if from CLOSET, otherwise "new".\n' +
    '- Decide quickly and keep any reasoning brief; the answer must be short.\n\n';
  const tail = '\n\nAnswer with ONLY a JSON array and no other text: [{"item":"...","category":"...","reason":"...","source":"new"}]';
  // The forecast is always sent in full (at most 20 short lines); the rest shares what's left.
  const forecast = d.weather.length ? d.weather.join('\n') : 'No forecast yet (forecasts only cover the next 16 days).';
  const room = Math.max(1200, (maxChars || 12000) - rules.length - tail.length - forecast.length - 450);
  const trip = [
    'Destination: ' + (d.destination || 'unknown'),
    d.itinerary.length > 1 ? 'Itinerary: ' + d.itinerary.join('; ') : '',
    'Trip type: ' + (d.type || 'leisure'),
    d.reason ? 'Purpose: ' + d.reason : '',
    d.dates ? 'Dates: ' + d.dates + (d.days ? ' (' + d.days + ' days)' : '') : (d.days ? 'Length: ' + d.days + ' days' : ''),
  ].filter(Boolean).join('\n');
  const packLines = d.packing.map(c => c.category + ': ' + (c.items.length ? c.items.join(', ') : '(empty)'));
  return rules +
    'TRIP\n' + trip + '\n\n' +
    'FORECAST (day, city, high/low in °F, conditions)\n' + forecast + '\n\n' +
    'ALREADY ON THE PACKING LIST\n' + (packLines.length ? gapFit(packLines, Math.floor(room * 0.46), '\n') : '(nothing yet)') + '\n\n' +
    'ALREADY PLANNED IN OUTFITS (count as packed)\n' + (d.outfits.length ? gapFit(d.outfits, Math.floor(room * 0.12), '\n') : '(none)') + '\n\n' +
    'MY ITEMS (things this traveler usually packs)\n' + (d.myItems.length ? gapFit(d.myItems, Math.floor(room * 0.14), '; ') : '(none saved)') + '\n\n' +
    'CLOSET (clothes this traveler owns)\n' + (d.closet.length ? gapFit(d.closet, Math.floor(room * 0.24), '; ') : '(none saved)') +
    tail;
}
function parseGapItems(text, categories) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('['), z = text.lastIndexOf(']');
  if (a < 0) return null;
  let arr = null;
  if (z > a) { try { arr = JSON.parse(text.slice(a, z + 1)); } catch (e) { arr = null; } }
  if (!Array.isArray(arr)) {
    // A reply cut off part-way: keep every complete {...} row that came before the cut.
    arr = [];
    for (const m of text.slice(a).match(/\{[^{}]*\}/g) || []) { try { arr.push(JSON.parse(m)); } catch (e) {} }
    if (!arr.length) return null;
  }
  const cats = Array.isArray(categories) && categories.length ? categories : ['Misc'];
  const seen = {};
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const item = gapClip(r.item, 60);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    const want = gapClip(r.category, 40).toLowerCase();
    const category = cats.find(c => c.toLowerCase() === want) || cats.find(c => c.toLowerCase() === 'misc') || 'Misc';
    const source = ['my-items', 'closet', 'new'].includes(r.source) ? r.source : 'new';
    out.push({ item, category, reason: gapClip(r.reason, 120), source });
    if (out.length >= 6) break;
  }
  return out;
}
// ── end of shared gap-check code ──

// ── SETUP (first run only) ── unchanged from v3

async function handleSetup(request, env) {
  const body = await request.json();
  if (!env.ADMIN_SECRET || body.secret !== env.ADMIN_SECRET) return json({ error: 'Invalid setup secret' }, 403);
  const existing = await env.PACKTR_KV.get('users');
  if (existing) return json({ error: 'Already set up' }, 400);
  const adminHash = await hashPassword(body.adminPassword || 'changeme123');
  const users = [
    { id: 'u1', name: body.adminName || 'Zak', email: body.adminEmail || '', passwordHash: adminHash, role: 'admin', initials: (body.adminName || 'Zak')[0].toUpperCase(), createdAt: new Date().toISOString() },
  ];
  await env.PACKTR_KV.put('users', JSON.stringify(users));
  return json({ ok: true, message: 'PacktRite initialized!' }, 201);
}

// ── HELPER ──

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
