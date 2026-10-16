/* ═══════════════════════════════════════════════════════════════════════════
   shared/reservations.js · APP-RSV-WU (2026-10-16)
   ───────────────────────────────────────────────────────────────────────────
   Open reservations per work order, from SAP's order reservation list (IWBK,
   "Availability list for materials for operations"). Operator, 2026-10-16:
   "upcoming demand is important for us to view, not just from past
   consumption, particularly when we review mins and maxes."

   An optional Intake upload, read here (like the Duplicate list: no column
   mapping step, no DQ gate) into an additive block on the canonical JSON:
     json.reservations = { file, loadedAt, rows: [ { material, order,
       reservation, required, withdrawn, open, start, latest, text, uom } ] }
   Only lines with an open quantity (required − withdrawn > 0) are kept.
   Display only: Where used shows them by fleet / unit; nothing in the Min /
   Max maths reads them.

   The export carries a title row and a blank row above the headers, so the
   header row is found by its column names, never assumed to be row 1.
   Columns are matched by exact header name (lower-case, spaces and
   punctuation stripped), never by position. IDs stay strings.

   Public API:
     Reservations.readFile(file)  -> Promise<rows[][]>   (first sheet with a header)
     Reservations.parse(rows)     -> { rows, headerRow, missing:[], skipped:{blank, noMaterial, closed} }
     Reservations.forMaterial(json, material) -> rows (open lines for one material)
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const ALIASES = {
    material:    ['Material', 'Material Number', 'Material No.'],
    order:       ['Order', 'Order Number'],
    reservation: ['Reservation', 'Reservation Number', 'Reservation No.'],
    required:    ['Requirement Quantity', 'Requirement Qty', 'Reqmt Qty', 'Required Quantity'],
    withdrawn:   ['Quantity withdrawn', 'Qty withdrawn', 'Withdrawn Quantity'],
    start:       ['Earliest start date', 'Requirements date', 'Requirement Date', 'Reqmt Date'],
    latest:      ['Latest start date'],
    text:        ['Order short text', 'Order Description'],
    uom:         ['Base Unit of Measure', 'Unit of Entry', 'BUn']
  };
  const NEED = ['material', 'order', 'required'];

  function id(v){ return String(v == null ? '' : v).trim().replace(/\.0+$/, ''); }
  function num(v){
    if (typeof v === 'number') return v;
    let s = String(v == null ? '' : v).trim();
    if (!s) return 0;
    let neg = false;
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }          // SAP trailing minus
    if (/^\d{1,3}(\.\d{3})*,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,5
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? (neg ? -n : n) : 0;
  }
  function iso(v){
    if (v instanceof Date && !isNaN(v)) {
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {          // Excel serial
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    const s = String(v == null ? '' : v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);             // dd.mm.yyyy (SAP)
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    return s || null;
  }

  function findHeader(rows){
    let best = -1, bestHits = 0, bestMap = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const r = rows[i] || [];
      const map = {}; let hits = 0;
      for (const [field, names] of Object.entries(ALIASES)) {
        const want = new Set(names.map(norm));
        const c = r.findIndex(h => want.has(norm(h)));
        if (c >= 0) { map[field] = c; hits++; }
      }
      if (NEED.every(f => f in map) && hits > bestHits) { best = i; bestHits = hits; bestMap = map; }
    }
    return best < 0 ? null : { row: best, map: bestMap };
  }

  function parse(rows){
    rows = rows || [];
    const h = findHeader(rows);
    if (!h) return { rows: [], headerRow: null, missing: NEED.slice(), skipped: {} };
    const M = h.map, out = [], skipped = { blank: 0, noMaterial: 0, closed: 0 };
    const get = (r, f) => (f in M) ? r[M[f]] : null;
    for (let i = h.row + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.every(v => v == null || String(v).trim() === '')) { skipped.blank++; continue; }
      const material = id(get(r, 'material'));
      if (!material) { skipped.noMaterial++; continue; }
      const required = num(get(r, 'required'));
      const withdrawn = num(get(r, 'withdrawn'));
      const open = Math.max(0, Math.round((required - withdrawn) * 1000) / 1000);
      if (!(open > 0)) { skipped.closed++; continue; }
      out.push({
        material, order: id(get(r, 'order')), reservation: id(get(r, 'reservation')),
        required, withdrawn, open,
        start: iso(get(r, 'start')), latest: iso(get(r, 'latest')),
        text: String(get(r, 'text') == null ? '' : get(r, 'text')).trim(),
        uom: String(get(r, 'uom') == null ? '' : get(r, 'uom')).trim()
      });
    }
    const missing = Object.keys(ALIASES).filter(f => !(f in M));
    return { rows: out, headerRow: h.row + 1, missing, skipped };
  }

  function readFile(file){
    return new Promise(function (resolve, reject) {
      const ext = (String(file && file.name || '').split('.').pop() || '').toLowerCase();
      const text = (ext === 'csv' || ext === 'tsv' || ext === 'txt');
      const r = new FileReader();
      r.onerror = function () { reject(r.error || new Error('the file could not be read')); };
      r.onload = function () {
        try {
          if (text) {
            if (typeof Papa === 'undefined') throw new Error('CSV reader not loaded');
            resolve(Papa.parse(r.result, { header: false, skipEmptyLines: false }).data || []);
            return;
          }
          if (typeof XLSX === 'undefined') throw new Error('spreadsheet reader not loaded');
          const wb = XLSX.read(new Uint8Array(r.result), { type: 'array', cellDates: true });
          for (const n of wb.SheetNames) {
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: true, raw: true });
            if (findHeader(rows)) { resolve(rows); return; }
          }
          resolve([]);
        } catch (e) { reject(e); }
      };
      if (text) r.readAsText(file); else r.readAsArrayBuffer(file);
    });
  }

  function forMaterial(json, material){
    const rows = (json && json.reservations && Array.isArray(json.reservations.rows)) ? json.reservations.rows : [];
    const m = id(material);
    return rows.filter(r => r.material === m && r.open > 0);
  }

  global.Reservations = { readFile, parse, forMaterial, findHeader };
})(window);
