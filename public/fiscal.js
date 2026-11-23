/* NexoCaja · Configuración fiscal (dueño) y Clientes (todos). */
(function () {
  'use strict';
  var NX = window.NX;

  // ── Utilidades fiscales en el navegador (mismas reglas que el servidor) ──
  var digits = function (v) { return String(v || '').replace(/\D/g, ''); };
  NX.rd = {
    validRnc: function (v) {
      var n = digits(v); if (n.length !== 9) return false;
      var w = [7, 9, 8, 6, 5, 4, 3, 2], s = 0;
      for (var i = 0; i < 8; i++) s += w[i] * +n[i];
      return String(((10 - (s % 11)) % 9) + 1) === n[8];
    },
    validCedula: function (v) {
      var n = digits(v); if (n.length !== 11) return false;
      var s = 0;
      for (var i = 0; i < 11; i++) { var d = +n[10 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } s += d; }
      return s % 10 === 0;
    },
    docHint: function (v) {
      var n = digits(v);
      if (!n) return { ok: true, text: '' };
      if (n.length === 9) return NX.rd.validRnc(n) ? { ok: true, text: '✔ RNC válido' } : { ok: false, text: '✖ El RNC no pasa la validación' };
      if (n.length === 11) return NX.rd.validCedula(n) ? { ok: true, text: '✔ Cédula válida' } : { ok: false, text: '✖ La cédula no pasa la validación' };
      return { ok: false, text: 'RNC: 9 dígitos · Cédula: 11 dígitos (' + n.length + ' escritos)' };
    }
  };
  NX.NCF_NAMES = { '02': 'Factura de Consumo', '01': 'Factura de Crédito Fiscal', '15': 'Factura Gubernamental', '04': 'Nota de Crédito' };

  NX.fiscal = { status: null };
  NX.loadFiscalStatus = function () {
    return NX.api('GET', '/api/fiscal/status').then(function (s) { NX.fiscal.status = s; return s; });
  };

  // ── Cliente: crear / editar (lo usan Clientes y la Caja) ──────
  NX.customerForm = function (c, after) {
    var isNew = !c;
    c = c || {};
    var m = NX.modal({
      title: isNew ? 'Nuevo cliente' : 'Editar cliente',
      html: '<div class="nx-modal-body"><div class="nx-form">' +
        '<div class="nx-field full"><label for="cu-name">Nombre o razón social</label><input id="cu-name" maxlength="120" value="' + NX.esc(c.name || '') + '" autofocus></div>' +
        '<div class="nx-field"><label for="cu-doc">RNC o cédula</label><input id="cu-doc" class="num" maxlength="15" value="' + NX.esc(c.docFormatted || c.docNumber || '') + '" placeholder="Opcional para consumo"><small data-hint></small></div>' +
        '<div class="nx-field"><label for="cu-phone">Teléfono</label><input id="cu-phone" maxlength="40" value="' + NX.esc(c.phone || '') + '"></div>' +
        '<div class="nx-field"><label for="cu-email">Correo</label><input id="cu-email" maxlength="120" value="' + NX.esc(c.email || '') + '"></div>' +
        '<div class="nx-field"><label for="cu-addr">Dirección</label><input id="cu-addr" maxlength="200" value="' + NX.esc(c.address || '') + '"></div>' +
        '</div><p class="nx-muted" style="margin:0;font-size:12px">Para facturas de Crédito Fiscal y Gubernamental el cliente necesita RNC (o cédula si es persona física, solo Crédito Fiscal). Verifica el nombre exacto en la consulta de RNC de la DGII.</p>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Guardar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); save(close, false); } }
    });
    var el = m.el, doc = el.querySelector('#cu-doc'), hint = el.querySelector('[data-hint]');
    var showHint = function () { var h = NX.rd.docHint(doc.value); hint.textContent = h.text; hint.style.color = h.ok ? '#15803d' : '#b91c1c'; };
    doc.addEventListener('input', showHint); showHint();
    function save(close, force) {
      var err = el.querySelector('[data-err]'); err.hidden = true;
      var body = { name: el.querySelector('#cu-name').value, docNumber: doc.value, phone: el.querySelector('#cu-phone').value,
        email: el.querySelector('#cu-email').value, address: el.querySelector('#cu-addr').value, force: force };
      var req = isNew ? NX.api('POST', '/api/customers', body) : NX.api('PUT', '/api/customers/' + encodeURIComponent(c.id), body);
      req.then(function (saved) { close(); NX.toast('Cliente guardado: ' + saved.name); if (after) after(saved); })
        .catch(function (x) {
          if (x.status === 422) {
            err.innerHTML = NX.esc(x.message) + ' <button type="button" class="nx-btn nx-btn--sm" data-force>Guardar de todos modos</button>';
            err.hidden = false;
            err.querySelector('[data-force]').onclick = function () { save(m.close, true); };
            return;
          }
          err.textContent = x.message; err.hidden = false;
        });
    }
    el.querySelector('[data-x]').onclick = m.close;
    el.querySelector('[data-ok]').onclick = function () { save(m.close, false); };
  };

  /** F2 en la Caja: buscar y elegir cliente. after(cliente|null). */
  NX.pickCustomer = function (after) {
    var results = [], hi = 0, timer;
    var m = NX.modal({
      title: 'F2 — Cliente de la venta', wide: true,
      html: '<div class="nx-modal-body"><div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
        '<div class="nx-field" style="flex:1 1 300px"><label for="pc-q">Buscar por nombre, RNC o cédula</label><input id="pc-q" autocomplete="off" autofocus></div>' +
        '<button type="button" class="nx-btn" data-final style="height:38px">Consumidor final</button>' +
        '<button type="button" class="nx-btn nx-btn--primary" data-new style="height:38px"><kbd class="nx-key">INS</kbd>Nuevo cliente</button></div>' +
        '<div class="nx-tablebox" style="max-height:360px;min-height:120px"><table class="nx-table" style="min-width:560px"><thead><tr><th>Nombre o razón social</th><th>Documento</th><th>Teléfono</th></tr></thead>' +
        '<tbody></tbody></table><div class="nx-empty" data-none hidden>No hay clientes con esa búsqueda. Créalo con <b>Nuevo cliente</b>.</div></div></div>',
      onKey: function (e, close) {
        if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, results.length - 1); paint(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, 0); paint(); }
        if (e.key === 'Enter') { e.preventDefault(); if (results[hi]) { close(); after(results[hi]); } }
        if (e.key === 'Insert') { e.preventDefault(); newOne(); }
      }
    });
    var q = m.el.querySelector('#pc-q');
    function paint() {
      m.el.querySelector('tbody').innerHTML = results.map(function (c, i) {
        return '<tr data-i="' + i + '" class="' + (i === hi ? 'is-sel' : '') + '" style="cursor:pointer"><td><b>' + NX.esc(c.name) + '</b></td><td class="num">' +
          (c.docFormatted ? NX.esc((c.docType === 'RNC' ? 'RNC ' : 'Céd. ') + c.docFormatted) : '<span class="nx-muted">—</span>') + '</td><td>' + NX.esc(c.phone) + '</td></tr>';
      }).join('');
      m.el.querySelector('[data-none]').hidden = results.length > 0;
    }
    function load() { NX.api('GET', '/api/customers?q=' + encodeURIComponent(q.value.trim())).then(function (r) { results = r; hi = 0; paint(); }); }
    function newOne() { m.close(); NX.customerForm(null, function (c) { after(c); }); }
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 150); });
    m.el.querySelector('tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-i]'); if (!tr) return;
      m.close(); after(results[+tr.getAttribute('data-i')]);
    });
    m.el.querySelector('[data-final]').onclick = function () { m.close(); after(null); };
    m.el.querySelector('[data-new]').onclick = newOne;
    load();
  };

  // ── Vista: Clientes ────────────────────────────────────────────
  var croot = null, customers = [];
  function loadCustomers(q) {
    NX.api('GET', '/api/customers?q=' + encodeURIComponent(q || '')).then(function (r) { customers = r; paintCustomers(); })
      .catch(function (x) { if (x.status !== 401) NX.toast(x.message, true); });
  }
  function paintCustomers() {
    if (!croot) return;
    croot.querySelector('tbody').innerHTML = customers.map(function (c) {
      return '<tr data-id="' + NX.esc(c.id) + '"><td><b>' + NX.esc(c.name) + '</b></td><td>' + NX.esc(c.docType === 'RNC' ? 'RNC' : c.docType === 'CEDULA' ? 'Cédula' : '—') + '</td>' +
        '<td class="num">' + NX.esc(c.docFormatted) + '</td><td>' + NX.esc(c.phone) + '</td><td>' + NX.esc(c.email) + '</td>' +
        '<td class="r" style="white-space:nowrap"><button type="button" class="nx-btn nx-btn--sm" data-edit>Editar</button>' +
        (NX.can('productos.editar') ? ' <button type="button" class="nx-btn nx-btn--sm nx-btn--danger" data-del>Eliminar</button>' : '') + '</td></tr>';
    }).join('');
    croot.querySelector('[data-empty]').hidden = customers.length > 0;
  }
  NX.register('clientes', {
    mount: function (el) {
      croot = el;
      el.innerHTML = '<div class="nx-page"><div class="nx-page-head"><h1>Clientes</h1>' +
        '<input class="nx-search" type="search" placeholder="Buscar por nombre, RNC o cédula…" aria-label="Buscar clientes">' +
        '<span class="nx-spacer"></span><button type="button" class="nx-btn nx-btn--primary" data-new><kbd class="nx-key">INS</kbd>Nuevo cliente</button></div>' +
        '<div class="nx-page-body"><div class="nx-tablebox"><table class="nx-table" style="min-width:800px"><thead><tr><th>Nombre o razón social</th><th>Tipo</th><th>Documento</th><th>Teléfono</th><th>Correo</th>' +
        '<th><span style="position:absolute;left:-9999px">Acciones</span></th></tr></thead><tbody></tbody></table>' +
        '<div class="nx-empty" data-empty hidden>No hay clientes. Agrega el primero con <b>Nuevo cliente</b>. Para ventas al consumidor final no hace falta registrar al cliente.</div></div></div></div>';
      var t, search = el.querySelector('.nx-search');
      search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { loadCustomers(search.value.trim()); }, 200); });
      el.querySelector('[data-new]').addEventListener('click', function () { NX.customerForm(null, function () { loadCustomers(search.value.trim()); }); });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (!tr) return;
        var c = customers.find(function (x) { return x.id === tr.getAttribute('data-id'); });
        if (e.target.closest('[data-edit]')) NX.customerForm(c, function () { loadCustomers(search.value.trim()); });
        if (e.target.closest('[data-del]')) NX.confirm('Eliminar cliente', '¿Eliminar a ' + c.name + '? Sus facturas anteriores se conservan.', 'Eliminar').then(function (ok) {
          if (ok) NX.api('DELETE', '/api/customers/' + encodeURIComponent(c.id)).then(function () { NX.toast('Cliente eliminado'); loadCustomers(search.value.trim()); }).catch(function (x) { NX.toast(x.message, true); });
        });
      });
      loadCustomers('');
      search.focus();
    },
    unmount: function () { croot = null; },
    onKey: function (e) { if (e.key === 'Insert') { e.preventDefault(); NX.customerForm(null, function () { loadCustomers(''); }); } }
  });

  // ── Vista: Configuración fiscal (dueño) ────────────────────────
  var froot = null;
  var STATE = { ok: ['nx-status--ok', 'Vigente'], alerta: ['nx-status--bad', 'Por agotarse / vencer'], agotada: ['nx-status--bad', 'Agotada'], vencida: ['nx-status--bad', 'Vencida'], inactiva: ['nx-status--muted', 'Inactiva'] };

  function seqForm(after) {
    var nextYear = new Date().getFullYear() + 1;
    var m = NX.modal({
      title: 'Registrar secuencia NCF autorizada',
      html: '<div class="nx-modal-body"><p style="margin:0">Copia los datos tal como aparecen en la autorización de la DGII (Oficina Virtual → Solicitud de comprobantes).</p><div class="nx-form">' +
        '<div class="nx-field full"><label for="sq-type">Tipo de comprobante</label><select id="sq-type"><option value="02">B02 — Factura de Consumo</option><option value="01">B01 — Factura de Crédito Fiscal</option><option value="15">B15 — Gubernamental</option><option value="04">B04 — Nota de Crédito (devoluciones)</option></select></div>' +
        '<div class="nx-field"><label for="sq-start">Desde (número de secuencia)</label><input id="sq-start" class="num" inputmode="numeric" value="1"><small data-from></small></div>' +
        '<div class="nx-field"><label for="sq-end">Hasta</label><input id="sq-end" class="num" inputmode="numeric" placeholder="Ej. 500"><small data-to></small></div>' +
        '<div class="nx-field"><label for="sq-exp">Fecha de vencimiento</label><input id="sq-exp" type="date" value="' + nextYear + '-12-31"></div>' +
        '<div class="nx-field"><label for="sq-alert">Avisar cuando queden</label><input id="sq-alert" class="num" inputmode="numeric" placeholder="Automático (10% del rango)"></div>' +
        '</div><div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Registrar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    var el = m.el;
    var pv = function () {
      var t = el.querySelector('#sq-type').value;
      var f = function (v) { v = parseInt(v, 10); return v > 0 ? 'B' + t + String(v).padStart(8, '0') : ''; };
      el.querySelector('[data-from]').textContent = f(el.querySelector('#sq-start').value);
      el.querySelector('[data-to]').textContent = f(el.querySelector('#sq-end').value);
    };
    ['#sq-type', '#sq-start', '#sq-end'].forEach(function (s) { el.querySelector(s).addEventListener('input', pv); });
    pv();
    function ok(close) {
      var err = el.querySelector('[data-err]'); err.hidden = true;
      NX.api('POST', '/api/fiscal/sequences', {
        typeCode: el.querySelector('#sq-type').value, start: parseInt(el.querySelector('#sq-start').value, 10), end: parseInt(el.querySelector('#sq-end').value, 10),
        expiresOn: el.querySelector('#sq-exp').value, alertAt: el.querySelector('#sq-alert').value.trim()
      }).then(function (s) { close(); NX.toast('Secuencia ' + s.from + ' a ' + s.to + ' registrada'); after(); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    el.querySelector('[data-x]').onclick = m.close;
    el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  }

  function loadFiscal() {
    Promise.all([NX.api('GET', '/api/fiscal/company'), NX.api('GET', '/api/fiscal/sequences'), NX.loadFiscalStatus()]).then(function (r) { paintFiscal(r[0], r[1], r[2]); })
      .catch(function (x) { if (x.status !== 401) NX.toast(x.message, true); });
  }
  function paintFiscal(co, seqs, st) {
    if (!froot) return;
    var alerts = st.alerts.map(function (a) { return '<div class="' + (a.level === 'bad' ? 'nx-error' : 'nx-result nx-result--warn') + '" style="font-weight:600">' + NX.esc(a.text) + '</div>'; }).join('');
    froot.innerHTML = '<div class="nx-estado"><h1>Configuración fiscal</h1>' + (alerts ? '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">' + alerts + '</div>' : '') +
      '<div class="nx-grid"><section class="nx-card"><h2>Datos del emisor</h2><form class="nx-form" data-co autocomplete="off">' +
      '<div class="nx-field full"><label for="co-legal">Razón social</label><input id="co-legal" maxlength="120" value="' + NX.esc(co.legalName) + '"></div>' +
      '<div class="nx-field full"><label for="co-trade">Nombre comercial</label><input id="co-trade" maxlength="120" value="' + NX.esc(co.tradeName) + '"></div>' +
      '<div class="nx-field"><label for="co-rnc">RNC del negocio</label><input id="co-rnc" class="num" maxlength="15" value="' + NX.esc(co.rnc) + '"><small data-hint></small></div>' +
      '<div class="nx-field"><label for="co-reg">Régimen</label><select id="co-reg"><option value="ORDINARIO">Ordinario</option><option value="RST">RST (Régimen Simplificado)</option></select></div>' +
      '<div class="nx-field"><label for="co-branch">Sucursal</label><input id="co-branch" maxlength="60" value="' + NX.esc(co.branch) + '"></div>' +
      '<div class="nx-field"><label for="co-phone">Teléfono</label><input id="co-phone" maxlength="40" value="' + NX.esc(co.phone) + '"></div>' +
      '<div class="nx-field full"><label for="co-addr">Dirección</label><input id="co-addr" maxlength="200" value="' + NX.esc(co.address) + '"></div>' +
      '<div class="nx-field full"><label for="co-mode">Comprobantes fiscales</label><select id="co-mode"><option value="ninguno">No emitir NCF (solo ticket de venta)</option><option value="NCF">Emitir NCF (comprobantes tradicionales, serie B)</option></select>' +
      '<small>La facturación electrónica (e-CF, serie E) con firma y envío a la DGII llegará en una actualización aparte.</small></div>' +
      '<div class="nx-error full" data-err hidden></div><div class="full" style="display:flex;justify-content:flex-end"><button type="submit" class="nx-btn nx-btn--primary" style="height:40px">Guardar datos del emisor</button></div>' +
      '</form></section>' +
      '<section class="nx-card"><h2>Secuencias NCF autorizadas</h2>' +
      (seqs.length ? '<div class="nx-tablebox" style="min-height:0"><table class="nx-table" style="min-width:0"><thead><tr><th>Tipo</th><th>Rango</th><th class="r">Quedan</th><th>Vence</th><th class="c">Estado</th><th></th></tr></thead><tbody>' +
        seqs.map(function (s) {
          var stt = STATE[s.state] || STATE.ok;
          return '<tr data-id="' + NX.esc(s.id) + '"><td><b>' + NX.esc(s.prefix) + '</b><br><small class="nx-muted">' + NX.esc(s.typeName) + '</small></td>' +
            '<td class="num" style="font-size:12px">' + NX.esc(s.from) + '<br>' + NX.esc(s.to) + '</td><td class="r num">' + s.remaining + '</td>' +
            '<td>' + NX.esc(s.expiresOn || '—') + '</td><td class="c"><span class="nx-status ' + stt[0] + '">' + stt[1] + '</span></td>' +
            '<td class="r"><button type="button" class="nx-btn nx-btn--sm" data-toggle>' + (s.active ? 'Desactivar' : 'Activar') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="nx-muted">Todavía no hay secuencias. Registra las que te autorizó la DGII para poder emitir facturas con NCF.</p>') +
      '<div style="margin-top:12px"><button type="button" class="nx-btn nx-btn--primary" data-newseq style="height:40px">+ Registrar secuencia</button></div>' +
      '<p class="nx-muted" style="font-size:12px">NexoCaja usa cada número una sola vez y en orden. Cuando una secuencia se agota o vence, la caja deja de emitir ese tipo hasta que registres otra.</p></section></div></div>';
    var f = froot.querySelector('[data-co]');
    f.querySelector('#co-reg').value = co.taxRegime;
    f.querySelector('#co-mode').value = co.mode;
    var rnc = f.querySelector('#co-rnc'), hint = f.querySelector('[data-hint]');
    var sh = function () { var h = NX.rd.docHint(rnc.value); hint.textContent = h.text; hint.style.color = h.ok ? '#15803d' : '#b91c1c'; };
    rnc.addEventListener('input', sh); sh();
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = f.querySelector('[data-err]'); err.hidden = true;
      NX.api('PUT', '/api/fiscal/company', {
        legalName: f.querySelector('#co-legal').value, tradeName: f.querySelector('#co-trade').value, rnc: rnc.value, taxRegime: f.querySelector('#co-reg').value,
        branch: f.querySelector('#co-branch').value, phone: f.querySelector('#co-phone').value, address: f.querySelector('#co-addr').value, mode: f.querySelector('#co-mode').value
      }).then(function (saved) {
        NX.toast('Datos del emisor guardados');
        if (NX.info) {
          NX.info.company = { legal_name: saved.legalName, trade_name: saved.tradeName, rnc: saved.rnc, branch: saved.branch, tax_regime: saved.taxRegime };
          NX.info.direccion = saved.address; NX.info.telefono = saved.phone; NX.info.fiscalMode = saved.mode;
          NX.$('company-name').textContent = saved.tradeName;
        }
        loadFiscal();
      }).catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
    froot.querySelector('[data-newseq]').addEventListener('click', function () { seqForm(loadFiscal); });
    froot.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var tr = b.closest('tr'); var s = seqs.find(function (x) { return x.id === tr.getAttribute('data-id'); });
        NX.api('PUT', '/api/fiscal/sequences/' + encodeURIComponent(s.id), { active: !s.active }).then(loadFiscal).catch(function (x) { NX.toast(x.message, true); });
      });
    });
  }
  NX.register('fiscal', {
    mount: function (el) {
      if (!NX.user || NX.user.role !== 'owner') { NX.go('caja'); return; }
      froot = el; el.innerHTML = '<div class="nx-empty">Cargando…</div>'; loadFiscal();
    },
    unmount: function () { froot = null; }
  });
})();
