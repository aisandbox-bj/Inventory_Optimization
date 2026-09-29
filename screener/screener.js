/* ═══════════════════════════════════════════════════════════════════════════
   Canvas page (was the Screener) — UI wiring · APP-SCR-01 (2026-06-25) →
   APP-CANVAS (2026-09-26)
   ───────────────────────────────────────────────────────────────────────────
   The PICKER for the Canvas review workspace. Reads the same canonical JSON as
   Trend + Trace, runs AppPipeline, and shows:
     · a screening-filter panel (AND-combined bands over the per-material result
       fields — category, range and risk-flag bands), always visible on the left;
     · a checklist table (Trend-style) whose columns the operator chooses and
       arranges in a SAP-style field picker; filters only change what the table
       SHOWS — ticks are kept;
     · ▶ Launch Canvas → the ticked materials open in the widescreen Canvas
       (ReportBuilder.openCanvas), one page per material, master layout.
   Clicking a row opens a Quick look (the Trend material detail + the Trace phase
   distribution) over the page.

   No SCHEMA_VERSION bump — consumes the existing pipeline result; bands persist
   in settings.screenerBands, the column set in settings.canvasColumns, ticks +
   sort in screener.viewState (NOT the canonical JSON). LLM is OFF here.

   Depends on: AppStorage, AppPipeline, AppChart, AppLocale, MaterialDetail,
   TracePhase, ReportBuilder.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const $  = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }

  // Band fields (operator-refinable). Set bands = category pickers; range bands
  // = numeric min/max over per-material result fields.
  const SET_FIELDS = [
    { k:'trafficLight', l:'Traffic light' },
    { k:'mrpType',      l:'MRP type' }
  ];
  const RANGE_FIELDS = [
    { k:'p2Rate',            l:'P2 rate / mo' },
    { k:'runway',            l:'Runway (mo)' },
    { k:'totalNet',          l:'Total (window)' },
    { k:'stock',             l:'Stock on hand' },
    { k:'daysSinceLastIssue',l:'Days since last issue' }
  ];

  // ── New bands (APP-SCR-01d, 2026-06-26) ───────────────────────────────────
  // PR-derived set bands — only meaningful when PR History is loaded.
  const PR_SET_FIELDS = [
    { k:'poStatus', l:'PO status' },
    { k:'prStatus', l:'PR status' }
  ];
  // Risk-flag bands. Each card flags an at-risk condition; checks within a card
  // combine with OR. need:'pr' cards depend on the procurement lead time, so
  // they only appear when PR History is loaded. Min comparisons use the CURRENT
  // SAP Min (operator decision 2026-06-26). Flags are computed per material in
  // computeRiskFields().
  const FLAG_CARDS = [
    { id:'sohBelow',   l:'SoH below',                 need:'soh', combine:'or', flags:[
        { k:'sohBelowP2',  l:'P2 (under 1 mo cover)' },
        { k:'sohBelowMin', l:'Min (current SAP)' }
    ]},
    { id:'minBelowLT', l:'Min below lead-time cover', need:'pr',  combine:'or', flags:[
        { k:'minBelowLT', l:'Min < P2 × avg lead-time (mo)' }
    ]},
    // APP-CANVAS-FILTER (2026-09-27) — the review work (★ from Trend, ✓ from the
    // Canvas). Values refresh on every draw (visibleRows), so a star or tick set
    // elsewhere shows straight away. The two cards AND, e.g. "★ and not reviewed".
    { id:'anActionCard', l:'For Action',    need:'analyst', grp:'review', combine:'or', flags:[
        { k:'anIsAction', l:'★ For Action only' }
    ]},
    { id:'anReviewCard', l:'Review status', need:'analyst', grp:'review', combine:'or', flags:[
        { k:'anIsReviewed',  l:'✓ Reviewed' },
        { k:'anNotReviewed', l:'Not reviewed yet' }
    ]}
  ];
  const FLAG_LABELS = {};
  FLAG_CARDS.forEach(c => c.flags.forEach(fl => { FLAG_LABELS[fl.k] = fl.l; }));

  /* ─── Table fields (APP-CANVAS field picker) ────────────────────────────────
     Every column the table can show. `g` groups them in the picker; `num` right-
     aligns + sorts numerically; `val(m)` is the sort value; `cell(m)` the HTML.
     Material is locked (always shown). Defaults = the Trend list + Below Min +
     Open PRs / Open POs (operator 2026-09-26). */
  const TL_ORDER = { RED:0, ORANGE:1, PURPLE:2, BLUE:3, GREEN:4, GREY:5 };
  const DASH = '<span class="muted">—</span>';
  const numCell = (v, d) => (v == null || v === '' || !Number.isFinite(+v)) ? DASH : (+v).toLocaleString('en-CA', { maximumFractionDigits: d == null ? 1 : d });
  const ynCell = (v) => v === 'Y' ? '<span class="yn y">Yes</span>' : v === 'N' ? '<span class="yn n">No</span>' : DASH;   // 'NA' = can't evaluate → —
  const ynVal = (v) => v === 'Y' ? 2 : v === 'N' ? 1 : 0;
  const rateCell = (r, f) => f === 'OK' ? r.toFixed(1) : `<span class="amber">${escapeHtml(f || '—')}</span>`;
  const cad = (v) => (v == null || v === '') ? DASH : ((typeof AppLocale !== 'undefined' && AppLocale.fmtCAD) ? escapeHtml(AppLocale.fmtCAD(v)) : numCell(v, 2));
  const FIELDS = [
    // Identity
    { k:'trafficLight', l:'TL', g:'Result', val:m => TL_ORDER[m.trafficLight] ?? 9,
      cell:m => `<span class="tl-dot ${escapeAttr(m.trafficLight)}"></span><span class="tl-lab">${escapeHtml(m.trafficLight || '')}</span>` },
    { k:'material', l:'Material', g:'Identity', lock:true, left:true, val:m => m.material,
      cell:m => {
        const a = state.analyst;
        const act = a && a.isAction(m.material), note = a && a.hasNote(m.material), rev = a && a.isReviewed && a.isReviewed(m.material);
        return `<span class="mono">${escapeHtml(m.material)}</span>${act ? '<span class="scr-row-action" title="Flagged For Action">★</span>' : ''}${note ? '<span class="scr-row-note" title="Has a note">✎</span>' : ''}${rev ? '<span class="scr-row-rev" title="Reviewed in the Canvas">✓</span>' : ''}`;
      } },
    { k:'description', l:'Description', g:'Identity', left:true, wide:true, val:m => m.description || '',
      cell:m => `<span class="desc" title="${escapeAttr(m.description || '')}">${escapeHtml(m.description || '')}</span>` },
    { k:'manufacturer',  l:'Manufacturer',   g:'Identity', left:true, val:m => m.manufacturer || '', cell:m => escapeHtml(m.manufacturer || '') || DASH },
    { k:'materialGroup', l:'Material group', g:'Identity', val:m => m.materialGroup || '', cell:m => escapeHtml(m.materialGroup || '') || DASH },
    // Consumption
    { k:'totalNet',   l:'Qty Iss.',   g:'Consumption', num:true, val:m => m.totalNet, cell:m => numCell(m.totalNet) },
    { k:'p1Rate',     l:'P1/mo',      g:'Consumption', num:true, val:m => m.p1Flag === 'OK' ? m.p1Rate : null, cell:m => rateCell(m.p1Rate, m.p1Flag) },
    { k:'p2Rate',     l:'P2/mo',      g:'Consumption', num:true, val:m => m.p2Flag === 'OK' ? m.p2Rate : null, cell:m => rateCell(m.p2Rate, m.p2Flag) },
    { k:'rateChange', l:'P1→P2 %',    g:'Consumption', num:true, val:m => m.rateChange, cell:m => m.rateChange != null ? escapeHtml(m.rateChange + '%') : DASH },
    { k:'pattern',    l:'Pattern',    g:'Consumption', val:m => m.pattern || '', cell:m => `<span class="${m.pattern === 'LUMPY' ? 'amber' : 'muted'}">${escapeHtml(m.pattern || '—')}</span>` },
    { k:'lastConsumptionDate', l:'Last cons.', g:'Consumption', val:m => m.lastConsumptionDate || '', cell:m => escapeHtml(m.lastConsumptionDate || '') || DASH },
    { k:'daysSinceLastIssue',  l:'Days since issue', g:'Consumption', num:true, val:m => m.daysSinceLastIssue, cell:m => numCell(m.daysSinceLastIssue, 0) },
    // Stock & MRP
    { k:'stock',          l:'SoH',          g:'Stock & MRP', num:true, val:m => m.stock, cell:m => numCell(m.stock) },
    { k:'totValueOh',     l:'Stock value',  g:'Stock & MRP', num:true, val:m => m.totValueOh, cell:m => cad(m.totValueOh) },
    { k:'movingAvgPrice', l:'Unit cost',    g:'Stock & MRP', num:true, val:m => m.movingAvgPrice, cell:m => cad(m.movingAvgPrice) },
    { k:'runway',         l:'Runway (mo)',  g:'Stock & MRP', num:true, val:m => m.runway, cell:m => numCell(m.runway) },
    { k:'mrpType',        l:'MRP',          g:'Stock & MRP', val:m => m.mrpType || '', cell:m => `<span class="muted">${escapeHtml(m.mrpType || '—')}</span>` },
    { k:'cmin',           l:'Min (SAP)',    g:'Stock & MRP', num:true, val:m => m.cmin, cell:m => numCell(m.cmin) },
    { k:'cmax',           l:'Max (SAP)',    g:'Stock & MRP', num:true, val:m => m.cmax, cell:m => numCell(m.cmax) },
    { k:'safetyStock',    l:'Safety stock', g:'Stock & MRP', num:true, val:m => m.safetyStock, cell:m => numCell(m.safetyStock) },
    { k:'recMrpType',     l:'Rec MRP',      g:'Stock & MRP', val:m => m.recMrpType || '', cell:m => escapeHtml(m.recMrpType || '') || DASH },
    { k:'recMin', l:'Rec Min', g:'Stock & MRP', num:true, val:m => m.recMin,
      cell:m => `${m.recMin ?? '—'}${m.cmin != null ? ` <span class="cur-brk" title="Current SAP Min">(${escapeHtml(String(m.cmin))})</span>` : ''}` },
    { k:'recMax', l:'Rec Max', g:'Stock & MRP', num:true, val:m => m.recMax,
      cell:m => `${m.recMax ?? '—'}${m.cmax != null ? ` <span class="cur-brk" title="Current SAP Max">(${escapeHtml(String(m.cmax))})</span>` : ''}` },
    { k:'mrpRecFlag',       l:'Reclass',    g:'Stock & MRP', val:m => m.mrpRecFlag || '', cell:m => m.mrpRecFlag ? `<span class="scr-row-reclass">${escapeHtml(m.mrpRecFlag)}</span>` : DASH },
    { k:'totalReservation', l:'Open resv.', g:'Stock & MRP', num:true, val:m => m.totalReservation, cell:m => numCell(m.totalReservation) },
    // Procurement (need PR History)
    { k:'leadDays', l:'Lead (d)', g:'Procurement', pr:true, num:true, val:m => m.leadDays,
      cell:m => m.leadDays != null ? `<span class="lead-fig ${MaterialDetail.leadBandClass(m.leadDays)}">${m.leadDays.toFixed(1)}</span>` : DASH },
    { k:'prOpenN',          l:'Open PRs',           g:'Procurement', pr:true, num:true, val:m => m.prOpenN, cell:m => m.prOpenN == null ? DASH : (m.prOpenN ? `<b class="amber">${m.prOpenN}</b>` : '<span class="muted">0</span>') },
    { k:'oldestOpenPrDays', l:'Oldest open PR (d)', g:'Procurement', pr:true, num:true, val:m => m.oldestOpenPrDays, cell:m => numCell(m.oldestOpenPrDays, 0) },
    { k:'poOpenN',          l:'Open POs',           g:'Procurement', pr:true, num:true, val:m => m.poOpenN, cell:m => m.poOpenN == null ? DASH : (m.poOpenN ? `<b>${m.poOpenN}</b>` : '<span class="muted">0</span>') },
    // Risk flags
    { k:'sohBelowMin', l:'Below Min',     g:'Risk flags', val:m => ynVal(m.sohBelowMin), cell:m => ynCell(m.sohBelowMin) },
    { k:'sohBelowP2',  l:'SoH < 1 mo',    g:'Risk flags', val:m => ynVal(m.sohBelowP2),  cell:m => ynCell(m.sohBelowP2) },
    { k:'minBelowLT',  l:'Min < LT cover', g:'Risk flags', pr:true, val:m => ynVal(m.minBelowLT), cell:m => ynCell(m.minBelowLT) },
    // Analyst (from the Trend sidecar — read-only here)
    { k:'anAction', l:'★ Action', g:'Analyst', val:m => (state.analyst && state.analyst.isAction(m.material)) ? 1 : 0,
      cell:m => (state.analyst && state.analyst.isAction(m.material)) ? '<span class="scr-row-action">★</span>' : '' },
    { k:'anReviewed', l:'✓ Reviewed', g:'Analyst', val:m => (state.analyst && state.analyst.reviewedOn) ? state.analyst.reviewedOn(m.material) : '',
      cell:m => { const d = (state.analyst && state.analyst.reviewedOn) ? state.analyst.reviewedOn(m.material) : ''; return d ? `<span class="scr-row-rev">✓</span> <span class="muted">${escapeHtml(d.slice(0, 10))}</span>` : DASH; } },
    { k:'anMinMax', l:'Analyst Min / Max', g:'Analyst', val:m => { const r = state.analyst ? state.analyst.getRec(m.material) : {}; return (r && (r.min || r.max)) ? String(r.min || '') + '/' + String(r.max || '') : ''; },
      cell:m => { const r = state.analyst ? state.analyst.getRec(m.material) : {}; return (r && (r.min || r.max)) ? `<span class="an-rec">${escapeHtml(r.min || '—')} / ${escapeHtml(r.max || '—')}</span>` : DASH; } }
  ];
  const FIELD = Object.fromEntries(FIELDS.map(f => [f.k, f]));
  const DEFAULT_COLS = ['trafficLight','material','description','totalNet','p1Rate','p2Rate','mrpType','recMin','recMax','leadDays','mrpRecFlag','pattern','sohBelowMin','prOpenN','poOpenN'];

  const state = {
    json:             null,
    result:           null,
    materials:        [],     // [{ m, bucket }] — deduped across buckets
    bands:            {},      // colKey → {type:'set',values:[]} | {type:'range',min,max}
    selectedMaterial: null,    // the material open in the Quick look
    search:           '',
    hasPr:            false,
    exportFlags:      new Set(), // the ticked materials — the Canvas set (also Quick PDF / Letter report)
    columns:          DEFAULT_COLS.slice(),
    sortKey:          'totalNet',
    sortDir:          'desc',
    // APP-FIX-SCR-EXCL — Trace's per-material manual excludes + sigma setting,
    // loaded from trace.viewState so the Screener's avg lead time + embedded
    // Trace phase-distribution honour the SAME exclusions the operator set on
    // the Trace page (otherwise the average chain length wouldn't reconcile).
    traceExcl:        { manualByMat: {}, sigmaLimit: null }
  };

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */
  async function boot(){
    const json = await AppStorage.get('intake.current');
    if (!json) { renderEmpty(); return; }
    state.json  = json;
    state.hasPr = !!(json.data && json.data.prHistory && json.data.prHistory.length);
    // R2-7 (2026-08-16) — bind the analyst sidecar (For-Action flags + Analyst Rec)
    // so the list, detail and PDF export can show the analyst's work.
    state.analyst = (typeof AnalystMarks !== 'undefined')
      ? AnalystMarks.forJson(json)   // APP-ANALYST-IN-JSON — review work lives in the JSON, auto-saved
      : null;

    try {
      state.result = AppPipeline.runPipelineCached(json, { runDate: AppLocale.localDateISO() });
    } catch (e) {
      console.error(e);
      renderError(e);
      return;
    }

    // Flatten result materials across buckets, dedupe by material number.
    const seen = new Map();
    for (const b of state.result.buckets) {
      for (const m of b.materials) {
        if (!seen.has(m.material)) seen.set(m.material, { m, bucket: b });
      }
    }
    state.materials = [...seen.values()];

    // APP-FIX-SCR-EXCL — pull in Trace's exclusions BEFORE deriving risk fields,
    // so the avg lead time matches what the operator sees on the Trace page.
    try {
      const tvs = await AppStorage.get('trace.viewState');
      state.traceExcl.manualByMat = (tvs && tvs.manualExclByMat && typeof tvs.manualExclByMat === 'object') ? tvs.manualExclByMat : {};
      state.traceExcl.sigmaLimit  = (tvs && typeof tvs.sigmaLimit === 'number') ? tvs.sigmaLimit : null;
    } catch (e) { /* no Trace state saved → no exclusions */ }

    // Derive per-material risk fields used by the bands + table columns.
    computeRiskFields();

    // Load persisted bands + columns + view state.
    try { state.bands = (await AppStorage.get('settings.screenerBands')) || {}; } catch { state.bands = {}; }
    if (sanitizeBands()) persistBands();
    try {
      const cols = await AppStorage.get('settings.canvasColumns');
      if (Array.isArray(cols) && cols.length) state.columns = sanitizeColumns(cols);
    } catch { /* defaults */ }
    try {
      const vs = await AppStorage.get('screener.viewState');
      if (vs && Array.isArray(vs.exportFlags)) state.exportFlags = new Set(vs.exportFlags.filter(m => seen.has(m)));
      if (vs && vs.sortKey && FIELD[vs.sortKey]) { state.sortKey = vs.sortKey; state.sortDir = vs.sortDir === 'asc' ? 'asc' : 'desc'; }
    } catch { /* ignore */ }

    renderBanner();
    $('#scrToolbar').hidden = false;
    $('#scrMain').hidden = false;
    bindToolbar();
    bindTableOnce();
    buildBandsBody();
    renderTable();

    // APP-CANVAS-NAV — arriving to open the Canvas straight away:
    //   #canvas=<mat> + a handoff from Trend's "Canvas it!" (the Trend list), or
    //   #canvas=<mat> back from Trace's "← Back to Canvas" (reopens the saved canvas).
    const hc = /(?:^|&)canvas(?:=([^&]*))?/.exec((location.hash || '').replace(/^#/, ''));
    if (hc) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      let mat = null; try { mat = hc[1] ? decodeURIComponent(hc[1]) : null; } catch (e) { mat = hc[1] || null; }
      let handoff = null;
      try { handoff = JSON.parse(sessionStorage.getItem('calibre.canvasHandoff') || 'null'); sessionStorage.removeItem('calibre.canvasHandoff'); } catch (e) {}
      if (handoff && handoff.from === 'trend') { try { sessionStorage.setItem('calibre.canvasOrigin', 'trend'); } catch (e) {} }
      openCanvasFor(mat, handoff);
    }
  }

  function canvasOrigin(){ try { return sessionStorage.getItem('calibre.canvasOrigin'); } catch (e) { return null; } }
  function openCanvasFor(mat, handoff){
    if (typeof ReportBuilder === 'undefined' || !ReportBuilder.openCanvas) { toast('Canvas unavailable.', 'crit'); return; }
    const byMat = new Map(state.materials.map(e => [e.m.material, e]));
    if (mat && !byMat.has(mat)) { toast(`${mat} isn't in this analysis — nothing to open in the Canvas.`, 'crit'); mat = null; }
    const keys = (handoff && Array.isArray(handoff.list) && handoff.list.length) ? handoff.list : (mat ? [mat] : []);
    const list = keys.map(k => byMat.get(k)).filter(Boolean).map(e => ({ m: e.m, bucket: e.bucket }));
    ReportBuilder.openCanvas({
      json:           state.json,
      hasPr:          state.hasPr,
      analyst:        state.analyst,
      assessmentName: (state.json.metadata && state.json.metadata.assessmentName) || '',
      list,
      startMat:       mat,
      listLabel:      handoff ? 'the Trend list' : 'this material',
      backToTrend:    canvasOrigin() === 'trend',
      lookup:         (k) => { const e = byMat.get(k); return e ? { m: e.m, bucket: e.bucket } : null; },
      traceFiltersFor: (k) => traceFiltersFor(k),
      onClose:        () => { renderTable(); updateCommentsButton(); }
    });
  }

  function renderEmpty(){
    $('#root').innerHTML = `
      <section class="loaded-banner">
        <div>
          <span class="lab">No intake loaded</span>
          <h2>Build a canonical JSON first</h2>
          <div class="sub">Go to the Intake page, drop your SAP exports, save → return here.</div>
        </div>
        <div class="row" style="grid-column:span 2;align-items:flex-end;">
          <a href="../intake/intake.html"><button class="primary">Go to Intake →</button></a>
        </div>
      </section>`;
  }

  function renderError(e){
    $('#root').innerHTML = `
      <section class="loaded-banner">
        <div>
          <span class="lab">Pipeline error</span>
          <h2>Could not run the analysis</h2>
          <div class="sub">${escapeHtml(e.message || String(e))}</div>
        </div>
      </section>`;
  }

  function countRows(j){
    const out = {};
    for (const k of Object.keys(j.data || {})) out[k] = (j.data[k] || []).length;
    return out;
  }

  function renderBanner(){
    const j = state.json;
    const counts = countRows(j);
    const sum = state.result.summary;
    $('#banner').innerHTML = `
      <div>
        <span class="lab">Canvas · reviewing</span>
        <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
        <div class="sub">${state.materials.length.toLocaleString()} materials in analysis · ${state.result.buckets.length} bucket${state.result.buckets.length === 1 ? '' : 's'}${state.hasPr ? '' : ' · no PR History (Trace tiles unavailable)'}</div>
      </div>
      <div class="row">
        <span class="lab">Traffic lights</span>
        <span class="v">${sum.GREEN||0} G · ${sum.BLUE||0} B · ${sum.ORANGE||0} O</span>
        <span class="v">${sum.RED||0} R · ${sum.PURPLE||0} P · ${sum.GREY||0} —</span>
      </div>
      <div class="row">
        <span class="lab">Source data</span>
        <span class="v">${(counts.mb51||0).toLocaleString()} MB51 · ${(counts.prHistory||0).toLocaleString()} PR</span>
        <span class="v">${(counts.inventoryMaster||0).toLocaleString()} master</span>
      </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     TOOLBAR
  ═════════════════════════════════════════════════════════════════════════ */
  function bindToolbar(){
    ListSearch.attach($('#scrSearch'), { universe: () => state.materials.map(e => e.m.material) });   // APP-LIST-SEARCH
    $('#scrSearch').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
    $('#btnClearBands').addEventListener('click', async () => {
      state.bands = {};
      await persistBands();
      buildBandsBody();
      renderTable();
    });
    $('#btnSelShown').addEventListener('click', () => { visibleRows().forEach(e => state.exportFlags.add(e.m.material)); afterSelectionChange(); });
    $('#btnUnselShown').addEventListener('click', () => { visibleRows().forEach(e => state.exportFlags.delete(e.m.material)); afterSelectionChange(); });
    $('#btnSelClear').addEventListener('click', () => { state.exportFlags.clear(); afterSelectionChange(); });
    $('#btnColumns').addEventListener('click', openColumnPicker);
    $('#btnLaunch').addEventListener('click', launchCanvas);
    $('#btnExport').addEventListener('click', buildExportPdf);
    const rb = $('#btnBuildReport');
    if (rb) rb.addEventListener('click', openReportBuilder);
    const cb = $('#btnComments');
    if (cb) cb.addEventListener('click', openCommentsMenu);
    const ci = $('#commentsImport');
    if (ci) ci.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f || typeof CommentStore === 'undefined') return;
      CommentStore.importFile(f, (res) => {
        if (res.ok) toast(`Comments restored — ${res.added} added, ${res.updated} updated.`, 'ok');
        else toast('Import failed: ' + (res.reason || 'unknown'), 'crit');
        updateCommentsButton();
      });
      e.target.value = '';   // allow re-importing the same file
    });
    // Refresh the count when a comment is written from anywhere (e.g. the Canvas).
    document.addEventListener('calibre:comments-changed', updateCommentsButton);
    updateCommentsButton();
    // Filter panel — live: a change applies at once (number boxes after a short pause).
    const body = $('#bandsBody');
    let t = null;
    body.addEventListener('change', () => { if (t) { clearTimeout(t); t = null; } applyBands(); });
    // APP-CANVAS-REVIEWED — clear every ✓ in this run (e.g. starting next month's
    // review from a run re-saved from this one). Two clicks; stars and notes stay.
    body.addEventListener('click', (e) => {
      const b = e.target.closest('#btnClearReviewed'); if (!b || !state.analyst || !state.analyst.clearReviewed) return;
      const n = state.analyst.reviewedMaterials().length; if (!n) return;
      if (!b.classList.contains('armed')) {
        b.classList.add('armed'); b.textContent = `Clear ${n} tick${n === 1 ? '' : 's'} — sure?`;
        setTimeout(() => { b.classList.remove('armed'); updateClearReviewedBtn(); }, 3500);
        return;
      }
      b.classList.remove('armed');
      const k = state.analyst.clearReviewed();
      toast(`Cleared ${k} ✓ Reviewed tick${k === 1 ? '' : 's'} — stars and notes are unchanged.`);
      renderTable();
    });
    body.addEventListener('input', (e) => {
      if (e.target.type !== 'number') return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; applyBands(); }, 450);
    });
  }

  // APP-COMMENT-DURABLE — comments are kept per material in this browser (survive
  // deleting the JSON). This backup menu exports/imports them as a small file so
  // they also survive a browser-data clear or a move to another machine.
  function updateCommentsButton(){
    const btn = $('#btnComments'); if (!btn || typeof CommentStore === 'undefined') return;
    const n = CommentStore.count();
    btn.textContent = n ? `💬 Comments (${n})` : '💬 Comments';
  }
  function openCommentsMenu(e){
    document.querySelector('.scr-cmt-menu')?.remove();
    if (typeof CommentStore === 'undefined'){ toast('Comment store unavailable.', 'crit'); return; }
    const n = CommentStore.count();
    const menu = document.createElement('div');
    menu.className = 'scr-cmt-menu';
    menu.innerHTML =
      `<div class="scr-cmt-count">${n} material${n===1?'':'s'} with a saved comment</div>` +
      `<button class="scr-cmt-item" data-act="export"${n?'':' disabled'}>⤓ Export backup file…</button>` +
      `<button class="scr-cmt-item" data-act="import">⤒ Import from file…</button>`;
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    document.body.appendChild(menu);
    const close = () => { menu.remove(); document.removeEventListener('click', off, true); };
    const off = (ev) => { if (!menu.contains(ev.target) && ev.target !== e.currentTarget) close(); };
    setTimeout(() => document.addEventListener('click', off, true), 0);
    menu.querySelector('[data-act="export"]').addEventListener('click', () => {
      const c = CommentStore.download();
      if (c >= 0) toast(`Exported ${c} comment${c===1?'':'s'} to calibre-comments.json.`, 'ok');
      else toast('Export failed.', 'crit');
      close();
    });
    menu.querySelector('[data-act="import"]').addEventListener('click', () => { $('#commentsImport').click(); close(); });
  }

  // The ticked materials in the table's current sort order (ALL ticks — including
  // ticks the filters currently hide; the filters are only a view).
  function selectedInOrder(){
    return sortRows(state.materials.slice()).filter(e => state.exportFlags.has(e.m.material));
  }

  // APP-SCR-REPORT — the Letter report keys off the ticked set (configure once →
  // generate all), not one selected material.
  function openReportBuilder(){
    const flagged = selectedInOrder();
    if (!flagged.length) { toast('Tick at least one material in the table first.', 'crit'); return; }
    if (typeof ReportBuilder === 'undefined') { toast('Report builder unavailable.', 'crit'); return; }
    const ref = flagged[0];   // reference material for arranging/previewing the layout
    ReportBuilder.open({
      json:           state.json,
      m:              ref.m,
      bucket:         ref.bucket,
      hasPr:          state.hasPr,
      analyst:        state.analyst,
      traceFilters:   traceFiltersFor(ref.m.material),
      assessmentName: (state.json.metadata && state.json.metadata.assessmentName) || '',
      batch: {
        list:          flagged.map(e => ({ m: e.m, bucket: e.bucket })),
        traceFiltersFor: (mat) => traceFiltersFor(mat)
      }
    });
  }

  // APP-CANVAS — a canvas in progress (saved by ReportBuilder.openCanvas) can be
  // continued even with nothing ticked.
  function canvasInProgress(){
    try {
      const name = (state.json.metadata && state.json.metadata.assessmentName) || '';
      const o = JSON.parse(localStorage.getItem('calibre.canvasSession.v1.' + name) || 'null');
      return !!(o && Array.isArray(o.order) && o.order.length);
    } catch (e) { return false; }
  }
  function launchCanvas(){
    if (typeof ReportBuilder === 'undefined' || !ReportBuilder.openCanvas) { toast('Canvas unavailable.', 'crit'); return; }
    const sel = selectedInOrder();
    if (!sel.length && !canvasInProgress()) { toast('Tick at least one material in the table first.', 'crit'); return; }
    try { sessionStorage.removeItem('calibre.canvasOrigin'); } catch (e) {}   // launched here, not from Trend
    ReportBuilder.openCanvas({
      json:           state.json,
      hasPr:          state.hasPr,
      analyst:        state.analyst,
      assessmentName: (state.json.metadata && state.json.metadata.assessmentName) || '',
      list:           sel.map(e => ({ m: e.m, bucket: e.bucket })),
      lookup:         (mat) => { const e = state.materials.find(x => x.m.material === mat); return e ? { m: e.m, bucket: e.bucket } : null; },
      traceFiltersFor: (mat) => traceFiltersFor(mat),
      onClose:        () => { renderTable(); updateCommentsButton(); }
    });
  }

  function updateSelectionUi(){
    const n = state.exportFlags.size;
    const shownSel = visibleRows().filter(e => state.exportFlags.has(e.m.material)).length;
    $('#scrSelCount').innerHTML = `<b>${n.toLocaleString()}</b> selected${n > shownSel ? ` <span class="muted">(${(n - shownSel).toLocaleString()} hidden by filters)</span>` : ''}`;
    const exp = $('#btnExport');
    exp.textContent = `⤓ Quick PDF (${n})`; exp.disabled = n === 0;
    const rb = $('#btnBuildReport');
    rb.textContent = `⤓ Letter report (${n})`; rb.disabled = n === 0;
    const la = $('#btnLaunch');
    const cont = !n && canvasInProgress();
    la.textContent = cont ? '▶ Continue Canvas' : `▶ Launch Canvas (${n})`;
    la.disabled = !n && !cont;
  }
  // kept for the export code below (it calls this after a run)
  function updateExportButton(){ updateSelectionUi(); }

  function afterSelectionChange(){
    persistView();
    renderTable();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PER-MATERIAL RISK FIELDS + band helpers (APP-SCR-01d)
  ═════════════════════════════════════════════════════════════════════════ */
  function numify(v){ if (v == null || v === '') return null; const n = (typeof v === 'number') ? v : parseFloat(v); return Number.isFinite(n) ? n : null; }

  function activeSetFields(){ return state.hasPr ? SET_FIELDS.concat(PR_SET_FIELDS) : SET_FIELDS.slice(); }
  function activeFlagCards(){ return FLAG_CARDS.filter(c => c.need === 'analyst' ? !!state.analyst : (c.need !== 'pr' || state.hasPr)); }
  // Refresh the review-work flags the filter cards read ('Y' / 'N').
  function refreshAnalystFlags(){
    const a = state.analyst; if (!a) return;
    for (const e of state.materials){
      const m = e.m, rev = !!(a.isReviewed && a.isReviewed(m.material));
      m.anIsAction = a.isAction(m.material) ? 'Y' : 'N';
      m.anIsReviewed = rev ? 'Y' : 'N';
      m.anNotReviewed = rev ? 'N' : 'Y';
    }
  }

  // APP-FIX-SCR-EXCL — the same filter object Trace uses, for one material, so
  // completed-chain stats here match the Trace page. Year is always 'All' (the
  // Canvas is all-time by design); manual + sigma exclusions are honoured.
  function traceFiltersFor(material){
    return {
      yearFilter: 'All',
      sigmaLimit: state.traceExcl.sigmaLimit,
      manualExcl: new Set(state.traceExcl.manualByMat[material] || [])
    };
  }

  // Drop persisted bands whose field no longer exists / isn't available (bands
  // removed this version, or PR-only bands when no PR History is loaded) so a
  // stale invisible filter can't silently hide materials.
  function sanitizeBands(){
    const valid = new Set([
      ...activeSetFields().map(f => f.k),
      ...RANGE_FIELDS.map(f => f.k),
      ...activeFlagCards().map(c => c.id)
    ]);
    let changed = false;
    for (const k of Object.keys(state.bands)) if (!valid.has(k)) { delete state.bands[k]; changed = true; }
    return changed;
  }

  // Keep only known fields, no duplicates, Material always present.
  function sanitizeColumns(cols){
    const out = [];
    for (const k of cols) if (FIELD[k] && !out.includes(k)) out.push(k);
    if (!out.includes('material')) out.splice(Math.min(1, out.length), 0, 'material');
    return out;
  }

  // Derive the fields the bands + columns use. SoH-vs-P2/Min need no PR data;
  // PO/PR open status + counts, avg procurement lead time, and Min-vs-lead-time
  // cover use the PR→PO→GR chains (TracePhase.computeChains), so chain work runs
  // only for materials that actually have PR History rows. 'NA' / null = can't
  // evaluate (missing inputs) — never silently treated as "not at risk".
  function computeRiskFields(){
    const prMatHas = new Set();
    if (state.hasPr) {
      for (const r of (state.json.data && state.json.data.prHistory) || []) {
        const k = String(r.material == null ? '' : r.material).trim();
        if (k) prMatHas.add(k);
      }
    }
    const todayMs = Date.parse(AppLocale.localDateISO() + 'T00:00:00Z');
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    let chainCalls = 0;
    for (const e of state.materials) {
      const m = e.m;
      const stock = numify(m.stock);
      const cmin  = numify(m.cmin);
      const p2    = (m.p2Flag === 'OK') ? numify(m.p2Rate) : null;

      // SoH below thresholds (no PR data needed).
      m.sohBelowP2  = (stock != null && p2   != null) ? (stock < p2   ? 'Y' : 'N') : 'NA';
      m.sohBelowMin = (stock != null && cmin != null) ? (stock < cmin ? 'Y' : 'N') : 'NA';

      // Chain-derived fields.
      let avgLT = null, poOpenN = null, prOpenN = null, oldestPr = null, lastChains = null;
      if (state.hasPr) { poOpenN = 0; prOpenN = 0; }
      if (state.hasPr && prMatHas.has(m.material)) {
        chainCalls++;
        const chains   = TracePhase.computeChains(state.json, m.material);
        // Apply Trace's manual + sigma exclusions before averaging, so the avg
        // lead time reconciles with the Trace view (APP-FIX-SCR-EXCL).
        const act      = TracePhase.activeChains(chains, traceFiltersFor(m.material));
        lastChains = { chains, act };
        const complete = act.filter(c => !!c.siteWH);
        if (complete.length) {
          // #22-tie (2026-08-16) — shared sum-of-phase-means helper so this matches
          // the Trend figure and the Trace headline.
          avgLT = TracePhase.totalToSiteMean(complete);  // days to site (post-suppression)
        }
        for (const c of chains) {
          if (c.state === 'IN_FLIGHT' && !c.adminCancelled) poOpenN++;   // PO placed, not yet received at site
          if (c.state === 'PR_ONLY') {                                    // PR raised, no PO yet
            prOpenN++;
            const d = Date.parse(String(c.prDate || '') + 'T00:00:00Z');
            if (Number.isFinite(d) && Number.isFinite(todayMs)) {
              const age = Math.max(0, Math.round((todayMs - d) / 86400000));
              if (oldestPr == null || age > oldestPr) oldestPr = age;
            }
          }
        }
      }
      m.avgProcTimelineDays = avgLT;
      // APP-FIX-SCR-LEADCELL (2026-09-25) — the shared detail panel's "Lead time" stat
      // reads m.leadDays; same calc + 1-dp rounding as Trend.
      m.leadDays = (avgLT != null) ? Math.round(avgLT * 10) / 10 : null;
      // APP-LT-GAP — when there's PR History but no lead time, carry the reason
      m.leadGap = (avgLT == null && lastChains && TracePhase.leadTimeGap) ? TracePhase.leadTimeGap(state.json, m.material, lastChains.chains, lastChains.act) : null;
      m.poOpenN = poOpenN;
      m.prOpenN = prOpenN;
      m.oldestOpenPrDays = oldestPr;
      m.poStatus = state.hasPr ? (poOpenN ? 'Open' : 'None') : null;
      m.prStatus = state.hasPr ? (prOpenN ? 'Open' : 'None') : null;

      // Min below lead-time cover: current SAP Min < P2/mo × (avg lead-time in mo).
      if (cmin != null && p2 != null && avgLT != null) {
        m.ltCoverUnits = p2 * (avgLT / 30);              // expected demand over avg lead time
        m.minBelowLT   = cmin < m.ltCoverUnits ? 'Y' : 'N';
      } else {
        m.ltCoverUnits = null;
        m.minBelowLT   = 'NA';
      }
    }
    if (t0 && typeof console !== 'undefined') {
      console.log(`[canvas] risk fields: ${state.materials.length} materials · ${chainCalls} chain computes · ${(performance.now() - t0).toFixed(0)}ms`);
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BAND PREDICATE + TABLE
  ═════════════════════════════════════════════════════════════════════════ */
  function passesBands(m, bands){
    for (const [k, f] of Object.entries(bands)) {
      if (!f) continue;
      const v = m[k];
      if (f.type === 'set') {
        if (Array.isArray(f.values) && f.values.length) {
          if (!f.values.includes(String(v == null ? '' : v))) return false;
        }
      } else if (f.type === 'range') {
        const n = (typeof v === 'number') ? v : parseFloat(v);
        if (isNaN(n)) {
          if (f.min != null || f.max != null) return false;
          continue;
        }
        if (f.min != null && n < f.min) return false;
        if (f.max != null && n > f.max) return false;
      } else if (f.type === 'flag') {
        // OR within a flag card: pass if ANY checked condition is true ('Y').
        const flags = Array.isArray(f.flags) ? f.flags : [];
        if (flags.length && !flags.some(fk => m[fk] === 'Y')) return false;
      }
    }
    return true;
  }

  function sortRows(rows){
    const f = FIELD[state.sortKey] || FIELD.totalNet;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const isNum = !!f.num || f.k === 'trafficLight' || f.k === 'anAction' || f.g === 'Risk flags';
    return rows.sort((a, b) => {
      let av = f.val(a.m), bv = f.val(b.m);
      const an = av == null || av === '', bn = bv == null || bv === '';
      if (an && bn) return String(a.m.material).localeCompare(String(b.m.material));
      if (an) return 1;            // blanks always sink to the bottom
      if (bn) return -1;
      if (isNum) return (av - bv) * dir || String(a.m.material).localeCompare(String(b.m.material));
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  // The rows the table shows: filters + search, in the current sort.
  function visibleRows(){
    refreshAnalystFlags();
    let rows = state.materials.filter(e => passesBands(e.m, state.bands));
    // APP-LIST-SEARCH — text, or a pasted list of up to 20 material numbers
    if (state.search) rows = rows.filter(e => ListSearch.test(state.search, e.m.material, e.m.description));
    return sortRows(rows);
  }
  // (name kept for the Quick-look Prev/Next below)
  function filteredMaterials(){ return visibleRows(); }

  function updateClearReviewedBtn(){
    const b = $('#btnClearReviewed'); if (!b || b.classList.contains('armed')) return;
    const n = (state.analyst && state.analyst.reviewedMaterials) ? state.analyst.reviewedMaterials().length : 0;
    b.textContent = n ? `Clear all ✓ ticks (${n})` : 'Clear all ✓ ticks';
    b.disabled = !n;
  }
  function renderTable(){
    updateClearReviewedBtn();
    const wrap = $('#scrTableWrap');
    const keepTop = wrap.scrollTop, keepLeft = wrap.scrollLeft;   // re-draws never jump the table
    const rows = visibleRows();
    const cols = state.columns.map(k => FIELD[k]).filter(Boolean);
    const allShownOn = rows.length > 0 && rows.every(e => state.exportFlags.has(e.m.material));
    const someShownOn = !allShownOn && rows.some(e => state.exportFlags.has(e.m.material));
    const head = `<th class="chk"><input type="checkbox" id="scrChkAll" ${allShownOn ? 'checked' : ''} title="Tick / untick every material shown"></th>` +
      cols.map(f => {
        const sorted = state.sortKey === f.k ? ` sorted ${state.sortDir}` : '';
        const na = f.pr && !state.hasPr ? ' title="Needs PR History"' : '';
        return `<th class="${f.left ? 'left' : ''}${sorted}" data-sort="${f.k}"${na}>${escapeHtml(f.l)}<span class="sort-ind">${state.sortKey === f.k ? (state.sortDir === 'asc' ? '▲' : '▼') : ''}</span></th>`;
      }).join('');
    const body = rows.map(e => {
      const m = e.m, on = state.exportFlags.has(m.material);
      const cls = [on ? 'on' : '', m.material === state.selectedMaterial ? 'open' : ''].filter(Boolean).join(' ');
      return `<tr class="${cls}" data-mat="${escapeAttr(m.material)}"><td class="chk"><input type="checkbox" data-flag="${escapeAttr(m.material)}" ${on ? 'checked' : ''} aria-label="Select ${escapeAttr(m.material)}"></td>` +
        cols.map(f => `<td class="${f.left ? 'left' : ''}${f.wide ? ' wide' : ''}">${f.cell(m)}</td>`).join('') + '</tr>';
    }).join('');
    wrap.innerHTML = rows.length
      ? `<table class="scr-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
      : `<div class="scr-list-empty">no materials match the current filters</div>`;
    wrap.scrollTop = keepTop; wrap.scrollLeft = keepLeft;
    const all = $('#scrChkAll'); if (all) all.indeterminate = someShownOn;
    $('#scrTableMeta').textContent = `${rows.length.toLocaleString()} of ${state.materials.length.toLocaleString()} materials shown · click a row for a quick look · click a heading to sort`;
    updateSelectionUi();
  }

  function bindTableOnce(){
    const wrap = $('#scrTableWrap');
    wrap.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = k; state.sortDir = (FIELD[k] && (FIELD[k].left || FIELD[k].k === 'mrpType' || FIELD[k].k === 'pattern')) ? 'asc' : 'desc'; }
        persistView(); renderTable();
        return;
      }
      if (e.target.matches('#scrChkAll')) {
        const rows = visibleRows();
        if (e.target.checked) rows.forEach(r => state.exportFlags.add(r.m.material));
        else rows.forEach(r => state.exportFlags.delete(r.m.material));
        afterSelectionChange();
        return;
      }
      const cb = e.target.closest('input[data-flag]');
      if (cb) {
        const mat = cb.dataset.flag;
        if (cb.checked) state.exportFlags.add(mat); else state.exportFlags.delete(mat);
        cb.closest('tr').classList.toggle('on', cb.checked);
        persistView();
        updateSelectionUi();
        const all = $('#scrChkAll');
        if (all) {
          const rows = visibleRows();
          const n = rows.filter(r => state.exportFlags.has(r.m.material)).length;
          all.checked = rows.length > 0 && n === rows.length; all.indeterminate = n > 0 && n < rows.length;
        }
        return;
      }
      if (e.target.closest('td.chk')) return;
      const tr = e.target.closest('tr[data-mat]');
      if (tr) openQuickLook(tr.dataset.mat);
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     QUICK LOOK — the combined detail (MaterialDetail + TracePhase), OVER the page
  ═════════════════════════════════════════════════════════════════════════ */
  function openQuickLook(mat){
    state.selectedMaterial = mat;
    let ql = $('#scrQuickLook');
    if (!ql) {
      ql = document.createElement('div');
      ql.id = 'scrQuickLook'; ql.className = 'scr-ql';
      ql.innerHTML = `
        <div class="scr-ql-back"></div>
        <div class="scr-ql-card" role="dialog" aria-label="Quick look">
          <div class="scr-ql-head">
            <span class="scr-ql-title"></span>
            <label class="scr-ql-sel"><input type="checkbox" id="scrQlSel"> Selected for the Canvas</label>
            <button class="ghost scr-ql-x" title="Close (Esc)">✕</button>
          </div>
          <div class="scr-ql-body" id="scrDetail"></div>
        </div>`;
      document.body.appendChild(ql);
      const close = () => closeQuickLook();
      ql.querySelector('.scr-ql-back').addEventListener('click', close);
      ql.querySelector('.scr-ql-x').addEventListener('click', close);
      ql.querySelector('#scrQlSel').addEventListener('change', (e) => {
        if (e.target.checked) state.exportFlags.add(state.selectedMaterial); else state.exportFlags.delete(state.selectedMaterial);
        persistView(); renderTable();
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#scrQuickLook')) closeQuickLook(); });
    }
    renderDetail();
    renderTable();
  }
  function closeQuickLook(){
    const ql = $('#scrQuickLook'); if (ql) ql.remove();
    state.selectedMaterial = null;
    renderTable();
  }

  function renderDetail(){
    const host = $('#scrDetail');
    if (!host) return;
    const entry = state.materials.find(e => e.m.material === state.selectedMaterial);
    if (!entry) { closeQuickLook(); return; }
    const t = $('#scrQuickLook .scr-ql-title');
    if (t) t.innerHTML = `Quick look · <b class="mono">${escapeHtml(entry.m.material)}</b> <span class="muted">${escapeHtml(entry.m.description || '')}</span>`;
    const sel = $('#scrQlSel'); if (sel) sel.checked = state.exportFlags.has(entry.m.material);
    // R2-7 — For-Action ★ on the graph (detail cell): read-only badge from the sidecar.
    const detIsAction = !!(state.analyst && state.analyst.isAction(entry.m.material));
    const detActionBadge = detIsAction ? ` <span class="scr-cell-action" title="Flagged For Action on Trend">★ For Action</span>` : '';
    host.innerHTML = `
      <div class="scr-detail-grid">
        <div class="scr-detail-cell">
          <div class="scr-cell-lab">Consumption detail${detActionBadge}</div>
          <div id="scrCellDetail"></div>
        </div>
        <div class="scr-detail-cell">
          <div class="scr-cell-lab">Procurement phase distribution</div>
          <div id="scrCellTrace"></div>
        </div>
      </div>`;

    // Trend material-detail visual (LLM off here). Wide aspect (Trend parity).
    MaterialDetail.render($('#scrCellDetail'), entry.m, {
      bucket:      entry.bucket,
      parameters:  state.json.parameters,
      enableLlm:   false,
      chartWidth:  936,
      chartHeight: 320,
      // APP-SCR-ALIGN (2026-08-17) — same Analyst column + Notes as Trend, but
      // read-only here; notes open in a read-only card. Prev/Next step through
      // the rows the table shows, in its order.
      analyst: state.analyst ? {
        enabled:  true,
        readOnly: true,
        flagged:  state.analyst.isAction(entry.m.material),
        values:   state.analyst.getRec(entry.m.material)
      } : null,
      notes: state.analyst ? {
        enabled:  true,
        hasNote:  state.analyst.hasNote(entry.m.material),
        onToggle: () => showRoNoteCard(entry.m.material)
      } : null,
      nav: (() => {
        const list = filteredMaterials();
        const i = list.findIndex(e => e.m.material === entry.m.material);
        return { hasPrev: i > 0, hasNext: i > -1 && i < list.length - 1, onPrev: () => scrStep(-1), onNext: () => scrStep(1) };
      })(),
      // APP-OPI-01 — open-procurement lamps (PR/PO/In-Transit) from the chains.
      openProc: (typeof TracePhase !== 'undefined') ? TracePhase.openProcurement(state.json, entry.m.material) : null,
      // APP-WU-01 — "Where used" button (lazy compute on click). Only when IW39 is loaded.
      whereUsedFn: (typeof WhereUsed !== 'undefined' && state.json.data && state.json.data.iw39 && state.json.data.iw39.length) ? () => WhereUsed.compute(state.json, entry.m.material) : null,
      // APP-WU-02 — per-cell drill into the underlying work orders.
      whereUsedDrillFn: (typeof WhereUsed !== 'undefined') ? (sel) => WhereUsed.drill(state.json, entry.m.material, sel) : null,
      // APP-TREND-HOV — per-event movement detail for the chart hover tooltips.
      chartMovementsFn: (typeof MovementDetail !== 'undefined') ? () => MovementDetail.forMaterial(state.json, entry.m.material) : null,
      // APP-FIX-SNAPSHOT-ALIGN — chart caption when the stock snapshot ≠ MB51 cut-off.
      snapshotAlign: state.result && state.result.snapshotAlign
    });

    // Trace per-material visual — graceful degradation when PR History absent.
    const tcell = $('#scrCellTrace');
    if (state.hasPr) {
      TracePhase.render(tcell, state.json, entry.m.material, { filters: traceFiltersFor(entry.m.material) });
    } else {
      tcell.innerHTML = `
        <div class="scr-trace-missing">
          <b>Trace needs PR History.</b> This assessment has no PR History data,
          so the procurement phase distribution can't be drawn. Re-open the
          assessment in Intake, add the PR History export, save, and return here.
        </div>`;
    }
  }

  /* Quick-look Prev/Next through the rows the table shows. */
  function scrStep(dir){
    const list = filteredMaterials();
    const i = list.findIndex(e => e.m.material === state.selectedMaterial);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    state.selectedMaterial = list[j].m.material;
    const body = $('#scrQuickLook .scr-ql-body'); if (body) body.scrollTop = 0;
    renderDetail();
    renderTable();
  }

  /* APP-SCR-ALIGN — read-only notes viewer (edit on Trend or in the Canvas). */
  function showRoNoteCard(material){
    const existing = document.getElementById('scrNoteCard');
    if (existing) existing.remove();
    const note = state.analyst ? state.analyst.getNote(material) : '';
    const el = document.createElement('div');
    el.id = 'scrNoteCard';
    el.className = 'scr-note-card';
    el.innerHTML =
      `<div class="scr-note-head"><span>Note · ${escapeHtml(String(material))}</span>` +
      `<button type="button" class="scr-note-close" aria-label="Close">✕</button></div>` +
      `<div class="scr-note-body">${(note && note.trim())
        ? escapeHtml(note)
        : '<span class="scr-note-empty">No note for this material.</span>'}</div>` +
      `<div class="scr-note-foot">View only — add or edit notes on the Trend page or in the Canvas.</div>`;
    document.body.appendChild(el);
    const close = () => { el.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(ev){ if (ev.key === 'Escape') close(); }
    el.querySelector('.scr-note-close').addEventListener('click', close);
    document.addEventListener('keydown', onEsc);
    setTimeout(() => {
      document.addEventListener('click', function off(ev){
        if (!el.contains(ev.target)){ close(); document.removeEventListener('click', off); }
      });
    }, 0);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     COLUMN PICKER (SAP-style "change layout") — APP-CANVAS
     Two lists: the columns shown (in order) and the fields available. Drag an
     item between the lists or up/down to reorder; double-click moves it across;
     the arrow buttons do the same for the highlighted item.
  ═════════════════════════════════════════════════════════════════════════ */
  function openColumnPicker(){
    let shownCols = state.columns.slice();
    let hi = null;   // highlighted field key
    const ov = document.createElement('div');
    ov.className = 'scr-modal';
    ov.innerHTML = `
      <div class="scr-backdrop"></div>
      <div class="scr-dialog scr-colpick" role="dialog" aria-label="Choose columns">
        <div class="scr-modal-head">
          <div class="scr-modal-title"><span class="lab">Table layout</span><h3>Choose &amp; arrange columns</h3></div>
          <button class="ghost scr-close cp-x" title="Close">✕</button>
        </div>
        <div class="scr-modal-body">
          <div class="cp-intro">Drag fields between the lists, or drag up and down to change the order. Double-click moves a field across. <b>Material</b> is always shown.</div>
          <div class="cp-grid">
            <div class="cp-col">
              <div class="cp-lab">Shown columns <span class="cp-n cp-n-shown"></span></div>
              <ul class="cp-list cp-shown" data-list="shown"></ul>
            </div>
            <div class="cp-mid">
              <button class="ghost cp-btn" data-act="add" title="Show the highlighted field">◀ Show</button>
              <button class="ghost cp-btn" data-act="rem" title="Hide the highlighted column">Hide ▶</button>
              <button class="ghost cp-btn" data-act="up" title="Move the highlighted column up">▲ Up</button>
              <button class="ghost cp-btn" data-act="dn" title="Move the highlighted column down">▼ Down</button>
            </div>
            <div class="cp-col">
              <div class="cp-lab">Available fields <input type="text" class="cp-find" placeholder="find…" autocomplete="off"></div>
              <ul class="cp-list cp-avail" data-list="avail"></ul>
            </div>
          </div>
        </div>
        <div class="scr-modal-foot">
          <button class="ghost cp-default">Restore default</button>
          <span class="scr-spacer"></span>
          <button class="ghost cp-cancel">Cancel</button>
          <button class="primary cp-apply">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const ulShown = ov.querySelector('.cp-shown'), ulAvail = ov.querySelector('.cp-avail'), find = ov.querySelector('.cp-find');
    const itemHtml = (f, where) => {
      const na = f.pr && !state.hasPr;
      return `<li class="cp-item${f.lock ? ' lock' : ''}${hi === f.k ? ' hi' : ''}${na ? ' na' : ''}" draggable="${f.lock ? 'false' : 'true'}" data-k="${f.k}">` +
        `<span class="cp-grip">⠿</span><span class="cp-name">${escapeHtml(f.l)}</span>` +
        `<span class="cp-grp">${escapeHtml(f.g)}${na ? ' · needs PR History' : ''}${f.lock ? ' · always shown' : ''}</span></li>`;
    };
    function draw(){
      ulShown.innerHTML = shownCols.map(k => itemHtml(FIELD[k], 'shown')).join('');
      const q = find.value.trim().toLowerCase();
      ulAvail.innerHTML = FIELDS.filter(f => !shownCols.includes(f.k) && (!q || (f.l + ' ' + f.g).toLowerCase().includes(q)))
        .map(f => itemHtml(f, 'avail')).join('') || '<li class="cp-empty">—</li>';
      ov.querySelector('.cp-n-shown').textContent = `(${shownCols.length})`;
    }
    draw();
    find.addEventListener('input', draw);
    const moveTo = (k, list, beforeKey) => {
      const f = FIELD[k]; if (!f || f.lock && list === 'avail') return;
      shownCols = shownCols.filter(x => x !== k);
      if (list === 'shown') {
        const i = beforeKey ? shownCols.indexOf(beforeKey) : -1;
        if (i >= 0) shownCols.splice(i, 0, k); else shownCols.push(k);
      }
      hi = k; draw();
    };
    // highlight / double-click
    ov.addEventListener('click', (e) => {
      const li = e.target.closest('.cp-item'); if (li) { hi = li.dataset.k; draw(); }
    });
    ov.addEventListener('dblclick', (e) => {
      const li = e.target.closest('.cp-item'); if (!li) return;
      const inShown = shownCols.includes(li.dataset.k);
      moveTo(li.dataset.k, inShown ? 'avail' : 'shown');
    });
    // drag & drop
    let dragK = null;
    ov.addEventListener('dragstart', (e) => { const li = e.target.closest('.cp-item'); if (!li) return; dragK = li.dataset.k; li.classList.add('drag'); try { e.dataTransfer.setData('text/plain', dragK); e.dataTransfer.effectAllowed = 'move'; } catch (_) {} });
    ov.addEventListener('dragend', () => { dragK = null; ov.querySelectorAll('.cp-drop').forEach(n => n.classList.remove('cp-drop')); draw(); });
    [ulShown, ulAvail].forEach(ul => {
      ul.addEventListener('dragover', (e) => {
        if (!dragK) return; e.preventDefault();
        ov.querySelectorAll('.cp-drop').forEach(n => n.classList.remove('cp-drop'));
        const li = e.target.closest('.cp-item'); (li || ul).classList.add('cp-drop');
      });
      ul.addEventListener('drop', (e) => {
        e.preventDefault(); if (!dragK) return;
        const list = ul.dataset.list;
        let before = null;
        const li = e.target.closest('.cp-item');
        if (li && list === 'shown' && li.dataset.k !== dragK) {
          const r = li.getBoundingClientRect();
          const after = (e.clientY - r.top) > r.height / 2;
          const idx = shownCols.indexOf(li.dataset.k);
          const rest = shownCols.filter(x => x !== dragK);
          const j = rest.indexOf(li.dataset.k) + (after ? 1 : 0);
          before = rest[j] || null;
          if (idx < 0) before = null;
        }
        moveTo(dragK, list, before);
      });
    });
    // buttons
    ov.querySelectorAll('.cp-btn').forEach(b => b.addEventListener('click', () => {
      if (!hi) return;
      const act = b.dataset.act, i = shownCols.indexOf(hi);
      if (act === 'add' && i < 0) moveTo(hi, 'shown');
      if (act === 'rem' && i >= 0) moveTo(hi, 'avail');
      if ((act === 'up' || act === 'dn') && i >= 0) {
        const j = act === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < shownCols.length) { shownCols.splice(i, 1); shownCols.splice(j, 0, hi); draw(); }
      }
    }));
    const close = () => { ov.remove(); document.removeEventListener('keydown', onEsc); };
    function onEsc(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc);
    ov.querySelector('.scr-backdrop').addEventListener('click', close);
    ov.querySelector('.cp-x').addEventListener('click', close);
    ov.querySelector('.cp-cancel').addEventListener('click', close);
    ov.querySelector('.cp-default').addEventListener('click', () => { shownCols = DEFAULT_COLS.slice(); hi = null; draw(); });
    ov.querySelector('.cp-apply').addEventListener('click', async () => {
      state.columns = sanitizeColumns(shownCols);
      if (!state.columns.includes(state.sortKey)) { state.sortKey = 'material'; state.sortDir = 'asc'; }
      try { await AppStorage.set('settings.canvasColumns', state.columns); } catch (e) { /* swallow */ }
      persistView();
      close();
      renderTable();
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     FILTER PANEL (inline, live) — the former "Screener bands" modal body
  ═════════════════════════════════════════════════════════════════════════ */
  function distinctValues(key){
    const s = new Set();
    for (const e of state.materials) { const v = e.m[key]; s.add(String(v == null ? '' : v)); }
    return [...s].sort();
  }

  function buildBandsBody(){
    const setHtml = activeSetFields().map(f => {
      const vals = distinctValues(f.k);
      const band = state.bands[f.k];
      const checkedSet = (band && band.type === 'set') ? new Set(band.values) : null;
      return `
        <div class="band-field">
          <div class="band-field-lab">${escapeHtml(f.l)}</div>
          <div class="band-checks">
            ${vals.map(v => {
              const checked = checkedSet ? (checkedSet.has(v) ? 'checked' : '') : '';
              const disp = v === '' ? '(blank)' : v;
              return `<label class="band-chk"><input type="checkbox" data-set="${escapeAttr(f.k)}" value="${escapeAttr(v)}" ${checked}><span>${escapeHtml(disp)}</span></label>`;
            }).join('')}
          </div>
        </div>`;
    }).join('');

    const rangeHtml = RANGE_FIELDS.map(f => {
      const band = state.bands[f.k];
      const mn = (band && band.type === 'range' && band.min != null) ? band.min : '';
      const mx = (band && band.type === 'range' && band.max != null) ? band.max : '';
      return `
        <div class="band-field band-range">
          <div class="band-field-lab">${escapeHtml(f.l)}</div>
          <div class="band-range-row">
            <input type="number" data-range-min="${escapeAttr(f.k)}" placeholder="min" value="${mn}">
            <span class="band-dash">–</span>
            <input type="number" data-range-max="${escapeAttr(f.k)}" placeholder="max" value="${mx}">
          </div>
        </div>`;
    }).join('');

    const allCards = activeFlagCards();
    const flagCardHtml = (card) => {
      const band = state.bands[card.id];
      const checkedSet = (band && band.type === 'flag') ? new Set(band.flags) : null;
      return `
        <div class="band-field">
          <div class="band-field-lab">${escapeHtml(card.l)} <span class="band-field-key">any of</span></div>
          <div class="band-checks">
            ${card.flags.map(fl => {
              const checked = checkedSet ? (checkedSet.has(fl.k) ? 'checked' : '') : '';
              return `<label class="band-chk"><input type="checkbox" data-flag-card="${escapeAttr(card.id)}" data-flag-key="${escapeAttr(fl.k)}" ${checked}><span>${escapeHtml(fl.l)}</span></label>`;
            }).join('')}
          </div>
        </div>`;
    };
    const reviewCards = allCards.filter(c => c.grp === 'review');
    const flagCards = allCards.filter(c => c.grp !== 'review');
    const flagHtml = flagCards.map(flagCardHtml).join('');
    const reviewHtml = reviewCards.map(flagCardHtml).join('');

    $('#bandsBody').innerHTML = `
      ${reviewCards.length ? `<div class="band-group-lab">Review work</div><div class="band-grid">${reviewHtml}</div><div class="band-rev-act"><button type="button" class="ghost scr-mini" id="btnClearReviewed">Clear all ✓ ticks</button></div>` : ''}
      ${flagCards.length ? `<div class="band-group-lab">Risk flags</div><div class="band-grid">${flagHtml}</div>` : ''}
      <div class="band-group-lab">Categories</div>
      <div class="band-grid">${setHtml}</div>
      <div class="band-group-lab">Ranges</div>
      <div class="band-grid">${rangeHtml}</div>
      <div class="band-intro">Filters combine with <b>AND</b>. In a category, tick the values to keep (none ticked = no filter). In a risk card, any ticked condition matches. Min comparisons use the <b>current SAP Min</b>.</div>`;
  }

  function applyBands(){
    const bands = {};
    for (const f of activeSetFields()) {
      const boxes = $$(`#bandsBody input[data-set="${f.k}"]`);
      const total = boxes.length;
      const checked = boxes.filter(b => b.checked).map(b => b.value);
      // checked.length 0 or === total → no filter (ignore this set)
      if (checked.length > 0 && checked.length < total) bands[f.k] = { type:'set', values: checked };
    }
    for (const f of RANGE_FIELDS) {
      const minEl = $(`#bandsBody input[data-range-min="${f.k}"]`);
      const maxEl = $(`#bandsBody input[data-range-max="${f.k}"]`);
      const mn = parseFloat(minEl ? minEl.value : '');
      const mx = parseFloat(maxEl ? maxEl.value : '');
      const min = isNaN(mn) ? null : mn;
      const max = isNaN(mx) ? null : mx;
      if (min != null || max != null) bands[f.k] = { type:'range', min, max };
    }
    for (const card of activeFlagCards()) {
      const boxes = $$(`#bandsBody input[data-flag-card="${card.id}"]`);
      const checked = boxes.filter(b => b.checked).map(b => b.dataset.flagKey);
      if (checked.length) bands[card.id] = { type:'flag', combine: card.combine || 'or', flags: checked };
    }
    state.bands = bands;
    persistBands();
    renderTable();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PERSISTENCE
  ═════════════════════════════════════════════════════════════════════════ */
  async function persistBands(){
    try { await AppStorage.set('settings.screenerBands', state.bands); } catch (e) { /* swallow */ }
  }
  async function persistView(){
    try {
      await AppStorage.set('screener.viewState', {
        exportFlags: [...state.exportFlags],
        sortKey: state.sortKey,
        sortDir: state.sortDir
      });
    } catch (e) { /* swallow */ }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PDF EXPORT — one letter-landscape page per flagged material, both tiles
     side by side. Renders each combined detail into an offscreen stage, then
     html2canvas → image → jsPDF page. (math unchanged — this is presentation.)
  ═════════════════════════════════════════════════════════════════════════ */
  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'scr-toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // Lazy-load jsPDF + autoTable only when the operator actually exports — keeps
  // them off the normal screener page load.
  let _exportLibsReady = false;
  function loadScript(src){
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureExportLibs(){
    if (_exportLibsReady) return;
    if (!(window.jspdf && window.jspdf.jsPDF)) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    }
    // autoTable attaches to the jsPDF prototype.
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    _exportLibsReady = true;
  }

  // SVG → JPEG (much smaller files than PNG for the dark chart/box-plot images).
  // Mirrors AppChart.toPng but encodes JPEG. Reads the viewBox for dimensions.
  function svgToJpeg(svgEl, scale, quality){
    scale = scale || 1.8; quality = quality || 0.9;
    return new Promise((resolve, reject) => {
      try {
        const vb = svgEl.getAttribute('viewBox').split(' ');
        const w = parseInt(vb[2], 10), h = parseInt(vb[3], 10);
        const xml = new XMLSerializer().serializeToString(svgEl);
        const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = w * scale; c.height = h * scale;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#0C2D3B'; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = svg64;
      } catch (e) { reject(e); }
    });
  }

  const TL_RGB = { GREEN:[0,176,80], BLUE:[52,152,219], ORANGE:[255,140,0], RED:[192,0,0], PURPLE:[155,89,182], GREY:[150,150,150] };
  function hexRgb(h){ h = String(h).replace('#',''); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }

  // jsPDF standard fonts are WinAnsi (Latin-1) only — Unicode symbols like → ⚑ ↑
  // ≤ σ corrupt the text stream. Map the ones our copy/data use to ASCII before
  // any doc.text / autoTable call. (Chart + box plots are SVG, so they keep
  // their real glyphs — this is only for jsPDF-rendered text.)
  function pdfSafe(s){
    return String(s == null ? '' : s)
      .replace(/→/g, '->').replace(/←/g, '<-').replace(/↑/g, '^').replace(/↓/g, 'v')
      .replace(/⚑/g, '>').replace(/≤/g, '<=').replace(/≥/g, '>=')
      .replace(/σ/g, 'sd').replace(/≈/g, '~').replace(/✓/g, 'OK').replace(/[✗✕]/g, 'x')
      .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  }

  async function buildExportPdf(){
    const flagged = state.materials.filter(e => state.exportFlags.has(e.m.material));
    if (!flagged.length) { toast('Flag at least one material (checkbox in the list) first.', 'crit'); return; }

    const btn = $('#btnExport');
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Preparing…';

    let host = null;
    try {
      await ensureExportLibs();
      const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      if (!jsPDFCtor) throw new Error('jsPDF unavailable');

      // Offscreen host just to materialise SVGs — AppChart.toPng reads the
      // viewBox (not layout), so position/visibility don't matter here.
      host = document.createElement('div');
      host.style.cssText = 'position:fixed; left:-100000px; top:0; width:1000px;';
      document.body.appendChild(host);

      const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'letter', compress: true });  // APP-E3-PDF — compress streams
      for (let i = 0; i < flagged.length; i++) {
        btn.textContent = `Exporting ${i + 1}/${flagged.length}…`;
        if (i > 0) doc.addPage();
        await renderMaterialPage(doc, flagged[i].m, flagged[i].bucket, host);
      }

      const assess = (state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_');
      doc.save(`Screener_Export_${assess}_${flagged.length}-materials.pdf`);
      toast(`Exported ${flagged.length} page${flagged.length === 1 ? '' : 's'}.`, 'ok');
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + (err.message || err), 'crit');
    } finally {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      btn.disabled = false;
      btn.textContent = origText;
      updateExportButton();
    }
  }

  /* One letter-portrait page per material: Consumption detail (chart + stats +
     MRP) stacked above Procurement phase distribution (chevron + box plots +
     stats). Built from jsPDF primitives + AppChart.toPng (reliable + fast —
     no html2canvas). Flows onto extra pages if a material's content is tall. */
  async function renderMaterialPage(doc, m, bucket, host){
    const W = 216, H = 279, M = 12, CW = W - 2 * M;
    let y;

    function header(){
      doc.setFillColor(31, 56, 100);
      doc.rect(0, 0, W, 20, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
      doc.text(String(m.material), M, 9);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      doc.text(doc.splitTextToSize(pdfSafe(m.description || ''), CW - 46)[0] || '', M, 15);
      // TL pill, top-right
      const tl = m.trafficLight, c = TL_RGB[tl] || [127,127,127];
      const pw = 30, px = W - M - pw;
      doc.setFillColor(c[0], c[1], c[2]); doc.rect(px, 5, pw, 7, 'F');
      doc.setTextColor(tl === 'GREY' ? 0 : 255, tl === 'GREY' ? 0 : 255, tl === 'GREY' ? 0 : 255);
      doc.setFontSize(9); doc.text(String(tl || ''), px + pw / 2, 10, { align: 'center' });
      doc.setTextColor(225, 230, 235); doc.setFontSize(7.5);
      doc.text(pdfSafe((state.json.metadata.assessmentName || '').slice(0, 70)), M, 19);
      y = 26;
    }
    function ensure(need){ if (y + need > H - M) { doc.addPage(); y = M + 2; } }
    function sectionLabel(txt){
      ensure(8);
      doc.setTextColor(31, 56, 100); doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
      doc.text(txt, M, y); y += 2;
      doc.setDrawColor(31, 56, 100); doc.setLineWidth(0.4); doc.line(M, y, W - M, y); y += 4;
    }

    header();

    // ── Consumption detail ───────────────────────────────────────────────
    sectionLabel('Consumption detail');
    // R2-7 — top comment: show the ANALYST recommendation when the analyst entered
    // one (replacing the algorithmic line); flag For Action if flagged.
    const anRec = state.analyst ? state.analyst.getRec(m.material) : {};
    const anHas = !!(anRec && (anRec.mrpType || anRec.min || anRec.max || anRec.safety));
    const anFlagged = !!(state.analyst && state.analyst.isAction(m.material));
    const topComment = anHas
      ? `Analyst recommendation: MRP ${anRec.mrpType || '—'} · Min ${anRec.min || '—'} · Max ${anRec.max || '—'} · SS ${anRec.safety || '—'}`
      : ('Recommendation: ' + (m.action || '—'));
    const topLine = (anFlagged ? '★ For Action  —  ' : '') + topComment;
    doc.setTextColor(60, 60, 70); doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5);
    doc.splitTextToSize(pdfSafe(topLine), CW).slice(0, 2).forEach(line => { doc.text(line, M, y); y += 4; });
    doc.setFont('helvetica', 'normal'); y += 1;

    // Chart (AppChart → PNG)
    try {
      host.innerHTML = '<div id="expCh"></div>';
      const svg = AppChart.render(host.querySelector('#expCh'), m, { width: 936, height: 320 });
      const png = await svgToJpeg(svg, 1.8, 0.65);  // APP-E3-PDF — q0.65
      const chH = CW * 320 / 936;
      ensure(chH + 2);
      doc.addImage(png, 'JPEG', M, y, CW, chH); y += chH + 4;
    } catch (e) {
      doc.setTextColor(192, 0, 0); doc.text('Chart render error: ' + (e.message || e), M, y); y += 5;
    }

    // Stats table (2 stat-pairs per row)
    const rcDisp = m.rateChange != null ? m.rateChange + '%' : 'N/A';
    const adjDisp = (m.hceP2 && m.hceP2.length && m.adjP2Flag === 'OK') ? m.adjP2Rate.toFixed(2) + ' /mo' : '—';
    const cad = (typeof AppLocale !== 'undefined' && AppLocale.fmtCAD) ? AppLocale.fmtCAD(m.totValueOh) : String(m.totValueOh ?? '—');
    const swCount = (m.stockoutWindows || []).length;
    const statRows = [
      ['Stock on hand', m.stock ?? '—', 'Stock value', cad],
      ['P1 rate', m.p1Flag === 'OK' ? m.p1Rate.toFixed(2) + ' /mo' : '—', 'P2 rate', m.p2Flag === 'OK' ? m.p2Rate.toFixed(2) + ' /mo' : '—'],
      ['Runway @ P2', m.runway != null ? m.runway + ' mo' : '—', 'P1 -> P2 change', rcDisp],
      ['Pattern', m.pattern || '—', 'Adj P2 (HCE excl)', adjDisp],
      ['Total (window)', String(m.totalNet ?? '—'), 'Last consumption', m.lastConsumptionDate || '—'],
      ['Stockouts in window', swCount ? String(swCount) : 'none', 'Drop cause', m.rateDropCause === 'STOCKOUT_DRIVEN' ? 'Stockout-driven' : (m.rateDropCause ? 'Genuine drop' : '—')],
      ['Lead time (to site)', m.leadDays != null ? m.leadDays.toFixed(1) + ' d' : (m.leadGap ? '— (' + m.leadGap.short + ')' : '—'), 'Open PRs / POs', m.prOpenN != null ? `${m.prOpenN} / ${m.poOpenN}` : '—']
    ];
    ensure(34);
    doc.autoTable({
      startY: y, body: statRows, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.4, lineColor: [210,214,220], lineWidth: 0.1 },
      columnStyles: { 0:{fontStyle:'bold',fillColor:[241,243,246]}, 2:{fontStyle:'bold',fillColor:[241,243,246]} },
      tableWidth: CW, margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 4;

    // MRP compare — R2-7: + Analyst column (from the sidecar rec; '—' when blank).
    const mrpBody = [
      ['MRP type', m.mrpType || '—', m.recMrpType || '—', anRec.mrpType || '—'],
      ['Min', m.cmin != null ? String(m.cmin) : '—', m.recMin != null ? String(m.recMin) : '—', anRec.min || '—'],
      ['Max', m.cmax != null ? String(m.cmax) : '—', m.recMax != null ? String(m.recMax) : '—', anRec.max || '—'],
      ['Safety stock', m.safetyStock != null ? String(m.safetyStock) : '—', '—', anRec.safety || '—']
    ];
    ensure(26);
    doc.autoTable({
      startY: y, head: [['MRP setting', 'Current', 'Recommended', 'Analyst']], body: mrpBody, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.4, lineColor: [210,214,220], lineWidth: 0.1 },
      headStyles: { fillColor: [48,84,150], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: { 0:{fontStyle:'bold',fillColor:[241,243,246]}, 1:{halign:'center'}, 2:{halign:'center',textColor:[22,138,145]}, 3:{halign:'center',textColor:[176,122,22],fontStyle:'bold'} },
      tableWidth: CW,
      didParseCell: (d) => {
        if (d.row.section === 'head' && (d.column.index === 1 || d.column.index === 2 || d.column.index === 3)) d.cell.styles.halign = 'center';
        if (d.row.section === 'body' && d.column.index >= 1 && d.row.index < 3) { const cur = mrpBody[d.row.index][1], rec = mrpBody[d.row.index][2]; if (cur !== '—' && rec !== '—' && cur !== rec) d.cell.styles.fillColor = [255,243,205]; }
      },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 2;
    if (m.mrpReclassRecommended && m.mrpReclassNote) {
      ensure(8);
      doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(146,110,10);
      doc.splitTextToSize(pdfSafe('> ' + m.mrpReclassNote), CW).forEach(line => { doc.text(line, M, y); y += 3.6; });
      doc.setFont('helvetica','normal'); doc.setTextColor(0,0,0); y += 2;
    }
    y += 2;

    // ── Procurement phase distribution ───────────────────────────────────
    sectionLabel('Procurement phase distribution');
    if (!state.hasPr) {
      doc.setTextColor(120,80,0); doc.setFontSize(9);
      doc.splitTextToSize('Trace needs PR History — this assessment has none, so the procurement phase distribution is unavailable.', CW).forEach(l => { doc.text(l, M, y); y += 4; });
      return;
    }
    const chains = TracePhase.computeChains(state.json, m.material);
    // #22-tie (2026-08-16) — honour the operator's Trace outlier suppression in the
    // PDF too (was empty filters → the PDF drew UN-suppressed durations).
    const act = TracePhase.activeChains(chains, traceFiltersFor(m.material));
    const drawn = act.filter(c => !!c.siteWH);
    if (drawn.length < 2) {
      doc.setTextColor(120,80,0); doc.setFontSize(9);
      doc.splitTextToSize(`Only ${drawn.length} complete chain(s) reached Site WH for this material — at least 2 are needed to draw the phase distribution.`, CW).forEach(l => { doc.text(l, M, y); y += 4; });
      return;
    }
    const PK = TracePhase.PHASE_KEYS, PL = TracePhase.PHASE_LABELS;
    const pstats = PK.map(ph => ({ key: ph, label: PL[ph], s: TracePhase.boxStats(TracePhase.phaseVals(drawn, ph)) }));
    const flowMean = TracePhase.totalToSiteMean(drawn);   // #22-tie — shared corrected calc (= Σ phase means A–D)
    const ePh = pstats.find(x => x.key === 'E');
    const eMean = (ePh && ePh.s) ? ePh.s.mean : 0;

    // ── Timeline chevron (visual): proportional A–D bar + Total-to-site + Shelf E ──
    const flowPhases = pstats.filter(x => x.key !== 'E');
    const COLORS = TracePhase.PHASE_COLORS;
    ensure(26);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(95, 95, 105);
    doc.text(`Total lead time to site availability · phase decomposition · avg across ${drawn.length} chain${drawn.length === 1 ? '' : 's'}`, M, y);
    y += 2.5;
    const barW = CW * 0.70, barH = 13;
    let cx = M;
    flowPhases.forEach((p, i) => {
      const frac = flowMean > 0 ? (p.s ? p.s.mean : 0) / flowMean : 0;
      const segW = Math.max(barW * frac, 0.5);
      const rgb = hexRgb(COLORS[i]);
      doc.setFillColor(rgb[0], rgb[1], rgb[2]); doc.rect(cx, y, segW, barH, 'F');
      if (segW > 10) {
        // phase name + value stacked inside the segment (dark text on fill)
        doc.setTextColor(15, 22, 32);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(6);
        doc.splitTextToSize(pdfSafe(p.label || ''), segW - 2.5).slice(0, 2).forEach((ln, li) => doc.text(ln, cx + 1.8, y + 4 + li * 2.5));
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.text((p.s ? p.s.mean.toFixed(1) : '—') + 'd', cx + 1.8, y + barH - 1.8);
        doc.setFont('helvetica', 'normal');
      }
      cx += segW;
    });
    // Total-to-site readout (right of the bar)
    const totX = M + barW + 5;
    doc.setTextColor(95, 95, 105); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text('Total to site', totX, y + 5);
    doc.setTextColor(28, 44, 64); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(flowMean.toFixed(1) + 'd', totX, y + 11);
    doc.setFont('helvetica', 'normal');
    y += barH + 3.5;
    // Shelf E note (E also appears as its own titled box plot below).
    doc.setTextColor(120, 95, 175); doc.setFontSize(7.5);
    // APP-FIX-RAW-OPENSTEP — no used-after-delivery chain yet → '—', not a fake 0.0d
    doc.text(`then on shelf · E · Time to First Use: ${(ePh && ePh.s) ? eMean.toFixed(1) + 'd' : '-'}`, M, y); y += 5;

    // Box plots (each SVG → PNG), 5 across
    host.innerHTML = '<div id="expTp"></div>';
    TracePhase.render(host.querySelector('#expTp'), state.json, m.material, { filters: traceFiltersFor(m.material) });
    const plotSvgs = [...host.querySelectorAll('.pd-plot-svg')];
    if (plotSvgs.length) {
      const gap = 3, n = plotSvgs.length;
      const pw = (CW - (n - 1) * gap) / n;
      // Cap the plot height so the whole material fits one page (slight vertical
      // compression of the simple box-and-whisker is fine).
      const ph = Math.min(pw * 220 / 168, 33);
      const titleH = 7;                       // room for the per-plot phase title
      ensure(titleH + ph + 2);
      for (let k = 0; k < n; k++) {
        const x = M + k * (pw + gap), cxp = x + pw / 2;
        // Phase name above each plot (the SVG itself carries no label).
        const ps = pstats[k] || {};
        doc.setTextColor(45, 55, 70); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
        doc.splitTextToSize(pdfSafe(ps.label || ''), pw - 1).slice(0, 2).forEach((ln, li) => doc.text(ln, cxp, y + 3 + li * 2.7, { align: 'center' }));
        doc.setFont('helvetica', 'normal');
        try { const p = await svgToJpeg(plotSvgs[k], 2, 0.65); doc.addImage(p, 'JPEG', x, y + titleH, pw, ph); } catch (e) { /* skip one */ }
      }
      y += titleH + ph + 4;
    }
    // (Per operator feedback: the per-phase stats table is dropped from the PDF —
    // the timeline chevron + box plots carry the phase story.)
  }

  document.addEventListener('DOMContentLoaded', boot);

})();
