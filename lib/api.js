// NexoCaja · API de productos, ventas e inventario.
// Todos los montos viajan y se guardan en CENTAVOS (enteros). El servidor recalcula
// precios, ITBIS y totales: nunca confía en los montos que manda el navegador.
import crypto from 'node:crypto';
import { can, requirePermOrPin, audit, HttpError } from './auth.js';
import { prepareFiscal, takeNcf } from './fiscal.js';
import { formatDoc, CANCEL_TYPES } from './rd.js';

const TAX_RATES = [0, 16, 18];
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];

const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

function toInt(v, field, { min = 0, max = 1e12 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} no es válido`);
  return n;
}
function toNum(v, field, { min = 0, max = 1e9 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} no es válido`);
  return n;
}
export function text(v, field, { max = 200, required = false } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `Falta ${field}`);
  if (s.length > max) throw new HttpError(400, `${field} es muy largo`);
  return s;
}

/** Desglose de ITBIS de un monto que YA incluye el impuesto. */
export function splitTax(totalCents, rate) {
  if (!rate) return { base: totalCents, tax: 0 };
  const base = Math.round((totalCents * 100) / (100 + rate));
  return { base, tax: totalCents - base };
}

function productRow(p) {
  if (!p) return null;
  return {
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, unit: p.unit,
    cost: p.cost, price: p.price, wholesalePrice: p.wholesale_price, wholesaleMinQty: p.wholesale_min_qty,
    taxRate: p.tax_rate, stock: p.stock, minStock: p.min_stock, trackStock: !!p.track_stock,
    low: !!p.track_stock && p.stock <= p.min_stock, out: !!p.track_stock && p.stock <= 0
  };
}

// ── Productos ─────────────────────────────────────────────────────
function listProducts(db, q, limit) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    return db.prepare(`SELECT * FROM products WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode LIKE ? ESCAPE '\\')
                       ORDER BY (barcode = ? OR sku = ?) DESC, name LIMIT ?`).all(like, like, like, q, q, lim).map(productRow);
  }
  return db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name LIMIT ?').all(lim).map(productRow);
}

function findByCode(db, code) {
  return productRow(db.prepare('SELECT * FROM products WHERE active = 1 AND (barcode = ? OR sku = ?) LIMIT 1').get(code, code));
}

function readProductInput(body) {
  const p = {
    barcode: text(body.barcode, 'el código de barras', { max: 64 }) || null,
    sku: text(body.sku, 'el código interno', { max: 64 }),
    name: text(body.name, 'el nombre', { max: 120, required: true }).toUpperCase(),
    unit: text(body.unit, 'la unidad', { max: 20 }) || 'unidad',
    cost: toInt(body.cost ?? 0, 'El costo'),
    price: toInt(body.price, 'El precio', { min: 1 }),
    wholesalePrice: body.wholesalePrice == null || body.wholesalePrice === '' ? null : toInt(body.wholesalePrice, 'El precio de mayoreo', { min: 1 }),
    wholesaleMinQty: body.wholesaleMinQty == null || body.wholesaleMinQty === '' ? null : toNum(body.wholesaleMinQty, 'La cantidad de mayoreo'),
    taxRate: toInt(body.taxRate ?? 18, 'El ITBIS'),
    stock: toNum(body.stock ?? 0, 'La existencia', { min: -1e9 }),
    minStock: toNum(body.minStock ?? 0, 'El mínimo'),
    trackStock: body.trackStock !== false
  };
  if (!TAX_RATES.includes(p.taxRate)) throw new HttpError(400, 'El ITBIS debe ser 18, 16 o 0 (exento)');
  return p;
}

function nextSku(db) {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(sku, 3) AS INTEGER)) AS n FROM products WHERE sku LIKE 'P-%'").get();
  return `P-${String((row.n || 0) + 1).padStart(4, '0')}`;
}

