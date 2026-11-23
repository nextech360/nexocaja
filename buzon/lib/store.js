// Buzón NexoCaja · Almacenamiento cifrado (AES-256-GCM con NX_MASTER_KEY) sobre Vercel Blob privado.
// Con NX_BUZON_LOCAL_DIR usa una carpeta local (pruebas).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function key() {
  const k = process.env.NX_MASTER_KEY;
  if (!k || k.length < 32) throw new Error('Falta NX_MASTER_KEY');
  return crypto.createHash('sha256').update(k).digest();
}
export function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
export function open(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

const LOCAL = process.env.NX_BUZON_LOCAL_DIR;
let blob = null;
async function sdk() { if (!blob) blob = await import('@vercel/blob'); return blob; }

export async function putJson(p, obj) {
  const data = seal(Buffer.from(JSON.stringify(obj)));
  if (LOCAL) { const f = path.join(LOCAL, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return; }
  const { put } = await sdk();
  await put(p, data, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/octet-stream' });
}
export async function getJson(p) {
  let buf;
  if (LOCAL) { const f = path.join(LOCAL, p); if (!fs.existsSync(f)) return null; buf = fs.readFileSync(f); }
  else {
    const { get } = await sdk();
    let r;
    try { r = await get(p, { access: 'private', useCache: false }); } catch (e) { if (/not.?found/i.test(String(e && (e.name || e.message)))) return null; throw e; }
    if (!r) return null;
    buf = Buffer.from(await new Response(r.stream).arrayBuffer());
  }
  return JSON.parse(open(buf).toString('utf8'));
}
export async function listPaths(prefix, limit = 50) {
  if (LOCAL) {
    const dir = path.join(LOCAL, prefix);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(path.relative(LOCAL, f).split(path.sep).join('/')); } };
    walk(dir);
    return out.sort().slice(0, limit);
  }
  const { list } = await sdk();
  const r = await list({ prefix, limit });
  return r.blobs.map((b) => b.pathname).sort();
}
export async function exists(p) {
  if (LOCAL) return fs.existsSync(path.join(LOCAL, p));
  return (await listPaths(p, 1)).includes(p);
}
export async function remove(paths) {
  if (!paths.length) return;
  if (LOCAL) { for (const p of paths) fs.rmSync(path.join(LOCAL, p), { force: true }); return; }
  const { del } = await sdk();
  await del(paths);
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function sameSecret(a, bHash) {
  const x = Buffer.from(sha256(a), 'hex'), y = Buffer.from(String(bHash || ''), 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const onlyRnc = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 9 || d.length === 11 ? d : null; };
export const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Fecha y hora de República Dominicana: dd-MM-AAAA HH:mm:ss */
export function drStamp(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
}

export async function tenant(rnc) { return rnc ? getJson(`tenants/${rnc}.json`) : null; }
