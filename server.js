// NexoCaja · servidor local (solo node:http, sin dependencias de npm)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { ROOT, loadConfig, appVersion } from './lib/config.js';

// node:sqlite todavía muestra un aviso "experimental"; lo ocultamos para no asustar al usuario.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.warn(w.message);
});

let dbMod, updater, api, auth, fiscal, returns, reports;
try {
  dbMod = await import('./lib/db.js');
  updater = await import('./lib/updater.js');
  api = await import('./lib/api.js');
  auth = await import('./lib/auth.js');
  fiscal = await import('./lib/fiscal.js');
  returns = await import('./lib/devoluciones.js');
  reports = await import('./lib/reportes.js');
} catch (err) {
  if (/sqlite/i.test(String(err.message))) {
    console.error('\n  Tu versión de Node.js es muy vieja para NexoCaja (necesita 22.13 o superior).');
    console.error('  Ejecuta instalar.bat para actualizarla.\n');
    process.exit(1);
  }
  throw err;
}

const cfg = loadConfig();
const VERSION = appVersion();
const PORT = Number(cfg.puerto) || 3360;
const URL_LOCAL = `http://localhost:${PORT}`;
const startedAt = Date.now();

function logError(err) {
  const line = `[${new Date().toISOString()}] ${err?.stack || err}\n`;
  try { fs.appendFileSync(path.join(ROOT, 'errores.log'), line); } catch { /* noop */ }
}
process.on('uncaughtException', (e) => { logError(e); console.error(e); });
process.on('unhandledRejection', (e) => { logError(e); console.error(e); });

// ── Base de datos ────────────────────────────────────────────────
dbMod.openDb(cfg, VERSION);
dbMod.migrate((m) => console.log(m));
dbMod.seedCompany(cfg);
const ecfEmision = await import('./lib/ecf/emision.js');
const ecfCola = await import('./lib/ecf/cola.js');
const ecfRutas = await import('./lib/ecf/rutas.js');
ecfEmision.initEcf(cfg);
ecfCola.startQueue(dbMod.getDb());
ecfEmision.onEcfIssued(ecfCola.kick);

// ── Estado de trabajos ───────────────────────────────────────────
// Cuando existan ventas/cobros, cada operación en curso hace busy++ / busy--.
const state = { busy: 0, updating: false };

// ── Utilidades HTTP ──────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    ...headers
  });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Solicitud demasiado grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function serveStatic(req, res, pathname) {
  const PUBLIC = path.join(ROOT, 'public');
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(PUBLIC, '.' + rel);
  if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Prohibido');
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(abs).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); // siempre revalidar: tras una actualización el navegador baja lo nuevo
  });
}