function assertUniqueCodes(db, p, exceptId = '') {
  if (p.barcode) {
    const dup = db.prepare('SELECT name FROM products WHERE (barcode = ? OR sku = ?) AND id <> ? AND active = 1').get(p.barcode, p.barcode, exceptId);
    if (dup) throw new HttpError(409, `El código ${p.barcode} ya lo usa ${dup.name}`);
  }
  if (p.sku) {
    const dup = db.prepare('SELECT name FROM products WHERE (sku = ? OR barcode = ?) AND id <> ?').get(p.sku, p.sku, exceptId);
    if (dup) throw new HttpError(409, `El código interno ${p.sku} ya lo usa ${dup.name}`);
  }
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createProduct(db, body, uid) {
  const p = readProductInput(body);
  return tx(db, () => {
    if (!p.sku) p.sku = nextSku(db);
    assertUniqueCodes(db, p);
    const pid = id('p');
    db.prepare(`INSERT INTO products (id, sku, barcode, name, department_id, unit, cost, price, wholesale_price, wholesale_min_qty,
                tax_rate, stock, min_stock, track_stock) VALUES (?, ?, ?, ?, 'dep-general', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pid, p.sku, p.barcode, p.name, p.unit, p.cost, p.price, p.wholesalePrice, p.wholesaleMinQty, p.taxRate, p.stock, p.minStock, p.trackStock ? 1 : 0);
    if (p.stock) {
      db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, user_id, note) VALUES (?, ?, 'entrada', ?, ?, 'Existencia inicial')`)
        .run(id('m'), pid, p.stock, uid);
    }
    return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
  });
}

function updateProduct(db, pid, body, uid) {
  const old = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(pid);
  if (!old) throw new HttpError(404, 'Producto no encontrado');
  const p = readProductInput({ ...body, sku: body.sku || old.sku });
  return tx(db, () => {
    assertUniqueCodes(db, p, pid);
    db.prepare(`UPDATE products SET sku = ?, barcode = ?, name = ?, unit = ?, cost = ?, price = ?, wholesale_price = ?, wholesale_min_qty = ?,
                tax_rate = ?, stock = ?, min_stock = ?, track_stock = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(p.sku, p.barcode, p.name, p.unit, p.cost, p.price, p.wholesalePrice, p.wholesaleMinQty, p.taxRate, p.stock, p.minStock, p.trackStock ? 1 : 0, pid);
    const diff = p.stock - old.stock;
    if (diff) {
      db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, user_id, note) VALUES (?, ?, 'ajuste', ?, ?, 'Ajuste desde Productos')`)
        .run(id('m'), pid, diff, uid);
    }
    if (old.price !== p.price || old.cost !== p.cost) {
      db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, 'precio.modificar', 'product', ?, ?)`)
        .run(uid, pid, JSON.stringify({ antes: { price: old.price, cost: old.cost }, despues: { price: p.price, cost: p.cost } }));
    }
    return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
  });
}

function deleteProduct(db, pid, uid) {
  const r = db.prepare("UPDATE products SET active = 0, barcode = NULL, updated_at = datetime('now') WHERE id = ? AND active = 1").run(pid);
  if (!r.changes) throw new HttpError(404, 'Producto no encontrado');
  db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?, 'producto.eliminar', 'product', ?)`).run(uid, pid);
  return { ok: true };
}

const DEMO = [
  ['7460000000011', 'CAFE MOLIDO 453 G', 39500, 37000, 28000, 18, 24, 10],
  ['7460000000028', 'LECHE ENTERA 1 L', 9800, 9200, 7400, 0, 6, 12],
  ['7460000000035', 'ARROZ SELECTO 5 LB', 21000, 19800, 16500, 0, 40, 15],
  ['7460000000042', 'SALAMI 1 LB', 18500, 17500, 13000, 18, 3, 8],
  ['7460000000059', 'CERVEZA 12 OZ', 12000, 10500, 8500, 18, 96, 24],
  ['7460000000066', 'AGUA 20 OZ', 2500, 2000, 1200, 18, 120, 30],
  ['7460000000073', 'PAN SOBAO X6', 7500, 7000, 5000, 0, 18, 10],
  ['7460000000080', 'QUESO DE FREIR 1 LB', 23000, 21500, 17000, 16, 14, 6],
  ['7460000000097', 'REFRESCO 2 L', 13000, 11800, 9000, 18, 30, 12],
  ['7460000000103', 'ACEITE VEGETAL 32 OZ', 28000, 26500, 21000, 18, 22, 8]
];

