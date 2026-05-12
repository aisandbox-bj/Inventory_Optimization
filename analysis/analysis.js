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
    llmByMaterial:   {},         // material → { verdict, notes, suggestedEdits, raw }
    colFilters:      {}          // colKey → { type:'set'|'range', values:Set, min, max }
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
    const tiles = ['GREEN','BLUE','ORANGE','RED','PURPLE','GREY'].map(k => `
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
    state.colFilters = {};
    closeColFilterPopover();
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
    const labels = ['ALL','GREEN','BLUE','ORANGE','RED','PURPLE','GREY'];
    host.innerHTML = labels.map(l => `<button data-tl="${l}" class="${state.filterTl === l ? 'active' : ''}">${l}</button>`).join('');
    $$('#tlFilter button').forEach(b => {
      b.addEventListener('click', () => { state.filterTl = b.dataset.tl; renderList(); renderFilterButtons(); });
    });
  }

  const LIST_COLS = [
    { k:'trafficLight', l:'TL',          type:'set',  picker:'set'   },
    { k:'material',     l:'Material',    type:'text', picker:'set'   },
    { k:'description',  l:'Description', type:'text', picker:'text'  },
    { k:'totalNet',     l:'Total',       type:'num',  picker:'range' },
    { k:'p1Rate',       l:'P1/mo',       type:'num',  picker:'range' },
    { k:'p2Rate',       l:'P2/mo',       type:'num',  picker:'range' },
    { k:'recMin',       l:'Rec Min',     type:'num',  picker:'range' },
    { k:'recMax',       l:'Rec Max',     type:'num',  picker:'range' },
    { k:'mrpType',      l:'MRP',         type:'text', picker:'set'   },
    { k:'pattern',      l:'Pattern',     type:'text', picker:'set'   }
  ];

  function passesColFilters(m){
    for (const [k, f] of Object.entries(state.colFilters)) {
      if (!f) continue;
      const v = m[k];
      if (f.type === 'set') {
        const sv = String(v == null ? '' : v);
        if (f.values && f.values.size && !f.values.has(sv)) return false;
      } else if (f.type === 'range') {
        const n = (typeof v === 'number') ? v : parseFloat(v);
        if (isNaN(n)) {
          if (f.min != null || f.max != null) return false;
          continue;
        }
        if (f.min != null && n < f.min) return false;
        if (f.max != null && n > f.max) return false;
      } else if (f.type === 'text') {
        if (f.value && !String(v || '').toLowerCase().includes(f.value.toLowerCase())) return false;
      }
    }
    return true;
  }

  function colFilterActive(k){
    const f = state.colFilters[k];
    if (!f) return false;
    if (f.type === 'set')   return f.values && f.values.size > 0;
    if (f.type === 'range') return f.min != null || f.max != null;
    if (f.type === 'text')  return f.value && f.value.length > 0;
    return false;
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
    rows = rows.filter(passesColFilters);
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

    const thead = LIST_COLS.map(c => {
      const sorted = state.sortKey === c.k ? `sorted ${state.sortDir === 'asc' ? 'asc' : ''}` : '';
      const fActive = colFilterActive(c.k);
      return `
        <th class="sortable ${sorted}" data-k="${c.k}">
          <span class="th-inner">
            <span class="th-label" data-sort="${c.k}">${c.l}</span>
            <button class="th-filter ${fActive ? 'active' : ''}" data-filter="${c.k}" title="Filter ${c.l}">▾</button>
          </span>
        </th>`;
    }).join('');

    const tbody = rows.map(m => `
      <tr data-material="${escapeAttr(m.material)}" class="${state.selectedMaterial === m.material ? 'selected' : ''}">
        <td><span class="tl-dot ${m.trafficLight}"></span><span class="tl-label">${m.trafficLight}</span></td>
        <td class="mat">${escapeHtml(m.material)}</td>
        <td class="desc" title="${escapeAttr(m.description)}">${escapeHtml(m.description || '')}</td>
        <td class="num">${m.totalNet?.toLocaleString?.() ?? m.totalNet ?? '—'}</td>
        <td class="num">${m.p1Flag === 'OK' ? m.p1Rate.toFixed(1) : `<span class="amber">${escapeHtml(m.p1Flag || '—')}</span>`}</td>
        <td class="num">${m.p2Flag === 'OK' ? m.p2Rate.toFixed(1) : `<span class="amber">${escapeHtml(m.p2Flag || '—')}</span>`}</td>
        <td class="num">${m.recMin ?? '—'}</td>
        <td class="num">${m.recMax ?? '—'}</td>
        <td class="num" style="color:var(--text-muted)">${escapeHtml(m.mrpType || '—')}</td>
        <td class="num" style="color:${m.pattern === 'LUMPY' ? 'var(--status-warn)' : 'var(--text-muted)'}">${escapeHtml(m.pattern || '—')}</td>
      </tr>`).join('');
    tbl.innerHTML = `<table class="list-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
                     <div class="list-meta" style="padding:8px 14px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);letter-spacing:.5px;">
                       ${rows.length.toLocaleString()} of ${bucket.materials.length.toLocaleString()} materials shown
                     </div>`;

    // Sort: click label → toggle sort
    $$('#listTableWrap .th-label').forEach(lab => {
      lab.addEventListener('click', (e) => {
        e.stopPropagation();
        const k = lab.dataset.sort;
        if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.sortKey = k; state.sortDir = 'desc'; }
        renderList();
      });
    });
    // Filter dropdown: click caret → open popover
    $$('#listTableWrap .th-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openColFilterPopover(btn);
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

  /* ─── Excel-style per-column filter popover ─────────────────────────────── */
  function openColFilterPopover(btn){
    closeColFilterPopover();
    const colKey = btn.dataset.filter;
    const col = LIST_COLS.find(c => c.k === colKey);
    if (!col) return;
    const bucket = currentBucket();
    const existing = state.colFilters[colKey] || {};

    const pop = document.createElement('div');
    pop.className = 'col-filter-pop';
    pop.dataset.colFilter = colKey;
    document.body.appendChild(pop);

    // Position relative to button
    const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.min(window.innerWidth - 290, r.left + window.scrollX)}px`;
    pop.style.top  = `${r.bottom + window.scrollY + 4}px`;

    let body = '';
    if (col.picker === 'set') {
      const allValues = new Set();
      bucket.materials.forEach(m => allValues.add(String(m[colKey] == null ? '' : m[colKey])));
      const sorted = [...allValues].sort();
      const sel = existing.values || new Set(sorted);
      body = `
        <div class="head">Filter · ${escapeHtml(col.l)}</div>
        <div class="vals" data-vals>
          ${sorted.map(v => `
            <label>
              <input type="checkbox" value="${escapeAttr(v)}" ${sel.has(v) ? 'checked' : ''}>
              <span>${escapeHtml(v) || '<em style="color:var(--text-muted)">(blank)</em>'}</span>
            </label>
          `).join('')}
        </div>
        <div class="actions">
          <button data-act="all">Select all</button>
          <button data-act="none">Clear</button>
          <button class="primary" data-act="apply">Apply</button>
        </div>
      `;
    } else if (col.picker === 'range') {
      body = `
        <div class="head">Filter · ${escapeHtml(col.l)} (numeric range)</div>
        <div class="range-row">
          <input type="number" data-fmin placeholder="min" value="${existing.min == null ? '' : existing.min}">
          <input type="number" data-fmax placeholder="max" value="${existing.max == null ? '' : existing.max}">
        </div>
        <div class="actions">
          <button data-act="clear">Clear</button>
          <button class="primary" data-act="apply">Apply</button>
        </div>
      `;
    } else if (col.picker === 'text') {
      body = `
        <div class="head">Filter · ${escapeHtml(col.l)} (contains)</div>
        <div class="range-row">
          <input type="text" data-ftext placeholder="any text…" value="${escapeAttr(existing.value || '')}">
        </div>
        <div class="actions">
          <button data-act="clear">Clear</button>
          <button class="primary" data-act="apply">Apply</button>
        </div>
      `;
    }
    pop.innerHTML = body;

    // Bind actions
    pop.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (col.picker === 'set') {
          const boxes = pop.querySelectorAll('input[type=checkbox]');
          if (act === 'all')  boxes.forEach(c => c.checked = true);
          if (act === 'none') boxes.forEach(c => c.checked = false);
          if (act === 'apply') {
            const total = boxes.length;
            const chosen = new Set([...boxes].filter(c => c.checked).map(c => c.value));
            if (chosen.size === total) delete state.colFilters[colKey];
            else state.colFilters[colKey] = { type:'set', values:chosen };
            closeColFilterPopover(); renderList();
          }
        } else if (col.picker === 'range') {
          if (act === 'clear') {
            delete state.colFilters[colKey];
            closeColFilterPopover(); renderList();
          }
          if (act === 'apply') {
            const mn = parseFloat(pop.querySelector('[data-fmin]').value);
            const mx = parseFloat(pop.querySelector('[data-fmax]').value);
            const f = { type:'range', min: isNaN(mn) ? null : mn, max: isNaN(mx) ? null : mx };
            if (f.min == null && f.max == null) delete state.colFilters[colKey];
            else state.colFilters[colKey] = f;
            closeColFilterPopover(); renderList();
          }
        } else if (col.picker === 'text') {
          if (act === 'clear') {
            delete state.colFilters[colKey];
            closeColFilterPopover(); renderList();
          }
          if (act === 'apply') {
            const val = pop.querySelector('[data-ftext]').value.trim();
            if (!val) delete state.colFilters[colKey];
            else state.colFilters[colKey] = { type:'text', value:val };
            closeColFilterPopover(); renderList();
          }
        }
      });
    });

    // Close on outside click / Esc
    setTimeout(() => {
      document.addEventListener('click', dismissOnOutside, { once:false });
      document.addEventListener('keydown', dismissOnEsc, { once:false });
    }, 0);
  }
  function dismissOnOutside(ev){
    const pop = document.querySelector('.col-filter-pop');
    if (!pop) return;
    if (pop.contains(ev.target)) return;
    closeColFilterPopover();
  }
  function dismissOnEsc(ev){
    if (ev.key === 'Escape') closeColFilterPopover();
  }
  function closeColFilterPopover(){
    document.querySelectorAll('.col-filter-pop').forEach(p => p.remove());
    document.removeEventListener('click', dismissOnOutside);
    document.removeEventListener('keydown', dismissOnEsc);
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
    return ({ GREEN:'ok', BLUE:'cyan', ORANGE:'warn', RED:'crit', PURPLE:'wr', GREY:'' })[tl] || '';
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
      <div class="label" style="margin-right:auto;">Bulk operations</div>
      <button id="btnMassReview" class="primary" title="Pick up to 50 materials for LLM review">✦ Mass LLM Review</button>
      <button id="btnLoadMassReview" class="ghost" title="Upload a saved mass-review JSON to view results">⤒ Load mass review</button>
      <button id="btnExportBucket" class="primary">⤓ Export this bucket</button>
      <button id="btnExportCombined" class="primary">⤓ Export ALL (combined)</button>
      <button id="btnExportAll">⤓ Export all (separate files)</button>
      <span id="exportProgress" class="export-progress" style="display:none;"></span>
      <input type="file" id="loadMassReviewInput" accept=".json" style="display:none;" />
    `;
    $('#btnMassReview').addEventListener('click', openMassReview);
    $('#btnLoadMassReview').addEventListener('click', () => $('#loadMassReviewInput').click());
    $('#loadMassReviewInput').addEventListener('change', handleMassReviewUpload);
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
     MASS LLM REVIEW  (v2.0)
     Modal lifecycle: Select → Run → Results → (download → wipe-on-close).
     No persistence; in-memory only. Closing wipes all LLM data.
  ═════════════════════════════════════════════════════════════════════════ */

  // Initialise mass-state lazily (state is defined earlier in the file)
  function ensureMassState(){
    if (!state.mass) {
      state.mass = {
        view: 'closed',                  // 'select' | 'run' | 'results' | 'closed'
        session: null,                   // AppMassLlm session object
        selected: new Set(),             // material numbers
        hydrated: false,                 // true if loaded from saved JSON
        bucketKeyAtRun: null             // bucket the session belongs to
      };
    }
    return state.mass;
  }

  function openMassReview(){
    ensureMassState();
    const b = currentBucket();
    if (!b) { toast('No bucket selected', 'warn'); return; }

    // If a session already exists for this bucket, jump to its current view
    if (state.mass.session) {
      if (state.mass.session.status === 'done' || state.mass.session.status === 'cancelled') {
        state.mass.view = 'results';
      } else {
        state.mass.view = 'run';
      }
      showMassModal();
      return;
    }

    // Fresh selection — scope to current bucket only (per design)
    state.mass.view = 'select';
    state.mass.bucketKeyAtRun = b.key;
    state.mass.selected = new Set();
    showMassModal();
  }

  function showMassModal(){
    const modal = $('#massModal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    $('#massBucketName').textContent = currentBucket() ? currentBucket().name : '—';
    hideMassChip();
    renderMassView();
    // Esc to dismiss (treats as soft close)
    document.addEventListener('keydown', massEscHandler);
  }
  function hideMassModal(){
    const modal = $('#massModal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', massEscHandler);
  }
  function massEscHandler(e){ if (e.key === 'Escape') softCloseMassReview(); }

  /* Soft close — close window, keep state in background if a run is live.
     Hard close (wipe) is triggered from explicit buttons in the Results view. */
  function softCloseMassReview(){
    if (!state.mass) { hideMassModal(); return; }
    const s = state.mass.session;
    if (s && (s.status === 'running' || s.status === 'paused')) {
      hideMassModal();
      showMassChip();
      return;
    }
    if (state.mass.view === 'results' && state.mass.session) {
      const ok = confirm(
        'Closing this view will WIPE all in-memory LLM data — both this mass-review session AND any single-review notes from this session. ' +
        'If you haven\'t already downloaded the Excel + JSON, do that first.\n\n' +
        'Continue closing?'
      );
      if (!ok) return;
      wipeAllLlm();
      hideMassModal();
      return;
    }
    // No session running or completed (Select view, never started) — just close
    hideMassModal();
  }

  function wipeAllLlm(){
    state.llmByMaterial = {};
    if (state.mass) {
      if (state.mass.session && (state.mass.session.status === 'running' || state.mass.session.status === 'paused')) {
        state.mass.session.cancel();
      }
      state.mass = null;
    }
    hideMassChip();
    // If a material is selected on the main page, re-render detail to drop any LLM panel
    if (state.selectedMaterial) renderDetail();
  }

  function showMassChip(){
    const chip = $('#massChip'); if (!chip) return;
    chip.classList.remove('hidden');
    updateMassChip();
    chip.querySelector('.mass-chip-open').onclick = () => { showMassModal(); };
  }
  function hideMassChip(){
    const chip = $('#massChip'); if (!chip) return;
    chip.classList.add('hidden');
  }
  function updateMassChip(){
    const chip = $('#massChip'); if (!chip || !state.mass || !state.mass.session) return;
    const s = state.mass.session;
    const done = s.results.filter(r => r.status === 'done' || r.status === 'error').length;
    chip.querySelector('.mass-chip-text').textContent = `Mass review: ${done} / ${s.total}`;
  }

  /* ─── View dispatcher ─── */
  function renderMassView(){
    if (!state.mass) return;
    const pill = $('#massModePill');
    if (state.mass.view === 'select') {
      pill.textContent = 'Select'; pill.className = 'mass-mode-pill';
      renderMassSelect();
    } else if (state.mass.view === 'run') {
      pill.textContent = 'Running'; pill.className = 'mass-mode-pill running';
      renderMassRun();
    } else if (state.mass.view === 'results') {
      const s = state.mass.session;
      const cancelled = s && s.status === 'cancelled';
      pill.textContent = cancelled ? 'Cancelled' : 'Results';
      pill.className = 'mass-mode-pill ' + (cancelled ? 'running' : 'done');
      renderMassResults();
    }
  }

  /* ─── Select view ─── */
  function renderMassSelect(){
    const bucket = currentBucket();
    const body = $('#massBody');
    const foot = $('#massFoot');
    if (!bucket) { body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted);">No bucket selected.</div>'; return; }

    const sel = state.mass.selected;
    const max = AppMassLlm.MAX_SELECTION;
    const overCap = sel.size > max;

    const cols = [
      { k:'__chk',         l:'',            type:'chk'  },
      { k:'trafficLight',  l:'TL',          type:'set'  },
      { k:'material',      l:'Material',    type:'mat'  },
      { k:'description',   l:'Description', type:'desc' },
      { k:'totalNet',      l:'Total',       type:'num'  },
      { k:'p2Rate',        l:'P2/mo',       type:'num'  },
      { k:'pattern',       l:'Pattern',     type:'pat'  }
    ];
    const thead = cols.map(c => `<th>${c.l}</th>`).join('');
    const tbody = bucket.materials.map(m => {
      const checked = sel.has(m.material) ? 'checked' : '';
      const disable = (!checked && sel.size >= max) ? 'disabled' : '';
      return `
        <tr data-material="${escapeAttr(m.material)}">
          <td><input type="checkbox" data-mat="${escapeAttr(m.material)}" ${checked} ${disable} /></td>
          <td><span class="tl-dot ${m.trafficLight}"></span><span class="tl-label">${m.trafficLight}</span></td>
          <td class="mat">${escapeHtml(m.material)}</td>
          <td class="desc" title="${escapeAttr(m.description)}">${escapeHtml((m.description || '').slice(0, 80))}</td>
          <td class="num">${m.totalNet?.toLocaleString?.() ?? m.totalNet ?? '—'}</td>
          <td class="num">${m.p2Flag === 'OK' ? m.p2Rate.toFixed(1) : '—'}</td>
          <td class="num" style="color:${m.pattern === 'LUMPY' ? 'var(--status-warn)' : 'var(--text-muted)'}">${m.pattern}</td>
        </tr>`;
    }).join('');

    body.innerHTML = `
      <div class="mass-select-info">
        <span>Pick materials to review — max <b>${max}</b>:</span>
        <span class="mass-select-counter ${overCap ? 'over' : ''}" id="massSelCounter">${sel.size} / ${max} selected</span>
      </div>
      <div class="list-table-wrap" style="max-height:480px;">
        <table class="list-table">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
    body.querySelectorAll('input[type=checkbox][data-mat]').forEach(cb => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const mat = cb.dataset.mat;
        if (cb.checked) {
          if (sel.size >= max) { cb.checked = false; return; }
          sel.add(mat);
        } else {
          sel.delete(mat);
        }
        renderMassSelect();
      });
    });

    foot.innerHTML = `
      <button id="massSelAll" class="ghost">Select all visible</button>
      <button id="massSelClear" class="ghost">Clear</button>
      <span class="spacer"></span>
      <span class="stat">Estimated: ~3-8 min · cost depends on provider/model</span>
      <button id="massStart" class="primary" ${sel.size === 0 || overCap ? 'disabled' : ''}>✦ Review ${sel.size} material${sel.size === 1 ? '' : 's'}</button>
    `;
    $('#massSelAll').addEventListener('click', () => {
      const mats = bucket.materials.map(m => m.material);
      const room = max - sel.size;
      mats.forEach(m => { if (!sel.has(m) && sel.size < max) sel.add(m); });
      renderMassSelect();
    });
    $('#massSelClear').addEventListener('click', () => { sel.clear(); renderMassSelect(); });
    $('#massStart').addEventListener('click', startMassReview);
  }

  /* ─── Start the run ─── */
  async function startMassReview(){
    const bucket = currentBucket();
    if (!bucket) return;
    const providers = await AppLlm.configuredProviders();
    if (providers.length === 0) {
      toast('No LLM provider configured — open Settings and add a key + pick a model.', 'crit');
      return;
    }
    const mats = bucket.materials.filter(m => state.mass.selected.has(m.material));
    state.mass.view = 'run';
    renderMassView();   // initial render before session emits first progress
    const session = AppMassLlm.createSession(
      mats,
      bucket.name,
      state.json.parameters,
      {
        onProgress: () => { renderMassRun(); updateMassChip(); },
        onComplete: () => { state.mass.view = 'results'; renderMassView(); hideMassChip(); }
      }
    );
    state.mass.session = session;
  }

  /* ─── Run view ─── */
  function renderMassRun(){
    const s = state.mass && state.mass.session;
    if (!s) return;
    const done = s.results.filter(r => r.status === 'done' || r.status === 'error').length;
    const pct  = s.total ? Math.round(done / s.total * 100) : 0;
    const current = s.results[s.cursor] || null;
    const nowText = current && current.status === 'inflight'
                    ? `Now reviewing: ${current.material} · ${escapeHtml((current.description || '').slice(0, 50))}`
                    : (s.status === 'paused' ? 'Paused' : 'Done');

    const body = $('#massBody');
    body.innerHTML = `
      <div class="mass-progress">
        <span class="label">Progress</span>
        <span class="now" id="massNow">${escapeHtml(nowText)}</span>
        <div class="mass-progress-bar"><div style="width:${pct}%"></div></div>
        <span class="mass-progress-pct">${done} / ${s.total}</span>
      </div>
      <div class="list-table-wrap" style="max-height:440px;">
        <table class="mass-results-table">
          <thead><tr>
            <th class="mass-status-cell"></th>
            <th>Material</th>
            <th>Description</th>
            <th>Pre-LLM</th>
            <th>LLM verdict</th>
            <th>Notes</th>
            <th>Latency</th>
          </tr></thead>
          <tbody>${renderMassRows(s)}</tbody>
        </table>
      </div>
    `;
    const foot = $('#massFoot');
    foot.innerHTML = `
      <button id="massCancel" class="danger" ${s.status === 'cancelled' ? 'disabled' : ''}>Cancel batch</button>
      <button id="massPause"  class="ghost"  ${s.status !== 'running' ? 'disabled' : ''}>${s.status === 'paused' ? 'Resume' : 'Pause'}</button>
      <span class="spacer"></span>
      <span class="stat"><b>${s.results.filter(r => r.status==='done').length}</b> done · <b>${s.results.filter(r => r.status==='error').length}</b> errors · <b>${s.results.filter(r => r.status==='inflight').length}</b> in flight</span>
    `;
    $('#massCancel').addEventListener('click', () => {
      if (confirm('Cancel batch? Remaining materials will be skipped. Completed results are preserved.')) s.cancel();
    });
    $('#massPause').addEventListener('click', () => {
      if (s.status === 'paused') s.resume();
      else s.pause();
    });
    bindMassRowClicks();
  }

  function renderMassRows(s){
    return s.results.map(r => {
      const verdictPill = r.verdict
                            ? `<span class="llm-pill ${r.verdict}">${r.verdict}</span>`
                            : (r.error ? '<span class="llm-pill empty">err</span>'
                                       : '<span class="llm-pill empty">—</span>');
      const statusGlyph = ({
        pending:  '⋯',
        inflight: '⏳',
        done:     '✓',
        error:    '✗',
        skipped:  '↷'
      })[r.status] || '·';
      const notesOrErr = r.error ? `<span style="color:var(--status-crit);">ERROR: ${escapeHtml(r.error)}</span>` : escapeHtml(r.notes || '');
      return `
        <tr data-material="${escapeAttr(r.material)}">
          <td class="mass-status-cell"><span class="mass-status ${r.status}">${statusGlyph}</span></td>
          <td class="mat">${escapeHtml(r.material)}</td>
          <td class="desc" title="${escapeAttr(r.description)}">${escapeHtml((r.description || '').slice(0, 60))}</td>
          <td><span class="mass-result-tl-cell"><span class="tl-dot ${r.preTL}"></span>${r.preTL}</span></td>
          <td>${verdictPill}</td>
          <td class="notes" title="${escapeAttr(r.notes || r.error || '')}">${notesOrErr}</td>
          <td class="num">${r.latencyMs != null ? (r.latencyMs/1000).toFixed(1) + 's' : '—'}</td>
        </tr>`;
    }).join('');
  }

  function bindMassRowClicks(){
    document.querySelectorAll('.mass-results-table tbody tr').forEach(tr => {
      tr.addEventListener('click', () => drillDownMaterial(tr.dataset.material));
    });
  }

  /* ─── Results view ─── */
  function renderMassResults(){
    const s = state.mass && state.mass.session;
    if (!s) return;
    const body = $('#massBody');
    body.innerHTML = `
      <div class="mass-progress">
        <span class="label">${s.status === 'cancelled' ? 'Cancelled' : 'Complete'}</span>
        <span class="now">
          ${s.results.filter(r => r.status === 'done').length} done ·
          ${s.results.filter(r => r.status === 'error').length} errors ·
          ${s.results.filter(r => r.status === 'skipped').length} skipped ·
          provider ${escapeHtml(s.provider || '—')} · model ${escapeHtml(s.model || '—')}
        </span>
        <span class="mass-progress-pct">${s.results.filter(r => r.status !== 'pending').length} / ${s.total}</span>
      </div>
      <div class="list-table-wrap" style="max-height:540px;">
        <table class="mass-results-table">
          <thead><tr>
            <th class="mass-status-cell"></th>
            <th>Material</th>
            <th>Description</th>
            <th>Pre-LLM</th>
            <th>LLM verdict</th>
            <th>Notes</th>
            <th>Latency</th>
          </tr></thead>
          <tbody>${renderMassRows(s)}</tbody>
        </table>
      </div>
      <div class="panel-sub" style="margin-top:12px;font-size:11px;color:var(--text-muted);">
        Click any row to drill into that material's chart + LLM commentary on the main analysis page.
        Closing this modal <b>wipes all in-memory LLM data</b> — download the Excel + JSON first if you want to keep it.
      </div>
    `;
    const foot = $('#massFoot');
    foot.innerHTML = `
      <button id="massDownloadXlsx" class="primary">⤓ Download Excel</button>
      <button id="massDownloadJson" class="primary">⤓ Download JSON</button>
      <span class="spacer"></span>
      <span class="stat">Hash: <b>${escapeHtml(s.promptHash || '—')}</b></span>
      <button id="massCloseWipe" class="danger">⌫ Close &amp; wipe</button>
    `;
    $('#massDownloadXlsx').addEventListener('click', downloadMassXlsx);
    $('#massDownloadJson').addEventListener('click', downloadMassJson);
    $('#massCloseWipe').addEventListener('click', () => {
      if (confirm('Wipe all in-memory LLM data and close? This cannot be undone — make sure you have downloaded the Excel and / or JSON.')) {
        wipeAllLlm();
        hideMassModal();
      }
    });
    bindMassRowClicks();
  }

  /* ─── Drill-down: close modal, select material on main page ─── */
  function drillDownMaterial(material){
    if (!state.mass || !state.mass.session) return;
    // Cache the LLM result onto state.llmByMaterial so the detail panel renders it
    const r = state.mass.session.results.find(x => x.material === material);
    if (r && r.verdict) {
      state.llmByMaterial[material] = {
        verdict: r.verdict,
        notes: r.notes,
        suggestedEdits: r.suggestedEdits,
        provider: state.mass.session.provider,
        model: state.mass.session.model,
        latencyMs: r.latencyMs,
        source: 'mass'
      };
    }
    state.selectedMaterial = material;
    // If session is running, keep the chip showing; otherwise hide
    const s = state.mass.session;
    if (s.status === 'running' || s.status === 'paused') {
      hideMassModal();
      showMassChip();
    } else {
      hideMassModal();
    }
    renderList();
    renderDetail();
    document.querySelector('#materialDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ─── Downloads ─── */
  async function downloadMassXlsx(){
    if (!state.mass || !state.mass.session) return;
    const bucket = currentBucket();
    const assess = (state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_');
    const safeBucket = bucket.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    const fname = `Mass_LLM_Review_${assess}_${safeBucket}_${state.result.runDate}.xlsx`;
    try {
      await AppExcel.downloadMassReview(bucket, state.mass.session, state.json.parameters, {
        runDate:  state.result.runDate,
        filename: fname
      });
      toast(`Excel downloaded: ${fname}`, 'ok');
    } catch (e) {
      console.error(e);
      toast('Excel download failed: ' + (e.message || e), 'crit');
    }
  }
  function downloadMassJson(){
    if (!state.mass || !state.mass.session) return;
    const json = AppMassLlm.toJson(state.mass.session, state.json.metadata.assessmentName || '');
    const blob = new Blob([JSON.stringify(json, null, 2)], { type:'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const assess = (state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g, '_');
    a.href = url;
    a.download = `Mass_LLM_Review_${assess}_${(state.mass.session.bucketName).replace(/[^A-Za-z0-9_-]+/g,'_')}_${state.result.runDate}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('JSON downloaded — keep this file to reload the review later.', 'ok');
  }

  /* ─── Upload saved mass-review JSON, hydrate into Results view ─── */
  async function handleMassReviewUpload(e){
    const file = e.target.files[0];
    e.target.value = '';   // reset so same file can be re-picked
    if (!file) return;
    try {
      const text = await file.text();
      const saved = JSON.parse(text);
      if (saved.kind !== 'mass-llm-review') {
        toast('Not a mass-review JSON.', 'crit');
        return;
      }
      const bucketKey = saved.metadata.bucketKey;
      const bucket = state.result.buckets.find(b => b.key === bucketKey || b.name === bucketKey);
      if (!bucket) {
        toast(`Bucket "${bucketKey}" not in the current analysis — load the matching intake JSON first.`, 'crit');
        return;
      }
      // Switch the active bucket if necessary
      if (state.selectedBucket !== bucket.key) selectBucket(bucket.key);
      ensureMassState();
      state.mass.session  = AppMassLlm.hydrate(saved, state.result, bucket.key);
      state.mass.hydrated = true;
      state.mass.view     = 'results';
      state.mass.bucketKeyAtRun = bucket.key;
      // Cache LLM results onto state.llmByMaterial too so drill-downs render
      for (const r of state.mass.session.results) {
        if (r.verdict) {
          state.llmByMaterial[r.material] = {
            verdict: r.verdict, notes: r.notes, suggestedEdits: r.suggestedEdits,
            provider: state.mass.session.provider, model: state.mass.session.model,
            latencyMs: r.latencyMs, source: 'mass-hydrated'
          };
        }
      }
      showMassModal();
      toast(`Loaded ${state.mass.session.results.filter(r => r.verdict).length} reviews from ${file.name}`, 'ok');
    } catch (err) {
      console.error(err);
      toast('Failed to load mass-review JSON: ' + (err.message || err), 'crit');
    }
  }

  /* ─── Wire close button + backdrop click ─── */
  function bindMassModalCloseHandlers(){
    const closeBtn = $('#massClose');
    if (closeBtn) closeBtn.addEventListener('click', softCloseMassReview);
    const backdrop = document.querySelector('.mass-backdrop');
    if (backdrop) backdrop.addEventListener('click', softCloseMassReview);
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
  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindToolbar();
    boot();
    bindMassModalCloseHandlers();
  });

})();
