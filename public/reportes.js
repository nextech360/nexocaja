/* NexoCaja · Reportes DGII: formatos 607 (ventas) y 608 (NCF anulados). */
(function () {
  'use strict';
  var NX = window.NX;
  var root = null, tab = '607';
  var PAY = ['Efectivo', 'Cheque/Transf.', 'Tarjeta', 'Crédito'];

  function prevPeriod() {
    var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  var ymd = function (s) { return s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4); };

  function render607(r) {
    var c = r.consumo;
    var h = '<div class="nx-grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:10px">' +
      card('Ventas con NCF (sin ITBIS)', NX.money(r.totals.ventas), 'ITBIS facturado ' + NX.money(r.totals.ventasItbis)) +
      card('Notas de crédito (B04)', '−' + NX.money(r.totals.notas), 'ITBIS rebajado ' + NX.money(r.totals.notasItbis)) +
      card('Neto del período', NX.money(r.net.monto), 'ITBIS neto ' + NX.money(r.net.itbis)) +
      card('Resumen facturas de consumo', NX.money(c.monto), c.count + ' factura(s) B02 · ITBIS ' + NX.money(c.itbis)) + '</div>';
    if (c.count) h += '<p class="nx-muted" style="margin:0 0 8px;font-size:13px">Las facturas de consumo (B02) menores de RD$250,000 no van línea por línea: al enviar el 607 en la Oficina Virtual, escribe el total de <b>' + NX.money(c.total) + '</b> (' + c.count + ' facturas, ITBIS ' + NX.money(c.itbis) + ') en la casilla «Resumen de facturas de consumo».</p>';
    h += '<div class="nx-tablebox"><table class="nx-table" style="min-width:980px"><thead><tr><th>RNC/Cédula</th><th>NCF</th><th>NCF modificado</th><th>Fecha</th><th class="r">Monto facturado</th><th class="r">ITBIS</th><th>Forma de pago</th><th>Cliente</th></tr></thead><tbody>' +
      r.rows.map(function (x) {
        var pays = Object.keys(x.pays).map(function (k) { return ({ efectivo: PAY[0], transferencia: PAY[1], tarjeta: PAY[2], credito: PAY[3] })[k] || k; }).join(' + ');
        return '<tr><td class="num">' + NX.esc(x.doc || '—') + '</td><td class="num">' + NX.esc(x.ncf) + '</td><td class="num">' + NX.esc(x.ncfModified || '') + '</td><td>' + ymd(x.date) + '</td>' +
          '<td class="r num">' + (x.kind === 'nota' ? '−' : '') + NX.money(x.monto) + '</td><td class="r num">' + (x.kind === 'nota' && x.itbis ? '−' : '') + NX.money(x.itbis) + '</td><td>' + pays + '</td><td>' + NX.esc(x.customer || '') +
          (x.kind === 'nota' && !x.itbisApplies ? ' <span class="nx-tag">NC después de 30 días</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>' + (r.rows.length ? '' : '<div class="nx-empty">No hay comprobantes para detallar en este período.' + (c.count ? ' Solo el resumen de consumo.' : '') + '</div>') + '</div>';
    return h;
  }
  function render608(r) {
    var h = '<div class="nx-tablebox"><table class="nx-table" style="min-width:760px"><thead><tr><th>NCF anulado</th><th>Fecha del comprobante</th><th>Tipo de anulación</th><th>Motivo escrito</th><th class="r">Monto</th></tr></thead><tbody>' +
      r.rows.map(function (x) {
        return '<tr><td class="num">' + NX.esc(x.ncf) + '</td><td>' + ymd(x.date) + '</td><td>' + x.type + ' — ' + NX.esc(x.typeName) +
          (x.assumed ? ' <span class="nx-tag" title="Anulada antes de la 1.4.0, sin tipo elegido">revisar</span>' : '') + '</td><td>' + NX.esc(x.reason || '') + '</td><td class="r num">' + NX.money(x.total) + '</td></tr>';
      }).join('') + '</tbody></table>' + (r.rows.length ? '' : '<div class="nx-empty">No se anuló ningún NCF en este período. Igual debes enviar el 608 (en cero) si estás obligado.</div>') + '</div>';
    return h;
  }
  function card(t, big, sub) {
    return '<div class="nx-card"><h2>' + t + '</h2><div class="num" style="font-size:22px;font-weight:800">' + big + '</div><div class="nx-muted" style="font-size:12px">' + sub + '</div></div>';
  }

  function load() {
    if (!root) return;
    var per = root.querySelector('#rp-period').value.replace('-', '');
    var out = root.querySelector('[data-out]');
    root.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('nx-btn--primary', b.getAttribute('data-tab') === tab); });
    out.innerHTML = '<div class="nx-empty">Generando…</div>';
    NX.api('GET', '/api/reports/' + tab + '?period=' + per).then(function (r) {
      if (!root) return;
      out.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">' +
        '<b>Formato ' + r.format + '</b><span class="nx-muted">· RNC ' + NX.esc(r.rnc) + ' · Período ' + NX.esc(r.period) + ' · ' + r.count + ' registro(s)</span><span class="nx-spacer"></span>' +
        '<a class="nx-btn nx-btn--ok" data-dl href="/api/reports/' + tab + '?period=' + per + '&download=1" download="' + NX.esc(r.fileName) + '">Descargar ' + NX.esc(r.fileName) + '</a></div>' +
        (tab === '607' ? render607(r) : render608(r)) +
        '<p class="nx-muted" style="font-size:12px;margin:10px 0 0">Antes de enviarlo por la Oficina Virtual, pásalo por la <b>Herramienta de Pre-validación</b> de la DGII y revísalo con tu contador. Se envía dentro de los primeros 15 días del mes siguiente.</p>';
    }).catch(function (x) { if (root) out.innerHTML = '<div class="nx-error">' + NX.esc(x.message) + '</div>'; });
  }

  NX.register('reportes', {
    mount: function (el) {
      if (!NX.can('reportes.ver')) { NX.go('caja'); return; }
      root = el;
      el.innerHTML = '<div class="nx-page"><div class="nx-page-head"><h1>Reportes DGII</h1>' +
        '<div class="nx-tabs"><button type="button" class="nx-btn" data-tab="607">607 · Ventas</button><button type="button" class="nx-btn" data-tab="608">608 · NCF anulados</button></div>' +
        '<label for="rp-period" class="nx-muted" style="margin-left:8px">Período</label><input type="month" id="rp-period" class="nx-search" style="flex:0 0 170px" value="' + prevPeriod() + '"></div>' +
        '<div class="nx-page-body" data-out style="overflow:auto"></div></div>';
      el.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { tab = b.getAttribute('data-tab'); load(); }); });
      el.querySelector('#rp-period').addEventListener('change', load);
      load();
    },
    unmount: function () { root = null; }
  });
})();
