/* NexoCaja · Usuarios (solo el dueño). */
(function () {
  'use strict';
  var NX = window.NX;
  var root = null, users = [];
  var ROLE_HELP = {
    cashier: 'Vende, cobra, abre y cierra su caja. No ve costos ni ganancias. Para anular o sacar efectivo necesita a un supervisor.',
    supervisor: 'Todo lo del cajero, más: editar productos y precios, anular ventas, salidas de efectivo, ver ganancias y actualizar NexoCaja.',
    owner: 'Acceso total, incluida la administración de usuarios.'
  };

  function load() { NX.api('GET', '/api/users').then(function (r) { users = r; paint(); }).catch(function (x) { if (x.status !== 401) NX.toast(x.message, true); }); }

  function paint() {
    if (!root) return;
    root.querySelector('tbody').innerHTML = users.map(function (u) {
      return '<tr data-id="' + NX.esc(u.id) + '" class="' + (u.active ? '' : 'is-cancelled') + '"><td><b>' + NX.esc(u.name) + '</b>' + (u.id === NX.user.id ? ' <span class="nx-tag">tú</span>' : '') + '</td>' +
        '<td class="num">' + NX.esc(u.username) + '</td><td>' + NX.esc(u.roleName) + '</td>' +
        '<td class="c"><span class="nx-status ' + (u.active ? 'nx-status--ok' : 'nx-status--muted') + '">' + (u.active ? 'Activo' : 'Inactivo') + '</span></td>' +
        '<td class="r" style="white-space:nowrap;text-decoration:none"><button type="button" class="nx-btn nx-btn--sm" data-edit>Editar</button></td></tr>';
    }).join('');
  }

  function form(u) {
    var isNew = !u;
    u = u || { role: 'cashier', active: true };
    var m = NX.modal({
      title: isNew ? 'Nuevo usuario' : 'Editar usuario',
      html: '<div class="nx-modal-body"><div class="nx-form">' +
        '<div class="nx-field full"><label for="us-name">Nombre</label><input id="us-name" maxlength="60" value="' + NX.esc(u.name || '') + '" autofocus></div>' +
        '<div class="nx-field"><label for="us-user">Usuario</label><input id="us-user" maxlength="30" value="' + NX.esc(u.username || '') + '"></div>' +
        '<div class="nx-field"><label for="us-role">Rol</label><select id="us-role"><option value="cashier">Cajero</option><option value="supervisor">Supervisor</option><option value="owner">Dueño</option></select></div>' +
        '<p class="nx-muted full" data-help style="margin:0;font-size:12px"></p>' +
        '<div class="nx-field"><label for="us-pin">' + (isNew ? 'PIN (4 a 6 números)' : 'PIN nuevo (déjalo vacío para no cambiarlo)') + '</label><input id="us-pin" class="num" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>' +
        '<div class="nx-field"><label for="us-pin2">Repite el PIN</label><input id="us-pin2" class="num" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password"></div>' +
        (isNew ? '' : '<label class="nx-check full"><input type="checkbox" id="us-active"' + (u.active ? ' checked' : '') + '> Usuario activo (desmárcalo para quitarle el acceso; sus ventas se conservan)</label>') +
        '</div><div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-x>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Guardar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); save(close); } }
    });
    var el = m.el, role = el.querySelector('#us-role');
    role.value = u.role;
    var help = function () { el.querySelector('[data-help]').textContent = ROLE_HELP[role.value]; };
    role.addEventListener('change', help); help();
    function save(close) {
      var err = el.querySelector('[data-err]'); err.hidden = true;
      var pin = el.querySelector('#us-pin').value, pin2 = el.querySelector('#us-pin2').value;
      if ((isNew || pin) && !/^\d{4,6}$/.test(pin)) { err.textContent = 'El PIN debe tener de 4 a 6 números.'; err.hidden = false; return; }
      if (pin !== pin2) { err.textContent = 'Los dos PIN no son iguales.'; err.hidden = false; return; }
      var body = { name: el.querySelector('#us-name').value, username: el.querySelector('#us-user').value, role: role.value };
      if (pin) body.pin = pin;
      if (!isNew) body.active = el.querySelector('#us-active').checked;
      var req = isNew ? NX.api('POST', '/api/users', body) : NX.api('PUT', '/api/users/' + encodeURIComponent(u.id), body);
      req.then(function (saved) {
        close(); NX.toast(isNew ? 'Usuario creado: ' + saved.name : 'Usuario guardado');
        if (saved.id === NX.user.id) { NX.user.name = saved.name; NX.user.role = saved.role; NX.user.roleName = saved.roleName; NX.applyUser(); }
        load();
      }).catch(function (x) { err.textContent = x.message; err.hidden = false; });
    }
    el.querySelector('[data-x]').onclick = m.close;
    el.querySelector('[data-ok]').onclick = function () { save(m.close); };
  }

  NX.register('usuarios', {
    mount: function (el) {
      if (!NX.user || NX.user.role !== 'owner') { NX.go('caja'); return; }
      root = el;
      el.innerHTML = '<div class="nx-page"><div class="nx-page-head"><h1>Usuarios</h1><span class="nx-muted">Cada persona entra con su propio PIN. Todo lo que hace queda registrado a su nombre.</span>' +
        '<span class="nx-spacer"></span><button type="button" class="nx-btn nx-btn--primary" data-new><kbd class="nx-key">INS</kbd>Nuevo usuario</button></div>' +
        '<div class="nx-page-body"><div class="nx-tablebox"><table class="nx-table" style="min-width:640px"><thead><tr>' +
        '<th>Nombre</th><th>Usuario</th><th>Rol</th><th class="c">Estado</th><th><span style="position:absolute;left:-9999px">Acciones</span></th>' +
        '</tr></thead><tbody></tbody></table></div></div></div>';
      el.querySelector('[data-new]').addEventListener('click', function () { form(null); });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (!tr || !e.target.closest('[data-edit]')) return;
        form(users.find(function (x) { return x.id === tr.getAttribute('data-id'); }));
      });
      load();
    },
    unmount: function () { root = null; },
    onKey: function (e) { if (e.key === 'Insert') { e.preventDefault(); form(null); } }
  });
})();
