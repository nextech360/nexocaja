// NexoCaja · Módulo fiscal: emisor, secuencias NCF y clientes.
import crypto from 'node:crypto';
import { can, audit, HttpError } from './auth.js';
import { NCF_TYPES, CONSUMO_ID_THRESHOLD, parseDoc, formatDoc, formatNcf, MAX_SEQ, onlyDigits } from './rd.js';
import { ECF_TYPES, ECF_SALE_ORDER, AMBIENTES } from './ecf/catalogo.js';
import { getAmbiente, setAmbiente, activeCert, certProblem, saveCertificate, removeCertificate, ecfXmlPath, listDocs } from './ecf/emision.js';
import fs from 'node:fs';
import { queueSummary } from './ecf/cola.js';

const typeInfo = (kind, code) => (kind === 'ECF' ? ECF_TYPES : NCF_TYPES)[code];

const ALERT_DAYS = 30;
const id = (p) => `${p}-${crypto.randomUUID()}`;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysUntil = (d) => Math.floor((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);

function txt(v, field, max = 120, required = false) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `Falta ${field}`);
  if (s.length > max) throw new HttpError(400, `${field} es muy largo`);
  return s;
}

export function fiscalMode(db) {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'fiscal_mode'").get();
  return r && (r.value === 'NCF' || r.value === 'ECF') ? r.value : 'ninguno';
}

// ── Emisor ────────────────────────────────────────────────────────
export function getCompany(db) {
  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() || {};
  return {
    legalName: c.legal_name || '', tradeName: c.trade_name || '', rnc: c.rnc || '', branch: c.branch || '',
    address: c.address || '', phone: c.phone || '', email: c.email || '', taxRegime: c.tax_regime || 'ORDINARIO', mode: fiscalMode(db),
    ambiente: getAmbiente(db)
  };
}

function saveCompany(db, body, user, ip) {
  const legalName = txt(body.legalName, 'la razón social', 120, true);
  const tradeName = txt(body.tradeName, 'el nombre comercial', 120) || legalName;
  const rncRaw = onlyDigits(body.rnc);
  let rnc = '';
  if (rncRaw) {
    const d = parseDoc(rncRaw);
    if (!d) throw new HttpError(400, 'El RNC debe tener 9 dígitos (o 11 si es una cédula de persona física)');
    if (!d.valid) throw new HttpError(400, `El ${d.type === 'RNC' ? 'RNC' : 'número de cédula'} no es válido (el dígito verificador no coincide)`);
    rnc = d.number;
  }
  const taxRegime = body.taxRegime === 'RST' ? 'RST' : 'ORDINARIO';
  const mode = body.mode === 'NCF' || body.mode === 'ECF' ? body.mode : 'ninguno';
  if (mode !== 'ninguno' && !rnc) throw new HttpError(400, 'Para emitir comprobantes primero registra el RNC del negocio');
  if (mode === 'ECF') {
    if (!txt(body.address, 'la dirección', 200)) throw new HttpError(400, 'La dirección del negocio es obligatoria en los e-CF');
    const p = certProblem(db);
    if (p) throw new HttpError(409, p);
  }
  const email = txt(body.email, 'el correo', 80);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'El correo no es válido');
  db.prepare(`INSERT INTO company (id, legal_name, trade_name, rnc, branch, address, phone, tax_regime) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET legal_name = excluded.legal_name, trade_name = excluded.trade_name, rnc = excluded.rnc,
              branch = excluded.branch, address = excluded.address, phone = excluded.phone, tax_regime = excluded.tax_regime, updated_at = datetime('now')`)
    .run(legalName, tradeName, rnc, txt(body.branch, 'la sucursal', 60), txt(body.address, 'la dirección', 200), txt(body.phone, 'el teléfono', 40), taxRegime);
  db.prepare('UPDATE company SET email = ? WHERE id = 1').run(email || null);
  db.prepare("INSERT INTO settings (key, value) VALUES ('fiscal_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(mode);
  audit(db, user.id, 'fiscal.emisor', { entity: 'company', entityId: '1', detail: { rnc, regimen: taxRegime, modo: mode }, ip });
  return getCompany(db);
}

