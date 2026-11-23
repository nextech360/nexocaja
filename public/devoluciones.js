/* NexoCaja · Devoluciones con nota de crédito (B04). */
(function () {
  'use strict';
  var NX = window.NX;
  var REFUND = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };
  var root = null;

  // ── Nota de crédito 80 mm ──────────────────────────────────────
  NX.printCreditNote = function (n) {
    var c = (NX.info && NX.info.company) || {};
    var row = function (a, b) { return '<div class="tk-row"><span>' + a + '</span><span>' + b + '</span></div>'; };
    var h = '<div class="tk-center tk-big">' + NX.esc(c.trade_name || 'NexoCaja') + '</div>';
    if (c.legal_name && c.legal_name !== c.trade_name) h += '<div class="tk-center">' + NX.esc(c.legal_name) + '</div>';
    if (c.rnc) h += '<div class="tk-center">RNC: ' + NX.esc(c.rnc) + '</div>';
    if (NX.info && NX.info.direccion) h += '<div class="tk-center">' + NX.esc(NX.info.direccion) + '</div>';
    if (n.ecf) h += '<hr class="tk-hr">' + NX.ecfHeader(n.ecf);
    else h += '<hr class="tk-hr"><div class="tk-center tk-big">' + (n.ncf ? 'NOTA DE CRÉDITO' : 'DEVOLUCIÓN') + '</div>';
    if (n.ncf && !n.ecf) {
      h += row('NCF:', NX.esc(n.ncf)) + (n.ncfExpiresOn ? row('Válido hasta:', NX.esc(n.ncfExpiresOn.split('-').reverse().join('/'))) : '');
      if (n.ncfModified) h += row('NCF modificado:', NX.esc(n.ncfModified));
    }
    h += row('Documento:', NX.esc(n.folio)) + row('Ticket original:', NX.esc(n.saleFolio || ''));
    if (n.customerName) h += '<div>Cliente: ' + NX.esc(n.customerName) + '</div>' + (n.customerDoc ? '<div>RNC/Céd.: ' + NX.esc(n.customerDoc) + '</div>' : '');
    h += '<div>' + NX.esc(NX.date(n.createdAt)) + '</div><div>Le atendió: ' + NX.esc(n.user || '') + '</div>' +
      (n.authorizedBy ? '<div>Autorizó: ' + NX.esc(n.authorizedBy) + '</div>' : '') + '<hr class="tk-hr">';
    n.lines.forEach(function (l) {
      h += '<div class="tk-item"><div>' + NX.esc(l.name) + '</div>' + row(NX.qty(l.qty) + ' x ' + NX.money(l.unitPrice), NX.money(l.lineTotal)) + '</div>';
    });
    h += '<hr class="tk-hr">' + row('Monto sin ITBIS', NX.money(n.subtotal)) + row('ITBIS', NX.money(n.taxTotal)) +
      '<div class="tk-row tk-total"><span>TOTAL DEVUELTO</span><span>' + NX.money(n.total) + '</span></div>' +
      row('Devuelto en', REFUND[n.refundMethod] || n.refundMethod);
    if (!n.itbisApplies) h += '<div style="margin-top:4px">Emitida después de 30 días de la factura: no rebaja el ITBIS.</div>';
    h += '<div style="margin-top:4px">Motivo: ' + NX.esc(n.reason) + '</div>' + (n.ecf ? NX.ecfFooter(n.ecf) : '') + '<hr class="tk-hr">' +
      '<div class="tk-center">Firma del cliente: ____________________</div>';
    if (!n.ncf) h += '<div class="tk-center">DOCUMENTO NO VÁLIDO COMO COMPROBANTE FISCAL</div>';
    h += '<div class="tk-center" style="margin-top:4px">NexoCaja · NexTech360</div>';
    NX.$('print-area').innerHTML = h;
    setTimeout(function () { window.print(); }, 50);
  };

  // ── Diálogo de devolución ──────────────────────────────────────
  NX.openReturn = function (sale, after) {
    var lines = sale.lines.filter(function (l) { return l.qty - l.returnedQty > 1e-9; });
    if (!lines.length) { NX.toast('Esa venta ya se devolvió completa', true); return; }
    var fiscal = !!sale.ncf;
    var m = NX.modal({
      title: 'Devolución del ticket ' + sale.folio, wide: true,
      html: '<div class="nx-modal-body">' +
        '<div class="nx-muted" style="font-size:13px">' + NX.esc(NX.date(sale.paidAt)) + (sale.ncf ? ' · NCF ' + NX.esc(sale.ncf) : '') + (sale.customerName ? ' · ' + NX.esc(sale.customerName) : '') + ' · Total ' + NX.money(sale.total) + '</div>' +
        (fiscal ? (sale.itbisApplies
          ? '<div class="nx-result nx-result--info" style="font-size:13px">Se emitirá una Nota de Crédito (' + (sale.ncf[0] === 'E' ? 'E34 electrónica' : 'B04') + ') que modifica el ' + (sale.ncf[0] === 'E' ? 'e-NCF ' : 'NCF ') + NX.esc(sale.ncf) + '. Han pasado ' + sale.daysSince + ' día(s): la nota rebaja el ITBIS.</div>'
          : '<div class="nx-result nx-result--warn" style="font-size:13px">Han pasado ' + sale.daysSince + ' días desde la factura (más de ' + sale.itbisDays + '): la Nota de Crédito se emite sin ITBIS, así que no rebaja el impuesto ya declarado.</div>')
          : '<div class="nx-result nx-result--info" style="font-size:13px">Esta venta no tiene NCF: se hará una devolución interna (sin comprobante fiscal).</div>') +
        '<div class="nx-tablebox" style="max-height:300px"><table class="nx-table"><thead><tr><th>Producto</th><th class="r">Vendido</th><th class="r">Ya devuelto</th><th class="r">Precio</th><th class="r" style="width:180px">A devolver</th><th class="r">Importe</th></tr></thead><tbody>' +
        lines.map(function (l) {
          var left = +(l.qty - l.returnedQty).toFixed(3);
          return '<tr data-id="' + NX.esc(l.id) + '"><td>' + NX.esc(l.name) + '</td><td class="r num">' + NX.qty(l.qty) + '</td><td class="r num">' + NX.qty(l.returnedQty) + '</td>' +
            '<td class="r num">' + NX.money(l.unitPrice) + '</td><td class="r" style="white-space:nowrap"><input class="num" data-q inputmode="decimal" style="width:80px;text-align:right" value="0" data-max="' + left + '"> ' +
            '<button type="button" class="nx-btn nx-btn--sm" data-all title="Devolver las ' + NX.qty(left) + '">Todo</button></td><td class="r num" data-amt>$0.00</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="nx-form">' +
        '<div class="nx-field"><label for="dv-method">Devolver el dinero en</label><select id="dv-method"><option value="efectivo">Efectivo (sale de la caja)</option><option value="tarjeta">Reverso a la tarjeta</option><option value="transferencia">Transferencia</option></select></div>' +
        '<div class="nx-field"><label for="dv-reason">Motivo</label><input id="dv-reason" maxlength="200" placeholder="Ej. producto dañado"></div>' +
        '<label class="nx-check full"><input type="checkbox" id="dv-stock" checked> Regresar los productos al inventario (desmárcalo si vienen dañados)</label>' +
        '</div>' +
        '<div class="nx-result nx-result--ok"><span>Total a devolver</span><b data-total>$0.00</b></div>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — ' + (fiscal ? 'Emitir nota de crédito' : 'Registrar devolución') + '</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter' && !e.target.closest('button')) { e.preventDefault(); ok(close); } }
    });
    var el = m.el;
    function calc() {
      var total = 0;
      el.querySelectorAll('tbody tr').forEach(function (tr) {
        var l = lines.find(function (x) { return x.id === tr.getAttribute('data-id'); });
        var q = parseFloat(String(tr.querySelector('[data-q]').value).replace(',', '.')) || 0;
        var left = l.qty - l.returnedQty;
        var a = q <= 0 ? 0 : Math.abs(q - left) < 1e-9 ? Math.round(l.lineTotal * left / l.qty) : Math.round(l.lineTotal * q / l.qty);
        tr.querySelector('[data-amt]').textContent = NX.money(a);
        tr.classList.toggle('is-bad', q > left + 1e-9);
        total += a;
      });
      el.querySelector('[data-total]').textContent = NX.money(total);
      return total;
    }
    el.querySelector('tbody').addEventListener('input', calc);
    el.querySelector('tbody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-all]'); if (!b) return;
      var inp = b.closest('tr').querySelector('[data-q]'); inp.value = inp.getAttribute('data-max'); calc();
    });
    var first = el.querySelector('[data-q]'); if (first) { first.focus(); first.select(); }
    function ok(close) {
      var err = el.querySelector('[data-err]'); err.hidden = true;
      var req = [];
      var bad = false;
      el.querySelectorAll('tbody tr').forEach(function (tr) {
        var q = parseFloat(String(tr.querySelector('[data-q]').value).replace(',', '.')) || 0;
        if (q > +tr.querySelector('[data-q]').getAttribute('data-max') + 1e-9) bad = true;
        if (q > 0) req.push({ lineId: tr.getAttribute('data-id'), qty: q });
      });
      var reason = el.querySelector('#dv-reason').value.trim();
      if (bad) { err.textContent = 'Hay una cantidad mayor a la que se puede devolver.'; err.hidden = false; return; }
      if (!req.length) { err.textContent = 'Escribe cuánto se devuelve de al menos un producto (o pulsa «Todo»).'; err.hidden = false; return; }
      if (!reason) { err.textContent = 'Escribe el motivo de la devolución.'; err.hidden = false; el.querySelector('#dv-reason').focus(); return; }
      var body = { saleId: sale.id, lines: req, reason: reason, refundMethod: el.querySelector('#dv-method').value, restock: el.querySelector('#dv-stock').checked };
      NX.askSupervisorPin('ventas.devolver', 'Hacer una devolución').then(function (pin) {
        body.authPin = pin || undefined;
        return NX.api('POST', '/api/returns', body);
      }).then(function (n) {
        close();
        NX.toast((n.ncf ? 'Nota de crédito ' + n.ncf : 'Devolución ' + n.folio) + ' · ' + NX.money(n.total) + ' en ' + (REFUND[n.refundMethod] || '').toLowerCase());
        NX.printCreditNote(n);
        if (NX.loadFiscalStatus) NX.loadFiscalStatus().catch(function () {});
        NX.refreshFooter();
        if (after) after(n);
      }).catch(function (x) { if (x.message !== 'cancelado') { err.textContent = x.message; err.hidden = false; } });
    }
    el.querySelector('[data-x]').onclick = m.close;
    el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
    calc();
  };

  NX.startReturn = function (q, after) {
    return NX.api('GET', '/api/returns/find?q=' + encodeURIComponent(q)).then(function (s) {
      if (s.status === 'anulada') { NX.toast('El ticket ' + s.folio + ' está anulado; no se puede devolver', true); return; }
      NX.openReturn(s, after);
    });
  };

  // ── Vista: Devoluciones ────────────────────────────────────────
  function load(q) {
    if (!root) return;
    NX.api('GET', '/api/returns' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (rows) {
      if (!root) return;
      root.querySelector('[data-empty]').hidden = rows.length > 0;
      root.querySelector('tbody').innerHTML = rows.map(function (n) {
        return '<tr data-id="' + NX.esc(n.id) + '"><td class="num">' + NX.esc(n.folio) + '</td><td class="num">' + NX.esc(n.ncf || '—') + '</td><td class="num">' + NX.esc(n.ncfModified || n.saleFolio || '') + '</td>' +
          '<td>' + NX.esc(n.customerName || 'Consumidor final') + '</td><td>' + NX.esc(NX.date(n.createdAt)) + '</td><td>' + (REFUND[n.refundMethod] || n.refundMethod) + '</td>' +
          '<td class="r num">' + NX.money(n.total) + (n.itbisApplies ? '' : ' <span class="nx-tag" title="Emitida después de 30 días">sin ITBIS</span>') + '</td>' +
          '<td class="r"><button type="button" class="nx-btn nx-btn--sm" data-print>Reimprimir</button></td></tr>';
      }).join('');
    }).catch(function (x) { NX.toast(x.message, true); });
  }
  NX.register('devoluciones', {
    mount: function (el) {
      root = el;
      el.innerHTML = '<div class="nx-page"><div class="nx-page-head"><h1>Devoluciones</h1>' +
        '<form data-find style="display:flex;gap:6px;flex:1 1 380px;max-width:520px"><input class="nx-search" id="dv-q" placeholder="Ticket (T-000123 o 123) o NCF de la factura…" aria-label="Ticket o NCF de la venta" style="max-width:none">' +
        '<button class="nx-btn nx-btn--primary" type="submit">Devolver</button></form>' +
        '<span class="nx-spacer"></span><input class="nx-search" type="search" data-filter placeholder="Filtrar: NC, B04 o ticket" style="max-width:240px" aria-label="Filtrar notas de crédito"></div>' +
        '<div class="nx-page-body"><p class="nx-muted" style="margin:0 0 8px;font-size:13px">Busca la venta por su ticket o NCF y marca lo que el cliente devuelve. Si la venta tenía NCF se emite una Nota de Crédito B04 (necesitas una secuencia B04 registrada en Configuración fiscal). La factura original nunca se modifica.</p>' +
        '<div class="nx-tablebox"><table class="nx-table" style="min-width:860px"><thead><tr><th>Documento</th><th>NCF (B04)</th><th>Modifica</th><th>Cliente</th><th>Fecha</th><th>Devuelto en</th><th class="r">Total</th><th></th></tr></thead><tbody></tbody></table>' +
        '<div class="nx-empty" data-empty hidden>Todavía no hay devoluciones.</div></div></div></div>';
      var q = el.querySelector('#dv-q');
      el.querySelector('[data-find]').addEventListener('submit', function (e) {
        e.preventDefault();
        if (!q.value.trim()) { q.focus(); return; }
        NX.startReturn(q.value.trim(), function () { q.value = ''; load(''); }).catch(function (x) { NX.toast(x.message, true); });
      });
      var t, f = el.querySelector('[data-filter]');
      f.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { load(f.value.trim()); }, 250); });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]');
        if (tr && e.target.closest('[data-print]')) NX.api('GET', '/api/returns/' + encodeURIComponent(tr.getAttribute('data-id'))).then(NX.printCreditNote);
      });
      load(''); q.focus();
    },
    unmount: function () { root = null; }
  });
})();
