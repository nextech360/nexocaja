// Actualizador de NexoCaja (mismo modelo que ClipSphere).
// Lee manifest.json de GitHub (rama main), baja SOLO los archivos que cambiaron,
// verifica su SHA-256 y los copia. config.json y la carpeta datos/ nunca se tocan.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';

export const REPO = process.env.APP_REPO || 'nextech360/nexocaja';
export const BRANCH = process.env.APP_BRANCH || 'main';
// APP_RAW solo se usa para pruebas locales (servidor que imita a GitHub)
const RAW = process.env.APP_RAW || `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

const PROTECTED = new Set(['config.json', 'config.json.bak', 'manifest.json', '.env', '.env.local']);
const PROTECTED_DIRS = ['datos/', 'respaldos/', 'certs/', '_update_tmp/', 'node_modules/', '.git/'];
const TMP = path.join(ROOT, '_update_tmp');
const MANIFEST = path.join(ROOT, 'manifest.json');

export function localManifest() {
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return { version: m.version || '0.0.0', files: Array.isArray(m.files) ? m.files : [], notes: m.notes || [] };
  } catch {
    return { version: '0.0.0', files: [], notes: [] };
  }
}

export function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Resuelve una ruta del manifest dentro de la app. Lanza error si intenta salirse o tocar algo protegido. */
export function safePath(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Ruta inválida en el manifest');
  const norm = rel.replace(/\\/g, '/');
  if (norm.split('/').includes('..') || norm.startsWith('/') || /^[a-z]:/i.test(norm)) {
    throw new Error(`Ruta no permitida: ${rel}`);
  }
  if (PROTECTED.has(norm) || PROTECTED_DIRS.some((d) => norm === d.slice(0, -1) || norm.startsWith(d))) {
    throw new Error(`Archivo protegido: ${rel}`);
  }
  const abs = path.resolve(ROOT, norm);
  if (!abs.startsWith(ROOT + path.sep)) throw new Error(`Ruta fuera de la app: ${rel}`);
  return abs;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(abs) {
  try { return sha256(fs.readFileSync(abs)); } catch { return null; }
}

export async function fetchRemote() {
  const res = await fetch(`${RAW}/manifest.json?t=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
  const m = await res.json();
  if (!m || typeof m.version !== 'string' || !Array.isArray(m.files)) throw new Error('manifest remoto inválido');
  return m;
}

export async function check() {
  const local = localManifest();
  const remote = await fetchRemote();
  return {
    current: local.version,
    latest: remote.version,
    available: cmpVer(remote.version, local.version) > 0,
    notes: Array.isArray(remote.notes) ? remote.notes : [],
    date: remote.date || null
  };
}

/** Paso 1: baja y verifica todo en _update_tmp/ (la app sigue funcionando normal). */
export async function prepare(log = () => {}) {
  const local = localManifest();
  const remote = await fetchRemote();
  if (cmpVer(remote.version, local.version) <= 0) throw new Error(`Ya tienes la última versión (v${local.version})`);

  // Validar TODO el manifest antes de bajar nada
  for (const f of remote.files) {
    safePath(f.path);
    if (!/^[a-f0-9]{64}$/.test(f.sha256 || '')) throw new Error(`SHA-256 inválido para ${f.path}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  try {
    return await download(local, remote, log);
  } catch (err) {
    fs.rmSync(TMP, { recursive: true, force: true });
    throw err;
  }
}

async function download(local, remote, log) {
  const changed = [];
  for (const f of remote.files) {
    const dest = safePath(f.path);
    if (sha256File(dest) === f.sha256) continue;

    log(`  bajando ${f.path}`);
    const url = `${RAW}/${f.path.split('/').map(encodeURIComponent).join('/')}?v=${encodeURIComponent(remote.version)}`;
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`No se pudo bajar ${f.path} (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== f.sha256) throw new Error(`${f.path} llegó dañado, intenta otra vez`);

    const tmpFile = path.join(TMP, f.path);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, buf);
    changed.push(f.path);
  }

  // Archivos que existían en la versión anterior y ya no están en la nueva
  const remotePaths = new Set(remote.files.map((f) => f.path));
  const removed = local.files.map((f) => f.path).filter((p) => !remotePaths.has(p)).filter((p) => {
    try { safePath(p); return true; } catch { return false; }
  });

  return { remote, changed, removed };
}

/** Paso 2: copia de una sola pasada. lib/ y server.js al final para que --watch reinicie con todo listo. */
export function commit(plan) {
  const rank = (p) => (p === 'server.js' ? 2 : p.startsWith('lib/') ? 1 : 0);
  const ordered = [...plan.changed].sort((a, b) => rank(a) - rank(b));
  for (const rel of ordered) {
    const dest = safePath(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(TMP, rel), dest);
  }
  for (const rel of plan.removed) {
    try { fs.rmSync(safePath(rel), { force: true }); } catch { /* noop */ }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  // El manifest va al último: si algo se corta antes, la próxima revisión reaplica.
  fs.writeFileSync(MANIFEST, JSON.stringify(plan.remote, null, 2) + '\n', 'utf8');
  return { version: plan.remote.version, changed: ordered.length, removed: plan.removed.length };
}

export async function apply(log = () => {}) {
  return commit(await prepare(log));
}