// ── Secuencias ────────────────────────────────────────────────────
function seqRow(s) {
  const remaining = Math.max(0, s.end_number - s.next_number + 1);
  const days = s.expires_on ? daysUntil(s.expires_on) : null;
  const expired = days != null && days < 0;
  const exhausted = remaining === 0;
  return {
    id: s.id, kind: s.kind, ambiente: s.ambiente || null, typeCode: s.type_code, typeName: (typeInfo(s.kind, s.type_code) || {}).name || s.type_code, prefix: s.prefix,
    start: s.start_number, end: s.end_number, next: s.next_number, remaining, used: s.next_number - s.start_number,
    from: formatNcf(s.kind, s.type_code, s.start_number), to: formatNcf(s.kind, s.type_code, s.end_number),
    nextNcf: exhausted ? null : formatNcf(s.kind, s.type_code, s.next_number),
    expiresOn: s.expires_on, daysToExpire: days, alertAt: s.alert_at_remaining, active: !!s.active,
    state: !s.active ? 'inactiva' : expired ? 'vencida' : exhausted ? 'agotada' : (remaining <= s.alert_at_remaining || (days != null && days <= ALERT_DAYS)) ? 'alerta' : 'ok'
  };
}

export function listSequences(db) {
  return db.prepare("SELECT * FROM ncf_sequences ORDER BY kind DESC, type_code, start_number").all().map(seqRow);
}

