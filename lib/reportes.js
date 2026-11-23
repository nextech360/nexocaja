// NexoCaja · Formatos de envío de datos a la DGII: 607 (ventas) y 608 (NCF anulados).
// Archivos TXT delimitados por "|" con una línea de encabezado (RNC|Periodo|Cantidad)
// según la Norma General 07-2018. Siempre se recomienda pasarlos por la
// Herramienta de Pre-validación de la DGII antes de enviarlos por la Oficina Virtual.
import { can, HttpError } from './auth.js';
import { CONSUMO_ID_THRESHOLD, CANCEL_TYPES, onlyDigits } from './rd.js';

const amt = (c) => (c / 100).toFixed(2);
const ymd = (iso) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10).replace(/-/g, '');
};
const PAY_COL = { efectivo: 0, transferencia: 1, tarjeta: 2, credito: 3 }; // columnas 17–20

function readPeriod(searchParams) {
  const p = String(searchParams.get('period') || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(p) || +p.slice(4) < 1 || +p.slice(4) > 12) throw new HttpError(400, 'Elige el período (año y mes)');
  return p;
}

function emitterRnc(db) {
  const c = db.prepare('SELECT rnc FROM company WHERE id = 1').get();
  const rnc = c && c.rnc ? onlyDigits(c.rnc) : '';
  if (!rnc) throw new HttpError(409, 'Registra el RNC del negocio en Configuración fiscal para generar los formatos');
  return rnc;
}

function buyer(doc) {
  const n = onlyDigits(doc);
  if (n.length === 9) return [n, '1'];
  if (n.length === 11) return [n, '2'];
  return ['', ''];
}

function detailLine(r) {
  // 23 columnas del 607
  const pays = ['', '', '', ''];
  for (const [m, v] of Object.entries(r.pays)) if (v && PAY_COL[m] != null) pays[PAY_COL[m]] = amt(v);
  return [r.doc, r.docType, r.ncf, r.ncfModified || '', '01', r.date, '', amt(r.monto), amt(r.itbis),
    '', '', '', '', '', '', '', ...pays, '', '', ''].join('|');
}

export function build607(db, period) {
  const rnc = emitterRnc(db);
  const sales = db.prepare(`SELECT * FROM sales WHERE ncf IS NOT NULL AND status <> 'anulada'
                            AND strftime('%Y%m', paid_at, 'localtime') = ? ORDER BY paid_at, rowid`).all(period);
  const payQ = db.prepare('SELECT method, SUM(amount) AS a FROM sale_payments WHERE sale_id = ? GROUP BY method');
  const rows = [];
  const consumo = { count: 0, monto: 0, itbis: 0, total: 0 };
  const totals = { ventas: 0, ventasItbis: 0, notas: 0, notasItbis: 0 };
  for (const s of sales) {
    const monto = s.total - s.tax_total;
    totals.ventas += monto; totals.ventasItbis += s.tax_total;
    // Consumo (B02) por debajo de RD$250,000: va consolidado en el "Resumen de Facturas de Consumo".
    if (s.ncf_type === '02' && s.total < CONSUMO_ID_THRESHOLD) {
      consumo.count++; consumo.monto += monto; consumo.itbis += s.tax_total; consumo.total += s.total;
      continue;
    }
    const [doc, docType] = buyer(s.customer_doc);
    const pays = {};
    for (const p of payQ.all(s.id)) pays[p.method] = p.a;
    rows.push({ kind: 'venta', ncf: s.ncf, ncfModified: null, doc, docType, date: ymd(s.paid_at), monto, itbis: s.tax_total, total: s.total, pays, customer: s.customer_name });
  }
  const notes = db.prepare(`SELECT * FROM credit_notes WHERE ncf IS NOT NULL AND strftime('%Y%m', created_at, 'localtime') = ? ORDER BY created_at`).all(period);
  for (const n of notes) {
    totals.notas += n.subtotal; totals.notasItbis += n.tax_total;
    const [doc, docType] = buyer(n.customer_doc);
    rows.push({ kind: 'nota', ncf: n.ncf, ncfModified: n.ncf_modified, doc, docType, date: ymd(n.created_at), monto: n.subtotal, itbis: n.tax_total,
      total: n.total, pays: { [n.refund_method]: n.total }, customer: n.customer_name, itbisApplies: !!n.itbis_applies });
  }
  const lines = [`607|${rnc}|${period}|${rows.length}`, ...rows.map(detailLine)];
  return {
    format: '607', period, rnc, count: rows.length, rows, consumo, totals,
    net: { monto: totals.ventas - totals.notas, itbis: totals.ventasItbis - totals.notasItbis },
    fileName: `DGII_F_607_${rnc}_${period}.TXT`, txt: lines.join('\r\n') + '\r\n'
  };
}

export function build608(db, period) {
  const rnc = emitterRnc(db);
  const sales = db.prepare(`SELECT * FROM sales WHERE ncf IS NOT NULL AND status = 'anulada'
                            AND strftime('%Y%m', COALESCE(cancelled_at, paid_at), 'localtime') = ? ORDER BY cancelled_at, rowid`).all(period);
  const rows = sales.map((s) => ({ ncf: s.ncf, date: ymd(s.paid_at), type: s.cancel_type || '04', assumed: !s.cancel_type,
    typeName: CANCEL_TYPES[s.cancel_type || '04'], reason: s.cancel_reason, total: s.total }));
  const lines = [`608|${rnc}|${period}|${rows.length}`, ...rows.map((r) => [r.ncf, r.date, r.type].join('|'))];
  return { format: '608', period, rnc, count: rows.length, rows, fileName: `DGII_F_608_${rnc}_${period}.TXT`, txt: lines.join('\r\n') + '\r\n' };
}

/** /api/reports/607 y /api/reports/608 (?period=AAAAMM, &download=1 para bajar el TXT). */
export async function handleReports(req, res, pathname, searchParams, ctx) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[1] !== 'reports') return false;
  const { db, json, user } = ctx;
  if (!user) throw new HttpError(401, 'Inicia sesión');
  if (!can(user, 'reportes.ver')) throw new HttpError(403, 'Los reportes fiscales son para el supervisor o el dueño');
  if (req.method !== 'GET' || !['607', '608'].includes(parts[2])) return json(res, 404, { error: 'No encontrado' }), true;
  const period = readPeriod(searchParams);
  const r = parts[2] === '607' ? build607(db, period) : build608(db, period);
  if (searchParams.get('download')) {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${r.fileName}"`,
      'Cache-Control': 'no-store'
    });
    res.end(r.txt);
    return true;
  }
  return json(res, 200, r), true;
}
