// NexoCaja · Cliente de los servicios web de la DGII (e-CF).
// Rutas según «Descripción Técnica Servicios DGII». Bases configurables (settings.ecf_urls
// o variables NX_DGII_ECF / NX_DGII_FC) para pruebas con un simulador.
import { signXml, canonicalRoot } from './firma.js';
import { esc } from './xml.js';

const SEG = { TesteCF: 'testecf', CerteCF: 'certecf', eCF: 'ecf' };
const TIMEOUT_MS = 15000;
const tokens = new Map(); // ambiente → { token, until }

export const net = { lastOkAt: 0, lastFailAt: 0, lastError: '' };
/** Sin conexión con la DGII: el último intento falló por red y no ha habido éxito después. */
export const offline = () => net.lastFailAt > net.lastOkAt;

export class DgiiError extends Error {
  constructor(message, { status = 0, network = false, body = null } = {}) { super(message); this.status = status; this.network = network; this.body = body; }
}

function bases(db) {
  let o = {};
  try { o = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'ecf_urls'").get() || {}).value || '{}'); } catch { o = {}; }
  return {
    ecf: (o.ecf || process.env.NX_DGII_ECF || 'https://ecf.dgii.gov.do').replace(/\/+$/, ''),
    fc: (o.fc || process.env.NX_DGII_FC || 'https://fc.dgii.gov.do').replace(/\/+$/, '')
  };
}
export function urls(db, amb) {
  const b = bases(db), s = SEG[amb];
  return {
    semilla: `${b.ecf}/${s}/autenticacion/api/autenticacion/semilla`,
    validar: `${b.ecf}/${s}/autenticacion/api/autenticacion/validarsemilla`,
    recepcion: `${b.ecf}/${s}/recepcion/api/facturaselectronicas`,
    rfce: `${b.fc}/${s}/recepcionfc/api/recepcion/ecf`,
    estado: (trackId) => `${b.ecf}/${s}/consultaresultado/api/consultas/estado?trackid=${encodeURIComponent(trackId)}`
  };
}

function log(db, entry) {
  try {
    db.prepare(`INSERT INTO ecf_log (document_id, ambiente, servicio, http_status, duracion_ms, request_resumen, response_raw, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(entry.docId || null, entry.amb, entry.servicio, entry.status ?? null, entry.ms ?? null, entry.req || null,
        entry.res == null ? null : String(entry.res).slice(0, 8000), new Date().toISOString());
  } catch { /* la bitácora nunca debe tumbar un envío */ }
}

async function request(db, { amb, servicio, docId, url, method = 'GET', token, xml, fileName }) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let body;
  if (xml != null) {
    body = new FormData();
    body.append('xml', new Blob([xml], { type: 'text/xml' }), fileName || 'documento.xml');
  }
  const t0 = Date.now();
  let res, text;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    net.lastFailAt = Date.now(); net.lastError = err.name === 'TimeoutError' ? 'La DGII no respondió a tiempo' : 'Sin conexión con la DGII';
    log(db, { amb, servicio, docId, ms: Date.now() - t0, req: `${method} ${url.replace(/\?.*/, '')}${fileName ? ' ' + fileName : ''}`, res: `ERROR RED: ${err.message}` });
    throw new DgiiError(net.lastError, { network: true });
  }
  log(db, { amb, servicio, docId, status: res.status, ms: Date.now() - t0, req: `${method} ${url.replace(/\?.*/, '')}${fileName ? ' ' + fileName : ''}`, res: text });
  if (res.status >= 500 || res.status === 429) {
    net.lastFailAt = Date.now(); net.lastError = `La DGII respondió con error ${res.status}`;
    throw new DgiiError(net.lastError, { status: res.status, network: true, body: text });
  }
  net.lastOkAt = Date.now();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text };
}

/** Token de sesión: semilla → firmada con el certificado → validarsemilla. Se guarda en memoria. */
export async function getToken(db, amb, sign, { force = false } = {}) {
  const c = tokens.get(amb);
  if (!force && c && c.until > Date.now()) return c.token;
  const u = urls(db, amb);
  const r1 = await request(db, { amb, servicio: 'semilla', url: u.semilla });
  if (r1.status !== 200) throw new DgiiError(`La DGII no entregó la semilla (HTTP ${r1.status})`, { status: r1.status, body: r1.text });
  const valor = /<valor>([\s\S]*?)<\/valor>/.exec(r1.text), fecha = /<fecha>([\s\S]*?)<\/fecha>/.exec(r1.text);
  if (!valor) throw new DgiiError('La semilla de la DGII vino en un formato inesperado', { body: r1.text });
  const attrs = {};
  const rootTag = /<SemillaModel([^>]*)>/.exec(r1.text);
  if (rootTag) for (const m of rootTag[1].matchAll(/\s(xmlns:[\w.-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const root = canonicalRoot('SemillaModel', attrs);
  const xml = root.open + `<valor>${esc(unesc(valor[1]))}</valor>` + (fecha ? `<fecha>${esc(unesc(fecha[1]))}</fecha>` : '') + root.close;
  const signed = sign(xml);
  const r2 = await request(db, { amb, servicio: 'token', url: u.validar, method: 'POST', xml: signed, fileName: 'semilla.xml' });
  if (r2.status !== 200 || !r2.data || !r2.data.token) {
    throw new DgiiError(`La DGII rechazó la autenticación${r2.data && (r2.data.mensaje || r2.data.message) ? ': ' + (r2.data.mensaje || r2.data.message) : ` (HTTP ${r2.status})`}. Revisa que el certificado sea el del representante registrado en la DGII.`, { status: r2.status, body: r2.text });
  }
  const exp = Date.parse(r2.data.expira || '') || Date.now() + 60 * 60 * 1000;
  tokens.set(amb, { token: r2.data.token, until: Math.min(exp, Date.now() + 60 * 60 * 1000) - 5 * 60 * 1000 });
  return r2.data.token;
}
export const dropToken = (amb) => tokens.delete(amb);

/** Envía un e-CF completo. Devuelve { trackId } o lanza DgiiError. */
export async function sendEcf(db, amb, token, docId, xml, fileName) {
  const r = await request(db, { amb, servicio: 'recepcion', docId, url: urls(db, amb).recepcion, method: 'POST', token, xml, fileName });
  return r;
}
/** Envía un RFCE. La respuesta trae el resultado de una vez. */
export async function sendRfce(db, amb, token, docId, xml, fileName) {
  return request(db, { amb, servicio: 'rfce', docId, url: urls(db, amb).rfce, method: 'POST', token, xml, fileName });
}
export async function consultaEstado(db, amb, token, docId, trackId) {
  return request(db, { amb, servicio: 'consulta', docId, url: urls(db, amb).estado(trackId), token });
}

/** Normaliza el estado que devuelve la DGII (texto o código). */
export function mapEstado(data) {
  const t = String((data && data.estado) || '').toLowerCase();
  if (t.includes('condicional')) return 'aceptado_condicional';
  if (t.includes('rechaz')) return 'rechazado';
  if (t.includes('aceptado')) return 'aceptado';
  if (t.includes('proceso')) return 'en_proceso';
  const c = Number(data && data.codigo);
  return { 1: 'aceptado', 2: 'rechazado', 3: 'en_proceso', 4: 'aceptado_condicional', 0: 'no_encontrado' }[c] || 'desconocido';
}
export function mensajes(data) {
  if (!data) return [];
  const list = Array.isArray(data.mensajes) ? data.mensajes : [];
  const out = list.map((m) => ({ codigo: m.codigo ?? '', valor: m.valor ?? m.mensaje ?? '' })).filter((m) => m.valor || m.codigo);
  if (data.mensaje) out.push({ codigo: '', valor: String(data.mensaje) });
  if (data.error && data.error !== data.mensaje) out.push({ codigo: '', valor: String(data.error) });
  return out;
}
