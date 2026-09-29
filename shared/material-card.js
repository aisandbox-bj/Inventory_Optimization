/*═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · shared/material-card.js · v2.2.0-dev
   APP-MAT-CARD (operator 2026-09-29; Backlog "#2 Inventory-Master helper card")

   Click the material number in a chart header (Trend / Canvas quick look /
   Sandbox detail, and the Trace banner) → a small card with that material's
   Inventory Master details: SAP # and VPN (manufacturer part no., both with a
   copy button), description, manufacturer, material group, unit, plant and
   storage location, stock (unrestricted / blocked / in transit / total), value
   and price, MRP settings, open PO, reservations, MRP controller and buyer group.

   Read-only: it shows what the loaded Inventory Master says, nothing computed.
   A material with several Inventory Master rows (split valuation / plants): the
   stock quantities and value are added up; plant-level figures that SAP repeats
   on every row (blocked, in transit, open PO, reservations) are taken once; the
   card says how many rows there are. Blank values show "—", never a guess.

   The card floats over the page (nothing moves); ✕, Esc or a click outside closes it.

   API: MaterialCard.setSource(json) · MaterialCard.open(material, anchorEl)
        MaterialCard.wire(el, material)  — make an element open the card on click
═════════════════════════════════════════════════════════════════════════════*/
(function (global) {
  'use strict';

  var src = null, idx = null;
  function setSource(json) { src = json || null; idx = null; }
  function rowsFor(material) {
    if (!src || !src.data || !Array.isArray(src.data.inventoryMaster)) return null;
    if (!idx) {
      idx = new Map();
      src.data.inventoryMaster.forEach(function (r) {
        var k = String(r.material == null ? '' : r.material).trim(); if (!k) return;
        if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r);
      });
    }
    return idx.get(String(material).trim()) || [];
  }

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var has = function (v) { return v != null && String(v).trim() !== ''; };
  var num = function (v, d) { return has(v) && isFinite(+v) ? (+v).toLocaleString('en-CA', { maximumFractionDigits: d == null ? 2 : d }) : '—'; };
  var cad = function (v) { return has(v) && isFinite(+v) ? '$' + (+v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; };
  var txt = function (v) { return has(v) ? esc(v) : '—'; };
  var both = function (a, b) { return has(a) || has(b) ? esc([a, b].filter(has).join(' · ')) : '—'; };
  function sum(rows, k) { var t = 0, any = false; rows.forEach(function (r) { if (has(r[k]) && isFinite(+r[k])) { t += +r[k]; any = true; } }); return any ? t : null; }
  function first(rows, k) { for (var i = 0; i < rows.length; i++) if (has(rows[i][k])) return rows[i][k]; return null; }
  function uniqJoin(rows, k) { var s = []; rows.forEach(function (r) { var v = String(r[k] == null ? '' : r[k]).trim(); if (v && s.indexOf(v) < 0) s.push(v); }); return s.join(', '); }

  var CSS = '.mc-card{position:fixed;z-index:9600;width:440px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;' +
    'background:#0C2D3B;border:1px solid rgba(31,206,216,.45);border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.55);' +
    'color:#F0F4F3;font:13px/1.45 Barlow,sans-serif}' +
    '.mc-h{display:flex;align-items:flex-start;gap:8px;padding:11px 12px 9px;border-bottom:1px solid rgba(31,206,216,.18);background:#091F2D;cursor:move}' +
    '.mc-h .mc-t{flex:1;min-width:0}.mc-h .mc-eb{font:500 10px/1.3 "JetBrains Mono",monospace;letter-spacing:1.4px;text-transform:uppercase;color:#1FCED8;opacity:.8}' +
    '.mc-h .mc-mat{font:700 17px/1.3 "JetBrains Mono",monospace;color:#1FCED8}.mc-h .mc-desc{color:#D6DFDE;font-size:13px}' +
    '.mc-x{background:none;border:none;color:#9BABA8;font-size:16px;cursor:pointer;padding:0 2px}.mc-x:hover{color:#fff}' +
    '.mc-b{padding:8px 12px 12px}.mc-sec{font:600 11px/1.3 Rajdhani,sans-serif;letter-spacing:1px;text-transform:uppercase;color:#86D6CF;margin:10px 0 4px}' +
    '.mc-g{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:3px 10px;align-items:baseline}' +
    '.mc-g .k{color:#9BABA8;font-size:12px;white-space:nowrap}.mc-g .v{font-family:"JetBrains Mono",monospace;font-size:12.5px;color:#F0F4F3;word-break:break-word}' +
    '.mc-g .v.wide{grid-column:span 3}' +
    '.mc-cp{margin-left:6px;background:transparent;border:1px solid rgba(155,176,182,.35);border-radius:4px;color:#9BABA8;font-size:11px;line-height:16px;padding:0 5px;cursor:pointer}' +
    '.mc-cp:hover{color:#1FCED8;border-color:#1FCED8}.mc-cp.ok{color:#34D399;border-color:#34D399}' +
    '.mc-note{margin-top:10px;color:#9BABA8;font-size:11.5px}.mc-warn{color:#FBBF24}' +
    '.mat-cardlink{cursor:pointer;text-decoration:underline dotted rgba(31,206,216,.6);text-underline-offset:3px}.mat-cardlink:hover{text-decoration-style:solid}';
  function ensureCss() {
    if (document.getElementById('mc-css')) return;
    var st = document.createElement('style'); st.id = 'mc-css'; st.textContent = CSS; document.head.appendChild(st);
  }

  var card = null;
  function close() { if (card) { card.remove(); card = null; } document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onOutside, true); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function onOutside(e) { if (card && !card.contains(e.target) && !(e.target.closest && e.target.closest('.mat-cardlink'))) close(); }

  function copy(btn, value) {
    var done = function () { btn.classList.add('ok'); btn.textContent = '✓'; setTimeout(function () { btn.classList.remove('ok'); btn.textContent = '⧉'; }, 1200); };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(value)).then(done, function () {});
      else { var ta = document.createElement('textarea'); ta.value = value; ta.style.position = 'fixed'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
    } catch (e) {}
  }

  function body(material, rows) {
    if (!rows) return '<div class="mc-note mc-warn">No assessment data is loaded on this page.</div>';
    if (!rows.length) return '<div class="mc-note mc-warn">This material isn’t in the loaded Inventory Master.</div>';
    var R = rows, n = R.length;
    var vpn = first(R, 'mfgPartNo');
    var kv = function (k, v, wide) { return '<span class="k">' + k + '</span><span class="v' + (wide ? ' wide' : '') + '">' + v + '</span>'; };
    var res = [1, 2, 3].map(function (i) { var d = first(R, 'res' + i + 'Doc'), q = first(R, 'res' + i + 'Qty'); return has(d) && has(q) && +q ? esc(d) + ' (' + num(q) + ')' : ''; }).filter(Boolean).join(', ');
    var imDate = src && src.metadata && src.metadata.inventoryMasterDate;
    return '' +
      '<div class="mc-sec">Identification</div><div class="mc-g">' +
        kv('VPN', (has(vpn) ? esc(vpn) + ' <button type="button" class="mc-cp" data-copy="' + esc(vpn) + '" aria-label="Copy VPN">⧉</button>' : '—'), true) +
        kv('Manufacturer', txt(first(R, 'manufacturer')), true) +
        kv('Material group', both(first(R, 'materialGroup'), first(R, 'materialGroupDesc')), true) +
        kv('Unit', txt(first(R, 'uom'))) + kv('Plant', txt(uniqJoin(R, 'plant'))) +
        kv('Storage loc.', txt(uniqJoin(R, 'storageLocation')), true) +
      '</div>' +
      '<div class="mc-sec">Stock</div><div class="mc-g">' +
        kv('Unrestricted', num(sum(R, 'totQtyOh'))) + kv('Blocked', num(first(R, 'blockedStock'))) +
        kv('In transit', num(first(R, 'inTransit'))) + kv('Total stock', num(sum(R, 'totalStock'))) +
        kv('Stock value', cad(sum(R, 'totValueOh'))) + kv('Moving avg', cad(first(R, 'movingAvgPrice'))) +
      '</div>' +
      '<div class="mc-sec">MRP & purchasing</div><div class="mc-g">' +
        kv('MRP type', txt(first(R, 'mrpInd'))) + kv('Safety stock', num(first(R, 'safetyStock'))) +
        kv('Min', num(first(R, 'mrpMin'))) + kv('Max', num(first(R, 'mrpMax'))) +
        kv('Open PO qty', num(first(R, 'openPO'))) + kv('Reserved', num(first(R, 'totalReservation'))) +
        (res ? kv('Reservations', res, true) : '') +
        kv('MRP controller', both(first(R, 'mrpController'), first(R, 'mrpControllerName')), true) +
        kv('Buyer group', both(first(R, 'purchasingGroup'), first(R, 'purchasingGroupDesc')), true) +
      '</div>' +
      '<div class="mc-note">From the loaded Inventory Master' + (imDate ? ' (extract ' + esc(imDate) + ')' : '') + '.' +
        (n > 1 ? ' <span class="mc-warn">' + n + ' Inventory Master rows for this material (split valuation or plants): stock and value are added up; blocked, in transit, open PO and reservations are shown once.</span>' : '') +
      '</div>';
  }

  function open(material, anchorEl) {
    ensureCss(); close();
    var rows = rowsFor(material), desc = rows && rows.length ? first(rows, 'description') : '';
    card = document.createElement('div'); card.className = 'mc-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Material ' + material);
    card.innerHTML = '<div class="mc-h"><div class="mc-t"><div class="mc-eb">Material card</div>' +
      '<div class="mc-mat">' + esc(material) + ' <button type="button" class="mc-cp" data-copy="' + esc(material) + '" aria-label="Copy material number">⧉</button></div>' +
      (desc ? '<div class="mc-desc">' + esc(desc) + '</div>' : '') + '</div>' +
      '<button type="button" class="mc-x" aria-label="Close">✕</button></div><div class="mc-b">' + body(material, rows) + '</div>';
    document.body.appendChild(card);
    // place just below the clicked number, kept on screen
    var r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : { left: 40, bottom: 80 };
    var w = card.offsetWidth, h = card.offsetHeight;
    card.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left)) + 'px';
    card.style.top = Math.max(12, Math.min(window.innerHeight - h - 12, r.bottom + 8)) + 'px';
    card.querySelector('.mc-x').addEventListener('click', close);
    card.addEventListener('click', function (e) { var b = e.target.closest('.mc-cp'); if (b) { e.stopPropagation(); copy(b, b.dataset.copy); } });
    // move by the header
    var h1 = card.querySelector('.mc-h');
    h1.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button')) return;
      e.preventDefault(); var sx = e.clientX, sy = e.clientY, ox = card.offsetLeft, oy = card.offsetTop;
      try { h1.setPointerCapture(e.pointerId); } catch (x) {}
      var mv = function (ev) { card.style.left = Math.max(0, Math.min(window.innerWidth - 60, ox + ev.clientX - sx)) + 'px'; card.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy)) + 'px'; };
      var up = function () { h1.removeEventListener('pointermove', mv); h1.removeEventListener('pointerup', up); };
      h1.addEventListener('pointermove', mv); h1.addEventListener('pointerup', up);
    });
    setTimeout(function () { document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onOutside, true); }, 0);
  }

  function wire(el, material) {
    if (!el || el._matCard) return;
    el._matCard = true; ensureCss();
    el.classList.add('mat-cardlink');
    el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Open the material card for ' + material);
    el.addEventListener('click', function (e) { e.stopPropagation(); open(material, el); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(material, el); } });
  }

  global.MaterialCard = { setSource: setSource, open: open, wire: wire, close: close };
})(window);