// ── Rutas ────────────────────────────────────────────────────────
async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://x');

  if (pathname === '/api/health' && req.method === 'GET') {
    let ok = false;
    try { ok = dbMod.getDb().prepare('SELECT 1 AS ok').get().ok === 1; } catch { /* noop */ }
    return json(res, ok ? 200 : 503, {
      ok, app: 'NexoCaja', version: VERSION, schema: dbMod.schemaVersion(), db: ok ? 'ok' : 'error',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000), node: process.version
    });
  }

  if (pathname === '/api/info' && req.method === 'GET') {
    const company = dbMod.getDb().prepare('SELECT legal_name, trade_name, rnc, branch, tax_regime, address, phone FROM company WHERE id = 1').get();
    return json(res, 200, {
      version: VERSION, company, caja: cfg.caja, dgiiAmbiente: cfg.dgii.ambiente, local: isLocal(req),
      direccion: (company && company.address) || '', telefono: (company && company.phone) || '', fiscalMode: fiscal.fiscalMode(dbMod.getDb())
    });
  }

  if (pathname === '/api/update/check' && req.method === 'GET') {
    try {
      const r = await updater.check();
      return json(res, 200, { ...r, local: isLocal(req) });
    } catch (err) {
      // Sin internet: la interfaz no se rompe
      return json(res, 200, { current: VERSION, available: false, error: `No se pudo revisar: ${err.message}`, local: isLocal(req) });
    }
  }

  if (pathname === '/api/update/apply' && req.method === 'POST') {
    if (!isLocal(req)) return json(res, 403, { error: 'Solo se puede actualizar desde la PC donde está instalado NexoCaja.' });
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Origen no permitido' });
    const who = auth.currentUser(dbMod.getDb(), req);
    if (!who) return json(res, 401, { error: 'Inicia sesión para actualizar.' });
    if (!auth.can(who, 'actualizar')) return json(res, 403, { error: 'Solo el dueño o un supervisor puede actualizar NexoCaja.' });
    if (state.updating) return json(res, 409, { error: 'Ya se está actualizando.' });
    if (state.busy > 0) return json(res, 409, { error: 'Hay una venta en proceso. Espera a que termine para actualizar.' });
    state.updating = true;
    try {
      const plan = await updater.prepare((m) => console.log(m));
      try { dbMod.backup('antes-de-actualizar'); } catch (e) { logError(e); }
      json(res, 200, { ok: true, version: plan.remote.version, changed: plan.changed.length });
      // Copiamos DESPUÉS de responder: con --watch, el reinicio ocurre al cambiar lib/ y server.js
      setTimeout(() => {
        try {
          const r = updater.commit(plan);
          console.log(`\n  ✔ Actualizado a v${r.version} (${r.changed} archivos). Reiniciando…\n`);
          // Con node --watch, el proceso hijo no recibe "--watch" en execArgv, pero sí esta variable.
          const watching = process.execArgv.some((a) => a.startsWith('--watch')) || !!process.env.WATCH_REPORT_DEPENDENCIES;
          if (!watching) {
            setTimeout(() => process.exit(0), 800);
          } else if (!plan.changed.some((p) => p === 'server.js' || p.startsWith('lib/'))) {
            // La actualización no tocó archivos vigilados (solo interfaz, migraciones…):
            // reescribimos server.js igual (mismo contenido) para que --watch reinicie
            // y se apliquen migraciones y la nueva versión.
            const sp = path.join(ROOT, 'server.js');
            fs.writeFileSync(sp, fs.readFileSync(sp));
          }
        } catch (err) {
          logError(err);
          console.error('  ✖ Error al copiar la actualización:', err.message);
        } finally {
          state.updating = false;
        }
      }, 150);
    } catch (err) {
      state.updating = false;
      logError(err);
      return json(res, 500, { error: err.message });
    }
    return;
  }

  if (pathname.startsWith('/api/')) {
    // Bloquea escrituras desde otras páginas web (solo se acepta JSON del propio NexoCaja)
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json') && req.method !== 'DELETE') {
      return json(res, 415, { error: 'Se esperaba JSON' });
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) {
      return json(res, 403, { error: 'Origen no permitido' });
    }
    if (state.updating && req.method !== 'GET') return json(res, 503, { error: 'NexoCaja se está actualizando. Intenta en unos segundos.' });
    try {
      const db = dbMod.getDb();
      const ctx = { db, json, readJson, state, isLocal: isLocal(req), ip: req.socket.remoteAddress, registerId: cfg.caja };
      if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/users')) {
        ctx.user = pathname.startsWith('/api/users') ? auth.currentUser(db, req) : null;
        const done = await auth.handleAuth(req, res, pathname, ctx);
        if (done !== false) return;
        return json(res, 404, { error: 'No encontrado' });
      }
      ctx.user = auth.currentUser(db, req);
      if ((await fiscal.handleFiscal(req, res, pathname, searchParams, ctx)) !== false) return;
      if ((await returns.handleReturns(req, res, pathname, searchParams, ctx)) !== false) return;
      if ((await ecfRutas.handleEcf(req, res, pathname, searchParams, ctx)) !== false) return;
      if ((await reports.handleReports(req, res, pathname, searchParams, ctx)) !== false) return;
      const handled = await api.handleApi(req, res, pathname, searchParams, ctx);
      if (handled) return;
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.message });
      throw err;
    }
    return json(res, 404, { error: 'No encontrado' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido');
  return serveStatic(req, res, pathname);
}

// ── Abrir el navegador solo la primera vez (no en cada reinicio de --watch) ──
function openBrowserOnce() {
  if (!process.argv.includes('--open')) return;
  const flag = path.join(os.tmpdir(), `nexocaja-abierto-${process.ppid}`);
  if (fs.existsSync(flag)) return;
  try { fs.writeFileSync(flag, String(Date.now())); } catch { /* noop */ }
  const cmd = process.platform === 'win32' ? `start "" "${URL_LOCAL}"` : process.platform === 'darwin' ? `open "${URL_LOCAL}"` : `xdg-open "${URL_LOCAL}"`;
  exec(cmd, () => {});
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    logError(err);
    if (!res.headersSent) json(res, 500, { error: 'Error interno' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  NexoCaja ya está abierto en ${URL_LOCAL}\n`);
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'win32' ? `start "" "${URL_LOCAL}"` : `xdg-open "${URL_LOCAL}"`;
      exec(cmd, () => process.exit(0));
    } else {
      process.exit(0);
    }
    return;
  }
  logError(err);
  throw err;
});

server.listen(PORT, cfg.host, () => {
  console.log(`\n  NexoCaja v${VERSION} © 2026 · Creado por Erick Nex · NexTech360`);
  console.log(`  ${URL_LOCAL}`);
  if (cfg.host === '0.0.0.0') {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    if (ips.length) console.log(`  En la red local: ${ips.map((ip) => `http://${ip}:${PORT}`).join('  ')}`);
  }
  console.log(`  Datos: ${cfg.dirDatos}`);
  console.log('  No cierres esta ventana mientras uses NexoCaja.\n');
  openBrowserOnce();
});

function shutdown() {
  server.close(() => { dbMod.closeDb(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