function seedDemo(db, uid) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n;
  if (n) throw new HttpError(409, 'Ya tienes productos; los de ejemplo solo se cargan con el catálogo vacío.');
  for (const [barcode, name, price, wholesalePrice, cost, taxRate, stock, minStock] of DEMO) {
    createProduct(db, { barcode, name, price, wholesalePrice, wholesaleMinQty: 6, cost, taxRate, stock, minStock }, uid);
  }
  return { ok: true, count: DEMO.length };
}

// ── Ventas ────────────────────────────────────────────────────────
/** Recalcula una venta completa con los precios de la BD. No escribe nada. */
export function priceSale(db, body) {
  if (!Array.isArray(body.lines) || !body.lines.length) throw new HttpError(400, 'La venta no tiene artículos');
  if (body.lines.length > 500) throw new HttpError(400, 'Demasiados artículos en una venta');
  const wholesale = !!body.wholesale;
  const lines = body.lines.map((l, i) => {
    const qty = toNum(l.qty, `La cantidad de la línea ${i + 1}`, { min: 0.001, max: 100000 });
    const discountPct = toNum(l.discountPct ?? 0, `El descuento de la línea ${i + 1}`, { max: 100 });
    let name, unitPrice, taxRate, unitCost, productId = null, priceType = 'normal', product = null;
    if (l.productId) {
      product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(String(l.productId));
      if (!product) throw new HttpError(409, `Un producto del ticket ya no existe (línea ${i + 1})`);
      productId = product.id;
      name = product.name;
      taxRate = product.tax_rate;
      unitCost = product.cost;
      const useWholesale = product.wholesale_price && (wholesale || (product.wholesale_min_qty && qty >= product.wholesale_min_qty));
      unitPrice = useWholesale ? product.wholesale_price : product.price;
      priceType = useWholesale ? 'mayoreo' : 'normal';
    } else {
      // Artículo común / varios
      name = text(l.name, `el nombre de la línea ${i + 1}`, { max: 120, required: true }).toUpperCase();
      unitPrice = toInt(l.unitPrice, `El precio de la línea ${i + 1}`, { min: 1 });
      taxRate = toInt(l.taxRate ?? 18, `El ITBIS de la línea ${i + 1}`);
      if (!TAX_RATES.includes(taxRate)) throw new HttpError(400, 'ITBIS inválido');
      unitCost = 0;
      priceType = 'manual';
    }
    const gross = Math.round(unitPrice * qty);
    const discount = Math.round((gross * discountPct) / 100);
    const lineTotal = gross - discount;
    const { base, tax } = splitTax(lineTotal, taxRate);
    return { productId, name, qty, unitPrice, priceType, discountPct, discount, taxRate, tax, base, unitCost, lineTotal, product };
  });

  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const byRate = { 18: { base: 0, tax: 0 }, 16: { base: 0, tax: 0 }, 0: { base: 0, tax: 0 } };
  for (const l of lines) { byRate[l.taxRate].base += l.base; byRate[l.taxRate].tax += l.tax; }
  return {
    lines,
    total,
    subtotal: lines.reduce((s, l) => s + l.base, 0),
    taxTotal: lines.reduce((s, l) => s + l.tax, 0),
    discountTotal: lines.reduce((s, l) => s + l.discount, 0),
    costTotal: lines.reduce((s, l) => s + Math.round(l.unitCost * l.qty), 0),
    byRate
  };
}

function readPayments(body, total) {
  if (!Array.isArray(body.payments) || !body.payments.length) throw new HttpError(400, 'Falta la forma de pago');
  const payments = body.payments.map((p, i) => {
    const method = String(p.method || '');
    if (!METHODS.includes(method)) throw new HttpError(400, `Forma de pago inválida (${i + 1})`);
    const amount = toInt(p.amount, `El monto del pago ${i + 1}`);
    const received = method === 'efectivo' && p.received != null ? toInt(p.received, 'El efectivo recibido') : null;
    return { method, amount, received, reference: text(p.reference, 'la referencia', { max: 60 }) || null };
  }).filter((p) => p.amount > 0 || p.method === 'efectivo');

  const nonCash = payments.filter((p) => p.method !== 'efectivo').reduce((s, p) => s + p.amount, 0);
  if (nonCash > total) throw new HttpError(400, 'Lo cobrado con tarjeta o transferencia es mayor que el total');
  const cash = payments.find((p) => p.method === 'efectivo');
  const cashDue = total - nonCash;
  let change = 0;
  if (cashDue > 0) {
    if (!cash) throw new HttpError(400, `Falta cobrar ${cashDue / 100}`);
    const received = cash.received ?? cash.amount;
    if (received < cashDue) throw new HttpError(400, 'El efectivo recibido no alcanza');
    cash.amount = cashDue;
    cash.received = received;
    change = received - cashDue;
  } else if (cash) {
    payments.splice(payments.indexOf(cash), 1);
  }
  return { payments, change, paid: total + change };
}


