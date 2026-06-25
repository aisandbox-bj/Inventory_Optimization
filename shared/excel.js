/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.0.0-dev · released 2026-05-12
   Excel deliverable — reference-matched workbook (775G_Analysis.xlsx shape).

   Per workbook:
     • Index sheet — title row (merged A1:Q1), header row with AutoFilter
       (Excel-native filter dropdowns on every column), frozen at row 2.
       17 columns. Material No. cells are hyperlinks to per-material sheets.
       Traffic-light cells colour-filled. Column widths match the reference.
     • Per-material sheet — sheet name = material number. Layout:
         row 1 : "← Index" backlink in B1:C1 merged
         row 2 : "{material} — {description}" title merged B2:D2
         row 3 : Field | Value | Notes header
         rows 4-24 : Material No. / Description / Material Group / Manufacturer
                    / Multi-Model Flag / Total Consumed / P1 Net / P1 Rate /
                    P2 Net / P2 Rate / Adj P2 Rate / Rate Change / Current Stock
                    / Runway @ P2 / MRP Type / Current Min / Current Max /
                    Rec Min / Rec Max / Traffic Light / Action Required
         row 27+ : "High Consumption Events — P2" header + WO table
         row 31+ : "MRP Settings Comparison" Current vs Recommended
       Chart image embedded anchored at column F, row 1 (~1100×470 px).
       Hyperlink B1 → 'Index'!A1.

   Depends on: ExcelJS (loaded via CDN before this), AppChart (chart capture).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Traffic-light fills (ARGB without alpha — ExcelJS expects 'FF' prefix) */
  const TL_FILL = {
    GREEN:  '00B050',
    ORANGE: 'FF8C00',
    BLUE:   '3498DB',
    RED:    'C00000',
    PURPLE: '9B59B6',
    GREY:   'BFBFBF'
  };
  const TL_FONT_WHITE = ['GREEN','ORANGE','BLUE','RED','PURPLE'];

  /* ─── Theme colours (ARGB minus alpha — we add FF in usage) ─── */
  const C = {
    titleNavy:    '1F3864',
    headerNavy:   '305496',
    headerOrange: 'C65911',
    headerGrey:   '404040',
    stripeA:      'FFFFFF',
    stripeB:      'F2F2F2',
    note:         '7F6000',
    noteFill:     'FFF2CC',
    border:       'BFBFBF',
    linkBlue:     '0563C1'
  };

  /* ─── Index sheet column definitions ─── */
  const INDEX_COLS = [
    { key:'material',     header:'Material No.',           width:14, type:'string' },
    { key:'description',  header:'Material Description',   width:42, type:'string' },
    { key:'totalNet',     header:'Total Consumed',         width:14, type:'number' },
    { key:'p1Rate',       header:'P1 Rate (u/mo)',         width:13, type:'rate'   },
    { key:'p2Rate',       header:'P2 Rate (u/mo)',         width:13, type:'rate'   },
    { key:'rateChange',   header:'Rate Change %',          width:12, type:'pctOrNA' },
    { key:'stock',        header:'Current Stock',          width:13, type:'numberOrDash' },
    { key:'mrpType',      header:'MRP Type',               width:10, type:'string' },
    { key:'cmin',         header:'Current Min',            width:11, type:'numberOrDash' },
    { key:'cmax',         header:'Current Max',            width:11, type:'numberOrDash' },
    { key:'recMin',       header:'Recommended Min',        width:13, type:'numberOrDash' },
    { key:'recMax',       header:'Recommended Max',        width:13, type:'numberOrDash' },
    { key:'trafficLight', header:'Traffic Light',          width:12, type:'tl'     },
    { key:'action',       header:'Action Required',        width:50, type:'string' },
    { key:'hceFlag',      header:'HCE Flag (P2)',          width:45, type:'string' },
    { key:'adjP2Rate',    header:'Adj P2 Rate (excl HCE)', width:14, type:'rateOrBlank' },
    { key:'multiModel',   header:'Multi-Model Flag',       width:11, type:'multiFlag' }
  ];

  /* ─── Helpers ─── */
  function pad(n){ return String(n).padStart(2, '0'); }
  function fmtDateShort(iso){
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
  }
  function safeSheetName(name, taken){
    let base = String(name).replace(/[\\\/\?\*\[\]:]/g, '_').slice(0, 31);
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base.slice(0, 28)}_${n}`;
      n++;
    }
    taken.add(candidate);
    return candidate;
  }
  function emdash(v){ return (v == null || v === '') ? '—' : v; }

  /* ─── Render a chart into an offscreen SVG, return raw base64 PNG ─────────
     APP-FIX-XCHART (2026-05-24) — operator-reported defect: every per-material
     Excel sheet rendered the FIRST material's chart while the numeric cells
     were per-material correct. Two defensive measures:
     (a) Yield one animation frame after AppChart.render(host, m) so the
         offscreen SVG completes one layout/paint cycle before XMLSerializer
         walks it. The prior synchronous return raced the render in some
         browser timing scenarios.
     (b) Strip the `data:image/png;base64,` prefix before returning. ExcelJS
         accepts data URLs in most builds, but some pinned versions silently
         dedup images by exact base64 string when the prefix is present —
         the second material's identical header bytes hash to the first
         material's media entry. Returning raw base64 is the documented
         path for `wb.addImage({base64, extension})`. */
  async function renderChartPng(material){
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1100px;height:470px;visibility:hidden;background:#0C2D3B;';
    document.body.appendChild(host);
    try {
      const svg = AppChart.render(host, material, { width: 1100, height: 470 });
      // (a) Paint flush — one rAF tick guarantees the SVG element tree is
      // fully laid out before serialization. Negligible perf cost (~1ms/material).
      await new Promise(r => requestAnimationFrame(() => r()));
      const dataUrl = await AppChart.toPng(svg, 1.6);
      // (b) Strip the data URL prefix → return raw base64.
      return dataUrl.replace(/^data:image\/png;base64,/, '');
    } finally {
      document.body.removeChild(host);
    }
  }

  /* ─── Cell formatters per Index column type ─── */
  function fmtIndexCell(col, m){
    switch (col.type) {
      case 'number':
        return (typeof m[col.key] === 'number') ? m[col.key] : '—';
      case 'numberOrDash':
        return (m[col.key] == null || m[col.key] === '') ? '—' : m[col.key];
      case 'rate':
        if (col.key === 'p1Rate') return (m.p1Flag === 'OK') ? m.p1Rate : '—';
        if (col.key === 'p2Rate') return (m.p2Flag === 'OK') ? m.p2Rate : '—';
        return m[col.key];
      case 'pctOrNA':
        return (m.rateChange == null) ? 'N/A' : `${m.rateChange}%`;
      case 'tl':
        return m.trafficLight;
      case 'rateOrBlank':
        if (m.hceP2 && m.hceP2.length) {
          return m.adjP2Flag === 'OK' ? m.adjP2Rate : '';
        }
        return '';
      case 'multiFlag':
        return m.multiModelFlag === 'Multi' ? 'Multi' : '';
      case 'string':
      default:
        if (col.key === 'hceFlag') {
          if (!m.hceP2 || !m.hceP2.length) return '';
          const h = m.hceP2[0];
          const extra = m.hceP2.length > 1 ? ` [+${m.hceP2.length - 1} more]` : '';
          return `WO ${h.order} | ${h.date} | ${h.equipment || '—'} | ${h.qty} units (${h.pct}% of P2)${extra}`;
        }
        return m[col.key] == null ? '' : m[col.key];
    }
  }

  /* ─── Build the Index sheet ─── */
  function buildIndexSheet(wb, bucket, parameters, runDate){
    const ws = wb.addWorksheet('Index', {
      views: [{ state: 'frozen', ySplit: 2, xSplit: 0 }]
    });

    // Column widths
    INDEX_COLS.forEach((col, i) => {
      ws.getColumn(i + 1).width = col.width;
    });

    // Row 1: title (merged A1:Q1)
    const p1Range = `${fmtDateShort(parameters.p1Start)}–${fmtDateShort(parameters.p1End)}`;
    const p2Range = `${fmtDateShort(p2StartIso(parameters, runDate))}–${fmtDateShort(runDate)}`;
    const titleText = `${bucket.name} — Consumption Profile & MRP Assessment  |  P1: ${p1Range}  |  P2: ${p2Range}  |  Run: ${runDate}  |  Rates: full MB51 (261+201 issues, 262+202 returns)`;
    ws.mergeCells('A1:Q1');
    const titleCell = ws.getCell('A1');
    titleCell.value = titleText;
    titleCell.font = { name:'Calibri', size:12, bold:true, color:{ argb:'FFFFFFFF' } };
    titleCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.titleNavy } };
    titleCell.alignment = { vertical:'middle', horizontal:'center', wrapText:false };
    ws.getRow(1).height = 26;

    // Row 2: column headers
    INDEX_COLS.forEach((col, i) => {
      const cell = ws.getRow(2).getCell(i + 1);
      cell.value = col.header;
      cell.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri' };
      cell.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb: 'FF' + (i >= 14 ? C.headerOrange : C.headerNavy) } };
      cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
      cell.border = thinBorder();
    });
    ws.getRow(2).height = 32;

    // AutoFilter on header row
    ws.autoFilter = {
      from: { row:2, column:1 },
      to:   { row:2, column:INDEX_COLS.length }
    };

    // Data rows
    let r = 3;
    const hyperlinkPairs = [];  // [{from, sheetName}]
    for (const m of bucket.materials) {
      const row = ws.getRow(r);
      INDEX_COLS.forEach((col, i) => {
        const cell = row.getCell(i + 1);
        cell.value = fmtIndexCell(col, m);
        cell.font  = { name:'Calibri', size:10 };
        cell.alignment = alignFor(col);
        cell.border = thinBorder();
        // Row striping
        const stripeColour = (r % 2 === 0) ? C.stripeB : C.stripeA;
        if (stripeColour !== 'FFFFFF') {
          cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + stripeColour } };
        }
      });

      // Traffic-light cell colour fill (column M = index 13)
      const tlCell = row.getCell(13);
      if (TL_FILL[m.trafficLight]) {
        tlCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + TL_FILL[m.trafficLight] } };
        tlCell.font = { bold:true, color:{ argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' }, name:'Calibri' };
        tlCell.alignment = { horizontal:'center', vertical:'middle' };
      }

      // HCE columns amber tint (cols 15, 16)
      if (m.hceP2 && m.hceP2.length) {
        [15, 16].forEach(ci => {
          const c = row.getCell(ci);
          c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.noteFill } };
          c.font = { name:'Calibri', size:10, color:{ argb:'FF' + C.note }, bold:true };
        });
      }

      // Material No. cell: bold + hyperlink to per-material sheet (set later)
      const matCell = row.getCell(1);
      matCell.font = Object.assign({}, matCell.font || {}, { bold:true });
      hyperlinkPairs.push({ rowIdx: r, sheetName: null /* filled in caller */ });

      r++;
    }

    return { ws, dataRows: r - 3, hyperlinkPairs };
  }

  function p2StartIso(params, runDate){
    const d = new Date(runDate);
    if (isNaN(d.getTime())) return runDate;
    d.setMonth(d.getMonth() - (params.p2Months || 3));
    return AppLocale.localDateISO(d);
  }

  function alignFor(col){
    if (col.type === 'number' || col.type === 'numberOrDash' || col.type === 'rate' || col.type === 'rateOrBlank' || col.type === 'pctOrNA') {
      return { horizontal:'right', vertical:'middle' };
    }
    if (col.type === 'tl' || col.type === 'multiFlag') {
      return { horizontal:'center', vertical:'middle' };
    }
    return { horizontal:'left', vertical:'middle', wrapText: (col.width > 30) };
  }

  function thinBorder(){
    const s = { style:'thin', color:{ argb:'FF' + C.border } };
    return { top:s, left:s, bottom:s, right:s };
  }

  /* ─── Build one per-material sheet ─── */
  async function buildMaterialSheet(wb, ws, m, parameters, runDate){
    // Column widths matching the reference (A=gutter, B=label, C=value, D=notes)
    ws.getColumn(1).width = 3;
    ws.getColumn(2).width = 24;
    ws.getColumn(3).width = 22;
    ws.getColumn(4).width = 32;

    // Row 1: "← Index" backlink in merged B1:C1
    ws.getRow(1).height = 20;
    ws.mergeCells('B1:C1');
    const back = ws.getCell('B1');
    back.value = { text: '← Index', hyperlink: `#'Index'!A1` };
    back.font  = { name:'Calibri', size:10, bold:true, underline:true, color:{ argb:'FF' + C.linkBlue } };
    back.alignment = { horizontal:'left', vertical:'middle' };

    // Row 2: title merged B2:D2
    ws.mergeCells('B2:D2');
    const title = ws.getCell('B2');
    title.value = `${m.material} — ${m.description || ''}`;
    title.font  = { name:'Calibri', size:14, bold:true, color:{ argb:'FFFFFFFF' } };
    title.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.titleNavy } };
    title.alignment = { horizontal:'left', vertical:'middle' };
    ws.getRow(2).height = 24;

    // Row 3: Field / Value / Notes headers
    ['Field', 'Value', 'Notes'].forEach((h, i) => {
      const c = ws.getRow(3).getCell(i + 2);
      c.value = h;
      c.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri' };
      c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerGrey } };
      c.alignment = { horizontal:'center', vertical:'middle' };
      c.border = thinBorder();
    });
    ws.getRow(3).height = 18;

    // Rows 4+: Field/Value/Notes data
    const p1Note = `${parameters.p1Start} – ${parameters.p1End}`;
    const p2Note = `${m.p2Start} – ${m.p2End}`;
    const fields = [
      ['Material No.',         m.material,                                            ''],
      ['Description',          m.description || '—',                             ''],
      ['Material Group',       m.materialGroup || '—',                           ''],
      ['Manufacturer',         m.manufacturer || '—',                            ''],
      ['Multi-Model Flag',     m.multiModelFlag || 'Single',                          m.multiModelFlag === 'Multi' ? `Appears in cross-bucket MULTI bucket` : ''],
      ['Total Consumed',       m.totalNet,                                            `Analysis window net (issues − returns)`],
      ['P1 Net Qty',           (m.p1Net != null ? m.p1Net : 0),                       p1Note],
      ['P1 Rate',              (m.p1Flag === 'OK' ? m.p1Rate : '—'),             `u/mo`],
      ['P2 Net Qty',           (m.p2Net != null ? m.p2Net : 0),                       p2Note],
      ['P2 Rate',              (m.p2Flag === 'OK' ? m.p2Rate : '—'),             `u/mo`],
      ['Adj P2 Rate',          (m.hceP2 && m.hceP2.length && m.adjP2Flag === 'OK') ? `${m.adjP2Rate} u/mo` : '—',   'Excl. HCE work orders'],
      ['Rate Change P1→P2', m.rateChange != null ? `${m.rateChange}%` : 'N/A',   ''],
      ['Current Stock',        (m.stock == null ? '—' : m.stock),                ''],
      ['Stock Value',          (m.totValueOh != null ? AppLocale.fmtCAD(m.totValueOh) : '—'),  'CAD'],
      ['Runway @ P2',          (m.runway != null ? m.runway : '—'),              'months'],
      ['MRP Type',             m.mrpType || '—',                                 ''],
      ['Current Min',          (m.cmin == null ? '—' : m.cmin),                  ''],
      ['Current Max',          (m.cmax == null ? '—' : m.cmax),                  ''],
      ['Rec Min',              (m.recMin == null ? '—' : m.recMin),              'P2 rate × ' + parameters.minMonths + ' months'],
      ['Rec Max',              (m.recMax == null ? '—' : m.recMax),              'P2 rate × ' + parameters.maxMonths + ' months'],
      ['Traffic Light',        m.trafficLight,                                        ''],
      ['Action Required',      m.action || '',                                        '']
    ];

    fields.forEach((f, i) => {
      const r = ws.getRow(i + 4);
      const stripe = (i % 2 === 0) ? C.stripeB : C.stripeA;

      // Field label
      const labelCell = r.getCell(2);
      labelCell.value = f[0];
      labelCell.font  = { name:'Calibri', size:10, bold:true };
      labelCell.alignment = { horizontal:'left', vertical:'middle' };
      labelCell.border = thinBorder();

      // Value
      const valueCell = r.getCell(3);
      valueCell.value = f[1];
      valueCell.font  = { name:'Calibri', size:10 };
      valueCell.alignment = { horizontal: (typeof f[1] === 'number') ? 'right' : 'left', vertical:'middle' };
      valueCell.border = thinBorder();

      // Notes
      const notesCell = r.getCell(4);
      notesCell.value = f[2];
      notesCell.font  = { name:'Calibri', size:9, italic:true, color:{ argb:'FF595959' } };
      notesCell.alignment = { horizontal:'left', vertical:'middle' };
      notesCell.border = thinBorder();

      // Stripe fill
      if (stripe !== 'FFFFFF') {
        [labelCell, valueCell, notesCell].forEach(c => {
          c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + stripe } };
        });
      }

      // Traffic light row: colour the value cell
      if (f[0] === 'Traffic Light' && TL_FILL[m.trafficLight]) {
        valueCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + TL_FILL[m.trafficLight] } };
        valueCell.font = { name:'Calibri', size:10, bold:true,
                           color:{ argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' } };
        valueCell.alignment = { horizontal:'center', vertical:'middle' };
      }

      // Adj P2 / HCE-related rows: amber tint
      if (f[0] === 'Adj P2 Rate' && m.hceP2 && m.hceP2.length) {
        [labelCell, valueCell, notesCell].forEach(c => {
          c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.noteFill } };
          c.font = Object.assign({}, c.font, { color:{ argb:'FF' + C.note } });
        });
      }
    });

    // HCE section starts at row 27 (matches reference)
    let r = 27;
    ws.mergeCells(`B${r}:D${r}`);
    const hceTitle = ws.getCell(`B${r}`);
    hceTitle.value = 'High Consumption Events — P2';
    hceTitle.font  = { name:'Calibri', size:11, bold:true, color:{ argb:'FFFFFFFF' } };
    hceTitle.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerOrange } };
    hceTitle.alignment = { horizontal:'left', vertical:'middle' };
    ws.getRow(r).height = 20;
    r++;

    // HCE header row (B..G)
    const hceHdrs = ['Work Order', 'Date', 'Equipment', 'Qty', '% of P2', 'Reason'];
    hceHdrs.forEach((h, i) => {
      const c = ws.getRow(r).getCell(i + 2);
      c.value = h;
      c.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri', size:10 };
      c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerGrey } };
      c.alignment = { horizontal:'center', vertical:'middle' };
      c.border = thinBorder();
    });
    r++;

    // HCE rows
    if (m.hceP2 && m.hceP2.length) {
      for (const e of m.hceP2) {
        const row = ws.getRow(r);
        const vals = [e.order, e.date, e.equipment || '—', e.qty, `${e.pct}%`, e.reasons || `${e.pct}% of period consumption`];
        vals.forEach((v, i) => {
          const c = row.getCell(i + 2);
          c.value = v;
          c.font  = { name:'Calibri', size:10 };
          c.alignment = { horizontal: (i === 3 || i === 4) ? 'right' : 'left', vertical:'middle' };
          c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.noteFill } };
          c.border = thinBorder();
        });
        r++;
      }
    } else {
      const c = ws.getRow(r).getCell(2);
      c.value = '— no high-consumption events flagged in P2 —';
      c.font = { name:'Calibri', size:10, italic:true, color:{ argb:'FF7F7F7F' } };
      ws.mergeCells(`B${r}:G${r}`);
      r++;
    }

    // Inv Adj section — only renders if there are confirmed Inv-Adj events for this material
    if (m.invAdj && m.invAdj.length) {
      r += 2;
      ws.mergeCells(`B${r}:G${r}`);
      const iaTitle = ws.getCell(`B${r}`);
      iaTitle.value = 'Inventory Adjustments (excluded from rate)';
      iaTitle.font  = { name:'Calibri', size:11, bold:true, color:{ argb:'FFFFFFFF' } };
      iaTitle.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF9B59B6' } };
      iaTitle.alignment = { horizontal:'left', vertical:'middle' };
      ws.getRow(r).height = 20;
      r++;
      const iaHdrs = ['Date', 'Order', 'Equipment', 'Qty', 'Reason'];
      iaHdrs.forEach((h, i) => {
        const c = ws.getRow(r).getCell(i + 2);
        c.value = h;
        c.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri', size:10 };
        c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerGrey } };
        c.alignment = { horizontal:'center', vertical:'middle' };
        c.border = thinBorder();
      });
      r++;
      for (const e of m.invAdj) {
        const row = ws.getRow(r);
        const vals = [e.date, e.order || '—', e.equipment || '—', e.qty, e.reasons || ''];
        vals.forEach((v, i) => {
          const c = row.getCell(i + 2);
          c.value = v;
          c.font  = { name:'Calibri', size:10 };
          c.alignment = { horizontal: (i === 3) ? 'right' : 'left', vertical:'middle' };
          c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE8D8F0' } };   // light purple
          c.border = thinBorder();
        });
        r++;
      }
    }

    // MRP Settings Comparison — placed at row 31 (matches reference) or below HCE if longer
    r = Math.max(r + 2, 31);
    ws.mergeCells(`B${r}:D${r}`);
    const cmpTitle = ws.getCell(`B${r}`);
    cmpTitle.value = 'MRP Settings Comparison';
    cmpTitle.font  = { name:'Calibri', size:11, bold:true, color:{ argb:'FFFFFFFF' } };
    cmpTitle.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerNavy } };
    cmpTitle.alignment = { horizontal:'left', vertical:'middle' };
    ws.getRow(r).height = 20;
    r++;

    // Comparison column headers
    ['', 'Current', 'Recommended'].forEach((h, i) => {
      const c = ws.getRow(r).getCell(i + 2);
      c.value = h;
      c.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri', size:10 };
      c.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.headerGrey } };
      c.alignment = { horizontal:'center', vertical:'middle' };
      c.border = thinBorder();
    });
    r++;

    // Comparison rows
    const cmpRows = [
      ['MRP Type', m.mrpType || '—',                            m.recMrpType || m.mrpType || 'PD'],
      ['Min',      (m.cmin == null ? '—' : m.cmin),             (m.recMin == null ? '—' : m.recMin)],
      ['Max',      (m.cmax == null ? '—' : m.cmax),             (m.recMax == null ? '—' : m.recMax)]
    ];
    cmpRows.forEach((cr, i) => {
      const row = ws.getRow(r);
      row.getCell(2).value = cr[0];
      row.getCell(3).value = cr[1];
      row.getCell(4).value = cr[2];
      row.getCell(2).font = { name:'Calibri', size:10, bold:true };
      [3, 4].forEach(ci => {
        row.getCell(ci).font = { name:'Calibri', size:10 };
        row.getCell(ci).alignment = { horizontal:'center', vertical:'middle' };
      });
      // Highlight if recommended differs from current
      const changed = String(cr[1]) !== String(cr[2]) && cr[2] !== '—';
      [2, 3, 4].forEach(ci => {
        row.getCell(ci).border = thinBorder();
        if (changed) {
          row.getCell(ci).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.noteFill } };
        }
      });
      r++;
    });

    // APP-E8 — MRP reclass note (PD → V1) when a Min/Max is recommended on a PD item
    if (m.mrpReclassRecommended && m.mrpReclassNote) {
      const noteRow = ws.getRow(r);
      noteRow.getCell(2).value = '⚑ ' + m.mrpReclassNote;
      noteRow.getCell(2).font = { name:'Calibri', size:9, italic:true, color:{ argb:'FF926E0A' } };
      noteRow.getCell(2).alignment = { horizontal:'left', vertical:'middle', wrapText:true };
      try { ws.mergeCells(r, 2, r, 4); } catch(e) {}
      r++;
    }

    // Embedded chart at col F (index 5 → ExcelJS col 6 zero-indexed = 5), row 1 (row index 1)
    try {
      const png = await renderChartPng(m);
      const imageId = wb.addImage({ base64: png, extension: 'png' });
      ws.addImage(imageId, {
        tl: { col: 5, row: 1 },            // F2 anchor
        ext: { width: 1100, height: 470 }
      });
    } catch (e) {
      ws.getCell('F2').value = `Chart render error: ${e.message || e}`;
    }
  }

  /* ─── Build one workbook for one bucket ─── */
  async function buildWorkbookForBucket(bucket, parameters, runDate, progressCb){
    const wb = new ExcelJS.Workbook();
    wb.creator  = 'Inventory Optimization App';
    wb.created  = new Date();

    // Index sheet
    const { ws: idx } = buildIndexSheet(wb, bucket, parameters, runDate);
    const taken = new Set(['Index']);

    // Per-material sheets — keyed by material number (matches reference)
    let progress = 0;
    const total = bucket.materials.length;
    const sheetNameByMat = new Map();

    for (const m of bucket.materials) {
      progress++;
      if (progressCb) progressCb(progress, total, m.material);
      const sname = safeSheetName(String(m.material), taken);
      sheetNameByMat.set(m.material, sname);
      const ws = wb.addWorksheet(sname);
      await buildMaterialSheet(wb, ws, m, parameters, runDate);
    }

    // Now add hyperlinks from Index column A → each material's sheet
    let r = 3;
    for (const m of bucket.materials) {
      const sname = sheetNameByMat.get(m.material);
      if (sname) {
        const cell = idx.getCell(`A${r}`);
        cell.value = { text: String(m.material), hyperlink: `#'${sname}'!A1` };
        cell.font  = { name:'Calibri', size:10, bold:true, underline:true, color:{ argb:'FF' + C.linkBlue } };
        cell.alignment = { horizontal:'left', vertical:'middle' };
        cell.border = thinBorder();
      }
      r++;
    }

    // Summary sheet — terse traffic-light counts (kept for reference)
    const sum = wb.addWorksheet('Summary');
    sum.getCell('A1').value = `${bucket.name} — Traffic-light Summary`;
    sum.getCell('A1').font  = { bold:true, size:13, name:'Calibri' };
    sum.mergeCells('A1:B1');
    sum.getRow(2).values = ['Light', 'Count'];
    sum.getRow(2).font   = { bold:true, name:'Calibri' };
    const order = ['GREEN','BLUE','ORANGE','RED','PURPLE','GREY'];
    let sr = 3;
    for (const k of order) {
      sum.getCell(`A${sr}`).value = k;
      sum.getCell(`B${sr}`).value = bucket.summary[k] || 0;
      sum.getCell(`A${sr}`).fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + TL_FILL[k] } };
      sum.getCell(`A${sr}`).font  = { bold:true, color:{ argb: TL_FONT_WHITE.includes(k) ? 'FFFFFFFF' : 'FF000000' }, name:'Calibri' };
      sr++;
    }
    sum.getCell(`A${sr}`).value = 'TOTAL';
    sum.getCell(`B${sr}`).value = bucket.summary.total || 0;
    sum.getCell(`A${sr}`).font  = { bold:true, name:'Calibri' };
    sum.getColumn(1).width = 14;
    sum.getColumn(2).width = 12;

    // Run metadata
    const meta = wb.addWorksheet('Run');
    meta.getCell('A1').value = 'Inventory Optimization · Analysis Run';
    meta.getCell('A1').font  = { bold:true, size:13, name:'Calibri' };
    const rows = [
      ['Bucket',           bucket.name],
      ['Bucket kind',      bucket.kind],
      ['Materials',        bucket.materials.length],
      ['Transactions',     bucket.txCount],
      ['Run date',         runDate],
      ['P1 start',         parameters.p1Start],
      ['P1 end',           parameters.p1End],
      ['P2 months',        parameters.p2Months],
      ['Min months',       parameters.minMonths],
      ['Max months',       parameters.maxMonths],
      ['Threshold',        parameters.threshold],
      ['HCE % threshold',  parameters.hcePctThreshold],
      ['HCE multiplier',   parameters.hceMultThreshold],
      ['Lumpy CV',         parameters.lumpyCvThreshold],
      ['Lumpy top-WO',     parameters.lumpyTopWoThreshold],
      ['Min/Max method',   parameters.minMaxMethod],
      ['Exported at',      AppLocale.localDateTimeISO()]
    ];
    rows.forEach((rr, i) => {
      meta.getCell(`A${i + 3}`).value = rr[0];
      meta.getCell(`A${i + 3}`).font  = { bold:true, name:'Calibri' };
      meta.getCell(`B${i + 3}`).value = rr[1];
    });
    meta.getColumn(1).width = 24;
    meta.getColumn(2).width = 38;

    return wb;
  }

  /* ─── Browser-side download trigger ─── */
  function triggerDownload(blob, filename){
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /* ─── Public: build + download a workbook for one bucket ─── */
  async function downloadBucket(bucket, parameters, opts){
    opts = opts || {};
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS not loaded — include the CDN script.');
    const wb = await buildWorkbookForBucket(bucket, parameters, opts.runDate || AppLocale.localDateISO(), opts.progress);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = sanitizeFile(opts.filename || `${(bucket.name || 'bucket').replace(/[^A-Za-z0-9_-]+/g,'_')}_Analysis.xlsx`);
    triggerDownload(blob, fname);
    return { filename: fname, sizeBytes: buf.byteLength };
  }

  /* ─── Public: build + download all buckets as separate workbooks ─── */
  async function downloadAll(result, opts){
    opts = opts || {};
    const out = [];
    for (const b of result.buckets) {
      const res = await downloadBucket(b, result.parameters, Object.assign({}, opts, {
        runDate:  result.runDate,
        filename: opts.namePrefix
          ? `${opts.namePrefix}_${b.name.replace(/[^A-Za-z0-9_-]+/g,'_')}_Analysis.xlsx`
          : `${b.name.replace(/[^A-Za-z0-9_-]+/g,'_')}_Analysis.xlsx`
      }));
      out.push(res);
    }
    return out;
  }

  /* ─── Combined workbook — Master Index across every bucket ─── */
  async function buildCombinedWorkbook(result, progressCb){
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Inventory Optimization App';
    wb.created = new Date();

    const parameters = result.parameters;
    const runDate    = result.runDate;

    // Master Index — every material, tagged by bucket
    const master = wb.addWorksheet('Master Index', {
      views: [{ state:'frozen', ySplit:2 }]
    });
    const masterCols = [{ key:'bucket', header:'Bucket', width:22, type:'string' }].concat(INDEX_COLS);
    masterCols.forEach((c, i) => master.getColumn(i + 1).width = c.width);

    // Title row
    master.mergeCells('A1:R1');
    const t = master.getCell('A1');
    t.value = `Combined Analysis — ${result.buckets.length} bucket(s) — Run: ${runDate}`;
    t.font  = { name:'Calibri', size:12, bold:true, color:{ argb:'FFFFFFFF' } };
    t.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.titleNavy } };
    t.alignment = { horizontal:'center', vertical:'middle' };
    master.getRow(1).height = 26;

    // Header row
    masterCols.forEach((col, i) => {
      const cell = master.getRow(2).getCell(i + 1);
      cell.value = col.header;
      cell.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri' };
      cell.fill  = { type:'pattern', pattern:'solid',
                     fgColor:{ argb:'FF' + (i === 0 ? C.headerGrey : (i >= 15 ? C.headerOrange : C.headerNavy)) } };
      cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
      cell.border = thinBorder();
    });
    master.getRow(2).height = 32;
    master.autoFilter = { from:{ row:2, column:1 }, to:{ row:2, column:masterCols.length } };

    // Cross-bucket Summary
    const xsum = wb.addWorksheet('Summary');
    xsum.getCell('A1').value = 'Cross-bucket Traffic-light Summary';
    xsum.getCell('A1').font  = { bold:true, size:13, name:'Calibri' };
    xsum.mergeCells('A1:G1');
    ['Bucket','GREEN','BLUE','ORANGE','RED','PURPLE','GREY','Total'].forEach((h, i) => {
      const c = xsum.getRow(2).getCell(i + 1);
      c.value = h;
      c.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri' };
      c.fill  = { type:'pattern', pattern:'solid',
                  fgColor:{ argb:'FF' + (i === 0 ? C.headerGrey : (TL_FILL[h] || C.headerNavy)) } };
      c.alignment = { horizontal:'center' };
    });

    let masterRow = 3, xsumRow = 3;
    const tlTot = { GREEN:0, BLUE:0, ORANGE:0, RED:0, PURPLE:0, GREY:0, total:0 };

    for (const bucket of result.buckets) {
      for (const m of bucket.materials) {
        const row = master.getRow(masterRow);
        row.getCell(1).value = bucket.name;
        INDEX_COLS.forEach((col, i) => {
          const cell = row.getCell(i + 2);
          cell.value = fmtIndexCell(col, m);
          cell.font  = { name:'Calibri', size:10 };
          cell.alignment = alignFor(col);
          cell.border = thinBorder();
        });
        // Traffic-light fill on master col 14 (Master col 1 + Index col 13)
        const tlCell = row.getCell(14);
        if (TL_FILL[m.trafficLight]) {
          tlCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + TL_FILL[m.trafficLight] } };
          tlCell.font = { bold:true, color:{ argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' }, name:'Calibri' };
          tlCell.alignment = { horizontal:'center', vertical:'middle' };
        }
        masterRow++;
      }
      const sr = xsum.getRow(xsumRow);
      sr.getCell(1).value = bucket.name;
      ['GREEN','BLUE','ORANGE','RED','PURPLE','GREY','total'].forEach((k, i) => {
        sr.getCell(i + 2).value = bucket.summary[k] || 0;
      });
      sr.getCell(8).font = { bold:true, name:'Calibri' };
      xsumRow++;
      ['GREEN','BLUE','ORANGE','RED','PURPLE','GREY','total'].forEach(k => tlTot[k] = (tlTot[k] || 0) + (bucket.summary[k] || 0));
    }
    // Totals row
    const tr = xsum.getRow(xsumRow);
    tr.getCell(1).value = 'TOTAL';
    ['GREEN','BLUE','ORANGE','RED','PURPLE','GREY','total'].forEach((k, i) => {
      tr.getCell(i + 2).value = tlTot[k] || 0;
    });
    tr.eachCell(c => { c.font = { bold:true, name:'Calibri' }; c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEEEEEE' } }; });

    xsum.getColumn(1).width = 28;
    for (let c = 2; c <= 8; c++) xsum.getColumn(c).width = 12;

    const meta = wb.addWorksheet('Run');
    meta.getCell('A1').value = 'Inventory Optimization · Combined Analysis Run';
    meta.getCell('A1').font  = { bold:true, size:13, name:'Calibri' };
    const totalMats = result.buckets.reduce((a, b) => a + b.materials.length, 0);
    const metaRows = [
      ['Run date',         runDate],
      ['Buckets',          result.buckets.length],
      ['Total materials',  totalMats],
      ['P1 start',         parameters.p1Start],
      ['P1 end',           parameters.p1End],
      ['P2 months',        parameters.p2Months],
      ['Min months',       parameters.minMonths],
      ['Max months',       parameters.maxMonths],
      ['Threshold',        parameters.threshold],
      ['HCE % threshold',  parameters.hcePctThreshold],
      ['HCE multiplier',   parameters.hceMultThreshold],
      ['Lumpy CV',         parameters.lumpyCvThreshold],
      ['Lumpy top-WO',     parameters.lumpyTopWoThreshold],
      ['Min/Max method',   parameters.minMaxMethod],
      ['Exported at',      AppLocale.localDateTimeISO()]
    ];
    metaRows.forEach((rr, i) => {
      meta.getCell(`A${i + 3}`).value = rr[0];
      meta.getCell(`A${i + 3}`).font  = { bold:true, name:'Calibri' };
      meta.getCell(`B${i + 3}`).value = rr[1];
    });
    meta.getColumn(1).width = 24;
    meta.getColumn(2).width = 38;

    if (progressCb) progressCb(totalMats, totalMats, 'done');

    return wb;
  }

  async function downloadCombined(result, opts){
    opts = opts || {};
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS not loaded — include the CDN script.');
    const wb = await buildCombinedWorkbook(result, opts.progress);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = sanitizeFile(opts.filename || `Combined_Analysis_${result.runDate || AppLocale.localDateISO()}.xlsx`);
    triggerDownload(blob, fname);
    return { filename: fname, sizeBytes: buf.byteLength };
  }

  function sanitizeFile(name){
    return String(name).replace(/[^A-Za-z0-9_.-]+/g, '_');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     MASS LLM REVIEW WORKBOOK (v2.0)
     Per-bucket reference shape + extra LLM columns + per-material LLM block.
     Only includes materials in the mass-review session (subset of bucket).
  ═══════════════════════════════════════════════════════════════════════ */

  const LLM_VERDICT_FILL = {
    ok:     '1FCED8',   // cyan
    tweak:  'F5A623',   // amber
    review: 'B83CD0'    // magenta
  };
  const LLM_VERDICT_FONT_WHITE = ['review'];

  async function buildMassReviewWorkbook(bucket, session, parameters, runDate, progressCb){
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Inventory Optimization App';
    wb.created = new Date();

    // Filter bucket.materials to only those in the session (preserve order)
    const matByKey = new Map(bucket.materials.map(m => [m.material, m]));
    const sessionMats = session.results
      .filter(r => matByKey.has(r.material))
      .map(r => matByKey.get(r.material));

    /* ─── Index sheet — adds Pre-LLM TL, LLM Verdict, LLM Notes columns ─── */
    const idx = wb.addWorksheet('Index', {
      views: [{ state:'frozen', ySplit: 2, xSplit: 0 }]
    });
    const cols = INDEX_COLS.concat([
      { key:'llmVerdict',  header:'LLM Verdict',  width:14, type:'llm' },
      { key:'llmNotes',    header:'LLM Notes',    width:60, type:'string' },
      { key:'llmLatency',  header:'LLM Latency',  width:12, type:'number' }
    ]);
    cols.forEach((c, i) => idx.getColumn(i + 1).width = c.width);

    // Title row merged across all columns
    const lastColLetter = numberToColumn(cols.length);
    idx.mergeCells(`A1:${lastColLetter}1`);
    const titleCell = idx.getCell('A1');
    const provText = `${session.provider || 'unknown'} · ${session.model || 'unknown'}`;
    titleCell.value = `${bucket.name} — Mass LLM Review (${provText})  |  Ran: ${session.startedAt || runDate}  |  ${session.results.filter(r => r.verdict).length} of ${session.total} reviewed`;
    titleCell.font = { name:'Calibri', size:12, bold:true, color:{ argb:'FFFFFFFF' } };
    titleCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + C.titleNavy } };
    titleCell.alignment = { vertical:'middle', horizontal:'center' };
    idx.getRow(1).height = 26;

    // Header row
    cols.forEach((col, i) => {
      const cell = idx.getRow(2).getCell(i + 1);
      cell.value = col.header;
      cell.font  = { bold:true, color:{ argb:'FFFFFFFF' }, name:'Calibri' };
      cell.fill  = { type:'pattern', pattern:'solid',
                     fgColor:{ argb:'FF' + (i >= INDEX_COLS.length ? '5E2A78' : (i >= 14 ? C.headerOrange : C.headerNavy)) } };
      cell.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
      cell.border = thinBorder();
    });
    idx.getRow(2).height = 32;

    // AutoFilter
    idx.autoFilter = { from:{ row:2, column:1 }, to:{ row:2, column:cols.length } };

    // Data rows
    const sheetNameByMat = new Map();
    let r = 3;
    for (const m of sessionMats) {
      const llm = session.results.find(x => x.material === m.material) || {};
      const row = idx.getRow(r);
      // Standard 17 columns
      INDEX_COLS.forEach((col, i) => {
        const cell = row.getCell(i + 1);
        cell.value = fmtIndexCell(col, m);
        cell.font  = { name:'Calibri', size:10 };
        cell.alignment = alignFor(col);
        cell.border = thinBorder();
      });
      // TL fill
      const tlCell = row.getCell(13);
      if (TL_FILL[m.trafficLight]) {
        tlCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + TL_FILL[m.trafficLight] } };
        tlCell.font = { bold:true, color:{ argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' }, name:'Calibri' };
        tlCell.alignment = { horizontal:'center', vertical:'middle' };
      }
      // LLM columns (18-20)
      const verdictCell = row.getCell(INDEX_COLS.length + 1);
      verdictCell.value = llm.verdict || (llm.error ? 'ERROR' : '—');
      verdictCell.alignment = { horizontal:'center', vertical:'middle' };
      verdictCell.border = thinBorder();
      verdictCell.font  = { name:'Calibri', size:10, bold:true };
      if (llm.verdict && LLM_VERDICT_FILL[llm.verdict]) {
        verdictCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + LLM_VERDICT_FILL[llm.verdict] } };
        verdictCell.font.color = { argb: LLM_VERDICT_FONT_WHITE.includes(llm.verdict) ? 'FFFFFFFF' : 'FF072025' };
      } else if (llm.error) {
        verdictCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFC7CE' } };
        verdictCell.font.color = { argb:'FF9C0006' };
      }
      const notesCell = row.getCell(INDEX_COLS.length + 2);
      notesCell.value = llm.notes || (llm.error ? `ERROR: ${llm.error}` : '');
      notesCell.font  = { name:'Calibri', size:10 };
      notesCell.alignment = { horizontal:'left', vertical:'middle', wrapText:true };
      notesCell.border = thinBorder();
      const latencyCell = row.getCell(INDEX_COLS.length + 3);
      latencyCell.value = llm.latencyMs != null ? `${(llm.latencyMs/1000).toFixed(1)} s` : '';
      latencyCell.font  = { name:'Calibri', size:10 };
      latencyCell.alignment = { horizontal:'right', vertical:'middle' };
      latencyCell.border = thinBorder();
      r++;
    }

    /* ─── Per-material sheets ─── */
    const taken = new Set(['Index']);
    let progress = 0;
    for (const m of sessionMats) {
      progress++;
      if (progressCb) progressCb(progress, sessionMats.length, m.material);
      const llm = session.results.find(x => x.material === m.material) || {};
      const sname = safeSheetName(String(m.material), taken);
      sheetNameByMat.set(m.material, sname);
      const ws = wb.addWorksheet(sname);
      await buildMaterialSheet(wb, ws, m, parameters, runDate);
      // Append an LLM Review block at the bottom
      appendLlmBlockToMaterialSheet(ws, llm, session);
    }

    // Hyperlinks on Index column A
    let rr = 3;
    for (const m of sessionMats) {
      const sname = sheetNameByMat.get(m.material);
      if (sname) {
        const cell = idx.getCell(`A${rr}`);
        cell.value = { text: String(m.material), hyperlink: `#'${sname}'!A1` };
        cell.font  = { name:'Calibri', size:10, bold:true, underline:true, color:{ argb:'FF' + C.linkBlue } };
        cell.alignment = { horizontal:'left', vertical:'middle' };
        cell.border = thinBorder();
      }
      rr++;
    }

    /* ─── Run metadata sheet ─── */
    const meta = wb.addWorksheet('Run');
    meta.getCell('A1').value = 'Mass LLM Review · Run metadata';
    meta.getCell('A1').font  = { bold:true, size:13, name:'Calibri' };
    const rows = [
      ['Bucket',           bucket.name],
      ['Materials reviewed', session.results.filter(r => r.verdict).length],
      ['Errored',          session.results.filter(r => r.error).length],
      ['Skipped',          session.results.filter(r => r.status === 'skipped').length],
      ['Total selected',   session.total],
      ['Provider',         session.provider || '—'],
      ['Model',            session.model    || '—'],
      ['Prompt hash',      session.promptHash || '—'],
      ['Started at',       session.startedAt || '—'],
      ['Completed at',     session.completedAt || '—'],
      ['Run date',         runDate],
      ['P2 months',        parameters.p2Months],
      ['Threshold',        parameters.threshold],
      ['Exported at',      AppLocale.localDateTimeISO()]
    ];
    rows.forEach((rr, i) => {
      meta.getCell(`A${i + 3}`).value = rr[0];
      meta.getCell(`A${i + 3}`).font  = { bold:true, name:'Calibri' };
      meta.getCell(`B${i + 3}`).value = rr[1];
    });
    meta.getColumn(1).width = 22;
    meta.getColumn(2).width = 56;

    return wb;
  }

  function appendLlmBlockToMaterialSheet(ws, llm, session){
    // Find a row below the existing content
    let r = ws.lastRow ? ws.lastRow.number + 3 : 40;
    if (r < 40) r = 40;
    ws.mergeCells(`B${r}:D${r}`);
    const title = ws.getCell(`B${r}`);
    title.value = 'LLM Review';
    title.font  = { name:'Calibri', size:11, bold:true, color:{ argb:'FFFFFFFF' } };
    title.fill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF5E2A78' } };   // purple-ish for distinction
    title.alignment = { horizontal:'left', vertical:'middle' };
    ws.getRow(r).height = 20;
    r++;

    const rows = [
      ['Provider',     session.provider || '—'],
      ['Model',        session.model    || '—'],
      ['Prompt hash',  session.promptHash || '—'],
      ['Verdict',      llm.verdict || (llm.error ? 'ERROR' : '—')],
      ['Notes',        llm.notes || (llm.error ? `ERROR: ${llm.error}` : '')],
      ['Suggested edits', llm.suggestedEdits && llm.suggestedEdits.length
                            ? llm.suggestedEdits.map(e => `${e.field}=${JSON.stringify(e.newValue)} (${e.rationale || ''})`).join(' · ')
                            : 'none'],
      ['Latency',      llm.latencyMs != null ? `${(llm.latencyMs/1000).toFixed(1)} s` : '—'],
      ['Timestamp',    llm.timestamp || '—']
    ];
    rows.forEach((pair, i) => {
      const row = ws.getRow(r + i);
      row.getCell(2).value = pair[0];
      row.getCell(2).font  = { name:'Calibri', size:10, bold:true };
      row.getCell(2).border = thinBorder();
      const valueCell = row.getCell(3);
      valueCell.value = pair[1];
      valueCell.font  = { name:'Calibri', size:10 };
      valueCell.alignment = { horizontal:'left', vertical:'middle', wrapText:true };
      valueCell.border = thinBorder();
      ws.mergeCells(`C${r + i}:D${r + i}`);
      // Highlight Verdict row
      if (pair[0] === 'Verdict' && llm.verdict && LLM_VERDICT_FILL[llm.verdict]) {
        valueCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF' + LLM_VERDICT_FILL[llm.verdict] } };
        valueCell.font = { name:'Calibri', size:10, bold:true,
                           color:{ argb: LLM_VERDICT_FONT_WHITE.includes(llm.verdict) ? 'FFFFFFFF' : 'FF072025' } };
      }
    });
  }

  /* Helper: column index (1-based) → Excel column letter(s) */
  function numberToColumn(n){
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  async function downloadMassReview(bucket, session, parameters, opts){
    opts = opts || {};
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS not loaded.');
    const wb = await buildMassReviewWorkbook(bucket, session, parameters, opts.runDate || AppLocale.localDateISO(), opts.progress);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = sanitizeFile(opts.filename || `Mass_LLM_Review_${bucket.name.replace(/[^A-Za-z0-9_-]+/g,'_')}.xlsx`);
    triggerDownload(blob, fname);
    return { filename: fname, sizeBytes: buf.byteLength };
  }

  global.AppExcel = Object.freeze({
    buildWorkbookForBucket,
    downloadBucket,
    downloadAll,
    buildCombinedWorkbook,
    downloadCombined,
    buildMassReviewWorkbook,
    downloadMassReview
  });

})(window);
