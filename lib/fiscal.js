// NexoCaja · Módulo fiscal: emisor, secuencias NCF y clientes.
import crypto from 'node:crypto';
import { can, audit, HttpError } from './auth.js';
import { NCF_TYPES, CONSUMO_ID_THRESHOLD, parseDoc, formatDoc, formatNcf, MAX_SEQ, onlyDigits } from './rd.js';

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
  return r && r.value === 'NCF' ? 'NCF' : 'ninguno';
}

// ── Emisor ────────────────────────────────────────────────────────
export function getCompany(db) {
  const c = db.prepare('SELECT * FROM company WHERE id = 1').get() || {};
  return {
    legalName: c.legal_name || '', tradeName: c.trade_name || '', rnc: c.rnc || '', branch: c.branch || '',
    address: c.address || '', phone: c.phone || '', taxRegime: c.tax_regime || 'ORDINARIO', mode: fiscalMode(db)
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
  const mode = body.mode === 'NCF' ? 'NCF' : 'ninguno';
  if (mode === 'NCF' && !rnc) throw new HttpError(400, 'Para emitir NCF primero registra el RNC del negocio');
  db.prepare(`INSERT INTO company (id, legal_name, trade_name, rnc, branch, address, phone, tax_regime) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET legal_name = excluded.legal_name, trade_name = excluded.trade_name, rnc = excluded.rnc,
              branch = excluded.branch, address = excluded.address, phone = excluded.phone, tax_regime = excluded.tax_regime, updated_at = datetime('now')`)
    .run(legalName, tradeName, rnc, txt(body.branch, 'la sucursal', 60), txt(body.address, 'la dirección', 200), txt(body.phone, 'el teléfono', 40), taxRegime);
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
    id: s.id, kind: s.kind, typeCode: s.type_code, typeName: (NCF_TYPES[s.type_code] || {}).name || s.type_code, prefix: s.prefix,
    start: s.start_number, end: s.end_number, next: s.next_number, remaining, used: s.next_number - s.start_number,
    from: formatNcf(s.kind, s.type_code, s.start_number), to: formatNcf(s.kind, s.type_code, s.end_number),
    nextNcf: exhausted ? null : formatNcf(s.kind, s.type_code, s.next_number),
    expiresOn: s.expires_on, daysToExpire: days, alertAt: s.alert_at_remaining, active: !!s.active,
    state: !s.active ? 'inactiva' : expired ? 'vencida' : exhausted ? 'agotada' : (remaining <= s.alert_at_remaining || (days != null && days <= ALERT_DAYS)) ? 'alerta' : 'ok'
  };
}

export function listSequences(db) {
  return db.prepare("SELECT * FROM ncf_sequences ORDER BY type_code, start_number").all().map(seqRow);
}

