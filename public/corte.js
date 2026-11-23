/* NexoCaja · Turnos y corte de caja: apertura, entradas/salidas, arqueo y cierre. */
(function () {
  'use strict';
  var NX = window.NX;
  var root = null;

  // ── Abrir caja (también lo usa la pantalla de Ventas) ─────────
  NX.openShiftDialog = function (after) {
    var m = NX.modal({
      title: 'Abrir caja',
      html: '<div class="nx-modal-body"><p style="margin:0">Cuenta el efectivo con el que empiezas el turno (fondo de caja para dar cambio).</p>' +
        '<div class="nx-field"><label for="op-float">Fondo inicial en efectivo</label><input id="op-float" class="nx-amount-input" inputmode="decimal" placeholder="0.00" autofocus></div>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--ok" data-ok>Enter — Abrir caja</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    function ok(close) {
      var raw = m.el.querySelector('#op-float').value.trim();
      var v = raw ? NX.parseMoney(raw) : 0;
      var err = m.el.querySelector('[data-err]');
      if (isNaN(v)) { err.textContent = 'Escribe un monto válido (o déjalo vacío si empiezas en cero).'; err.hidden = false; return; }
      NX.api('POST', '/api/shift/open', { openingFloat: v }).then(function (s) {
        close(); NX.toast('Caja abierta con fondo de ' + NX.money(s.openingFloat)); NX.refreshFooter();
        if (after) after(s);
      }).catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  };

  // ── F7 Entrada / F8 Salida de efectivo ─────────────────────────
  NX.cashMove = function (type, after) {
    var isOut = type === 'salida';
    var m = NX.modal({
      title: (isOut ? 'F8 — Salida' : 'F7 — Entrada') + ' de efectivo',
      html: '<div class="nx-modal-body"><p style="margin:0">' + (isOut ? 'Dinero que sale de la caja (pagos a suplidores, gastos, retiros).' : 'Dinero que entra a la caja sin ser venta (cambio extra, abonos).') + '</p>' +
        '<div class="nx-field"><label for="mv-amount">Monto</label><input id="mv-amount" class="nx-amount-input" inputmode="decimal" placeholder="0.00" autofocus></div>' +
        '<div class="nx-field"><label for="mv-reason">Motivo</label><input id="mv-reason" maxlength="120" placeholder="' + (isOut ? 'Ej. pago de hielo' : 'Ej. cambio adicional') + '"></div>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Registrar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    function ok(close) {
      var amount = NX.parseMoney(m.el.querySelector('#mv-amount').value);
      var reason = m.el.querySelector('#mv-reason').value.trim();
      var err = m.el.querySelector('[data-err]'); err.hidden = true;
      if (!(amount > 0)) { err.textContent = 'Escribe un monto mayor que 0.'; err.hidden = false; return; }
      if (!reason) { err.textContent = 'Escribe el motivo.'; err.hidden = false; return; }
      NX.askSupervisorPin('caja.' + type, 'Sacar efectivo de la caja').then(function (pin) {
        return NX.api('POST', '/api/shift/move', { type: type, amount: amount, reason: reason, authPin: pin || undefined });
      }).then(function (s) {
        close(); NX.toast((isOut ? 'Salida' : 'Entrada') + ' de ' + NX.money(amount) + ' registrada');
        if (after) after(s);
      }).catch(function (x) {
        if (x.message === 'cancelado') return;
        if (x.status === 409 && /cerrada/.test(x.message)) { close(); NX.openShiftDialog(after); return; }
        err.textContent = x.message; err.hidden = false;
      });
    }
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  };

  // ── Resumen e impresión ────────────────────────────────────────
  function summaryHtml(s) {
    var diff = s.difference;
    var h = '<dl class="nx-kv">' +
      '<dt>Fondo inicial</dt><dd>' + NX.money(s.openingFloat) + '</dd>' +
      '<dt>Ventas en efectivo</dt><dd>' + NX.money(s.methods.efectivo) + '</dd>' +
      '<dt>Entradas de efectivo</dt><dd>' + NX.money(s.entradas) + '</dd>' +
      '<dt>Salidas de efectivo</dt><dd>−' + NX.money(s.salidas) + '</dd>' +
      (s.refunds && s.refunds.efectivo ? '<dt>Devoluciones en efectivo</dt><dd>−' + NX.money(s.refunds.efectivo) + '</dd>' : '') +
      '<div class="sep"></div><dt class="strong">Efectivo esperado en caja</dt><dd class="strong">' + NX.money(s.expectedCash) + '</dd>';
    if (s.countedCash != null) {
      h += '<dt>Efectivo contado</dt><dd>' + NX.money(s.countedCash) + '</dd>' +
        '<dt>Diferencia</dt><dd class="' + (diff === 0 ? 'nx-diff-ok' : 'nx-diff-bad') + '">' + (diff > 0 ? '+' : diff < 0 ? '−' : '') + NX.money(Math.abs(diff)) + (diff > 0 ? ' (sobra)' : diff < 0 ? ' (falta)' : ' (cuadra)') + '</dd>';
    }
    h += '<div class="sep"></div>' +
      '<dt>Ventas (' + s.salesCount + ')</dt><dd>' + NX.money(s.salesTotal) + '</dd>' +
      '<dt>· Efectivo</dt><dd>' + NX.money(s.methods.efectivo) + '</dd>' +
      '<dt>· Tarjeta</dt><dd>' + NX.money(s.methods.tarjeta) + '</dd>' +
      '<dt>· Transferencia</dt><dd>' + NX.money(s.methods.transferencia) + '</dd>' +
      '<dt>ITBIS cobrado</dt><dd>' + NX.money(s.taxTotal) + '</dd>' +
      '<dt>Descuentos dados</dt><dd>' + NX.money(s.discountTotal) + '</dd>' +
      '<dt>Ventas anuladas (' + s.cancelledCount + ')</dt><dd>' + NX.money(s.cancelledTotal) + '</dd>' +
      (s.refunds && s.refunds.count ? '<dt>Devoluciones (' + s.refunds.count + ')</dt><dd>−' + NX.money(s.refunds.total) + '</dd>' : '');
    if (s.profit != null) h += '<div class="sep"></div><dt class="strong">Ganancia estimada</dt><dd class="strong">' + NX.money(s.profit) + '</dd>';
    return h + '</dl>';
  }

  NX.printShift = function (s, partial) {
    var c = (NX.info && NX.info.company) || {};
    var row = function (a, b) { return '<div class="tk-row"><span>' + a + '</span><span>' + b + '</span></div>'; };
    var h = '<div class="tk-center tk-big">' + NX.esc(c.trade_name || 'NexoCaja') + '</div>' +
      '<div class="tk-center tk-big">' + (partial ? 'CORTE PARCIAL (X)' : 'CORTE DE CAJA (Z)') + '</div><hr class="tk-hr">' +
      row('Caja', NX.esc(s.registerId)) + row('Abrió', NX.esc(s.openedBy || '')) + row('Apertura', NX.esc(NX.date(s.openedAt))) +
      (s.closedAt ? row('Cerró', NX.esc(s.closedBy || '')) + row('Cierre', NX.esc(NX.date(s.closedAt))) : row('Impreso', NX.esc(new Date().toLocaleString('es-DO')))) +
      '<hr class="tk-hr">' + row('Fondo inicial', NX.money(s.openingFloat)) + row('Ventas efectivo', NX.money(s.methods.efectivo)) +
      row('Entradas', NX.money(s.entradas)) + row('Salidas', '-' + NX.money(s.salidas)) +
      (s.refunds && s.refunds.efectivo ? row('Devoluciones', '-' + NX.money(s.refunds.efectivo)) : '') +
      '<div class="tk-row tk-total"><span>ESPERADO</span><span>' + NX.money(s.expectedCash) + '</span></div>';
    if (s.countedCash != null) h += row('Contado', NX.money(s.countedCash)) + row('Diferencia', (s.difference < 0 ? '-' : '') + NX.money(Math.abs(s.difference)));
    h += '<hr class="tk-hr">' + row('Ventas (' + s.salesCount + ')', NX.money(s.salesTotal)) + row(' Efectivo', NX.money(s.methods.efectivo)) +
      row(' Tarjeta', NX.money(s.methods.tarjeta)) + row(' Transferencia', NX.money(s.methods.transferencia)) +
      row('ITBIS', NX.money(s.taxTotal)) + row('Descuentos', NX.money(s.discountTotal)) + row('Anuladas (' + s.cancelledCount + ')', NX.money(s.cancelledTotal)) +
      (s.refunds && s.refunds.count ? row('Devoluc. (' + s.refunds.count + ')', '-' + NX.money(s.refunds.total)) : '');
    if (s.byCashier && s.byCashier.length) {
      h += '<hr class="tk-hr"><div>Por cajero:</div>' + s.byCashier.map(function (x) { return row(' ' + NX.esc(x.name || '') + ' (' + x.n + ')', NX.money(x.total)); }).join('');
    }
    if (s.moves && s.moves.length) {
      h += '<hr class="tk-hr"><div>Movimientos:</div>' + s.moves.map(function (mv) {
        return row(' ' + (mv.type === 'salida' ? 'Sal. ' : 'Ent. ') + NX.esc(mv.reason), (mv.type === 'salida' ? '-' : '') + NX.money(mv.amount));
      }).join('');
    }
    if (s.notes) h += '<hr class="tk-hr"><div>Nota: ' + NX.esc(s.notes) + '</div>';
    h += '<hr class="tk-hr"><div style="margin-top:18px">Firma: ______________________</div><div class="tk-center" style="margin-top:6px">NexoCaja · NexTech360</div>';
    NX.$('print-area').innerHTML = h;
    setTimeout(function () { window.print(); }, 50);
  };

  // ── Cerrar caja ────────────────────────────────────────────────
  function closeDialog(s) {
    var m = NX.modal({
      title: 'Cerrar caja — corte Z',
      html: '<div class="nx-modal-body"><p style="margin:0">Cuenta todo el efectivo que hay en la caja y escríbelo aquí.</p>' +
        '<div class="nx-big-total"><span>EFECTIVO ESPERADO</span><b>' + NX.money(s.expectedCash) + '</b></div>' +
        '<div class="nx-field"><label for="cl-count">Efectivo contado</label><input id="cl-count" class="nx-amount-input" inputmode="decimal" placeholder="0.00" autofocus></div>' +
        '<div class="nx-result nx-result--info" data-diff><span>Diferencia</span><b>—</b></div>' +
        '<div class="nx-field"><label for="cl-notes">Nota (opcional)</label><input id="cl-notes" maxlength="300" placeholder="Ej. faltan 20 pesos de un cambio"></div>' +
        '<label class="nx-check"><input type="checkbox" id="cl-print" checked> Imprimir el corte</label>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--ok" data-ok>Enter — Cerrar caja</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    var input = m.el.querySelector('#cl-count');
    input.addEventListener('input', function () {
      var v = NX.parseMoney(input.value), box = m.el.querySelector('[data-diff]');
      if (isNaN(v)) { box.className = 'nx-result nx-result--info'; box.innerHTML = '<span>Diferencia</span><b>—</b>'; return; }
      var d = v - s.expectedCash;
      box.className = 'nx-result nx-result--' + (d === 0 ? 'ok' : 'warn');
      box.innerHTML = '<span>' + (d === 0 ? 'Cuadra exacto' : d > 0 ? 'Sobra' : 'Falta') + '</span><b>' + NX.money(Math.abs(d)) + '</b>';
    });
    function ok(close) {
      var v = NX.parseMoney(input.value), err = m.el.querySelector('[data-err]');
      if (isNaN(v)) { err.textContent = 'Escribe cuánto efectivo contaste.'; err.hidden = false; return; }
      var doPrint = m.el.querySelector('#cl-print').checked;
      NX.api('POST', '/api/shift/close', { countedCash: v, notes: m.el.querySelector('#cl-notes').value }).then(function (res) {
        close(); NX.toast('Caja cerrada. ' + (res.difference === 0 ? 'Cuadró exacto.' : (res.difference > 0 ? 'Sobraron ' : 'Faltaron ') + NX.money(Math.abs(res.difference))));
        if (doPrint) NX.printShift(res, false);
        NX.refreshFooter(); load();
      }).catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  }

  // ── Vista ──────────────────────────────────────────────────────
  var currentShift = null, history = [];
  function load() {
    Promise.all([NX.api('GET', '/api/shift/current'), NX.api('GET', '/api/shift/history')]).then(function (r) {
      currentShift = r[0].shift; history = r[1]; paint(r[0].registerId);
    }).catch(function (x) { if (x.status !== 401) NX.toast(x.message, true); });
  }
  function paint(registerId) {
    if (!root) return;
    var s = currentShift;
    var left = s
      ? '<section class="nx-card"><h2>Turno abierto · ' + NX.esc(registerId) + '</h2>' +
        '<p class="nx-muted" style="margin:0 0 10px">Abrió ' + NX.esc(s.openedBy || '') + ' · ' + NX.esc(NX.date(s.openedAt)) + '</p>' + summaryHtml(s) +
        '<div class="nx-actions" style="margin-top:14px"><button type="button" class="nx-btn" data-in><kbd class="nx-key">F7</kbd>Entrada</button>' +
        '<button type="button" class="nx-btn" data-out><kbd class="nx-key">F8</kbd>Salida</button>' +
        '<button type="button" class="nx-btn" data-x>Imprimir corte parcial (X)</button>' +
        '<span class="nx-spacer"></span><button type="button" class="nx-btn nx-btn--ok" data-close style="height:40px">Cerrar caja (Z)</button></div></section>'
      : '<section class="nx-card"><h2>Caja cerrada · ' + NX.esc(registerId) + '</h2><p>No hay un turno abierto. Ábrelo con el fondo inicial para empezar a vender.</p>' +
        '<button type="button" class="nx-btn nx-btn--ok" data-open style="height:44px;padding:0 18px">Abrir caja</button></section>';
    var moves = s && s.moves.length
      ? '<section class="nx-card"><h2>Movimientos de efectivo</h2><table class="nx-table" style="min-width:0"><tbody>' +
        s.moves.map(function (mv) {
          return '<tr><td>' + NX.esc(NX.date(mv.created_at)) + '</td><td>' + (mv.type === 'salida' ? 'Salida' : 'Entrada') + '</td><td>' + NX.esc(mv.reason) + '</td><td>' + NX.esc(mv.user || '') + '</td>' +
            '<td class="r num">' + (mv.type === 'salida' ? '−' : '') + NX.money(mv.amount) + '</td></tr>';
        }).join('') + '</tbody></table></section>' : '';
    var hist = '<section class="nx-card"><h2>Cortes anteriores</h2>' + (history.length
      ? '<div class="nx-tablebox" style="min-height:0;max-height:360px"><table class="nx-table" style="min-width:0"><thead><tr><th>Cierre</th><th>Cerró</th><th class="r">Ventas</th><th class="r">Diferencia</th><th></th></tr></thead><tbody>' +
        history.map(function (h, i) {
          var d = h.difference;
          return '<tr><td>' + NX.esc(NX.date(h.closedAt)) + '</td><td>' + NX.esc(h.closedBy || '') + '</td><td class="r num">' + NX.money(h.salesTotal) + '</td>' +
            '<td class="r num ' + (d === 0 ? 'nx-diff-ok' : 'nx-diff-bad') + '">' + (d < 0 ? '−' : d > 0 ? '+' : '') + NX.money(Math.abs(d || 0)) + '</td>' +
            '<td class="r"><button type="button" class="nx-btn nx-btn--sm" data-reprint="' + i + '">Reimprimir</button></td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<p class="nx-muted" style="margin:0">Todavía no hay cortes cerrados.</p>') + '</section>';
    root.innerHTML = '<div class="nx-estado"><h1>Corte de caja</h1><div class="nx-grid">' + left + '<div style="display:flex;flex-direction:column;gap:14px">' + moves + hist + '</div></div></div>';
    var on = function (sel, fn) { var b = root.querySelector(sel); if (b) b.addEventListener('click', fn); };
    on('[data-open]', function () { NX.openShiftDialog(load); });
    on('[data-in]', function () { NX.cashMove('entrada', load); });
    on('[data-out]', function () { NX.cashMove('salida', load); });
    on('[data-x]', function () { NX.printShift(currentShift, true); });
    on('[data-close]', function () { closeDialog(currentShift); });
    root.querySelectorAll('[data-reprint]').forEach(function (b) { b.addEventListener('click', function () { NX.printShift(history[+b.getAttribute('data-reprint')], false); }); });
  }

  NX.register('corte', {
    mount: function (el) { root = el; el.innerHTML = '<div class="nx-empty">Cargando…</div>'; load(); },
    unmount: function () { root = null; },
    onKey: function (e) {
      if (!currentShift) return;
      if (e.key === 'F7') { e.preventDefault(); NX.cashMove('entrada', load); }
      if (e.key === 'F8') { e.preventDefault(); NX.cashMove('salida', load); }
    }
  });
})();
