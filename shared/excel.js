/* ═══════════════════════════════════════════════════════════════════════════
   Excel export — per-bucket workbook with Index + per-material sheets +
   embedded chart images. Mirrors the existing Python output's shape.

   Depends on: ExcelJS (loaded via CDN before this), AppChart (chart capture).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Traffic-light fills (hex without #, matching ExcelJS ARGB format) ─── */
  const TL_FILL = {
    GREEN:  '00B050',
    ORANGE: 'FF8C00',
    BLUE:   '3498DB',
    RED:    'FF0000',
    GREY:   'C0C0C0'
  };
  const TL_FONT_WHITE = ['GREEN','ORANGE','BLUE','RED'];

  /* ─── Header columns for the Index sheet ────────────────────────────────── */
  const INDEX_HEADERS = [
    'Material No.', 'Material Description', 'Total Consumed',
    'P1 Rate (u/mo)', 'P2 Rate (u/mo)', 'Rate Change %',
    'Current Stock', 'MRP Type', 'Current Min', 'Current Max',
    'Recommended Min', 'Recommended Max', 'Traffic Light', 'Action Required',
    'HCE Flag (P2)', 'Adj P2 Rate (excl HCE)', 'Pattern'
  ];

  function pad(n){ return String(n).padStart(2, '0'); }

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

  /* ─── Render a chart into an offscreen SVG, return PNG data URL ─────────── */
  async function renderChartPng(material){
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:720px;height:340px;visibility:hidden;';
    document.body.appendChild(host);
    try {
      const svg = AppChart.render(host, material, { width: 720, height: 340 });
      const png = await AppChart.toPng(svg, 2);
      return png;
    } finally {
      document.body.removeChild(host);
    }
  }

  /* ─── Build one workbook for one bucket ─────────────────────────────────── */
  async function buildWorkbookForBucket(bucket, parameters, runDate, progressCb){
    const wb = new ExcelJS.Workbook();
    wb.creator  = 'Inventory Optimization App';
    wb.created  = new Date();

    /* ─── Index sheet ─────────────────────────────────────────────────────── */
    const idx = wb.addWorksheet('Index', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    idx.columns = INDEX_HEADERS.map((h, i) => ({
      header: h,
      key:    'c' + i,
      width:  i === 14 ? 30 : (i === 13 ? 36 : (i === 1 ? 32 : 16))
    }));
    // Header style
    idx.getRow(1).eachCell((cell, col) => {
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: col >= 15 ? 'FF7B4F00' : 'FF1B4F72' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    idx.getRow(1).height = 28;

    const taken = new Set(['Index']);

    /* ─── Per-material sheets + index rows ────────────────────────────────── */
    let row = 2;
    let progress = 0;
    const total = bucket.materials.length;

    for (const m of bucket.materials) {
      progress++;
      if (progressCb) progressCb(progress, total, m.material);

      /* Index row */
      const p1Disp = m.p1Flag === 'OK' ? m.p1Rate : `0 [${m.p1Flag}]`;
      const p2Disp = m.p2Flag === 'OK' ? m.p2Rate : `0 [${m.p2Flag}]`;
      const adjDisp = (m.hceP2 && m.hceP2.length)
                        ? (m.adjP2Flag === 'OK' ? m.adjP2Rate : `0 [${m.adjP2Flag || 'NO_DATA'}]`)
                        : '';
      const hceFlagText = (m.hceP2 && m.hceP2.length)
                        ? `WO ${m.hceP2[0].order} | ${m.hceP2[0].date} | ${m.hceP2[0].equipment} | ${m.hceP2[0].qty} units (${m.hceP2[0].pct}% of P2)${m.hceP2.length > 1 ? ` [+${m.hceP2.length - 1} more]` : ''}`
                        : '';
      const rcDisp = m.rateChange != null ? `${m.rateChange}%` : 'N/A';

      const r = idx.getRow(row);
      r.getCell(1).value  = m.material;
      r.getCell(2).value  = m.description;
      r.getCell(3).value  = m.totalNet;
      r.getCell(4).value  = p1Disp;
      r.getCell(5).value  = p2Disp;
      r.getCell(6).value  = rcDisp;
      r.getCell(7).value  = m.stock;
      r.getCell(8).value  = m.mrpType;
      r.getCell(9).value  = m.cmin;
      r.getCell(10).value = m.cmax;
      r.getCell(11).value = m.recMin != null ? m.recMin : 'Review';
      r.getCell(12).value = m.recMax != null ? m.recMax : 'Review';
      r.getCell(13).value = m.trafficLight;
      r.getCell(14).value = m.action;
      r.getCell(15).value = hceFlagText;
      r.getCell(16).value = adjDisp;
      r.getCell(17).value = m.pattern;

      // Traffic-light cell styling
      const tlCell = r.getCell(13);
      tlCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + TL_FILL[m.trafficLight] } };
      tlCell.font = { bold: true, color: { argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' } };
      tlCell.alignment = { horizontal: 'center', vertical: 'middle' };

      // HCE columns amber-tinted if flagged
      if (hceFlagText) {
        for (const col of [15, 16]) {
          r.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
          r.getCell(col).font = { color: { argb: 'FF7B4F00' }, bold: true };
        }
      }

      /* Per-material sheet */
      const sname = safeSheetName(m.material, taken);
      const ws = wb.addWorksheet(sname);
      ws.columns = [
        { width: 44 },
        { width: 32 },
        { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 22 }
      ];

      ws.getCell('A1').value = 'Field';
      ws.getCell('B1').value = 'Value';
      ws.getCell('A1').font  = { bold: true };
      ws.getCell('B1').font  = { bold: true };

      const stats = [
        ['Material No.',                       m.material],
        ['Description',                        m.description],
        ['Total Consumed (analysis window)',   m.totalNet],
        [`P1 Rate · ${m.p1Start} → ${m.p1End} (u/mo)`, p1Disp],
        [`P2 Rate · ${m.p2Start} → ${m.p2End} (u/mo)`, p2Disp],
        ['Adj P2 Rate (HCE excl, display)',    adjDisp || 'N/A (no HCE detected)'],
        ['Rate Change P1 → P2',                rcDisp],
        ['Pattern',                            m.pattern],
        ['Current Stock',                      m.stock],
        ['MRP Type',                           m.mrpType],
        ['Current Min',                        m.cmin],
        ['Current Max',                        m.cmax],
        ['Recommended Min',                    m.recMin != null ? m.recMin : 'Review'],
        ['Recommended Max',                    m.recMax != null ? m.recMax : 'Review'],
        ['Traffic Light',                      m.trafficLight],
        ['Action Required',                    m.action]
      ];
      stats.forEach((pair, i) => {
        const rr = ws.getRow(i + 2);
        rr.getCell(1).value = pair[0];
        rr.getCell(2).value = pair[1];
        if (pair[0].startsWith('Adj P2')) {
          rr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
          rr.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
          rr.getCell(1).font = { italic: true, color: { argb: 'FF7B4F00' } };
          rr.getCell(2).font = { italic: true, color: { argb: 'FF7B4F00' } };
        }
        if (pair[0] === 'Traffic Light') {
          rr.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + TL_FILL[m.trafficLight] } };
          rr.getCell(2).font = { bold: true, color: { argb: TL_FONT_WHITE.includes(m.trafficLight) ? 'FFFFFFFF' : 'FF000000' } };
        }
      });

      let nextRow = stats.length + 3;

      /* HCE table (if any events) */
      if ((m.hceP1 && m.hceP1.length) || (m.hceP2 && m.hceP2.length)) {
        nextRow = writeHceTable(ws, nextRow, m.hceP1 || [], m.hceP2 || []);
      }

      /* Embedded chart image */
      try {
        const png = await renderChartPng(m);
        const imageId = wb.addImage({
          base64: png,
          extension: 'png'
        });
        ws.addImage(imageId, {
          tl: { col: 3, row: 1 },          // anchor at D2 area
          ext: { width: 720, height: 340 }
        });
      } catch (e) {
        ws.getCell('D2').value = `Chart render error: ${e.message || e}`;
      }
    }

    /* ─── Summary sheet (traffic-light counts) ────────────────────────────── */
    const sum = wb.addWorksheet('Summary', { state: 'visible' });
    sum.getCell('A1').value = 'TRAFFIC LIGHT SUMMARY';
    sum.getCell('A1').font  = { bold: true, size: 14 };
    sum.mergeCells('A1:B1');
    sum.getRow(2).values = ['Light', 'Count'];
    sum.getRow(2).font   = { bold: true };
    const order = ['GREEN','BLUE','ORANGE','RED','GREY'];
    let sr = 3;
    for (const k of order) {
      sum.getCell(`A${sr}`).value = k;
      sum.getCell(`B${sr}`).value = bucket.summary[k] || 0;
      sum.getCell(`A${sr}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + TL_FILL[k] } };
      sum.getCell(`A${sr}`).font = { bold: true, color: { argb: TL_FONT_WHITE.includes(k) ? 'FFFFFFFF' : 'FF000000' } };
      sr++;
    }
    sum.getCell(`A${sr}`).value = 'TOTAL';
    sum.getCell(`B${sr}`).value = bucket.summary.total || 0;
    sum.getCell(`A${sr}`).font  = { bold: true };
    sum.getColumn(1).width = 14;
    sum.getColumn(2).width = 12;

    // Metadata sheet
    const meta = wb.addWorksheet('Run');
    meta.getCell('A1').value = 'Inventory Optimization · Analysis Run';
    meta.getCell('A1').font  = { bold: true, size: 14 };
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
      ['Exported at',      new Date().toISOString()]
    ];
    rows.forEach((r, i) => {
      meta.getCell(`A${i + 3}`).value = r[0];
      meta.getCell(`A${i + 3}`).font  = { bold: true };
      meta.getCell(`B${i + 3}`).value = r[1];
    });
    meta.getColumn(1).width = 24;
    meta.getColumn(2).width = 38;

    return wb;
  }

  function writeHceTable(ws, startRow, hceP1, hceP2){
    let r = startRow;
    const titleCell = ws.getCell(`A${r}`);
    titleCell.value = 'HIGH CONSUMPTION EVENTS DETECTED';
    titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF8C00' } };
    titleCell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.mergeCells(`A${r}:G${r}`);
    r++;
    const noteCell = ws.getCell(`A${r}`);
    noteCell.value = 'NOTE: Unusually large single-job consumption. Adjusted P2 rate (HCE excluded) shown above. Official P2 rate unchanged.';
    noteCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    noteCell.font = { italic: true, color: { argb: 'FF7B4F00' } };
    ws.mergeCells(`A${r}:G${r}`);
    r++;
    const headers = ['Period','Work Order','Date','Equipment','Qty (issue)','% of Period','Flag Reason'];
    headers.forEach((h, i) => {
      const c = ws.getRow(r).getCell(i + 1);
      c.value = h;
      c.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };
      c.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.alignment = { horizontal: 'center' };
    });
    r++;
    const events = [...(hceP1 || []), ...(hceP2 || [])];
    for (const e of events) {
      const row = ws.getRow(r);
      const tint = String(e.period).startsWith('P2') ? 'FFFFCCCC' : 'FFFFE0CC';
      row.getCell(1).value = e.period;
      row.getCell(2).value = e.order;
      row.getCell(3).value = e.date;
      row.getCell(4).value = e.equipment;
      row.getCell(5).value = e.qty;
      row.getCell(6).value = `${e.pct}%`;
      row.getCell(7).value = e.reasons;
      for (let c = 1; c <= 7; c++) {
        row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tint } };
      }
      row.getCell(5).alignment = { horizontal: 'right' };
      r++;
    }
    return r + 1;
  }

  /* ─── Browser-side download trigger ─────────────────────────────────────── */
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

  /* ─── Public: build + download a workbook for one bucket ────────────────── */
  async function downloadBucket(bucket, parameters, opts){
    opts = opts || {};
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS not loaded — include the CDN script.');
    const wb = await buildWorkbookForBucket(bucket, parameters, opts.runDate || new Date().toISOString().slice(0, 10), opts.progress);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = sanitizeFile(opts.filename || `analysis-${bucket.name}-${new Date().toISOString().slice(0,10)}.xlsx`);
    triggerDownload(blob, fname);
    return { filename: fname, sizeBytes: buf.byteLength };
  }

  /* ─── Public: build + download all buckets as separate workbooks ────────── */
  async function downloadAll(result, opts){
    opts = opts || {};
    const out = [];
    for (const b of result.buckets) {
      const res = await downloadBucket(b, result.parameters, Object.assign({}, opts, {
        runDate:  result.runDate,
        filename: opts.namePrefix
          ? `${opts.namePrefix}-${b.name}.xlsx`
          : `analysis-${b.name}-${result.runDate}.xlsx`
      }));
      out.push(res);
    }
    return out;
  }

  /* ─── Build one combined workbook with every bucket as its own sheet ────── */
  async function buildCombinedWorkbook(result, progressCb){
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Inventory Optimization App';
    wb.created = new Date();

    const parameters = result.parameters;
    const runDate    = result.runDate;

    /* ─── Master Index — every material across every bucket ───────────────── */
    const master = wb.addWorksheet('Master Index', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    const masterHeaders = ['Bucket', ...INDEX_HEADERS];
    master.columns = masterHeaders.map((h, i) => ({
      header: h,
      key:    'c' + i,
      width:  i === 0 ? 22 : (i === 15 ? 30 : (i === 14 ? 36 : (i === 2 ? 32 : 16)))
    }));
    master.getRow(1).eachCell((cell, col) => {
      cell.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: col === 1 ? 'FF0F3E5C' : (col >= 16 ? 'FF7B4F00' : 'FF1B4F72') } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    master.getRow(1).height = 28;

    /* ─── Cross-bucket Summary ────────────────────────────────────────────── */
    const xsum = wb.addWorksheet('Summary', { state: 'visible' });
    xsum.getCell('A1').value = 'CROSS-BUCKET TRAFFIC-LIGHT SUMMARY';
    xsum.getCell('A1').font  = { bold: true, size: 14 };
    xsum.mergeCells('A1:G1');
    const sumHeaders = ['Bucket', 'GREEN', 'BLUE', 'ORANGE', 'RED', 'GREY', 'Total'];
    xsum.getRow(2).values = sumHeaders;
    xsum.getRow(2).font   = { bold: true };
    xsum.getRow(2).eachCell((cell, col) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col === 1 ? 'FF0F3E5C' : ('FF' + (TL_FILL[sumHeaders[col-1]] || '777777')) } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center' };
    });

    let masterRow = 2;
    let xsumRow = 3;
    const taken = new Set(['Master Index', 'Summary', 'Run']);

    /* ─── Per-bucket sheets ───────────────────────────────────────────────── */
    let totalMats = result.buckets.reduce((a, b) => a + b.materials.length, 0);
    let done = 0;

    const tl_total = { GREEN: 0, BLUE: 0, ORANGE: 0, RED: 0, GREY: 0, total: 0 };

    for (const bucket of result.buckets) {
      /* Bucket sheet name */
      const bsheetName = safeSheetName(`B · ${bucket.name}`, taken);
      const ws = wb.addWorksheet(bsheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = INDEX_HEADERS.map((h, i) => ({
        header: h,
        key:    'c' + i,
        width:  i === 14 ? 30 : (i === 13 ? 36 : (i === 1 ? 32 : 16))
      }));
      ws.getRow(1).eachCell((cell, col) => {
        cell.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: col >= 15 ? 'FF7B4F00' : 'FF1B4F72' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      });
      ws.getRow(1).height = 28;

      let bRow = 2;

      for (const m of bucket.materials) {
        done++;
        if (progressCb) progressCb(done, totalMats, `${bucket.name} · ${m.material}`);

        const p1Disp = m.p1Flag === 'OK' ? m.p1Rate : `0 [${m.p1Flag}]`;
        const p2Disp = m.p2Flag === 'OK' ? m.p2Rate : `0 [${m.p2Flag}]`;
        const adjDisp = (m.hceP2 && m.hceP2.length)
                          ? (m.adjP2Flag === 'OK' ? m.adjP2Rate : `0 [${m.adjP2Flag || 'NO_DATA'}]`)
                          : '';
        const hceFlagText = (m.hceP2 && m.hceP2.length)
                          ? `WO ${m.hceP2[0].order} | ${m.hceP2[0].date} | ${m.hceP2[0].equipment} | ${m.hceP2[0].qty} units (${m.hceP2[0].pct}% of P2)${m.hceP2.length > 1 ? ` [+${m.hceP2.length - 1} more]` : ''}`
                          : '';
        const rcDisp = m.rateChange != null ? `${m.rateChange}%` : 'N/A';

        const rowValues = [
          m.material, m.description, m.totalNet,
          p1Disp, p2Disp, rcDisp,
          m.stock, m.mrpType, m.cmin, m.cmax,
          m.recMin != null ? m.recMin : 'Review',
          m.recMax != null ? m.recMax : 'Review',
          m.trafficLight, m.action, hceFlagText, adjDisp, m.pattern
        ];

        /* Bucket sheet row */
        const br = ws.getRow(bRow);
        rowValues.forEach((v, i) => { br.getCell(i + 1).value = v; });
        stylTrafficCell(br.getCell(13), m.trafficLight);
        if (hceFlagText) {
          for (const col of [15, 16]) {
            br.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
            br.getCell(col).font = { color: { argb: 'FF7B4F00' }, bold: true };
          }
        }
        bRow++;

        /* Master index row */
        const mr = master.getRow(masterRow);
        mr.getCell(1).value = bucket.name;
        rowValues.forEach((v, i) => { mr.getCell(i + 2).value = v; });
        stylTrafficCell(mr.getCell(14), m.trafficLight);
        if (hceFlagText) {
          for (const col of [16, 17]) {
            mr.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
            mr.getCell(col).font = { color: { argb: 'FF7B4F00' }, bold: true };
          }
        }
        masterRow++;
      }

      /* Cross-bucket summary row */
      const sr = xsum.getRow(xsumRow);
      sr.getCell(1).value = bucket.name;
      sr.getCell(2).value = bucket.summary.GREEN  || 0;
      sr.getCell(3).value = bucket.summary.BLUE   || 0;
      sr.getCell(4).value = bucket.summary.ORANGE || 0;
      sr.getCell(5).value = bucket.summary.RED    || 0;
      sr.getCell(6).value = bucket.summary.GREY   || 0;
      sr.getCell(7).value = bucket.summary.total  || 0;
      sr.getCell(7).font  = { bold: true };
      xsumRow++;

      tl_total.GREEN  += bucket.summary.GREEN  || 0;
      tl_total.BLUE   += bucket.summary.BLUE   || 0;
      tl_total.ORANGE += bucket.summary.ORANGE || 0;
      tl_total.RED    += bucket.summary.RED    || 0;
      tl_total.GREY   += bucket.summary.GREY   || 0;
      tl_total.total  += bucket.summary.total  || 0;
    }

    /* Totals row on cross-bucket summary */
    const tr = xsum.getRow(xsumRow);
    tr.getCell(1).value = 'TOTAL';
    tr.getCell(2).value = tl_total.GREEN;
    tr.getCell(3).value = tl_total.BLUE;
    tr.getCell(4).value = tl_total.ORANGE;
    tr.getCell(5).value = tl_total.RED;
    tr.getCell(6).value = tl_total.GREY;
    tr.getCell(7).value = tl_total.total;
    tr.eachCell(cell => { cell.font = { bold: true }; cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFEEEEEE' } }; });

    xsum.getColumn(1).width = 28;
    for (let c = 2; c <= 7; c++) xsum.getColumn(c).width = 12;

    /* ─── Run metadata sheet ──────────────────────────────────────────────── */
    const meta = wb.addWorksheet('Run');
    meta.getCell('A1').value = 'Inventory Optimization · Combined Analysis Run';
    meta.getCell('A1').font  = { bold: true, size: 14 };
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
      ['Exported at',      new Date().toISOString()]
    ];
    metaRows.forEach((r, i) => {
      meta.getCell(`A${i + 3}`).value = r[0];
      meta.getCell(`A${i + 3}`).font  = { bold: true };
      meta.getCell(`B${i + 3}`).value = r[1];
    });
    meta.getColumn(1).width = 24;
    meta.getColumn(2).width = 38;

    return wb;
  }

  function stylTrafficCell(cell, tl){
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (TL_FILL[tl] || '777777') } };
    cell.font = { bold: true, color: { argb: TL_FONT_WHITE.includes(tl) ? 'FFFFFFFF' : 'FF000000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }

  /* ─── Public: combined single-workbook export ───────────────────────────── */
  async function downloadCombined(result, opts){
    opts = opts || {};
    if (typeof ExcelJS === 'undefined') throw new Error('ExcelJS not loaded — include the CDN script.');
    const wb = await buildCombinedWorkbook(result, opts.progress);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = sanitizeFile(opts.filename || `analysis-ALL-${result.runDate || new Date().toISOString().slice(0,10)}.xlsx`);
    triggerDownload(blob, fname);
    return { filename: fname, sizeBytes: buf.byteLength };
  }

  function sanitizeFile(name){
    return String(name).replace(/[^A-Za-z0-9_.-]+/g, '_');
  }

  global.AppExcel = Object.freeze({
    buildWorkbookForBucket,
    downloadBucket,
    downloadAll,
    buildCombinedWorkbook,
    downloadCombined
  });

})(window);
