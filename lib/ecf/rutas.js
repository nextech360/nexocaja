// NexoCaja · API de comprobantes electrónicos: monitor, reintento, reemisión y prueba de conexión.
import { can, audit, HttpError } from '../auth.js';
import { takeNcf } from '../fiscal.js';
import { onlyDigits } from '../rd.js';
import { issueEcf, docRow, getAmbiente, signWithActive, certProblem } from './emision.js';
import { run, kick, queueSummary } from './cola.js';
import * as dgii from './dgii.js';

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Reemite un e-CF rechazado con un e-NCF nuevo (los datos salen de la venta o nota original). */
function reissue(db, encf, user, ip) {
  const d = db.prepare('SELECT * FROM ecf_documents WHERE encf = ?').get(encf);
  if (!d) throw new HttpError(404, 'No existe ese e-CF');
  if (d.estado !== 'rechazado') throw new HttpError(409, 'Solo se reemiten los e-CF rechazados por la DGII');
  if (d.reemplazado_por) throw new HttpError(409, `Ya se reemitió como ${d.reemplazado_por}`);
  if (d.ambiente !== getAmbiente(db)) throw new HttpError(409, `Ese e-CF es del ambiente ${d.ambiente}; cambia a ese ambiente para reemitirlo`);
  return tx(db, () => {
    const nc = takeNcf(db, d.tipo, 'ECF');
    let input;
    if (d.origen === 'venta') {
      const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(d.origen_id);
      const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY rowid').all(s.id);
      const pays = db.prepare('SELECT method, amount FROM sale_payments WHERE sale_id = ? ORDER BY rowid').all(s.id);
      const doc = s.customer_doc ? onlyDigits(s.customer_doc) : '';
      input = { tipo: d.tipo, encf: nc.ncf, venceSecuencia: nc.expiresOn, origen: 'venta', origenId: s.id,
        comprador: doc ? { rnc: doc, razonSocial: s.customer_name } : null,
        pagos: pays.map((p) => ({ metodo: p.method, monto: p.amount })),
        lineas: lines.map((l) => ({ nombre: l.name_snapshot, cantidad: l.qty, descuentoPct: l.discount_pct, descuento: l.discount, tasa: l.tax_rate, itbis: l.tax, total: l.line_total })) };
      db.prepare('UPDATE sales SET ncf = ?, ncf_expires_on = ? WHERE id = ?').run(nc.ncf, nc.expiresOn, s.id);
    } else if (d.origen === 'nota_credito') {
      const n = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(d.origen_id);
      const lines = db.prepare('SELECT * FROM credit_note_lines WHERE credit_note_id = ? ORDER BY rowid').all(n.id);
      const doc = n.customer_doc ? onlyDigits(n.customer_doc) : '';
      input = { tipo: d.tipo, encf: nc.ncf, origen: 'nota_credito', origenId: n.id, indicadorNotaCredito: !n.itbis_applies,
        comprador: doc ? { rnc: doc, razonSocial: n.customer_name } : null,
        referencia: { ncf: d.ref_encf, fecha: d.ref_fecha, codigo: Number(d.ref_codigo), razon: n.reason },
        lineas: lines.map((l) => ({ nombre: l.name_snapshot, cantidad: l.qty, tasa: l.tax_rate, itbis: l.tax, total: l.line_total })) };
      db.prepare('UPDATE credit_notes SET ncf = ? WHERE id = ?').run(nc.ncf, n.id);
    } else throw new HttpError(409, 'Ese tipo de documento no se puede reemitir desde aquí');
    issueEcf(db, input);
    db.prepare('UPDATE ecf_documents SET reemplazado_por = ? WHERE id = ?').run(nc.ncf, d.id);
    audit(db, user.id, 'ecf.reemitir', { entity: 'ecf', entityId: d.id, detail: { anterior: encf, nuevo: nc.ncf, origen: d.origen }, ip });
    return { anterior: encf, nuevo: nc.ncf, origen: d.origen, origenId: d.origen_id };
  });
}

