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
    chains:           [],          // computed per selected single material (raw, unfiltered)
    chart:            null,

    // APP-V03-PORT-2 (2026-05-24) — filter machinery ported from v0.3
    // (lines 1221-1340). yearFilter + sigmaLimit are global preferences;
    // manualExclByMat is per-material so excluding a chain in one material
    // doesn't affect another.
    yearFilter:       'All',       // 'All' | year-string (e.g. '2025')
    sigmaLimit:       null,        // null = off; 3 / 2 / 1.5 = looser → tighter
    manualExclByMat:  new Map(),   // material → Set<pr-number>

    // APP-V03-PORT-5 (2026-05-24) — Volume view pack-size override.
    // Per-material because UOM varies; defaults to 1 if unset. Once D3
    // lands (UOM from inventoryMaster[i].uom) this falls back to that.
    packSizeByMat:    new Map()    // material → integer pack size (>= 1)
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

  // APP-T-07 — deep-link helpers for the Analysis "Trace it!" button.
  // trace.html#mat=<material> selects that material on boot.
  function readHashMaterial(){
    const h = (window.location.hash || '').replace(/^#/, '');
    if (!h) return null;
    const m = /(?:^|&)mat=([^&]+)/.exec(h);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  function clearHash(){
    try { history.replaceState(null, '', window.location.pathname + window.location.search); }
    catch (e) { try { window.location.hash = ''; } catch (e2) { /* ignore */ } }
  }

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

    // APP-T-07 — "Trace it!" deep link. trace.html#mat=<material> auto-picks that
    // material (overriding any persisted selection) when it exists in this
    // assessment, persists it as the new selection, then consumes the hash so a
    // later reload respects the normal last-picked selection.
    const hashMat = readHashMaterial();
    if (hashMat && state.matIndex.has(hashMat)) {
      state.scopeMode = 'single';
      state.scopeSingle = hashMat;
      await persistState();
      clearHash();
    }

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
      // APP-V03-PORT-2 — filter machinery
      if (typeof saved.yearFilter === 'string') state.yearFilter = saved.yearFilter;
      if (saved.sigmaLimit === null || saved.sigmaLimit === 3 || saved.sigmaLimit === 2 || saved.sigmaLimit === 1.5) {
        state.sigmaLimit = saved.sigmaLimit;
      }
      if (saved.manualExclByMat && typeof saved.manualExclByMat === 'object') {
        state.manualExclByMat = new Map();
        for (const [mat, prs] of Object.entries(saved.manualExclByMat)) {
          if (Array.isArray(prs)) state.manualExclByMat.set(mat, new Set(prs.map(String)));
        }
      }
      // APP-V03-PORT-5 — pack-size per material
      if (saved.packSizeByMat && typeof saved.packSizeByMat === 'object') {
        state.packSizeByMat = new Map();
        for (const [mat, n] of Object.entries(saved.packSizeByMat)) {
          const v = parseInt(n, 10);
          if (Number.isFinite(v) && v >= 1) state.packSizeByMat.set(mat, v);
        }
      }
    } catch (e) { /* silently fall through */ }
  }

  async function persistState(){
    try {
      // APP-V03-PORT-2 — serialise per-material exclude sets as plain object
      const manualExclSerial = {};
      for (const [mat, prSet] of state.manualExclByMat.entries()) {
        if (prSet && prSet.size) manualExclSerial[mat] = [...prSet];
      }
      // APP-V03-PORT-5 — serialise per-material pack-size
      const packSizeSerial = {};
      for (const [mat, n] of state.packSizeByMat.entries()) {
        if (n > 1) packSizeSerial[mat] = n;   // skip default 1 to keep storage tidy
      }
      await AppStorage.set(STORAGE_KEY, {
        scopeMode:    state.scopeMode,
        scopeSingle:  state.scopeSingle,
        scopeMulti: {
          mode:        state.scopeMulti.mode,
          materials:   state.scopeMulti.materials,
          groups:      [...state.scopeMulti.groups],
          stockFilter: state.scopeMulti.stockFilter
        },
        activeView:       state.activeView,
        yearFilter:       state.yearFilter,
        sigmaLimit:       state.sigmaLimit,
        manualExclByMat:  manualExclSerial,
        packSizeByMat:    packSizeSerial
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

    // APP-V03-PORT-4 (2026-05-24) — Phase Distribution view.
    if (state.activeView === 'phase-distribution') {
      if (state.scopeMode === 'single') {
        const mat = state.matIndex.get(state.scopeSingle);
        if (!mat) {
          host.innerHTML = `<div class="view-empty">Pick a material from the rail to load the distribution.</div>`;
          return;
        }
        renderPhaseDistribution(host, mat.material);
      } else {
        host.innerHTML = renderPDInMultiPanel();
      }
      return;
    }

    // APP-V03-PORT-5 (2026-05-24) — Volume cumulative view.
    if (state.activeView === 'volume') {
      if (state.scopeMode === 'single') {
        const mat = state.matIndex.get(state.scopeSingle);
        if (!mat) {
          host.innerHTML = `<div class="view-empty">Pick a material from the rail to load the volume chart.</div>`;
          return;
        }
        renderVolume(host, mat.material);
      } else {
        host.innerHTML = renderVolumeInMultiPanel();
      }
      return;
    }

    // APP-V03-PORT-6 (2026-06-26) — Year-on-Year view.
    if (state.activeView === 'year-on-year') {
      if (state.scopeMode === 'single') {
        const mat = state.matIndex.get(state.scopeSingle);
        if (!mat) {
          host.innerHTML = `<div class="view-empty">Pick a material from the rail to load the year-on-year view.</div>`;
          return;
        }
        renderYoY(host, mat.material);
      } else {
        host.innerHTML = renderYoYInMultiPanel();
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

  function isSingleScopeView(_v){
    // APP-V03-PORT-4 (2026-05-24) — no remaining queued single-scope views;
    // every queued view in the rail's view list is multi-material.
    return false;
  }

  function renderPDInMultiPanel(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Single material only</div>
        <h3>Phase Distribution renders one material at a time</h3>
        <p>Switch to <b>Single material</b> on the rail to load the box plots for a specific material.</p>
      </div>`;
  }

  function renderVolumeInMultiPanel(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Single material only</div>
        <h3>Volume cumulative renders one material at a time</h3>
        <p>Switch to <b>Single material</b> on the rail to load the cumulative chart for a specific material.</p>
      </div>`;
  }

  /* ─── APP-V03-PORT-5 (2026-05-24) · Pack-size helpers ────────────────── */
  function getPackSize(material){
    const v = state.packSizeByMat.get(material);
    return (v && v >= 1) ? v : 1;
  }
  function setPackSize(material, raw){
    const v = parseInt(raw, 10);
    if (Number.isFinite(v) && v >= 1) state.packSizeByMat.set(material, v);
    else state.packSizeByMat.delete(material);
  }
  function bindVolumePackSize(material){
    const input = $('#volPackSize');
    if (!input) return;
    const fire = () => {
      setPackSize(material, input.value);
      persistState();
      const host = $('#contentView');
      if (host) renderVolume(host, material);
    };
    input.addEventListener('change', fire);
    input.addEventListener('blur', fire);
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
    state._rawDataMaterial = material;
    // APP-V03-PORT-2 — show all chains but flag excluded ones, and surface
    // a small toggle in each row for manual exclude/include. Sigma-excluded
    // rows are read-only (toggle is greyed); manual-excluded rows can be
    // clicked back in.
    const totalExcl = allExcl(state.chains, material).size;
    const manualSet = getManualExcl(material);
    host.innerHTML = `
      <div class="raw-data-head">
        <span class="raw-data-lab">Raw Data · all PRs for material ${escapeHtml(material)}</span>
        <span class="raw-data-meta">${state.chains.length} chain${state.chains.length === 1 ? '' : 's'}${totalExcl ? ` · <b>${totalExcl}</b> excluded` : ''}${manualSet.size ? ` · <button class="tr-fbtn tr-reset" id="rawResetManual" title="Clear manual excludes for this material">Reset manual</button>` : ''}</span>
      </div>
      <div class="chain-table-wrap">
        <table class="chain-table" id="chainTable">
          <thead>
            <tr>
              <th></th>
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
    bindRawDataControls(material);
  }

  function bindRawDataControls(material){
    // Per-row exclude/include toggle
    $$('#chainTableBody [data-toggle-excl]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pr = btn.dataset.toggleExcl;
        const isSigma = btn.dataset.sigma === '1';
        if (isSigma) return;  // sigma-trimmed rows don't toggle from the table
        toggleManualExcl(material, pr);
        persistState();
        // Recompute + re-render the Raw Data view in place
        const host = $('#contentView');
        if (host) renderRawData(host, material);
      });
    });
    const reset = $('#rawResetManual');
    if (reset) {
      reset.addEventListener('click', () => {
        clearManualExcl(material);
        persistState();
        const host = $('#contentView');
        if (host) renderRawData(host, material);
      });
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     APP-V03-PORT-4 (2026-05-24) — PHASE DISTRIBUTION VIEW
     Ported from v0.3 drawBoxPlots() + buildStatsTable() (lines 1567–1827).
     Five box plots per phase A–E, Tukey upper fence (Q3 + 1.5·IQR) for
     Y-clipping, outliers above the fence rendered as ↑ markers. Stats
     table below shows N · Min · Mean · Median · Max per phase. Total
     Lead Time chevron banner above shows the average phase decomposition
     across the active chains.
     Consumes PORT-2's active() set transparently — filter chips, sigma
     trim, manual excludes from Procurement Chain view all carry through.
  ═════════════════════════════════════════════════════════════════════════ */

  function renderPhaseDistribution(host, material){
    state.chains = computeChainsForMaterial(material);
    const act    = active(state.chains, material);
    // Phase distribution operates on chains with all five phases populated —
    // i.e. those that reached site warehouse. IN_FLIGHT / PR_ONLY chains carry
    // null phases and are excluded so they don't pollute the stats.
    const drawn  = act.filter(c => !!c.siteWH);

    // Filter toolbar (same UX as Procurement Chain view — single source of truth)
    const years = getYearsForChains(state.chains);
    const manualSet = getManualExcl(material);
    const sigmaSet  = sigmaExcl(state.chains);
    const totalExcl = manualSet.size + sigmaSet.size;
    const yearBtns = ['All'].concat(years).map(y =>
      `<button class="tr-fbtn ${state.yearFilter === y ? 'active' : ''}" data-filter="year" data-val="${y}">${y === 'All' ? 'All years' : y}</button>`
    ).join('');
    const sigmaBtns = [
      { v: 'null', lab: 'Off',          title: 'No sigma trim' },
      { v: '3',    lab: 'Loose 3σ',     title: 'Drop chains slower than mean + 3·sd of total LT' },
      { v: '2',    lab: 'Standard 2σ',  title: 'Drop chains slower than mean + 2·sd of total LT' },
      { v: '1.5',  lab: 'Tight 1.5σ',   title: 'Drop chains slower than mean + 1.5·sd of total LT' }
    ].map(s => {
      const isActive = (s.v === 'null' && state.sigmaLimit === null) || (state.sigmaLimit !== null && Number(s.v) === state.sigmaLimit);
      return `<button class="tr-fbtn ${isActive ? 'active' : ''}" data-filter="sigma" data-val="${s.v}" title="${s.title}">${s.lab}</button>`;
    }).join('');
    const exclChipHtml = totalExcl
      ? `<span class="tr-excl-chip" title="Manually excluded: ${manualSet.size}. Sigma-trimmed: ${sigmaSet.size}.">${totalExcl} excluded</span>`
      : '';
    const resetBtnHtml = manualSet.size
      ? `<button class="tr-fbtn tr-reset" data-filter="reset-manual" title="Clear manual excludes for this material">Reset manual</button>`
      : '';
    const filterToolbar = `
      <div class="tr-filterbar" id="traceFilterBar">
        <span class="tr-flbl">Year</span>${yearBtns}
        <span class="tr-fsep"></span>
        <span class="tr-flbl">Sigma trim</span>${sigmaBtns}
        ${exclChipHtml}
        ${resetBtnHtml}
      </div>
    `;

    // APP-SCR-01 (2026-06-25) — the chevron + box-plot grid + transposed stats
    // table now live in shared/trace-phase.js (TracePhase), the single source of
    // truth shared with the Screener. The filter toolbar + its bindFilterBar
    // wiring stay here: Trace owns the year / sigma / manual-exclude UX.
    if (drawn.length < 2) {
      host.innerHTML = filterToolbar + TracePhase.renderPhaseEmpty(material, drawn.length, act.length);
    } else {
      host.innerHTML = filterToolbar + TracePhase.renderPhaseVisual(drawn);
    }

    bindFilterBar(material);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     APP-V03-PORT-5 (2026-05-24) — VOLUME CUMULATIVE VIEW
     Ported from v0.3 buildVolume() (lines 2510–2958). Five layered series
     over time: PR Raised / PO Raised / Site Receipt (MVT 109) / Consumed
     (MVT 261), plus cancelled-PR ticks at y=0 for hit detection.
     Consumes PORT-2's active() set so filter + manual excludes carry.
     Pack-size multiplier is per-material (state.packSizeByMat) — once D3
     locks UOM to inventoryMaster[i].uom, that pulls in via getPackSize.
     Custom Chart.js xNearestPerDataset interaction mode (v0.3:1228–1269)
     not needed here: Chart.js v4's 'nearest' mode with intersect:false
     handles the cross-dataset hover correctly because each series has
     its own {x, y} point set (not a shared-index array as in v0.3).
  ═════════════════════════════════════════════════════════════════════════ */

  function tsOf(dateStr){
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function fmtVolDate(ts){
    if (ts == null) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
  }

  function fmtVolDateFull(ts){
    if (ts == null) return '—';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '—';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
  }

  function buildCumulativeSeries(rows, dateGet, qtyGet){
    const pts = [];
    for (const r of rows) {
      const ts = tsOf(dateGet(r));
      if (ts == null) continue;
      const q = qtyGet(r);
      if (!Number.isFinite(q) || q === 0) continue;
      pts.push({ ts, q });
    }
    pts.sort((a, b) => a.ts - b.ts);
    let cum = 0;
    return pts.map(p => { cum += p.q; return { x: p.ts, y: cum }; });
  }

  // APP-FIX-VOL-CANCEL (2026-05-24) — Chart.js plugin that paints vertical
  // red ticks at every cancelled-PR's x-position along the bottom of the
  // chart area. The "Cancelled PR" scatter dataset stays in the chart but
  // renders invisibly (pointRadius:0); its meta.data positions are what
  // we read here so the tick lines stay in sync with year-filtering and
  // other re-renders. Hover hit detection is still handled by Chart.js
  // via pointHitRadius on the scatter dataset — operator hovers the tick,
  // tooltip pops with PR + qty + creation-indicator origin.
  const cancelTickPlugin = {
    id: 'cancelTicks',
    afterDatasetsDraw(chart) {
      const idx = (chart.data.datasets || []).findIndex(d => d && d.label === 'Cancelled PR');
      if (idx < 0) return;
      const meta = chart.getDatasetMeta(idx);
      if (!meta || meta.hidden) return;
      const ctx = chart.ctx;
      const yScale = chart.scales.y;
      if (!yScale) return;
      const yBottom = yScale.bottom;
      const yTop    = yBottom - 14;   // tick height above the x-axis baseline
      ctx.save();
      ctx.strokeStyle = '#EF4444';
      ctx.lineWidth   = 1.5;
      ctx.lineCap     = 'square';
      for (const pt of (meta.data || [])) {
        if (!pt || !Number.isFinite(pt.x)) continue;
        if (pt.x < chart.scales.x.left || pt.x > chart.scales.x.right) continue;
        ctx.beginPath();
        ctx.moveTo(pt.x, yBottom);
        ctx.lineTo(pt.x, yTop);
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  function renderVolume(host, material){
    state.chains = computeChainsForMaterial(material);
    const act    = active(state.chains, material);
    const ps     = getPackSize(material);
    const mb51   = (state.json.data.mb51 || []).filter(r => String(r.material || '').trim() === material);

    // ── Filter toolbar (shared with other views) ──────────────────────────
    const years = getYearsForChains(state.chains);
    const manualSet = getManualExcl(material);
    const sigmaSetV = sigmaExcl(state.chains);
    const totalExcl = manualSet.size + sigmaSetV.size;
    const yearBtns = ['All'].concat(years).map(y =>
      `<button class="tr-fbtn ${state.yearFilter === y ? 'active' : ''}" data-filter="year" data-val="${y}">${y === 'All' ? 'All years' : y}</button>`
    ).join('');
    const sigmaBtns = [
      { v: 'null', lab: 'Off',          title: 'No sigma trim' },
      { v: '3',    lab: 'Loose 3σ',     title: 'Drop chains slower than mean + 3·sd of total LT' },
      { v: '2',    lab: 'Standard 2σ',  title: 'Drop chains slower than mean + 2·sd of total LT' },
      { v: '1.5',  lab: 'Tight 1.5σ',   title: 'Drop chains slower than mean + 1.5·sd of total LT' }
    ].map(s => {
      const isActive = (s.v === 'null' && state.sigmaLimit === null) || (state.sigmaLimit !== null && Number(s.v) === state.sigmaLimit);
      return `<button class="tr-fbtn ${isActive ? 'active' : ''}" data-filter="sigma" data-val="${s.v}" title="${s.title}">${s.lab}</button>`;
    }).join('');
    const exclChipHtml = totalExcl ? `<span class="tr-excl-chip" title="Manually excluded: ${manualSet.size}. Sigma-trimmed: ${sigmaSetV.size}.">${totalExcl} excluded</span>` : '';
    const resetBtnHtml = manualSet.size ? `<button class="tr-fbtn tr-reset" data-filter="reset-manual" title="Clear manual excludes for this material">Reset manual</button>` : '';
    const filterToolbar = `
      <div class="tr-filterbar" id="traceFilterBar">
        <span class="tr-flbl">Year</span>${yearBtns}
        <span class="tr-fsep"></span>
        <span class="tr-flbl">Sigma trim</span>${sigmaBtns}
        ${exclChipHtml}
        ${resetBtnHtml}
      </div>
    `;

    // ── Cumulative series ─────────────────────────────────────────────────
    // PR Raised: only chains that converted to a PO contribute to this line —
    // they're the "real" raised demand from a flow perspective. Cancelled-no-PO
    // PRs surface as vertical red ticks along the x-axis (cancelTickPlugin
    // below), not on this line. Operator framing 2026-05-24: "only REQ's that
    // have been converted to PO's should show in the line charts; cancelled
    // PRs should only flag by the little red lines along the X-axis." (v0.3
    // lines 2589-2647 used the same shape — ticks for cancels, line for
    // PR-with-PO.)
    const prSeries = buildCumulativeSeries(act.filter(c => !!c.po), c => c.prDate, c => (c.qty || 0) * ps);
    // PO Raised: chains with a PO populated contribute at poDate
    const poSeries = buildCumulativeSeries(act.filter(c => !!c.po), c => c.poDate, c => (c.qty || 0) * ps);
    // Site Receipt: MB51 MVT 109 — independent of chain-level filters
    // (it's the physical receipt event regardless of how the chain classifies)
    const siteSeries = buildCumulativeSeries(
      mb51.filter(r => String(r.movementType || '').trim() === '109'),
      r => r.postingDate,
      r => Math.abs(parseFloat(r.quantity) || 0) * ps
    );
    // Consumed: MB51 MVT 261 — same independence rationale
    const consSeries = buildCumulativeSeries(
      mb51.filter(r => String(r.movementType || '').trim() === '261'),
      r => r.postingDate,
      r => Math.abs(parseFloat(r.quantity) || 0) * ps
    );

    // Cancelled-PR ticks: chains with state === 'CANCELLED' (per the PR/PO rule).
    // Render as a scatter at y=0; tooltip shows PR + qty + MRP-vs-manual.
    const cancelChains = act.filter(c => c.state === 'CANCELLED');
    const cancelPoints = cancelChains
      .map(c => ({ x: tsOf(c.prDate), y: 0, pr: c.pr, qty: (c.qty || 0) * ps, creationIndicator: c.creationIndicator, prDate: c.prDate }))
      .filter(p => p.x != null);

    // ── KPI strip values ─────────────────────────────────────────────────
    const fmt = n => n.toLocaleString();
    const sumQty = arr => arr.reduce((s, c) => s + (c.qty || 0), 0) * ps;
    const cancelledUnits = sumQty(cancelChains);
    const totalPRunits   = sumQty(act);
    const deliveredUnits = sumQty(act.filter(c => !!c.siteWH));
    const cancelRatePct  = totalPRunits > 0 ? (cancelledUnits / totalPRunits * 100) : 0;
    const totalChains    = act.length;
    const cancelCount    = cancelChains.length;

    // ── Empty state — no data of any kind ────────────────────────────────
    const totalEvents = prSeries.length + poSeries.length + siteSeries.length + consSeries.length + cancelPoints.length;
    if (totalEvents === 0) {
      host.innerHTML = `
        ${filterToolbar}
        <div class="pd-empty">
          <div class="pd-empty-lab">No volume data</div>
          <h3>Nothing to plot for material ${escapeHtml(material)}</h3>
          <p>The active set has no PR / PO / Site / Consume events. Check the year filter or switch to Raw Data to inspect what's there.</p>
        </div>
      `;
      bindFilterBar(material);
      return;
    }

    // ── HTML ──────────────────────────────────────────────────────────────
    const unitLabel = ps > 1 ? `units (pack size ${ps}× applied)` : 'units';
    host.innerHTML = `
      ${filterToolbar}
      <div class="vol-kpi-strip">
        <div class="vk-cell"><span class="lab">Cancelled PRs</span><span class="v ${cancelCount ? 'warn' : ''}">${cancelCount}</span><span class="sub">of ${totalChains}</span></div>
        <div class="vk-cell"><span class="lab">Cancelled units</span><span class="v ${cancelledUnits ? 'warn' : ''}">${fmt(cancelledUnits)}</span><span class="sub">${ps > 1 ? `× ${ps} pack` : ''}</span></div>
        <div class="vk-cell"><span class="lab">Cancellation rate</span><span class="v ${cancelRatePct > 30 ? 'warn' : ''}">${cancelRatePct.toFixed(1)}%</span><span class="sub">cancelled ÷ requested</span></div>
        <div class="vk-cell"><span class="lab">Delivered units</span><span class="v">${fmt(deliveredUnits)}</span><span class="sub">${ps > 1 ? `× ${ps} pack` : ''}</span></div>
        <div class="vk-pack">
          <label class="vk-pack-lab" title="Multiplier applied to all volumes. Per-material. Once D3 locks UOM from Inventory Master, this will pre-populate from inventoryMaster[i].uom; manual override stays available."><span>Pack size</span>
            <input id="volPackSize" type="number" min="1" step="1" value="${ps}" />
          </label>
        </div>
      </div>
      <div class="vol-chart-host"><canvas id="volChart"></canvas></div>
      <div class="chart-caveat">Cumulative time series for material <b>${escapeHtml(material)}</b>. <b>PR Raised</b> + <b>PO Raised</b> count <em>only chains that converted to a PO</em> (a PR that never reached PO doesn't move either cumulative line — its volume isn't real demand from a flow perspective). <b>Site Receipt</b> and <b>Consumed</b> sum MB51 movement types 109 and 261 by posting date (independent of chain-level filters — these are physical events). <b>Cancelled-PR ticks</b> drop as short vertical red lines at the x-axis baseline on each cancelled PR's PR date; hover any tick to see the PR + qty + MRP-vs-manual origin in the tooltip. Pack-size multiplies every unit value on the chart and in the KPI strip — leave at 1 if Inventory Master's UOM is "each".</div>
    `;

    bindFilterBar(material);
    bindVolumePackSize(material);

    // ── Build Chart.js chart ─────────────────────────────────────────────
    if (state.chart) state.chart.destroy();
    state.chart = new Chart($('#volChart'), {
      type: 'line',
      data: {
        datasets: [
          // APP-FIX-VOL-V03-PARITY (2026-06-26) — per-series styling restored to
          // v0.3's deliberate choices (buildVolume, v0.3 lines 2808–2842): PR/PO
          // dashed lines with point markers, Site Receipt the solid filled
          // headline series, Consumed a smooth (tension) line. Palette + dash /
          // fill / marker treatment only — data + cumulative math unchanged.
          { label: 'PR Raised',    data: prSeries,   borderColor: '#F472B6', backgroundColor: 'rgba(244,114,182,.06)', fill: false, stepped: 'before', borderDash: [6,4], borderWidth: 2,   pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: '#F472B6', tension: 0 },
          { label: 'PO Raised',    data: poSeries,   borderColor: '#FB923C', backgroundColor: 'rgba(251,146,60,.06)',  fill: false, stepped: 'before', borderDash: [6,4], borderWidth: 2,   pointRadius: 4, pointHoverRadius: 7, pointBackgroundColor: '#FB923C', tension: 0 },
          { label: 'Site Receipt', data: siteSeries, borderColor: '#1FCED8', backgroundColor: 'rgba(31,206,216,.10)',  fill: true,  stepped: 'before', pointRadius: 6, pointHoverRadius: 9, pointBackgroundColor: '#1FCED8', borderWidth: 2.5, tension: 0 },
          { label: 'Consumed',     data: consSeries, borderColor: '#FBBF24', backgroundColor: 'rgba(251,191,36,.04)',  fill: false, stepped: false,    pointRadius: 0, pointHoverRadius: 4, borderWidth: 2,   tension: 0.3 },
          // APP-FIX-VOL-CANCEL (2026-05-24) — cancelled-PR markers now render
          // as vertical red ticks at the x-axis baseline via cancelTickPlugin
          // (defined below). The scatter dataset is kept for Chart.js hover
          // hit detection only: pointRadius:0 keeps it invisible, pointHover
          // shows the diamond on hover so the operator can identify which
          // PR they're inspecting. Matches v0.3's tick design (lines 2603-2647).
          { label: 'Cancelled PR', data: cancelPoints, borderColor: '#EF4444', backgroundColor: '#EF4444', showLine: false, pointStyle: 'rectRot', pointRadius: 0, pointHoverRadius: 7, pointHitRadius: 14, borderWidth: 1 }
        ]
      },
      plugins: [cancelTickPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              callback: (ms) => fmtVolDate(ms),
              color: '#9BABA8',
              maxTicksLimit: 8,
              font: { family: 'JetBrains Mono', size: 10 }
            },
            grid: { color: 'rgba(31,206,216,.06)' },
            title: { display: false }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#9BABA8', font: { family: 'JetBrains Mono', size: 10 } },
            grid: { color: 'rgba(31,206,216,.06)' },
            title: { display: true, text: `Cumulative ${unitLabel}`, color: '#9BABA8', font: { size: 10 } }
          }
        },
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#D6DFDE', font: { family: 'JetBrains Mono', size: 10 }, boxWidth: 14, usePointStyle: true } },
          tooltip: {
            callbacks: {
              title: (items) => fmtVolDateFull(items[0].parsed.x),
              label: (item) => {
                if (item.dataset.label === 'Cancelled PR') {
                  const p = item.raw;
                  const src = p.creationIndicator === 'R' ? 'MANUAL PR' : 'MRP-generated';
                  return ` Cancelled PR ${p.pr} · ${p.qty.toLocaleString()} units · ${src}`;
                }
                return ` ${item.dataset.label}: ${item.parsed.y.toLocaleString()} units`;
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

  /* ═════════════════════════════════════════════════════════════════════════
     APP-V03-PORT-6 (2026-06-26) — YEAR-ON-YEAR VIEW
     Faithful port of v0.3 buildYoY() (v0.3 lines 1835–2084): per-phase A–E box
     plots, one box per year side by side, with a colour-coded mean-change delta
     marker between the two most recent years. Canvas-drawn (matches v0.3).
     Ignores the year filter (the view IS the year comparison); respects sigma +
     manual exclusions. Generalised to the years actually present in the data.
  ═════════════════════════════════════════════════════════════════════════ */
  function renderYoY(host, material){
    state.chains = computeChainsForMaterial(material);
    const ex     = allExcl(state.chains, material);
    // APP-FIX-YOY-CALC (2026-06-26) — average over COMPLETED chains only (those
    // that reached Site WH = received POs), matching the Phase Distribution view.
    // Previously this used every non-excluded chain incl. PR-only / cancelled /
    // in-flight, whose un-happened phases compute as 0 days — that dragged every
    // mean toward zero and made the per-year "n" count PRs, not POs.
    const acAll  = state.chains.filter(c => !ex.has(c.pr) && !!c.siteWH);   // completed only; ignore yearFilter; respect manual + sigma

    // Shared filter toolbar (same construction as the other views). Year buttons
    // are shown for consistency but DON'T change this view — noted in the sub.
    const years     = getYearsForChains(state.chains);
    const manualSet = getManualExcl(material);
    const sigmaSetV = sigmaExcl(state.chains);
    const totalExcl = manualSet.size + sigmaSetV.size;
    const yearBtns = ['All'].concat(years).map(y =>
      `<button class="tr-fbtn ${state.yearFilter === y ? 'active' : ''}" data-filter="year" data-val="${y}">${y === 'All' ? 'All years' : y}</button>`
    ).join('');
    const sigmaBtns = [
      { v: 'null', lab: 'Off',         title: 'No sigma trim' },
      { v: '3',    lab: 'Loose 3σ',    title: 'Drop chains slower than mean + 3·sd of total LT' },
      { v: '2',    lab: 'Standard 2σ', title: 'Drop chains slower than mean + 2·sd of total LT' },
      { v: '1.5',  lab: 'Tight 1.5σ',  title: 'Drop chains slower than mean + 1.5·sd of total LT' }
    ].map(s => {
      const isActive = (s.v === 'null' && state.sigmaLimit === null) || (state.sigmaLimit !== null && Number(s.v) === state.sigmaLimit);
      return `<button class="tr-fbtn ${isActive ? 'active' : ''}" data-filter="sigma" data-val="${s.v}" title="${s.title}">${s.lab}</button>`;
    }).join('');
    const exclChipHtml = totalExcl ? `<span class="tr-excl-chip" title="Manually excluded: ${manualSet.size}. Sigma-trimmed: ${sigmaSetV.size}.">${totalExcl} excluded</span>` : '';
    const resetBtnHtml = manualSet.size ? `<button class="tr-fbtn tr-reset" data-filter="reset-manual" title="Clear manual excludes for this material">Reset manual</button>` : '';
    const filterToolbar = `
      <div class="tr-filterbar" id="traceFilterBar">
        <span class="tr-flbl">Year</span>${yearBtns}
        <span class="tr-fsep"></span>
        <span class="tr-flbl">Sigma trim</span>${sigmaBtns}
        ${exclChipHtml}
        ${resetBtnHtml}
      </div>
    `;

    // Years present in the active set (numeric, ascending).
    const yrNums = [...new Set(acAll.map(c => Number(getChainYear(c))).filter(y => !isNaN(y)))].sort((a, b) => a - b);

    if (acAll.length === 0 || yrNums.length === 0) {
      host.innerHTML = `
        ${filterToolbar}
        <div class="pd-empty">
          <div class="pd-empty-lab">No year data</div>
          <h3>Nothing to compare for material ${escapeHtml(material)}</h3>
          <p>There are no <b>completed</b> chains (none reached Site WH), so there are no full phase durations to average year-on-year. Check the sigma / manual exclusions, or switch to Raw Data to inspect what's there.</p>
        </div>`;
      bindFilterBar(material);
      return;
    }

    // APP-V03-PORT-6b — per-year total-timeline chevrons (phases A–D to site +
    // shelf E) so the operator can compare the whole timeline year-over-year
    // above the box plots. Phase-coloured segments (consistent with the Phase
    // Distribution chevron); the year is labelled on the left.
    const palette = ['#4FC2D7', '#F87171', '#FBBF24', '#A78BFA', '#5AB69D', '#FB923C'];
    const yrColor = {}; yrNums.forEach((y, i) => { yrColor[y] = palette[i % palette.length]; });
    const PK = TracePhase.PHASE_KEYS, PL = TracePhase.PHASE_LABELS, PC = TracePhase.PHASE_COLORS;
    const meanPh = (chs, ph) => { const v = chs.map(c => c[ph]).filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
    const yrData = yrNums.map(yr => {
      const cc = acAll.filter(c => Number(getChainYear(c)) === yr);
      const m = {}; PK.forEach(ph => { m[ph] = meanPh(cc, ph); });
      return { yr, n: cc.length, m, flowMean: m.A + m.B + m.C + m.D };
    });
    // Same scale across years (operator): each bar's LENGTH is its total-to-site
    // relative to the largest year, so overall performance compares visually —
    // a shorter bar = a shorter total timeline.
    const sharedMaxFlow = Math.max(1, ...yrData.map(d => d.flowMean));
    const yoyChevrons = yrData.map(({ yr, n, m, flowMean }) => {
      const widthPct = (flowMean / sharedMaxFlow * 100).toFixed(1);
      const segs = PK.filter(k => k !== 'E').map((ph, i) => {
        const frac = flowMean > 0 ? m[ph] / flowMean : 0;
        return `<div class="pd-chev-seg" style="flex:${frac || 0.001}; background:${PC[i]}; --pd-chev-fill:${PC[i]};">
          <div class="pd-chev-inner"><span class="pd-chev-code">${ph}</span><span class="pd-chev-val">${m[ph].toFixed(1)}d</span></div>
        </div>`;
      }).join('');
      return `<div class="yoy-chev">
        <span class="yoy-chev-year" style="border-color:${yrColor[yr]}; color:${yrColor[yr]};">${yr}<small>n=${n}</small></span>
        <div class="yoy-chev-track"><div class="pd-chevron-bar" style="width:${widthPct}%;">${segs}</div></div>
        <div class="pd-chev-total-site" title="Average total processing time to site (phases A–D) for ${yr}."><span class="lab">Total to site</span><span class="v">${flowMean.toFixed(1)}d</span></div>
        <div class="pd-chev-shelf" style="border-color:${PC[4]}; background:${PC[4]}1f;" title="Average shelf time before first use (phase E) for ${yr}."><span class="pd-chev-shelf-lab">then on shelf</span><span class="pd-chev-shelf-name">E · ${PL.E}</span><span class="pd-chev-shelf-val" style="color:${PC[4]};">${m.E.toFixed(1)}d</span></div>
      </div>`;
    }).join('');
    const chevronsHtml = `<div class="yoy-chevrons"><div class="yoy-chevrons-lab">Total timeline by year — phases A–D to site, plus shelf time (E)</div>${yoyChevrons}</div>`;

    host.innerHTML = `
      ${filterToolbar}
      <div class="yoy-host">
        <div class="yoy-head">
          <span class="yoy-title">Year-over-Year — phase distribution</span>
          <span class="yoy-sub">${yrNums.join(' vs ')} · completed chains only (reached site, i.e. received POs) · exclusions respected · the year filter is ignored here</span>
        </div>
        <div class="yoy-legend"><b>Year-on-year direction:</b>
          <span style="color:#EF4444">▲ slower (worse)</span> ·
          <span style="color:#FBBF24">▲ mild +5–15%</span> ·
          <span style="color:#34D399">▼ faster (better)</span> ·
          <span style="color:#1FCED8">● stable ±5%</span>
        </div>
        ${chevronsHtml}
        <div class="yoy-chart-host"><canvas id="yoyCanvas"></canvas></div>
        <div class="chart-caveat">Each phase A–E shows one box plot per year side by side — mean line labelled, whiskers to min/max, IQR box, jittered points. All boxes share one y-axis (Tukey upper fence across every phase-year; values above the clip render as <b>↑</b> off-chart). The marker between the two most recent years flags the change in <b>mean</b> processing time: <span style="color:#EF4444">red &gt;+15%</span> / <span style="color:#FBBF24">orange +5–15%</span> slower · <span style="color:#34D399">green &lt;−5%</span> faster · <span style="color:#1FCED8">blue ±5%</span> stable. The <b>year filter is ignored</b> here (the view IS the comparison); sigma + manual exclusions are respected.</div>
      </div>`;

    bindFilterBar(material);
    drawYoYCanvas(host.querySelector('#yoyCanvas'), acAll, yrNums);
  }

  // Canvas draw — ported from v0.3 buildYoY(), generalised to N years.
  function drawYoYCanvas(canvas, acAll, yrNums){
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const dpr  = window.devicePixelRatio || 1;
    const wrap = canvas.parentNode;
    const W    = Math.max((wrap && wrap.clientWidth) ? wrap.clientWidth : 800, 520);
    const H    = 420;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const phases  = TracePhase.PHASE_KEYS;       // ['A','B','C','D','E']
    const pLabels = TracePhase.PHASE_LABELS;     // { A:'PR Approval', ... }
    const palette = ['#4FC2D7', '#F87171', '#FBBF24', '#A78BFA', '#5AB69D', '#FB923C'];
    const yrColor = {}; yrNums.forEach((y, i) => { yrColor[y] = palette[i % palette.length]; });
    const fmt0 = v => Math.round(v).toString();
    const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);

    // Per (phase, year): the raw values (for jitter/outliers) + box stats.
    const phYr = phases.map(ph => yrNums.map(yr => {
      const vals = acAll.filter(c => Number(getChainYear(c)) === yr)
                        .map(c => c[ph]).filter(v => v != null && Number.isFinite(v));
      return { vals, s: vals.length ? TracePhase.boxStats(vals) : null };
    }));

    const n = phases.length;
    const padL = 68, padR = 16, padT = 46, padB = 60;
    const plotW = W - padL - padR;
    const slotW = plotW / n;

    // Y scale — max = the total average duration (sum of per-phase pooled means
    // across both years), no padding factor (operator: drop the 1.x factor so
    // the scale IS the average total). Boxes/whiskers above this clip and flag
    // as ↑ off-chart.
    const pooledMean = phases.map(ph => {
      const vs = acAll.map(c => c[ph]).filter(v => v != null && Number.isFinite(v));
      return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : 0;
    });
    const totalMean = pooledMean.reduce((s, v) => s + v, 0);
    const yMax = Math.max(totalMean, 10);
    const yMin = 0;
    const yScale = v => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

    // Y grid + axis labels
    const yTicks = 5;
    ctx.font = '10px "JetBrains Mono",monospace';
    for (let i = 0; i <= yTicks; i++) {
      const v = yMin + (yMax - yMin) * i / yTicks;
      const y = yScale(v);
      ctx.strokeStyle = 'rgba(31,206,216,.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillStyle = '#9BABA8'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(v) + 'd', padL - 8, y + 3);
    }

    // Lane separators between phase columns
    ctx.strokeStyle = 'rgba(31,206,216,.18)'; ctx.lineWidth = 1;
    for (let i = 1; i < n; i++) {
      const x = padL + i * slotW;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
    }

    // Top legend: active count + outlier note + year swatches
    const counts = yrNums.map(yr => acAll.filter(c => Number(getChainYear(c)) === yr).length);
    ctx.fillStyle = 'rgba(31,206,216,.55)'; ctx.textAlign = 'left'; ctx.font = '10px "JetBrains Mono",monospace';
    ctx.fillText(`${acAll.length} completed chains  ·  scale = avg total ${Math.round(yMax)} d  ·  ↑ = above scale`, padL, 18);
    let swX = Math.max(padL + 220, W - padR - yrNums.length * 96);
    yrNums.forEach((yr, i) => {
      ctx.fillStyle = yrColor[yr]; ctx.fillRect(swX, 11, 10, 10);
      ctx.fillStyle = '#D6DFDE'; ctx.font = '10px "JetBrains Mono",monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${yr} (n=${counts[i]})`, swX + 16, 20);
      swX += 96;
    });

    const subCx = (pi, yi) => padL + pi * slotW + (slotW - slotW * 0.82) / 2 + (yi + 0.5) * (slotW * 0.82 / yrNums.length);

    phases.forEach((ph, pi) => {
      const row = phYr[pi];
      const slotCenterX = padL + (pi + 0.5) * slotW;
      const subW = slotW * 0.82 / yrNums.length;

      yrNums.forEach((yr, yi) => {
        const cell = row[yi], s = cell.s, col = yrColor[yr];
        const cx = subCx(pi, yi);
        const bw = Math.min(subW * 0.62, 30);

        if (s) {
          const visMax = Math.min(s.max, yMax);
          ctx.strokeStyle = col + '70'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(cx, yScale(s.min)); ctx.lineTo(cx, yScale(visMax)); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx - bw * 0.28, yScale(s.min)); ctx.lineTo(cx + bw * 0.28, yScale(s.min)); ctx.stroke();
          if (s.max <= yMax) { ctx.beginPath(); ctx.moveTo(cx - bw * 0.28, yScale(s.max)); ctx.lineTo(cx + bw * 0.28, yScale(s.max)); ctx.stroke(); }

          if (s.q1 !== s.q3) {
            const yQ1 = yScale(s.q1), yQ3 = yScale(s.q3);
            ctx.fillStyle = col + '20'; ctx.fillRect(cx - bw / 2, yQ3, bw, yQ1 - yQ3);
            ctx.strokeStyle = col + '50'; ctx.lineWidth = 1; ctx.strokeRect(cx - bw / 2, yQ3, bw, yQ1 - yQ3);
          }

          if (s.mean <= yMax) {
            ctx.strokeStyle = col; ctx.lineWidth = 2.5; const yMean = yScale(s.mean);
            ctx.beginPath(); ctx.moveTo(cx - bw / 2, yMean); ctx.lineTo(cx + bw / 2, yMean); ctx.stroke();
            // Mean value OUTSIDE the box (operator: hard to read on the box) — the
            // first year's label sits to the left of its box, later years to the
            // right, at mean height, clear of the box fill.
            ctx.fillStyle = col; ctx.font = 'bold 10px "JetBrains Mono",monospace';
            const side = (yi === 0) ? -1 : 1;
            ctx.textAlign = side < 0 ? 'right' : 'left';
            ctx.fillText(fmt1(s.mean) + 'd', cx + side * (bw / 2 + 5), yMean + 3);
          }

          ctx.font = '8.5px "JetBrains Mono",monospace'; ctx.fillStyle = col + 'CC'; ctx.textAlign = 'center';
          ctx.fillText(fmt0(s.min) + 'd', cx, yScale(s.min) + 11);
          if (s.max <= yMax) ctx.fillText(fmt0(s.max) + 'd', cx, yScale(s.max) - 4);

          const outl = cell.vals.filter(v => v > yMax).sort((a, b) => b - a);
          if (outl.length) {
            const arrowY = padT + 14;
            ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.font = 'bold 14px "Rajdhani",sans-serif';
            ctx.fillText('↑', cx, arrowY);
            ctx.font = '8.5px "JetBrains Mono",monospace'; ctx.fillStyle = col + 'CC';
            ctx.fillText(outl.length === 1 ? fmt0(outl[0]) + 'd' : fmt0(outl[0]) + 'd · +' + (outl.length - 1), cx, arrowY + 11);
          }

          cell.vals.forEach(v => {
            if (v > yMax) return;
            ctx.beginPath(); ctx.arc(cx + (Math.random() - 0.5) * bw * 0.35, yScale(v), 2.2, 0, Math.PI * 2);
            ctx.fillStyle = col + '80'; ctx.fill();
          });

          ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.font = 'bold 9.5px "JetBrains Mono",monospace';
          ctx.fillText(String(yr).slice(2), cx, H - padB + 12);
        } else {
          ctx.fillStyle = '#5C7270'; ctx.textAlign = 'center'; ctx.font = '9px "JetBrains Mono",monospace';
          ctx.fillText('—', cx, (H - padB + padT) / 2);
          ctx.fillStyle = col; ctx.font = 'bold 9.5px "JetBrains Mono",monospace';
          ctx.fillText(String(yr).slice(2), cx, H - padB + 12);
        }
      });

      // Delta marker between the two most recent years (mean change).
      if (yrNums.length >= 2) {
        const sA = row[yrNums.length - 2].s, sB = row[yrNums.length - 1].s;
        if (sA && sB && sA.n && sB.n && sA.mean > 0) {
          const deltaPct = (sB.mean - sA.mean) / sA.mean * 100;
          const absDays  = Math.abs(sB.mean - sA.mean);
          const absPct   = Math.abs(deltaPct);
          let bandCol, sentence;
          if (deltaPct > 15)      { bandCol = '#EF4444'; sentence = 'Processing time up ' + absDays.toFixed(1) + 'd · ' + absPct.toFixed(0) + '% increase'; }
          else if (deltaPct > 5)  { bandCol = '#FBBF24'; sentence = 'Processing time up ' + absDays.toFixed(1) + 'd · ' + absPct.toFixed(0) + '% increase'; }
          else if (deltaPct < -5) { bandCol = '#34D399'; sentence = 'Processing time down ' + absDays.toFixed(1) + 'd · ' + absPct.toFixed(0) + '% improvement'; }
          else                    { bandCol = '#1FCED8'; sentence = 'Stable · within ±' + absPct.toFixed(0) + '% YoY'; }

          ctx.fillStyle = bandCol; ctx.font = 'bold 10.5px "Rajdhani",sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(sentence, slotCenterX, padT - 8);

          const cxA = subCx(pi, yrNums.length - 2), cxB = subCx(pi, yrNums.length - 1);
          const midX = (cxA + cxB) / 2;
          const yA = yScale(Math.min(sA.mean, yMax)), yB = yScale(Math.min(sB.mean, yMax));
          const midY = (yA + yB) / 2, triH = 22, triW = 22;
          ctx.fillStyle = bandCol; ctx.beginPath();
          if (deltaPct > 5)       { ctx.moveTo(midX, midY - triH / 2); ctx.lineTo(midX - triW / 2, midY + triH / 2); ctx.lineTo(midX + triW / 2, midY + triH / 2); ctx.closePath(); }
          else if (deltaPct < -5) { ctx.moveTo(midX, midY + triH / 2); ctx.lineTo(midX - triW / 2, midY - triH / 2); ctx.lineTo(midX + triW / 2, midY - triH / 2); ctx.closePath(); }
          else                    { ctx.arc(midX, midY, triW / 2.2, 0, Math.PI * 2); }
          ctx.fill();
          ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(8,12,20,.7)'; ctx.stroke();

          const lbl = (deltaPct > 0 ? '+' : '') + deltaPct.toFixed(0) + '%';
          ctx.textAlign = 'center'; ctx.font = 'bold 11px "JetBrains Mono",monospace';
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,12,20,.85)'; ctx.strokeText(lbl, midX, midY + triH / 2 + 13);
          ctx.fillStyle = bandCol; ctx.fillText(lbl, midX, midY + triH / 2 + 13);
        }
      }

      // Phase code + plain-English label below the year pair.
      ctx.fillStyle = '#D6DFDE'; ctx.textAlign = 'center'; ctx.font = 'bold 12px "Rajdhani",sans-serif';
      ctx.fillText(ph, slotCenterX, H - padB + 28);
      ctx.font = '9px "JetBrains Mono",monospace'; ctx.fillStyle = 'rgba(240,244,243,.45)';
      ctx.fillText(pLabels[ph], slotCenterX, H - padB + 42);
    });
  }

  function renderYoYInMultiPanel(){
    return `
      <div class="view-empty">
        <div class="view-empty-lab">Mode mismatch</div>
        <h3>Year-on-Year renders one material at a time</h3>
        <p>You're in <b>Multi-material</b> scope. The Year-on-Year view compares one material's phase durations across years; switch to <b>Single material</b> on the rail to load it.</p>
      </div>`;
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

    // APP-V03-PORT-2 — counts now reflect the active set (year filter +
    // manual exclude + sigma trim applied). Raw count stays available
    // for the toolbar "X of Y" readout below.
    const act      = active(state.chains, material);
    const complete = act.filter(c => c.state === 'COMPLETE');
    const inFlight = act.filter(c => c.state === 'IN_FLIGHT' || c.state === 'NOT_YET_CONSUMED');
    const prOnly   = act.filter(c => c.state === 'PR_ONLY');
    const cancelled= act.filter(c => c.state === 'CANCELLED');
    // APP-V03-PORT-1 (2026-05-24) — reporting-only count of chains where the PR
    // was deletion-flagged AFTER a PO was raised. Per the operator PR/PO rule
    // these chains classify by the phase they actually reached (IN_FLIGHT /
    // NOT_YET_CONSUMED / COMPLETE) and the admin-cancel flag is informational.
    const adminCancel = act.filter(c => c.adminCancelled).length;
    const avgLT    = complete.length
      ? Math.round(complete.reduce((s, c) => s + c.total, 0) / complete.length)
      : null;
    const manualPR = act.filter(c => c.creationIndicator === 'R').length;

    // APP-V03-PORT-3 (2026-05-24) — Funnel arithmetic. v0.3 panel
    // (lines 803–850) reborn dynamically from the corrected state machine.
    //   PR Generated  = active total
    //   Cancelled     = state === 'CANCELLED' (PR with no PO — operator-rule)
    //   PR Only       = state === 'PR_ONLY' (still in process — no PO yet)
    //   Progressed    = has PO (i.e. NOT cancelled and NOT pr-only)
    //   Delivered     = has siteWH (i.e. IN_FLIGHT progressed past site,
    //                   plus NOT_YET_CONSUMED + COMPLETE)
    const progressed   = act.filter(c => !!c.po && c.state !== 'CANCELLED');
    const delivered    = act.filter(c => !!c.siteWH);
    const sumQty = (arr) => arr.reduce((s, c) => s + (c.qty || 0), 0);
    const funnel = {
      generated: { count: act.length,           units: sumQty(act),         label: 'PR Generated',          glyph: '◯' },
      cancelled: { count: cancelled.length,     units: sumQty(cancelled),   label: 'Cancelled (no PO)',     glyph: '✕' },
      prOnly:    { count: prOnly.length,        units: sumQty(prOnly),      label: 'PR raised · open',      glyph: '◐' },
      progressed:{ count: progressed.length,    units: sumQty(progressed),  label: 'Progressed to PO',      glyph: '⇒' },
      delivered: { count: delivered.length,     units: sumQty(delivered),   label: 'Delivered to WH',       glyph: '✓' }
    };
    const fmtN = n => n.toLocaleString();
    const pct  = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

    // Build the funnel HTML — vertical cascade, tinted per tier, each tile
    // animates a count-up the first render via CSS keyframes.
    const funnelHtml = `
      <div class="pchain-funnel" data-anim="1">
        <div class="pf-hdr"><span class="pf-hdr-lab">Procurement Flow</span><span class="pf-hdr-sub">${fmtN(funnel.generated.count)} PRs · ${fmtN(funnel.generated.units)} units</span></div>
        <div class="pf-tier pf-tier-root">
          <div class="pf-glyph">${funnel.generated.glyph}</div>
          <div class="pf-body">
            <div class="pf-row1"><span class="pf-lab">${funnel.generated.label}</span><span class="pf-count">${fmtN(funnel.generated.count)}</span></div>
            <div class="pf-row2"><span class="pf-units">${fmtN(funnel.generated.units)} units requested</span></div>
          </div>
        </div>
        <div class="pf-branches">
          ${funnel.cancelled.count > 0 ? `
            <div class="pf-tier pf-tier-cancel">
              <div class="pf-conn">├─</div>
              <div class="pf-glyph">${funnel.cancelled.glyph}</div>
              <div class="pf-body">
                <div class="pf-row1"><span class="pf-lab">${funnel.cancelled.label}</span><span class="pf-count">${fmtN(funnel.cancelled.count)}</span><span class="pf-pct">${pct(funnel.cancelled.count, funnel.generated.count)}% of PRs</span></div>
                <div class="pf-row2"><span class="pf-units">${fmtN(funnel.cancelled.units)} units</span><span class="pf-upct">${pct(funnel.cancelled.units, funnel.generated.units)}% of requested</span></div>
                <div class="pf-bar"><div class="pf-bar-fill" style="width:${pct(funnel.cancelled.count, funnel.generated.count)}%"></div></div>
              </div>
            </div>
          ` : ''}
          ${funnel.prOnly.count > 0 ? `
            <div class="pf-tier pf-tier-pronly">
              <div class="pf-conn">├─</div>
              <div class="pf-glyph">${funnel.prOnly.glyph}</div>
              <div class="pf-body">
                <div class="pf-row1"><span class="pf-lab">${funnel.prOnly.label}</span><span class="pf-count">${fmtN(funnel.prOnly.count)}</span><span class="pf-pct">${pct(funnel.prOnly.count, funnel.generated.count)}% of PRs</span></div>
                <div class="pf-row2"><span class="pf-units">${fmtN(funnel.prOnly.units)} units</span><span class="pf-note" title="PR raised, deletion-flag not set, no PO yet. Per the operator PR/PO rule these are treated as in-process — they may or may not progress to PO.">in process</span></div>
                <div class="pf-bar"><div class="pf-bar-fill" style="width:${pct(funnel.prOnly.count, funnel.generated.count)}%"></div></div>
              </div>
            </div>
          ` : ''}
          <div class="pf-tier pf-tier-po">
            <div class="pf-conn">└─</div>
            <div class="pf-glyph">${funnel.progressed.glyph}</div>
            <div class="pf-body">
              <div class="pf-row1"><span class="pf-lab">${funnel.progressed.label}</span><span class="pf-count">${fmtN(funnel.progressed.count)}</span><span class="pf-pct">${pct(funnel.progressed.count, funnel.generated.count)}% of PRs</span></div>
              <div class="pf-row2"><span class="pf-units">${fmtN(funnel.progressed.units)} units</span><span class="pf-upct">${pct(funnel.progressed.units, funnel.generated.units)}% of requested</span>${adminCancel ? `<span class="pf-note pf-admin" title="PRs deletion-flagged AFTER PO raised — admin meaning only, classified by phase reached per the PR/PO rule.">+${adminCancel} admin-cancel</span>` : ''}</div>
              <div class="pf-bar"><div class="pf-bar-fill" style="width:${pct(funnel.progressed.count, funnel.generated.count)}%"></div></div>
            </div>
          </div>
          ${funnel.progressed.count > 0 ? `
            <div class="pf-tier pf-tier-deliv pf-indent">
              <div class="pf-conn">└─</div>
              <div class="pf-glyph">${funnel.delivered.glyph}</div>
              <div class="pf-body">
                <div class="pf-row1"><span class="pf-lab">${funnel.delivered.label}</span><span class="pf-count">${fmtN(funnel.delivered.count)}</span><span class="pf-pct">${pct(funnel.delivered.count, funnel.progressed.count)}% of POs</span></div>
                <div class="pf-row2"><span class="pf-units">${fmtN(funnel.delivered.units)} units${funnel.delivered.units > funnel.progressed.units ? ' (overship)' : ''}</span><span class="pf-upct">${pct(funnel.delivered.units, funnel.progressed.units)}% of ordered</span></div>
                <div class="pf-bar"><div class="pf-bar-fill" style="width:${pct(funnel.delivered.count, funnel.progressed.count)}%"></div></div>
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    // POST-T-04 PATCH (2026-05-17) — operator finding: chains all show "in-
    // flight" or "cancelled" on materials they're investigating. Surface the
    // honest data-source story instead of letting them guess. Only renders
    // when there are chains but none are complete — never-hide-issues.
    const diagnostic = (state.chains.length > 0 && complete.length === 0)
      ? renderZeroCompleteDiagnostic(material, inFlight.length, prOnly.length, cancelled.length)
      : '';

    // APP-V03-PORT-2 — filter toolbar markup. Year buttons derived from
    // the chain set's actual prDate years; sigma buttons fixed at v0.3's
    // four levels; manual-exclude chip + reset visible only when there's
    // something to clear.
    const years = getYearsForChains(state.chains);
    const manualSet = getManualExcl(material);
    const sigmaSet  = sigmaExcl(state.chains);
    const totalExcl = manualSet.size + sigmaSet.size;
    const yearBtns = ['All'].concat(years).map(y =>
      `<button class="tr-fbtn ${state.yearFilter === y ? 'active' : ''}" data-filter="year" data-val="${y}">${y === 'All' ? 'All years' : y}</button>`
    ).join('');
    const sigmaBtns = [
      { v: 'null', lab: 'Off',          title: 'No sigma trim — show every chain' },
      { v: '3',    lab: 'Loose 3σ',     title: 'Drop chains slower than mean + 3·sd of total LT' },
      { v: '2',    lab: 'Standard 2σ',  title: 'Drop chains slower than mean + 2·sd of total LT' },
      { v: '1.5',  lab: 'Tight 1.5σ',   title: 'Drop chains slower than mean + 1.5·sd of total LT' }
    ].map(s => {
      const isActive = (s.v === 'null' && state.sigmaLimit === null) || (state.sigmaLimit !== null && Number(s.v) === state.sigmaLimit);
      return `<button class="tr-fbtn ${isActive ? 'active' : ''}" data-filter="sigma" data-val="${s.v}" title="${s.title}">${s.lab}</button>`;
    }).join('');
    const exclChipHtml = totalExcl
      ? `<span class="tr-excl-chip" title="Manually excluded: ${manualSet.size}. Sigma-trimmed: ${sigmaSet.size}. Use Raw Data view to toggle manual excludes per chain.">${totalExcl} excluded</span>`
      : '';
    const resetBtnHtml = manualSet.size
      ? `<button class="tr-fbtn tr-reset" data-filter="reset-manual" title="Clear manual excludes for this material">Reset manual</button>`
      : '';
    const filterToolbar = `
      <div class="tr-filterbar" id="traceFilterBar">
        <span class="tr-flbl">Year</span>${yearBtns}
        <span class="tr-fsep"></span>
        <span class="tr-flbl">Sigma trim</span>${sigmaBtns}
        ${exclChipHtml}
        ${resetBtnHtml}
      </div>
    `;

    host.innerHTML = `
      ${filterToolbar}

      <div class="pchain-layout">
        <div class="pc-main">
          <div class="chart-toolbar">
            <span class="chart-toolbar-lab" id="chainCount">${act.length} of ${state.chains.length} chain${state.chains.length === 1 ? '' : 's'} · ${delivered.length} delivered · ${progressed.length} progressed${totalExcl ? ` · ${totalExcl} excluded` : ''}</span>
          </div>
          <div class="chart-host">
            <canvas id="swimChart"></canvas>
          </div>
        </div>

        <aside class="pc-side">
          ${funnelHtml}

          <div class="pchain-stats">
            <div class="ps-cell"><span class="lab">Complete chains</span><span class="v">${complete.length}</span></div>
            <div class="ps-cell"><span class="lab">In-flight</span><span class="v">${inFlight.length}</span></div>
            <div class="ps-cell"><span class="lab">Avg total LT</span><span class="v">${avgLT != null ? avgLT + 'd' : '—'}</span></div>
            <div class="ps-cell"><span class="lab">Manual PRs</span><span class="v ${manualPR ? 'warn' : ''}">${manualPR}</span></div>
            ${adminCancel ? `<div class="ps-cell"><span class="lab">Admin-cancel</span><span class="v" title="Subset of Progressed: PR deletion-flagged AFTER the PO landed. Per the PR/PO rule, classified by phase reached, not as cancelled.">${adminCancel}</span></div>` : ''}
          </div>

          ${diagnostic}
        </aside>
      </div>

      <div class="chart-caveat">Phases A–E computed from PR History + MB51 join on Purchase Order. Phase E (Time to First Use) measured to the first consumption transaction for this material after Site WH receipt — not necessarily of this PO's units specifically. <b>Cancelled-before-PO PRs are excluded from the swimlane</b> — see Raw Data view for the full list. Per the PR/PO classification rule, a PR cancelled <em>after</em> a PO landed renders in its actual phase colour, not red — the post-PO deletion has admin meaning only.</div>
    `;

    bindFilterBar(material);
    renderSwimlane(material);
  }

  // APP-V03-PORT-2 — filter toolbar handlers. Each button dispatches a
  // state mutation and re-renders the Procurement Chain view in place.
  function bindFilterBar(material){
    const bar = $('#traceFilterBar');
    if (!bar) return;
    bar.querySelectorAll('.tr-fbtn').forEach(btn => {
      btn.addEventListener('click', () => {
        const f   = btn.dataset.filter;
        const val = btn.dataset.val;
        if (f === 'year') {
          state.yearFilter = val;
        } else if (f === 'sigma') {
          state.sigmaLimit = (val === 'null') ? null : Number(val);
        } else if (f === 'reset-manual') {
          clearManualExcl(material);
        }
        persistState();
        // Re-render whichever view is active. #contentView is the shared host.
        if (state.chart) { state.chart.destroy(); state.chart = null; }
        const host = $('#contentView');
        if (!host) return;
        if      (state.activeView === 'phase-distribution') renderPhaseDistribution(host, material);
        else if (state.activeView === 'volume')             renderVolume(host, material);
        else if (state.activeView === 'raw-data')           renderRawData(host, material);
        else                                                renderProcurementChain(host, material);
      });
    });
  }

  // APP-SCR-01 (2026-06-25) — chain compute extracted to shared/trace-phase.js
  // (TracePhase.computeChains, with `json` passed as an argument). This thin
  // wrapper keeps every existing call site (Procurement Chain / Raw Data /
  // Volume / Phase Distribution) unchanged while the logic lives in one place
  // shared with the Screener.
  function computeChainsForMaterial(material){
    return TracePhase.computeChains(state.json, material);
  }

  /* ─── APP-V03-PORT-2 (2026-05-24) · Filter machinery ────────────────────
     Ports v0.3's active() / allExcl() / sigmaExcl() triplet (v0.3:1325–1340)
     to operate on v0.4's per-material chain set. Key differences from v0.3:
       · v0.3 had a hardcoded CHAINS array with an `idx` field; v0.4 uses
         the PR number as the chain identity (unique per material).
       · v0.3 had `c.yr` pre-computed; v0.4 derives year from prDate string.
       · v0.4's manualExcl is per-material (state.manualExclByMat) since one
         material's noise chains don't apply to another. v0.3 was single-
         material so the global set was fine.
       · Sigma calculation only considers chains with a non-null `total`
         (i.e. those rendered on the swimlane after the siteWH gate) —
         "trim outliers on the chart" is the operator's mental model. */

  function getChainYear(c){
    return (c.prDate || '').substring(0, 4);   // ISO 'YYYY-MM-DD' → 'YYYY'
  }

  function getYearsForChains(chains){
    const yrs = new Set();
    for (const c of chains) { const y = getChainYear(c); if (y) yrs.add(y); }
    return [...yrs].sort();
  }

  function getManualExcl(material){
    if (!material) return new Set();
    if (!state.manualExclByMat.has(material)) {
      state.manualExclByMat.set(material, new Set());
    }
    return state.manualExclByMat.get(material);
  }

  function sigmaExcl(chains){
    // Returns Set<pr> of chains classified as statistical outliers on
    // `chain.total`. Pre-restricts to year-filtered chains AND chains with
    // a non-null total (siteWH-gated) so the threshold reflects what the
    // operator can see on the swimlane.
    if (!state.sigmaLimit) return new Set();
    const inYear = chains.filter(c => state.yearFilter === 'All' || getChainYear(c) === state.yearFilter);
    const drawn  = inYear.filter(c => !!c.siteWH);
    if (drawn.length < 2) return new Set();
    const totals = drawn.map(c => c.total);
    const n      = totals.length;
    const mean   = totals.reduce((s, v) => s + v, 0) / n;
    const sd     = Math.sqrt(totals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1));
    const threshold = mean + state.sigmaLimit * sd;
    const excl = new Set();
    drawn.forEach(c => { if (c.total > threshold) excl.add(c.pr); });
    return excl;
  }

  function allExcl(chains, material){
    return new Set([...getManualExcl(material), ...sigmaExcl(chains)]);
  }

  function active(chains, material){
    const ex = allExcl(chains, material);
    return chains.filter(c =>
      (state.yearFilter === 'All' || getChainYear(c) === state.yearFilter)
      && !ex.has(c.pr)
    );
  }

  function isExcluded(chain, material){
    return allExcl(state.chains, material).has(chain.pr);
  }

  function clearManualExcl(material){
    if (material && state.manualExclByMat.has(material)) {
      state.manualExclByMat.get(material).clear();
    }
  }

  function toggleManualExcl(material, pr){
    const set = getManualExcl(material);
    if (set.has(pr)) set.delete(pr); else set.add(pr);
  }

  function renderSwimlane(material){
    // APP-FIX-T-04c (2026-05-17) — tightened from `!!c.po` to `!!c.siteWH`
    // per operator review against v0.3. v0.3 deliberately excluded in-flight
    // chains (PO raised, Site WH not yet posted) from CHAINS: phase C/D/E
    // are null and the partial bar clutters the distribution stats. They
    // still appear on Raw Data view + cancellation diagnostic / progression
    // panels in v0.3, but NOT on the swimlane itself. Chains with PO but no
    // Site WH drop out here; they stay visible in the Raw Data tab.
    //
    // APP-FIX-SWIM-GHOST (2026-05-24) — operator finding: when I exclude a
    // chain, I still want to see it, but ghost-dulled. So the swimlane
    // renders ALL siteWH-gated chains in the year-filtered set; excluded
    // chains (manual + sigma) stay visible but tinted very low alpha and
    // their y-axis label dims. The funnel + stats + Phase Distribution math
    // still respect active() — exclusion still removes the chain from
    // counts and analytics, it just doesn't drop the bar visually.
    // (Matches v0.3 lines 1454/1466 — excluded chains rendered with tinted
    // colour, not dropped.)
    const mat = material || state.scopeSingle;
    const yearFiltered = state.chains.filter(c =>
      state.yearFilter === 'All' || getChainYear(c) === state.yearFilter
    );
    const drawn = yearFiltered.filter(c => !!c.siteWH);
    const exclSet = allExcl(state.chains, mat);
    const isExcl = (c) => exclSet.has(c.pr);
    const labels = drawn.map(c => `${c.pr}${c.po ? ' → ' + c.po : ''}`);

    // Colour helpers — fold the cancelled / excluded / normal logic into
    // one place so background and border stay in sync.
    const bgFor = (c, i) => {
      if (c.state === 'CANCELLED') return isExcl(c) ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.18)';
      if (isExcl(c))               return PHASE_COLORS[i] + '1A';   // ~10% alpha — ghost
      return PHASE_COLORS[i] + 'CC';                                // ~80% — normal
    };
    const bdFor = (c, i) => {
      if (c.state === 'CANCELLED') return isExcl(c) ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.4)';
      if (isExcl(c))               return PHASE_COLORS[i] + '40';   // ~25% — soft border
      return PHASE_COLORS[i];
    };

    const datasets = PHASE_KEYS.map((ph, i) => ({
      label: PHASE_LABELS[ph],
      data:  drawn.map(c => c[ph] || 0),
      // APP-V03-PORT-1 (2026-05-24) — red-tint only true CANCELLED (PR with no PO).
      // adminCancelled (PR cancelled AFTER PO raised) renders in normal phase
      // colour per the operator-locked PR/PO rule — admin meaning only.
      // APP-FIX-SWIM-GHOST (2026-05-24) — excluded chains drop to ~10% alpha.
      backgroundColor: drawn.map(c => bgFor(c, i)),
      borderColor:     drawn.map(c => bdFor(c, i)),
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
          y: { stacked: true, grid: { display: false }, ticks: {
            // APP-FIX-SWIM-GHOST — dim the y-axis label for excluded chains
            // so the ghost rendering reads consistently with the bar tint.
            color: (ctx) => {
              const c = drawn[ctx.index];
              if (c && isExcl(c)) return 'rgba(214,223,222,0.40)';
              return '#D6DFDE';
            },
            font: { family: 'JetBrains Mono', size: 10 }
          } }
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
                const lines = [
                  '─────────',
                  `Total LT: ${c.total}d`,
                  `Qty: ${c.qty} (${c.qtySource})`,
                  `Source: ${c.creationIndicator === 'R' ? 'MANUAL PR' : 'MRP-generated'}`,
                  `State: ${c.state}`
                ];
                // APP-FIX-SWIM-GHOST — surface exclusion status in the tooltip
                if (isExcl(c)) {
                  const manualSet = getManualExcl(mat);
                  const sigSet    = sigmaExcl(state.chains);
                  const how = manualSet.has(c.pr)
                    ? 'manual'
                    : sigSet.has(c.pr) ? `sigma-trim (${state.sigmaLimit}σ)` : 'excluded';
                  lines.push(`Excluded: ${how}`);
                }
                return lines;
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

    // APP-V03-PORT-2a (2026-05-24) — right-click context menu on swimlane bars
    // for direct exclude/include. v0.3 line 1537–1539 had the same pattern;
    // mobile-friendly fallback stays in the Raw Data per-row toggle.
    canvas.addEventListener('contextmenu', (e) => {
      const points = state.chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
      if (!points.length) return;   // empty space → let the browser show its menu
      e.preventDefault();
      const chain = drawn[points[0].index];
      if (!chain) return;
      showChainContextMenu(e.clientX, e.clientY, chain, mat);
    });
  }

  // APP-V03-PORT-2a — context menu DOM + handlers
  function showChainContextMenu(x, y, chain, material){
    hideChainContextMenu();
    const manual = getManualExcl(material);
    const sigmaSet = sigmaExcl(state.chains);
    const isManual = manual.has(chain.pr);
    const isSigma  = sigmaSet.has(chain.pr);
    const menu = document.createElement('div');
    menu.id = 'traceChainMenu';
    menu.className = 'tr-ctx-menu';
    menu.innerHTML = `
      <div class="tr-ctx-hdr">PR ${escapeHtml(chain.pr)}${chain.po ? ' · PO ' + escapeHtml(chain.po) : ''}</div>
      <div class="tr-ctx-sub">${chain.state.replace(/_/g, ' ')}${chain.adminCancelled ? ' · admin-cancel' : ''} · ${chain.total || '—'}d total LT</div>
      ${isManual
        ? '<button class="tr-ctx-item" data-action="include">Include this chain</button>'
        : '<button class="tr-ctx-item" data-action="exclude">Exclude this chain</button>'}
      ${isSigma && !isManual ? '<div class="tr-ctx-note">Currently sigma-trimmed. Adjust via toolbar to keep / drop.</div>' : ''}
      <div class="tr-ctx-sep"></div>
      <button class="tr-ctx-item ghost" data-action="raw-data">Show in Raw Data view…</button>
    `;
    // Anchor at cursor, clamp to viewport so the menu never overflows
    document.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const vx = Math.min(x, window.innerWidth  - w - 8);
    const vy = Math.min(y, window.innerHeight - h - 8);
    menu.style.left = vx + 'px';
    menu.style.top  = vy + 'px';

    menu.addEventListener('click', (ev) => {
      const action = ev.target?.dataset?.action;
      if (!action) return;
      if (action === 'exclude' || action === 'include') {
        toggleManualExcl(material, chain.pr);
        persistState();
        const host = $('#contentView');
        if (host) renderProcurementChain(host, material);
      } else if (action === 'raw-data') {
        state.activeView = 'raw-data';
        persistState();
        renderRail();      // re-paint view list active state
        renderActiveView();
      }
      hideChainContextMenu();
    });
    // Click-away + Esc dismissal
    setTimeout(() => {
      document.addEventListener('click', hideChainContextMenu, { once: true });
      document.addEventListener('keydown', escDismiss);
    }, 0);
  }
  function hideChainContextMenu(){
    const m = document.getElementById('traceChainMenu');
    if (m) m.remove();
    document.removeEventListener('keydown', escDismiss);
  }
  function escDismiss(e){
    if (e.key === 'Escape') hideChainContextMenu();
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
    // APP-V03-PORT-1 (2026-05-24) — row tint follows STATE, not raw cancellation
    // flag. adminCancelled chains (PR cancel-flag set AFTER PO raised) keep
    // their phase state's tint and get a small annotation in the State column.
    // APP-V03-PORT-2 (2026-05-24) — per-row exclude/include toggle. Manual
    // excludes click-toggle from the table; sigma-excluded rows display a
    // greyed σ glyph (toggle via the sigma button in the toolbar).
    const mat = state._rawDataMaterial || state.scopeSingle;
    const manualSet = getManualExcl(mat);
    const sigmaSet  = sigmaExcl(state.chains);
    const rows = state.chains.map(c => {
      const isManual = manualSet.has(c.pr);
      const isSigma  = sigmaSet.has(c.pr);
      const excluded = isManual || isSigma;
      const trCls    = [
        c.state === 'CANCELLED' ? 'cancelled' : '',
        excluded ? 'excluded' : ''
      ].filter(Boolean).join(' ');
      const togBtn = isSigma
        ? `<span class="tr-excl-tog sigma" title="Sigma-trimmed (mean + ${state.sigmaLimit}σ on total LT). Adjust via toolbar.">σ</span>`
        : `<button class="tr-excl-tog ${isManual ? 'on' : ''}" data-toggle-excl="${escapeAttr(c.pr)}" data-sigma="0" title="${isManual ? 'Click to include this chain in stats / chart' : 'Click to exclude this chain from stats / chart'}">${isManual ? '✕' : '·'}</button>`;
      const stateLabel = excluded
        ? `<span class="state-excluded" title="Excluded: ${isSigma ? 'sigma-trim' : 'manual'}">EXCL · ${c.state.replace(/_/g, ' ')}</span>`
        : c.state.replace(/_/g, ' ');
      return `
        <tr class="${trCls}">
          <td class="tog-cell">${togBtn}</td>
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
          <td class="state state-${c.state.toLowerCase()}">${stateLabel}${c.adminCancelled ? ' <span class="state-admin-cancel" title="PR deletion-flagged after PO raised — admin meaning only; does not affect classification">(admin cancel)</span>' : ''}</td>
        </tr>
      `;
    }).join('');
    $('#chainTableBody').innerHTML = rows || `<tr><td colspan="16" class="empty">no chains for this material</td></tr>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */

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