function createSequence(db, body, user, ip) {
  const typeCode = String(body.typeCode || '');
  if (!NCF_TYPES[typeCode]) throw new HttpError(400, 'Tipo de comprobante inválido');
  const start = Number(body.start), end = Number(body.end);
  if (!Number.isInteger(start) || start < 1) throw new HttpError(400, 'El número inicial debe ser 1 o mayor');
  if (!Number.isInteger(end) || end < start) throw new HttpError(400, 'El número final debe ser mayor o igual al inicial');
  if (end > MAX_SEQ.NCF) throw new HttpError(400, 'El número final pasa del máximo de 8 dígitos');
  const expiresOn = String(body.expiresOn || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw new HttpError(400, 'Escribe la fecha de vencimiento que te autorizó la DGII');
  if (daysUntil(expiresOn) < 0) throw new HttpError(400, 'Esa fecha de vencimiento ya pasó');
  const auto = Math.max(1, Math.min(50, Math.floor((end - start + 1) * 0.1)));
  const alertAt = body.alertAt !== '' && body.alertAt != null && Number.isInteger(Number(body.alertAt)) && Number(body.alertAt) >= 0 ? Number(body.alertAt) : auto;
  const overlap = db.prepare(`SELECT 1 FROM ncf_sequences WHERE kind = 'NCF' AND type_code = ? AND NOT (end_number < ? OR start_number > ?)`).get(typeCode, start, end);
  if (overlap) throw new HttpError(409, 'Ese rango se cruza con una secuencia que ya registraste para ese tipo');
  const sid = id('seq');
  db.prepare(`INSERT INTO ncf_sequences (id, kind, type_code, prefix, start_number, end_number, next_number, expires_on, alert_at_remaining)
              VALUES (?, 'NCF', ?, ?, ?, ?, ?, ?, ?)`).run(sid, typeCode, `B${typeCode}`, start, end, start, expiresOn, alertAt);
  audit(db, user.id, 'fiscal.secuencia.crear', { entity: 'ncf_sequence', entityId: sid, detail: { tipo: typeCode, desde: start, hasta: end, vence: expiresOn }, ip });
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
  const seqs = listSequences(db).filter((s) => s.active && s.kind === 'NCF');
  const types = ['02', '01', '15'].map((code) => [code, NCF_TYPES[code]]).map(([code, t]) => {
    const usable = seqs.filter((s) => s.typeCode === code && (s.state === 'ok' || s.state === 'alerta'));
    const remaining = usable.reduce((a, s) => a + s.remaining, 0);
    const cur = usable[0];
    return { code, name: t.name, needsDoc: t.needsDoc, available: remaining > 0, remaining, nextNcf: cur ? cur.nextNcf : null, expiresOn: cur ? cur.expiresOn : null };
  });
  const alerts = [];
  if (mode === 'NCF') {
    for (const s of seqs) {
      if (s.state === 'vencida') alerts.push({ level: 'bad', text: `La secuencia ${s.prefix} (${s.typeName}) venció el ${s.expiresOn}.` });
      else if (s.state === 'agotada') alerts.push({ level: 'bad', text: `Se agotaron los NCF ${s.prefix} (${s.typeName}).` });
      else if (s.state === 'alerta') alerts.push({ level: 'warn', text: `${s.prefix} (${s.typeName}): ${s.remaining === 1 ? 'queda 1 comprobante' : `quedan ${s.remaining} comprobantes`}${s.daysToExpire != null && s.daysToExpire <= ALERT_DAYS ? `, vence en ${s.daysToExpire} día${s.daysToExpire === 1 ? '' : 's'}` : ''}.` });
    }
    if (!types.find((t) => t.code === '02').available) alerts.push({ level: 'bad', text: 'No hay NCF de Consumo (B02) disponibles: no se puede cobrar hasta registrar una secuencia vigente.' });
  }
  const ncSeqs = seqs.filter((s) => s.typeCode === '04' && (s.state === 'ok' || s.state === 'alerta'));
  const creditNote = { remaining: ncSeqs.reduce((a, s) => a + s.remaining, 0), nextNcf: ncSeqs[0] ? ncSeqs[0].nextNcf : null };
  creditNote.available = creditNote.remaining > 0;
  return { mode, types, creditNote, alerts, consumoThreshold: CONSUMO_ID_THRESHOLD };
}

/**
 * Valida y toma el siguiente NCF dentro de la transacción de la venta.
 * Devuelve { ncf, typeCode, expiresOn, customer } o null si no se usan comprobantes.
 */
export function prepareFiscal(db, body, total) {
  if (fiscalMode(db) !== 'NCF') return null;
  const typeCode = String(body.ncfType || '02');
  const t = NCF_TYPES[typeCode];
  if (!t || !t.sale) throw new HttpError(400, 'Tipo de comprobante inválido para una venta');
  let customer = null;
  if (body.customerId) {
    customer = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(String(body.customerId));
    if (!customer) throw new HttpError(409, 'El cliente seleccionado ya no existe');
  }
  if (t.needsDoc && !(customer && customer.doc_number)) {
    throw new HttpError(409, `La factura de ${t.name} necesita un cliente con RNC o cédula (F2 para elegirlo)`);
  }
  if (typeCode === '15' && customer && customer.doc_type !== 'RNC') throw new HttpError(409, 'La factura Gubernamental necesita el RNC de la institución');
  if (typeCode === '02' && total >= CONSUMO_ID_THRESHOLD && !(customer && customer.doc_number)) {
    throw new HttpError(409, 'Las facturas de consumo de RD$250,000 o más deben identificar al comprador (F2 para elegir un cliente con cédula o RNC)');
  }
  return { typeCode, customer };
}

export function takeNcf(db, typeCode) {
  const seq = db.prepare(`SELECT * FROM ncf_sequences WHERE kind = 'NCF' AND type_code = ? AND active = 1 AND next_number <= end_number
                          AND (expires_on IS NULL OR expires_on >= ?) ORDER BY start_number LIMIT 1`).get(typeCode, today());
  if (!seq) throw new HttpError(409, `No hay NCF de ${NCF_TYPES[typeCode].name} (B${typeCode}) disponibles: no hay secuencia, o está agotada o vencida. Regístrala en Configuración fiscal.`);
  const r = db.prepare('UPDATE ncf_sequences SET next_number = next_number + 1 WHERE id = ? AND next_number = ?').run(seq.id, seq.next_number);
  if (!r.changes) throw new HttpError(409, 'Otro cobro tomó ese NCF al mismo tiempo; intenta de nuevo');
  return { ncf: formatNcf('NCF', typeCode, seq.next_number), expiresOn: seq.expires_on };
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