function createSale(db, body, user, shiftId) {
  const priced = priceSale(db, body);
  const fiscal = prepareFiscal(db, body, priced.total);
  const { payments, change, paid } = readPayments(body, priced.total);
  let customer = fiscal ? fiscal.customer : null;
  if (!customer && body.customerId) customer = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(String(body.customerId)) || null;
  const saleId = id('s');
  return tx(db, () => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'folio'").run();
    const n = db.prepare("SELECT value FROM counters WHERE name = 'folio'").get().value;
    const folio = `T-${String(n).padStart(6, '0')}`;
    const nc = fiscal ? takeNcf(db, fiscal.typeCode) : null;
    db.prepare(`INSERT INTO sales (id, folio, ncf_type, ncf, ncf_expires_on, status, customer_id, customer_name, customer_doc, shift_id, user_id,
                subtotal, tax_total, discount_total, total, paid, change_given, cost_total, paid_at)
                VALUES (?, ?, ?, ?, ?, 'pagada', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saleId, folio, fiscal ? fiscal.typeCode : null, nc ? nc.ncf : null, nc ? nc.expiresOn : null,
        customer ? customer.id : null, customer ? customer.name : null, customer && customer.doc_number ? formatDoc(customer.doc_type, customer.doc_number) : null,
        shiftId, user.id, priced.subtotal, priced.taxTotal, priced.discountTotal, priced.total, paid, change, priced.costTotal, now());
    const insLine = db.prepare(`INSERT INTO sale_lines (id, sale_id, product_id, name_snapshot, qty, unit_price, price_type, discount_pct, discount,
                                tax_rate, tax, unit_cost, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insMove = db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, ref_id, user_id) VALUES (?, ?, 'venta', ?, ?, ?)`);
    const decStock = db.prepare("UPDATE products SET stock = stock - ?, updated_at = datetime('now') WHERE id = ? AND track_stock = 1");
    for (const l of priced.lines) {
      insLine.run(id('l'), saleId, l.productId, l.name, l.qty, l.unitPrice, l.priceType, l.discountPct, l.discount, l.taxRate, l.tax, l.unitCost, l.lineTotal);
      if (l.productId) {
        decStock.run(l.qty, l.productId);
        insMove.run(id('m'), l.productId, -l.qty, saleId, user.id);
      }
    }
    const insPay = db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, received, reference) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of payments) insPay.run(id('pay'), saleId, p.method, p.amount, p.received, p.reference);
    return getSale(db, saleId);
  });
}

export function getSale(db, saleId) {
  const s = db.prepare(`SELECT s.*, u.full_name AS cashier, c.full_name AS canceller FROM sales s
                        LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users c ON c.id = s.cancelled_by WHERE s.id = ?`).get(saleId);
  if (!s) throw new HttpError(404, 'Venta no encontrada');
  const lines = db.prepare(`SELECT l.*, COALESCE((SELECT SUM(c.qty) FROM credit_note_lines c WHERE c.sale_line_id = l.id), 0) AS returned_qty
                            FROM sale_lines l WHERE l.sale_id = ? ORDER BY l.rowid`).all(saleId);
  const notes = db.prepare('SELECT id, folio, ncf, total, refund_method, created_at FROM credit_notes WHERE sale_id = ? ORDER BY created_at').all(saleId);
  const payments = db.prepare('SELECT method, amount, received, reference FROM sale_payments WHERE sale_id = ? ORDER BY rowid').all(saleId);
  const byRate = { 18: { base: 0, tax: 0 }, 16: { base: 0, tax: 0 }, 0: { base: 0, tax: 0 } };
  for (const l of lines) {
    const t = byRate[l.tax_rate] || (byRate[l.tax_rate] = { base: 0, tax: 0 });
    t.base += l.line_total - l.tax; t.tax += l.tax;
  }
  return {
    id: s.id, folio: s.folio, status: s.status, createdAt: s.created_at, paidAt: s.paid_at, shiftId: s.shift_id,
    ncf: s.ncf, ncfType: s.ncf_type, ncfExpiresOn: s.ncf_expires_on, customerName: s.customer_name, customerDoc: s.customer_doc,
    cashier: s.cashier, cancelReason: s.cancel_reason, cancelType: s.cancel_type, cancelledBy: s.canceller, cancelledAt: s.cancelled_at,
    subtotal: s.subtotal, taxTotal: s.tax_total, discountTotal: s.discount_total, total: s.total, paid: s.paid, change: s.change_given,
    byRate,
    creditNotes: notes.map((n) => ({ id: n.id, folio: n.folio, ncf: n.ncf, total: n.total, refundMethod: n.refund_method, createdAt: n.created_at })),
    returnedTotal: notes.reduce((a, n) => a + n.total, 0),
    lines: lines.map((l) => ({ id: l.id, returnedQty: l.returned_qty, name: l.name_snapshot, qty: l.qty, unitPrice: l.unit_price, priceType: l.price_type, discountPct: l.discount_pct,
      discount: l.discount, taxRate: l.tax_rate, tax: l.tax, lineTotal: l.line_total })),
    payments
  };
}

function listSales(db, shiftId) {
  const rows = shiftId
    ? db.prepare(`SELECT s.id, s.folio, s.ncf, s.customer_name, s.status, s.total, s.paid_at, u.full_name AS cashier FROM sales s LEFT JOIN users u ON u.id = s.user_id
                  WHERE s.shift_id = ? ORDER BY s.paid_at DESC, s.rowid DESC`).all(shiftId)
    : db.prepare(`SELECT s.id, s.folio, s.ncf, s.customer_name, s.status, s.total, s.paid_at, u.full_name AS cashier FROM sales s LEFT JOIN users u ON u.id = s.user_id
                  WHERE date(s.paid_at, 'localtime') = date('now', 'localtime') ORDER BY s.paid_at DESC, s.rowid DESC`).all();
  const pay = db.prepare('SELECT method FROM sale_payments WHERE sale_id = ? ORDER BY rowid');
  const ret = db.prepare('SELECT COALESCE(SUM(total), 0) AS t FROM credit_notes WHERE sale_id = ?');
  return rows.map((r) => ({ id: r.id, folio: r.folio, ncf: r.ncf, customer: r.customer_name, status: r.status, total: r.total, paidAt: r.paid_at, cashier: r.cashier,
    returned: ret.get(r.id).t,
    methods: [...new Set(pay.all(r.id).map((p) => p.method))] }));
}

async function cancelSale(db, saleId, body, user, ip) {
  const reason = text(body.reason, 'el motivo', { max: 200, required: true });
  const authBy = await requirePermOrPin(db, user, 'ventas.anular', body.authPin);
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!s) throw new HttpError(404, 'Venta no encontrada');
  if (s.status !== 'pagada') throw new HttpError(409, 'Esa venta ya estaba anulada');
  if (db.prepare('SELECT 1 FROM credit_notes WHERE sale_id = ?').get(saleId)) throw new HttpError(409, 'Esa venta ya tiene devoluciones (nota de crédito); no se puede anular');
  let cancelType = null;
  if (s.ncf) {
    cancelType = String(body.cancelType || '');
    if (!CANCEL_TYPES[cancelType]) throw new HttpError(400, 'Elige el tipo de anulación del comprobante (se reporta en el formato 608)');
  }
  const shift = s.shift_id ? db.prepare('SELECT status FROM cash_shifts WHERE id = ?').get(s.shift_id) : null;
  if (!shift || shift.status !== 'abierta') throw new HttpError(409, 'Solo se pueden anular ventas del turno abierto');
  const authorizer = authBy ? authBy.id : user.id;
  tx(db, () => {
    db.prepare("UPDATE sales SET status = 'anulada', cancel_reason = ?, cancel_type = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?").run(reason, cancelType, authorizer, now(), saleId);
    const lines = db.prepare('SELECT product_id, qty FROM sale_lines WHERE sale_id = ? AND product_id IS NOT NULL').all(saleId);
    const inc = db.prepare("UPDATE products SET stock = stock + ?, updated_at = datetime('now') WHERE id = ? AND track_stock = 1");
    const mv = db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, ref_id, user_id, note) VALUES (?, ?, 'devolucion', ?, ?, ?, 'Venta anulada')`);
    for (const l of lines) { inc.run(l.qty, l.product_id); mv.run(id('m'), l.product_id, l.qty, saleId, user.id); }
    audit(db, user.id, 'venta.anular', { authorizedBy: authBy ? authBy.id : null, entity: 'sale', entityId: saleId, detail: { folio: s.folio, ncf: s.ncf, total: s.total, motivo: reason, tipo608: cancelType }, ip });
  });
  return getSale(db, saleId);
}

