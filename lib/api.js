// NexoCaja · API de productos, ventas e inventario.
// Todos los montos viajan y se guardan en CENTAVOS (enteros). El servidor recalcula
// precios, ITBIS y totales: nunca confía en los montos que manda el navegador.
import crypto from 'node:crypto';

const USER_ID = 'u-admin'; // hasta que llegue el login (1.2.0)
const TAX_RATES = [0, 16, 18];
const METHODS = ['efectivo', 'tarjeta', 'transferencia'];

const id = (p) => `${p}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
function text(v, field, { max = 200, required = false } = {}) {
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

function tx(db, fn) {
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

function createProduct(db, body) {
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
        .run(id('m'), pid, p.stock, USER_ID);
    }
    return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
  });
}

function updateProduct(db, pid, body) {
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
        .run(id('m'), pid, diff, USER_ID);
    }
    if (old.price !== p.price || old.cost !== p.cost) {
      db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?, 'precio.modificar', 'product', ?, ?)`)
        .run(USER_ID, pid, JSON.stringify({ antes: { price: old.price, cost: old.cost }, despues: { price: p.price, cost: p.cost } }));
    }
    return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
  });
}

function deleteProduct(db, pid) {
  const r = db.prepare("UPDATE products SET active = 0, barcode = NULL, updated_at = datetime('now') WHERE id = ? AND active = 1").run(pid);
  if (!r.changes) throw new HttpError(404, 'Producto no encontrado');
  db.prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?, 'producto.eliminar', 'product', ?)`).run(USER_ID, pid);
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

function seedDemo(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n;
  if (n) throw new HttpError(409, 'Ya tienes productos; los de ejemplo solo se cargan con el catálogo vacío.');
  for (const [barcode, name, price, wholesalePrice, cost, taxRate, stock, minStock] of DEMO) {
    createProduct(db, { barcode, name, price, wholesalePrice, wholesaleMinQty: 6, cost, taxRate, stock, minStock });
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

function createSale(db, body) {
  const priced = priceSale(db, body);
  const { payments, change, paid } = readPayments(body, priced.total);
  const saleId = id('s');
  return tx(db, () => {
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'folio'").run();
    const n = db.prepare("SELECT value FROM counters WHERE name = 'folio'").get().value;
    const folio = `T-${String(n).padStart(6, '0')}`;
    db.prepare(`INSERT INTO sales (id, folio, status, user_id, subtotal, tax_total, discount_total, total, paid, change_given, cost_total, paid_at)
                VALUES (?, ?, 'pagada', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saleId, folio, USER_ID, priced.subtotal, priced.taxTotal, priced.discountTotal, priced.total, paid, change, priced.costTotal, now());
    const insLine = db.prepare(`INSERT INTO sale_lines (id, sale_id, product_id, name_snapshot, qty, unit_price, price_type, discount_pct, discount,
                                tax_rate, tax, unit_cost, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insMove = db.prepare(`INSERT INTO stock_movements (id, product_id, type, qty, ref_id, user_id) VALUES (?, ?, 'venta', ?, ?, ?)`);
    const decStock = db.prepare("UPDATE products SET stock = stock - ?, updated_at = datetime('now') WHERE id = ? AND track_stock = 1");
    for (const l of priced.lines) {
      insLine.run(id('l'), saleId, l.productId, l.name, l.qty, l.unitPrice, l.priceType, l.discountPct, l.discount, l.taxRate, l.tax, l.unitCost, l.lineTotal);
      if (l.productId) {
        decStock.run(l.qty, l.productId);
        insMove.run(id('m'), l.productId, -l.qty, saleId, USER_ID);
      }
    }
    const insPay = db.prepare('INSERT INTO sale_payments (id, sale_id, method, amount, received, reference) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of payments) insPay.run(id('pay'), saleId, p.method, p.amount, p.received, p.reference);
    return getSale(db, saleId);
  });
}

function getSale(db, saleId) {
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!s) throw new HttpError(404, 'Venta no encontrada');
  const lines = db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY rowid').all(saleId);
  const payments = db.prepare('SELECT method, amount, received, reference FROM sale_payments WHERE sale_id = ? ORDER BY rowid').all(saleId);
  const byRate = { 18: { base: 0, tax: 0 }, 16: { base: 0, tax: 0 }, 0: { base: 0, tax: 0 } };
  for (const l of lines) {
    const t = byRate[l.tax_rate] || (byRate[l.tax_rate] = { base: 0, tax: 0 });
    t.base += l.line_total - l.tax; t.tax += l.tax;
  }
  return {
    id: s.id, folio: s.folio, status: s.status, createdAt: s.created_at, paidAt: s.paid_at,
    subtotal: s.subtotal, taxTotal: s.tax_total, discountTotal: s.discount_total, total: s.total, paid: s.paid, change: s.change_given,
    byRate,
    lines: lines.map((l) => ({ name: l.name_snapshot, qty: l.qty, unitPrice: l.unit_price, priceType: l.price_type, discountPct: l.discount_pct,
      discount: l.discount, taxRate: l.tax_rate, tax: l.tax, lineTotal: l.line_total })),
    payments
  };
}

function todaySummary(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM sales
                          WHERE status = 'pagada' AND date(paid_at, 'localtime') = date('now', 'localtime')`).get();
  const byMethod = db.prepare(`SELECT p.method, SUM(p.amount) AS amount FROM sale_payments p JOIN sales s ON s.id = p.sale_id
                               WHERE s.status = 'pagada' AND date(s.paid_at, 'localtime') = date('now', 'localtime') GROUP BY p.method`).all();
  const last = db.prepare("SELECT id FROM sales WHERE status = 'pagada' ORDER BY paid_at DESC, rowid DESC LIMIT 1").get();
  return { count: row.n, total: row.total, byMethod, lastSale: last ? getSale(db, last.id) : null };
}

