/* NexoCaja · Productos e inventario. */
(function () {
  'use strict';
  var NX = window.NX;
  var root = null;
  var items = [];
  var filter = { q: '', low: false };
  var timer;

  function money(c) { return c == null ? '—' : NX.money(c); }
  function toInputMoney(c) { return c == null ? '' : (c / 100).toFixed(2); }

  function load() {
    return NX.api('GET', '/api/products?limit=1000&q=' + encodeURIComponent(filter.q)).then(function (r) { items = r; paint(); });
  }

  function paint() {
    if (!root) return;
    var list = filter.low ? items.filter(function (p) { return p.low; }) : items;
    var low = items.filter(function (p) { return p.low && !p.out; }).length;
    var out = items.filter(function (p) { return p.out; }).length;
    root.querySelector('[data-alerts]').innerHTML =
      (out ? '<span class="nx-pill nx-pill--bad">' + out + ' agotado' + (out > 1 ? 's' : '') + '</span>' : '') +
      (low ? '<span class="nx-pill nx-pill--warn">' + low + ' con inventario bajo</span>' : '') +
      '<span class="nx-muted" style="font-size:12px">' + items.length + ' producto' + (items.length === 1 ? '' : 's') + (filter.q ? ' encontrados' : '') + '</span>';
    root.querySelector('tbody').innerHTML = list.map(function (p) {
      var cls = p.out ? 'out' : p.low ? 'low' : '';
      return '<tr data-id="' + NX.esc(p.id) + '">' +
        '<td class="num">' + NX.esc(p.barcode || '') + '</td><td class="num">' + NX.esc(p.sku) + '</td>' +
        '<td><b>' + NX.esc(p.name) + '</b></td>' +
        '<td class="r num">' + money(p.cost) + '</td><td class="r num">' + money(p.price) + '</td>' +
        '<td class="r num">' + money(p.wholesalePrice) + (p.wholesaleMinQty ? ' <small class="nx-muted">≥' + NX.qty(p.wholesaleMinQty) + '</small>' : '') + '</td>' +
        '<td class="c num">' + (p.taxRate ? p.taxRate + '%' : 'E') + '</td>' +
        '<td class="c num ' + cls + '">' + (p.trackStock ? NX.qty(p.stock) : 'Ilim') + '</td>' +
        '<td class="c num">' + (p.trackStock ? NX.qty(p.minStock) : '—') + '</td>' +
        '<td class="r" style="white-space:nowrap"><button type="button" class="nx-btn nx-btn--sm" data-edit>Editar</button> ' +
        '<button type="button" class="nx-btn nx-btn--sm nx-btn--danger" data-del>Eliminar</button></td></tr>';
    }).join('');
    var empty = root.querySelector('[data-empty]');
    empty.hidden = list.length > 0;
    empty.innerHTML = items.length || filter.q ? 'No hay productos con ese filtro.'
      : 'Todavía no tienes productos. Agrega el primero con <b>Nuevo producto</b>, o carga <button type="button" class="nx-btn nx-btn--sm" data-demo>10 productos de ejemplo</button> para probar la caja.';
    var demo = empty.querySelector('[data-demo]');
    if (demo) demo.onclick = function () {
      NX.api('POST', '/api/products/demo', {}).then(function (r) { NX.toast(r.count + ' productos de ejemplo cargados'); load(); })
        .catch(function (e) { NX.toast(e.message, true); });
    };
  }

  function openForm(p) {
    var isNew = !p;
    p = p || { taxRate: 18, trackStock: true, stock: 0, minStock: 0 };
    var m = NX.modal({
      title: isNew ? 'Nuevo producto' : 'Editar producto',
      html: '<div class="nx-modal-body"><div class="nx-form">' +
        '<div class="nx-field full"><label for="f-name">Descripción *</label><input id="f-name" maxlength="120" value="' + NX.esc(p.name || '') + '" autofocus></div>' +
        '<div class="nx-field"><label for="f-barcode">Código de barras</label><input id="f-barcode" class="num" maxlength="64" value="' + NX.esc(p.barcode || '') + '" placeholder="Escanéalo aquí"></div>' +
        '<div class="nx-field"><label for="f-sku">Código interno</label><input id="f-sku" class="num" maxlength="64" value="' + NX.esc(p.sku || '') + '" placeholder="Automático (P-0001…)"></div>' +
        '<div class="nx-field"><label for="f-price">Precio de venta (con ITBIS) *</label><input id="f-price" class="num" inputmode="decimal" value="' + toInputMoney(p.price) + '"></div>' +
        '<div class="nx-field"><label for="f-cost">Costo</label><input id="f-cost" class="num" inputmode="decimal" value="' + toInputMoney(p.cost) + '"><small data-margin></small></div>' +
        '<div class="nx-field"><label for="f-wprice">Precio de mayoreo</label><input id="f-wprice" class="num" inputmode="decimal" value="' + toInputMoney(p.wholesalePrice) + '" placeholder="Opcional"></div>' +
        '<div class="nx-field"><label for="f-wmin">Mayoreo a partir de (unidades)</label><input id="f-wmin" class="num" inputmode="decimal" value="' + (p.wholesaleMinQty || '') + '" placeholder="Opcional; F11 lo fuerza"></div>' +
        '<div class="nx-field"><label for="f-tax">ITBIS</label><select id="f-tax"><option value="18">18%</option><option value="16">16%</option><option value="0">Exento</option></select></div>' +
        '<div class="nx-field"><label for="f-unit">Unidad</label><select id="f-unit"><option>unidad</option><option>lb</option><option>kg</option><option>litro</option><option>caja</option><option>paquete</option></select></div>' +
        '<div class="nx-field"><label for="f-stock">Existencia actual</label><input id="f-stock" class="num" inputmode="decimal" value="' + (p.stock != null ? p.stock : 0) + '"></div>' +
        '<div class="nx-field"><label for="f-min">Inventario mínimo (alerta)</label><input id="f-min" class="num" inputmode="decimal" value="' + (p.minStock != null ? p.minStock : 0) + '"></div>' +
        '<label class="nx-check full"><input type="checkbox" id="f-track"' + (p.trackStock !== false ? ' checked' : '') + '> Controlar inventario (desmarca para servicios)</label>' +
        '</div><div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-cancel>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-save>Enter — Guardar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); save(close); } }
    });
    var el = m.el;
    el.querySelector('#f-tax').value = String(p.taxRate);
    el.querySelector('#f-unit').value = p.unit || 'unidad';
    function margin() {
      var pr = NX.parseMoney(el.querySelector('#f-price').value), co = NX.parseMoney(el.querySelector('#f-cost').value);
      var tax = +el.querySelector('#f-tax').value;
      var s = el.querySelector('[data-margin]');
      if (pr > 0 && co > 0) {
        var base = pr * 100 / (100 + tax);
        s.textContent = 'Ganancia estimada: ' + NX.money(Math.round(base - co)) + ' (' + Math.round((base - co) / co * 100) + '% sobre costo)';
      } else s.textContent = '';
    }
    ['#f-price', '#f-cost'].forEach(function (s) { el.querySelector(s).addEventListener('input', margin); });
    el.querySelector('#f-tax').addEventListener('change', margin);
    margin();
    function num(sel) { var v = String(el.querySelector(sel).value).trim().replace(',', '.'); return v === '' ? null : Number(v); }
    function save(close) {
      var err = el.querySelector('[data-err]'); err.hidden = true;
      var price = NX.parseMoney(el.querySelector('#f-price').value);
      var costRaw = el.querySelector('#f-cost').value.trim();
      var wRaw = el.querySelector('#f-wprice').value.trim();
      var body = {
        name: el.querySelector('#f-name').value.trim(),
        barcode: el.querySelector('#f-barcode').value.trim(),
        sku: el.querySelector('#f-sku').value.trim(),
        price: price,
        cost: costRaw ? NX.parseMoney(costRaw) : 0,
        wholesalePrice: wRaw ? NX.parseMoney(wRaw) : null,
        wholesaleMinQty: num('#f-wmin'),
        taxRate: +el.querySelector('#f-tax').value,
        unit: el.querySelector('#f-unit').value,
        stock: num('#f-stock') || 0,
        minStock: num('#f-min') || 0,
        trackStock: el.querySelector('#f-track').checked
      };
      var problem = !body.name ? 'Escribe la descripción.' : !(price > 0) ? 'Escribe un precio de venta mayor que 0.'
        : isNaN(body.cost) ? 'El costo no es válido.' : (wRaw && !(body.wholesalePrice > 0)) ? 'El precio de mayoreo no es válido.'
        : [body.stock, body.minStock].some(isNaN) ? 'Revisa la existencia y el mínimo.' : '';
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      var req = isNew ? NX.api('POST', '/api/products', body) : NX.api('PUT', '/api/products/' + encodeURIComponent(p.id), body);
      req.then(function (saved) {
        close();
        NX.toast((isNew ? 'Producto creado: ' : 'Producto guardado: ') + saved.name);
        load();
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; });
    }
    el.querySelector('[data-cancel]').onclick = m.close;
    el.querySelector('[data-save]').onclick = function () { save(m.close); };
  }

  NX.register('productos', {
    mount: function (el) {
      root = el;
      el.innerHTML =
        '<div class="nx-page"><div class="nx-page-head"><h1>Productos e inventario</h1>' +
        '<input class="nx-search" type="search" placeholder="Buscar por nombre o código…" aria-label="Buscar productos" value="' + NX.esc(filter.q) + '">' +
        '<label class="nx-check"><input type="checkbox" data-low' + (filter.low ? ' checked' : '') + '> Solo inventario bajo</label>' +
        '<span class="nx-spacer"></span><button type="button" class="nx-btn nx-btn--primary" data-new><kbd class="nx-key">INS</kbd>Nuevo producto</button></div>' +
        '<div class="nx-page-body"><div class="nx-alerts" data-alerts></div>' +
        '<div class="nx-tablebox"><table class="nx-table" style="min-width:1000px"><thead><tr>' +
        '<th>Código de barras</th><th>Interno</th><th>Descripción</th><th class="r">Costo</th><th class="r">Precio</th><th class="r">Mayoreo</th>' +
        '<th class="c">ITBIS</th><th class="c">Existencia</th><th class="c">Mínimo</th><th><span style="position:absolute;left:-9999px">Acciones</span></th>' +
        '</tr></thead><tbody></tbody></table><div class="nx-empty" data-empty hidden></div></div></div></div>';
      var search = el.querySelector('.nx-search');
      search.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { filter.q = search.value.trim(); load(); }, 200); });
      el.querySelector('[data-low]').addEventListener('change', function (e) { filter.low = e.target.checked; paint(); });
      el.querySelector('[data-new]').addEventListener('click', function () { openForm(null); });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (!tr) return;
        var p = items.find(function (x) { return x.id === tr.getAttribute('data-id'); });
        if (!p) return;
        if (e.target.closest('[data-edit]')) openForm(p);
        if (e.target.closest('[data-del]')) {
          NX.confirm('Eliminar producto', '¿Eliminar ' + p.name + '? Las ventas anteriores se conservan.', 'Eliminar').then(function (ok) {
            if (!ok) return;
            NX.api('DELETE', '/api/products/' + encodeURIComponent(p.id)).then(function () { NX.toast('Producto eliminado'); load(); })
              .catch(function (er) { NX.toast(er.message, true); });
          });
        }
      });
      el.querySelector('tbody').addEventListener('dblclick', function (e) {
        var tr = e.target.closest('tr[data-id]'); if (!tr) return;
        var p = items.find(function (x) { return x.id === tr.getAttribute('data-id'); }); if (p) openForm(p);
      });
      load();
      search.focus();
    },
    unmount: function () { root = null; },
    onKey: function (e) {
      if (e.key === 'Insert') { e.preventDefault(); openForm(null); }
    }
  });
})();