// ── Turnos / corte de caja ────────────────────────────────────────
export function openShift(db, registerId) {
  return db.prepare("SELECT * FROM cash_shifts WHERE register_id = ? AND status = 'abierta' ORDER BY opened_at DESC LIMIT 1").get(registerId) || null;
}

export function shiftSummary(db, shiftId, withProfit) {
  const sh = db.prepare(`SELECT c.*, uo.full_name AS opened_name, uc.full_name AS closed_name FROM cash_shifts c
                         LEFT JOIN users uo ON uo.id = c.opened_by LEFT JOIN users uc ON uc.id = c.closed_by WHERE c.id = ?`).get(shiftId);
  if (!sh) throw new HttpError(404, 'Turno no encontrado');
  const sales = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(subtotal),0) AS subtotal,
                            COALESCE(SUM(tax_total),0) AS tax, COALESCE(SUM(cost_total),0) AS cost, COALESCE(SUM(discount_total),0) AS discount
                            FROM sales WHERE shift_id = ? AND status = 'pagada'`).get(shiftId);
  const cancelled = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sales WHERE shift_id = ? AND status = 'anulada'`).get(shiftId);
  const methods = { efectivo: 0, tarjeta: 0, transferencia: 0, credito: 0 };
  for (const r of db.prepare(`SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
                               WHERE s.shift_id = ? AND s.status = 'pagada' GROUP BY p.method`).all(shiftId)) methods[r.method] = r.amount;
  const moves = db.prepare(`SELECT m.type, m.amount, m.reason, m.created_at, u.full_name AS user FROM cash_movements m
                            LEFT JOIN users u ON u.id = m.user_id WHERE m.shift_id = ? ORDER BY m.created_at`).all(shiftId);
  const entradas = moves.filter((m) => m.type === 'entrada').reduce((a, m) => a + m.amount, 0);
  const salidas = moves.filter((m) => m.type === 'salida').reduce((a, m) => a + m.amount, 0);
  const refunds = { count: 0, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0 };
  for (const r of db.prepare('SELECT refund_method AS m, COUNT(*) AS n, SUM(total) AS t FROM credit_notes WHERE shift_id = ? GROUP BY refund_method').all(shiftId)) {
    refunds[r.m] = r.t; refunds.count += r.n; refunds.total += r.t;
  }
  const refundMargin = db.prepare(`SELECT COALESCE(SUM(l.line_total - l.tax - CAST(ROUND(l.unit_cost * l.qty) AS INTEGER)), 0) AS m
                                   FROM credit_note_lines l JOIN credit_notes n ON n.id = l.credit_note_id WHERE n.shift_id = ?`).get(shiftId).m;
  const expected = sh.opening_float + methods.efectivo + entradas - salidas - refunds.efectivo;
  const byCashier = db.prepare(`SELECT u.full_name AS name, COUNT(*) AS n, SUM(s.total) AS total FROM sales s LEFT JOIN users u ON u.id = s.user_id
                                WHERE s.shift_id = ? AND s.status = 'pagada' GROUP BY s.user_id ORDER BY total DESC`).all(shiftId);
  return {
    id: sh.id, registerId: sh.register_id, status: sh.status,
    openedAt: sh.opened_at, openedBy: sh.opened_name, closedAt: sh.closed_at, closedBy: sh.closed_name,
    openingFloat: sh.opening_float, salesCount: sales.n, salesTotal: sales.total, taxTotal: sales.tax, discountTotal: sales.discount,
    cancelledCount: cancelled.n, cancelledTotal: cancelled.total, refunds, methods, entradas, salidas, moves, byCashier,
    expectedCash: sh.status === 'cerrada' ? sh.expected_cash : expected,
    countedCash: sh.counted_cash, difference: sh.counted_cash == null ? null : sh.counted_cash - sh.expected_cash,
    notes: sh.notes,
    profit: withProfit ? sales.subtotal - sales.cost - refundMargin : undefined
  };
}

