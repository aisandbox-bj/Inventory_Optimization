/* ═══════════════════════════════════════════════════════════════════════════
   Screener page — UI wiring · APP-SCR-01 (2026-06-25)
   ───────────────────────────────────────────────────────────────────────────
   A post-analysis BAND FILTER. Reads the same canonical JSON as Analysis +
   Trace, runs AppPipeline, lists the subset of analysed materials that fall
   inside operator-defined bands (AND-combined set + range filters over the
   per-material result fields), and on selection renders BOTH:
     · the Analysis material-detail visual (shared MaterialDetail.render), and
     · the Trace per-material phase distribution (shared TracePhase.render),
   responsive: side-by-side when wide, stacked when narrow.

   No SCHEMA_VERSION bump — consumes the existing pipeline result; bands persist
   in settings.sandboxBands (NOT the canonical JSON). LLM is OFF on the
   Screener (math decides; the panel is an Analysis-page affordance).

   Depends on: AppStorage, AppPipeline, AppChart, AppLocale, MaterialDetail,
   TracePhase.
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
    ]}
  ];
  const FLAG_LABELS = {};
  FLAG_CARDS.forEach(c => c.flags.forEach(fl => { FLAG_LABELS[fl.k] = fl.l; }));

  const state = {
    json:             null,
    result:           null,
    materials:        [],     // [{ m, bucket }] — deduped across buckets
    bands:            {},      // colKey → {type:'set',values:[]} | {type:'range',min,max}
    selectedMaterial: null,
    search:           '',
    hasPr:            false,
    exportFlags:      new Set(), // material numbers flagged for PDF export
    // APP-FIX-SCR-EXCL — Trace's per-material manual excludes + sigma setting,
    // loaded from trace.viewState so the Screener's avg lead time + embedded
    // Trace phase-distribution honour the SAME exclusions the operator set on
    // the Trace page (otherwise the average chain length wouldn't reconcile).
    traceExcl:        { manualByMat: {}, sigmaLimit: null },
    // SANDBOX — Calc B (proposed classifier) thresholds, driven by the sliders.
    sbx:              { factor: 1.2 }   // APP-SBX-BATCHMIN — batched-Min factor (will read from settings when promoted)
  };

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */
  async function boot(){
    const json = await AppStorage.get('intake.current');
    if (!json) { renderEmpty(); return; }
    state.json  = json;
    state.hasPr = !!(json.data && json.data.prHistory && json.data.prHistory.length);

    try {
      state.result = AppPipeline.runPipeline(json, { runDate: AppLocale.localDateISO() });
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

    // Derive per-material risk fields used by the new bands (SoH-vs-P2/Min,
    // PO/PR open status, avg procurement lead time, Min-vs-lead-time cover).
    computeRiskFields();
    computeProfileStats();   // SANDBOX — per-material consumption-distribution stats (Calc A numbers + Calc B input)

    // Load persisted bands + view state.
    try { state.bands = (await AppStorage.get('settings.sandboxBands')) || {}; } catch { state.bands = {}; }
    if (sanitizeBands()) persistBands();
    try {
      const vs = await AppStorage.get('sandbox.viewState');
      if (vs && vs.selectedMaterial && seen.has(vs.selectedMaterial)) state.selectedMaterial = vs.selectedMaterial;
      if (vs && Array.isArray(vs.exportFlags)) {
        state.exportFlags = new Set(vs.exportFlags.filter(m => seen.has(m)));
      }
    } catch { /* ignore */ }

    renderBanner();
    $('#scrToolbar').hidden = false;
    $('#scrMain').hidden = false;
    $('#sbxControls').hidden = false;
    $('#sbxReview').hidden = false;
    bindToolbar();
    bindSandboxControls();
    bindSandboxReview();   // APP-SBX-REVIEW — persistent review flag + note + vs-Prod modal
    renderActiveBands();
    renderList();
    updateExportButton();
    updateSandboxSummary();
    if (state.selectedMaterial) renderDetail();
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
        <span class="lab">Screening from</span>
        <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
        <div class="sub">${state.materials.length.toLocaleString()} materials in analysis · ${state.result.buckets.length} bucket${state.result.buckets.length === 1 ? '' : 's'}${state.hasPr ? '' : ' · no PR History (Trace panel disabled)'}</div>
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
    $('#scrSearch').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
    $('#btnBands').addEventListener('click', openBandsModal);
    $('#btnClearBands').addEventListener('click', async () => {
      state.bands = {};
      await persistBands();
      renderActiveBands();
      renderList();
    });
  }

  function updateExportButton(){
    const btn = $('#btnExport');
    if (!btn) return;
    const n = state.exportFlags.size;
    btn.textContent = `⤓ Export flagged (${n})`;
    btn.disabled = n === 0;
  }

  function renderActiveBands(){
    const el = $('#scrActiveBands');
    const keys = Object.keys(state.bands);
    if (!keys.length) { el.innerHTML = `<span class="scr-band-none">no bands · all materials</span>`; return; }
    el.innerHTML = keys.map(k => {
      const f = state.bands[k];
      let txt;
      if (f.type === 'set') txt = `${bandLabel(k)}: ${f.values.join('/')}`;
      else if (f.type === 'flag') {
        const labs = (f.flags || []).map(flagLabel);
        txt = labs.length > 1 ? `${bandLabel(k)}: ${labs.join(' / ')}` : bandLabel(k);
      }
      else txt = `${bandLabel(k)}: ${f.min != null ? f.min : '−∞'}…${f.max != null ? f.max : '∞'}`;
      return `<span class="scr-band-chip" title="${escapeAttr(txt)}">${escapeHtml(txt)}</span>`;
    }).join('');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PER-MATERIAL RISK FIELDS + band helpers (APP-SCR-01d)
  ═════════════════════════════════════════════════════════════════════════ */
  function numify(v){ if (v == null || v === '') return null; const n = (typeof v === 'number') ? v : parseFloat(v); return Number.isFinite(n) ? n : null; }

  function activeSetFields(){ return state.hasPr ? SET_FIELDS.concat(PR_SET_FIELDS) : SET_FIELDS.slice(); }
  function activeFlagCards(){ return FLAG_CARDS.filter(c => c.need !== 'pr' || state.hasPr); }
  function bandLabel(k){
    const f = activeSetFields().find(x => x.k === k)
           || RANGE_FIELDS.find(x => x.k === k)
           || FLAG_CARDS.find(x => x.id === k);
    return f ? f.l : k;
  }
  function flagLabel(k){ return FLAG_LABELS[k] || k; }

  // APP-FIX-SCR-EXCL — the same filter object Trace uses, for one material, so
  // completed-chain stats here match the Trace page. Year is always 'All' (the
  // Screener is all-time by design); manual + sigma exclusions are honoured.
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

  // Derive the fields the new bands filter on. SoH-vs-P2/Min need no PR data;
  // PO/PR open status, avg procurement lead time, and Min-vs-lead-time cover use
  // the PR→PO→GR chains (TracePhase.computeChains), so chain work runs only for
  // materials that actually have PR History rows. 'NA' = can't evaluate (missing
  // inputs) — never silently treated as "not at risk".
  function computeRiskFields(){
    const prMatHas = new Set();
    if (state.hasPr) {
      for (const r of (state.json.data && state.json.data.prHistory) || []) {
        const k = String(r.material == null ? '' : r.material).trim();
        if (k) prMatHas.add(k);
      }
    }
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
      let avgLT = null, poOpen = false, prOpen = false;
      if (state.hasPr && prMatHas.has(m.material)) {
        chainCalls++;
        const chains   = TracePhase.computeChains(state.json, m.material);
        // Apply Trace's manual + sigma exclusions before averaging, so the avg
        // lead time reconciles with the Trace view (APP-FIX-SCR-EXCL).
        const act      = TracePhase.activeChains(chains, traceFiltersFor(m.material));
        const complete = act.filter(c => !!c.siteWH);
        if (complete.length) {
          const tot = complete.reduce((s, c) => s + (c.A + c.B + c.C + c.D), 0);
          avgLT = tot / complete.length;                 // mean phase A–D total (days to site)
        }
        poOpen = chains.some(c => c.state === 'IN_FLIGHT' && !c.adminCancelled); // PO placed, not yet received at site
        prOpen = chains.some(c => c.state === 'PR_ONLY');                        // PR raised, no PO yet
      }
      m.avgProcTimelineDays = avgLT;
      m.poStatus = state.hasPr ? (poOpen ? 'Open' : 'None') : null;
      m.prStatus = state.hasPr ? (prOpen ? 'Open' : 'None') : null;

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
      console.log(`[sandbox] risk fields: ${state.materials.length} materials · ${chainCalls} chain computes · ${(performance.now() - t0).toFixed(0)}ms`);
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BAND PREDICATE + LIST
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

  function filteredMaterials(){
    let rows = state.materials.filter(e => passesBands(e.m, state.bands));
    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter(e => (e.m.material || '').toLowerCase().includes(q) || (e.m.description || '').toLowerCase().includes(q));
    }
    return rows;
  }

  function renderList(){
    const rows = filteredMaterials();
    $('#scrCount').textContent = `${rows.length.toLocaleString()} of ${state.materials.length.toLocaleString()} in analysis`;
    const host = $('#scrList');
    if (!rows.length) {
      host.innerHTML = `<div class="scr-list-empty">no materials match the current bands</div>`;
      return;
    }
    host.innerHTML = rows.map(e => {
      const m = e.m;
      const sel = m.material === state.selectedMaterial ? 'selected' : '';
      const flg = state.exportFlags.has(m.material) ? 'flagged' : '';
      const p2  = m.p2Flag === 'OK' ? m.p2Rate.toFixed(1) : '—';
      const rw  = m.runway != null ? m.runway + 'mo' : '—';
      const reclass = m.mrpRecFlag ? `<span class="scr-row-reclass" title="${escapeAttr(m.mrpReclassNote || 'Reclass recommended')}">${escapeHtml(m.mrpRecFlag)}</span>` : '';
      return `
        <div class="scr-row ${sel} ${flg}" data-mat="${escapeAttr(m.material)}">
          <input type="checkbox" class="scr-row-flag" data-flag="${escapeAttr(m.material)}" ${flg ? 'checked' : ''} title="Flag this material for PDF export" aria-label="Flag ${escapeAttr(m.material)} for export">
          <span class="tl-dot ${m.trafficLight}"></span>
          <div class="scr-row-main">
            <div class="scr-row-id">${escapeHtml(m.material)}${reclass}</div>
            <div class="scr-row-desc" title="${escapeAttr(m.description)}">${escapeHtml(m.description || '')}</div>
          </div>
          <div class="scr-row-stats">
            <span title="P2 rate / mo">${p2}</span>
            <span class="muted" title="Runway @ P2">${rw}</span>
          </div>
        </div>`;
    }).join('');
    $$('#scrList .scr-row').forEach(r => {
      r.addEventListener('click', () => {
        state.selectedMaterial = r.dataset.mat;
        persistView();
        renderList();
        renderDetail();
      });
    });
    // Export-flag checkboxes — toggle without selecting the row.
    $$('#scrList .scr-row-flag').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const mat = cb.dataset.flag;
        if (cb.checked) state.exportFlags.add(mat); else state.exportFlags.delete(mat);
        const row = cb.closest('.scr-row');
        if (row) row.classList.toggle('flagged', cb.checked);
        persistView();
        updateExportButton();
      });
    });
    updateExportButton();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     COMBINED DETAIL (MaterialDetail + TracePhase) — responsive grid
  ═════════════════════════════════════════════════════════════════════════ */
  function renderDetail(){
    const host = $('#scrDetail');
    const entry = state.materials.find(e => e.m.material === state.selectedMaterial);
    if (!entry) {
      host.innerHTML = `<div class="scr-empty"><div class="scr-empty-big">Pick a material</div>Select a material on the left to load its combined detail.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="scr-detail-grid">
        <div class="scr-detail-cell">
          <div class="scr-cell-lab">Consumption detail</div>
          <div id="scrCellDetail"></div>
        </div>
        <div class="scr-detail-cell">
          <div class="scr-cell-lab">Classifier sandbox — histogram + Calc A vs Calc B</div>
          <div id="sbxCellProfile"></div>
        </div>
      </div>`;

    // Analysis material-detail visual (LLM off). Wide aspect (Analysis parity).
    MaterialDetail.render($('#scrCellDetail'), entry.m, {
      bucket:      entry.bucket,
      parameters:  state.json.parameters,
      enableLlm:   false,
      chartWidth:  936,
      chartHeight: 320,
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

    renderProfilePanel($('#sbxCellProfile'), entry);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     SANDBOX — consumption-distribution profile + Calc A (current) vs Calc B
     (proposed mean-vs-median skew). Per-material stats are computed once at boot;
     the sliders only re-run the cheap Calc-B verdict + the cross-material summary.
  ═════════════════════════════════════════════════════════════════════════ */
  function computeProfileStats(){
    if (typeof ConsumptionProfile === 'undefined') return;
    for (const e of state.materials) {
      const evq = ConsumptionProfile.eventQtys(state.json, e.m.material);
      const woq = ConsumptionProfile.woQtys(state.json, e.m.material);
      const bq  = ConsumptionProfile.batchQtys(state.json, e.m.material);   // APP-BATCH-WO — WO draws only
      e.sbxQtys      = evq;
      e.sbxStats     = ConsumptionProfile.describe(evq);
      e.sbxA         = ConsumptionProfile.calcANumbers(woq);
      e.sbxBatchQtys = bq;
      e.sbxBatch     = ConsumptionProfile.describe(bq);
    }
  }

  // APP-SBX-BATCHMIN / APP-BATCH-WO — does the recommended Min cover a typical
  // WORK-ORDER batch draw? batch size = median net job draw (261/262 per order,
  // cost-centre excluded); batched Min = batch size × factor; flag when > rec Min.
  function batchAdequacy(entry){
    const st = entry.sbxBatch || {};
    const batchSize  = st.median || 0;
    const factor     = state.sbx.factor || 1.2;
    const batchedMin = batchSize > 0 ? Math.round(batchSize * factor) : null;
    const currentMin = (entry.m.recMin != null) ? entry.m.recMin : null;
    const needBatched = currentMin != null && batchedMin != null && batchedMin > currentMin;
    return { batchSize, factor, batchedMin, currentMin, needBatched };
  }

  function bindSandboxControls(){
    const f = $('#sbxFactor');
    if (f) f.addEventListener('input', () => {
      const v = parseFloat(f.value);
      if (Number.isFinite(v) && v > 0) state.sbx.factor = v;
      updateSandboxSummary();
      refreshProfilePanel();
    });
  }

  /* APP-SBX-REVIEW — persistent (settings.*) review flag + note, like the API
     keys: survives dataset reloads + page changes. Plus a "Sandbox vs Prod" delta
     modal so the operator can see what's experimental here and decide what to promote. */
  const SBX_REVIEW_KEY = 'settings.sandbox.reviewed';
  const SBX_NOTE_KEY   = 'settings.sandbox.reviewNote';
  const VS_PROD_ITEMS = [
    ['WO-only batch metric', 'Batch size = median net job draw per work order (261 net of 262); cost-centre draws (201/202 = shop consumables) are excluded. <b>Now promoted</b> — the live recommendation shows "Min · batched" from this figure (informational; the calc Min still governs).'],
    ['Batch histogram + WO-batch stats box', 'The per-job-draw distribution (nice round buckets + mean/median markers) and the "WO batch draws" stats. <b>Sandbox only.</b>'],
    ['BATCHED / STEADY labels', 'The Sandbox relabels the consumption pattern; the live Trend / Screener still read <b>LUMPY / SMOOTH</b> (global rename queued: APP-RENAME-BATCHED).'],
    ['Batched-Min adequacy + factor', 'The "RAISE MIN" verdict (batched Min vs current Min) with the live factor control. <b>Now promoted</b> — the factor is a real setting ("Batched Min factor", default 1.2) and the batched Min shows on the live recommendation. It does <b>not</b> change the calc Min/Max.'],
    ['The live recommendation is unchanged', 'For clarity: the algorithmic Min/Max stays <b>Min = P2 rate × min-months</b>, <b>Max = P2 rate × max-months</b>. Nothing in the Sandbox alters that — the batched figures are comparison-only.']
  ];
  function flashSaved(el){ if (!el) return; el.textContent = '✓ saved'; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1200); }
  function bindSandboxReview(){
    const chk = $('#sbxReviewed'), note = $('#sbxReviewNote'), saved = $('#sbxRevSaved');
    if (chk) {
      AppStorage.get(SBX_REVIEW_KEY).then(v => { chk.checked = !!v; }).catch(() => {});
      chk.addEventListener('change', async () => { try { await AppStorage.set(SBX_REVIEW_KEY, chk.checked); flashSaved(saved); } catch {} });
    }
    if (note) {
      AppStorage.get(SBX_NOTE_KEY).then(v => { if (typeof v === 'string') note.value = v; }).catch(() => {});
      let t; note.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(async () => { try { await AppStorage.set(SBX_NOTE_KEY, note.value); flashSaved(saved); } catch {} }, 350);
      });
    }
    const modal = $('#vsProdModal'), body = $('#vsProdBody');
    if (body) body.innerHTML = `<ul class="vsprod-list">${VS_PROD_ITEMS.map(([h, d]) => `<li><b>${h}</b><div>${d}</div></li>`).join('')}</ul>`;
    const open  = () => { if (modal) { modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false'); } };
    const close = () => { if (modal) { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); } };
    const btn = $('#btnVsProd'); if (btn) btn.addEventListener('click', open);
    const x = $('#vsProdClose'); if (x) x.addEventListener('click', close);
    const bk = $('#vsProdBackdrop'); if (bk) bk.addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  function updateSandboxSummary(){
    const el = $('#sbxSummary'); if (!el) return;
    let need = 0, evaluable = 0;
    for (const e of state.materials) {
      const ad = batchAdequacy(e);
      if (ad.currentMin != null && ad.batchedMin != null) { evaluable++; if (ad.needBatched) need++; }
    }
    el.innerHTML = `<span class="sbx-sum-b">${need} need a higher (batched) Min</span> <span class="sbx-sum-n">of ${evaluable} with a Min · ${state.materials.length} total</span>`;
  }

  function refreshProfilePanel(){
    if (!state.selectedMaterial) return;
    const entry = state.materials.find(e => e.m.material === state.selectedMaterial);
    const host  = $('#sbxCellProfile');
    if (entry && host) renderProfilePanel(host, entry);
  }

  function sbxPct(v){ return v == null ? '—' : (Math.round(v * 1000) / 10) + '%'; }
  function sbx2(v){ return v == null ? '—' : (Math.round(v * 100) / 100); }
  function sbx1(v){ return v == null ? '—' : (Math.round(v * 10) / 10); }

  function renderProfilePanel(host, entry){
    const st  = entry.sbxStats;
    const pat = entry.m.pattern || '';                                  // raw LUMPY/SMOOTH → reuse its colour class
    const patLabel = pat === 'LUMPY' ? 'BATCHED' : (pat === 'SMOOTH' ? 'STEADY' : (pat || '—'));
    const ad  = batchAdequacy(entry);
    const bt  = entry.sbxBatch || {};                                    // WO-only batch stats
    // Histogram shows the WORK-ORDER batch draws (the batch distribution); CC excluded.
    const histo = ConsumptionProfile.renderHistogram(entry.sbxBatchQtys, { width: 1040, height: 320, color: ad.needBatched ? '#FBBF24' : '#5DD9E2' });
    const vClass = ad.needBatched ? 'LUMPY' : 'SMOOTH';
    const vPill  = ad.currentMin == null ? '—' : (ad.needBatched ? 'RAISE MIN' : 'OK');
    let banner;
    if (ad.batchSize <= 0)          banner = `No work-order batch draws (drawn via cost-centre only) — batch-Min n/a`;
    else if (ad.currentMin == null) banner = `No recommended Min (not calculable) — can't test batch coverage`;
    else if (ad.needBatched)        banner = `Batched Min <b>${ad.batchedMin.toLocaleString()}</b> &gt; current Min ${ad.currentMin.toLocaleString()} → raise Min to cover a ${sbx1(ad.batchSize)}-unit WO batch`;
    else                            banner = `Current Min ${ad.currentMin.toLocaleString()} ≥ batched Min ${ad.batchedMin.toLocaleString()} — covers a ${sbx1(ad.batchSize)}-unit WO batch`;
    host.innerHTML = `
      <div class="sbx-histo">${histo}</div>
      <div class="sbx-compare">
        <div class="sbx-calc sbx-calc-a">
          <div class="sbx-calc-h">WO batch draws <span class="sbx-verdict ${pat}">${patLabel}</span></div>
          <div class="sbx-calc-sub">work orders only (CC excluded) · ${bt.n || 0} job draw${(bt.n || 0) === 1 ? '' : 's'} · all-issue median ${sbx1(st.median)}</div>
          <div class="sbx-rows">
            <span>mean</span><b>${sbx1(bt.mean)}</b>
            <span>median (batch)</span><b>${sbx1(bt.median)}</b>
            <span>std</span><b>${sbx1(bt.std)}</b>
            <span>min–max</span><b>${sbx1(bt.min)}–${sbx1(bt.max)}</b>
            <span>skew (mean÷med)</span><b>${bt.skew == null ? '—' : sbx2(bt.skew)}</b>
          </div>
        </div>
        <div class="sbx-calc sbx-calc-b">
          <div class="sbx-calc-h">Min adequacy <span class="sbx-verdict ${vClass}">${vPill}</span></div>
          <div class="sbx-calc-sub">batched Min = WO batch (median) × ${ad.factor}</div>
          <div class="sbx-rows">
            <span>batch size (median, WO)</span><b>${sbx1(ad.batchSize)}</b>
            <span>factor</span><b>${ad.factor}</b>
            <span>current Min</span><b>${ad.currentMin == null ? '—' : ad.currentMin.toLocaleString()}</b>
            <span>batched Min</span><b class="${ad.needBatched ? 'sbx-hot' : ''}">${ad.batchedMin == null ? '—' : ad.batchedMin.toLocaleString()}</b>
          </div>
        </div>
      </div>
      <div class="sbx-agree ${ad.needBatched ? 'no' : 'ok'}">${banner}</div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BANDS MODAL
  ═════════════════════════════════════════════════════════════════════════ */
  function distinctValues(key){
    const s = new Set();
    for (const e of state.materials) { const v = e.m[key]; s.add(String(v == null ? '' : v)); }
    return [...s].sort();
  }

  function openBandsModal(){
    buildBandsBody();
    buildBandsFoot();
    const modal = $('#bandsModal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    const closeBtn = $('#bandsClose');
    if (closeBtn && !closeBtn._wired) { closeBtn.addEventListener('click', closeBandsModal); closeBtn._wired = true; }
    const backdrop = $('#bandsBackdrop');
    if (backdrop && !backdrop._wired) { backdrop.addEventListener('click', closeBandsModal); backdrop._wired = true; }
  }
  function closeBandsModal(){
    const modal = $('#bandsModal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function buildBandsBody(){
    const setHtml = activeSetFields().map(f => {
      const vals = distinctValues(f.k);
      const band = state.bands[f.k];
      const checkedSet = (band && band.type === 'set') ? new Set(band.values) : null;
      return `
        <div class="band-field">
          <div class="band-field-lab">${escapeHtml(f.l)} <span class="band-field-key">${f.k}</span></div>
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
          <div class="band-field-lab">${escapeHtml(f.l)} <span class="band-field-key">${f.k}</span></div>
          <div class="band-range-row">
            <input type="number" data-range-min="${escapeAttr(f.k)}" placeholder="min" value="${mn}">
            <span class="band-dash">–</span>
            <input type="number" data-range-max="${escapeAttr(f.k)}" placeholder="max" value="${mx}">
          </div>
        </div>`;
    }).join('');

    const flagCards = activeFlagCards();
    const flagHtml = flagCards.map(card => {
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
    }).join('');
    const flagGroup = flagCards.length ? `
      <div class="band-group-lab">Risk flags</div>
      <div class="band-intro">Each card flags an at-risk condition; checks within a card combine with <b>OR</b> (match if any checked condition is true). Min comparisons use the <b>current SAP Min</b>. Cards that need the procurement lead time only appear when PR History is loaded.</div>
      <div class="band-grid">${flagHtml}</div>` : '';

    $('#bandsBody').innerHTML = `
      <div class="band-intro">Bands <b>AND</b> together — a material must satisfy every constraint you set. For a category band, leave it fully unchecked (or fully checked) to ignore it. For a range, leave both inputs blank to ignore it.</div>
      <div class="band-group-lab">Category bands</div>
      <div class="band-grid">${setHtml}</div>
      <div class="band-group-lab">Numeric range bands</div>
      <div class="band-grid">${rangeHtml}</div>
      ${flagGroup}`;
  }

  function buildBandsFoot(){
    $('#bandsFoot').innerHTML = `
      <button id="bandsClearAll" class="ghost">Clear all</button>
      <span class="scr-spacer"></span>
      <button id="bandsApply" class="primary">Apply bands</button>`;
    $('#bandsApply').addEventListener('click', applyBands);
    $('#bandsClearAll').addEventListener('click', () => {
      $$('#bandsBody input[type=checkbox]').forEach(c => c.checked = false);
      $$('#bandsBody input[type=number]').forEach(i => i.value = '');
    });
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
    closeBandsModal();
    renderActiveBands();
    renderList();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PERSISTENCE
  ═════════════════════════════════════════════════════════════════════════ */
  async function persistBands(){
    try { await AppStorage.set('settings.sandboxBands', state.bands); } catch (e) { /* swallow */ }
  }
  async function persistView(){
    try {
      await AppStorage.set('sandbox.viewState', {
        selectedMaterial: state.selectedMaterial,
        exportFlags: [...state.exportFlags]
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

      const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'letter' });
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
    // Algorithmic recommendation
    doc.setTextColor(60, 60, 70); doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5);
    doc.splitTextToSize(pdfSafe('Recommendation: ' + (m.action || '—')), CW).slice(0, 2).forEach(line => { doc.text(line, M, y); y += 4; });
    doc.setFont('helvetica', 'normal'); y += 1;

    // Chart (AppChart → PNG)
    try {
      host.innerHTML = '<div id="expCh"></div>';
      const svg = AppChart.render(host.querySelector('#expCh'), m, { width: 936, height: 320 });
      const png = await svgToJpeg(svg, 1.8, 0.92);
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
      ['Stockouts in window', swCount ? String(swCount) : 'none', 'Drop cause', m.rateDropCause === 'STOCKOUT_DRIVEN' ? 'Stockout-driven' : (m.rateDropCause ? 'Genuine drop' : '—')]
    ];
    ensure(34);
    doc.autoTable({
      startY: y, body: statRows, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.4, lineColor: [210,214,220], lineWidth: 0.1 },
      columnStyles: { 0:{fontStyle:'bold',fillColor:[241,243,246]}, 2:{fontStyle:'bold',fillColor:[241,243,246]} },
      tableWidth: CW, margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 4;

    // MRP compare
    const mrpBody = [
      ['MRP type', m.mrpType || '—', m.recMrpType || '—'],
      ['Min', m.cmin != null ? String(m.cmin) : '—', m.recMin != null ? String(m.recMin) : '—'],
      ['Max', m.cmax != null ? String(m.cmax) : '—', m.recMax != null ? String(m.recMax) : '—'],
      ['Safety stock', m.safetyStock != null ? String(m.safetyStock) : '—', '—']
    ];
    ensure(26);
    doc.autoTable({
      startY: y, head: [['MRP setting', 'Current', 'Recommended']], body: mrpBody, theme: 'grid',
      styles: { fontSize: 8, cellPadding: 1.4, lineColor: [210,214,220], lineWidth: 0.1 },
      headStyles: { fillColor: [48,84,150], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: { 0:{fontStyle:'bold',fillColor:[241,243,246]}, 1:{halign:'center'}, 2:{halign:'center',textColor:[22,138,145]} },
      tableWidth: CW,
      didParseCell: (d) => {
        if (d.row.section === 'head' && (d.column.index === 1 || d.column.index === 2)) d.cell.styles.halign = 'center';
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
    const act = TracePhase.activeChains(chains, {});
    const drawn = act.filter(c => !!c.siteWH);
    if (drawn.length < 2) {
      doc.setTextColor(120,80,0); doc.setFontSize(9);
      doc.splitTextToSize(`Only ${drawn.length} complete chain(s) reached Site WH for this material — at least 2 are needed to draw the phase distribution.`, CW).forEach(l => { doc.text(l, M, y); y += 4; });
      return;
    }
    const PK = TracePhase.PHASE_KEYS, PL = TracePhase.PHASE_LABELS;
    const pstats = PK.map(ph => ({ key: ph, label: PL[ph], s: TracePhase.boxStats(drawn.map(c => c[ph])) }));
    const flowMean = pstats.filter(x => x.key !== 'E').reduce((a, x) => a + (x.s ? x.s.mean : 0), 0);
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
    doc.text(`then on shelf · E · Time to First Use: ${eMean.toFixed(1)}d`, M, y); y += 5;

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
        try { const p = await svgToJpeg(plotSvgs[k], 2, 0.92); doc.addImage(p, 'JPEG', x, y + titleH, pw, ph); } catch (e) { /* skip one */ }
      }
      y += titleH + ph + 4;
    }
    // (Per operator feedback: the per-phase stats table is dropped from the PDF —
    // the timeline chevron + box plots carry the phase story.)
  }

  document.addEventListener('DOMContentLoaded', boot);

})();
