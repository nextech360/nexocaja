/* NexoCaja · Ticket térmico (58 mm / 80 mm): factura NCF, e-CF, nota de crédito o recibo no fiscal.
   Una sola plantilla para imprimir y para la vista previa en pantalla. */
(function () {
  'use strict';
  var NX = window.NX;
  var e = function (v) { return NX.esc(v == null ? '' : v); };

  // ── Configuración del papel ────────────────────────────────────
  var PAPER = {
    '80': { page: '80mm', width: '72mm', font: '11px', big: '14px', qr: '34mm' },
    '58': { page: '58mm', width: '48mm', font: '9.5px', big: '12px', qr: '30mm' }
  };
  NX.ticketWidth = function () { var w = NX.info && String(NX.info.ticketAncho || '80'); return PAPER[w] ? w : '80'; };

  // ── Utilidades ────────────────────────────────────────────────
  var digits = function (v) { return String(v || '').replace(/\D/g, ''); };
  function fmtDoc(v) {
    var n = digits(v);
    if (n.length === 9) return n.slice(0, 1) + '-' + n.slice(1, 3) + '-' + n.slice(3, 8) + '-' + n.slice(8);
    if (n.length === 11) return n.slice(0, 3) + '-' + n.slice(3, 10) + '-' + n.slice(10);
    return String(v || '');
  }
  function docLabel(v) { return digits(v).length === 11 ? 'Cédula' : 'RNC'; }
  function fecha(v) {
    if (!v) return '';
    var s = String(v), d = new Date(/T/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return s;
    return d.toLocaleString('es-DO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  }
  var dmy = function (iso) { return iso ? String(iso).slice(0, 10).split('-').reverse().join('-') : ''; };
  var row = function (a, b, cls) { return '<div class="tk-row' + (cls ? ' ' + cls : '') + '"><span class="tk-l">' + a + '</span><span class="tk-r">' + b + '</span></div>'; };
  var line = function (t, cls) { return t ? '<div class="' + (cls || '') + '">' + t + '</div>' : ''; };
  var HR = '<hr class="tk-hr">';

  var NCF_TITLES = { '01': 'FACTURA DE CRÉDITO FISCAL', '02': 'FACTURA DE CONSUMO', '15': 'COMPROBANTE GUBERNAMENTAL', '04': 'NOTA DE CRÉDITO' };
  var LEYENDA = {
    '01': 'Comprobante válido para crédito fiscal', '31': 'Comprobante válido para crédito fiscal',
    '02': 'Comprobante fiscal de consumidor final', '32': 'Comprobante fiscal de consumidor final',
    '15': 'Comprobante fiscal gubernamental', '45': 'Comprobante fiscal gubernamental',
    '04': 'Nota de crédito fiscal', '34': 'Nota de crédito fiscal'
  };
  var METHOD = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito' };

  // ── Bloques ───────────────────────────────────────────────────
  function header() {
    var i = NX.info || {}, c = i.company || {};
    var trade = c.trade_name || c.legal_name || 'NexoCaja';
    var h = line(e(trade), 'tk-center tk-big');
    if (c.legal_name && c.legal_name !== trade) h += line(e(c.legal_name), 'tk-center');
    if (c.rnc) h += line('RNC: ' + e(fmtDoc(c.rnc)), 'tk-center tk-strong');
    if (c.branch) h += line('Sucursal: ' + e(c.branch), 'tk-center');
    if (i.direccion) h += line(e(i.direccion), 'tk-center');
    var contact = [i.telefono ? 'Tel. ' + e(i.telefono) : '', i.email ? e(i.email) : ''].filter(Boolean).join(' · ');
    if (contact) h += line(contact, 'tk-center');
    return h;
  }
  /** Tipo de comprobante y su número. */
  function fiscalBlock(doc) {
    var h = '';
    if (doc.ecf) {
      var x = doc.ecf;
      if (x.ambiente !== 'eCF') h += line('*** PRUEBA · SIN VALIDEZ FISCAL ***', 'tk-center tk-strong');
      h += line(e(String(x.tipoNombre || '').toUpperCase()), 'tk-center tk-big') + line('(e-CF ' + e(x.tipo) + ')', 'tk-center');
      h += row('e-NCF:', '<b>' + e(x.encf) + '</b>');
      if (x.venceSecuencia) h += row('Válido hasta:', e(dmy(x.venceSecuencia)));
      if (x.referencia) h += row('NCF modificado:', e(x.referencia));
      return h;
    }
    if (doc.ncf) {
      h += line(e(NCF_TITLES[doc.ncfType] || 'COMPROBANTE FISCAL'), 'tk-center tk-big');
      h += row('NCF:', '<b>' + e(doc.ncf) + '</b>');
      if (doc.ncfExpiresOn) h += row('Válido hasta:', e(dmy(doc.ncfExpiresOn)));
      if (doc.ncfModified) h += row('NCF modificado:', e(doc.ncfModified));
      return h;
    }
    return line(doc.isNote ? 'DEVOLUCIÓN' : 'RECIBO DE VENTA', 'tk-center tk-big');
  }
  function idBlock(doc) {
    var caja = (NX.info && NX.info.caja) || '';
    return row(e(doc.isNote ? 'Documento ' + doc.folio : 'Ticket ' + doc.folio), e(caja)) +
      (doc.isNote && doc.saleFolio ? row('Ticket original:', e(doc.saleFolio)) : '') +
      row('Fecha:', e(fecha(doc.when))) +
      (doc.cashier ? row('Cajero:', e(doc.cashier)) : '') +
      (doc.authorizedBy ? row('Autorizó:', e(doc.authorizedBy)) : '');
  }
  function customerBlock(doc) {
    var mustShow = doc.ncfType === '01' || doc.ncfType === '31';
    if (!doc.customerName && !doc.customerDoc && !mustShow) return '';
    return HR + line('Cliente: <b>' + e(doc.customerName || '') + '</b>') +
      (doc.customerDoc ? line(docLabel(doc.customerDoc) + ': ' + e(fmtDoc(doc.customerDoc))) : '');
  }
  function itemsBlock(lines) {
    return lines.map(function (l) {
      var exento = l.taxRate === 0 ? ' (E)' : '';
      return '<div class="tk-item">' + line(e(l.name) + exento, 'tk-name') +
        row(NX.qty(l.qty) + ' x ' + NX.money(l.unitPrice) + (l.priceType === 'mayoreo' ? ' MAY' : ''), NX.money(l.lineTotal + (l.discount || 0))) +
        (l.discount ? row('  Desc. ' + NX.qty(l.discountPct) + '%', '-' + NX.money(l.discount)) : '') + '</div>';
    }).join('');
  }
  function totalsBlock(doc) {
    var r = doc.byRate || {}, h = '';
    var g18 = r[18] || {}, g16 = r[16] || {}, ex = r[0] || {};
    var gross = doc.lines.reduce(function (a, l) { return a + l.lineTotal + (l.discount || 0); }, 0);
    h += row('Subtotal', NX.money(gross));
    if (doc.discountTotal) h += row('Descuentos', '-' + NX.money(doc.discountTotal));
    if (g18.base || g18.tax) h += row('Gravado 18%', NX.money(g18.base));
    if (g16.base || g16.tax) h += row('Gravado 16%', NX.money(g16.base));
    if (ex.base) h += row('Exento', NX.money(ex.base));
    if (g18.tax) h += row('ITBIS 18%', NX.money(g18.tax));
    if (g16.tax) h += row('ITBIS 16%', NX.money(g16.tax));
    h += row('Total ITBIS', NX.money(doc.taxTotal || 0));
    if (doc.tip) h += row('Propina legal (10%)', NX.money(doc.tip));
    h += row(doc.isNote ? 'TOTAL DEVUELTO' : 'TOTAL', NX.money(doc.total), 'tk-total');
    return h;
  }
  function paymentsBlock(doc) {
    if (doc.isNote) return row('Devuelto en:', e(METHOD[doc.refundMethod] || doc.refundMethod || ''));
    var p = doc.payments || [];
    if (!p.length) return '';
    var h = p.length > 1 ? line('Forma de pago: <b>Pago mixto</b>') : '';
    p.forEach(function (x) {
      var label = (METHOD[x.method] || x.method) + (x.reference ? ' (' + e(x.reference) + ')' : '');
      h += row(label, NX.money(x.method === 'efectivo' && x.received ? x.received : x.amount));
    });
    if (doc.change) h += row('Cambio', NX.money(doc.change), 'tk-strong');
    return h;
  }
  function footer(doc) {
    var h = '';
    var code = doc.ecf ? doc.ecf.tipo : doc.ncfType;
    if (doc.ecf || doc.ncf) {
      if (LEYENDA[code]) h += line(e(LEYENDA[code]), 'tk-center');
    } else {
      h += line('DOCUMENTO NO VÁLIDO COMO COMPROBANTE FISCAL', 'tk-center tk-strong');
    }
    if (doc.ecf) {
      var x = doc.ecf, qr = '';
      try { qr = NX.qrSvg ? NX.qrSvg(x.qrUrl, 132) : ''; } catch (err) { qr = ''; }
      h += '<div class="tk-qr">' + qr + '</div>' +
        row('Código de seguridad:', '<b>' + e(x.codigoSeguridad) + '</b>') +
        row('Fecha firma:', e(x.fechaFirma));
      if (x.contingencia) h += line('e-CF emitido en modalidad de Contingencia, el cual podrá ser consultado para su validez fiscal, a partir de las setenta y dos (72) horas.', 'tk-center tk-small');
    }
    return h;
  }

  /** Convierte una venta o una nota de crédito al formato común del ticket. */
  function normalize(src, isNote) {
    if (isNote) {
      return { isNote: true, folio: src.folio, saleFolio: src.saleFolio, when: src.createdAt, cashier: src.user, authorizedBy: src.authorizedBy,
        ncf: src.ncf, ncfType: src.ncf ? (src.ncf[0] === 'E' ? '34' : '04') : null, ncfExpiresOn: src.ncfExpiresOn, ncfModified: src.ncfModified, ecf: src.ecf,
        customerName: src.customerName, customerDoc: src.customerDoc,
        lines: src.lines.map(function (l) { return { name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, taxRate: l.taxRate, discount: 0 }; }),
        byRate: (function () { var r = {}; src.lines.forEach(function (l) { var t = r[l.taxRate] || (r[l.taxRate] = { base: 0, tax: 0 }); t.base += l.lineTotal - l.tax; t.tax += l.tax; }); return r; })(),
        taxTotal: src.taxTotal, total: src.total, refundMethod: src.refundMethod, reason: src.reason, itbisApplies: src.itbisApplies, status: 'pagada' };
    }
    return { isNote: false, folio: src.folio, when: src.paidAt || src.createdAt, cashier: src.cashier, ncf: src.ncf, ncfType: src.ncfType,
      ncfExpiresOn: src.ncfExpiresOn, ecf: src.ecf, customerName: src.customerName, customerDoc: src.customerDoc, lines: src.lines, byRate: src.byRate,
      discountTotal: src.discountTotal, taxTotal: src.taxTotal, total: src.total, tip: src.tip || 0, payments: src.payments, change: src.change, status: src.status };
  }

  NX.ticketHtml = function (src, isNote) {
    var d = normalize(src, isNote);
    var h = '';
    if (d.status === 'anulada') h += line('*** VENTA ANULADA ***', 'tk-center tk-big');
    h += header() + HR + fiscalBlock(d) + HR + idBlock(d) + customerBlock(d) + HR + itemsBlock(d.lines) + HR + totalsBlock(d);
    var pay = paymentsBlock(d);
    if (pay) h += HR + pay;
    if (d.isNote) {
      if (!d.itbisApplies) h += line('Emitida después de 30 días de la factura: no rebaja el ITBIS.', 'tk-small');
      h += line('Motivo: ' + e(d.reason));
    }
    h += HR + footer(d);
    if (d.isNote) h += HR + line('Firma del cliente: ______________', 'tk-center');
    else h += line('¡Gracias por su compra!', 'tk-center');
    h += line('NexoCaja · NexTech360', 'tk-center tk-brand');
    return h;
  };

  // ── Impresión ─────────────────────────────────────────────────
  function applyPaper(el, w) {
    var p = PAPER[w];
    el.className = 'tk tk-' + w;
    el.style.setProperty('--tk-width', p.width);
    el.style.setProperty('--tk-font', p.font);
    el.style.setProperty('--tk-big', p.big);
    el.style.setProperty('--tk-qr', p.qr);
    var st = document.getElementById('tk-page');
    if (!st) { st = document.createElement('style'); st.id = 'tk-page'; document.head.appendChild(st); }
    st.textContent = '@media print { @page { size: ' + p.page + ' auto; margin: ' + (w === '58' ? '2mm' : '3mm') + '; } }';
  }
  function print(html) {
    var area = NX.$('print-area');
    applyPaper(area, NX.ticketWidth());
    area.innerHTML = html;
    setTimeout(function () { window.print(); }, 50);
  }
  NX.printSale = function (sale) { print(NX.ticketHtml(sale, false)); };
  NX.printCreditNote = function (note) { print(NX.ticketHtml(note, true)); };

  // ── Vista previa en pantalla ──────────────────────────────────
  NX.previewTicket = function (src, isNote, width) {
    var w = width || NX.ticketWidth();
    var m = NX.modal({
      title: 'Vista previa del ticket · ' + w + ' mm',
      html: '<div class="nx-modal-body tk-preview-wrap"><div class="tk-paper" data-paper></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cerrar</button><button type="button" class="nx-btn nx-btn--primary" data-p>Imprimir</button></div>'
    });
    var paper = m.el.querySelector('[data-paper]');
    applyPaper(paper, w);
    paper.innerHTML = NX.ticketHtml(src, isNote);
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-p]').onclick = function () { m.close(); (isNote ? NX.printCreditNote : NX.printSale)(src); };
  };

  /** Venta de ejemplo para la vista previa cuando aún no hay ventas. */
  NX.sampleSale = function () {
    return { folio: 'T-000000', paidAt: new Date().toISOString(), cashier: (NX.user && NX.user.name) || 'Cajero', ncf: null, ncfType: null, status: 'pagada',
      customerName: null, customerDoc: null, discountTotal: 2000, taxTotal: 7322, total: 48000, change: 2000,
      byRate: { 18: { base: 40678, tax: 7322 }, 16: { base: 0, tax: 0 }, 0: { base: 0, tax: 0 } },
      lines: [{ name: 'ACEITE VEGETAL 32 OZ', qty: 1, unitPrice: 28000, lineTotal: 28000, taxRate: 18, discount: 0 },
        { name: 'CERVEZA 12 OZ', qty: 2, unitPrice: 11000, lineTotal: 20000, taxRate: 18, discount: 2000, discountPct: 9.09 }],
      payments: [{ method: 'efectivo', amount: 48000, received: 50000 }] };
  };
})();