function todaySummary(db, registerId) {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM sales
                          WHERE status = 'pagada' AND date(paid_at, 'localtime') = date('now', 'localtime')`).get();
  const last = db.prepare("SELECT id FROM sales WHERE status = 'pagada' ORDER BY paid_at DESC, rowid DESC LIMIT 1").get();
  const sh = openShift(db, registerId);
  return { count: row.n, total: row.total, lastSale: last ? getSale(db, last.id) : null, shift: sh ? { id: sh.id, openedAt: sh.opened_at, openingFloat: sh.opening_float } : null };
}

// ── Enrutador ─────────────────────────────────────────────────────
/**
 * Atiende /api/products/*, /api/sales/* y /api/shift/*. Devuelve true si la ruta era suya.
 * ctx: { db, json, readJson, state, user, registerId, ip }
 */
export async function handleApi(req, res, pathname, searchParams, ctx) {
  const { db, json, user } = ctx;
  const parts = pathname.split('/').filter(Boolean);
  const area = parts[1];
  if (!['products', 'sales', 'shift'].includes(area)) return false;
  if (!user) throw new HttpError(401, 'Inicia sesión');
  const need = (perm) => { if (!can(user, perm)) throw new HttpError(403, 'No tienes permiso para esto'); };
  const hideCost = (p) => (can(user, 'costos.ver') ? p : { ...p, cost: null });

  if (area === 'products') {
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, listProducts(db, (searchParams.get('q') || '').trim(), searchParams.get('limit')).map(hideCost)), true;
    if (req.method === 'GET' && parts[2] === 'code' && parts[3]) {
      const p = findByCode(db, decodeURIComponent(parts[3]));
      return json(res, p ? 200 : 404, p ? hideCost(p) : { error: 'No existe ese código' }), true;
    }
    need('productos.editar');
    if (req.method === 'POST' && parts.length === 2) return json(res, 201, createProduct(db, await ctx.readJson(req), user.id)), true;
    if (req.method === 'POST' && parts[2] === 'demo') return json(res, 200, seedDemo(db, user.id)), true;
    if (req.method === 'PUT' && parts[2]) return json(res, 200, updateProduct(db, parts[2], await ctx.readJson(req), user.id)), true;
    if (req.method === 'DELETE' && parts[2]) return json(res, 200, deleteProduct(db, parts[2], user.id)), true;
  }

  if (area === 'sales') {
    if (req.method === 'POST' && parts[2] === 'quote') return json(res, 200, stripProducts(priceSale(db, await ctx.readJson(req)))), true;
    if (req.method === 'POST' && parts.length === 2) {
      need('vender');
      const sh = openShift(db, ctx.registerId);
      if (!sh) throw new HttpError(409, 'La caja está cerrada. Ábrela con el fondo inicial para poder cobrar.');
      ctx.state.busy++;
      try {
        return json(res, 201, createSale(db, await ctx.readJson(req), user, sh.id)), true;
      } finally {
        ctx.state.busy--;
      }
    }
    if (req.method === 'GET' && parts[2] === 'today') return json(res, 200, todaySummary(db, ctx.registerId)), true;
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, listSales(db, searchParams.get('shift') || null)), true;
    if (req.method === 'POST' && parts[2] && parts[3] === 'cancel') return json(res, 200, await cancelSale(db, parts[2], await ctx.readJson(req), user, ctx.ip)), true;
    if (req.method === 'GET' && parts[2]) return json(res, 200, getSale(db, parts[2])), true;
  }

  if (area === 'shift') {
    const withProfit = can(user, 'costos.ver');
    if (req.method === 'GET' && parts[2] === 'current') {
      const sh = openShift(db, ctx.registerId);
      return json(res, 200, { registerId: ctx.registerId, shift: sh ? shiftSummary(db, sh.id, withProfit) : null }), true;
    }
    if (req.method === 'GET' && parts[2] === 'history') {
      const rows = db.prepare(`SELECT id FROM cash_shifts WHERE register_id = ? AND status = 'cerrada' ORDER BY closed_at DESC LIMIT 20`).all(ctx.registerId);
      return json(res, 200, rows.map((r) => shiftSummary(db, r.id, withProfit))), true;
    }
    if (req.method === 'POST' && parts[2] === 'open') {
      need('caja.abrir');
      const body = await ctx.readJson(req);
      const float = toInt(body.openingFloat ?? 0, 'El fondo inicial', { max: 1e10 });
      const shiftId = tx(db, () => {
        if (openShift(db, ctx.registerId)) throw new HttpError(409, 'La caja ya está abierta');
        const sid = id('sh');
        db.prepare('INSERT INTO cash_shifts (id, register_id, opened_by, opened_at, opening_float) VALUES (?, ?, ?, ?, ?)').run(sid, ctx.registerId, user.id, now(), float);
        audit(db, user.id, 'caja.abrir', { entity: 'shift', entityId: sid, detail: { fondo: float, caja: ctx.registerId }, ip: ctx.ip });
        return sid;
      });
      return json(res, 201, shiftSummary(db, shiftId, withProfit)), true;
    }
    if (req.method === 'POST' && parts[2] === 'move') {
      const body = await ctx.readJson(req);
      const type = body.type === 'salida' ? 'salida' : body.type === 'entrada' ? 'entrada' : null;
      if (!type) throw new HttpError(400, 'Tipo de movimiento inválido');
      const amount = toInt(body.amount, 'El monto', { min: 1, max: 1e10 });
      const reason = text(body.reason, 'el motivo', { max: 120, required: true });
      const authBy = await requirePermOrPin(db, user, `caja.${type}`, body.authPin);
      const sh = openShift(db, ctx.registerId);
      if (!sh) throw new HttpError(409, 'La caja está cerrada');
      if (type === 'salida') {
        const s = shiftSummary(db, sh.id, false);
        if (amount > s.expectedCash) throw new HttpError(409, `No hay tanto efectivo en caja (hay ${(s.expectedCash / 100).toFixed(2)})`);
      }
      const mid = id('cm');
      db.prepare('INSERT INTO cash_movements (id, shift_id, type, amount, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(mid, sh.id, type, amount, reason, user.id, now());
      audit(db, user.id, `caja.${type}`, { authorizedBy: authBy ? authBy.id : null, entity: 'shift', entityId: sh.id, detail: { monto: amount, motivo: reason }, ip: ctx.ip });
      return json(res, 201, shiftSummary(db, sh.id, withProfit)), true;
    }
    if (req.method === 'POST' && parts[2] === 'close') {
      need('caja.cerrar');
      const body = await ctx.readJson(req);
      const counted = toInt(body.countedCash, 'El efectivo contado', { max: 1e10 });
      const notes = text(body.notes, 'la nota', { max: 300 }) || null;
      const sh = openShift(db, ctx.registerId);
      if (!sh) throw new HttpError(409, 'La caja ya está cerrada');
      if (ctx.state.busy > 0) throw new HttpError(409, 'Hay un cobro en proceso; espera un momento');
      const s = shiftSummary(db, sh.id, false);
      db.prepare("UPDATE cash_shifts SET status = 'cerrada', closed_by = ?, closed_at = ?, expected_cash = ?, counted_cash = ?, notes = ? WHERE id = ?")
        .run(user.id, now(), s.expectedCash, counted, notes, sh.id);
      audit(db, user.id, 'caja.cerrar', { entity: 'shift', entityId: sh.id, detail: { esperado: s.expectedCash, contado: counted, diferencia: counted - s.expectedCash }, ip: ctx.ip });
      return json(res, 200, shiftSummary(db, sh.id, withProfit)), true;
    }
    if (req.method === 'GET' && parts[2]) return json(res, 200, shiftSummary(db, parts[2], withProfit)), true;
  }
  return json(res, 404, { error: 'No encontrado' }), true;
}

function stripProducts(priced) {
  return { ...priced, lines: priced.lines.map(({ product, ...l }) => l) };
}