export async function handleEcf(req, res, pathname, searchParams, ctx) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[1] !== 'ecf') return false;
  const { db, json, user } = ctx;
  if (!user) throw new HttpError(401, 'Inicia sesión');
  if (req.method === 'GET' && parts[2] === 'summary') return json(res, 200, queueSummary(db)), true; // todos (indicador del encabezado)
  if (!can(user, 'reportes.ver')) throw new HttpError(403, 'Los comprobantes electrónicos los revisa el supervisor o el dueño');

  if (req.method === 'GET' && parts[2] === 'docs' && !parts[3]) {
    const estado = String(searchParams.get('estado') || '');
    const q = String(searchParams.get('q') || '').trim().toUpperCase();
    const limit = Math.min(500, Number(searchParams.get('limit')) || 200);
    let rows;
    if (q) rows = db.prepare('SELECT * FROM ecf_documents WHERE encf LIKE ? OR track_id = ? ORDER BY created_at DESC LIMIT ?').all(`%${q}%`, q, limit);
    else if (estado === 'pendientes') rows = db.prepare(`SELECT * FROM ecf_documents WHERE estado IN ('firmado','en_cola','en_proceso','enviado') ORDER BY created_at DESC LIMIT ?`).all(limit);
    else if (estado === 'aceptados') rows = db.prepare(`SELECT * FROM ecf_documents WHERE estado IN ('aceptado','aceptado_condicional') ORDER BY created_at DESC LIMIT ?`).all(limit);
    else if (estado) rows = db.prepare('SELECT * FROM ecf_documents WHERE estado = ? ORDER BY created_at DESC LIMIT ?').all(estado, limit);
    else rows = db.prepare('SELECT * FROM ecf_documents ORDER BY created_at DESC LIMIT ?').all(limit);
    return json(res, 200, { summary: queueSummary(db), docs: rows.map(docRow) }), true;
  }
  if (req.method === 'GET' && parts[2] === 'docs' && parts[3]) {
    const d = db.prepare('SELECT * FROM ecf_documents WHERE encf = ?').get(decodeURIComponent(parts[3]).toUpperCase());
    if (!d) throw new HttpError(404, 'No existe ese e-CF');
    const log = db.prepare('SELECT servicio, http_status, duracion_ms, request_resumen, response_raw, created_at FROM ecf_log WHERE document_id = ? ORDER BY id DESC LIMIT 30').all(d.id);
    return json(res, 200, { ...docRow(d), log }), true;
  }
  if (req.method === 'POST' && parts[2] === 'docs' && parts[3] && parts[4] === 'retry') {
    const encf = decodeURIComponent(parts[3]).toUpperCase();
    const r = db.prepare(`UPDATE ecf_documents SET proximo_intento = NULL WHERE encf = ? AND estado IN ('firmado','en_cola','en_proceso','enviado')`).run(encf);
    if (!r.changes) throw new HttpError(409, 'Ese e-CF no está pendiente');
    await run();
    return json(res, 200, docRow(db.prepare('SELECT * FROM ecf_documents WHERE encf = ?').get(encf))), true;
  }
  if (req.method === 'POST' && parts[2] === 'docs' && parts[3] && parts[4] === 'reissue') {
    const r = reissue(db, decodeURIComponent(parts[3]).toUpperCase(), user, ctx.ip);
    kick();
    return json(res, 200, r), true;
  }
  if (req.method === 'POST' && parts[2] === 'send-now') {
    db.prepare(`UPDATE ecf_documents SET proximo_intento = NULL WHERE estado IN ('firmado','en_cola','en_proceso','enviado')`).run();
    const r = await run();
    return json(res, 200, { ...(r || {}), summary: queueSummary(db) }), true;
  }
  if (req.method === 'POST' && parts[2] === 'test') {
    if (user.role !== 'owner') throw new HttpError(403, 'Solo el dueño');
    const p = certProblem(db); if (p) throw new HttpError(409, p);
    const amb = getAmbiente(db);
    const t0 = Date.now();
    try {
      await dgii.getToken(db, amb, signWithActive(db), { force: true });
      audit(db, user.id, 'ecf.prueba_conexion', { detail: { ambiente: amb, ok: true }, ip: ctx.ip });
      return json(res, 200, { ok: true, ambiente: amb, ms: Date.now() - t0, mensaje: `Conectado con la DGII (${amb}). El certificado fue aceptado y se obtuvo el token de sesión.` }), true;
    } catch (err) {
      return json(res, 200, { ok: false, ambiente: amb, ms: Date.now() - t0, mensaje: err.message }), true;
    }
  }
  return json(res, 404, { error: 'No encontrado' }), true;
}
