// NexoCaja · Acceso con PIN, sesiones y permisos por rol.
import crypto from 'node:crypto';

export const ROLES = { owner: 'Dueño', supervisor: 'Supervisor', cashier: 'Cajero' };
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MINUTES = 5;
const COOKIE = 'nx_sess';

/** Qué puede hacer cada rol. El dueño puede todo. */
const PERMS = {
  cashier: ['vender', 'caja.abrir', 'caja.cerrar', 'caja.entrada', 'productos.ver'],
  supervisor: ['vender', 'caja.abrir', 'caja.cerrar', 'caja.entrada', 'caja.salida', 'productos.ver', 'productos.editar',
    'ventas.anular', 'ventas.devolver', 'reportes.ver', 'costos.ver', 'actualizar'],
  owner: ['*']
};
export function can(user, perm) {
  if (!user) return false;
  const p = PERMS[user.role] || [];
  return p.includes('*') || p.includes(perm);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── PIN ───────────────────────────────────────────────────────────
export function validPin(pin) { return /^\d{4,6}$/.test(String(pin || '')); }
export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function checkPin(pin, stored) {
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pin), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}

const sqlDate = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function publicUser(u) {
  return u ? { id: u.id, username: u.username, name: u.full_name, role: u.role_id, roleName: ROLES[u.role_id] || u.role_id } : null;
}

// ── Sesiones ──────────────────────────────────────────────────────
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function currentUser(db, req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{30,}$/.test(token)) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(sha(token));
  if (!row) return null;
  // Sesión deslizante: se renueva mientras se use
  db.prepare(`UPDATE sessions SET expires_at = datetime('now', '+${SESSION_HOURS} hours') WHERE token_hash = ?`).run(sha(token));
  return publicUser(row);
}

function startSession(db, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_HOURS} hours'))`).run(sha(token), userId);
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
}

