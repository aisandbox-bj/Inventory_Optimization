/* ═══════════════════════════════════════════════════════════════════════════
   Calibre Trace · v0.4-dev (left rail + scope machinery) · APP-T-04
   ───────────────────────────────────────────────────────────────────────────
   Reads canonical JSON from AppStorage (key 'intake.current' — same source
   Analysis uses). Hosts the left-rail layout: SCOPE selector (single vs
   multi-material) + VIEW list (current view dispatches into #contentView).

   Single-material views (built):
     ▶ Procurement Chain — relocated from T-03, fed by chain-compute below.
   Single-material views (queued):
     ◌ Phase Distribution

   Multi-material views (all queued — operator-named one chunk at a time):
     ◌ Internal Process MoM
     ◌ Supplier Performance
     ◌ 3PL Performance
     ◌ Cancellation Diagnostic
     ◌ Unit-Cost Sensitivity
     ◌ Year-on-Year
     ◌ Volume cumulative
     ◌ Data Table

   Persistence: trace.viewState in localStorage holds scopeMode +
   scopeSingle + scopeMulti + activeView so the page re-opens where the
   operator left off.
   ═════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $  = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  /* ─── State ────────────────────────────────────────────────────────────── */
  const state = {
    json:             null,
    materials:        [],          // [{ material, description, prCount, mb51Count, materialGroup, mrpInd, soh, mrpMin, mrpMax, safetyStock }]
    matIndex:         new Map(),   // material → entry (fast lookup)
    groupCounts:      new Map(),   // materialGroup → count (for the rail checkbox list)

    scopeMode:        'single',    // 'single' | 'multi'
    scopeSingle:      null,        // selected material number
    scopeMulti: {
      mode:           'list',      // 'list' | 'filter' (which mechanism the operator drove)
      materials:      [],          // explicit list (pasted or Tune's)
      groups:         new Set(),   // checked materialGroup values
      stockFilter:    'any',
      groupSearch:    ''
    },

    activeView:       'procurement-chain',
    matSearch:        '',
    chains:           [],          // computed per selected single material
    chart:            null
  };

  const PHASE_KEYS   = ['A', 'B', 'C', 'D', 'E'];
  const PHASE_LABELS = {
    A: 'PR Approval',
    B: 'Internal Processing',
    C: 'Vendor Lead Time',
    D: 'Transfer to Site',
    E: 'Time to First Use'
  };
  const PHASE_COLORS = ['#1FCED8', '#5AB69D', '#FBBF24', '#F87171', '#A78BFA'];

  const STORAGE_KEY = 'trace.viewState';

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */

  async function boot(){
    const json = await AppStorage.get('intake.current');
    if (!json) { showEmptyState(renderNoIntake()); return; }
    state.json = json;

    const prHistory = (json.data && json.data.prHistory) || [];
    if (prHistory.length === 0) { showEmptyState(renderNoPrHistory()); return; }

    state.materials = buildMaterialIndex(json);
    if (state.materials.length === 0) { showEmptyState(renderNoMaterials()); return; }

    state.materials.forEach(m => state.matIndex.set(m.material, m));
    state.groupCounts = buildGroupCounts(state.materials);

    // Hydrate persisted view state — silently fall through if anything's stale
    await hydratePersistedState();

    // Default the single-mode picker to first material if nothing persisted
    if (state.scopeMode === 'single' && !state.scopeSingle) {
      state.scopeSingle = state.materials[0].material;
    }

    bindRailControls();
    renderRail();
    renderBanner();
    renderActiveView();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     EMPTY STATES
  ═════════════════════════════════════════════════════════════════════════ */

  function showEmptyState(html){
    $('#emptyState').innerHTML = html;
    $('#emptyState').classList.remove('hidden');
    $('#traceRail').classList.add('hidden');
    $('#traceContent').classList.add('hidden');
  }

  function renderNoIntake(){
    return `
      <div class="empty-card">
        <span class="empty-lab">No intake loaded</span>
        <h2>Build a canonical JSON first</h2>
        <p>Go to the Intake page, drop your SAP exports including <b>PR History</b>, save → return here.</p>
        <a href="../intake/intake.html"><button class="primary">Go to Intake →</button></a>
      </div>`;
  }

  function renderNoPrHistory(){
    const j = state.json;
    return `
      <div class="empty-card">
        <span class="empty-lab">Loaded intake — but no PR History</span>
        <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
        <p>Trace needs <b>PR History</b> data to render procurement chains. Re-open this assessment in Intake and drop your PR History export, then save and return here.</p>
        <a href="../intake/intake.html"><button class="primary">Add PR History →</button></a>
      </div>`;
  }

  function renderNoMaterials(){
    return `
      <div class="empty-card">
        <span class="empty-lab">PR History loaded — but no usable rows</span>
        <h2>No materials matched after parse</h2>
        <p>Every PR History row has a blank material number, or every PR is fully cancelled / deleted. Check the source export.</p>
      </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL INDEX — augmented with InventoryMaster fields for filters
  ═════════════════════════════════════════════════════════════════════════ */

  function buildMaterialIndex(json){
    const prHistory = json.data.prHistory || [];
    const mb51      = json.data.mb51 || [];
    const master    = json.data.inventoryMaster || [];

    // Pre-index Inventory Master rows by material for fast lookup
    const masterByMat = new Map();
    for (const r of master) {
      const m = String(r.material || '').trim();
      if (m && !masterByMat.has(m)) masterByMat.set(m, r);
    }

    // Aggregate PR History per material
    const prByMat = new Map();
    for (const r of prHistory) {
      const m = String(r.material || '').trim();
      if (!m) continue;
      const entry = prByMat.get(m) || { material: m, prCount: 0, mb51Count: 0, descFallback: '' };
      entry.prCount++;
      if (!entry.descFallback && r.shortText) entry.descFallback = String(r.shortText).trim();
      prByMat.set(m, entry);
    }

    for (const r of mb51) {
      const m = String(r.material || '').trim();
      const entry = prByMat.get(m);
      if (entry) entry.mb51Count++;
    }

    return Array.from(prByMat.values()).map(e => {
      const mr = masterByMat.get(e.material) || {};
      return {
        material:      e.material,
        description:   (mr.description || e.descFallback || '').toString().trim(),
        prCount:       e.prCount,
        mb51Count:     e.mb51Count,
        materialGroup: String(mr.materialGroup || '').trim(),
        mrpInd:        String(mr.mrpInd || '').trim().toUpperCase(),
        soh:           toNum(mr.totQtyOh),
        mrpMin:        toNum(mr.mrpMin),
        mrpMax:        toNum(mr.mrpMax),
        safetyStock:   toNum(mr.safetyStock)
      };
    }).sort((a, b) => b.prCount - a.prCount);
  }

  function buildGroupCounts(mats){
    const m = new Map();
    for (const x of mats) {
      const g = x.materialGroup || '(none)';
      m.set(g, (m.get(g) || 0) + 1);
    }
    return new Map([...m.entries()].sort((a, b) => b[1] - a[1]));
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PERSISTENCE
  ═════════════════════════════════════════════════════════════════════════ */

  async function hydratePersistedState(){
    try {
      const saved = await AppStorage.get(STORAGE_KEY);
      if (!saved) return;
      if (saved.scopeMode === 'single' || saved.scopeMode === 'multi') state.scopeMode = saved.scopeMode;
      if (saved.scopeSingle && state.matIndex.has(saved.scopeSingle)) state.scopeSingle = saved.scopeSingle;
      if (saved.scopeMulti && typeof saved.scopeMulti === 'object') {
        state.scopeMulti.mode        = saved.scopeMulti.mode || 'list';
        state.scopeMulti.materials   = Array.isArray(saved.scopeMulti.materials) ? saved.scopeMulti.materials : [];
        state.scopeMulti.groups      = new Set(Array.isArray(saved.scopeMulti.groups) ? saved.scopeMulti.groups : []);
        state.scopeMulti.stockFilter = saved.scopeMulti.stockFilter || 'any';
      }
      if (saved.activeView) state.activeView = saved.activeView;
    } catch (e) { /* silently fall through */ }
  }

  async function persistState(){
    try {
      await AppStorage.set(STORAGE_KEY, {
        scopeMode:    state.scopeMode,
        scopeSingle:  state.scopeSingle,
        scopeMulti: {
          mode:        state.scopeMulti.mode,
          materials:   state.scopeMulti.materials,
          groups:      [...state.scopeMulti.groups],
          stockFilter: state.scopeMulti.stockFilter
        },
        activeView:   state.activeView
      });
    } catch (e) { /* swallow */ }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     RAIL — render + bind
  ═════════════════════════════════════════════════════════════════════════ */

  function bindRailControls(){
    // Scope mode toggle
    $$('input[name="scopeModeRadio"]').forEach(r => {
      r.addEventListener('change', () => {
        state.scopeMode = r.value;
        renderRail();
        renderBanner();
        renderActiveView();
        persistState();
      });
    });

    // Single — search box
    $('#matSearch').addEventListener('input', (e) => {
      state.matSearch = e.target.value;
      renderMatListCompact();
    });

    // Multi — Use Tune's list
    $('#btnUseTuneList').addEventListener('click', () => {
      const j = state.json;
      if (!(j.scope && j.scope.mode === 'manual' && j.scope.manual && j.scope.manual.materials && j.scope.manual.materials.length)) {
        renderScopeMultiSummary('No fixed material list on this assessment (its scope is fleet / param / classification). Use Paste list or the filters instead.');
        return;
      }
      state.scopeMulti.mode      = 'list';
      state.scopeMulti.materials = [...j.scope.manual.materials];
      renderRail();
      renderBanner();                                                 // POST-T-04 PATCH (2026-05-17) — banner was stale after Use-Tune's-list click; same fix on Paste / group / stock handlers below.
      renderActiveView();
      persistState();
    });

    // Multi — Paste list
    $('#btnPasteList').addEventListener('click', () => {
      $('#pasteZone').classList.toggle('hidden');
    });
    $('#pasteApply').addEventListener('click', () => {
      const raw = $('#pasteText').value || '';
      const mats = raw.split(/[\s,;\t\n]+/).map(s => s.trim()).filter(Boolean);
      state.scopeMulti.mode      = 'list';
      state.scopeMulti.materials = uniq(mats);
      $('#pasteZone').classList.add('hidden');
      renderRail();
      renderBanner();                                                 // POST-T-04 PATCH
      renderActiveView();
      persistState();
    });
    $('#pasteCancel').addEventListener('click', () => {
      $('#pasteZone').classList.add('hidden');
    });

    // Multi — Group filter search
    $('#groupSearch').addEventListener('input', (e) => {
      state.scopeMulti.groupSearch = e.target.value;
      renderGroupChecks();
    });

    // Multi — Stock filter
    $('#stockFilter').addEventListener('change', (e) => {
      state.scopeMulti.stockFilter = e.target.value;
      renderScopeMultiSummary();
      renderBanner();                                                 // POST-T-04 PATCH
      renderActiveView();
      persistState();
    });

    // View buttons — POST-T-04 PATCH (2026-05-17): no mode lockout. Any view
    // is clickable in any scope mode. Queued views land on the "not built
    // yet" panel; the built view (procurement-chain) renders chain content
    // when scope = single, and an honest "switch to single material" panel
    // when scope = multi.
    $$('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view;
        state.activeView = v;
        renderRail();
        renderActiveView();
        persistState();
      });
    });
  }

  function renderRail(){
    // Reflect scope mode
    $$('input[name="scopeModeRadio"]').forEach(r => { r.checked = (r.value === state.scopeMode); });
    $('#scopeSingle').classList.toggle('hidden', state.scopeMode !== 'single');
    $('#scopeMulti' ).classList.toggle('hidden', state.scopeMode !== 'multi');

    // POST-T-04 PATCH (2026-05-17) — active-only state per view. The .queued
    // class is set in the HTML for views that aren't built yet; we keep it,
    // and only toggle .active. Buttons are always clickable.
    $$('.view-btn').forEach(btn => {
      const v = btn.dataset.view;
      btn.classList.toggle('active', state.activeView === v);
    });

    if (state.scopeMode === 'single') {
      $('#matSearch').value = state.matSearch;
      renderMatListCompact();
    } else {
      renderGroupChecks();
      $('#stockFilter').value = state.scopeMulti.stockFilter;
      renderScopeMultiSummary();
    }
  }

  function renderMatListCompact(){
    const q = state.matSearch.trim().toLowerCase();
    const filtered = q
      ? state.materials.filter(m => m.material.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
      : state.materials;
    const max = 60;
    const shown = filtered.slice(0, max);

    $('#scopeSingleMeta').textContent = filtered.length === state.materials.length
      ? `${state.materials.length} total`
      : `${filtered.length} of ${state.materials.length}`;

    $('#matListCompact').innerHTML = shown.map(m => `
      <div class="mat-compact ${m.material === state.scopeSingle ? 'active' : ''}" data-mat="${escapeAttr(m.material)}" title="${escapeAttr((m.description || '') + ' · ' + m.prCount + ' PR · ' + m.mb51Count + ' MB51')}">
        <span class="mat-compact-id">${escapeHtml(m.material)}</span>
        <span class="mat-compact-desc">${escapeHtml(m.description || '—')}</span>
      </div>`).join('') + (filtered.length > max
        ? `<div class="mat-compact-more">… ${(filtered.length - max).toLocaleString()} more — refine search</div>`
        : '');

    $$('#matListCompact .mat-compact').forEach(el => {
      el.addEventListener('click', () => {
        state.scopeSingle = el.dataset.mat;
        renderMatListCompact();
        renderBanner();
        renderActiveView();
        persistState();
      });
    });
  }

  function renderGroupChecks(){
    const q = (state.scopeMulti.groupSearch || '').trim().toLowerCase();
    const groups = [...state.groupCounts.entries()].filter(([g]) => !q || g.toLowerCase().includes(q));
    $('#groupChecks').innerHTML = groups.map(([g, n]) => `
      <label class="group-check">
        <input type="checkbox" data-group="${escapeAttr(g)}" ${state.scopeMulti.groups.has(g) ? 'checked' : ''}>
        <span class="group-name" title="${escapeAttr(g)}">${escapeHtml(g)}</span>
        <span class="group-count">${n}</span>
      </label>`).join('') || `<div class="group-empty">no groups in this assessment</div>`;

    $$('#groupChecks input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const g = cb.dataset.group;
        if (cb.checked) state.scopeMulti.groups.add(g);
        else            state.scopeMulti.groups.delete(g);
        renderScopeMultiSummary();
        renderBanner();                                                 // POST-T-04 PATCH
        renderActiveView();
        persistState();
      });
    });
  }

  function renderScopeMultiSummary(overrideMsg){
    const matched = computeMultiScope().materials;
    if (overrideMsg) {
      $('#scopeMultiSummary').textContent = overrideMsg;
      return;
    }
    if (matched.length === 0 && state.scopeMulti.materials.length === 0 && state.scopeMulti.groups.size === 0 && state.scopeMulti.stockFilter === 'any') {
      $('#scopeMultiSummary').textContent = 'No multi-material scope set yet. Paste a list, use Tune\'s list, pick groups, or set a stock filter.';
    } else {
      $('#scopeMultiSummary').textContent = `${matched.length.toLocaleString()} material${matched.length === 1 ? '' : 's'} in scope`;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MULTI SCOPE — combine list + group + stock filter into a material set
  ═════════════════════════════════════════════════════════════════════════ */

  function computeMultiScope(){
    let pool = state.materials;
    // Explicit list narrows first
    if (state.scopeMulti.materials.length > 0) {
      const listSet = new Set(state.scopeMulti.materials.map(s => String(s).trim()));
      pool = pool.filter(m => listSet.has(m.material));
    }
    // Group filter
    if (state.scopeMulti.groups.size > 0) {
      pool = pool.filter(m => state.scopeMulti.groups.has(m.materialGroup || '(none)'));
    }
    // Stock filter (MRP-aware per the design note)
    const sf = state.scopeMulti.stockFilter;
    if (sf === 'oos') {
      pool = pool.filter(m => m.soh != null && m.soh <= 0);
    } else if (sf === 'belowMin') {
      pool = pool.filter(m => m.mrpInd === 'V1' && m.mrpMin != null && m.soh != null && m.soh < m.mrpMin);
    } else if (sf === 'belowSS') {
      pool = pool.filter(m => m.mrpInd === 'PD' && m.safetyStock != null && m.soh != null && m.soh < m.safetyStock);
    } else if (sf === 'aboveMax') {
      pool = pool.filter(m => m.mrpInd === 'V1' && m.mrpMax != null && m.soh != null && m.soh > m.mrpMax);
    }
    return { materials: pool };
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BANNER (compact context above the content area)
  ═════════════════════════════════════════════════════════════════════════ */

  function renderBanner(){
    const j = state.json;
    const counts = countRows(j);

    if (state.scopeMode === 'single') {
      const mat = state.matIndex.get(state.scopeSingle);
      if (!mat) { $('#contentBanner').innerHTML = ''; return; }
      $('#contentBanner').innerHTML = `
        <div class="banner-left">
          <span class="banner-lab">Material</span>
          <div class="banner-id">${escapeHtml(mat.material)}</div>
          <div class="banner-desc">${escapeHtml(mat.description || '—')}</div>
        </div>
        <div class="banner-mid">
          <span class="banner-lab">Assessment</span>
          <div class="banner-asst">${escapeHtml(j.metadata.assessmentName || '(unnamed)')}</div>
        </div>
        <div class="banner-right">
          <span class="banner-lab">Source data</span>
          <div class="banner-stats">${(counts.prHistory || 0).toLocaleString()} PR · ${(counts.mb51 || 0).toLocaleString()} MB51 · ${(counts.inventoryMaster || 0).toLocaleString()} master</div>
        </div>`;
    } else {
      const matched = computeMultiScope().materials;
      $('#contentBanner').innerHTML = `
        <div class="banner-left">
          <span class="banner-lab">Multi-material scope</span>
          <div class="banner-id">${matched.length.toLocaleString()} material${matched.length === 1 ? '' : 's'}</div>
          <div class="banner-desc">${describeMultiScope()}</div>
        </div>
        <div class="banner-mid">
          <span class="banner-lab">Assessment</span>
          <div class="banner-asst">${escapeHtml(j.metadata.assessmentName || '(unnamed)')}</div>
        </div>
        <div class="banner-right">
          <span class="banner-lab">Source data</span>
          <div class="banner-stats">${(counts.prHistory || 0).toLocaleString()} PR · ${(counts.mb51 || 0).toLocaleString()} MB51</div>
        </div>`;
    }
  }

  function describeMultiScope(){
    const bits = [];
    if (state.scopeMulti.materials.length) bits.push(`list of ${state.scopeMulti.materials.length}`);
    if (state.scopeMulti.groups.size)      bits.push(`${state.scopeMulti.groups.size} group${state.scopeMulti.groups.size === 1 ? '' : 's'}`);
    if (state.scopeMulti.stockFilter !== 'any') bits.push(stockFilterLabel(state.scopeMulti.stockFilter));
    return bits.length ? bits.join(' · ') : 'no filters set';
  }
  function stockFilterLabel(sf){
    return ({ oos: 'OOS', belowMin: 'below MRP Min', belowSS: 'below Safety Stock', aboveMax: 'above MRP Max' })[sf] || sf;
  }

  function countRows(j){
    const out = {};
    for (const k of Object.keys(j.data || {})) out[k] = (j.data[k] || []).length;
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     VIEW DISPATCH
  ═════════════════════════════════════════════════════════════════════════ */

  function renderActiveView(){
    const host = $('#contentView');
    // Force-clear any leftover Chart.js canvas instance
    if (state.chart) { state.chart.destroy(); state.chart = null; }

    // POST-T-04 PATCH (2026-05-17) — views aren't locked to scope mode any
    // more. Routing logic:
    //   activeView === 'procurement-chain':
    //     scope = single → render the chain view for the selected material
    //     scope = multi  → honest "switch to single material" panel
    //   activeView in queued list:
    //     either scope → "not built yet" panel (operator-named follow-up)
    if (state.activeView === 'procurement-chain') {
      if (state.scopeMode === 'single') {
        const mat = state.matIndex.get(state.scopeSingle);
        if (!mat) {
          host.innerHTML = `<div class="view-empty">Pick a material from the rail to load the procurement chain.</div>`;
          return;
        }
        renderProcurementChain(host, mat.material);
      } else {
        host.innerHTML = renderPCInMultiPanel();
      }
      return;
    }

    // APP-FIX-T-04b (2026-05-17) — Raw Data view: lifted out of Procurement
    // Chain into its own tab. All chains for the selected material, full
    // detail per row, no chart. Cancelled and PR-only chains included
    // here (they're filtered OUT of the swimlane but operator needs them
    // for raw drill-down).
    if (state.activeView === 'raw-data') {
      if (state.scopeMode === 'single') {
        const mat = state.matIndex.get(state.scopeSingle);
        if (!mat) {
          host.innerHTML = `<div class="view-empty">Pick a material from the rail to load the raw data.</div>`;
          return;
        }
        renderRawData(host, mat.material);
      } else {
        host.innerHTML = renderRawDataInMultiPanel();
      }
      return;
    }

    // Any other view is queued — render the not-built state (regardless of
    // scope mode). Queued multi-material views get a richer panel with the
    // candidate list; queued single-material views get a shorter one.
    if (isSingleScopeView(state.activeView)) {
      host.innerHTML = renderViewQueued(state.activeView);
    } else {
      host.innerHTML = renderMultiNoView();
    }
  }

  function isSingleScopeView(v){
    return v === 'phase-distribution';   // currently only Phase Distribution is the queued single-material view
  }

  function renderRawDataInMultiPanel(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Single material only</div>
        <h3>Raw Data renders one material at a time</h3>
        <p>Switch to <b>Single material</b> on the rail to load the chain table for a specific material.</p>
      </div>`;
  }

  function renderRawData(host, material){
    // Compute chains fresh — same logic as Procurement Chain view. State
    // share means both views render the same set; differ only in presentation.
    state.chains = computeChainsForMaterial(material);
    host.innerHTML = `
      <div class="raw-data-head">
        <span class="raw-data-lab">Raw Data · all PRs for material ${escapeHtml(material)}</span>
        <span class="raw-data-meta">${state.chains.length} chain${state.chains.length === 1 ? '' : 's'}</span>
      </div>
      <div class="chain-table-wrap">
        <table class="chain-table" id="chainTable">
          <thead>
            <tr>
              <th>PR</th>
              <th>PR date</th>
              <th>PO</th>
              <th>PO date</th>
              <th>3PL GR</th>
              <th>Site WH</th>
              <th>First 261</th>
              <th class="num">A</th>
              <th class="num">B</th>
              <th class="num">C</th>
              <th class="num">D</th>
              <th class="num">E</th>
              <th class="num">Total</th>
              <th class="num">Qty</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody id="chainTableBody"></tbody>
        </table>
      </div>
    `;
    renderChainTable();
  }

  function renderPCInMultiPanel(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Mode mismatch</div>
        <h3>Procurement Chain renders one material at a time</h3>
        <p>You're in <b>Multi-material</b> scope. The Procurement Chain view shows the PR → PO → GR → consumption chain for a single material; rendering it across many materials at once becomes unreadable.</p>
        <p>Switch to <b>Single material</b> on the rail to use this view, or pick one of the queued multi-material views below to call for build.</p>
        <ul class="view-candidates">
          <li><b>Internal Process MoM</b> — admin time (Phase A + B) month-on-month vs 3 / 6 / 12 month average</li>
          <li><b>Supplier Performance</b> — per-vendor scorecard, LT variance, OTIF</li>
          <li><b>3PL Performance</b> — Phase D administrative drift</li>
          <li><b>Cancellation Diagnostic</b> — cancelled PR ledger + cost</li>
          <li><b>Unit-Cost Sensitivity</b> — LT vs Net Price across POs</li>
          <li><b>Year-on-Year</b> — per-phase, per-year distribution</li>
          <li><b>Volume cumulative</b> — PR / PO / WH / consumption stack</li>
          <li><b>Data Table</b> — raw row drill-down with Excel-style filters</li>
        </ul>
      </div>`;
  }

  function renderViewQueued(viewKey){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Not built yet</div>
        <h3>${escapeHtml(prettyViewName(viewKey))}</h3>
        <p>This view is queued. Tell us when it's the most useful next view and it becomes the next chunk.</p>
      </div>`;
  }
  function renderMultiNoView(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">No multi-material views built yet</div>
        <h3>Pick the next view</h3>
        <p>The scope tool on the left is in place — multi-material views are operator-named, one chunk at a time. The roadmap candidates:</p>
        <ul class="view-candidates">
          <li><b>Internal Process MoM</b> — admin time (Phase A + B) month-on-month vs 3 / 6 / 12 month average</li>
          <li><b>Supplier Performance</b> — per-vendor scorecard, LT variance, OTIF</li>
          <li><b>3PL Performance</b> — Phase D administrative drift</li>
          <li><b>Cancellation Diagnostic</b> — cancelled PR ledger + cost</li>
          <li><b>Unit-Cost Sensitivity</b> — LT vs Net Price across POs</li>
          <li><b>Year-on-Year</b> — per-phase, per-year distribution</li>
          <li><b>Volume cumulative</b> — PR / PO / WH / consumption stack</li>
          <li><b>Data Table</b> — raw row drill-down with Excel-style filters</li>
        </ul>
        <p>In the meantime, switch to <b>Single material</b> on the rail to see procurement chains.</p>
      </div>`;
  }
  function prettyViewName(k){
    return ({
      'phase-distribution': 'Phase Distribution',
      'internal-mom': 'Internal Process MoM',
      'supplier-performance': 'Supplier Performance',
      'three-pl': '3PL Performance',
      'cancellation': 'Cancellation Diagnostic',
      'unit-cost': 'Unit-Cost Sensitivity',
      'year-on-year': 'Year-on-Year',
      'volume': 'Volume cumulative',
      'data-table': 'Data Table'
    })[k] || k;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PROCUREMENT CHAIN VIEW (ported from T-03)
  ═════════════════════════════════════════════════════════════════════════ */

  function renderProcurementChain(host, material){
    state.chains = computeChainsForMaterial(material);

    const complete = state.chains.filter(c => c.state === 'COMPLETE');
    const inFlight = state.chains.filter(c => c.state === 'IN_FLIGHT' || c.state === 'NOT_YET_CONSUMED');
    const prOnly   = state.chains.filter(c => c.state === 'PR_ONLY');
    const cancelled= state.chains.filter(c => c.state === 'CANCELLED');
    const avgLT    = complete.length
      ? Math.round(complete.reduce((s, c) => s + c.total, 0) / complete.length)
      : null;
    const manualPR = state.chains.filter(c => c.creationIndicator === 'R').length;

    // POST-T-04 PATCH (2026-05-17) — operator finding: chains all show "in-
    // flight" or "cancelled" on materials they're investigating. Surface the
    // honest data-source story instead of letting them guess. Only renders
    // when there are chains but none are complete — never-hide-issues.
    const diagnostic = (state.chains.length > 0 && complete.length === 0)
      ? renderZeroCompleteDiagnostic(material, inFlight.length, prOnly.length, cancelled.length)
      : '';

    host.innerHTML = `
      <div class="pchain-summary">
        <div class="sum-cell"><span class="lab">Complete chains</span><span class="v">${complete.length}</span></div>
        <div class="sum-cell"><span class="lab">In-flight</span><span class="v">${inFlight.length}</span></div>
        <div class="sum-cell"><span class="lab">PR only</span><span class="v">${prOnly.length}</span></div>
        <div class="sum-cell"><span class="lab">Cancelled</span><span class="v ${cancelled.length ? 'warn' : ''}">${cancelled.length}</span></div>
        <div class="sum-cell"><span class="lab">Avg total LT</span><span class="v">${avgLT != null ? avgLT + 'd' : '—'}</span></div>
        <div class="sum-cell"><span class="lab">Manual PRs</span><span class="v ${manualPR ? 'warn' : ''}">${manualPR}</span></div>
      </div>

      ${diagnostic}

      <div class="chart-toolbar">
        <span class="chart-toolbar-lab" id="chainCount">${state.chains.length} chain${state.chains.length === 1 ? '' : 's'} · ${complete.length} complete · ${inFlight.length} in-flight · ${cancelled.length} cancelled</span>
      </div>
      <div class="chart-host">
        <canvas id="swimChart"></canvas>
      </div>
      <div class="chart-caveat">Phases A–E computed from PR History + MB51 join on Purchase Order. Phase E (Time to First Use) measured to the first consumption transaction for this material after Site WH receipt — not necessarily of this PO's units specifically. Cancelled-before-PO PRs are excluded from the swimlane — see Raw Data view for the full list.</div>
    `;

    renderSwimlane();
  }

  function computeChainsForMaterial(material){
    const j = state.json;
    const prHistory = j.data.prHistory || [];
    const mb51      = j.data.mb51 || [];

    const prRows = prHistory.filter(r => String(r.material || '').trim() === material);

    const mb51ForMat = mb51.filter(r => String(r.material || '').trim() === material);
    const firstByPoMvt = new Map();
    for (const r of mb51ForMat) {
      const po = String(r.purchaseOrder || '').trim();
      const mvt = String(r.movementType || '').trim();
      if (!po || !mvt) continue;
      const key = po + '|' + mvt;
      const d = parseISO(r.postingDate);
      if (!d) continue;
      const existing = firstByPoMvt.get(key);
      if (!existing || d < existing.date) {
        firstByPoMvt.set(key, { date: d, qty: numOr(r.quantity, 0) });
      }
    }

    const cons261 = mb51ForMat
      .filter(r => String(r.movementType || '').trim() === '261')
      .map(r => parseISO(r.postingDate))
      .filter(Boolean)
      .sort((a, b) => a - b);

    return prRows.map(r => {
      const pr        = String(r.pr || '').trim();
      const po        = String(r.purchaseOrder || '').trim();
      const prDate    = parseISO(r.prDate);
      const relDate   = parseISO(r.releaseDate);
      const poDate    = parseISO(r.poDate);
      const gr3pl     = po ? (firstByPoMvt.get(po + '|107')?.date || null) : null;
      const siteWH    = po ? (firstByPoMvt.get(po + '|109')?.date || null) : null;
      const qtyAtWH   = po ? (firstByPoMvt.get(po + '|109')?.qty || 0)      : 0;
      const c261      = siteWH ? cons261.find(d => d >= siteWH) || null : null;

      // APP-FIX-T-04c (2026-05-17) — cancellation logic flipped OR → AND per
      // v0.3's documented ledger filter: "Cancelled PR ledger — rows where
      // Status='N' + Deletion Indicator=true". OR was over-classifying chains
      // that had progressed to PO (processingStatus='N' is also "Not yet
      // processed" / intermediate-state for non-cancelled PRs); v0.3's AND
      // requires BOTH signals before calling a PR cancelled.
      const cancelled = String(r.deletionIndicator || '').toLowerCase() === 'true'
                     && String(r.processingStatus || '').trim().toUpperCase() === 'N';

      const A = days(prDate, relDate);
      const B = days(relDate, poDate);
      const C = days(poDate, gr3pl);
      const D = days(gr3pl, siteWH);
      const E = days(siteWH, c261);
      const total = [A, B, C, D, E].reduce((s, x) => s + (x || 0), 0);

      let state_ = 'COMPLETE';
      if (cancelled)            state_ = 'CANCELLED';
      else if (!po)             state_ = 'PR_ONLY';
      else if (!siteWH)         state_ = 'IN_FLIGHT';
      else if (!c261)           state_ = 'NOT_YET_CONSUMED';

      return {
        pr, po,
        prDate:   fmtISO(prDate),
        relDate:  fmtISO(relDate),
        poDate:   fmtISO(poDate),
        gr3pl:    fmtISO(gr3pl),
        siteWH:   fmtISO(siteWH),
        c261:     fmtISO(c261),
        A, B, C, D, E, total,
        qty:      qtyAtWH || numOr(r.qtyRequested, 0),
        qtySource: qtyAtWH ? 'MB51-109' : 'PR-requested',
        state:    state_,
        cancelled,
        creationIndicator: String(r.creationIndicator || '').trim() || 'B'
      };
    }).sort((a, b) => (b.prDate || '').localeCompare(a.prDate || ''));
  }

  function renderSwimlane(){
    // APP-FIX-T-04c (2026-05-17) — tightened from `!!c.po` to `!!c.siteWH`
    // per operator review against v0.3. v0.3 deliberately excluded in-flight
    // chains (PO raised, Site WH not yet posted) from CHAINS: phase C/D/E
    // are null and the partial bar clutters the distribution stats. They
    // still appear on Raw Data view + cancellation diagnostic / progression
    // panels in v0.3, but NOT on the swimlane itself. Chains with PO but no
    // Site WH drop out here; they stay visible in the Raw Data tab.
    const drawn = state.chains.filter(c => !!c.siteWH);
    const labels = drawn.map(c => `${c.pr}${c.po ? ' → ' + c.po : ''}`);

    const datasets = PHASE_KEYS.map((ph, i) => ({
      label: PHASE_LABELS[ph],
      data:  drawn.map(c => c[ph] || 0),
      backgroundColor: drawn.map(c => c.cancelled ? 'rgba(239,68,68,0.18)' : PHASE_COLORS[i] + 'CC'),
      borderColor:     drawn.map(c => c.cancelled ? 'rgba(239,68,68,0.4)'  : PHASE_COLORS[i]),
      borderWidth: 1,
      borderRadius: 2
    }));

    const canvas = $('#swimChart');
    const h = Math.max(220, drawn.length * 32 + 60);
    canvas.style.height = h + 'px';

    if (state.chart) state.chart.destroy();
    if (drawn.length === 0) {
      canvas.style.height = '60px';
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#9BABA8';
      ctx.font = '12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('no chains with a PO to render — try another material', canvas.width / 2, 30);
      return;
    }

    state.chart = new Chart(canvas, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          // APP-FIX-T-04b — x-axis at TOP so the operator sees the calendar-
          // days scale immediately, not after scrolling through every chain.
          x: { stacked: true, position: 'top', grid: { color: 'rgba(31,206,216,.08)' }, ticks: { color: '#9BABA8', font: { family: 'JetBrains Mono', size: 10 } }, title: { display: true, text: 'Calendar Days', color: '#9BABA8', font: { size: 10 } } },
          y: { stacked: true, grid: { display: false }, ticks: { color: '#D6DFDE', font: { family: 'JetBrains Mono', size: 10 } } }
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#D6DFDE', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 14 } },
          tooltip: {
            callbacks: {
              title(items) { const c = drawn[items[0].dataIndex]; return `PR ${c.pr}${c.po ? ' · PO ' + c.po : ''}`; },
              beforeBody(items) {
                const c = drawn[items[0].dataIndex];
                return [
                  `PR Created: ${c.prDate || '—'}`,
                  `PO Created: ${c.poDate || '—'}`,
                  `3PL GR:     ${c.gr3pl || '—'}`,
                  `Site WH:    ${c.siteWH || '—'}`,
                  `First 261:  ${c.c261  || '—'}`,
                  '─────────'
                ];
              },
              label(item) { return ` ${item.dataset.label}: ${item.raw}d`; },
              afterBody(items) {
                const c = drawn[items[0].dataIndex];
                return [
                  '─────────',
                  `Total LT: ${c.total}d`,
                  `Qty: ${c.qty} (${c.qtySource})`,
                  `Source: ${c.creationIndicator === 'R' ? 'MANUAL PR' : 'MRP-generated'}`,
                  `State: ${c.state}`
                ];
              }
            },
            backgroundColor: 'rgba(8,12,20,.96)',
            borderColor: 'rgba(31,206,216,.3)', borderWidth: 1,
            titleColor: '#1FCED8', bodyColor: '#D6DFDE', padding: 10,
            titleFont: { family: 'JetBrains Mono', size: 11 },
            bodyFont:  { family: 'JetBrains Mono', size: 10 }
          }
        }
      }
    });
  }

  // POST-T-04 PATCH (2026-05-17) — diagnostic surface when 0 chains complete.
  // Splits the cause into measurable categories so the operator knows whether
  // it's a data-export issue or a real-world supply-chain finding.
  function renderZeroCompleteDiagnostic(material, inFlightCount, prOnlyCount, cancelledCount){
    const j = state.json;
    const mb51 = j.data.mb51 || [];

    // Site receipts (MVT 109) for this material — and which POs they touched.
    const receipts109 = mb51.filter(r =>
      String(r.material || '').trim() === material &&
      String(r.movementType || '').trim() === '109'
    );
    const receiptPOs = new Set(receipts109.map(r => String(r.purchaseOrder || '').trim()).filter(Boolean));

    // POs in PR History for this material.
    const prPOs = new Set(state.chains.map(c => c.po).filter(Boolean));

    // Intersection — POs that exist in BOTH PR History and MB51 receipt side.
    const overlap = [...prPOs].filter(p => receiptPOs.has(p)).length;

    // APP-FIX-T-04b (2026-05-17) — added "stale parse" detection. If MB51
    // 109 rows exist but their purchaseOrder fields are all blank, this is
    // an intake parsed before the MB51 purchaseOrder alias was added — the
    // chain join can't work without that field.
    const receipts109NoPo = receipts109.filter(r => !String(r.purchaseOrder || '').trim()).length;

    let scenario, body;
    if (receipts109.length === 0) {
      scenario = 'No goods receipts in MB51 for this material';
      body = `MB51 contains zero MVT-109 (site goods receipt) rows for material <b>${escapeHtml(material)}</b>. Two scenarios produce this:
        <ul>
          <li><b>Real-world incomplete chains</b> — receipts genuinely haven't happened yet (your ${inFlightCount} in-flight chains are the consequence) OR the chains were cancelled before delivery (your ${cancelledCount} cancelled).</li>
          <li><b>MB51 export was filtered</b> — common SAP export filter is "consumption only" (MVTs 261/201), which strips out receipt-side MVTs (101/107/109). Re-export including MVT 109 (or 107 for the 3PL leg) to verify which scenario you're in.</li>
        </ul>`;
    } else if (receipts109NoPo === receipts109.length) {
      scenario = `${receipts109.length.toLocaleString()} goods receipts in MB51 — but all have a blank purchase-order field`;
      body = `MB51 has <b>${receipts109.length.toLocaleString()}</b> MVT-109 row${receipts109.length === 1 ? '' : 's'} for this material but <b>every row has a blank <code>purchaseOrder</code> field</b>. The PR-to-receipt join keys on this field; without it, no chain can reach COMPLETE.
        <ul>
          <li><b>Most likely:</b> this assessment was parsed before the MB51 <code>purchaseOrder</code> alias was added (APP-FIX-T-04b, 2026-05-17). <strong>Save alone won't fix it — Save persists the in-memory canonical rows, which still don't have the field.</strong> Re-drop the original <code>MB51_Opn.xlsx</code> file on the Intake page (the MB51 drop zone), which triggers a fresh parse with the new alias map, then click Save and return here.</li>
          <li><b>Possible (rare):</b> the SAP MB51 export omitted the Purchase order column. Re-export including that column.</li>
        </ul>`;
    } else if (overlap === 0) {
      scenario = `${receipts109.length.toLocaleString()} goods receipts in MB51 — but none of them match the POs in PR History`;
      body = `MB51 has <b>${receipts109.length.toLocaleString()}</b> MVT-109 row${receipts109.length === 1 ? '' : 's'} for this material across <b>${receiptPOs.size}</b> purchase order${receiptPOs.size === 1 ? '' : 's'}, but <b>none</b> of those POs appear in PR History (which has <b>${prPOs.size}</b> distinct PO${prPOs.size === 1 ? '' : 's'} for this material).
        <ul>
          <li><b>Most likely:</b> PR History export covers a recent window; the goods receipts on file are for earlier POs that aged out of the PR window. Re-export PR History over a longer window.</li>
          <li><b>Possible:</b> PO-number format mismatch between the two exports (leading-zero differences, or different SAP plants with separate numbering).</li>
        </ul>`;
    } else {
      scenario = `${overlap} of ${prPOs.size} POs have receipts — but chain compute missed them`;
      body = `<b>${overlap}</b> of the <b>${prPOs.size}</b> distinct POs in PR History have at least one matching MVT-109 row in MB51. The chain-compute should have marked some of those COMPLETE — please drop me a note via Dev Notes with the PR / PO numbers and I'll dig in. (Most likely: date-ordering edge case where the first MB51-109 row predates the PR — confusing the chain join.)`;
    }

    return `
      <div class="chain-diagnostic">
        <div class="diag-lab">No complete chains — diagnostic</div>
        <div class="diag-headline">${escapeHtml(scenario)}</div>
        <div class="diag-body">${body}</div>
      </div>`;
  }

  function renderChainTable(){
    const rows = state.chains.map(c => `
      <tr class="${c.cancelled ? 'cancelled' : ''}">
        <td class="mono">${escapeHtml(c.pr)}</td>
        <td class="mono">${escapeHtml(c.prDate || '—')}</td>
        <td class="mono">${escapeHtml(c.po || '—')}</td>
        <td class="mono">${escapeHtml(c.poDate || '—')}</td>
        <td class="mono">${escapeHtml(c.gr3pl || '—')}</td>
        <td class="mono">${escapeHtml(c.siteWH || '—')}</td>
        <td class="mono">${escapeHtml(c.c261  || '—')}</td>
        <td class="num mono">${cellNum(c.A)}</td>
        <td class="num mono">${cellNum(c.B)}</td>
        <td class="num mono">${cellNum(c.C)}</td>
        <td class="num mono">${cellNum(c.D)}</td>
        <td class="num mono">${cellNum(c.E)}</td>
        <td class="num mono"><b>${c.total || '—'}</b></td>
        <td class="num mono">${c.qty != null ? c.qty.toLocaleString() : '—'}</td>
        <td class="state state-${c.state.toLowerCase()}">${c.state.replace(/_/g, ' ')}</td>
      </tr>
    `).join('');
    $('#chainTableBody').innerHTML = rows || `<tr><td colspan="15" class="empty">no chains for this material</td></tr>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */

  function parseISO(s){
    if (!s) return null;
    const str = String(s).slice(0, 10);
    const d = new Date(str + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtISO(d){ if (!d) return null; return d.toISOString().slice(0, 10); }
  function days(a, b){
    if (!a || !b) return 0;
    const ms = b - a;
    if (ms < 0) return 0;
    return Math.round(ms / 86400000);
  }
  function numOr(v, fb){
    if (v == null || v === '') return fb;
    const n = parseFloat(v);
    return isNaN(n) ? fb : n;
  }
  function toNum(v){
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  function cellNum(n){ if (n == null || n === 0) return '—'; return n.toString(); }
  function uniq(arr){ const s = new Set(); const out = []; for (const x of arr) { if (!s.has(x)) { s.add(x); out.push(x); } } return out; }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }

  document.addEventListener('DOMContentLoaded', boot);

})();
