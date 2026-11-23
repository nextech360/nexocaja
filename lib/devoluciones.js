// NexoCaja · Devoluciones con nota de crédito (B04).
// Una devolución nunca borra ni cambia la factura original: crea un documento nuevo
// (NC-000001 y, si la venta tenía NCF, un NCF B04 con el "NCF modificado").
import crypto from 'node:crypto';
import { can, requirePermOrPin, audit, HttpError } from './auth.js';
import { getSale, openShift, shiftSummary, tx, text } from './api.js';
import { takeNcf } from './fiscal.js';
import { NC_ITBIS_DAYS } from './rd.js';

const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();
const REFUND = ['efectivo', 'tarjeta', 'transferencia'];
const EPS = 1e-9;

/** Fecha local AAAA-MM-DD de un ISO. */
const localDay = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
export const daysSince = (iso) => Math.round((new Date(localDay(now()) + 'T00:00:00') - new Date(localDay(iso) + 'T00:00:00')) / 86400000);

function noteRow(db, n) {
  const lines = db.prepare('SELECT * FROM credit_note_lines WHERE credit_note_id = ? ORDER BY rowid').all(n.id);
  const sale = db.prepare('SELECT folio, paid_at FROM sales WHERE id = ?').get(n.sale_id) || {};
  const users = db.prepare('SELECT id, full_name FROM users WHERE id IN (?, ?)').all(n.user_id, n.authorized_by || '');
  const name = (uid) => (users.find((u) => u.id === uid) || {}).full_name || null;
  return {
    id: n.id, folio: n.folio, saleId: n.sale_id, saleFolio: sale.folio, saleDate: sale.paid_at,
    ncf: n.ncf, ncfModified: n.ncf_modified, ncfExpiresOn: n.ncf_expires_on,
    customerName: n.customer_name, customerDoc: n.customer_doc, reason: n.reason, refundMethod: n.refund_method,
    restock: !!n.restock, itbisApplies: !!n.itbis_applies, subtotal: n.subtotal, taxTotal: n.tax_total, total: n.total,
    createdAt: n.created_at, user: name(n.user_id), authorizedBy: name(n.authorized_by),
    lines: lines.map((l) => ({ name: l.name_snapshot, qty: l.qty, unitPrice: l.unit_price, taxRate: l.tax_rate, tax: n.itbis_applies ? l.tax : 0, lineTotal: l.line_total }))
  };
}

export function getNote(db, nid) {
  const n = db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(nid);
  if (!n) throw new HttpError(404, 'Nota de crédito no encontrada');
  return noteRow(db, n);
}

function listNotes(db, q) {
  const s = String(q || '').trim().toUpperCase();
  const rows = s
    ? db.prepare(`SELECT n.* FROM credit_notes n JOIN sales v ON v.id = n.sale_id
                  WHERE UPPER(n.folio) = ? OR UPPER(n.ncf) = ? OR UPPER(n.ncf_modified) = ? OR UPPER(v.folio) = ? ORDER BY n.created_at DESC LIMIT 50`).all(s, s, s, s)
    : db.prepare('SELECT * FROM credit_notes ORDER BY created_at DESC LIMIT 50').all();
  return rows.map((n) => ({ id: n.id, folio: n.folio, ncf: n.ncf, ncfModified: n.ncf_modified, customerName: n.customer_name,
    total: n.total, refundMethod: n.refund_method, itbisApplies: !!n.itbis_applies, createdAt: n.created_at,
    saleFolio: (db.prepare('SELECT folio FROM sales WHERE id = ?').get(n.sale_id) || {}).folio }));
}

/** Busca la venta por ticket (T-000123 o 123) o por NCF. */
function findSale(db, q) {
  let s = String(q || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) throw new HttpError(400, 'Escribe el número de ticket o el NCF');
  if (/^\d{1,6}$/.test(s)) s = `T-${s.padStart(6, '0')}`;
  if (/^T\d+$/.test(s)) s = `T-${s.slice(1).padStart(6, '0')}`;
  const row = db.prepare('SELECT id FROM sales WHERE UPPER(folio) = ? OR UPPER(ncf) = ?').get(s, s);
  if (!row) throw new HttpError(404, `No encontré ninguna venta con «${q}»`);
  const sale = getSale(db, row.id);
  const days = daysSince(sale.paidAt || sale.createdAt);
  return { ...sale, daysSince: days, itbisApplies: days <= NC_ITBIS_DAYS, itbisDays: NC_ITBIS_DAYS };
}

