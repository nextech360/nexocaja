/* NexoCaja · Monitor de comprobantes electrónicos (e-CF) y su envío a la DGII. */
(function () {
  'use strict';
  var NX = window.NX;
  var root = null, filtro = '', busca = '', docs = [];
  var TIPOS = { '31': 'Crédito Fiscal', '32': 'Consumo', '33': 'Nota de Débito', '34': 'Nota de Crédito', '45': 'Gubernamental', '44': 'Reg. Especiales' };
  var CLASE = { aceptado: 'nx-status--ok', aceptado_condicional: 'nx-status--ok', rechazado: 'nx-status--bad' };

  // ── Indicador del encabezado ───────────────────────────────────
  var pollTimer = null;
  function paintPill(s) {
    var pill = NX.$('ecf-pill'); if (!pill) return;
    var on = NX.fiscal.status && NX.fiscal.status.mode === 'ECF';
    pill.hidden = !on; if (!on) return;
    var txt, cls;
    if (s.offline && s.contingencia) { txt = 'Sin conexión DGII · ' + s.contingencia + ' en contingencia'; cls = 'bad'; }
    else if (s.rechazados) { txt = 'e-CF: ' + s.rechazados + ' rechazado' + (s.rechazados === 1 ? '' : 's'); cls = 'bad'; }
    else if (s.authError) { txt = 'e-CF: error de conexión'; cls = 'bad'; }
    else if (s.porEnviar || s.enProceso) { txt = 'e-CF: ' + (s.porEnviar + s.enProceso) + ' enviando…'; cls = 'warn'; }
    else { txt = 'e-CF al día'; cls = 'ok'; }
    pill.textContent = txt;
    pill.className = 'nx-ecf-pill nx-ecf-pill--' + cls;
    pill.title = s.authError || s.ultimoErrorRed || 'Estado del envío de comprobantes electrónicos a la DGII';
  }
  NX.refreshEcfPill = function () {
    if (!NX.user || !NX.fiscal.status || NX.fiscal.status.mode !== 'ECF') { paintPill({}); return; }
    NX.api('GET', '/api/ecf/summary').then(paintPill).catch(function () {});
  };
  NX.startEcfPoll = function () {
    clearInterval(pollTimer);
    pollTimer = setInterval(NX.refreshEcfPill, 20000);
    NX.refreshEcfPill();
  };

  var pillEl = NX.$('ecf-pill');
  if (pillEl) pillEl.addEventListener('click', function () { if (NX.can('reportes.ver')) NX.go('ecf'); else NX.toast(pillEl.title || pillEl.textContent); });

  // ── Vista ──────────────────────────────────────────────────────
  function card(label, n, cls, f) {
    return '<button type="button" class="nx-card nx-ecf-card' + (filtro === f ? ' is-on' : '') + '" data-f="' + f + '"><span class="nx-muted">' + label + '</span><b class="num ' + (cls || '') + '">' + n + '</b></button>';
  }
  function loadRecibidos() {
    NX.api('GET', '/api/ecf/recibidos').then(function (rows) {
      if (!root) return;
      root.querySelectorAll('[data-f]').forEach(function (b) { b.classList.toggle('is-on', b.getAttribute('data-f') === 'recibidos'); });
      root.querySelector('thead tr').innerHTML = '<th>Suplidor</th><th>e-NCF</th><th>Emitida</th><th class="r">ITBIS</th><th class="r">Total</th><th>Recibida</th><th></th>';
      root.querySelector('[data-empty]').hidden = rows.length > 0;
      root.querySelector('[data-empty]').textContent = 'Todavía no han llegado facturas electrónicas de suplidores. Activa el Buzón en Configuración fiscal.';
      root.querySelector('tbody').innerHTML = rows.map(function (r) {
        return '<tr><td><b>' + NX.esc(r.razonSocial || '') + '</b><br><small class="nx-muted num">RNC ' + NX.esc(r.rncEmisor) + '</small></td><td class="num">' + NX.esc(r.encf) + '<br><small class="nx-muted">' + (TIPOS[r.tipo] || r.tipo || '') + '</small></td>' +
          '<td>' + NX.esc(r.fechaEmision || '') + '</td><td class="r num">' + NX.money(r.itbis || 0) + '</td><td class="r num">' + NX.money(r.total || 0) + '</td><td>' + NX.esc(NX.date(r.recibidoAt)) + '</td>' +
          '<td class="r" style="white-space:nowrap"><a class="nx-btn nx-btn--sm" href="/api/ecf/recibidos/' + encodeURIComponent(r.id) + '/xml" download>XML</a> <a class="nx-btn nx-btn--sm" href="/api/ecf/recibidos/' + encodeURIComponent(r.id) + '/acuse" download>Acuse</a></td></tr>';
      }).join('');
    }).catch(function (x) { NX.toast(x.message, true); });
  }
  var HEAD = '<th>e-NCF</th><th>Tipo</th><th class="r">Total</th><th>Firmado</th><th>Estado DGII</th><th></th>';
  function load() {
    if (!root) return;
    if (filtro === 'recibidos') {
      NX.api('GET', '/api/ecf/docs?limit=1').then(function (r) { paintCards(r.summary); loadRecibidos(); });
      return;
    }
    root.querySelector('thead tr').innerHTML = HEAD;
    root.querySelector('[data-empty]').textContent = 'No hay comprobantes en esta lista.';
    var q = busca ? '?q=' + encodeURIComponent(busca) : filtro ? '?estado=' + filtro : '';
    NX.api('GET', '/api/ecf/docs' + q).then(function (r) {
      if (!root) return;
      docs = r.docs; paintCards(r.summary);
      root.querySelector('[data-empty]').hidden = docs.length > 0;
      paintRows();
    }).catch(function (x) { NX.toast(x.message, true); });
  }
  function paintCards(s) {
      paintPill(s);
      root.querySelector('[data-cards]').innerHTML =
        card('Todos', '—', '', '') + card('Pendientes de envío', s.porEnviar + s.enProceso, s.porEnviar ? 'nx-diff-bad' : '', 'pendientes') +
        card('Aceptados', s.aceptados, 'nx-diff-ok', 'aceptados') + card('Rechazados', s.rechazados, s.rechazados ? 'nx-diff-bad' : '', 'rechazado') +
        card('Recibidos de suplidores', '↓', '', 'recibidos');
      var warn = '';
      if (s.offline) warn += '<div class="nx-error">' + NX.esc(s.ultimoErrorRed || 'Sin conexión con la DGII') + '. Sigue vendiendo: los e-CF quedan en contingencia y se envían solos al volver internet. Plazo: 72 horas.</div>';
      if (s.authError) warn += '<div class="nx-error">' + NX.esc(s.authError) + '</div>';
      root.querySelector('[data-warn]').innerHTML = warn;
  }
  function paintRows() {
      root.querySelector('tbody').innerHTML = docs.map(function (d) {
        var msg = d.mensajes && d.mensajes.length ? '<br><small class="' + (d.estado === 'rechazado' ? 'nx-diff-bad' : 'nx-muted') + '">' + NX.esc(d.mensajes.map(function (m) { return (m.codigo ? m.codigo + ': ' : '') + m.valor; }).join(' · ')).slice(0, 220) + '</small>' : '';
        return '<tr data-encf="' + NX.esc(d.encf) + '"><td class="num"><b>' + NX.esc(d.encf) + '</b>' + (d.referencia ? '<br><small class="nx-muted">modifica ' + NX.esc(d.referencia) + '</small>' : '') + '</td>' +
          '<td>' + (TIPOS[d.tipo] || d.tipo) + '<br><small class="nx-muted">' + (d.ruta === 'RFCE' ? 'Resumen (RFCE)' : 'e-CF completo') + ' · ' + NX.esc(d.ambiente) + '</small></td>' +
          '<td class="r num">' + NX.money(d.total) + '</td><td>' + NX.esc(d.fechaFirma || '') + '</td>' +
          '<td><span class="nx-status ' + (CLASE[d.estado] || 'nx-status--muted') + '">' + NX.esc(d.estadoNombre) + '</span>' +
          (d.contingencia ? ' <span class="nx-tag">contingencia</span>' : '') + (d.aprobacionComercial ? ' <span class="nx-tag">cliente: ' + NX.esc(d.aprobacionComercial) + '</span>' : '') + (d.reemplazadoPor ? '<br><small>Reemitido como <b class="num">' + NX.esc(d.reemplazadoPor) + '</b></small>' : '') + msg + '</td>' +
          '<td class="r" style="white-space:nowrap"><button type="button" class="nx-btn nx-btn--sm" data-det>Detalle</button> ' +
          '<a class="nx-btn nx-btn--sm" href="/api/fiscal/ecf/' + encodeURIComponent(d.encf) + '/xml" download>XML</a>' +
          (['firmado', 'en_cola', 'en_proceso', 'enviado'].indexOf(d.estado) >= 0 ? ' <button type="button" class="nx-btn nx-btn--sm" data-retry>Reintentar</button>' : '') +
          (d.estado === 'rechazado' && !d.reemplazadoPor ? ' <button type="button" class="nx-btn nx-btn--sm nx-btn--danger" data-reissue>Reemitir</button>' : '') + '</td></tr>';
      }).join('');
  }
  function detail(encf) {
    NX.api('GET', '/api/ecf/docs/' + encodeURIComponent(encf)).then(function (d) {
      var m = NX.modal({
        title: 'e-CF ' + d.encf, wide: true,
        html: '<div class="nx-modal-body"><dl class="nx-dl">' +
          '<dt>Estado</dt><dd>' + NX.esc(d.estadoNombre) + (d.contingencia ? ' · emitido en contingencia (plazo ' + NX.esc(NX.date(d.limiteEnvio)) + ')' : '') + '</dd>' +
          '<dt>TrackId</dt><dd class="num">' + NX.esc(d.trackId || '—') + '</dd><dt>Código de seguridad</dt><dd class="num">' + NX.esc(d.codigoSeguridad || '') + '</dd>' +
          '<dt>Firmado</dt><dd>' + NX.esc(d.fechaFirma || '') + '</dd><dt>Enviado</dt><dd>' + NX.esc(d.enviadoAt ? NX.date(d.enviadoAt) : '—') + '</dd>' +
          '<dt>Respuesta</dt><dd>' + (d.mensajes.length ? d.mensajes.map(function (x) { return NX.esc((x.codigo ? x.codigo + ': ' : '') + x.valor); }).join('<br>') : '—') + '</dd></dl>' +
          '<h3 style="margin:10px 0 6px;font-size:13px">Bitácora de comunicación con la DGII</h3><div class="nx-tablebox" style="max-height:260px;min-height:0"><table class="nx-table" style="min-width:0"><thead><tr><th>Hora</th><th>Servicio</th><th class="r">HTTP</th><th class="r">ms</th><th>Respuesta</th></tr></thead><tbody>' +
          (d.log.map(function (l) {
            return '<tr><td>' + NX.esc(NX.date(l.created_at)) + '</td><td>' + NX.esc(l.servicio) + '</td><td class="r num">' + (l.http_status || '—') + '</td><td class="r num">' + (l.duracion_ms || '') + '</td>' +
              '<td style="font-family:var(--nx-font-num);font-size:11px;word-break:break-all">' + NX.esc((l.response_raw || '').slice(0, 300)) + '</td></tr>';
          }).join('') || '<tr><td colspan="5" class="nx-muted">Todavía no se ha enviado.</td></tr>') + '</tbody></table></div></div>' +
          '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cerrar</button></div>'
      });
      m.el.querySelector('[data-x]').onclick = m.close;
    }).catch(function (x) { NX.toast(x.message, true); });
  }
  NX.register('ecf', {
    mount: function (el) {
      if (!NX.can('reportes.ver')) { NX.go('caja'); return; }
      root = el;
      el.innerHTML = '<div class="nx-page"><div class="nx-page-head"><h1>Comprobantes electrónicos (e-CF)</h1>' +
        '<input class="nx-search" type="search" placeholder="Buscar e-NCF o TrackId…" aria-label="Buscar e-CF"><span class="nx-spacer"></span>' +
        '<button type="button" class="nx-btn nx-btn--primary" data-send>Enviar pendientes ahora</button></div>' +
        '<div class="nx-page-body" style="overflow:auto"><div class="nx-ecf-cards" data-cards></div><div data-warn style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>' +
        '<div class="nx-tablebox"><table class="nx-table" style="min-width:980px"><thead><tr><th>e-NCF</th><th>Tipo</th><th class="r">Total</th><th>Firmado</th><th>Estado DGII</th><th></th></tr></thead><tbody></tbody></table>' +
        '<div class="nx-empty" data-empty hidden>No hay comprobantes en esta lista.</div></div></div></div>';
      el.querySelector('[data-cards]').addEventListener('click', function (e) {
        var b = e.target.closest('[data-f]'); if (!b) return; filtro = b.getAttribute('data-f'); busca = ''; el.querySelector('.nx-search').value = ''; load();
      });
      var t, s = el.querySelector('.nx-search');
      s.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { busca = s.value.trim(); load(); }, 250); });
      el.querySelector('[data-send]').addEventListener('click', function (e) {
        var btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Enviando…';
        NX.api('POST', '/api/ecf/send-now', {}).then(function (r) { NX.toast('Enviados: ' + (r.sent || 0) + ' · consultados: ' + (r.checked || 0) + (r.errors ? ' · con error: ' + r.errors : '')); })
          .catch(function (x) { NX.toast(x.message, true); })
          .then(function () { btn.disabled = false; btn.textContent = 'Enviar pendientes ahora'; load(); });
      });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-encf]'); if (!tr) return;
        var encf = tr.getAttribute('data-encf');
        if (e.target.closest('[data-det]')) detail(encf);
        if (e.target.closest('[data-retry]')) NX.api('POST', '/api/ecf/docs/' + encodeURIComponent(encf) + '/retry', {}).then(function (d) { NX.toast(encf + ': ' + d.estadoNombre); load(); }).catch(function (x) { NX.toast(x.message, true); });
        if (e.target.closest('[data-reissue]')) {
          NX.confirm('Reemitir e-CF', 'Se emitirá un e-NCF nuevo con los mismos datos de la venta (corrige antes lo que la DGII señaló, por ejemplo los datos del negocio o del cliente). ¿Continuar?', 'Reemitir').then(function (ok) {
            if (!ok) return;
            NX.api('POST', '/api/ecf/docs/' + encodeURIComponent(encf) + '/reissue', {}).then(function (r) {
              NX.toast('Reemitido como ' + r.nuevo);
              if (r.origen === 'venta') NX.api('GET', '/api/sales/' + encodeURIComponent(r.origenId)).then(NX.printSale);
              else NX.api('GET', '/api/returns/' + encodeURIComponent(r.origenId)).then(NX.printCreditNote);
              load();
            }).catch(function (x) { NX.toast(x.message, true); });
          });
        }
      });
      load();
    },
    unmount: function () { root = null; }
  });
})();
