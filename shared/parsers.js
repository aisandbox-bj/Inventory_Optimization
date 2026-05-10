/* ═══════════════════════════════════════════════════════════════════════════
   Parsers — XLSX / CSV → canonical row arrays. Handles SAP export drift via
   column-alias matching. Sheet names auto-detected (skill rule: never hardcode).

   Depends on: SheetJS (XLSX), PapaParse (Papa) — loaded via CDN before this.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Column alias map per source file ──────────────────────────────────── */
  /* Each canonical field has 1+ candidate header names. Matching is case- and
     punctuation-insensitive (see normalize() below). User-defined overrides
     from Settings are layered on top. */
  const ALIASES = {
    mb51: {
      postingDate:  ['Posting Date', 'Pstng Date', 'Pstng date', 'Date', 'Posting date'],
      order:        ['Order', 'Order Number'],
      material:     ['Material', 'Material Number', "Mat'l", 'Mat No', 'Mat. No.'],
      description:  ['Material Description', 'Material descr.', 'Description', 'Mat Desc'],
      quantity:     ['Quantity', 'Qty', 'Qty in unit of entry', 'Qty in unit', 'Qty in UnE'],
      movementType: ['Movement Type', 'Movement type', 'MvT', 'Mvt Type']
    },
    iw39: {
      order:          ['Order', 'Order Number'],
      sortField:      ['Sort Field', 'Sort field', 'Sort No.', 'SortFld'],
      basicStartDate: ['Basic start date', 'Basic Start Date', 'Bas. Start', 'Basic Start'],
      description:    ['Description', 'Long Text', 'Operation Short Text', 'Order Description']
    },
    fleetMaster: {
      model:               ['Model number', 'Model Number', 'Model', 'Model No.'],
      sortField:           ['Sort Field', 'Sort field'],
      unitType:            ['Unit_Type', 'Unit Type', 'UnitType', 'Type'],
      manufacturer:        ['Manufacturer', 'Make', 'OEM', 'Mfr'],
      functLocDescription: ['FunctLocDescrip.', 'Functional Location', 'FunctLoc.', 'Description']
    },
    inventoryMaster: {
      material:       ['Material'],
      totQtyOh:       ['Tot_Qty_OH', 'Tot Qty OH', 'Total Qty', 'Stock On Hand', 'SOH'],
      mrpInd:         ['MRP_Ind', 'MRP Ind', 'MRP Type', 'MRP_Type', 'MRP Indicator'],
      mrpMin:         ['MRP_Min', 'MRP Min', 'Min', 'Minimum', 'Reorder Point'],
      mrpMax:         ['MRP_Max', 'MRP Max', 'Max', 'Maximum'],
      inventoryType:  ['Inventory_Type', 'Inventory Type', 'Inv Type', 'Item Category'],
      primaryVendor:  ['Vendor', 'Primary Vendor', 'Source', 'Vendor No.']
    },
    materialVendor: {
      material:            ['Material'],
      vendor:              ['Vendor', 'Vendor Number', 'Vendor No.'],
      vendorName:          ['Vendor Name', 'Name', 'Vendor description'],
      sourceListIndicator: ['Source List', 'SL', 'SL Indicator']
    },
    leadTimes: {
      material:     ['Material'],
      leadTimeDays: ['Lead Time', 'Lead Time (Days)', 'Trigger to GR', 'LT'],
      safetyStock:  ['Safety Stock', 'SS', 'SS Qty'],
      source:       ['Source', 'Method', 'Lead Time Source']
    }
  };

  /* ─── String normalization for fuzzy header matching ────────────────────── */
  function normalize(s){
    return String(s || '')
      .toLowerCase()
      .replace(/[\s._\-()/]+/g, '')
      .trim();
  }

  /**
   * Build a header → canonical-field map for a given source.
   * Layers user-saved aliases (from Settings) over the built-in map.
   *
   * @param {string} source  — one of ALIASES keys (e.g. 'mb51')
   * @param {string[]} headers — actual headers from the parsed file
   * @param {Object} userAliases — saved overrides keyed by source.canonicalField → ['header','aliases']
   * @returns {{ fieldToHeader: Object, unmatched: string[], matchedFields: string[], missingFields: string[] }}
   */
  function buildFieldMap(source, headers, userAliases) {
    const builtIn = ALIASES[source] || {};
    const user    = (userAliases && userAliases[source]) || {};
    const fields  = Object.keys(builtIn);

    // Combined alias list per field — user overrides matched FIRST so they win
    const combined = {};
    for (const f of fields) {
      const list = [...((user[f] || [])), ...(builtIn[f] || [])];
      combined[f] = list.map(normalize);
    }

    const headerNormMap = {};
    headers.forEach(h => { headerNormMap[normalize(h)] = h; });

    const fieldToHeader = {};
    const matched = [];
    const missing = [];
    const usedHeaders = new Set();

    for (const f of fields) {
      let found = null;
      for (const candidate of combined[f]) {
        if (headerNormMap[candidate] && !usedHeaders.has(headerNormMap[candidate])) {
          found = headerNormMap[candidate];
          break;
        }
      }
      if (found) {
        fieldToHeader[f] = found;
        usedHeaders.add(found);
        matched.push(f);
      } else {
        missing.push(f);
      }
    }

    const unmatched = headers.filter(h => !usedHeaders.has(h));
    return { fieldToHeader, unmatched, matchedFields: matched, missingFields: missing };
  }

  /* ─── Coercion helpers ──────────────────────────────────────────────────── */
  function toIsoDate(v){
    if (v == null || v === '') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      return v.toISOString().slice(0, 10);
    }
    // SheetJS may return Excel serial or Date depending on options. Handle both.
    if (typeof v === 'number') {
      // Excel serial date → JS Date
      const ms = Math.round((v - 25569) * 86400 * 1000);
      const d  = new Date(ms);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    }
    const s = String(v).trim();
    // Try common formats: yyyy-mm-dd, dd/mm/yyyy, mm/dd/yyyy, dd.mm.yyyy
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) return s;
    const slashMatch = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
    if (slashMatch) {
      let [_, a, b, y] = slashMatch;
      if (y.length === 2) y = (parseInt(y,10) > 50 ? '19' : '20') + y;
      // SAP exports are typically dd.mm.yyyy or dd/mm/yyyy in many locales,
      // but mm/dd/yyyy in US. Heuristic: if first part > 12, it's the day.
      let day, month;
      if (parseInt(a,10) > 12)      { day = a; month = b; }
      else if (parseInt(b,10) > 12) { day = b; month = a; }
      else                          { day = a; month = b; }   // ambiguous → assume dd/mm
      return `${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }

  function toNumber(v){
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const s = String(v).trim().replace(/,/g, '');   // strip thousands separators
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function toString(v){
    if (v == null) return '';
    return String(v).trim();
  }

  /* ─── Type schemas per source — drives coercion ─────────────────────────── */
  const FIELD_TYPES = {
    mb51: {
      postingDate:  'date',
      order:        'string',
      material:     'string',
      description:  'string',
      quantity:     'number',
      movementType: 'string'
    },
    iw39: {
      order:          'string',
      sortField:      'string',
      basicStartDate: 'date',
      description:    'string'
    },
    fleetMaster: {
      model:               'string',
      sortField:           'string',
      unitType:            'string',
      manufacturer:        'string',
      functLocDescription: 'string'
    },
    inventoryMaster: {
      material:      'string',
      totQtyOh:      'number',
      mrpInd:        'string',
      mrpMin:        'number',
      mrpMax:        'number',
      inventoryType: 'string',
      primaryVendor: 'string'
    },
    materialVendor: {
      material:            'string',
      vendor:              'string',
      vendorName:          'string',
      sourceListIndicator: 'string'
    },
    leadTimes: {
      material:     'string',
      leadTimeDays: 'number',
      safetyStock:  'number',
      source:       'string'
    }
  };

  function coerce(v, type){
    if (type === 'date')   return toIsoDate(v);
    if (type === 'number') return toNumber(v);
    return toString(v);
  }

  /* ─── Map raw rows → canonical rows using field map ─────────────────────── */
  function mapRows(rawRows, source, fieldToHeader){
    const types = FIELD_TYPES[source];
    const out = [];
    for (const raw of rawRows) {
      const obj = {};
      for (const [field, header] of Object.entries(fieldToHeader)) {
        obj[field] = coerce(raw[header], types[field]);
      }
      out.push(obj);
    }
    return out;
  }

  /* ─── XLSX parsing — auto-pick sheet ────────────────────────────────────── */
  /**
   * Pick the most "data-like" sheet from a workbook. Heuristic: largest used
   * range with a header row that matches at least one canonical alias for the
   * named source. If nothing matches, fall back to the largest sheet.
   */
  function pickSheet(wb, source){
    const aliases  = ALIASES[source] || {};
    const allCands = new Set();
    for (const arr of Object.values(aliases)) for (const a of arr) allCands.add(normalize(a));

    let best = { name: null, score: -1, rowCount: 0 };
    for (const name of wb.SheetNames) {
      const ws    = wb.Sheets[name];
      const rows  = XLSX.utils.sheet_to_json(ws, { defval: null, blankrows: false });
      if (rows.length === 0) continue;
      const headers = Object.keys(rows[0] || {});
      let hits = 0;
      for (const h of headers) if (allCands.has(normalize(h))) hits++;
      const score = hits * 10000 + rows.length;        // alias hits dominate, size as tiebreak
      if (score > best.score) best = { name, score, rowCount: rows.length };
    }
    return best.name;
  }

  /**
   * Parse a File object into { rows, headers } given a source key.
   * Returns a Promise.
   */
  function parseFile(file, source){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload  = () => {
        try {
          const ext = (file.name.split('.').pop() || '').toLowerCase();
          if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
            const text = reader.result;
            const out  = Papa.parse(text, { header: true, skipEmptyLines: true });
            const rows = out.data || [];
            const headers = out.meta && out.meta.fields ? out.meta.fields : Object.keys(rows[0] || {});
            resolve({ rows, headers, sheet: null });
          } else {
            const data = new Uint8Array(reader.result);
            const wb   = XLSX.read(data, { type: 'array', cellDates: true });
            const sheetName = pickSheet(wb, source) || wb.SheetNames[0];
            const ws   = wb.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(ws, { defval: null, blankrows: false });
            const headers = Object.keys(rows[0] || {});
            resolve({ rows, headers, sheet: sheetName });
          }
        } catch (e) {
          reject(e);
        }
      };
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext === 'csv' || ext === 'tsv' || ext === 'txt') reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  /**
   * High-level: parse + map + coerce in one call.
   *   { canonical: [...], headers: [...], sheet, fieldMap, unmatched, missingFields }
   */
  async function parseAndMap(file, source, userAliases){
    const { rows, headers, sheet } = await parseFile(file, source);
    const map = buildFieldMap(source, headers, userAliases);
    const canonical = mapRows(rows, source, map.fieldToHeader);
    return {
      canonical,
      headers,
      sheet,
      fieldMap:      map.fieldToHeader,
      unmatched:     map.unmatched,
      missingFields: map.missingFields,
      matchedFields: map.matchedFields,
      rowCount:      canonical.length
    };
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppParsers = Object.freeze({
    ALIASES,
    FIELD_TYPES,
    parseFile,
    parseAndMap,
    buildFieldMap,
    pickSheet,
    normalize
  });

})(window);
