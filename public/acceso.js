/* NexoCaja · Acceso con PIN, cambio de usuario, autorización de supervisor y ventas del día. */
(function () {
  'use strict';
  var NX = window.NX;
  var $ = NX.$;
  var root = function () { return $('login-root'); };
  var onReady = null;

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
  }
  function keypad() {
    return '<div class="nx-keypad" aria-label="Teclado numérico">' +
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(function (k) {
        return '<button type="button" data-k="' + k + '" aria-label="' + (k === 'C' ? 'Borrar todo' : k === '⌫' ? 'Borrar' : k) + '">' + k + '</button>';
      }).join('') + '</div>';
  }
  function wireKeypad(container, input) {
    container.querySelectorAll('[data-k]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-k');
        if (k === 'C') input.value = '';
        else if (k === '⌫') input.value = input.value.slice(0, -1);
        else if (input.value.length < 6) input.value += k;
        input.focus();
        input.dispatchEvent(new Event('input'));
      });
    });
  }
  function brandHead(title, sub) {
    return '<div class="nx-login-head"><span class="nx-logo" aria-hidden="true">N</span><div><h1>' + NX.esc(title) + '</h1><p>' + NX.esc(sub) + '</p></div></div>';
  }
  function showRoot(html) {
    NX.closeAllModals();
    $('toast').hidden = true;
    var r = root();
    r.innerHTML = html;
    r.hidden = false;
    $('app').setAttribute('aria-hidden', 'true');
  }
  function hideRoot() {
    root().hidden = true;
    root().innerHTML = '';
    $('app').removeAttribute('aria-hidden');
  }

  // ── Primer uso: crear al dueño ─────────────────────────────────
  function showSetup() {
    showRoot('<div class="nx-login">' + brandHead('Bienvenido a NexoCaja', 'Primero crea la cuenta del dueño. Con ella podrás agregar supervisores y cajeros.') +
      '<div class="nx-login-body"><form class="nx-form" data-setup autocomplete="off">' +
      '<div class="nx-field full"><label for="su-name">Tu nombre</label><input id="su-name" maxlength="60" required placeholder="Ej. Erick Nex"></div>' +
      '<div class="nx-field full"><label for="su-user">Usuario</label><input id="su-user" maxlength="30" required placeholder="Ej. erick"><small>Letras y números, sin espacios.</small></div>' +
      '<div class="nx-field"><label for="su-pin">PIN (4 a 6 números)</label><input id="su-pin" class="num" type="password" inputmode="numeric" maxlength="6" required></div>' +
      '<div class="nx-field"><label for="su-pin2">Repite el PIN</label><input id="su-pin2" class="num" type="password" inputmode="numeric" maxlength="6" required></div>' +
      '<div class="nx-error full" data-err hidden></div>' +
      '<div class="full" style="display:flex;justify-content:flex-end"><button type="submit" class="nx-btn nx-btn--primary" style="height:44px;padding:0 18px">Crear dueño y entrar</button></div>' +
      '</form></div></div>');
    var f = root().querySelector('[data-setup]');
    root().querySelector('#su-name').focus();
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = f.querySelector('[data-err]'); err.hidden = true;
      var pin = f.querySelector('#su-pin').value, pin2 = f.querySelector('#su-pin2').value;
      if (!/^\d{4,6}$/.test(pin)) { err.textContent = 'El PIN debe tener de 4 a 6 números.'; err.hidden = false; return; }
      if (pin !== pin2) { err.textContent = 'Los dos PIN no son iguales.'; err.hidden = false; return; }
      NX.api('POST', '/api/auth/setup', { name: f.querySelector('#su-name').value, username: f.querySelector('#su-user').value, pin: pin })
        .then(function (r) { enter(r.user); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    });
  }

  // ── Entrar: elegir usuario y PIN ───────────────────────────────
  function showLogin(users) {
    var html = '<div class="nx-login">' + brandHead('¿Quién va a usar la caja?', 'Toca tu nombre y escribe tu PIN.') +
      '<div class="nx-login-body" data-body><div class="nx-users">' +
      users.map(function (u) {
        return '<button type="button" class="nx-usertile" data-u="' + NX.esc(u.id) + '"><span class="nx-avatar">' + NX.esc(initials(u.name)) + '</span>' +
          '<b>' + NX.esc(u.name) + '</b><small>' + NX.esc(u.roleName || '') + '</small></button>';
      }).join('') + '</div></div></div>';
    showRoot(html);
    var first = root().querySelector('.nx-usertile'); if (first) first.focus();
    root().querySelectorAll('[data-u]').forEach(function (b) {
      b.addEventListener('click', function () {
        var u = users.find(function (x) { return x.id === b.getAttribute('data-u'); });
        askLoginPin(u, users);
      });
    });
  }
  function askLoginPin(u, users) {
    var body = root().querySelector('[data-body]');
    body.innerHTML = '<div class="nx-pinbox"><span class="nx-avatar" style="width:64px;height:64px;font-size:24px">' + NX.esc(initials(u.name)) + '</span>' +
      '<b style="font-size:18px">' + NX.esc(u.name) + '</b>' +
      '<input class="nx-pin-input" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN de ' + NX.esc(u.name) + '">' +
      '<div class="nx-error" data-err hidden></div>' + keypad() +
      '<div style="display:flex;gap:8px"><button type="button" class="nx-btn" data-back>← Otro usuario</button>' +
      '<button type="button" class="nx-btn nx-btn--primary" data-go style="height:40px;padding:0 18px">Entrar</button></div></div>';
    var input = body.querySelector('.nx-pin-input');
    wireKeypad(body, input);
    input.focus();
    var busy = false;
    function go() {
      if (busy) return;
      var err = body.querySelector('[data-err]'); err.hidden = true;
      if (!/^\d{4,6}$/.test(input.value)) { err.textContent = 'Escribe tu PIN de 4 a 6 números.'; err.hidden = false; return; }
      busy = true;
      NX.api('POST', '/api/auth/login', { userId: u.id, pin: input.value }).then(function (r) { enter(r.user); })
        .catch(function (x) { busy = false; input.value = ''; input.focus(); err.textContent = x.message; err.hidden = false; });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') showLogin(users); });
    body.querySelector('[data-go]').onclick = go;
    body.querySelector('[data-back]').onclick = function () { showLogin(users); };
  }

  function enter(user) {
    NX.user = user;
    hideRoot();
    NX.toast('Hola, ' + user.name.split(' ')[0]);
    if (onReady) onReady();
  }

  NX.showLogin = function () {
    if (!root().hidden) return;
    NX.user = null;
    NX.resetView();
    NX.api('GET', '/api/auth/status').then(function (s) {
      if (s.setup) showSetup(); else showLogin(s.users);
    });
  };

  NX.auth = {
    boot: function (ready) {
      onReady = ready;
      NX.api('GET', '/api/auth/status').then(function (s) {
        if (s.user) { NX.user = s.user; ready(); }
        else if (s.setup) showSetup();
        else showLogin(s.users);
      }).catch(function () { NX.toast('No se pudo conectar con NexoCaja', true); });
    }
  };

  // ── Encabezado: cambiar usuario y Mi PIN ───────────────────────
  $('btn-switch').addEventListener('click', function () {
    NX.api('POST', '/api/auth/logout', {}).catch(function () {}).then(function () { NX.showLogin(); });
  });
  $('btn-mypin').addEventListener('click', function () {
    var m = NX.modal({
      title: 'Cambiar mi PIN',
      html: '<div class="nx-modal-body"><div class="nx-form">' +
        '<div class="nx-field full"><label for="mp-cur">PIN actual</label><input id="mp-cur" class="num" type="password" inputmode="numeric" maxlength="6" autofocus></div>' +
        '<div class="nx-field"><label for="mp-new">PIN nuevo (4 a 6 números)</label><input id="mp-new" class="num" type="password" inputmode="numeric" maxlength="6"></div>' +
        '<div class="nx-field"><label for="mp-new2">Repite el PIN nuevo</label><input id="mp-new2" class="num" type="password" inputmode="numeric" maxlength="6"></div>' +
        '</div><div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Guardar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); save(close); } }
    });
    function save(close) {
      var err = m.el.querySelector('[data-err]'); err.hidden = true;
      var cur = m.el.querySelector('#mp-cur').value, n1 = m.el.querySelector('#mp-new').value, n2 = m.el.querySelector('#mp-new2').value;
      if (!/^\d{4,6}$/.test(n1)) { err.textContent = 'El PIN nuevo debe tener de 4 a 6 números.'; err.hidden = false; return; }
      if (n1 !== n2) { err.textContent = 'Los PIN nuevos no son iguales.'; err.hidden = false; return; }
      NX.api('PUT', '/api/users/' + encodeURIComponent(NX.user.id), { pin: n1, currentPin: cur })
        .then(function () { close(); NX.toast('Tu PIN quedó cambiado'); })
        .catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { save(m.close); };
  });

  /**
   * Pide el PIN de un supervisor cuando el usuario no tiene permiso.
   * Devuelve Promise<string|null> (null si no hace falta, o rechaza si cancela).
   */
  NX.askSupervisorPin = function (perm, what) {
    if (NX.can(perm)) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var done = false;
      var m = NX.modal({
        title: 'Autorización de supervisor',
        html: '<div class="nx-modal-body"><p style="margin:0">' + NX.esc(what) + ' necesita que un supervisor o el dueño escriba su PIN.</p>' +
          '<div class="nx-pinbox"><input class="nx-pin-input" type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN del supervisor" autofocus>' + keypad() + '</div></div>' +
          '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Autorizar</button></div>',
        onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } },
        onClose: function () { if (!done) reject(new Error('cancelado')); }
      });
      var input = m.el.querySelector('.nx-pin-input');
      wireKeypad(m.el, input);
      function ok(close) { if (!/^\d{4,6}$/.test(input.value)) return; done = true; var v = input.value; close(); resolve(v); }
      m.el.querySelector('[data-x]').onclick = m.close;
      m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
    });
  };

  // ── Ventas del día y anulaciones ───────────────────────────────
  var METHOD = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transf.', credito: 'Crédito' };
  NX.openSalesDay = function () {
    var m = NX.modal({
      title: 'Ventas del día y anulaciones', wide: true,
      html: '<div class="nx-modal-body"><div class="nx-tablebox" style="max-height:460px;min-height:120px"><table class="nx-table" style="min-width:640px"><thead><tr>' +
        '<th>Ticket</th><th>Hora</th><th>Cajero</th><th>Pago</th><th class="r">Total</th><th class="c">Estado</th><th><span style="position:absolute;left:-9999px">Acciones</span></th>' +
        '</tr></thead><tbody></tbody></table><div class="nx-empty" data-none hidden>Todavía no hay ventas hoy.</div></div></div>'
    });
    function load() {
      NX.api('GET', '/api/sales').then(function (rows) {
        m.el.querySelector('[data-none]').hidden = rows.length > 0;
        m.el.querySelector('tbody').innerHTML = rows.map(function (s) {
          var cancelled = s.status === 'anulada';
          return '<tr data-id="' + NX.esc(s.id) + '" class="' + (cancelled ? 'is-cancelled' : '') + '"><td class="num">' + NX.esc(s.folio) + '</td>' +
            '<td>' + NX.esc(NX.date(s.paidAt)) + '</td><td>' + NX.esc(s.cashier || '') + '</td>' +
            '<td>' + s.methods.map(function (x) { return METHOD[x] || x; }).join(' + ') + '</td><td class="r num">' + NX.money(s.total) + '</td>' +
            '<td class="c"><span class="nx-status ' + (cancelled ? 'nx-status--bad' : 'nx-status--ok') + '">' + (cancelled ? 'Anulada' : 'Pagada') + '</span></td>' +
            '<td class="r" style="white-space:nowrap;text-decoration:none"><button type="button" class="nx-btn nx-btn--sm" data-print>Reimprimir</button> ' +
            (cancelled ? '' : '<button type="button" class="nx-btn nx-btn--sm nx-btn--danger" data-cancel>Anular</button>') + '</td></tr>';
        }).join('');
      }).catch(function (x) { NX.toast(x.message, true); });
    }
    m.el.querySelector('tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-id]'); if (!tr) return;
      var id = tr.getAttribute('data-id');
      if (e.target.closest('[data-print]')) NX.api('GET', '/api/sales/' + encodeURIComponent(id)).then(NX.printSale);
      if (e.target.closest('[data-cancel]')) cancelSale(id, tr.children[0].textContent, load);
    });
    load();
  };

  function cancelSale(id, folio, after) {
    var m = NX.modal({
      title: 'Anular venta ' + folio,
      html: '<div class="nx-modal-body"><p style="margin:0">La venta queda anulada, sale del corte y los productos vuelven al inventario.</p>' +
        '<div class="nx-field"><label for="an-reason">Motivo</label><input id="an-reason" maxlength="200" placeholder="Ej. el cliente devolvió todo" autofocus></div>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Anular venta</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    function ok(close) {
      var reason = m.el.querySelector('#an-reason').value.trim();
      var err = m.el.querySelector('[data-err]');
      if (!reason) { err.textContent = 'Escribe el motivo.'; err.hidden = false; return; }
      NX.askSupervisorPin('ventas.anular', 'Anular una venta').then(function (pin) {
        return NX.api('POST', '/api/sales/' + encodeURIComponent(id) + '/cancel', { reason: reason, authPin: pin || undefined });
      }).then(function () {
        close(); NX.toast('Venta ' + folio + ' anulada'); NX.refreshFooter(); after();
      }).catch(function (x) { if (x.message !== 'cancelado') { err.textContent = x.message; err.hidden = false; } });
    }
    m.el.querySelector('[data-x]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  }
})();
