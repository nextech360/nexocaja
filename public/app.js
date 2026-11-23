/* NexoCaja · núcleo de la interfaz: utilidades, rutas, teclado, actualizaciones, ticket y Estado. */
(function () {
  'use strict';

  var NX = (window.NX = {});
  var $ = function (id) { return document.getElementById(id); };
  NX.$ = $;

  // ── Utilidades ─────────────────────────────────────────────────
  NX.money = function (cents) {
    var n = (Number(cents) || 0) / 100;
    return '$' + n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  /** "1,250.50" → 125050 centavos. Devuelve NaN si no es un número. */
  NX.parseMoney = function (v) {
    var s = String(v == null ? '' : v).replace(/[$\s,]/g, '');
    if (!s) return NaN;
    var n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
  };
  NX.qty = function (q) {
    return Number(q).toLocaleString('es-DO', { maximumFractionDigits: 3 });
  };
  NX.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  NX.api = function (method, url, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (r.status === 401 && url.indexOf('/api/auth/') !== 0 && NX.showLogin) NX.showLogin();
        if (!r.ok) { var e = new Error(d.error || ('Error ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  };
  /** Fechas de SQLite ("2026-11-22 23:10:00", UTC) o ISO → hora local legible. */
  NX.date = function (v) {
    if (!v) return '';
    var s = String(v);
    var d = new Date(/T/.test(s) ? s : s.replace(' ', 'T') + 'Z');
    return isNaN(d) ? s : d.toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
  };
  NX.user = null;
  var PERMS = {
    cashier: ['vender', 'caja.abrir', 'caja.cerrar', 'caja.entrada', 'productos.ver'],
    supervisor: ['vender', 'caja.abrir', 'caja.cerrar', 'caja.entrada', 'caja.salida', 'productos.ver', 'productos.editar', 'ventas.anular', 'costos.ver', 'actualizar'],
    owner: ['*']
  };
  NX.can = function (perm) {
    var p = NX.user ? PERMS[NX.user.role] || [] : [];
    return p.indexOf('*') >= 0 || p.indexOf(perm) >= 0;
  };
  NX.store = {
    get: function (k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } }
  };

  var toastTimer;
  NX.toast = function (msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'nx-toast' + (bad ? ' nx-toast--bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 5000 : 3500);
  };

  // ── Modales ────────────────────────────────────────────────────
  var modalStack = [];
  /** NX.modal({ title, html, wide, onKey(e, close), onClose }) → { el, close } */
  NX.modal = function (opts) {
    var overlay = document.createElement('div');
    overlay.className = 'nx-overlay';
    overlay.innerHTML =
      '<div class="nx-modal' + (opts.wide ? ' nx-modal--wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + NX.esc(opts.title) + '">' +
      '<div class="nx-modal-head"><span>' + NX.esc(opts.title) + '</span><button type="button" class="nx-modal-close" aria-label="Cerrar (Esc)">×</button></div>' +
      opts.html + '</div>';
    $('modal-root').appendChild(overlay);
    var entry = { el: overlay, opts: opts, prevFocus: document.activeElement };
    var close = function () {
      if (!overlay.parentNode) return;
      overlay.parentNode.removeChild(overlay);
      modalStack.splice(modalStack.indexOf(entry), 1);
      if (opts.onClose) opts.onClose();
      if (entry.prevFocus && entry.prevFocus.focus) entry.prevFocus.focus();
    };
    entry.close = close;
    modalStack.push(entry);
    overlay.querySelector('.nx-modal-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    var first = overlay.querySelector('[autofocus], input, select, button:not(.nx-modal-close)');
    if (first) setTimeout(function () { first.focus(); if (first.select) first.select(); }, 0);
    return { el: overlay, close: close };
  };
  NX.closeAllModals = function () { modalStack.slice().forEach(function (m) { m.close(); }); };
  NX.confirm = function (title, text, okLabel) {
    return new Promise(function (resolve) {
      var done = false;
      var m = NX.modal({
        title: title,
        html: '<div class="nx-modal-body"><p style="margin:0">' + NX.esc(text) + '</p></div>' +
          '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-no>Esc — No</button>' +
          '<button type="button" class="nx-btn nx-btn--primary" data-yes autofocus>Enter — ' + NX.esc(okLabel || 'Sí') + '</button></div>',
        onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); done = true; close(); resolve(true); } },
        onClose: function () { if (!done) resolve(false); }
      });
      m.el.querySelector('[data-no]').onclick = function () { m.close(); };
      m.el.querySelector('[data-yes]').onclick = function () { done = true; m.close(); resolve(true); };
    });
  };

  // ── Rutas ──────────────────────────────────────────────────────
  var views = {};
  var current = null;
  NX.register = function (name, view) { views[name] = view; };
  function route() {
    var name = (location.hash.replace(/^#\/?/, '') || 'caja').split('?')[0];
    if (!views[name]) name = 'caja';
    if (current && current.name === name) return;
    NX.closeAllModals();
    if (current && current.view.unmount) current.view.unmount();
    var el = $('view');
    el.innerHTML = '';
    current = { name: name, view: views[name] };
    document.querySelectorAll('.nx-modules [data-route]').forEach(function (a) {
      if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    views[name].mount(el);
  }
  NX.go = function (name) { if (location.hash !== '#/' + name) location.hash = '#/' + name; else route(); };

  // ── Teclado global ─────────────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    if (!$('login-root').hidden && !modalStack.length) return; // en la pantalla de acceso no hay atajos
    var top = modalStack[modalStack.length - 1];
    if (top) {
      if (e.key === 'Escape') { e.preventDefault(); top.close(); return; }
      if (top.opts.onKey) top.opts.onKey(e, top.close);
      if (/^F\d+$/.test(e.key)) e.preventDefault();
      return;
    }
    if (e.key === 'F1') { e.preventDefault(); NX.go('caja'); return; }
    if (e.key === 'F3') { e.preventDefault(); NX.go('productos'); return; }
    if (e.key === 'F4') { e.preventDefault(); NX.go('corte'); return; }
    if (current && current.view.onKey) current.view.onKey(e);
  });

  // ── Información y barra inferior ───────────────────────────────
  NX.info = null;
  NX.lastSale = null;
  NX.refreshFooter = function () {
    return NX.api('GET', '/api/sales/today').then(function (t) {
      NX.lastSale = t.lastSale;
      var s = t.lastSale;
      $('f-total').textContent = NX.money(s ? s.total : 0);
      $('f-paid').textContent = NX.money(s ? s.paid : 0);
      $('f-change').textContent = NX.money(s ? s.change : 0);
      $('f-today').textContent = 'Ventas de hoy: ' + t.count + ' · ' + NX.money(t.total);
      $('btn-reprint').disabled = !s;
    }).catch(function () { /* noop */ });
  };

  // ── Ticket 80 mm ───────────────────────────────────────────────
  var METHOD_NAMES = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito' };
  NX.printSale = function (sale) {
    var c = (NX.info && NX.info.company) || {};
    var when = NX.date(sale.paidAt || sale.createdAt);
    var h = '';
    if (sale.status === 'anulada') h += '<div class="tk-center tk-big">*** VENTA ANULADA ***</div>';
    h += '<div class="tk-center tk-big">' + NX.esc(c.trade_name || 'NexoCaja') + '</div>';
    if (c.legal_name && c.legal_name !== c.trade_name) h += '<div class="tk-center">' + NX.esc(c.legal_name) + '</div>';
    if (c.rnc) h += '<div class="tk-center">RNC: ' + NX.esc(c.rnc) + '</div>';
    if (NX.info && NX.info.direccion) h += '<div class="tk-center">' + NX.esc(NX.info.direccion) + '</div>';
    if (NX.info && NX.info.telefono) h += '<div class="tk-center">Tel. ' + NX.esc(NX.info.telefono) + '</div>';
    h += '<hr class="tk-hr"><div class="tk-row"><span>Ticket ' + NX.esc(sale.folio) + '</span><span>' + NX.esc(NX.info ? NX.info.caja : '') + '</span></div>';
    h += '<div>' + NX.esc(when) + '</div>' + (sale.cashier ? '<div>Le atendió: ' + NX.esc(sale.cashier) + '</div>' : '') + '<hr class="tk-hr">';
    sale.lines.forEach(function (l) {
      h += '<div class="tk-item"><div>' + NX.esc(l.name) + (l.taxRate === 0 ? ' (E)' : '') + '</div>' +
        '<div class="tk-row"><span>' + NX.qty(l.qty) + ' x ' + NX.money(l.unitPrice) + (l.priceType === 'mayoreo' ? ' MAY' : '') + '</span><span>' + NX.money(l.lineTotal) + '</span></div>' +
        (l.discount ? '<div class="tk-row"><span>  Desc. ' + NX.qty(l.discountPct) + '%</span><span>-' + NX.money(l.discount) + '</span></div>' : '') + '</div>';
    });
    h += '<hr class="tk-hr">';
    var r = sale.byRate || {};
    if (r[18] && (r[18].base || r[18].tax)) h += '<div class="tk-row"><span>Gravado 18%</span><span>' + NX.money(r[18].base) + '</span></div><div class="tk-row"><span>ITBIS 18%</span><span>' + NX.money(r[18].tax) + '</span></div>';
    if (r[16] && (r[16].base || r[16].tax)) h += '<div class="tk-row"><span>Gravado 16%</span><span>' + NX.money(r[16].base) + '</span></div><div class="tk-row"><span>ITBIS 16%</span><span>' + NX.money(r[16].tax) + '</span></div>';
    if (r[0] && r[0].base) h += '<div class="tk-row"><span>Exento</span><span>' + NX.money(r[0].base) + '</span></div>';
    if (sale.discountTotal) h += '<div class="tk-row"><span>Descuentos</span><span>-' + NX.money(sale.discountTotal) + '</span></div>';
    h += '<div class="tk-row tk-total"><span>TOTAL</span><span>' + NX.money(sale.total) + '</span></div><hr class="tk-hr">';
    sale.payments.forEach(function (p) {
      h += '<div class="tk-row"><span>' + (METHOD_NAMES[p.method] || p.method) + (p.reference ? ' (' + NX.esc(p.reference) + ')' : '') + '</span><span>' + NX.money(p.method === 'efectivo' && p.received ? p.received : p.amount) + '</span></div>';
    });
    if (sale.change) h += '<div class="tk-row"><span>Cambio</span><span>' + NX.money(sale.change) + '</span></div>';
    h += '<hr class="tk-hr"><div class="tk-center">Gracias por su compra</div>';
    h += '<div class="tk-center">DOCUMENTO NO VÁLIDO COMO COMPROBANTE FISCAL</div>';
    h += '<div class="tk-center" style="margin-top:4px">NexoCaja · NexTech360</div>';
    $('print-area').innerHTML = h;
    setTimeout(function () { window.print(); }, 50);
  };

  // ── Actualizaciones ────────────────────────────────────────────
  var LATER_KEY = 'nexocaja-luego';
  var isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  NX.update = { last: null };
  NX.checkUpdate = function (manual) {
    return NX.api('GET', '/api/update/check').then(function (u) {
      NX.update.last = u;
      var canHere = u.local !== false && !isPhone;
      if (u.available && canHere && (manual || NX.store.get(LATER_KEY, '') !== u.latest)) {
        $('upd-version').textContent = 'v' + u.latest;
        $('upd-notes').textContent = u.notes && u.notes.length ? ' — ' + u.notes.join(' · ') : '';
        $('upd-msg').textContent = '';
        $('update-bar').hidden = false;
        $('update-bar').dataset.version = u.latest;
      }
      if (NX.onUpdateInfo) NX.onUpdateInfo(u);
      return u;
    }).catch(function () { return null; });
  };
  function wireUpdateBar() {
    $('btn-later').addEventListener('click', function () {
      NX.store.set(LATER_KEY, $('update-bar').dataset.version || '');
      $('update-bar').hidden = true;
    });
    $('btn-update').addEventListener('click', function () {
      var btn = $('btn-update');
      btn.disabled = true; btn.textContent = 'Actualizando…';
      $('btn-later').disabled = true;
      $('upd-msg').textContent = '';
      fetch('/api/update/apply', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.d.error || 'No se pudo actualizar');
          $('upd-msg').textContent = ' Listo: versión ' + res.d.version + '. Recargando…';
          setTimeout(function () { location.reload(); }, 4000);
        })
        .catch(function (err) {
          $('upd-msg').textContent = ' ✖ ' + err.message;
          btn.disabled = false; btn.textContent = 'Actualizar';
          $('btn-later').disabled = false;
        });
    });
  }

  // ── Vista: Estado del sistema ──────────────────────────────────
  NX.register('estado', {
    mount: function (el) {
      el.innerHTML =
        '<div class="nx-estado"><h1>Estado del sistema</h1><div class="nx-grid">' +
        '<section class="nx-card"><h2>Sistema</h2><dl>' +
        '<dt>Versión</dt><dd class="nx-num" id="s-version">…</dd><dt>Base de datos</dt><dd id="s-db">…</dd>' +
        '<dt>Esquema</dt><dd class="nx-num" id="s-schema">…</dd><dt>Node.js</dt><dd class="nx-num" id="s-node">…</dd>' +
        '<dt>Actualizaciones</dt><dd id="s-update">…</dd></dl>' +
        '<button id="btn-check" class="nx-btn" type="button">Buscar actualizaciones</button></section>' +
        '<section class="nx-card"><h2>Empresa</h2><dl>' +
        '<dt>Razón social</dt><dd id="e-name">…</dd><dt>RNC</dt><dd class="nx-num" id="e-rnc">…</dd>' +
        '<dt>Régimen</dt><dd id="e-regime">…</dd><dt>Caja</dt><dd class="nx-num" id="e-caja">…</dd>' +
        '<dt>Ambiente DGII</dt><dd class="nx-num" id="e-dgii">…</dd></dl>' +
        '<p class="nx-muted">Estos datos se cambian en <code>config.json</code> (luego tendrán su pantalla en Configuración).</p></section>' +
        '</div></div>';
      NX.api('GET', '/api/health').then(function (h) {
        $('s-version').textContent = 'v' + h.version;
        $('s-db').textContent = h.ok ? '✔ Conectada' : '✖ Error';
        $('s-schema').textContent = h.schema || '—';
        $('s-node').textContent = h.node;
      });
      var i = NX.info || {}; var c = i.company || {};
      $('e-name').textContent = c.legal_name || '—';
      $('e-rnc').textContent = c.rnc || 'Sin configurar';
      $('e-regime').textContent = c.tax_regime || '—';
      $('e-caja').textContent = i.caja || '—';
      $('e-dgii').textContent = i.dgiiAmbiente || '—';
      var show = function (u) {
        var s = $('s-update'); if (!s) return;
        s.textContent = !u ? 'Sin conexión para revisar' : u.error ? 'Sin conexión para revisar' : u.available ? 'Disponible v' + u.latest : '✔ Al día';
      };
      NX.onUpdateInfo = show;
      show(NX.update.last);
      $('btn-check').addEventListener('click', function () {
        var b = $('btn-check'); b.disabled = true; b.textContent = 'Buscando…';
        NX.checkUpdate(true).then(function () { b.disabled = false; b.textContent = 'Buscar actualizaciones'; });
      });
    },
    unmount: function () { NX.onUpdateInfo = null; }
  });

  // ── Arranque ───────────────────────────────────────────────────
  var started = false;
  /** Muestra el usuario en el encabezado y oculta lo que su rol no puede usar. */
  NX.applyUser = function () {
    var u = NX.user || {};
    $('h-user').textContent = u.name || '';
    $('h-role').textContent = u.roleName ? '(' + u.roleName + ')' : '';
    document.querySelectorAll('[data-need]').forEach(function (el) { el.hidden = !NX.can(el.getAttribute('data-need')); });
    document.querySelectorAll('[data-owner]').forEach(function (el) { el.hidden = u.role !== 'owner'; });
  };
  NX.resetView = function () { if (current && current.view.unmount) current.view.unmount(); current = null; $('view').innerHTML = ''; };
  NX.start = function () {
    wireUpdateBar();
    $('btn-reprint').addEventListener('click', function () {
      if (NX.lastSale) NX.printSale(NX.lastSale);
    });
    $('btn-sales-day').addEventListener('click', function () { if (NX.openSalesDay) NX.openSalesDay(); });
    NX.api('GET', '/api/info').then(function (i) {
      NX.info = i;
      $('company-name').textContent = (i.company && i.company.trade_name) || '';
      $('h-caja').textContent = i.caja + ' · ' + ((i.company && i.company.branch) || '');
      $('f-version').textContent = 'v' + i.version;
    }).catch(function () {
      NX.toast('No se pudo conectar con NexoCaja. ¿Está abierta la ventana negra (iniciar.bat)?', true);
    }).then(function () {
      NX.auth.boot(function () {
        NX.applyUser();
        if (!started) { started = true; window.addEventListener('hashchange', route); }
        current = null;
        route();
        NX.refreshFooter();
      });
    });
    NX.checkUpdate(false);
    setInterval(function () { NX.checkUpdate(false); }, 6 * 60 * 60 * 1000);
  };
})();
