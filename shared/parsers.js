/* ═══════════════════════════════════════════════════════════════════════════
   Parsers — XLSX / CSV → canonical row arrays. Handles SAP export drift via
   column-alias matching. Sheet names auto-detected (skill rule: never hardcode).

   Depends on: SheetJS (XLSX), PapaParse (Papa) — loaded via CDN before this.
   Optional:   WorXlsxRows (vendor/wor_xlsx_rows.js) — when loaded, every .xlsx
               is read one row at a time (APP-INT-ROWREAD); without it the
               library reads the file as before.
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
      order:        ['Order', 'Order Number', 'Order No', 'Order No.'],
      material:     ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.', 'SKU', 'Part', 'Part No', 'Part No.', 'Part Number'],
      description:  ['Material Description', 'Material descr.', 'Description', 'Mat Desc'],
      quantity:     ['Quantity', 'Qty', 'Qty in unit of entry', 'Qty in unit', 'Qty in UnE'],
      movementType: ['Movement Type', 'Movement type', 'MvT', 'Mvt Type'],
      /* APP-T-01b — plant alias added so per-file plant breakdown is visible
         in the Intake drop-stats panel. No analytical change in this chunk —
         pipeline still ignores plant on MB51 rows. Plant-scoped filtering /
         scope picker / Settings toggle land in a follow-up chunk. */
      plant:        ['Plant'],
      /* APP-FIX-T-04b (2026-05-17) — purchaseOrder alias was missing on
         MB51, which broke Trace's PR-to-PO-to-receipt chain join (PR
         History supplies the PO number, MB51 109 rows need to match by PO
         to register a Site WH receipt). Without this alias, every row's
         purchaseOrder field is undefined → zero matches → every chain
         reads as IN_FLIGHT or PR_ONLY. Audit §"MB51_Opn.xlsx" col 24
         confirms the header is verbatim "Purchase order". String type
         to preserve leading zeros on PO numbers like 9600010502. */
      purchaseOrder: ['Purchase order', 'PO', 'PO Number', 'PO No', 'PO No.', 'Purchasing Document'],
      /* APP-FIX-SHELF-STOCK (2026-10-14) — storage location on every MB51 line. The stock line counts
         the lines in the shelf storage location; a 109 / 110 with NO storage location is a part bought
         straight for an order / cost centre / project (total use, never shelf stock). Optional: a file
         without it keeps the old movement-type reading. Same aliases as the Inventory Master. */
      storageLocation: ['Storage Location', 'Sloc', 'Stor. Loc.', 'StorLoc'],
      /* APP-FIX-PROJECT-STOCK (2026-10-14) — project (special stock Q) lines carry a storage location but
         are not own stock. Told apart by the Special Stock indicator when the file has it, else by the
         movement text ("GR fr Val.BlStk Proj", "GI acct ass.fm proj.", "TF proj. to proj.", …). Optional. */
      movementTypeText: ['Movement Type Text', 'Mvt Type Text', 'MvT Text', 'Movement type text'],
      specialStock:     ['Special Stock', 'Special Stock Indicator', 'Special Stock Ind.', 'Spec. Stock']
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
    /* APP-T-01 (2026-05-16) — widened to ingest the standard SAP Material
       Master Fiori export per Willem's field-mapping audit (Fiori_Field_
       Audit_APP-T-01.md). Existing legacy aliases (Tot_Qty_OH, MRP_Ind etc.)
       kept for back-compat with the old Inventory Master - Output.xlsx.
       Plant is now canonical (was implicit single-plant before — multi-plant
       handling, scope-picker UI, and cross-file consistency check are queued
       for APP-T-01b). openPO is plant-conditional in source data: GM PO Qty
       is plant 1130 (the operator's primary), MLA PO Qty is plant 1120 (3PL
       hub) — first-match-wins resolves to plant 1130 by default; proper
       plant-conditional selection lands in T-01b. */
    inventoryMaster: {
      material:           ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.'],
      description:        ['Material Description', 'Mat Desc', 'Description'],
      plant:              ['Plant'],
      uom:                ['Base Unit of Measure', 'Base UoM', 'BUn', 'UoM', 'Unit of Measure', 'Unit'],
      totQtyOh:           ['Unrestricted', 'Unrestricted Stock', 'Unrestricted-Use Stock', 'Tot_Qty_OH', 'Tot Qty OH', 'Total Qty', 'Stock On Hand', 'SOH', 'Qty On Hand'],
      totValueOh:         ['Total Value', 'Tot_Value_OH', 'Tot Value OH', 'Stock Value', 'Value On Hand', 'On-Hand Value', 'Inventory Value'],
      mrpInd:             ['MRP Type', 'MRP_Ind', 'MRP Ind', 'MRP_Type', 'MRP Indicator'],
      mrpMin:             ['Reorder Point', 'MRP_Min', 'MRP Min', 'Min', 'Minimum'],
      mrpMax:             ['Maximum Stock Level', 'MRP_Max', 'MRP Max', 'Max', 'Maximum'],
      safetyStock:        ['Safety Stock', 'SS', 'SS Qty', 'Safety_Stock', 'Buffer Stock'],
      inventoryType:      ['Inventory_Type', 'Inventory Type', 'Inv Type', 'Item Category'],
      materialGroup:      ['Material Group', 'Mat Group', 'MatGrp', 'Material_Group', 'MGroup'],
      manufacturer:       ['Mfg Name', 'Manufacturer', 'Mfr', 'OEM', 'Make', 'Manufacturer Name'],
      primaryVendor:      ['Vendor', 'Primary Vendor', 'Source', 'Vendor No.'],
      /* APP-T-01 — new canonical fields (D20 — five for Compose PR drafting) */
      inTransit:          ['Stock in Transit', 'In Transit', 'In-Transit Qty', 'Stock In Transit'],
      openPO:             ['GM PO Qty', 'MLA PO Qty', 'Open PO Qty', 'Open PO', 'PO Qty', 'PO_QTY'],
      totalReservation:   ['Total Res Qty', 'Total Reservations', 'Total Reservation Qty', 'Res Qty', 'Reservation Qty'],
      unitPrice:          ['Net Price', 'Unit Price', 'Standard Price', 'Std Price'],
      movingAvgPrice:     ['Moving price', 'Moving Avg Price', 'Moving Average Price', 'mov_ave_cost', 'Moving Avg', 'MAP'],
      /* APP-T-01 — high-value carry-through aliases (per audit §8) */
      materialGroupDesc:  ['Material Group Desc.', 'Material Group Description', 'Mat Group Desc'],
      mfgPartNo:          ['Manufacturer Part No.', 'Mfg Part No', 'MPN', 'Manufacturer Part Number', 'VPN', 'Vendor Part No.', 'Vendor Part Number'],
      storageLocation:    ['Storage Location', 'Sloc', 'Stor. Loc.', 'StorLoc'],
      mrpController:      ['MRP Controller'],
      mrpControllerName:  ['MRP controller name', 'MRP Controller Name'],
      currency:           ['Local Currency', 'Currency'],
      purchasingGroup:    ['Purchasing Group', 'Purch. Group', 'PGr'],
      purchasingGroupDesc:['Description p. group', 'Purchasing Group Description'],
      blockedStock:       ['Valuated Goods Receipt Blocked Stock', 'Blocked Stock', 'GR Blocked Stock'],
      totalStock:         ['Total Stock'],
      res1Doc:            ['Reservation 1'],
      res1Qty:            ['Res 1 Qty'],
      res2Doc:            ['Reservation 2'],
      res2Qty:            ['Res 2 Qty'],
      res3Doc:            ['Reservation 3'],
      res3Qty:            ['Res 3 Qty']
    },
    userList: {
      material:    ['Material', 'Material Number', 'Material No', 'Material No.', "Mat'l", 'Mat No', 'Mat. No.', 'SKU', 'Part', 'Part No', 'Part No.', 'Part Number'],
      /* APP-E22 — accept either a material OR an order column on uploaded user-list files. */
      order:       ['Order', 'Order Number', 'Order No', 'Order No.', 'Maintenance Order', 'Work Order', 'WO', 'WO Number', 'Order Num'],
      description: ['Description', 'Material Description', 'Mat Desc']
    },
    materialVendor: {
      material:            ['Material', 'Material Number', 'Material No', 'Material No.'],
      vendor:              ['Vendor', 'Vendor Number', 'Vendor No.'],
      vendorName:          ['Vendor Name', 'Name', 'Vendor description'],
      sourceListIndicator: ['Source List', 'SL', 'SL Indicator']
    },
    leadTimes: {
      material:     ['Material'],
      leadTimeDays: ['Lead Time', 'Lead Time (Days)', 'Trigger to GR', 'LT'],
      safetyStock:  ['Safety Stock', 'SS', 'SS Qty'],
      source:       ['Source', 'Method', 'Lead Time Source']
    },
    /* APP-T-02 (2026-05-16) — PR History: new OPTIONAL source. The Trace
       bridge starts here. 21 columns aliased from the 30 in the SAP Fiori
       PR History export per the CoWork field-mapping audit; the 9 columns
       skipped are the audit-flagged low/no-value ones (Deliv. date
       category, Purchasing Info Rec, MPN:Material, No. of requisns, GR
       processing time, Goods Receipt boolean, Delivery Date in yyyymmdd
       string form, Purch. Organization, Short Text — kept for display
       only, no canonical role). All values stay as strings unless
       explicitly typed below — preserves SAP zero-padding on PR numbers,
       PO numbers, and creation indicator flags. */
    prHistory: {
      material:           ['Material'],
      plant:              ['Plant'],
      uom:                ['Unit of Measure', 'Base UoM', 'BUn', 'UoM'],
      purchaseOrder:      ['Purchase order', 'Purchasing Document'],
      poDate:             ['Purchase Order Date', 'PO Date'],
      pr:                 ['Purchase Requisition', 'PR Number', 'Requisition No.'],
      prItem:             ['Item of requisition', 'Item', 'PR Item'],
      prDate:             ['Requisition date', 'PR Date', 'Created on'],
      releaseDate:        ['Release Date'],
      changedOn:          ['Changed On'],
      processingStatus:   ['Processing status', 'Status'],
      deletionIndicator:  ['Deletion Indicator', 'Deletion ind.'],
      creationIndicator:  ['Creation indicator', 'Creation Ind.', 'ESTKZ'],
      releaseIndicator:   ['Release indicator', 'Release Ind.'],
      qtyRequested:       ['Quantity requested', 'Quantity', 'Qty Requested'],
      shortText:          ['Short Text', 'Description', 'Text'],
      requisitioner:      ['Requisitioner'],
      acctAssignmentCat:  ['Acct Assignment Cat.', 'Acc.Assgnmt Cat.', 'AAC'],
      purchasingGroup:    ['Purchasing Group', 'Purch. Group', 'PGr'],
      itemCategory:       ['Item Category', 'Item Cat'],
      desiredVendor:      ['Desired Vendor'],
      fixedVendor:        ['Fixed Vendor', 'Vendor']
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
      movementType: 'string',
      plant:         'string',  /* APP-T-01b */
      purchaseOrder: 'string',  /* APP-FIX-T-04b — preserve PO leading zeros for PR↔MB51 join */
      storageLocation: 'string', /* APP-FIX-SHELF-STOCK — blank is kept as '' (blank means "not on the shelf") */
      movementTypeText: 'string', /* APP-FIX-PROJECT-STOCK */
      specialStock:     'string'  /* APP-FIX-PROJECT-STOCK — blank = own stock */
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
      material:           'string',
      description:        'string',
      plant:              'string',
      uom:                'string',
      totQtyOh:           'number',
      totValueOh:         'number',
      mrpInd:             'string',
      mrpMin:             'number',
      mrpMax:             'number',
      safetyStock:        'number',
      inventoryType:      'string',
      materialGroup:      'string',
      manufacturer:       'string',
      primaryVendor:      'string',
      /* APP-T-01 — new canonical fields */
      inTransit:          'number',
      openPO:             'number',
      totalReservation:   'number',
      unitPrice:          'number',
      movingAvgPrice:     'number',
      /* APP-T-01 — carry-through aliases */
      materialGroupDesc:  'string',
      mfgPartNo:          'string',
      storageLocation:    'string',
      mrpController:      'string',
      mrpControllerName:  'string',
      currency:           'string',
      purchasingGroup:    'string',
      purchasingGroupDesc:'string',
      blockedStock:       'number',
      totalStock:         'number',
      res1Doc:            'string',
      res1Qty:            'number',
      res2Doc:            'string',
      res2Qty:            'number',
      res3Doc:            'string',
      res3Qty:            'number'
    },
    userList: {
      material:    'string',
      order:       'string',  /* APP-E22 — preserve leading zeros on order numbers */
      description: 'string'
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
    },
    /* APP-T-02 — PR History field types. Dates coerced via toIsoDate. Most
       numeric-looking fields (PR / PO / item / vendor / plant) stay STRING
       to preserve leading zeros. qtyRequested is the only true numeric. */
    prHistory: {
      material:           'string',
      plant:              'string',
      uom:                'string',
      purchaseOrder:      'string',
      poDate:             'date',
      pr:                 'string',
      prItem:             'string',
      prDate:             'date',
      releaseDate:        'date',
      changedOn:          'date',
      processingStatus:   'string',
      deletionIndicator:  'string',
      creationIndicator:  'string',
      releaseIndicator:   'string',
      qtyRequested:       'number',
      shortText:          'string',
      requisitioner:      'string',
      acctAssignmentCat:  'string',
      purchasingGroup:    'string',
      itemCategory:       'string',
      desiredVendor:      'string',
      fixedVendor:        'string'
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

  /* ─── APP-INT-ROWREAD (2026-10-13) — an .xlsx read one row at a time ─────────
     SheetJS holds a whole sheet as one text, and a browser allows about 512 MB
     for one text: past that (roughly half a million MB51 rows) the library hands
     back an EMPTY sheet and no error. The vendored row reader
     (vendor/wor_xlsx_rows.js, from WO Readiness 0.5.6) unpacks the sheet in
     pieces and gives one row at a time, so only the mapped columns are ever kept.

     Three ways to read an .xlsx, tried in this order:
       1. 'worker'  — the row reader on its own thread: the page stays alive and
                      the card counts rows while a large file is read;
       2. 'rows'    — the row reader on the page (where a thread cannot start);
       3. 'library' — SheetJS, as before (.xls, or a browser with no
                      DecompressionStream).
     The helpers here reproduce what sheet_to_json({ defval:null, blankrows:false })
     gave, so all three give the same result; tools/reader-check.html compares
     them on any set of files. Run it after any change here.
  ───────────────────────────────────────────────────────────────────────── */
  let lastRead = null;   // how the last file was read (for the reader check and for support)

  function rowReaderLoaded(){
    return !!(global.WorXlsxRows && typeof DecompressionStream === 'function');
  }
  async function isZip(file){
    const b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4B;   // "PK" = a zip = .xlsx (the old .xls is not)
  }

  /* Header names the library's way: a blank header is __EMPTY; a repeat gets _1, _2 … */
  function headerNames(top){
    const names = [], seen = Object.create(null);
    for (let c = 0; c < top.length; c++) {
      const cell = top[c];
      const v = cell == null ? '__EMPTY' : (typeof cell === 'boolean' ? (cell ? 'TRUE' : 'FALSE') : String(cell));
      let vv = v, counter = seen[v] || 0;
      if (!counter) seen[v] = 1;
      else { do { vv = v + '_' + (counter++); } while (seen[vv]); seen[v] = counter; seen[vv] = 1; }
      names.push(vv);
    }
    return names;
  }

  function isBlankRow(row){
    for (let i = 0; i < row.length; i++) if (row[i] != null) return false;
    return true;
  }

  /* Same choice as pickSheet(): alias hits × 10000 + data rows, first best wins.
     sheets = [{ name, top (its first row), n (its data rows) }]. One sheet (every SAP export) needs no scoring. */
  function scoreSheets(sheets, source){
    if (sheets.length <= 1) return sheets.length ? sheets[0].name : undefined;
    const aliases = ALIASES[source] || {}, cands = new Set();
    for (const arr of Object.values(aliases)) for (const a of arr) cands.add(normalize(a));
    let best = { name: null, score: -1 };
    for (const s of sheets) {
      if (!s.top || !s.n) continue;
      let hits = 0;
      for (const h of headerNames(s.top)) if (cands.has(normalize(h))) hits++;
      const score = hits * 10000 + s.n;
      if (score > best.score) best = { name: s.name, score };
    }
    return best.name || sheets[0].name;
  }

  /* The mapping for one sheet: which columns to keep, in which field order, as which type.
     As the library did, the headers are the keys of the first data row (so whole-number names sort first). */
  function planColumns(source, hdr, userAliases){
    const probe = {}; for (const h of hdr) probe[h] = null;
    const headers = Object.keys(probe);
    const map     = buildFieldMap(source, headers, userAliases);
    const fields  = Object.keys(map.fieldToHeader);
    const types   = FIELD_TYPES[source];
    return { headers, map, fields, cols: fields.map(f => hdr.indexOf(map.fieldToHeader[f])), kinds: fields.map(f => types[f]) };
  }
  function shapeResult(source, sheetName, plan, canonical, userAliases){
    /* no data rows: nothing maps and there are no headers, as before */
    const headers = (plan && canonical.length) ? plan.headers : [];
    const map     = (plan && canonical.length) ? plan.map : buildFieldMap(source, [], userAliases);
    return { canonical, headers, sheet: sheetName, fieldMap: map.fieldToHeader, unmatched: map.unmatched,
             missingFields: map.missingFields, matchedFields: map.matchedFields, rowCount: canonical.length };
  }

  /* ── 2. the row reader on the page ── */
  async function parseXlsxByRows(file, source, userAliases, onProgress){
    const wb = await global.WorXlsxRows.open(new Uint8Array(await file.arrayBuffer()));
    const sheets = [];
    for (const name of wb.sheetNames) {
      if (wb.sheetNames.length === 1) { sheets.push({ name }); break; }
      let top = null, n = 0;
      await wb.sheet(name, { onRow: (row, i) => { if (i === 0) top = row; else if (!isBlankRow(row)) n++; } });
      sheets.push({ name, top, n });
    }
    const sheetName = scoreSheets(sheets, source);
    let plan = null, hdr = null, rowsRead = 0;
    const canonical = [];
    if (sheetName != null) {
      await wb.sheet(sheetName, { onRow: (row, i) => {
        if (i === 0) { hdr = headerNames(row); return; }
        rowsRead++;
        if (isBlankRow(row)) return;
        if (!plan) plan = planColumns(source, hdr, userAliases);
        const obj = {};
        for (let k = 0; k < plan.fields.length; k++) obj[plan.fields[k]] = coerce(row[plan.cols[k]], plan.kinds[k]);
        canonical.push(obj);
        if (onProgress && canonical.length % 25000 === 0) onProgress(canonical.length);
      } });
    }
    return { result: shapeResult(source, sheetName, plan, canonical, userAliases), rowsRead,
             sheetMB: sheetName != null ? Math.round(wb.sizeOf(sheetName) / 1e6) : 0 };
  }

  /* ── 1. the row reader on its own thread ──
     The thread only reads: it sends the first row of a sheet, then the rows cut down to the columns asked for,
     20,000 at a time. Mapping and type conversion stay here, in one place, for all three readers. */
  const ROW_WORKER = `
    const blank = r => { for (let i = 0; i < r.length; i++) if (r[i] != null) return false; return true; };
    let wb = null;
    onmessage = async (ev) => {
      const m = ev.data;
      try {
        if (m.op === 'open') {
          wb = await WorXlsxRows.open(new Uint8Array(await m.file.arrayBuffer()));
          const names = wb.sheetNames, sheets = [];
          for (const name of names) {
            if (names.length === 1) { sheets.push({ name }); break; }
            let top = null, n = 0;
            await wb.sheet(name, { onRow: (row, i) => { if (i === 0) top = row; else if (!blank(row)) n++; } });
            sheets.push({ name, top, n });
          }
          postMessage({ op: 'sheets', sheets });
        } else if (m.op === 'top') {
          const t = await wb.sheet(m.name, { limit: 1 });
          postMessage({ op: 'top', top: t.rows.length ? t.rows[0] : null, range: t.range, sheetMB: Math.round(wb.sizeOf(m.name) / 1e6) });
        } else if (m.op === 'rows') {
          const cols = m.cols; let batch = [], read = 0, kept = 0;
          await wb.sheet(m.name, { range: m.range, onRow: (row, i) => {
            if (i === 0) return;
            read++;
            if (blank(row)) return;
            const o = new Array(cols.length);
            for (let k = 0; k < cols.length; k++) o[k] = row[cols[k]];
            batch.push(o); kept++;
            if (batch.length >= 20000) { postMessage({ op: 'batch', rows: batch, kept }); batch = []; }
          } });
          if (batch.length) postMessage({ op: 'batch', rows: batch, kept });
          postMessage({ op: 'done', read, kept });
        }
      } catch (e) { postMessage({ op: 'error', message: String(e && e.message || e) }); }
    };`;

  function workerCall(w, msg, onBatch){
    return new Promise((resolve, reject) => {
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.op === 'batch') { try { onBatch(m); } catch (e) { reject(e); } }
        else if (m.op === 'error') reject(new Error(m.message));
        else resolve(m);
      };
      w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); reject(new Error((ev && ev.message) || 'the reader thread could not start')); };
      w.postMessage(msg);
    });
  }

  async function parseXlsxInWorker(file, source, userAliases, onProgress){
    const tag = document.querySelector('script[src*="wor_xlsx_rows.js"]');
    if (!tag || typeof Worker !== 'function') throw new Error('no reader thread in this browser');
    const blobUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(tag.src)});\n${ROW_WORKER}`], { type: 'text/javascript' }));
    let w = null;
    try {
      w = new Worker(blobUrl);
      const opened    = await workerCall(w, { op: 'open', file });
      const sheetName = scoreSheets(opened.sheets, source);
      const canonical = [];
      let plan = null, rowsRead = 0, sheetMB = 0;
      if (sheetName != null) {
        const top = await workerCall(w, { op: 'top', name: sheetName });
        sheetMB = top.sheetMB;
        if (top.top) {
          plan = planColumns(source, headerNames(top.top), userAliases);
          /* a text that repeats (a material, a plant, a movement type) is kept once, as the row reader keeps it */
          const pool = new Map(), F = plan.fields, K = plan.kinds;
          const done = await workerCall(w, { op: 'rows', name: sheetName, range: top.range, cols: plan.cols }, (m) => {
            for (const raw of m.rows) {
              const obj = {};
              for (let k = 0; k < F.length; k++) {
                let v = raw[k];
                if (typeof v === 'string') { const p = pool.get(v); if (p === undefined) pool.set(v, v); else v = p; }
                obj[F[k]] = coerce(v, K[k]);
              }
              canonical.push(obj);
            }
            if (onProgress) onProgress(m.kept);
          });
          rowsRead = done.read;
        }
      }
      return { result: shapeResult(source, sheetName, plan, canonical, userAliases), rowsRead, sheetMB };
    } finally {
      if (w) w.terminate();
      URL.revokeObjectURL(blobUrl);
    }
  }

  /**
   * High-level: parse + map + coerce in one call.
   *   { canonical: [...], headers: [...], sheet, fieldMap, unmatched, missingFields }
   * opts.onProgress(rows) — called as the rows of an .xlsx come in.
   * opts.reader — 'worker', 'rows' or 'library' forces one reader (the reader check uses it); default: the first that works.
   */
  async function parseAndMap(file, source, userAliases, opts){
    opts = opts || {};
    const t0   = Date.now();
    const ext  = (file.name.split('.').pop() || '').toLowerCase();
    const text = ext === 'csv' || ext === 'tsv' || ext === 'txt';
    const want = opts.reader || 'auto';
    const tried = [];   // why an earlier reader was passed over

    if (!text && want !== 'library') {
      if (rowReaderLoaded() && await isZip(file)) {
        for (const how of (want === 'auto' ? ['worker', 'rows'] : [want])) {
          try {
            const out = how === 'worker' ? await parseXlsxInWorker(file, source, userAliases, opts.onProgress)
                                         : await parseXlsxByRows(file, source, userAliases, opts.onProgress);
            lastRead = { reader: how, file: file.name, ms: Date.now() - t0, rowsRead: out.rowsRead, rowsKept: out.result.rowCount,
                         blankRows: out.rowsRead - out.result.rowCount, sheetMB: out.sheetMB, passedOver: tried.slice() };
            return out.result;
          } catch (e) {
            if (want !== 'auto') throw e;
            tried.push(`${how}: ${e.message || e}`);   // try the next reader before giving up
          }
        }
      } else if (want !== 'auto') {
        throw new Error('this file cannot be read row by row (not an .xlsx, or the browser is too old)');
      }
    }

    const { rows, headers, sheet } = await parseFile(file, source);
    /* A spreadsheet of several MB with no cell in it is the library's size limit, not an empty file: say so. */
    if (!text && rows.length === 0 && headers.length === 0 && file.size > 5 * 1024 * 1024) {
      throw new Error(`this file is too large for this browser to open as a spreadsheet (${Math.round(file.size / 1048576)} MB came back empty). `
        + 'Use a current Chrome or Edge, or save the file as .csv and load that'
        + (tried.length ? ` [${tried.join(' · ')}]` : ''));
    }
    const map = buildFieldMap(source, headers, userAliases);
    const canonical = mapRows(rows, source, map.fieldToHeader);
    lastRead = { reader: text ? 'text' : 'library', file: file.name, ms: Date.now() - t0, rowsRead: rows.length, rowsKept: canonical.length,
                 blankRows: 0, sheetMB: null, passedOver: tried.slice() };
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
    normalize,
    lastRead: () => lastRead   // APP-INT-ROWREAD — which reader opened the last file, how long, rows read / kept
  });

})(window);
