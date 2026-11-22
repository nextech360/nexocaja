(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LATER_KEY = 'nexocaja-luego';
  var SIX_HOURS = 6 * 60 * 60 * 1000;
  var isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  function getLater() { try { return localStorage.getItem(LATER_KEY); } catch (e) { return null; } }
  function setLater(v) { try { localStorage.setItem(LATER_KEY, v); } catch (e) { /* noop */ } }

  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }

  // ── Estado e información ───────────────────────────────────────
  function loadStatus() {
    Promise.all([
      fetch('/api/health').then(function (r) { return r.json(); }),
      fetch('/api/info').then(function (r) { return r.json(); })
    ]).then(function (res) {
      var h = res[0], i = res[1];
      setText('s-version', 'v' + h.version);
      setText('f-version', 'v' + h.version);
      setText('s-db', h.ok ? '✔ Conectada' : '✖ Error');
      setText('s-schema', h.schema || '—');
      setText('s-node', h.node);
      var c = i.company || {};
      setText('company-name', c.trade_name || '');
      setText('company-sub', i.caja + ' · ' + (c.branch || ''));
      setText('e-name', c.legal_name || '—');
      setText('e-rnc', c.rnc || 'Sin configurar');
      setText('e-regime', c.tax_regime || '—');
      setText('e-caja', i.caja);
      setText('e-dgii', i.dgiiAmbiente);
    }).catch(function () {
      var e = $('error');
      e.textContent = 'No se pudo conectar con NexoCaja. ¿Está abierta la ventana negra (iniciar.bat)?';
      e.hidden = false;
    });
  }

  // ── Actualizaciones ────────────────────────────────────────────
  function checkUpdate(manual) {
    var btn = $('btn-check');
    if (manual) { btn.disabled = true; btn.textContent = 'Buscando…'; }
    return fetch('/api/update/check')
      .then(function (r) { return r.json(); })
      .then(function (u) {
        if (u.error) setText('s-update', 'Sin conexión para revisar');
        else if (u.available) setText('s-update', 'Disponible v' + u.latest);
        else setText('s-update', '✔ Al día');

        var canUpdateHere = u.local !== false && !isPhone;
        if (u.available && canUpdateHere && (manual || getLater() !== u.latest)) {
          setText('upd-version', 'v' + u.latest);
          setText('upd-notes', u.notes && u.notes.length ? ' — ' + u.notes.join(' · ') : '');
          setText('upd-msg', '');
          $('update-bar').hidden = false;
          $('update-bar').dataset.version = u.latest;
        }
      })
      .catch(function () { setText('s-update', 'Sin conexión para revisar'); })
      .then(function () {
        if (manual) { btn.disabled = false; btn.textContent = 'Buscar actualizaciones'; }
      });
  }

  $('btn-later').addEventListener('click', function () {
    setLater($('update-bar').dataset.version || '');
    $('update-bar').hidden = true;
  });

  $('btn-update').addEventListener('click', function () {
    var btn = $('btn-update');
    btn.disabled = true;
    btn.textContent = 'Actualizando…';
    $('btn-later').disabled = true;
    setText('upd-msg', '');
    fetch('/api/update/apply', { method: 'POST' })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'No se pudo actualizar');
        setText('upd-msg', ' Listo: versión ' + res.d.version + '. Recargando…');
        setTimeout(function () { location.reload(); }, 4000);
      })
      .catch(function (err) {
        setText('upd-msg', ' ✖ ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Actualizar';
        $('btn-later').disabled = false;
      });
  });

  $('btn-check').addEventListener('click', function () { checkUpdate(true); });

  loadStatus();
  checkUpdate(false);
  setInterval(function () { checkUpdate(false); }, SIX_HOURS);
})();