async function createNote(db, body, user, ctx) {
  const reason = text(body.reason, 'el motivo de la devolución', { max: 200, required: true });
  const refundMethod = REFUND.includes(body.refundMethod) ? body.refundMethod : null;
  if (!refundMethod) throw new HttpError(400, 'Elige cómo se le devuelve el dinero al cliente');
  const restock = body.restock !== false;
  const authBy = await requirePermOrPin(db, user, 'ventas.devolver', body.authPin);

  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(String(body.saleId || ''));
  if (!sale) throw new HttpError(404, 'Venta no encontrada');
  if (sale.status !== 'pagada') throw new HttpError(409, 'Esa venta está anulada; no se puede devolver');
  const req = Array.isArray(body.lines) ? body.lines : [];
  if (!req.length) throw new HttpError(400, 'Marca al menos un producto para devolver');

  const getLine = db.prepare('SELECT * FROM sale_lines WHERE id = ? AND sale_id = ?');
  const done = db.prepare('SELECT COALESCE(SUM(qty),0) AS q, COALESCE(SUM(line_total),0) AS t, COALESCE(SUM(tax),0) AS x FROM credit_note_lines WHERE sale_line_id = ?');
  const seen = new Set();
  const out = [];
  for (const r of req) {
    const lid = String(r.lineId || '');
    if (seen.has(lid)) throw new HttpError(400, 'Un producto está repetido en la devolución');
    seen.add(lid);
    const l = getLine.get(lid, sale.id);
    if (!l) throw new HttpError(400, 'Ese producto no es de esta venta');
    const qty = Number(r.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const prev = done.get(lid);
    const avail = l.qty - prev.q;
    if (qty > avail + EPS) throw new HttpError(409, `De «${l.name_snapshot}» solo quedan ${+avail.toFixed(3)} por devolver`);
    const all = Math.abs(qty - avail) < EPS;
    const lineTotal = all ? l.line_total - prev.t : Math.round((l.line_total * qty) / l.qty);
    const tax = all ? l.tax - prev.x : Math.round((l.tax * qty) / l.qty);
    out.push({ l, qty: all ? avail : qty, lineTotal, tax });
  }
  if (!out.length) throw new HttpError(400, 'Escribe la cantidad a devolver');

  const total = out.reduce((a, x) => a + x.lineTotal, 0);
  if (total <= 0) throw new HttpError(400, 'El monto a devolver es cero');
  const realTax = out.reduce((a, x) => a + x.tax, 0);
  const days = daysSince(sale.paid_at || sale.created_at);
  const itbisApplies = days <= NC_ITBIS_DAYS;
  const taxTotal = itbisApplies ? realTax : 0;
  const cost = out.reduce((a, x) => a + Math.round(x.l.unit_cost * x.qty), 0);

  const sh = openShift(db, ctx.registerId);
  if (refundMethod === 'efectivo') {
    if (!sh) throw new HttpError(409, 'Para devolver en efectivo la caja tiene que estar abierta');
    const s = shiftSummary(db, sh.id, false);
    if (total > s.expectedCash) throw new HttpError(409, `No hay suficiente efectivo en caja para devolver ${(total / 100).toFixed(2)} (hay ${(s.expectedCash / 100).toFixed(2)})`);
  }

  const nid = id('nc');
  tx(db, () => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'folio_nc'").run();
    const n = db.prepare("SELECT value FROM counters WHERE name = 'folio_nc'").get().value;
    const folio = `NC-${String(n).padStart(6, '0')}`;
    const nc = sale.ncf ? takeNcf(db, '04') : null;
    db.prepare(`INSERT INTO credit_notes (id, folio, sale_id, ncf, ncf_modified, ncf_expires_on, customer_name, customer_doc, reason, refund_method,
                restock, itbis_applies, subtotal, tax_total, total, cost_total, shift_id, user_id, authorized_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nid, folio, sale.id, nc ? nc.ncf : null, sale.ncf || null, nc ? nc.expiresOn : null, sale.customer_name, sale.customer_doc, reason, refundMethod,
        restock ? 1 : 0, itbisApplies ? 1 : 0, total - taxTotal, taxTotal, total, cost, sh ? sh.id : null, user.id, authBy ? authBy.id : null, now());
    const insL = db.prepare(`INSERT INTO credit_note_lines (id, credit_note_id, sale_line_id, product_id, name_snapshot, qty, unit_price, tax_rate, tax, line_total, unit_cost)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const inc = db.prepare("UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ? AND track_stock = 1");
    const mv = db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, ref_id, user_id, note) VALUES (?, ?, 'devolucion', ?, ?, ?, ?)`);
    for (const x of out) {
      insL.run(id('ncl'), nid, x.l.id, x.l.product_id, x.l.name_snapshot, x.qty, x.l.unit_price, x.l.tax_rate, x.tax, x.lineTotal, x.l.unit_cost);
      if (restock && x.l.product_id) { inc.run(x.qty, x.l.product_id); mv.run(id('m'), x.l.product_id, x.qty, nid, user.id, `Devolución ${folio}`); }
    }
    audit(db, user.id, 'nc.emitir', { authorizedBy: authBy ? authBy.id : null, entity: 'credit_note', entityId: nid,
      detail: { folio, ncf: nc ? nc.ncf : null, ncfModificado: sale.ncf, venta: sale.folio, total, itbis: taxTotal, reembolso: refundMethod, inventario: restock, motivo: reason }, ip: ctx.ip });
  });
  return getNote(db, nid);
}

/** /api/returns/* — devoluciones y notas de crédito. */
export async function handleReturns(req, res, pathname, searchParams, ctx) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[1] !== 'returns') return false;
  const { db, json, user } = ctx;
  if (!user) throw new HttpError(401, 'Inicia sesión');
  if (req.method === 'GET' && parts.length === 2) return json(res, 200, listNotes(db, searchParams.get('q'))), true;
  if (req.method === 'GET' && parts[2] === 'find') return json(res, 200, findSale(db, searchParams.get('q'))), true;
  if (req.method === 'POST' && parts.length === 2) {
    if (!can(user, 'vender')) throw new HttpError(403, 'No tienes permiso para esto');
    ctx.state.busy++;
    try { return json(res, 201, await createNote(db, await ctx.readJson(req), user, ctx)), true; } finally { ctx.state.busy--; }
  }
  if (req.method === 'GET' && parts[2]) return json(res, 200, getNote(db, parts[2])), true;
  return json(res, 404, { error: 'No encontrado' }), true;
}
