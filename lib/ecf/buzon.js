// NexoCaja · Conexión con el Buzón e-CF (Vercel): alta del negocio, bajada de lo recibido.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeCertFile, dataPath, relData, sealText, openText } from './emision.js';
import { onlyDigits } from '../rd.js';

const DEFAULT_URL = 'https://nexocaja-buzon.vercel.app';
const id = (p) => `${p}-${crypto.randomUUID()}`;
export const buzonState = { lastSyncAt: null, lastError: null, running: false };

export function getBuzon(db) {
  let b = {};
  try { b = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'buzon'").get() || {}).value || '{}'); } catch { b = {}; }
  return b;
}
function setBuzon(db, b) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('buzon', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(b));
}
export const buzonUrl = (db) => (getBuzon(db).url || process.env.NX_BUZON_URL || DEFAULT_URL).replace(/\/+$/, '');
export function buzonPublic(db) {
  const b = getBuzon(db);
  return { activo: !!b.apiKeyEnc, url: buzonUrl(db), urls: b.urls || null, rnc: b.rnc || null, activadoAt: b.activadoAt || null, certVence: b.certVence || null,
    lastSyncAt: buzonState.lastSyncAt, lastError: buzonState.lastError };
}

async function call(db, method, p, { body, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(buzonUrl(db) + p, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch { throw Object.assign(new Error('No se pudo conectar con el Buzón (revisa el internet)'), { status: 502 }); }
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = null; }
  if (!r.ok) throw Object.assign(new Error((d && (d.error || d.mensaje)) || `El Buzón respondió ${r.status}`), { status: r.status === 403 ? 403 : 502 });
  return d;
}

/** Activa el buzón: sube una copia del certificado (cifrada en el servidor) y guarda la clave del negocio. */
export async function activate(db, code) {
  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() || {};
  const rnc = onlyDigits(c.rnc);
  if (!rnc) throw Object.assign(new Error('Registra primero el RNC del negocio'), { status: 409 });
  const cert = activeCertFile(db);
  if (!cert) throw Object.assign(new Error('Sube primero el certificado digital'), { status: 409 });
  const prev = getBuzon(db);
  const headers = prev.apiKeyEnc && prev.rnc === rnc ? { 'x-api-key': openText(prev.apiKeyEnc) } : {};
  const r = await call(db, 'POST', '/api/enroll', { body: { rnc, code: String(code || '').trim(), razonSocial: c.legal_name, p12: cert.file.toString('base64'), password: cert.password }, headers });
  setBuzon(db, { ...prev, rnc, apiKeyEnc: sealText(r.apiKey), urls: r.urls, certVence: r.certVence, activadoAt: new Date().toISOString() });
  return buzonPublic(db);
}
export async function deactivate(db) {
  const b = getBuzon(db);
  if (b.apiKeyEnc) {
    try { await call(db, 'DELETE', `/api/enroll?rnc=${b.rnc}`, { headers: { 'x-api-key': openText(b.apiKeyEnc) } }); } catch (e) { if (e.status !== 403) throw e; }
  }
  setBuzon(db, { url: b.url });
  return buzonPublic(db);
}

const tag = (xml, t) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml); return m ? m[1].trim() : ''; };
const cents = (v) => (v ? Math.round(parseFloat(v) * 100) : 0);
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Baja lo recibido en el buzón, lo guarda y confirma. Devuelve cuántos documentos entraron. */
export async function syncBuzon(db) {
  const b = getBuzon(db);
  if (!b.apiKeyEnc || buzonState.running) return { recibidos: 0, aprobaciones: 0 };
  buzonState.running = true;
  const out = { recibidos: 0, aprobaciones: 0 };
  try {
    const headers = { 'x-rnc': b.rnc, 'x-api-key': openText(b.apiKeyEnc) };
    for (let round = 0; round < 8; round++) {
      const r = await call(db, 'GET', '/api/sync', { headers });
      if (!r.items.length) break;
      const ack = [];
      for (const it of r.items) {
        if (it.tipo === 'ecf') {
          const rncE = onlyDigits(it.rncEmisor || tag(it.xml, 'RNCEmisor'));
          const encf = it.encf || tag(it.xml, 'eNCF');
          const dir = dataPath(path.join('ecf', 'recibidos', it.recibido.slice(0, 4), it.recibido.slice(5, 7)));
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `${rncE}${encf}.xml`);
          fs.writeFileSync(f, it.xml);
          let fa = null;
          if (it.arecf) { fa = f.replace(/\.xml$/, '.acuse.xml'); fs.writeFileSync(fa, it.arecf); }
          db.prepare(`INSERT OR IGNORE INTO ecf_recibidos (id, rnc_emisor, razon_social, encf, tipo, fecha_emision, monto_total, itbis_total, xml_path, arecf_path,
                      acuse_estado, recibido_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recibido', ?, ?)`)
            .run(id('rec'), rncE, unesc(tag(it.xml, 'RazonSocialEmisor')), encf, tag(it.xml, 'TipoeCF'), tag(it.xml, 'FechaEmision'),
              cents(tag(it.xml, 'MontoTotal')), cents(tag(it.xml, 'TotalITBIS')), relData(f), fa ? relData(fa) : null, it.recibido, new Date().toISOString());
          out.recibidos++;
        } else if (it.tipo === 'acecf') {
          const estado = tag(it.xml, 'Estado');
          const det = { estado, motivo: unesc(tag(it.xml, 'DetalleMotivoRechazo')), fecha: tag(it.xml, 'FechaHoraAprobacionComercial'), recibido: it.recibido };
          db.prepare('UPDATE ecf_documents SET aprobacion_comercial = ?, aprobacion_detalle = ? WHERE encf = ?')
            .run(estado === '1' ? 'aprobado' : estado === '2' ? 'rechazado' : `estado ${estado}`, JSON.stringify(det), it.encf);
          out.aprobaciones++;
        }
        ack.push(it.id);
      }
      await call(db, 'POST', '/api/sync', { headers, body: { ack } });
    }
    buzonState.lastError = null;
    return out;
  } catch (e) {
    buzonState.lastError = e.message;
    throw e;
  } finally {
    buzonState.running = false;
    buzonState.lastSyncAt = new Date().toISOString();
  }
}

export function listRecibidos(db, limit = 200) {
  return db.prepare('SELECT * FROM ecf_recibidos ORDER BY recibido_at DESC LIMIT ?').all(limit).map((r) => ({
    id: r.id, rncEmisor: r.rnc_emisor, razonSocial: r.razon_social, encf: r.encf, tipo: r.tipo, fechaEmision: r.fecha_emision,
    total: r.monto_total, itbis: r.itbis_total, acuse: r.acuse_estado, aprobacion: r.aprobacion, recibidoAt: r.recibido_at
  }));
}
export function recibidoPath(db, rid, acuse = false) {
  const r = db.prepare('SELECT xml_path, arecf_path FROM ecf_recibidos WHERE id = ?').get(rid);
  const p = r && (acuse ? r.arecf_path : r.xml_path);
  return p ? dataPath(p) : null;
}

let timer = null;
export function startBuzonSync(db, everyMs = 120000) {
  timer = setInterval(() => { if (getBuzon(db).apiKeyEnc) syncBuzon(db).catch(() => {}); }, everyMs);
  timer.unref?.();
  setTimeout(() => { if (getBuzon(db).apiKeyEnc) syncBuzon(db).catch(() => {}); }, 5000).unref?.();
}
