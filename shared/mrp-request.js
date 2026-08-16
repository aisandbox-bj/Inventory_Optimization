/* ═══════════════════════════════════════════════════════════════════════════
   shared/mrp-request.js · APP-MRP-REQ (2026-08-15)
   ───────────────────────────────────────────────────────────────────────────
   "MRP Request Template" — a planner-facing Excel a stores/reliability analyst
   hands to the MRP controller to justify a Min/Max/MRP-type change on a SAP
   inventory material. Scoped to the ★ For-Action (analyst-reviewed) materials.

   Per flagged SAP material it carries:
     · SAP # · description · Stock on hand · Unit cost (moving-avg price)
     · CURRENT MRP type / Min / Max / Safety Stock (from the Inventory Master)
     · algorithmic RECOMMENDED MRP / Min / Max
     · the ANALYST recommendation (MRP / Min / Max / SS) from the sidecar
     · WHERE-USED population: the fleet models it was issued to, how many units
       it was OBSERVED on, and an ESTIMATED unit population (see estimate rule).
     · open RESERVATIONS (from the Inventory Master), for planner context.

   ── Population estimate (borrowed from the dev-handoff spec, Step 4) ─────────
   1. Build a fleet register from Fleet Master: every unit → (Manufacturer,
      base-model), where base-model = the first token of the model string
      (F350/F550 keep their number; trims/suffixes drop).
   2. Observed set = the (Manufacturer, base-model) of the units the material was
      ACTUALLY issued to (MB51 261 → IW39 order → Sort Field → Fleet unit).
   3. Estimated population = every register unit whose (Manufacturer, base-model)
      matches an observed one.
   Reported alongside the observed evidence (units, basis %) so the planner sees
   the basis — this is an ESTIMATE, not a system count (a caveat says so in the
   sheet). If Fleet Master carries no Manufacturer, the match degrades to
   base-model only and the sheet flags that.

   Availability: needs Fleet Master + IW39 (for where-used) AND ≥1 flagged
   material. AppMrpRequest.canDownload(json, flaggedCount) → {ok, reason}.

   No SCHEMA_VERSION change. Deterministic; no LLM/web fields.
   Depends on globals: ExcelJS, WhereUsed (both already loaded on the Trend page).
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function n(v){ const x = Number(v); return Number.isFinite(x) ? x : null; }
  function baseModel(model){
    const s = String(model == null ? '' : model).trim();
    if (!s) return '';
    return s.split(/[\s\-\/]+/)[0].toUpperCase();
  }
  function famKey(mfr, bm){ return String(mfr || '').trim().toUpperCase() + '||' + bm; }

  /* Build the fleet register: every unit → (manufacturer, base-model), plus a
     Sort Field → unit lookup for resolving observed usage. */
  function fleetRegister(json){
    const fleet = (json && json.data && json.data.fleetMaster) || [];
    const units = [];
    const bySf  = new Map();
    let mfrCount = 0;
    for (const u of fleet){
      const sf    = String(u.sortField || '').trim();
      const model = String(u.model || '').trim();
      const mfr   = String(u.manufacturer || '').trim();
      if (mfr) mfrCount++;
      const rec = { sortField: sf, model, manufacturer: mfr, baseModel: baseModel(model), key: famKey(mfr, baseModel(model)) };
      units.push(rec);
      if (sf && !bySf.has(sf)) bySf.set(sf, rec);
    }
    return { units, bySf, hasMfr: mfrCount > 0, total: units.length };
  }

  /* The (Manufacturer, base-model) families a material was OBSERVED on, plus the
     observed unit list. Uses WhereUsed.compute → its woEntries carry the Sort
     Field of each destination the material was actually issued to. */
  function observedFor(json, material, reg){
    const wu = (typeof WhereUsed !== 'undefined') ? WhereUsed.compute(json, material) : null;
    const sfs = new Set();
    if (wu && wu.woEntries) wu.woEntries.forEach(e => { if (e.sortField) sfs.add(String(e.sortField).trim()); });
    const famKeys = new Set();
    const models  = new Set();
    let matchedUnits = 0, unresolvedSf = 0;
    sfs.forEach(sf => {
      const u = reg.bySf.get(sf);
      if (u){ famKeys.add(u.key); if (u.model) models.add(u.model); matchedUnits++; }
      else unresolvedSf++;
    });
    return { famKeys, models: [...models].sort(), observedUnits: matchedUnits, unresolvedSf, hasWu: !!(wu && wu.available) };
  }

  /* One template row per flagged material. `materials` = the deduped flagged
     material objects (pipeline output); `analyst` = the AnalystMarks handle. */
  function templateRows(json, materials, analyst){
    const reg = fleetRegister(json);
    return materials.map(m => {
      const obs = observedFor(json, m.material, reg);
      const estPop = reg.units.reduce((s, u) => s + (obs.famKeys.has(u.key) ? 1 : 0), 0);
      const rec = (analyst && typeof analyst.getRec === 'function') ? (analyst.getRec(m.material) || {}) : {};
      return {
        material:    m.material,
        description: m.description || '',
        stock:       n(m.stock),
        unitCost:    n(m.movingAvgPrice),
        reservations: n(m.totalReservation),
        curMrp: m.mrpType || '', curMin: n(m.cmin), curMax: n(m.cmax), curSS: n(m.safetyStock),
        recMrp: m.recMrpType || '', recMin: n(m.recMin), recMax: n(m.recMax),
        anMrp: rec.mrpType || '', anMin: rec.min || '', anMax: rec.max || '', anSS: rec.safety || '',
        whereUsedModels: obs.models.join(', '),
        observedUnits: obs.observedUnits,
        estPopulation: estPop,
        basisPct: estPop > 0 ? Math.round((obs.observedUnits / estPop) * 100) : null,
        unresolvedSf: obs.unresolvedSf
      };
    });
  }

  /* Gate: the template needs Fleet Master + IW39 (for where-used) AND ≥1 flagged
     material. Returns { ok, reason } — reason feeds the greyed button tooltip. */
  function canDownload(json, flaggedCount){
    const d = (json && json.data) || {};
    const missing = [];
    if (!(d.iw39 && d.iw39.length))         missing.push('IW39 (work orders)');
    if (!(d.fleetMaster && d.fleetMaster.length)) missing.push('Fleet Master');
    if (missing.length) return { ok:false, reason: 'Load ' + missing.join(' + ') + ' to populate where-used.' };
    if (!flaggedCount)  return { ok:false, reason: 'Flag at least one material For Action (★) first.' };
    return { ok:true, reason: '' };
  }

  /* ─── Excel build + download ─────────────────────────────────────────────── */
  const COLS = [
    { h:'SAP material #',     k:'material',        w:16, t:'text' },
    { h:'Description',        k:'description',      w:38, t:'text' },
    { h:'Stock on hand',      k:'stock',            w:13, t:'num'  },
    { h:'Unit cost (CAD)',    k:'unitCost',         w:14, t:'money'},
    { h:'Open reservations',  k:'reservations',     w:15, t:'num'  },
    { h:'Current MRP',        k:'curMrp',           w:11, t:'text' },
    { h:'Current Min',        k:'curMin',           w:11, t:'num'  },
    { h:'Current Max',        k:'curMax',           w:11, t:'num'  },
    { h:'Current SS',         k:'curSS',            w:11, t:'num'  },
    { h:'Recommended MRP',    k:'recMrp',           w:14, t:'text' },
    { h:'Recommended Min',    k:'recMin',           w:14, t:'num'  },
    { h:'Recommended Max',    k:'recMax',           w:14, t:'num'  },
    { h:'Analyst MRP',        k:'anMrp',            w:12, t:'text' },
    { h:'Analyst Min',        k:'anMin',            w:12, t:'text' },
    { h:'Analyst Max',        k:'anMax',            w:12, t:'text' },
    { h:'Analyst SS',         k:'anSS',             w:12, t:'text' },
    { h:'Where used (models)',k:'whereUsedModels',  w:28, t:'text' },
    { h:'Observed units',     k:'observedUnits',    w:13, t:'num'  },
    { h:'Est. unit population',k:'estPopulation',   w:17, t:'num'  },
    { h:'Basis %',            k:'basisPct',         w:9,  t:'pct'  }
  ];

  function cellVal(row, col){
    const v = row[col.k];
    if (v === '' || v == null) return null;
    return v;
  }

  async function buildWorkbook(rows, meta){
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Calibre Tune';
    const ws = wb.addWorksheet('MRP Request', { views:[{ state:'frozen', ySplit:4, xSplit:1 }] });

    ws.mergeCells(1, 1, 1, COLS.length);
    const title = ws.getCell(1, 1);
    title.value = `MRP Request Template — ${meta.assessmentName || '(unnamed assessment)'}`;
    title.font = { bold:true, size:14, color:{ argb:'FF12303F' } };

    ws.mergeCells(2, 1, 2, COLS.length);
    const sub = ws.getCell(2, 1);
    sub.value = `Analyst-reviewed (★ For Action) materials · ${rows.length} material${rows.length===1?'':'s'} · Run ${meta.runDate || ''}` +
                (meta.hasMfr ? '' : '  ·  ⚠ Fleet Master has no Manufacturer column — population matched on base-model only');
    sub.font = { italic:true, size:10, color:{ argb:'FF5C7A89' } };

    ws.mergeCells(3, 1, 3, COLS.length);
    const cav = ws.getCell(3, 1);
    cav.value = 'Est. unit population is an ESTIMATE — every fleet unit whose (Manufacturer, base-model) matches a unit this part was observed on. Verify current MRP/Min/Max/SS against SAP before actioning.';
    cav.font = { size:9, color:{ argb:'FF8AA3B0' } };
    cav.alignment = { wrapText:true };
    ws.getRow(3).height = 26;

    const headRow = ws.getRow(4);
    COLS.forEach((c, i) => {
      const cell = headRow.getCell(i + 1);
      cell.value = c.h;
      cell.font = { bold:true, size:10, color:{ argb:'FFFFFFFF' } };
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0E8F9B' } };
      cell.alignment = { vertical:'middle', horizontal:(c.t === 'text' ? 'left' : 'center'), wrapText:true };
      ws.getColumn(i + 1).width = c.w;
    });
    headRow.height = 30;

    rows.forEach((r, ri) => {
      const row = ws.getRow(5 + ri);
      COLS.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        const v = cellVal(r, c);
        cell.value = v;
        if (c.t === 'money' && v != null) cell.numFmt = '$#,##0.00';
        else if (c.t === 'num' && v != null) cell.numFmt = '#,##0';
        else if (c.t === 'pct' && v != null){ cell.value = v / 100; cell.numFmt = '0%'; }
        cell.alignment = { horizontal:(c.t === 'text' ? 'left' : 'center'), vertical:'top', wrapText:(c.k === 'description' || c.k === 'whereUsedModels') };
        cell.font = { size:10 };
        if (ri % 2 === 1) cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF2F6F8' } };
      });
    });

    return wb;
  }

  function triggerDownload(buf, filename){
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function slug(s){ return String(s || 'assessment').replace(/[^\w.-]+/g, '_').slice(0, 60); }

  /* Public entrypoint. materials = flagged material objects; analyst = handle;
     meta = { assessmentName, runDate }. Returns { count }. */
  async function download(json, materials, analyst, meta){
    meta = meta || {};
    const reg  = fleetRegister(json);
    const rows = templateRows(json, materials, analyst);
    const wb   = await buildWorkbook(rows, Object.assign({ hasMfr: reg.hasMfr }, meta));
    const buf  = await wb.xlsx.writeBuffer();
    triggerDownload(buf, `MRP Request Template - ${slug(meta.assessmentName)}.xlsx`);
    return { count: rows.length };
  }

  global.AppMrpRequest = Object.freeze({ canDownload, templateRows, download, fleetRegister });

})(window);