function endSession(db, req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function audit(db, userId, action, extra = {}) {
  db.prepare('INSERT INTO audit_log (user_id, authorized_by, action, entity, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId || null, extra.authorizedBy || null, action, extra.entity || null, extra.entityId || null,
      extra.detail ? JSON.stringify(extra.detail) : null, extra.ip || null);
}
export { audit };

function needsSetup(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role_id = 'owner' AND pin_hash IS NOT NULL").get().n === 0;
}

/** Verifica el PIN de un usuario con bloqueo temporal tras varios intentos. */
async function verifyUserPin(db, user, pin) {
  if (user.locked_until && sqlDate(user.locked_until) > new Date()) {
    throw new HttpError(423, `Usuario bloqueado por intentos fallidos. Intenta en unos minutos.`);
  }
  if (validPin(pin) && checkPin(pin, user.pin_hash)) {
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    return true;
  }
  const fails = (user.failed_attempts || 0) + 1;
  if (fails >= MAX_FAILS) {
    db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = datetime('now', '+${LOCK_MINUTES} minutes') WHERE id = ?`).run(user.id);
  } else {
    db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(fails, user.id);
  }
  await sleep(400);
  return false;
}

/**
 * Autorización de supervisor: busca un supervisor o dueño activo con ese PIN.
 * Devuelve el usuario que autoriza o lanza error.
 */
export async function authorizeWithPin(db, pin, perm) {
  if (!validPin(pin)) { await sleep(400); throw new HttpError(403, 'PIN de autorización incorrecto'); }
  const candidates = db.prepare("SELECT * FROM users WHERE active = 1 AND role_id IN ('supervisor','owner') AND pin_hash IS NOT NULL").all();
  for (const u of candidates) {
    if (u.locked_until && sqlDate(u.locked_until) > new Date()) continue;
    if (checkPin(pin, u.pin_hash) && can(publicUser(u), perm)) return publicUser(u);
  }
  await sleep(400);
  throw new HttpError(403, 'PIN de autorización incorrecto');
}

/** El usuario actual puede hacerlo, o un supervisor lo autoriza con su PIN. */
export async function requirePermOrPin(db, user, perm, authPin) {
  if (can(user, perm)) return null;
  if (!authPin) throw new HttpError(403, 'Esta acción necesita autorización de un supervisor');
  return authorizeWithPin(db, authPin, perm);
}

// ── Usuarios ──────────────────────────────────────────────────────
function readUserInput(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = String(body.name || '').trim();
    if (!out.name || out.name.length > 60) throw new HttpError(400, 'Escribe el nombre (máximo 60 letras)');
  }
  if (!partial || body.username !== undefined) {
    out.username = String(body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,30}$/.test(out.username)) throw new HttpError(400, 'El usuario debe tener de 3 a 30 letras o números, sin espacios');
  }
  if (!partial || body.role !== undefined) {
    out.role = String(body.role || '');
    if (!ROLES[out.role]) throw new HttpError(400, 'Rol inválido');
  }
  if (body.pin !== undefined && body.pin !== '' && body.pin !== null) {
    if (!validPin(body.pin)) throw new HttpError(400, 'El PIN debe tener de 4 a 6 números');
    out.pin = String(body.pin);
  } else if (!partial) {
    throw new HttpError(400, 'El PIN debe tener de 4 a 6 números');
  }
  if (body.active !== undefined) out.active = !!body.active;
  return out;
}

function assertPinUnique(db, pin, exceptId = '') {
  // El PIN identifica al supervisor que autoriza, así que no puede repetirse.
  const users = db.prepare('SELECT id, pin_hash FROM users WHERE active = 1 AND pin_hash IS NOT NULL AND id <> ?').all(exceptId);
  if (users.some((u) => checkPin(pin, u.pin_hash))) throw new HttpError(409, 'Ese PIN ya lo usa otra persona. Elige otro.');
}

function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY active DESC, full_name').all().map((u) => ({
    ...publicUser(u), active: !!u.active, hasPin: !!u.pin_hash, createdAt: u.created_at
  }));
}

function activeOwners(db, exceptId = '') {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role_id = 'owner' AND pin_hash IS NOT NULL AND id <> ?").get(exceptId).n;
}

// ── Rutas /api/auth/* y /api/users/* ─────────────────────────────
export async function handleAuth(req, res, pathname, ctx) {
  const { db, json, readJson } = ctx;
  const ip = req.socket.remoteAddress;

  if (pathname === '/api/auth/status' && req.method === 'GET') {
    const setup = needsSetup(db);
    const users = setup ? [] : db.prepare("SELECT id, full_name, role_id FROM users WHERE active = 1 AND pin_hash IS NOT NULL ORDER BY full_name").all()
      .map((u) => ({ id: u.id, name: u.full_name, role: u.role_id, roleName: ROLES[u.role_id] }));
    return json(res, 200, { setup, users, user: currentUser(db, req) });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    if (!needsSetup(db)) throw new HttpError(409, 'El sistema ya tiene dueño configurado');
    const body = await readJson(req);
    const u = readUserInput({ ...body, role: 'owner' });
    // Se reutiliza el usuario "admin" de la 1.1.0 para que las ventas anteriores queden a nombre del dueño.
    const existing = db.prepare("SELECT id FROM users WHERE id = 'u-admin'").get();
    if (existing) {
      db.prepare("UPDATE users SET full_name = ?, username = ?, role_id = 'owner', pin_hash = ?, active = 1, failed_attempts = 0, locked_until = NULL WHERE id = 'u-admin'")
        .run(u.name, u.username, hashPin(u.pin));
    } else {
      db.prepare("INSERT INTO users (id, username, full_name, role_id, pin_hash) VALUES ('u-admin', ?, ?, 'owner', ?)").run(u.username, u.name, hashPin(u.pin));
    }
    audit(db, 'u-admin', 'usuario.configurar_dueno', { ip });
    startSession(db, res, 'u-admin');
    return json(res, 200, { user: publicUser(db.prepare("SELECT * FROM users WHERE id = 'u-admin'").get()) });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readJson(req);
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1 AND pin_hash IS NOT NULL').get(String(body.userId || ''));
    if (!user) throw new HttpError(404, 'Usuario no encontrado');
    const ok = await verifyUserPin(db, user, String(body.pin || ''));
    if (!ok) {
      audit(db, user.id, 'login.fallido', { ip });
      throw new HttpError(401, 'PIN incorrecto');
    }
    startSession(db, res, user.id);
    audit(db, user.id, 'login', { ip });
    return json(res, 200, { user: publicUser(user) });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const u = currentUser(db, req);
    endSession(db, req, res);
    if (u) audit(db, u.id, 'logout', { ip });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const u = currentUser(db, req);
    return u ? json(res, 200, { user: u }) : json(res, 401, { error: 'Inicia sesión' });
  }

  if (pathname.startsWith('/api/users')) {
    const me = ctx.user;
    if (!me) throw new HttpError(401, 'Inicia sesión');
    const parts = pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && parts.length === 2) {
      if (me.role !== 'owner') throw new HttpError(403, 'Solo el dueño administra usuarios');
      return json(res, 200, listUsers(db));
    }
    if (req.method === 'POST' && parts.length === 2) {
      if (me.role !== 'owner') throw new HttpError(403, 'Solo el dueño administra usuarios');
      const u = readUserInput(await readJson(req));
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) throw new HttpError(409, 'Ese usuario ya existe');
      assertPinUnique(db, u.pin);
      const id = `u-${crypto.randomUUID()}`;
      db.prepare('INSERT INTO users (id, username, full_name, role_id, pin_hash) VALUES (?, ?, ?, ?, ?)').run(id, u.username, u.name, u.role, hashPin(u.pin));
      audit(db, me.id, 'usuario.crear', { entity: 'user', entityId: id, detail: { usuario: u.username, rol: u.role }, ip });
      return json(res, 201, listUsers(db).find((x) => x.id === id));
    }
    if (req.method === 'PUT' && parts[2]) {
      const id = parts[2];
      const self = id === me.id;
      const body = await readJson(req);
      // Cualquiera puede cambiar su propio PIN; lo demás solo el dueño.
      if (!self && me.role !== 'owner') throw new HttpError(403, 'Solo el dueño administra usuarios');
      if (self && me.role !== 'owner' && Object.keys(body).some((k) => k !== 'pin' && k !== 'currentPin')) throw new HttpError(403, 'Solo puedes cambiar tu PIN');
      const old = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!old) throw new HttpError(404, 'Usuario no encontrado');
      if (self && body.pin) {
        if (!(validPin(body.currentPin) && checkPin(body.currentPin, old.pin_hash))) throw new HttpError(403, 'Tu PIN actual no es correcto');
      }
      const u = readUserInput(body, { partial: true });
      const losingOwner = old.role_id === 'owner' && ((u.role && u.role !== 'owner') || u.active === false);
      if (losingOwner && activeOwners(db, id) === 0) throw new HttpError(409, 'Debe quedar al menos un dueño activo');
      if (u.username && u.username !== old.username && db.prepare('SELECT 1 FROM users WHERE username = ? AND id <> ?').get(u.username, id)) throw new HttpError(409, 'Ese usuario ya existe');
      if (u.pin) assertPinUnique(db, u.pin, id);
      db.prepare(`UPDATE users SET full_name = COALESCE(?, full_name), username = COALESCE(?, username), role_id = COALESCE(?, role_id),
                  pin_hash = COALESCE(?, pin_hash), active = COALESCE(?, active), failed_attempts = CASE WHEN ? IS NULL THEN failed_attempts ELSE 0 END,
                  locked_until = CASE WHEN ? IS NULL THEN locked_until ELSE NULL END WHERE id = ?`)
        .run(u.name ?? null, u.username ?? null, u.role ?? null, u.pin ? hashPin(u.pin) : null,
          u.active === undefined ? null : (u.active ? 1 : 0), u.pin ? 1 : null, u.pin ? 1 : null, id);
      if (u.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      audit(db, me.id, u.pin && Object.keys(u).length === 1 ? 'usuario.cambiar_pin' : 'usuario.editar', { entity: 'user', entityId: id, ip,
        detail: { nombre: u.name, rol: u.role, activo: u.active } });
      return json(res, 200, listUsers(db).find((x) => x.id === id));
    }
  }
  return false;
}
