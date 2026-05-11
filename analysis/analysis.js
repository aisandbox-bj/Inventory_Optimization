/* ═══════════════════════════════════════════════════════════════════════════
   Analysis engine page — UI wiring.
   Depends on: AppStorage, AppPipeline, AppChart, AppLlm, AppExcel, ExcelJS (CDN).
═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $  = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

  const state = {
    json:            null,       // canonical JSON loaded from storage
    result:          null,       // pipeline result
    selectedBucket:  null,       // bucket key
    selectedMaterial:null,       // material no
    filterTl:        'ALL',
    sortKey:         'totalNet',
    sortDir:         'desc',
    searchText:      '',
    llmInflight:     false,
    llmByMaterial:   {}          // material → { verdict, notes, suggestedEdits, raw }
  };

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */
  async function boot(){
    const json = await AppStorage.get('intake.current');
    if (!json) {
      renderEmpty();
      return;
    }
    state.json = json;
    renderLoadedBanner();
    await runPipelineNow();
    bindGlobalKeys();
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
      </section>
    `;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BANNER
  ═════════════════════════════════════════════════════════════════════════ */
  function renderLoadedBanner(){
    const j = state.json;
    const scopeDetail = describeScope(j);
    const counts = countRows(j);
    $('#banner').innerHTML = `
      <div>
        <span class="lab">Loaded intake</span>
        <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
        <div class="sub">${escapeHtml(scopeDetail)} · created ${escapeHtml((j.metadata.createdAt || '').replace('T', ' ').slice(0, 16))}</div>
      </div>
      <div class="row">
        <span class="lab">Parameters</span>
        <span class="v">P1 ${j.parameters.p1Start} → ${j.parameters.p1End}</span>
        <span class="v">P2 ${j.parameters.p2Months} mo rolling</span>
        <span class="v">min ${j.parameters.minMonths} / max ${j.parameters.maxMonths} mo · threshold ${j.parameters.threshold}</span>
      </div>
      <div class="row">
        <span class="lab">Source data</span>
        <span class="v">${(counts.mb51 || 0).toLocaleString()} MB51 · ${(counts.iw39 || 0).toLocaleString()} IW39</span>
        <span class="v">${(counts.fleetMaster || 0).toLocaleString()} fleet · ${(counts.inventoryMaster || 0).toLocaleString()} master</span>
        <span class="v">DQ: ${j.validation?.passed ? 'passed' : `${(j.validation?.issues || []).length} issue${(j.validation?.issues || []).length === 1 ? '' : 's'}`}</span>
      </div>
    `;
  }

  function countRows(j){
    const out = {};
    for (const k of Object.keys(j.data || {})) out[k] = (j.data[k] || []).length;
    return out;
  }
  function describeScope(j){
    const m = j.scope.mode;
    if (m === 'fleet')              return `Fleet · ${(j.scope.fleet?.models || []).join(' / ') || '—'}`;
    if (m === 'manual')             return `Manual · ${(j.scope.manual?.materials || []).length} materials`;
    if (m === 'byClassification') {
      const f = j.scope.byClassification;
      const bits = [];
      if (f.inventoryTypes?.length) bits.push(`type: ${f.inventoryTypes.join('/')}`);
      if (f.mrpClassifiers?.length) bits.push(`MRP: ${f.mrpClassifiers.join('/')}`);
      if (f.movementAmount?.min != null || f.movementAmount?.max != null) {
        bits.push(`mvmt: ${f.movementAmount.min ?? '—'} … ${f.movementAmount.max ?? '—'}`);
      }
      return `By classification · ${bits.join(' · ') || '—'}`;
    }
    if (m === 'byVendor')           return `By vendor · ${(j.scope.byVendor?.vendors || []).length} vendors`;
    return m;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     PIPELINE
  ═════════════════════════════════════════════════════════════════════════ */
  async function runPipelineNow(){
    const status = $('#pipelineStatus');
    status.querySelector('.meta').textContent = 'running…';
    // Defer so the UI repaints
    await new Promise(r => setTimeout(r, 30));
    try {
      const t0 = performance.now();
      state.result = AppPipeline.runPipeline(state.json, { runDate: new Date().toISOString().slice(0, 10) });
      const t1 = performance.now();
      status.querySelector('.meta').textContent = `${state.result.summary.total} materials across ${state.result.buckets.length} bucket${state.result.buckets.length === 1 ? '' : 's'} · ${Math.round(t1 - t0)} ms`;
      renderSummaryTiles();
      renderBucketTabs();
      if (state.result.buckets.length) selectBucket(state.result.buckets[0].key);
      renderExportActions();
    } catch (e) {
      console.error(e);
      status.querySelector('.meta').innerHTML = `<span class="crit">error: ${escapeHtml(e.message || String(e))}</span>`;
    }
  }

  function renderSummaryTiles(){
    const sum = state.result.summary;
    const tiles = ['GREEN','BLUE','ORANGE','RED','GREY'].map(k => `
      <div class="tl-tile ${k}" data-tl="${k}">
        <span class="name">${k}</span>
        <div class="v">${sum[k] || 0}</div>
      </div>`).join('');
    $('#tlTiles').innerHTML = tiles;
    $$('#tlTiles .tl-tile').forEach(t => {
      t.addEventListener('click', () => {
        const tl = t.dataset.tl;
        state.filterTl = state.filterTl === tl ? 'ALL' : tl;
        renderList();
        renderFilterButtons();
      });
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BUCKET TABS
  ═════════════════════════════════════════════════════════════════════════ */
  function renderBucketTabs(){
    const host = $('#bucketTabs');
    host.innerHTML = '';
    for (const b of state.result.buckets) {
      const tab = document.createElement('button');
      tab.className = 'bucket-tab' + (b.kind === 'multi' ? ' multi' : '');
      tab.dataset.bucket = b.key;
      tab.innerHTML = `${escapeHtml(b.name)}<span class="badge">${b.materials.length}</span>`;
      tab.addEventListener('click', () => selectBucket(b.key));
      host.appendChild(tab);
    }
  }

  function selectBucket(key){
    state.selectedBucket = key;
    state.selectedMaterial = null;
    state.filterTl = 'ALL';
    state.searchText = '';
    $$('#bucketTabs .bucket-tab').forEach(t => t.classList.toggle('active', t.dataset.bucket === key));
    renderList();
    renderDetail();
    renderFilterButtons();
  }

  function currentBucket(){
    return state.result.buckets.find(b => b.key === state.selectedBucket);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL LIST
  ═════════════════════════════════════════════════════════════════════════ */
  function renderFilterButtons(){
    const host = $('#tlFilter');
    const labels = ['ALL','GREEN','BLUE','ORANGE','RED','GREY'];
    host.innerHTML = labels.map(l => `<button data-tl="${l}" class="${state.filterTl === l ? 'active' : ''}">${l}</button>`).join('');
    $$('#tlFilter button').forEach(b => {
      b.addEventListener('click', () => { state.filterTl = b.dataset.tl; renderList(); renderFilterButtons(); });
    });
  }

  function renderList(){
    const bucket = currentBucket();
    if (!bucket) return;
    let rows = bucket.materials.slice();
    if (state.filterTl !== 'ALL') rows = rows.filter(m => m.trafficLight === state.filterTl);
    if (state.searchText) {
      const q = state.searchText.toLowerCase();
      rows = rows.filter(m => (m.material || '').toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q));
    }
    const k = state.sortKey, dir = state.sortDir;
    rows.sort((a, b) => {
      let av = a[k], bv = b[k];
      if (av == null) av = (typeof bv === 'number') ? -Infinity : '';
      if (bv == null) bv = (typeof av === 'number') ? -Infinity : '';
      if (typeof av === 'number' && typeof bv === 'number') return dir === 'asc' ? av - bv : bv - av;
      return dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });

    const tbl = $('#listTableWrap');
    if (rows.length === 0) {
      tbl.innerHTML = `<div class="list-empty">no materials match the current filter</div>`;
      return;
    }
    const cols = [
      { k:'trafficLight', l:'TL',    type:'tl'   },
      { k:'material',     l:'Material', type:'mat' },
      { k:'description',  l:'Description', type:'desc' },
      { k:'totalNet',     l:'Total', type:'num'  },
      { k:'p2Rate',       l:'P2/mo', type:'num'  },
      { k:'recMin',       l:'Rec Min', type:'num' },
      { k:'recMax',       l:'Rec Max', type:'num' },
      { k:'pattern',      l:'Pattern', type:'pat' }
    ];
    const thead = cols.map(c => {
      const sorted = state.sortKey === c.k ? `sorted ${state.sortDir === 'asc' ? 'asc' : ''}` : '';
      return `<th class="sortable ${sorted}" data-k="${c.k}">${c.l}</th>`;
    }).join('');
    const tbody = rows.map(m => `
      <tr data-material="${escapeAttr(m.material)}" class="${state.selectedMaterial === m.material ? 'selected' : ''}">
        <td><span class="tl-dot ${m.trafficLight}"></span><span class="tl-label">${m.trafficLight}</span></td>
        <td class="mat">${escapeHtml(m.material)}</td>
        <td class="desc" title="${escapeAttr(m.description)}">${escapeHtml(m.description || '')}</td>
        <td class="num">${m.totalNet?.toLocaleString?.() ?? m.totalNet ?? '—'}</td>
        <td class="num">${m.p2Flag === 'OK' ? m.p2Rate.toFixed(1) : `<span class="amber">${m.p2Flag}</span>`}</td>
        <td class="num">${m.recMin ?? '—'}</td>
        <td class="num">${m.recMax ?? '—'}</td>
        <td class="num" style="color:${m.pattern === 'LUMPY' ? 'var(--status-warn)' : 'var(--text-muted)'}">${m.pattern}</td>
      </tr>`).join('');
    tbl.innerHTML = `<table class="list-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;

    $$('#listTableWrap th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = k; state.sortDir = 'desc'; }
        renderList();
      });
    });
    $$('#listTableWrap tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        state.selectedMaterial = tr.dataset.material;
        renderList();
        renderDetail();
      });
    });
  }

  function bindToolbar(){
    $('#listSearch').addEventListener('input', (e) => {
      state.searchText = e.target.value;
      renderList();
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL DETAIL
  ═════════════════════════════════════════════════════════════════════════ */
  function renderDetail(){
    const host = $('#materialDetail');
    const bucket = currentBucket();
    if (!bucket) {
      host.innerHTML = `<div class="detail-empty"><div class="big">No bucket selected</div></div>`;
      return;
    }
    const mat = bucket.materials.find(m => m.material === state.selectedMaterial);
    if (!mat) {
      host.innerHTML = `<div class="detail-empty"><div class="big">Select a material on the left</div>Pick any row to load the consumption chart, key stats, HCE events (if any), and run an LLM review.</div>`;
      return;
    }
    const rcDisp = mat.rateChange != null ? `${mat.rateChange}%` : 'N/A';
    const adjDisp = (mat.hceP2 && mat.hceP2.length)
                  ? (mat.adjP2Flag === 'OK' ? `${mat.adjP2Rate.toFixed(2)}` : `0 [${mat.adjP2Flag || 'NO_DATA'}]`)
                  : '—';

    const llmCfg = state.llmByMaterial[mat.material];

    host.innerHTML = `
      <div class="detail-head">
        <div>
          <div class="mat">${escapeHtml(mat.material)}</div>
          <div class="desc">${escapeHtml(mat.description || '')}</div>
        </div>
        <div class="spacer"></div>
        <span class="pill ${pillCls(mat.trafficLight)}"><span class="dot"></span>${mat.trafficLight}</span>
      </div>

      <div class="action-banner ${mat.trafficLight}">
        <span class="lab">Algorithmic recommendation</span>
        ${escapeHtml(mat.action)}
      </div>

      <div class="chart-host" id="chartHost"></div>

      <div class="stat-grid">
        <div class="stat-cell"><span class="lab">P1 rate</span><div class="v ${mat.p1Flag !== 'OK' ? 'warn' : ''}">${mat.p1Flag === 'OK' ? mat.p1Rate.toFixed(2) : '—'} <small>/ mo</small></div></div>
        <div class="stat-cell"><span class="lab">P2 rate</span><div class="v ${mat.p2Flag !== 'OK' ? 'warn' : ''}">${mat.p2Flag === 'OK' ? mat.p2Rate.toFixed(2) : '—'} <small>/ mo</small></div></div>
        <div class="stat-cell"><span class="lab">Adj P2 (HCE excl)</span><div class="v">${adjDisp} <small>${mat.hceP2 && mat.hceP2.length ? '/ mo' : ''}</small></div></div>
        <div class="stat-cell"><span class="lab">P1 → P2 change</span><div class="v ${(mat.rateChange||0) > 200 ? 'warn' : ''}">${rcDisp}</div></div>
        <div class="stat-cell"><span class="lab">Total (window)</span><div class="v">${mat.totalNet}</div></div>
        <div class="stat-cell"><span class="lab">Pattern</span><div class="v ${mat.pattern === 'LUMPY' ? 'warn' : ''}">${mat.pattern}</div></div>
        <div class="stat-cell"><span class="lab">Stock on hand</span><div class="v">${mat.stock ?? '—'}</div></div>
        <div class="stat-cell"><span class="lab">MRP type</span><div class="v">${escapeHtml(mat.mrpType || '—')}</div></div>
        <div class="stat-cell"><span class="lab">Current Min</span><div class="v">${mat.cmin ?? '—'}</div></div>
        <div class="stat-cell"><span class="lab">Current Max</span><div class="v">${mat.cmax ?? '—'}</div></div>
        <div class="stat-cell"><span class="lab">Rec Min</span><div class="v">${mat.recMin ?? '—'}</div></div>
        <div class="stat-cell"><span class="lab">Rec Max</span><div class="v">${mat.recMax ?? '—'}</div></div>
      </div>

      ${renderHceTable(mat)}

      <div class="actions-row">
        <button id="btnLlm" class="primary" ${state.llmInflight ? 'disabled' : ''}>${llmCfg ? '↻ Re-run LLM review' : '✦ Run LLM review'}</button>
        <span id="llmStatus"></span>
      </div>
      ${llmCfg ? renderLlmPanel(llmCfg) : ''}
    `;

    // Render chart
    AppChart.render($('#chartHost'), mat, { width: 720, height: 320 });

    // Bind LLM
    $('#btnLlm').addEventListener('click', () => runLlmReview(mat));
  }

  function renderHceTable(mat){
    const evs = [...(mat.hceP1 || []), ...(mat.hceP2 || [])];
    if (evs.length === 0) return '';
    const rows = evs.map(e => `
      <tr class="${(e.period || '').toLowerCase().includes('p2') ? 'p2' : 'p1'}">
        <td>${escapeHtml(e.period)}</td>
        <td>${escapeHtml(e.order)}</td>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.equipment || '—')}</td>
        <td title="${escapeAttr(e.description)}">${escapeHtml((e.description || '').slice(0, 36))}</td>
        <td class="q">${e.qty}</td>
        <td class="q">${e.pct}%</td>
      </tr>`).join('');
    return `
      <div style="margin-bottom:14px;">
        <div class="label" style="margin-bottom:6px;">High Consumption Events</div>
        <table class="hce-table">
          <thead><tr><th>Period</th><th>WO</th><th>Date</th><th>Equip</th><th>Description</th><th>Qty</th><th>%</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function pillCls(tl){
    return ({ GREEN:'ok', BLUE:'cyan', ORANGE:'warn', RED:'crit', GREY:'' })[tl] || '';
  }

  /* ═════════════════════════════════════════════════════════════════════════
     LLM REVIEW
  ═════════════════════════════════════════════════════════════════════════ */
  function renderLlmPanel(llm){
    return `
      <div class="llm-panel ${llm.verdict}">
        <div class="llm-head">
          <h4>LLM review</h4>
          <span class="verdict ${llm.verdict}">${llm.verdict}</span>
          <span class="spacer"></span>
          <span class="provider">${escapeHtml(llm.provider)} · ${escapeHtml(llm.model || '')}</span>
        </div>
        <div class="llm-body">${escapeHtml(llm.notes || '(no notes)')}</div>
        ${(llm.suggestedEdits || []).length ? `
          <div class="llm-edits">
            <div class="label" style="margin-bottom:6px;">Suggested edits</div>
            ${(llm.suggestedEdits).map(e => `
              <div class="llm-edit">
                <span class="field">${escapeHtml(e.field || '')}</span>
                <span class="arrow">→</span>
                <span>${escapeHtml(JSON.stringify(e.newValue))}</span>
                ${e.rationale ? `<span class="rationale">${escapeHtml(e.rationale)}</span>` : ''}
              </div>
            `).join('')}
          </div>` : ''}
      </div>
    `;
  }

  async function runLlmReview(mat){
    state.llmInflight = true;
    $('#btnLlm').disabled = true;
    $('#llmStatus').innerHTML = '<span class="llm-spinner">Reviewing chart…</span>';
    try {
      const svg = $('#chartHost svg');
      const bucket = currentBucket();
      const out = await AppLlm.review(mat, bucket.name, state.json.parameters, svg);
      state.llmByMaterial[mat.material] = out;
      renderDetail();
    } catch (e) {
      console.error(e);
      const msg = e.message || String(e);
      const hint = /failed to fetch|cors/i.test(msg)
        ? ' — if you opened the page via file://, serve it via http://localhost instead (run: python -m http.server 8000 in App/v1/).'
        : '';
      $('#llmStatus').innerHTML = `<span class="llm-error">✗ ${escapeHtml(msg)}${hint}</span>`;
    } finally {
      state.llmInflight = false;
      $('#btnLlm').disabled = false;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     EXPORT
  ═════════════════════════════════════════════════════════════════════════ */
  function renderExportActions(){
    const host = $('#exportActions');
    host.innerHTML = `
      <div class="label" style="margin-right:auto;">Export Excel pack</div>
      <button id="btnExportBucket" class="primary">⤓ Export this bucket</button>
      <button id="btnExportCombined" class="primary">⤓ Export ALL (combined)</button>
      <button id="btnExportAll">⤓ Export all (separate files)</button>
      <span id="exportProgress" class="export-progress" style="display:none;"></span>
    `;
    $('#btnExportBucket').addEventListener('click', exportThisBucket);
    $('#btnExportCombined').addEventListener('click', exportCombined);
    $('#btnExportAll').addEventListener('click', exportAllBuckets);
  }

  async function exportThisBucket(){
    const b = currentBucket(); if (!b) return;
    const prog = $('#exportProgress');
    prog.style.display = '';
    prog.textContent = `Building workbook for ${b.name}…`;
    try {
      const fname = `analysis-${(state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_')}-${b.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${state.result.runDate}.xlsx`;
      await AppExcel.downloadBucket(b, state.json.parameters, {
        runDate: state.result.runDate,
        filename: fname,
        progress: (n, total, mat) => { prog.textContent = `Building chart ${n}/${total} · ${mat}`; }
      });
      prog.textContent = `✓ Exported ${b.name}`;
      setTimeout(() => { prog.style.display = 'none'; }, 3500);
    } catch (e) {
      console.error(e);
      prog.textContent = `✗ ${e.message || e}`;
    }
  }

  async function exportCombined(){
    const prog = $('#exportProgress');
    prog.style.display = '';
    prog.textContent = 'Building combined workbook…';
    try {
      const assess = (state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_');
      const fname  = `analysis-${assess}-ALL-${state.result.runDate}.xlsx`;
      const res = await AppExcel.downloadCombined(state.result, {
        filename: fname,
        progress: (n, total, label) => { prog.textContent = `Indexing ${n}/${total} · ${label}`; }
      });
      prog.textContent = `✓ Exported combined workbook · ${(res.sizeBytes/1024).toFixed(0)} KB`;
      setTimeout(() => { prog.style.display = 'none'; }, 4500);
    } catch (e) {
      console.error(e);
      prog.textContent = `✗ ${e.message || e}`;
    }
  }

  async function exportAllBuckets(){
    const prog = $('#exportProgress');
    prog.style.display = '';
    try {
      let i = 0;
      for (const b of state.result.buckets) {
        i++;
        prog.textContent = `Workbook ${i}/${state.result.buckets.length} · ${b.name}`;
        await AppExcel.downloadBucket(b, state.json.parameters, {
          runDate: state.result.runDate,
          filename: `analysis-${(state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_')}-${b.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${state.result.runDate}.xlsx`,
          progress: (n, total, mat) => { prog.textContent = `Workbook ${i}/${state.result.buckets.length} · ${b.name} · chart ${n}/${total}`; }
        });
      }
      prog.textContent = `✓ Exported ${state.result.buckets.length} workbooks`;
      setTimeout(() => { prog.style.display = 'none'; }, 4000);
    } catch (e) {
      console.error(e);
      prog.textContent = `✗ ${e.message || e}`;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */
  function bindGlobalKeys(){
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $$('.toast').forEach(t => t.remove());
    });
  }
  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }

  document.addEventListener('DOMContentLoaded', () => {
    bindToolbar();
    boot();
  });

})();