function createSequence(db, body, user, ip) {
  const kind = body.kind === 'ECF' ? 'ECF' : 'NCF';
  const typeCode = String(body.typeCode || '');
  if (!typeInfo(kind, typeCode)) throw new HttpError(400, 'Tipo de comprobante inválido');
  const ambiente = kind === 'ECF' ? getAmbiente(db) : null;
  const start = Number(body.start), end = Number(body.end);
  if (!Number.isInteger(start) || start < 1) throw new HttpError(400, 'El número inicial debe ser 1 o mayor');
  if (!Number.isInteger(end) || end < start) throw new HttpError(400, 'El número final debe ser mayor o igual al inicial');
  if (end > MAX_SEQ[kind]) throw new HttpError(400, `El número final pasa del máximo de ${kind === 'ECF' ? 10 : 8} dígitos`);
  const expiresOn = String(body.expiresOn || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new HttpError(400, 'Escribe la fecha de vencimiento que te autorizó la DGII');
  if (daysUntil(expiresOn) < 0) throw new HttpError(400, 'Esa fecha de vencimiento ya pasó');
  const auto = Math.max(1, Math.min(50, Math.floor((end - start + 1) * 0.1)));
  const alertAt = body.alertAt !== '' && body.alertAt != null && Number.isInteger(Number(body.alertAt)) && Number(body.alertAt) >= 0 ? Number(body.alertAt) : auto;
  const overlap = db.prepare(`SELECT 1 FROM ncf_sequences WHERE kind = ? AND type_code = ? AND COALESCE(ambiente, '') = ? AND NOT (end_number < ? OR start_number > ?)`)
    .get(kind, typeCode, ambiente || '', start, end);
  if (overlap) throw new HttpError(409, 'Ese rango se cruza con una secuencia que ya registraste para ese tipo');
  const sid = id('seq');
  db.prepare(`INSERT INTO ncf_sequences (id, kind, type_code, prefix, start_number, end_number, next_number, expires_on, alert_at_remaining, ambiente)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, kind, typeCode, `${kind === 'ECF' ? 'E' : 'B'}${typeCode}`, start, end, start, expiresOn, alertAt, ambiente);
  audit(db, user.id, 'fiscal.secuencia.crear', { entity: 'ncf_sequence', entityId: sid, detail: { tipo: `${kind === 'ECF' ? 'E' : 'B'}${typeCode}`, desde: start, hasta: end, vence: expiresOn, ambiente }, ip });
  return seqRow(db.prepare('SELECT * FROM ncf_sequences WHERE id = ?').get(sid));
}

function updateSequence(db, sid, body, user, ip) {
  const s = db.prepare('SELECT * FROM ncf_sequences WHERE id = ?').get(sid);
  if (!s) throw new HttpError(404, 'Secuencia no encontrada');
  const active = body.active === undefined ? s.active : (body.active ? 1 : 0);
  const alertAt = body.alertAt === undefined ? s.alert_at_remaining : Math.max(0, parseInt(body.alertAt, 10) || 0);
  let expiresOn = s.expires_on;
  if (body.expiresOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.expiresOn))) throw new HttpError(400, 'Fecha de vencimiento inválida');
    expiresOn = String(body.expiresOn);
  }
  db.prepare('UPDATE ncf_sequences SET active = ?, alert_at_remaining = ?, expires_on = ? WHERE id = ?').run(active, alertAt, expiresOn, sid);
  audit(db, user.id, 'fiscal.secuencia.editar', { entity: 'ncf_sequence', entityId: sid, detail: { activa: !!active, alerta: alertAt, vence: expiresOn }, ip });
  return seqRow(db.prepare('SELECT * FROM ncf_sequences WHERE id = ?').get(sid));
}

/** Estado fiscal para la caja: qué tipos se pueden emitir y alertas. */
export function fiscalStatus(db) {
  const mode = fiscalMode(db);
  const kind = mode === 'ECF' ? 'ECF' : 'NCF';
  const amb = getAmbiente(db);
  const seqs = listSequences(db).filter((s) => s.active && s.kind === kind && (kind === 'NCF' || s.ambiente === amb));
  const order = kind === 'ECF' ? ECF_SALE_ORDER.filter((c) => c !== '44') : ['02', '01', '15'];
  const types = order.map((code) => [code, typeInfo(kind, code)]).map(([code, t]) => {
    const usable = seqs.filter((s) => s.typeCode === code && (s.state === 'ok' || s.state === 'alerta'));
    const remaining = usable.reduce((a, s) => a + s.remaining, 0);
    const cur = usable[0];
    return { code, name: t.name, short: t.short, needsDoc: t.needsDoc, available: remaining > 0, remaining, nextNcf: cur ? cur.nextNcf : null, expiresOn: cur ? cur.expiresOn : null };
  });
  const alerts = [];
  if (mode !== 'ninguno') {
    for (const s of seqs) {
      if (s.state === 'vencida') alerts.push({ level: 'bad', text: `La secuencia ${s.prefix} (${s.typeName}) venció el ${s.expiresOn}.` });
      else if (s.state === 'agotada') alerts.push({ level: 'bad', text: `Se agotaron los NCF ${s.prefix} (${s.typeName}).` });
      else if (s.state === 'alerta') alerts.push({ level: 'warn', text: `${s.prefix} (${s.typeName}): ${s.remaining === 1 ? 'queda 1 comprobante' : `quedan ${s.remaining} comprobantes`}${s.daysToExpire != null && s.daysToExpire <= ALERT_DAYS ? `, vence en ${s.daysToExpire} día${s.daysToExpire === 1 ? '' : 's'}` : ''}.` });
    }
    const consumo = types[0];
    if (!consumo.available) alerts.push({ level: 'bad', text: `No hay comprobantes de Consumo (${kind === 'ECF' ? 'E32' : 'B02'}) disponibles: no se puede cobrar hasta registrar una secuencia vigente.` });
  }
  let cert = null;
  if (mode === 'ECF') {
    cert = activeCert(db);
    const p = certProblem(db);
    if (p) alerts.unshift({ level: 'bad', text: p });
    else if (cert.daysLeft <= 30) alerts.push({ level: 'warn', text: `El certificado digital vence en ${cert.daysLeft} día${cert.daysLeft === 1 ? '' : 's'} (${cert.notAfter.slice(0, 10)}). Renuévalo a tiempo.` });
    if (amb !== 'eCF') alerts.push({ level: 'warn', text: `Facturación electrónica en ambiente de ${AMBIENTES[amb].name}: los e-CF se firman pero todavía no tienen validez fiscal.` });
    const q = queueSummary(db);
    if (q.authError) alerts.unshift({ level: 'bad', text: `No se pudo conectar con la DGII: ${q.authError}` });
    if (q.rechazados) alerts.unshift({ level: 'bad', text: `La DGII rechazó ${q.rechazados} e-CF. Revísalos en «Comprobantes e-CF» y reemítelos.` });
    if (q.contingencia) {
      const h = q.limiteMasCercano ? Math.floor((new Date(q.limiteMasCercano) - Date.now()) / 3600000) : null;
      alerts.unshift({ level: h != null && h < 24 ? 'bad' : 'warn', text: `Contingencia: ${q.contingencia} e-CF sin enviar a la DGII${h != null ? (h >= 0 ? `; el más viejo vence en ${h} h` : '; ¡ya pasó el plazo de 72 h!') : ''}. NexoCaja los reintenta solo.` });
    }
  }
  const ncSeqs = seqs.filter((s) => s.typeCode === (kind === 'ECF' ? '34' : '04') && (s.state === 'ok' || s.state === 'alerta'));
  const creditNote = { remaining: ncSeqs.reduce((a, s) => a + s.remaining, 0), nextNcf: ncSeqs[0] ? ncSeqs[0].nextNcf : null };
  creditNote.available = creditNote.remaining > 0;
  return { mode, kind, ambiente: mode === 'ECF' ? amb : null, types, creditNote, alerts, consumoThreshold: CONSUMO_ID_THRESHOLD,
    cert: cert ? { notAfter: cert.notAfter, daysLeft: cert.daysLeft } : null };
}

/**
 * Valida y toma el siguiente NCF dentro de la transacción de la venta.
 * Devuelve { ncf, typeCode, expiresOn, customer } o null si no se usan comprobantes.
 */
export function prepareFiscal(db, body, total) {
  const mode = fiscalMode(db);
  if (mode === 'ninguno') return null;
  const kind = mode === 'ECF' ? 'ECF' : 'NCF';
  const typeCode = String(body.ncfType || (kind === 'ECF' ? '32' : '02'));
  const t = typeInfo(kind, typeCode);
  if (!t || !t.sale || typeCode === '44') throw new HttpError(400, 'Tipo de comprobante inválido para una venta');
  if (kind === 'ECF') { const p = certProblem(db); if (p) throw new HttpError(409, p); }
  let customer = null;
  if (body.customerId) {
    customer = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(String(body.customerId));
    if (!customer) throw new HttpError(409, 'El cliente seleccionado ya no existe');
  }
  if (t.needsDoc && !(customer && customer.doc_number)) {
    throw new HttpError(409, `La factura de ${t.name} necesita un cliente con RNC o cédula (F2 para elegirlo)`);
  }
  if ((typeCode === '15' || typeCode === '45') && customer && customer.doc_type !== 'RNC') throw new HttpError(409, 'La factura Gubernamental necesita el RNC de la institución');
  if ((typeCode === '02' || typeCode === '32') && total >= CONSUMO_ID_THRESHOLD && !(customer && customer.doc_number)) {
    throw new HttpError(409, 'Las facturas de consumo de RD$250,000 o más deben identificar al comprador (F2 para elegir un cliente con cédula o RNC)');
  }
  return { typeCode, kind, customer };
}

export function takeNcf(db, typeCode, kind = 'NCF') {
  const amb = kind === 'ECF' ? getAmbiente(db) : '';
  const seq = db.prepare(`SELECT * FROM ncf_sequences WHERE kind = ? AND type_code = ? AND active = 1 AND next_number <= end_number
                          AND COALESCE(ambiente, '') = ? AND (expires_on IS NULL OR expires_on >= ?) ORDER BY start_number LIMIT 1`).get(kind, typeCode, amb, today());
  const pre = kind === 'ECF' ? 'E' : 'B';
  if (!seq) throw new HttpError(409, `No hay comprobantes ${typeInfo(kind, typeCode).name} (${pre}${typeCode}) disponibles${kind === 'ECF' ? ` en ${AMBIENTES[amb].name}` : ''}: no hay secuencia, o está agotada o vencida. Regístrala en Configuración fiscal.`);
  const r = db.prepare('UPDATE ncf_sequences SET next_number = next_number + 1 WHERE id = ? AND next_number = ?').run(seq.id, seq.next_number);
  if (!r.changes) throw new HttpError(409, 'Otro cobro tomó ese NCF al mismo tiempo; intenta de nuevo');
  return { ncf: formatNcf(kind, typeCode, seq.next_number), expiresOn: seq.expires_on };
}

// ── Clientes ──────────────────────────────────────────────────────
function customerRow(c) {
  return {
    id: c.id, name: c.name, docType: c.doc_type, docNumber: c.doc_number, docFormatted: c.doc_number ? formatDoc(c.doc_type, c.doc_number) : '',
    phone: c.phone || '', email: c.email || '', address: c.address || '', active: !!c.active
  };
}

function listCustomers(db, q) {
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const digits = onlyDigits(q);
    return db.prepare(`SELECT * FROM customers WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR (? <> '' AND doc_number LIKE ?)) ORDER BY name LIMIT 100`)
      .all(like, digits, `%${digits}%`).map(customerRow);
  }
  return db.prepare('SELECT * FROM customers WHERE active = 1 ORDER BY name LIMIT 500').all().map(customerRow);
}

function readCustomer(body) {
  const name = txt(body.name, 'el nombre o razón social', 120, true);
  const raw = onlyDigits(body.docNumber);
  let docType = null, docNumber = null;
  if (raw) {
    const d = parseDoc(raw);
    if (!d) throw new HttpError(400, 'El documento debe ser un RNC de 9 dígitos o una cédula de 11 dígitos');
    if (!d.valid && !body.force) throw new HttpError(422, `El ${d.type === 'RNC' ? 'RNC' : 'número de cédula'} no pasa la validación del dígito verificador. Revísalo; si estás seguro de que es correcto, guárdalo de todos modos.`);
    docType = d.type; docNumber = d.number;
  }
  const email = txt(body.email, 'el correo', 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'El correo no es válido');
  return { name, docType, docNumber, phone: txt(body.phone, 'el teléfono', 40), email, address: txt(body.address, 'la dirección', 200) };
}

function saveCustomer(db, cid, body, user, ip) {
  const c = readCustomer(body);
  if (c.docNumber) {
    const dup = db.prepare('SELECT name FROM customers WHERE doc_number = ? AND active = 1 AND id <> ?').get(c.docNumber, cid || '');
    if (dup) throw new HttpError(409, `Ese documento ya está registrado para ${dup.name}`);
  }
  if (cid) {
    const r = db.prepare('UPDATE customers SET name = ?, doc_type = ?, doc_number = ?, phone = ?, email = ?, address = ? WHERE id = ? AND active = 1')
      .run(c.name, c.docType, c.docNumber, c.phone, c.email, c.address, cid);
    if (!r.changes) throw new HttpError(404, 'Cliente no encontrado');
  } else {
    cid = id('c');
    db.prepare('INSERT INTO customers (id, name, doc_type, doc_number, phone, email, address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cid, c.name, c.docType, c.docNumber, c.phone, c.email, c.address);
  }
  audit(db, user.id, body.id ? 'cliente.editar' : 'cliente.guardar', { entity: 'customer', entityId: cid, detail: { nombre: c.name, doc: c.docNumber }, ip });
  return customerRow(db.prepare('SELECT * FROM customers WHERE id = ?').get(cid));
}

// ── Rutas /api/fiscal/* y /api/customers/* ───────────────────────
export async function handleFiscal(req, res, pathname, searchParams, ctx) {
  const { db, json, user } = ctx;
  const parts = pathname.split('/').filter(Boolean);
  if (parts[1] !== 'fiscal' && parts[1] !== 'customers') return false;
  if (!user) throw new HttpError(401, 'Inicia sesión');
  const owner = () => { if (user.role !== 'owner') throw new HttpError(403, 'Solo el dueño cambia la configuración fiscal'); };

  if (parts[1] === 'fiscal') {
    if (req.method === 'GET' && parts[2] === 'status') return json(res, 200, fiscalStatus(db)), true;
    if (req.method === 'GET' && parts[2] === 'company') return json(res, 200, getCompany(db)), true;
    if (req.method === 'PUT' && parts[2] === 'company') { owner(); return json(res, 200, saveCompany(db, await ctx.readJson(req), user, ctx.ip)), true; }
    if (req.method === 'GET' && parts[2] === 'sequences') {
      if (!can(user, 'costos.ver')) throw new HttpError(403, 'No tienes permiso para esto');
      return json(res, 200, listSequences(db)), true;
    }
    if (req.method === 'POST' && parts[2] === 'sequences') { owner(); return json(res, 201, createSequence(db, await ctx.readJson(req), user, ctx.ip)), true; }
    if (req.method === 'PUT' && parts[2] === 'sequences' && parts[3]) { owner(); return json(res, 200, updateSequence(db, parts[3], await ctx.readJson(req), user, ctx.ip)), true; }
    // ── Facturación electrónica ──
    if (parts[2] === 'cert') {
      owner();
      if (req.method === 'GET') return json(res, 200, { cert: activeCert(db) }), true;
      if (req.method === 'POST') {
        const body = await ctx.readJson(req, 512 * 1024);
        const buf = Buffer.from(String(body.fileBase64 || ''), 'base64');
        const c = saveCertificate(db, buf, body.password, user.id);
        audit(db, user.id, 'ecf.certificado', { entity: 'certificate', entityId: c.id, detail: { titular: c.subject, vence: c.notAfter, emisor: c.issuer }, ip: ctx.ip });
        return json(res, 201, { cert: c }), true;
      }
      if (req.method === 'DELETE') {
        if (fiscalMode(db) === 'ECF') throw new HttpError(409, 'Primero cambia el modo de comprobantes: la caja está emitiendo e-CF con este certificado');
        removeCertificate(db);
        audit(db, user.id, 'ecf.certificado.quitar', { entity: 'certificate', ip: ctx.ip });
        return json(res, 200, { cert: null }), true;
      }
    }
    if (req.method === 'PUT' && parts[2] === 'ambiente') {
      owner();
      const body = await ctx.readJson(req);
      setAmbiente(db, String(body.ambiente || ''));
      audit(db, user.id, 'ecf.ambiente', { entity: 'settings', entityId: 'ecf_ambiente', detail: { ambiente: body.ambiente }, ip: ctx.ip });
      return json(res, 200, fiscalStatus(db)), true;
    }
    if (req.method === 'GET' && parts[2] === 'ecf') {
      if (!can(user, 'reportes.ver')) throw new HttpError(403, 'No tienes permiso para esto');
      if (parts[3] && parts[4] === 'xml') {
        const f = ecfXmlPath(db, decodeURIComponent(parts[3]).toUpperCase());
        if (!f || !fs.existsSync(f)) throw new HttpError(404, 'No encontré el XML de ese e-CF');
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${f.split(/[\\/]/).pop()}"`, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(f));
        return true;
      }
      return json(res, 200, listDocs(db, Math.min(500, Number(searchParams.get('limit')) || 100))), true;
    }
  }

  if (parts[1] === 'customers') {
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, listCustomers(db, (searchParams.get('q') || '').trim())), true;
    if (req.method === 'POST' && parts.length === 2) return json(res, 201, saveCustomer(db, null, await ctx.readJson(req), user, ctx.ip)), true;
    if (req.method === 'PUT' && parts[2]) return json(res, 200, saveCustomer(db, parts[2], { ...(await ctx.readJson(req)), id: parts[2] }, user, ctx.ip)), true;
    if (req.method === 'DELETE' && parts[2]) {
      if (!can(user, 'productos.editar')) throw new HttpError(403, 'Solo un supervisor o el dueño puede eliminar clientes');
      const r = db.prepare('UPDATE customers SET active = 0 WHERE id = ? AND active = 1').run(parts[2]);
      if (!r.changes) throw new HttpError(404, 'Cliente no encontrado');
      audit(db, user.id, 'cliente.eliminar', { entity: 'customer', entityId: parts[2], ip: ctx.ip });
      return json(res, 200, { ok: true }), true;
    }
  }
  return json(res, 404, { error: 'No encontrado' }), true;
}
