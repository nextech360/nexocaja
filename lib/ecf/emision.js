// NexoCaja · Emisión de e-CF: certificado, firma, archivo inmutable y datos para la RI/QR.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readP12, certInfo, P12Error } from './p12.js';
import { buildEcf } from './xml.js';
import { signXml } from './firma.js';
import { offline } from './dgii.js';
import { AMBIENTES, ECF_TYPES } from './catalogo.js';
import { CONSUMO_ID_THRESHOLD, onlyDigits } from '../rd.js';

let CFG = null;
const signers = new Map();          // certId → { key, certDer }
const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

export function initEcf(cfg) { CFG = cfg; }
const certDir = () => path.join(CFG.dirDatos, 'certs');
const ecfDir = () => path.join(CFG.dirDatos, 'ecf');

// ── Cifrado en reposo (AES-256-GCM con la clave local de config.json) ──
function aesKey() {
  if (!CFG || !CFG.claves || !CFG.claves.cifradoCertificado) throw new Error('Falta la clave de cifrado en config.json');
  return crypto.createHash('sha256').update(String(CFG.claves.cifradoCertificado)).digest();
}
function seal(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);
}
function open(buf) {
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}

// ── Hora de República Dominicana (GMT-4) ──────────────────────────
function drParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date).map((x) => [x.type, x.value]));
  if (p.hour === '24') p.hour = '00';
  return p;
}
export const drDateIso = (date) => { const p = drParts(date); return `${p.year}-${p.month}-${p.day}`; };
export const drStamp = (date) => { const p = drParts(date); return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`; };

// ── Ambiente ──────────────────────────────────────────────────────
export function getAmbiente(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'ecf_ambiente'").get();
  return r && AMBIENTES[r.value] ? r.value : 'TesteCF';
}
export function setAmbiente(db, amb) {
  if (!AMBIENTES[amb]) throw Object.assign(new Error('Ambiente inválido'), { status: 400 });
  db.prepare("INSERT INTO settings (key, value) VALUES ('ecf_ambiente', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(amb);
}

// ── Certificado ───────────────────────────────────────────────────
function certRow(r) {
  if (!r) return null;
  const days = Math.floor((new Date(r.not_after) - Date.now()) / 86400000);
  return { id: r.id, subject: r.subject, issuer: r.issuer, serial: r.serial, docTitular: r.doc_titular, notBefore: r.not_before, notAfter: r.not_after,
    daysLeft: days, expired: days < 0 || new Date(r.not_before) > new Date(), createdAt: r.created_at };
}
export function activeCert(db) {
  return certRow(db.prepare('SELECT * FROM ecf_certificates WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get());
}
export function certProblem(db) {
  const c = activeCert(db);
  if (!c) return 'Falta el certificado digital (.p12) para firmar los e-CF. Súbelo en Configuración fiscal.';
  if (c.expired) return `El certificado digital venció el ${c.notAfter.slice(0, 10)}. Sube el certificado renovado en Configuración fiscal.`;
  return null;
}

export function saveCertificate(db, fileBuf, password, userId) {
  if (!fileBuf || !fileBuf.length) throw Object.assign(new Error('Elige el archivo .p12 o .pfx'), { status: 400 });
  if (fileBuf.length > 64 * 1024) throw Object.assign(new Error('Ese archivo es demasiado grande para ser un certificado'), { status: 400 });
  let p;
  try { p = readP12(fileBuf, String(password || '')); } catch (e) {
    if (e instanceof P12Error) throw Object.assign(new Error(e.message), { status: 400 });
    throw e;
  }
  const info = certInfo(p.cert);
  if (new Date(info.notAfter) < new Date()) throw Object.assign(new Error(`Ese certificado ya venció (${info.notAfter.slice(0, 10)})`), { status: 400 });
  fs.mkdirSync(certDir(), { recursive: true });
  const cid = id('cert');
  const fileName = `${cid}.p12.enc`;
  fs.writeFileSync(path.join(certDir(), fileName), seal(Buffer.from(fileBuf)));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE ecf_certificates SET active = 0 WHERE active = 1').run();
    db.prepare(`INSERT INTO ecf_certificates (id, file_name, password_enc, subject, issuer, serial, doc_titular, not_before, not_after, uploaded_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cid, fileName, seal(Buffer.from(String(password || ''), 'utf8')).toString('base64'), info.name || info.subject, info.issuer, info.serial,
        info.docTitular, info.notBefore, info.notAfter, userId, now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  signers.clear();
  return activeCert(db);
}
export function removeCertificate(db) {
  db.prepare('UPDATE ecf_certificates SET active = 0 WHERE active = 1').run();
  signers.clear();
}

export function signer(db) {
  const r = db.prepare('SELECT * FROM ecf_certificates WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get();
  if (!r) throw Object.assign(new Error(certProblem(db)), { status: 409 });
  if (signers.has(r.id)) return signers.get(r.id);
  const file = open(fs.readFileSync(path.join(certDir(), r.file_name)));
  const pw = open(Buffer.from(r.password_enc, 'base64')).toString('utf8');
  const p = readP12(file, pw);
  const s = { key: p.key, certDer: p.certDer };
  signers.set(r.id, s);
  return s;
}

// ── Emisión ───────────────────────────────────────────────────────
function company(db) {
  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() || {};
  return { rnc: onlyDigits(c.rnc), razonSocial: c.legal_name, nombreComercial: c.trade_name !== c.legal_name ? c.trade_name : '', sucursal: c.branch,
    direccion: c.address, telefono: c.phone, correo: c.email };
}

/**
 * Arma, firma y guarda un e-CF. Se llama DENTRO de la transacción de la venta o nota:
 * si algo falla, no se consume el e-NCF ni se registra la operación.
 */
export function issueEcf(db, d) {
  const problem = certProblem(db);
  if (problem) throw Object.assign(new Error(problem), { status: 409 });
  const em = company(db);
  if (!em.rnc) throw Object.assign(new Error('Falta el RNC del emisor'), { status: 409 });
  if (!em.direccion) throw Object.assign(new Error('Falta la dirección del negocio en Configuración fiscal (es obligatoria en el e-CF)'), { status: 409 });
  const amb = getAmbiente(db);
  const fecha = new Date();
  const fechaEmision = drDateIso(fecha), fechaHoraFirma = drStamp(fecha);
  const { xml, totales } = buildEcf({ ...d, emisor: em, fechaEmision, fechaHoraFirma });
  const s = signer(db);
  const signed = signXml(xml, s.key, s.certDer);
  const dir = path.join(ecfDir(), amb, fechaEmision.slice(0, 4), fechaEmision.slice(5, 7));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${em.rnc}${d.encf}.xml`);
  fs.writeFileSync(file, signed.xml, { flag: 'wx' });
  const ruta = d.tipo === '32' && totales.total < CONSUMO_ID_THRESHOLD ? 'RFCE' : 'ECF';
  const did = id('ecf');
  const conting = offline();
  db.prepare(`INSERT INTO ecf_documents (id, ambiente, tipo, encf, origen, origen_id, ruta, rnc_comprador, monto_total, itbis_total, fecha_emision, fecha_firma,
              codigo_seguridad, vence_secuencia, xml_path, xml_sha256, estado, ref_encf, ref_fecha, ref_codigo, contingencia, limite_envio, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'firmado', ?, ?, ?, ?, ?, ?)`)
    .run(did, amb, d.tipo, d.encf, d.origen, d.origenId, ruta, d.comprador && d.comprador.rnc ? d.comprador.rnc : null, totales.total, totales.itbis,
      fechaEmision.split('-').reverse().join('-'), fechaHoraFirma, signed.codigoSeguridad, d.venceSecuencia || null,
      path.relative(CFG.dirDatos, file), crypto.createHash('sha256').update(signed.xml).digest('hex'),
      d.referencia ? d.referencia.ncf : null, d.referencia ? d.referencia.fecha : null, d.referencia ? String(d.referencia.codigo) : null,
      conting ? 1 : 0, conting ? new Date(Date.now() + 72 * 3600 * 1000).toISOString() : null, now());
  if (onIssued) setImmediate(onIssued);
  return { id: did, codigoSeguridad: signed.codigoSeguridad, fechaHoraFirma, ruta, contingencia: conting };
}

/** Firma un XML cualquiera con el certificado activo (semilla de autenticación, RFCE…). */
export function signWithActive(db) {
  return (xml) => { const s = signer(db); return signXml(xml, s.key, s.certDer).xml; };
}
export function signDetailed(db, xml) { const s = signer(db); return signXml(xml, s.key, s.certDer); }
export const dataPath = (rel) => path.join(CFG.dirDatos, rel);
export const relData = (abs) => path.relative(CFG.dirDatos, abs);

let onIssued = null;
export function onEcfIssued(fn) { onIssued = fn; }

/** URL del QR (timbre) según el tipo y el monto. */
export function qrUrl(rncEmisor, doc) {
  const seg = (AMBIENTES[doc.ambiente] || AMBIENTES.eCF).qr;
  const q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const monto = (doc.monto_total / 100).toFixed(2);
  if (doc.ruta === 'RFCE') return `https://fc.dgii.gov.do/${seg}/ConsultaTimbreFC?` + q({ RncEmisor: rncEmisor, ENCF: doc.encf, MontoTotal: monto, CodigoSeguridad: doc.codigo_seguridad });
  return `https://ecf.dgii.gov.do/${seg}/ConsultaTimbre?` + q({ RncEmisor: rncEmisor, RncComprador: doc.rnc_comprador, ENCF: doc.encf, FechaEmision: doc.fecha_emision,
    MontoTotal: monto, FechaFirma: doc.fecha_firma, CodigoSeguridad: doc.codigo_seguridad });
}

export const ESTADOS = { generado: 'Generado', firmado: 'Firmado · por enviar', en_cola: 'Pendiente de envío', enviado: 'Enviado', en_proceso: 'En proceso (DGII)',
  aceptado: 'Aceptado', aceptado_condicional: 'Aceptado condicional', rechazado: 'Rechazado', error_local: 'Error' };

/** Datos del e-CF para la representación impresa y la pantalla. */
export function ecfInfo(db, encf) {
  if (!encf || encf[0] !== 'E') return null;
  const d = db.prepare('SELECT * FROM ecf_documents WHERE encf = ?').get(encf);
  if (!d) return null;
  const rnc = onlyDigits((db.prepare('SELECT rnc FROM company WHERE id = 1').get() || {}).rnc);
  return {
    tipo: d.tipo, tipoNombre: (ECF_TYPES[d.tipo] || {}).name, encf: d.encf, ambiente: d.ambiente, ambienteNombre: AMBIENTES[d.ambiente].name,
    estado: d.estado, estadoNombre: ESTADOS[d.estado] || d.estado, ruta: d.ruta,
    fechaEmision: d.fecha_emision, fechaFirma: d.fecha_firma, codigoSeguridad: d.codigo_seguridad,
    venceSecuencia: ECF_TYPES[d.tipo].venceSecuencia && d.vence_secuencia ? d.vence_secuencia : null,
    contingencia: !!d.contingencia, limiteEnvio: d.limite_envio, referencia: d.ref_encf, trackId: d.track_id,
    mensajes: d.dgii_mensajes ? JSON.parse(d.dgii_mensajes) : [], reemplazadoPor: d.reemplazado_por, qrUrl: qrUrl(rnc, d)
  };
}

export function ecfXmlPath(db, encf) {
  const d = db.prepare('SELECT xml_path FROM ecf_documents WHERE encf = ?').get(encf);
  return d && d.xml_path ? path.join(CFG.dirDatos, d.xml_path) : null;
}

export function docRow(d) {
  return {
    encf: d.encf, tipo: d.tipo, origen: d.origen, origenId: d.origen_id, ruta: d.ruta, total: d.monto_total, itbis: d.itbis_total, ambiente: d.ambiente,
    estado: d.estado, estadoNombre: ESTADOS[d.estado] || d.estado, codigoSeguridad: d.codigo_seguridad, fechaFirma: d.fecha_firma, comprador: d.rnc_comprador,
    trackId: d.track_id, intentos: d.intentos, proximoIntento: d.proximo_intento, contingencia: !!d.contingencia, limiteEnvio: d.limite_envio,
    enviadoAt: d.enviado_at, resueltoAt: d.resuelto_at, mensajes: d.dgii_mensajes ? JSON.parse(d.dgii_mensajes) : [], reemplazadoPor: d.reemplazado_por,
    referencia: d.ref_encf, createdAt: d.created_at
  };
}
export function listDocs(db, limit = 100, estado = '') {
  const rows = estado
    ? db.prepare('SELECT * FROM ecf_documents WHERE estado = ? ORDER BY created_at DESC LIMIT ?').all(estado, limit)
    : db.prepare('SELECT * FROM ecf_documents ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(docRow);
}