// ── Enrutador ─────────────────────────────────────────────────────
/**
 * Atiende /api/products/* y /api/sales/*. Devuelve true si la ruta era suya.
 * ctx: { db, json, readJson, state, isLocal }
 */
export async function handleApi(req, res, pathname, searchParams, ctx) {
  const { db, json } = ctx;
  const parts = pathname.split('/').filter(Boolean); // ['api','products',...]
  if (parts[1] !== 'products' && parts[1] !== 'sales') return false;
  try {
    if (parts[1] === 'products') {
      if (req.method === 'GET' && parts.length === 2) return json(res, 200, listProducts(db, (searchParams.get('q') || '').trim(), searchParams.get('limit'))), true;
      if (req.method === 'GET' && parts[2] === 'code' && parts[3]) {
        const p = findByCode(db, decodeURIComponent(parts[3]));
        return json(res, p ? 200 : 404, p || { error: 'No existe ese código' }), true;
      }
      if (req.method === 'POST' && parts.length === 2) return json(res, 201, createProduct(db, await ctx.readJson(req))), true;
      if (req.method === 'POST' && parts[2] === 'demo') return json(res, 200, seedDemo(db)), true;
      if (req.method === 'PUT' && parts[2]) return json(res, 200, updateProduct(db, parts[2], await ctx.readJson(req))), true;
      if (req.method === 'DELETE' && parts[2]) return json(res, 200, deleteProduct(db, parts[2])), true;
    }
    if (parts[1] === 'sales') {
      if (req.method === 'POST' && parts[2] === 'quote') return json(res, 200, stripProducts(priceSale(db, await ctx.readJson(req)))), true;
      if (req.method === 'POST' && parts.length === 2) {
        ctx.state.busy++;
        try {
          return json(res, 201, createSale(db, await ctx.readJson(req))), true;
        } finally {
          ctx.state.busy--;
        }
      }
      if (req.method === 'GET' && parts[2] === 'today') return json(res, 200, todaySummary(db)), true;
      if (req.method === 'GET' && parts[2]) return json(res, 200, getSale(db, parts[2])), true;
    }
    return json(res, 404, { error: 'No encontrado' }), true;
  } catch (err) {
    if (err instanceof HttpError) return json(res, err.status, { error: err.message }), true;
    throw err;
  }
}

function stripProducts(priced) {
  return { ...priced, lines: priced.lines.map(({ product, ...l }) => l) };
}
