/* NexoCaja · Pantalla de Ventas / Caja (estilo caja clásica). */
(function () {
  'use strict';
  var NX = window.NX;
  var $ = NX.$;
  var KEY = 'nexocaja-tickets';
  var DISC_STEPS = [0, 5, 10, 15];

  var st = NX.store.get(KEY, null) || { tickets: [{ id: 1, lines: [], wholesale: false }], active: 0, seq: 1, sel: 0 };
  if (!st.tickets.length) st.tickets = [{ id: 1, lines: [], wholesale: false }];
  function save() { NX.store.set(KEY, st); }
  function ticket() { return st.tickets[st.active] || st.tickets[0]; }

  // ── Cálculos (igual que el servidor; el total final lo confirma el servidor al cobrar) ──
  function unitPrice(l, t) {
    if (l.varios) return l.unitPrice;
    var useW = l.wholesalePrice && (t.wholesale || (l.wholesaleMinQty && l.qty >= l.wholesaleMinQty));
    return useW ? l.wholesalePrice : l.price;
  }
  function isWholesale(l, t) { return !l.varios && l.wholesalePrice && unitPrice(l, t) === l.wholesalePrice && l.wholesalePrice !== l.price; }
  function calc(t) {
    var r = { total: 0, disc: 0, items: 0, g18: 0, t18: 0, g16: 0, t16: 0, ex: 0 };
    t.lines.forEach(function (l) {
      var gross = Math.round(unitPrice(l, t) * l.qty);
      var d = Math.round(gross * (l.discountPct || 0) / 100);
      var lt = gross - d;
      l._total = lt;
      r.total += lt; r.disc += d; r.items += l.qty;
      if (l.taxRate) {
        var base = Math.round(lt * 100 / (100 + l.taxRate));
        if (l.taxRate === 18) { r.g18 += base; r.t18 += lt - base; } else { r.g16 += base; r.t16 += lt - base; }
      } else { r.ex += lt; }
    });
    return r;
  }

  // ── Plantilla ──────────────────────────────────────────────────
  var root = null;
  function render() {
    if (!root) return;
    var t = ticket();
    if (st.sel >= t.lines.length) st.sel = Math.max(0, t.lines.length - 1);
    var c = calc(t);
    var rows = t.lines.map(function (l, i) {
      var left = l.trackStock ? l.stock - l.qty : null;
      var stockCls = left == null ? '' : left < 0 ? 'out' : left <= l.minStock ? 'low' : '';
      var tag = (l.discountPct ? '<span class="nx-tag">−' + NX.qty(l.discountPct) + '%</span>' : '') + (isWholesale(l, t) ? '<span class="nx-tag">MAYOREO</span>' : '');
      return '<tr data-i="' + i + '" class="' + (i === st.sel ? 'is-sel' : '') + '">' +
        '<td class="num">' + NX.esc(l.code || '—') + '</td>' +
        '<td><b>' + NX.esc(l.name) + '</b>' + tag + '</td>' +
        '<td class="r num">' + NX.money(unitPrice(l, t)) + '</td>' +
        '<td class="c"><span class="nx-qty"><button type="button" data-act="dec" aria-label="Restar uno">−</button><span>' + NX.qty(l.qty) + '</span><button type="button" data-act="inc" aria-label="Sumar uno">+</button></span></td>' +
        '<td class="c num">' + (l.taxRate ? l.taxRate + '%' : 'E') + '</td>' +
        '<td class="amount">' + NX.money(l._total) + '</td>' +
        '<td class="c num ' + stockCls + '">' + (l.trackStock ? NX.qty(l.stock) : 'Ilim') + '</td></tr>';
    }).join('');
    var tabs = st.tickets.map(function (tk, i) {
      var n = tk.lines.length;
      return '<button type="button" role="tab" class="nx-tab" data-tab="' + i + '" aria-selected="' + (i === st.active) + '">Ticket ' + tk.id + (i === st.active ? '' : ' · pendiente (' + n + ')') + '</button>';
    }).join('');

    root.querySelector('[data-band-title]').textContent = 'VENTA — Ticket ' + t.id;
    paintFiscal(t);
    root.querySelector('[data-wholesale-chip]').hidden = !t.wholesale;
    root.querySelector('[data-mayoreo]').setAttribute('aria-pressed', String(!!t.wholesale));
    root.querySelector('[data-tabs]').innerHTML = tabs + '<button type="button" class="nx-tab nx-tab--new" data-newtab>+ Nuevo ticket</button>';
    root.querySelector('tbody').innerHTML = rows;
    root.querySelector('[data-empty]').hidden = t.lines.length > 0;
    root.querySelector('[data-count]').textContent = NX.qty(c.items);
    root.querySelector('[data-breakdown]').innerHTML =
      '<span>Gravado ' + NX.money(c.g18 + c.g16) + '</span><span>ITBIS 18% ' + NX.money(c.t18) + '</span><span>ITBIS 16% ' + NX.money(c.t16) + '</span>' +
      '<span>Exento ' + NX.money(c.ex) + '</span><span>Desc. ' + NX.money(c.disc) + '</span>';
    root.querySelector('[data-total]').textContent = NX.money(c.total);
    root.querySelector('[data-cobrar]').disabled = !t.lines.length;
    var sel = root.querySelector('tr.is-sel');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    save();
  }

  function fiscalOn() { var st0 = NX.fiscal.status; return !!(st0 && st0.mode === 'NCF'); }
  function paintFiscal(t) {
    var stt = NX.fiscal.status;
    var chip = root.querySelector('[data-doc-chip]');
    var bar = root.querySelector('[data-fiscal]');
    var cust = t.customer
      ? '<b>' + NX.esc(t.customer.name) + '</b>' + (t.customer.docFormatted ? ' <span class="nx-num">· ' + (t.customer.docType === 'RNC' ? 'RNC ' : 'Céd. ') + NX.esc(t.customer.docFormatted) + '</span>' : '')
      : '<b>Consumidor final</b>';
    var html = '<span class="nx-fb-label">Cliente:</span> ' + cust +
      ' <button type="button" class="nx-btn nx-btn--sm" data-cust><kbd class="nx-key">F2</kbd>' + (t.customer ? 'Cambiar' : 'Elegir cliente') + '</button>' +
      (t.customer ? ' <button type="button" class="nx-btn nx-btn--sm" data-nocust>Quitar</button>' : '');
    if (fiscalOn()) {
      var type = t.ncfType || '02';
      html += '<span class="nx-spacer"></span><span class="nx-fb-label">Comprobante:</span><span role="group" aria-label="Tipo de comprobante" class="nx-fb-types">' +
        stt.types.map(function (ty) {
          return '<button type="button" class="nx-btn nx-btn--sm" data-ncf="' + ty.code + '" aria-pressed="' + (ty.code === type) + '"' + (ty.available ? '' : ' disabled title="Sin secuencia disponible"') + '>' +
            NX.esc(ty.name) + ' <span class="nx-num" style="font-size:11px">B' + ty.code + (ty.available ? ' · ' + ty.remaining : ' · 0') + '</span></button>';
        }).join('') + '</span>';
      var cur = stt.types.find(function (x) { return x.code === type; }) || {};
      chip.textContent = (NX.NCF_NAMES[type] || '') + (cur.nextNcf ? ' · próximo NCF ' + cur.nextNcf : ' · SIN NCF DISPONIBLE');
      chip.className = 'nx-chip' + (cur.available ? '' : ' nx-chip--warn');
    } else {
      chip.textContent = 'Ticket de venta (sin comprobante fiscal)';
      chip.className = 'nx-chip';
    }
    var alerts = stt && stt.alerts && stt.alerts.length ? '<div class="nx-fb-alerts">' + stt.alerts.map(function (a) { return '<span class="nx-pill ' + (a.level === 'bad' ? 'nx-pill--bad' : 'nx-pill--warn') + '">' + NX.esc(a.text) + '</span>'; }).join('') + '</div>' : '';
    bar.innerHTML = '<div class="nx-fb-row">' + html + '</div>' + alerts;
  }
  function chooseCustomer() {
    NX.pickCustomer(function (c) { ticket().customer = c || null; render(); focusCode(); });
  }
  function setNcfType(code) { ticket().ncfType = code; render(); focusCode(); }
  /** Revisa en la caja lo que el servidor exigiría, para avisar antes de abrir el cobro. */
  function fiscalProblem(t) {
    if (!fiscalOn()) return '';
    var type = t.ncfType || '02';
    var ty = NX.fiscal.status.types.find(function (x) { return x.code === type; });
    if (!ty || !ty.available) return 'No hay NCF de ' + (ty ? ty.name : 'ese tipo') + ' disponibles. El dueño debe registrar una secuencia en Configuración fiscal.';
    if (ty.needsDoc && !(t.customer && t.customer.docNumber)) return 'La ' + NX.NCF_NAMES[type] + ' necesita un cliente con RNC o cédula.';
    if (type === '15' && t.customer.docType !== 'RNC') return 'La factura Gubernamental necesita el RNC de la institución.';
    return '';
  }

  function focusCode() { var i = root && root.querySelector('#codigo'); if (i) i.focus(); }

  // ── Acciones ───────────────────────────────────────────────────
  function addProduct(p, qty) {
    var t = ticket();
    qty = qty || 1;
    var idx = -1;
    t.lines.forEach(function (l, i) { if (!l.varios && l.productId === p.id) idx = i; });
    if (idx >= 0) {
      t.lines[idx].qty = +(t.lines[idx].qty + qty).toFixed(3);
      Object.assign(t.lines[idx], { price: p.price, wholesalePrice: p.wholesalePrice, wholesaleMinQty: p.wholesaleMinQty, taxRate: p.taxRate, stock: p.stock, minStock: p.minStock, trackStock: p.trackStock });
    } else {
      t.lines.push({ productId: p.id, code: p.barcode || p.sku, name: p.name, price: p.price, wholesalePrice: p.wholesalePrice,
        wholesaleMinQty: p.wholesaleMinQty, taxRate: p.taxRate, qty: qty, discountPct: 0, stock: p.stock, minStock: p.minStock, trackStock: p.trackStock });
      idx = t.lines.length - 1;
    }
    st.sel = idx;
    var l = t.lines[idx];
    if (l.trackStock && l.stock - l.qty < 0) NX.toast('Atención: ' + l.name + ' solo tiene ' + NX.qty(l.stock) + ' en existencia', true);
    render();
  }

  function addFromCode() {
    var input = root.querySelector('#codigo');
    var raw = input.value.trim();
    if (!raw) return;
    var qty = 1, code = raw;
    var m = raw.match(/^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/);   // 3*7460000000011
    if (m) { qty = parseFloat(m[1].replace(',', '.')); code = m[2].trim(); }
    if (!(qty > 0)) { NX.toast('Cantidad inválida', true); return; }
    NX.api('GET', '/api/products/code/' + encodeURIComponent(code)).then(function (p) {
      input.value = '';
      addProduct(p, qty);
    }).catch(function () {
      openSearch(code, qty);
    });
  }

  function changeQty(delta) {
    var t = ticket(); var l = t.lines[st.sel]; if (!l) return;
    var q = +(l.qty + delta).toFixed(3);
    if (q <= 0) { t.lines.splice(st.sel, 1); } else { l.qty = q; }
    render();
  }
  function removeSel() { var t = ticket(); if (!t.lines[st.sel]) return; t.lines.splice(st.sel, 1); render(); focusCode(); }
  function cycleDiscount() {
    var l = ticket().lines[st.sel]; if (!l) return;
    var i = DISC_STEPS.indexOf(l.discountPct || 0);
    l.discountPct = DISC_STEPS[(i + 1) % DISC_STEPS.length];
    render();
  }
  function toggleWholesale() { var t = ticket(); t.wholesale = !t.wholesale; render(); focusCode(); }
  function newTicket() {
    st.seq += 1;
    st.tickets.push({ id: st.seq, lines: [], wholesale: false });
    st.active = st.tickets.length - 1; st.sel = 0;
    render(); focusCode();
  }
  function hold() {
    if (!ticket().lines.length) return;
    var id = ticket().id;
    newTicket();
    NX.toast('Ticket ' + id + ' quedó pendiente. Lo encuentras en las pestañas.');
  }
  function closeTicket() {
    st.tickets.splice(st.active, 1);
    if (!st.tickets.length) { st.seq += 1; st.tickets.push({ id: st.seq, lines: [], wholesale: false }); }
    st.active = Math.min(st.active, st.tickets.length - 1); st.sel = 0;
  }
  function cancelTicket() {
    if (!ticket().lines.length) return;
    NX.confirm('Anular venta', '¿Borrar todos los artículos del Ticket ' + ticket().id + '?', 'Anular').then(function (ok) {
      if (!ok) return;
      closeTicket(); render(); focusCode();
    });
  }

  // ── F10 Buscar ─────────────────────────────────────────────────
  function openSearch(q, qty) {
    var results = []; var hi = 0; var timer;
    var m = NX.modal({
      title: 'F10 — Buscar producto', wide: true,
      html: '<div class="nx-modal-body"><div class="nx-field"><label for="bq">Nombre, código de barras o código interno</label>' +
        '<input id="bq" autocomplete="off" value="' + NX.esc(q || '') + '" placeholder="Ej. leche, 7460…"></div>' +
        '<div class="nx-tablebox" style="max-height:380px;min-height:120px"><table class="nx-table" style="min-width:600px"><thead><tr>' +
        '<th>Código</th><th>Descripción</th><th class="r">Precio</th><th class="c">ITBIS</th><th class="c">Exist.</th><th><span style="position:absolute;left:-9999px">Acción</span></th>' +
        '</tr></thead><tbody></tbody></table><div class="nx-empty" data-none hidden>Sin resultados. Créalo en Productos (F3).</div></div></div>',
      onKey: function (e, close) {
        if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(hi + 1, results.length - 1); paint(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, 0); paint(); }
        if (e.key === 'Enter') { e.preventDefault(); pick(hi, close); }
      }
    });
    var input = m.el.querySelector('#bq');
    function pick(i, close) {
      var p = results[i]; if (!p) return;
      close(); addProduct(p, qty || 1);
      var ci = root && root.querySelector('#codigo'); if (ci) ci.value = '';
      focusCode();
    }
    function paint() {
      m.el.querySelector('tbody').innerHTML = results.map(function (p, i) {
        var cls = p.out ? 'out' : p.low ? 'low' : '';
        return '<tr class="' + (i === hi ? 'is-sel' : '') + '" data-i="' + i + '"><td class="num">' + NX.esc(p.barcode || p.sku) + '</td><td><b>' + NX.esc(p.name) + '</b></td>' +
          '<td class="r num">' + NX.money(p.price) + '</td><td class="c num">' + (p.taxRate ? p.taxRate + '%' : 'E') + '</td>' +
          '<td class="c num ' + cls + '">' + (p.trackStock ? NX.qty(p.stock) : 'Ilim') + '</td>' +
          '<td class="r"><button type="button" class="nx-btn nx-btn--sm" data-pick="' + i + '">Agregar</button></td></tr>';
      }).join('');
      m.el.querySelector('[data-none]').hidden = results.length > 0;
      var s = m.el.querySelector('tr.is-sel'); if (s) s.scrollIntoView({ block: 'nearest' });
    }
    function load() {
      NX.api('GET', '/api/products?limit=100&q=' + encodeURIComponent(input.value.trim())).then(function (r) { results = r; hi = 0; paint(); });
    }
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(load, 150); });
    m.el.querySelector('tbody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]');
      var tr = e.target.closest('tr[data-i]');
      if (b) pick(+b.getAttribute('data-pick'), m.close);
      else if (tr) { hi = +tr.getAttribute('data-i'); paint(); }
    });
    m.el.querySelector('tbody').addEventListener('dblclick', function (e) {
      var tr = e.target.closest('tr[data-i]'); if (tr) pick(+tr.getAttribute('data-i'), m.close);
    });
    load();
  }

  // ── INS Artículo varios ────────────────────────────────────────
  function openVarios() {
    var m = NX.modal({
      title: 'INS — Artículo varios (sin código)',
      html: '<div class="nx-modal-body"><div class="nx-form">' +
        '<div class="nx-field full"><label for="v-name">Descripción</label><input id="v-name" value="ARTÍCULO VARIOS"></div>' +
        '<div class="nx-field"><label for="v-price">Precio (con ITBIS)</label><input id="v-price" class="num" inputmode="decimal" placeholder="0.00" autofocus></div>' +
        '<div class="nx-field"><label for="v-qty">Cantidad</label><input id="v-qty" class="num" inputmode="decimal" value="1"></div>' +
        '<div class="nx-field"><label for="v-tax">ITBIS</label><select id="v-tax"><option value="18">18%</option><option value="16">16%</option><option value="0">Exento</option></select></div>' +
        '</div><div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-cancel>Esc — Cancelar</button><button type="button" class="nx-btn nx-btn--primary" data-ok>Enter — Agregar</button></div>',
      onKey: function (e, close) { if (e.key === 'Enter') { e.preventDefault(); ok(close); } }
    });
    function ok(close) {
      var name = m.el.querySelector('#v-name').value.trim();
      var price = NX.parseMoney(m.el.querySelector('#v-price').value);
      var qty = parseFloat(String(m.el.querySelector('#v-qty').value).replace(',', '.'));
      var err = m.el.querySelector('[data-err]');
      if (!name || !(price > 0) || !(qty > 0)) { err.textContent = 'Escribe la descripción, un precio mayor que 0 y la cantidad.'; err.hidden = false; return; }
      ticket().lines.push({ varios: true, name: name.toUpperCase(), unitPrice: price, qty: qty, taxRate: +m.el.querySelector('#v-tax').value, discountPct: 0, trackStock: false });
      st.sel = ticket().lines.length - 1;
      close(); render(); focusCode();
    }
    m.el.querySelector('[data-cancel]').onclick = m.close;
    m.el.querySelector('[data-ok]').onclick = function () { ok(m.close); };
  }

  // ── F12 Cobrar ─────────────────────────────────────────────────
  function linesPayload(t) {
    return t.lines.map(function (l) {
      return l.varios ? { name: l.name, unitPrice: l.unitPrice, qty: l.qty, taxRate: l.taxRate, discountPct: l.discountPct || 0 }
        : { productId: l.productId, qty: l.qty, discountPct: l.discountPct || 0 };
    });
  }
  function openCobro() {
    var t = ticket();
    if (!t.lines.length) return;
    var problem = fiscalProblem(t);
    if (problem) { NX.toast(problem, true); if (/cliente/.test(problem)) chooseCustomer(); return; }
    var payload = { lines: linesPayload(t), wholesale: !!t.wholesale };
    if (fiscalOn()) payload.ncfType = t.ncfType || '02';
    if (t.customer) payload.customerId = t.customer.id;
    NX.api('POST', '/api/sales/quote', payload).then(function (q) {
      if (fiscalOn() && payload.ncfType === '02' && q.total >= NX.fiscal.status.consumoThreshold && !(t.customer && t.customer.docNumber)) {
        NX.toast('Las facturas de consumo de RD$250,000 o más deben identificar al comprador. Elige el cliente con F2.', true);
        chooseCustomer(); return;
      }
      showCobro(t, payload, q.total);
    })
      .catch(function (err) { NX.toast(err.message, true); });
  }
  function showCobro(t, payload, total) {
    var method = 'efectivo'; var busy = false;
    var printPref = NX.store.get('nexocaja-imprimir', true);
    var m = NX.modal({
      title: 'F12 — Cobrar Ticket ' + t.id + (payload.ncfType ? ' · ' + NX.NCF_NAMES[payload.ncfType] : ''),
      html: '<div class="nx-modal-body">' +
        '<div class="nx-big-total"><span>TOTAL A COBRAR</span><b>' + NX.money(total) + '</b></div>' +
        '<div class="nx-methods" role="group" aria-label="Forma de pago">' +
        '<button type="button" class="nx-btn" data-m="efectivo"><kbd class="nx-key">F1</kbd>Efectivo</button>' +
        '<button type="button" class="nx-btn" data-m="tarjeta"><kbd class="nx-key">F2</kbd>Tarjeta</button>' +
        '<button type="button" class="nx-btn" data-m="transferencia"><kbd class="nx-key">F3</kbd>Transferencia</button>' +
        '<button type="button" class="nx-btn" data-m="mixto"><kbd class="nx-key">F4</kbd>Mixto</button></div>' +
        '<div class="nx-field" data-cash><label for="c-cash" data-cash-label>Pagó con (efectivo)</label><input id="c-cash" class="nx-amount-input" inputmode="decimal" placeholder="0.00" autocomplete="off"></div>' +
        '<div class="nx-bills" data-bills><button type="button" class="nx-btn" data-exact>Exacto</button>' +
        [100, 200, 500, 1000, 2000].map(function (b) { return '<button type="button" class="nx-btn nx-num" data-bill="' + b + '">+' + b.toLocaleString('es-DO') + '</button>'; }).join('') + '</div>' +
        '<div class="nx-field" data-ref hidden><label for="c-ref" data-ref-label>Autorización / últimos 4 dígitos</label><input id="c-ref" class="num" placeholder="Opcional" autocomplete="off"></div>' +
        '<div class="nx-result" data-result></div>' +
        '<label class="nx-check"><input type="checkbox" id="c-print"' + (printPref ? ' checked' : '') + '> Imprimir ticket al cobrar</label>' +
        '<div class="nx-error" data-err hidden></div></div>' +
        '<div class="nx-modal-foot"><button type="button" class="nx-btn" data-cancel>Esc — Regresar</button>' +
        '<button type="button" class="nx-btn nx-btn--ok" data-ok>Enter — Cobrar</button></div>',
      onKey: function (e, close) {
        var map = { F1: 'efectivo', F2: 'tarjeta', F3: 'transferencia', F4: 'mixto' };
        if (map[e.key]) { e.preventDefault(); setMethod(map[e.key]); }
        if (e.key === 'Enter' || e.key === 'F12') { e.preventDefault(); confirm(close); }
      }
    });
    var el = m.el;
    var cash = el.querySelector('#c-cash');
    function cashValue() { var v = NX.parseMoney(cash.value); return isNaN(v) ? 0 : v; }
    function setMethod(mm) {
      method = mm;
      el.querySelectorAll('[data-m]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-m') === mm)); });
      var showCash = mm === 'efectivo' || mm === 'mixto';
      el.querySelector('[data-cash]').hidden = !showCash;
      el.querySelector('[data-bills]').hidden = mm !== 'efectivo';
      el.querySelector('[data-ref]').hidden = mm === 'efectivo';
      el.querySelector('[data-cash-label]').textContent = mm === 'mixto' ? 'Parte en efectivo (el resto con tarjeta)' : 'Pagó con (efectivo)';
      el.querySelector('[data-ref-label]').textContent = mm === 'transferencia' ? 'Referencia de la transferencia' : 'Autorización / últimos 4 dígitos';
      cash.value = '';
      update();
      (showCash ? cash : el.querySelector('#c-ref')).focus();
    }
    function state() {
      var c = cashValue();
      if (method === 'efectivo') {
        if (!cash.value.trim()) return { ok: true, cls: 'ok', label: 'Cambio (pago exacto)', value: 0, received: total };
        return c >= total ? { ok: true, cls: 'ok', label: 'Cambio a entregar', value: c - total, received: c }
          : { ok: false, cls: 'warn', label: 'Falta por recibir', value: total - c };
      }
      if (method === 'mixto') {
        if (c <= 0 || c >= total) return { ok: false, cls: 'warn', label: 'Escribe la parte en efectivo (menor que el total)', value: c };
        return { ok: true, cls: 'info', label: 'Resto con tarjeta', value: total - c };
      }
      return { ok: true, cls: 'info', label: method === 'tarjeta' ? 'Cargar a tarjeta' : 'Monto transferido', value: total };
    }
    function update() {
      var s = state();
      var r = el.querySelector('[data-result]');
      r.className = 'nx-result nx-result--' + s.cls;
      r.innerHTML = '<span>' + NX.esc(s.label) + '</span><b>' + NX.money(s.value) + '</b>';
      el.querySelector('[data-ok]').disabled = !s.ok || busy;
    }
    function payments() {
      var ref = el.querySelector('#c-ref').value.trim();
      var s = state();
      if (method === 'efectivo') return [{ method: 'efectivo', amount: 0, received: s.received }];
      if (method === 'mixto') return [{ method: 'tarjeta', amount: total - cashValue(), reference: ref }, { method: 'efectivo', amount: 0, received: cashValue() }];
      return [{ method: method, amount: total, reference: ref }];
    }
    function confirm(close) {
      if (busy || !state().ok) return;
      busy = true; update();
      var doPrint = el.querySelector('#c-print').checked;
      NX.store.set('nexocaja-imprimir', doPrint);
      var err = el.querySelector('[data-err]'); err.hidden = true;
      NX.api('POST', '/api/sales', { lines: payload.lines, wholesale: payload.wholesale, ncfType: payload.ncfType, customerId: payload.customerId, payments: payments() }).then(function (sale) {
        close();
        var idx = st.tickets.indexOf(t);
        if (idx >= 0) { st.active = idx; closeTicket(); }
        render(); focusCode();
        NX.toast((sale.ncf ? sale.ncf : 'Venta ' + sale.folio) + ' cobrada · ' + NX.money(sale.total) + (sale.change ? ' · Cambio ' + NX.money(sale.change) : ''));
        NX.refreshFooter();
        NX.loadFiscalStatus().then(function () { if (root) render(); });
        if (doPrint) NX.printSale(sale);
      }).catch(function (e) {
        busy = false; update();
        if (e.status === 409 && /NCF|comprobante|cliente|identificar/.test(e.message)) NX.loadFiscalStatus().then(function () { if (root) render(); });
        if (e.status === 409 && /cerrada/.test(e.message)) {
          close();
          NX.toast(e.message, true);
          if (viewEl) showClosed(viewEl);
          return;
        }
        err.textContent = e.message; err.hidden = false;
      });
    }
    el.querySelectorAll('[data-m]').forEach(function (b) { b.addEventListener('click', function () { setMethod(b.getAttribute('data-m')); }); });
    cash.addEventListener('input', update);
    el.querySelector('[data-exact]').onclick = function () { cash.value = (total / 100).toFixed(2); update(); cash.focus(); };
    el.querySelectorAll('[data-bill]').forEach(function (b) {
      b.onclick = function () { cash.value = ((cashValue() / 100) + +b.getAttribute('data-bill')).toFixed(2); update(); cash.focus(); };
    });
    el.querySelector('[data-cancel]').onclick = m.close;
    el.querySelector('[data-ok]').onclick = function () { confirm(m.close); };
    setMethod('efectivo');
  }

  // ── Vista ──────────────────────────────────────────────────────
  function showClosed(el) {
    root = null;
    el.innerHTML = '<div class="nx-closed"><div class="nx-closed-card"><h2>La caja está cerrada</h2>' +
      '<p class="nx-muted" style="margin:0">Para vender, abre la caja con el efectivo del fondo inicial.</p>' +
      '<button type="button" class="nx-btn nx-btn--ok" data-open style="height:48px;font-size:16px;justify-content:center">Abrir caja</button></div></div>';
    el.querySelector('[data-open]').addEventListener('click', function () { NX.openShiftDialog(function () { mountCaja(el); }); });
    el.querySelector('[data-open]').focus();
  }

  NX.register('caja', {
    mount: function (el) {
      viewEl = el;
      el.innerHTML = '<div class="nx-empty">Cargando…</div>';
      NX.api('GET', '/api/shift/current').then(function (r) {
        if (viewEl !== el) return;
        if (r.shift) mountCaja(el); else showClosed(el);
      }).catch(function (x) { if (x.status !== 401) NX.toast(x.message, true); });
    },
    unmount: function () { root = null; viewEl = null; },
    onKey: function (e) { if (root) cajaKeys(e); else if (/^F\d+$/.test(e.key) && e.key !== 'F5') e.preventDefault(); }
  });

  var viewEl = null;
  function mountCaja(el) {
      root = el;
      el.innerHTML =
        '<div class="nx-band"><h1 data-band-title>VENTA</h1><span class="nx-chip nx-chip--warn" data-wholesale-chip hidden>MAYOREO ACTIVO</span>' +
        '<span class="nx-spacer"></span><span class="nx-chip" data-doc-chip></span></div>' +
        '<div class="nx-fiscalbar" data-fiscal></div>' +
        '<div class="nx-coderow"><label for="codigo">Código del producto:</label>' +
        '<input id="codigo" class="nx-input-code" autocomplete="off" placeholder="Escanee o escriba el código y presione Enter (3*código = 3 unidades)">' +
        '<button type="button" class="nx-btn nx-btn--enter" data-enter>ENTER — Agregar producto</button></div>' +
        '<div class="nx-toolbar" role="toolbar" aria-label="Acciones de venta">' +
        '<button type="button" class="nx-btn" data-varios><kbd class="nx-key">INS</kbd>Varios</button>' +
        '<button type="button" class="nx-btn" data-buscar><kbd class="nx-key">F10</kbd>Buscar</button>' +
        '<button type="button" class="nx-btn" data-mayoreo aria-pressed="false"><kbd class="nx-key">F11</kbd>Mayoreo</button>' +
        '<button type="button" class="nx-btn" data-desc><kbd class="nx-key">F9</kbd>Descuento</button>' +
        '<button type="button" class="nx-btn" data-in><kbd class="nx-key">F7</kbd>Entradas</button>' +
        '<button type="button" class="nx-btn" data-out><kbd class="nx-key">F8</kbd>Salidas</button>' +
        '<button type="button" class="nx-btn nx-btn--danger" data-borrar><kbd class="nx-key">DEL</kbd>Borrar art.</button></div>' +
        '<div class="nx-ticketarea"><div class="nx-tabs" role="tablist" aria-label="Tickets" data-tabs></div>' +
        '<div class="nx-tablebox"><table class="nx-table"><thead><tr>' +
        '<th style="width:150px">Código de barras</th><th>Descripción del producto</th><th class="r" style="width:120px">Precio venta</th>' +
        '<th class="c" style="width:150px">Cant.</th><th class="c" style="width:70px">ITBIS</th><th class="r" style="width:130px">Importe</th><th class="c" style="width:90px">Existencia</th>' +
        '</tr></thead><tbody></tbody></table>' +
        '<div class="nx-empty" data-empty>Ticket vacío. Escanee un código o presione <b>F10</b> para buscar.</div></div></div>' +
        '<section class="nx-summary" aria-label="Resumen de la venta"><div class="nx-summary-left">' +
        '<div class="nx-count"><b data-count>0</b><span>Productos en la venta actual</span></div>' +
        '<div class="nx-actions"><button type="button" class="nx-btn" data-hold><kbd class="nx-key">F6</kbd>Pendiente</button>' +
        '<button type="button" class="nx-btn nx-btn--danger" data-cancel>Anular venta</button></div></div>' +
        '<button type="button" class="nx-btn-cobrar" data-cobrar disabled>F12 — Cobrar</button>' +
        '<div class="nx-total-box"><div class="nx-total-breakdown" data-breakdown></div><span class="nx-total" data-total>$0.00</span></div></section>';

      var on = function (sel, fn) { el.querySelector(sel).addEventListener('click', fn); };
      on('[data-enter]', addFromCode);
      on('[data-varios]', openVarios);
      on('[data-buscar]', function () { openSearch(el.querySelector('#codigo').value.trim()); });
      on('[data-mayoreo]', toggleWholesale);
      on('[data-desc]', cycleDiscount);
      on('[data-borrar]', removeSel);
      on('[data-hold]', hold);
      on('[data-cancel]', cancelTicket);
      on('[data-cobrar]', openCobro);
      el.querySelector('#codigo').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addFromCode(); }
      });
      el.querySelector('[data-tabs]').addEventListener('click', function (e) {
        if (e.target.closest('[data-newtab]')) { newTicket(); return; }
        var b = e.target.closest('[data-tab]');
        if (b) { st.active = +b.getAttribute('data-tab'); st.sel = 0; render(); focusCode(); }
      });
      el.querySelector('tbody').addEventListener('click', function (e) {
        var tr = e.target.closest('tr[data-i]'); if (!tr) return;
        st.sel = +tr.getAttribute('data-i');
        var act = e.target.closest('[data-act]');
        if (act) changeQty(act.getAttribute('data-act') === 'inc' ? 1 : -1); else render();
      });
      el.querySelector('[data-fiscal]').addEventListener('click', function (e) {
        if (e.target.closest('[data-cust]')) chooseCustomer();
        if (e.target.closest('[data-nocust]')) { ticket().customer = null; render(); focusCode(); }
        var nb = e.target.closest('[data-ncf]'); if (nb && !nb.disabled) setNcfType(nb.getAttribute('data-ncf'));
      });
      NX.loadFiscalStatus().then(function () { if (root === el) render(); }).catch(function () {});
      on('[data-in]', function () { NX.cashMove('entrada'); });
      on('[data-out]', function () { NX.cashMove('salida'); });
      render();
      focusCode();
  }

  function cajaKeys(e) {
      var inCode = document.activeElement && document.activeElement.id === 'codigo';
      var codeEmpty = !inCode || !document.activeElement.value;
      var typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !inCode;
      if (typing) return;
      switch (e.key) {
        case 'F10': e.preventDefault(); openSearch(inCode ? document.activeElement.value.trim() : ''); break;
        case 'F11': e.preventDefault(); toggleWholesale(); break;
        case 'F9': e.preventDefault(); cycleDiscount(); break;
        case 'F6': e.preventDefault(); hold(); break;
        case 'F12': e.preventDefault(); openCobro(); break;
        case 'F7': e.preventDefault(); NX.cashMove('entrada'); break;
        case 'F2': e.preventDefault(); chooseCustomer(); break;
        case 'F8': e.preventDefault(); NX.cashMove('salida'); break;
        case 'Insert': e.preventDefault(); openVarios(); break;
        case 'Delete': if (codeEmpty) { e.preventDefault(); removeSel(); } break;
        case 'ArrowDown': if (codeEmpty) { e.preventDefault(); st.sel = Math.min(st.sel + 1, ticket().lines.length - 1); render(); } break;
        case 'ArrowUp': if (codeEmpty) { e.preventDefault(); st.sel = Math.max(st.sel - 1, 0); render(); } break;
        case '+': if (codeEmpty) { e.preventDefault(); changeQty(1); } break;
        case '-': if (codeEmpty) { e.preventDefault(); changeQty(-1); } break;
        default:
          if (/^F\d+$/.test(e.key) && e.key !== 'F5') e.preventDefault();
          else if (!inCode && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) focusCode(); // el escáner escribe aunque el foco esté fuera
      }
  }
})();
