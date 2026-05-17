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
    colFilters:      {},         // colKey → { type:'set'|'range', values:Set, min, max } — main analysis list
    marked:          {           // user-marked materials (right-click context menu, v2.0)
      review: new Set(),         // → pre-checked in Mass LLM modal
      pdf:    new Set()          // → pre-checked in PDF Pack modal
    },
    // v2.1.1 — Mass LLM modal-local filter state (independent of main list).
    _massSelectFilters:  {},     // colKey → filter spec, applies to Mass LLM selection table
    _massResultsFilters: {},     // colKey → filter spec, applies to Mass LLM results table
    _massSelectSort:     { key:null, dir:'desc' },
    _massResultsSort:    { key:null, dir:'desc' }
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
    if (m === 'manual') {
      /* APP-E22 — branch on listType for plain-English summary. */
      const mm = j.scope.manual || {};
      if (mm.listType === 'workOrders') return `Manual · ${(mm.workOrders || []).length} work orders`;
      return `Manual · ${(mm.materials || []).length} materials`;
    }
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
  async function runPipelineNow(autoPopupIfCandidates){
    const status = $('#pipelineStatus');
    status.querySelector('.meta').textContent = 'running…';
    // Defer so the UI repaints
    await new Promise(r => setTimeout(r, 30));
    try {
      const t0 = performance.now();
      state.result = AppPipeline.runPipeline(state.json, { runDate: AppLocale.localDateISO() });
      const t1 = performance.now();
      const ia = state.result.invAdjAnalysis || { candidates: [] };
      const iaCount = ia.candidates.length;
      const iaSummary = iaCount > 0
        ? ` · <span style="color:var(--status-warn);cursor:pointer;text-decoration:underline;" id="iaMetaLink" title="${iaCount} possible inventory-adjustment date${iaCount===1?'':'s'} detected — click to review">${iaCount} Inv-Adj candidate${iaCount===1?'':'s'}</span>`
        : '';
      status.querySelector('.meta').innerHTML = `${state.result.summary.total} materials across ${state.result.buckets.length} bucket${state.result.buckets.length === 1 ? '' : 's'} · ${Math.round(t1 - t0)} ms${iaSummary}`;
      const iaLink = document.getElementById('iaMetaLink');
      if (iaLink) iaLink.addEventListener('click', () => openInvAdjModal());
      renderSummaryTiles();
      renderBucketTabs();
      if (state.result.buckets.length) selectBucket(state.result.buckets[0].key);
      renderExportActions();
      // APP-E25 (2026-05-17) — auto-popup the Inv Adj modal on first run when
      // candidates exist AND the operator hasn't yet reviewed/dismissed it
      // for THIS assessment. Gate flipped from a per-session JS flag
      // (state._invAdjSeen, reset on every reload) to a persistent flag in
      // the canonical JSON (parameters.invAdjReviewed, survives reload).
      // Operator can re-open manually via the "N Inv-Adj candidate" link in
      // the pipeline status header at any time.
      const alreadyReviewed = !!(state.json && state.json.parameters && state.json.parameters.invAdjReviewed);
      if (autoPopupIfCandidates !== false && iaCount > 0 && !alreadyReviewed) {
        // Slight delay so the analysis UI paints first
        setTimeout(() => openInvAdjModal(), 250);
      }
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

  /* v2.1.1: passesColFilters and colFilterActive now accept an optional
     colFilters reference so the same predicates serve mass-select and
     mass-results filter state. Defaults to state.colFilters for the
     existing main-list call sites. */
  function passesColFilters(m, filters){
    const cf = filters || state.colFilters;
    for (const [k, f] of Object.entries(cf)) {
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

  function colFilterActive(k, filters){
    const f = (filters || state.colFilters)[k];
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

    const tbody = rows.map(m => {
      const isReview = state.marked.review.has(m.material);
      const isPdf    = state.marked.pdf.has(m.material);
      const rowClasses = [
        state.selectedMaterial === m.material ? 'selected' : '',
        (isReview || isPdf) ? 'marked-any' : '',
        isReview ? 'marked-review' : '',
        isPdf    ? 'marked-pdf'    : ''
      ].filter(Boolean).join(' ');
      const badges = (isReview || isPdf)
        ? `<span class="mark-badges">${isReview ? '<span class="mark-badge review" title="Marked for LLM review">✦</span>' : ''}${isPdf ? '<span class="mark-badge pdf" title="Marked for PDF print">⤓</span>' : ''}</span>`
        : '';
      return `
      <tr data-material="${escapeAttr(m.material)}" class="${rowClasses}">
        <td><span class="tl-dot ${m.trafficLight}"></span><span class="tl-label">${m.trafficLight}</span></td>
        <td class="mat">${escapeHtml(m.material)}${badges}</td>
        <td class="desc" title="${escapeAttr(m.description)}">${escapeHtml(m.description || '')}</td>
        <td class="num">${m.totalNet?.toLocaleString?.() ?? m.totalNet ?? '—'}</td>
        <td class="num">${m.p1Flag === 'OK' ? m.p1Rate.toFixed(1) : `<span class="amber">${escapeHtml(m.p1Flag || '—')}</span>`}</td>
        <td class="num">${m.p2Flag === 'OK' ? m.p2Rate.toFixed(1) : `<span class="amber">${escapeHtml(m.p2Flag || '—')}</span>`}</td>
        <td class="num">${m.recMin ?? '—'}</td>
        <td class="num">${m.recMax ?? '—'}</td>
        <td class="num" style="color:var(--text-muted)">${escapeHtml(m.mrpType || '—')}</td>
        <td class="num" style="color:${m.pattern === 'LUMPY' ? 'var(--status-warn)' : 'var(--text-muted)'}">${escapeHtml(m.pattern || '—')}</td>
      </tr>`;
    }).join('');
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
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openRowContextMenu(e.clientX, e.clientY, tr.dataset.material);
      });
    });
  }

  /* ─── Right-click context menu (v2.0) ───────────────────────────────────── */
  function openRowContextMenu(x, y, material){
    const menu = $('#rowContextMenu');
    if (!menu) return;
    menu.classList.remove('hidden');
    menu.setAttribute('aria-hidden', 'false');

    // Toggle which menu items are shown based on existing marks
    const isReview = state.marked.review.has(material);
    const isPdf    = state.marked.pdf.has(material);
    menu.querySelector('[data-action="mark-review"]').style.display   = isReview ? 'none' : '';
    menu.querySelector('[data-action="unmark-review"]').style.display = isReview ? '' : 'none';
    menu.querySelector('[data-action="mark-pdf"]').style.display      = isPdf    ? 'none' : '';
    menu.querySelector('[data-action="unmark-pdf"]').style.display    = isPdf    ? '' : 'none';

    // Position — clamp to viewport
    const w = 260, h = 200;
    const left = Math.min(x, window.innerWidth - w - 8);
    const top  = Math.min(y, window.innerHeight - h - 8);
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';

    // Bind item handlers (one-shot per open)
    menu.querySelectorAll('.row-ctx-item').forEach(item => {
      item.onclick = () => {
        const act = item.dataset.action;
        if (act === 'mark-review')   { state.marked.review.add(material);    }
        if (act === 'unmark-review') { state.marked.review.delete(material); }
        if (act === 'mark-pdf')      { state.marked.pdf.add(material);       }
        if (act === 'unmark-pdf')    { state.marked.pdf.delete(material);    }
        if (act === 'open-detail')   {
          state.selectedMaterial = material;
          renderDetail();
          document.querySelector('#materialDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        closeRowContextMenu();
        renderList();
        renderBulkCounters();
      };
    });

    setTimeout(() => {
      document.addEventListener('click', dismissRowCtxOutside, { once: true });
      document.addEventListener('keydown', dismissRowCtxEsc, { once: true });
      window.addEventListener('scroll', closeRowContextMenu, { once: true });
    }, 0);
  }
  function dismissRowCtxOutside(){ closeRowContextMenu(); }
  function dismissRowCtxEsc(e){ if (e.key === 'Escape') closeRowContextMenu(); }
  function closeRowContextMenu(){
    const menu = $('#rowContextMenu');
    if (menu) { menu.classList.add('hidden'); menu.setAttribute('aria-hidden','true'); }
  }

  /* Update bulk-operations row to show mark counters */
  function renderBulkCounters(){
    const reviewBtn = $('#btnMassReview');
    const pdfBtn    = $('#btnPdfPack');
    const nReview = state.marked.review.size;
    const nPdf    = state.marked.pdf.size;
    if (reviewBtn) reviewBtn.textContent = nReview > 0
      ? `✦ Mass LLM Review · ${nReview} marked`
      : `✦ Mass LLM Review`;
    if (pdfBtn) pdfBtn.textContent = nPdf > 0
      ? `⤓ Export PDF Pack · ${nPdf} marked`
      : `⤓ Export PDF Pack`;
  }

  /* ─── Excel-style per-column filter popover ───────────────────────────────
     v2.1.1: refactored to accept an opts object so the same popover serves
     three tables (main list, mass-select, mass-results). Old call sites
     pass { colDefs: LIST_COLS, colFilters: state.colFilters,
            data: currentBucket().materials, onChange: renderList }. */
  function openColFilterPopover(btn, opts){
    opts = opts || {};
    const colDefs    = opts.colDefs    || LIST_COLS;
    const colFilters = opts.colFilters || state.colFilters;
    const data       = opts.data       || (currentBucket() ? currentBucket().materials : []);
    const onChange   = opts.onChange   || renderList;

    closeColFilterPopover();
    const colKey = btn.dataset.filter;
    const col = colDefs.find(c => c.k === colKey);
    if (!col) return;
    const existing = colFilters[colKey] || {};

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
      data.forEach(m => allValues.add(String(m[colKey] == null ? '' : m[colKey])));
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
            if (chosen.size === total) delete colFilters[colKey];
            else colFilters[colKey] = { type:'set', values:chosen };
            closeColFilterPopover(); onChange();
          }
        } else if (col.picker === 'range') {
          if (act === 'clear') {
            delete colFilters[colKey];
            closeColFilterPopover(); onChange();
          }
          if (act === 'apply') {
            const mn = parseFloat(pop.querySelector('[data-fmin]').value);
            const mx = parseFloat(pop.querySelector('[data-fmax]').value);
            const f = { type:'range', min: isNaN(mn) ? null : mn, max: isNaN(mx) ? null : mx };
            if (f.min == null && f.max == null) delete colFilters[colKey];
            else colFilters[colKey] = f;
            closeColFilterPopover(); onChange();
          }
        } else if (col.picker === 'text') {
          if (act === 'clear') {
            delete colFilters[colKey];
            closeColFilterPopover(); onChange();
          }
          if (act === 'apply') {
            const val = pop.querySelector('[data-ftext]').value.trim();
            if (!val) delete colFilters[colKey];
            else colFilters[colKey] = { type:'text', value:val };
            closeColFilterPopover(); onChange();
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
      host.innerHTML = `<div class="detail-empty"><div class="big">Select a material above</div>Pick any row in the table above to load the consumption chart, key stats, HCE events (if any), and run an LLM review.</div>`;
      return;
    }
    const rcDisp = mat.rateChange != null ? `${mat.rateChange}%` : 'N/A';
    const adjDisp = (mat.hceP2 && mat.hceP2.length)
                  ? (mat.adjP2Flag === 'OK' ? `${mat.adjP2Rate.toFixed(2)}` : `0 [${mat.adjP2Flag || 'NO_DATA'}]`)
                  : '—';

    const llmCfg = state.llmByMaterial[mat.material];

    // APP-E18 — pre-compute conditional stat cells (stockout-aware diagnostic
    // from APP-E1) so they can be slotted into the regrouped stat-grid below.
    const lastCons = mat.lastConsumptionDate || null;
    let lastConsCell  = '';
    let stockoutsCell = '';
    let dropCauseCell = '';
    if (lastCons) {
      const swCount = (mat.stockoutWindows || []).length;
      const swDays  = (mat.stockoutWindows || []).reduce((s,w) => s + (w.days||0), 0);
      const swDisp  = swCount === 0
        ? '<span style="color:var(--accent-ok,#4fd06d)">none</span>'
        : `<span style="color:var(--accent-crit,#ff5a5a)">${swCount} window${swCount===1?'':'s'} · ${swDays}d</span>`;
      const cause = mat.rateDropCause || null;
      lastConsCell  = `<div class="stat-cell"><span class="lab">Last consumption</span><div class="v">${lastCons}</div></div>`;
      stockoutsCell = `<div class="stat-cell"><span class="lab">Stockouts in window</span><div class="v">${swDisp}</div></div>`;
      dropCauseCell = cause
        ? `<div class="stat-cell"><span class="lab">Drop cause</span><div class="v" style="color:${cause==='STOCKOUT_DRIVEN' ? 'var(--accent-crit,#ff5a5a)' : 'var(--accent-warn,#ff9e4c)'}">${cause === 'STOCKOUT_DRIVEN' ? '⚠ Stockout-driven' : 'Genuine demand drop'}</div></div>`
        : '';
    }

    host.innerHTML = `
      <div class="detail-head ${mat.trafficLight}">
        <div class="detail-head-id">
          <div class="mat-row">
            <span class="mat">${escapeHtml(mat.material)}</span>
            <button class="mat-copy" id="btnCopyMat" title="Copy material number to clipboard" aria-label="Copy material number">⧉</button>
          </div>
          <div class="desc">${escapeHtml(mat.description || '')}</div>
        </div>
        <div class="detail-head-rec">
          <span class="rec-lab">Algorithmic recommendation</span>
          <div class="rec-text">${escapeHtml(mat.action)}</div>
        </div>
        <span class="pill ${pillCls(mat.trafficLight)}"><span class="dot"></span>${mat.trafficLight}</span>
      </div>

      <div class="chart-toolbar">
        <span class="chart-toolbar-lab">Show:</span>
        <label class="chart-toggle"><input type="checkbox" id="chartToggleConsumption" checked> Consumption</label>
        <label class="chart-toggle"><input type="checkbox" id="chartToggleSoh" checked> Stock on Hand</label>
      </div>
      <div class="chart-host" id="chartHost"></div>
      <div class="chart-caveat">Stock-on-hand line is back-calculated from MB51 movements (site stock only, 3PL receipts excluded) — not pulled from SAP.</div>

      <div class="stat-grid">
        <!-- Row 1 · headline raw values -->
        <div class="stat-cell"><span class="lab">Stock on hand</span><div class="v">${mat.stock ?? '—'}</div></div>
        <div class="stat-cell"><span class="lab">Stock value (CAD)</span><div class="v">${AppLocale.fmtCAD(mat.totValueOh)}</div></div>
        <div class="stat-cell"><span class="lab">P1 rate</span><div class="v ${mat.p1Flag !== 'OK' ? 'warn' : ''}">${mat.p1Flag === 'OK' ? mat.p1Rate.toFixed(2) : '—'} <small>/ mo</small></div></div>
        <div class="stat-cell"><span class="lab">P2 rate</span><div class="v ${mat.p2Flag !== 'OK' ? 'warn' : ''}">${mat.p2Flag === 'OK' ? mat.p2Rate.toFixed(2) : '—'} <small>/ mo</small></div></div>
        <!-- Row 2 · derived / time -->
        <div class="stat-cell"><span class="lab">Runway @ P2</span><div class="v">${mat.runway != null ? mat.runway + ' mo' : '—'}</div></div>
        ${lastConsCell}
        <div class="stat-cell"><span class="lab">P1 → P2 change</span><div class="v ${(mat.rateChange||0) > 200 ? 'warn' : ''}">${rcDisp}</div></div>
        <div class="stat-cell"><span class="lab">Pattern</span><div class="v ${mat.pattern === 'LUMPY' ? 'warn' : ''}">${mat.pattern}</div></div>
        <!-- Row 3 · adjusted / data-quality -->
        <div class="stat-cell"><span class="lab">Adj P2 (HCE excl)</span><div class="v">${adjDisp} <small>${mat.hceP2 && mat.hceP2.length ? '/ mo' : ''}</small></div></div>
        <div class="stat-cell"><span class="lab">Total (window)</span><div class="v">${mat.totalNet}</div></div>
        ${stockoutsCell}
        ${dropCauseCell}
      </div>

      ${renderMrpCompare(mat)}
      ${renderInvAdjTable(mat)}

      ${renderHceTable(mat)}

      <div class="actions-row">
        <button id="btnLlm" class="primary" ${state.llmInflight ? 'disabled' : ''}>${llmCfg ? '↻ Re-run LLM review' : '✦ Run LLM review'}</button>
        <span id="llmStatus"></span>
      </div>
      ${llmCfg ? renderLlmPanel(llmCfg) : ''}
    `;

    // APP-E11 — chart 30% wider (was 720). Caveat caption + legend toggles
    // wired right after render so toggle state applies to the freshly drawn SVG.
    AppChart.render($('#chartHost'), mat, { width: 936, height: 320 });
    wireChartToggles();

    // Bind LLM
    $('#btnLlm').addEventListener('click', () => runLlmReview(mat));

    // APP-E26 (2026-05-17) — Bind material-number copy button. Tiny QoL
    // ahead of the "Trace it!" cross-tool button (APP-T-07). Uses async
    // Clipboard API with fallback for non-secure contexts (file:// in older
    // browsers); brief glyph swap as visual confirm.
    const copyBtn = $('#btnCopyMat');
    if (copyBtn && !copyBtn._wired) {
      copyBtn._wired = true;
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const orig = copyBtn.textContent;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(mat.material);
          } else {
            // Fallback for non-secure contexts: temporary textarea + execCommand
            const ta = document.createElement('textarea');
            ta.value = mat.material;
            ta.setAttribute('readonly', '');
            ta.style.position = 'absolute'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          copyBtn.classList.add('copied');
          copyBtn.textContent = '✓';
        } catch (err) {
          copyBtn.classList.add('failed');
          copyBtn.textContent = '✕';
          console.warn('Clipboard write failed:', err);
        }
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.classList.remove('failed');
          copyBtn.textContent = orig;
        }, 1200);
      });
    }
  }

  /* ─── APP-E11 · Chart legend toggle wiring ──────────────────────────────
     Each checkbox toggles a CSS class on the chart-host. The corresponding
     CSS rule hides the relevant SVG layer (consumption polyline or SOH
     group). Called every render — checkbox state is the source of truth. */
  function wireChartToggles(){
    const host = $('#chartHost');
    const cb1  = $('#chartToggleConsumption');
    const cb2  = $('#chartToggleSoh');
    if (!host) return;
    function apply(){
      if (cb1) host.classList.toggle('hide-cum', !cb1.checked);
      if (cb2) host.classList.toggle('hide-soh', !cb2.checked);
    }
    apply();
    if (cb1 && !cb1._wired) { cb1.addEventListener('change', apply); cb1._wired = true; }
    if (cb2 && !cb2._wired) { cb2.addEventListener('change', apply); cb2._wired = true; }
  }

  /* ─── MRP Settings Comparison: Current (shaded) vs Recommended (shaded) ─ */
  function renderMrpCompare(mat){
    // Has anything to show?
    const hasCurrent = mat.mrpType || mat.cmin != null || mat.cmax != null || mat.safetyStock != null;
    const hasRec     = mat.recMrpType || mat.recMin != null || mat.recMax != null;
    if (!hasCurrent && !hasRec) return '';

    const eq = (a, b) => {
      if (a == null || b == null) return false;
      const na = parseFloat(a), nb = parseFloat(b);
      if (!isNaN(na) && !isNaN(nb)) return Math.round(na) === Math.round(nb);
      return String(a) === String(b);
    };

    const rows = [
      { label:'MRP type',     cur: mat.mrpType || '—',                                       rec: mat.recMrpType || '—' },
      { label:'Min',          cur: mat.cmin != null ? mat.cmin : '—',                        rec: mat.recMin != null ? mat.recMin : '—' },
      { label:'Max',          cur: mat.cmax != null ? mat.cmax : '—',                        rec: mat.recMax != null ? mat.recMax : '—' },
      { label:'Safety Stock', cur: mat.safetyStock != null ? mat.safetyStock : '—',          rec: '—', recOmitted: true }
    ];
    const trs = rows.map(r => {
      const changed = !r.recOmitted && r.cur !== '—' && r.rec !== '—' && !eq(r.cur, r.rec);
      return `
        <tr class="${changed ? 'changed' : ''}">
          <td class="lab">${escapeHtml(r.label)}</td>
          <td class="current">${escapeHtml(String(r.cur))}</td>
          <td class="rec">${escapeHtml(String(r.rec))}</td>
        </tr>`;
    }).join('');

    return `
      <div class="mrp-compare">
        <div class="mrp-compare-head">
          <h4>MRP Settings · Current vs Recommended</h4>
          <span class="hint">Yellow rows = recommendation differs from current. Safety Stock is informational (not modelled in v2 algorithm).</span>
        </div>
        <table class="mrp-compare-table">
          <thead>
            <tr>
              <th></th>
              <th class="current-head">Current</th>
              <th class="rec-head">Recommended</th>
            </tr>
          </thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    `;
  }

  /* ─── Inv Adj events table (rendered below MRP comparison, before HCE) ─ */
  function renderInvAdjTable(mat){
    const evs = mat.invAdj || [];
    if (!evs.length) return '';
    const rows = evs.map(e => `
      <tr>
        <td>${escapeHtml(e.date)}</td>
        <td>${escapeHtml(e.order || '—')}</td>
        <td>${escapeHtml(e.equipment || '—')}</td>
        <td class="q">${e.qty}</td>
        <td title="${escapeAttr(e.reasons)}">${escapeHtml(e.reasons.length > 50 ? e.reasons.slice(0, 50) + '…' : e.reasons)}</td>
      </tr>`).join('');
    return `
      <div style="margin-bottom:14px;">
        <div class="label" style="margin-bottom:6px;color:var(--status-warn);">
          Inventory Adjustments (excluded from rate)
        </div>
        <table class="hce-table">
          <thead><tr><th>Date</th><th>Order</th><th>Equip</th><th>Qty</th><th>Reason</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
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
    // APP-E13 — grouped action row. Order chosen so the most-used path runs
    // left-to-right: open the data-quality review, pick PDF/Excel/JSON
    // outputs, then optionally run/reload an LLM review.
    host.innerHTML = `
      <div class="export-group">
        <span class="export-group-label">Data quality</span>
        <div class="export-group-buttons">
          <button id="btnInvAdj" class="ghost" title="Open the Inventory Adjustment review modal — flags MB51 dates with anomalously high issue-transaction counts (likely cycle counts) so they can be excluded from rate math.">⚠ Inv Adj review</button>
        </div>
      </div>

      <div class="export-group">
        <span class="export-group-label">PDF</span>
        <div class="export-group-buttons">
          <button id="btnPdfPack" class="primary" title="One PDF, one page per selected material (chart + key stats + MRP comparison + HCE + Inv Adj). Right-click a row in the list to 'Mark for PDF print', then click here.">⤓ PDF Pack (selected)</button>
        </div>
      </div>

      <div class="export-group">
        <span class="export-group-label">Excel</span>
        <div class="export-group-buttons">
          <button id="btnExportBucket" class="primary" title="One Excel workbook for the currently-selected bucket only.">⤓ Excel — this bucket</button>
          <button id="btnExportCombined" class="primary" title="One Excel workbook containing every bucket in this analysis, on separate tabs.">⤓ Excel — all (1 file)</button>
          <button id="btnExportAll" class="ghost" title="One Excel workbook per bucket, downloaded in sequence (useful when the combined file is too large to open).">⤓ Excel — all (separate files)</button>
        </div>
      </div>

      <div class="export-group">
        <span class="export-group-label">JSON</span>
        <div class="export-group-buttons">
          <button id="btnDownloadJson" class="primary" title="Download the canonical intake JSON for this analysis (everything the pipeline read in — parsed MB51, IW39, Fleet, Inventory Master, parameters, metadata). Safe to share / reload later via the Intake page.">⤓ Canonical dataset</button>
        </div>
      </div>

      <div class="export-group">
        <span class="export-group-label">LLM</span>
        <div class="export-group-buttons">
          <button id="btnMassReview" class="primary" title="Pick up to 50 materials from this bucket and run the LLM against each one in sequence. Produces an Excel + JSON deliverable. In-memory only — wiped on modal close unless you download.">✦ Mass review (run)</button>
          <button id="btnLoadMassReview" class="ghost" title="Reload a previously-downloaded Mass-Review JSON. Use this after a session was wiped (closed) to view the saved LLM annotations again. The matching canonical intake JSON must already be loaded on this page.">⤒ Reload saved review</button>
        </div>
      </div>

      <span id="exportProgress" class="export-progress" style="display:none;"></span>
      <input type="file" id="loadMassReviewInput" accept=".json" style="display:none;" />
    `;
    $('#btnInvAdj').addEventListener('click', openInvAdjModal);
    $('#btnPdfPack').addEventListener('click', openPdfPackModal);
    $('#btnMassReview').addEventListener('click', openMassReview);
    renderBulkCounters();
    $('#btnLoadMassReview').addEventListener('click', () => $('#loadMassReviewInput').click());
    $('#loadMassReviewInput').addEventListener('change', handleMassReviewUpload);
    $('#btnExportBucket').addEventListener('click', exportThisBucket);
    $('#btnExportCombined').addEventListener('click', exportCombined);
    $('#btnExportAll').addEventListener('click', exportAllBuckets);
    $('#btnDownloadJson').addEventListener('click', downloadCanonicalJson);
  }

  /* ─── APP-E13 · Canonical-dataset JSON download ───────────────────────
     Serializes the in-memory canonical intake JSON (everything the pipeline
     read in) and triggers a browser download. Filename derives from the
     metadata.assessmentName + runDate so it lands as a re-loadable artifact.
     Nothing leaves the browser — pure local download. */
  function downloadCanonicalJson(){
    if (!state.json) { setExportProgress('No analysis loaded'); return; }
    try {
      const json = state.json;
      const text = JSON.stringify(json, null, 2);
      const safe = s => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
      const name = safe(json?.metadata?.assessmentName || 'assessment');
      const date = (state.result?.runDate || json?.metadata?.runDate || '').slice(0, 10);
      const fname = `${name}${date ? '-' + date : ''}-canonical.json`;
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportProgress(`Downloaded ${fname}`);
      setTimeout(() => setExportProgress(''), 3000);
    } catch (err) {
      setExportProgress(`JSON download failed: ${err.message}`);
    }
  }
  function setExportProgress(msg){
    const el = $('#exportProgress');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
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
     PDF PACK EXPORT (v2.0)
     Per-material PDF page (chart + stats + MRP compare + HCE + Inv Adj),
     selection modal pre-checked from state.marked.pdf, no row cap.
  ═════════════════════════════════════════════════════════════════════════ */
  function openPdfPackModal(){
    const b = currentBucket();
    if (!b) { toast('No bucket selected', 'warn'); return; }
    if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
      toast('jsPDF library not loaded yet — try again in a moment.', 'crit');
      return;
    }
    state._pdfPack = state._pdfPack || { selected: new Set(), running: false };
    // Pre-check materials marked via right-click
    state._pdfPack.selected = new Set([...state.marked.pdf].filter(m => b.materials.some(x => x.material === m)));
    $('#pdfBucketName').textContent = b.name;
    $('#pdfModePill').textContent = 'Select';
    $('#pdfModePill').className = 'mass-mode-pill';
    showPdfModal();
    renderPdfSelect();
    // Bind close
    const closeBtn = $('#pdfClose');
    if (closeBtn && !closeBtn._pdfBound) {
      closeBtn.addEventListener('click', closePdfModal);
      closeBtn._pdfBound = true;
    }
    const backdrop = $('#pdfModal').querySelector('.mass-backdrop');
    if (backdrop && !backdrop._pdfBound) {
      backdrop.addEventListener('click', closePdfModal);
      backdrop._pdfBound = true;
    }
  }
  function showPdfModal(){
    const m = $('#pdfModal');
    m.classList.remove('hidden'); m.setAttribute('aria-hidden','false');
  }
  function closePdfModal(){
    if (state._pdfPack && state._pdfPack.running) {
      if (!confirm('PDF export is still running. Close anyway?')) return;
    }
    const m = $('#pdfModal');
    m.classList.add('hidden'); m.setAttribute('aria-hidden','true');
  }

  function renderPdfSelect(){
    const bucket = currentBucket();
    const body = $('#pdfBody');
    const foot = $('#pdfFoot');
    const sel  = state._pdfPack.selected;

    const cols = [
      { l:'' }, { l:'TL' }, { l:'Material' }, { l:'Description' },
      { l:'Total' }, { l:'P2/mo' }, { l:'Pattern' }
    ];
    const thead = cols.map(c => `<th>${c.l}</th>`).join('');
    const tbody = bucket.materials.map(m => {
      const checked = sel.has(m.material) ? 'checked' : '';
      return `
        <tr data-material="${escapeAttr(m.material)}">
          <td><input type="checkbox" data-mat="${escapeAttr(m.material)}" ${checked} /></td>
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
        <span>Pick materials to include in the PDF pack — one page per material:</span>
        <span class="mass-select-counter" id="pdfSelCounter">${sel.size} selected</span>
      </div>
      <div class="list-table-wrap" style="max-height:480px;">
        <table class="list-table">
          <thead><tr>${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
    body.querySelectorAll('input[type=checkbox][data-mat]').forEach(cb => {
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => {
        const mat = cb.dataset.mat;
        if (cb.checked) sel.add(mat); else sel.delete(mat);
        $('#pdfSelCounter').textContent = `${sel.size} selected`;
      });
    });

    foot.innerHTML = `
      <button id="pdfSelAll"   class="ghost">Select all visible</button>
      <button id="pdfSelMarked" class="ghost">Select marked only</button>
      <button id="pdfSelClear" class="ghost">Clear</button>
      <span class="spacer"></span>
      <span class="stat">Output: A4 portrait · 1 page / material</span>
      <button id="pdfStart" class="primary" ${sel.size === 0 ? 'disabled' : ''}>⤓ Build PDF (${sel.size})</button>
    `;
    $('#pdfSelAll').addEventListener('click', () => {
      bucket.materials.forEach(m => sel.add(m.material));
      renderPdfSelect();
    });
    $('#pdfSelMarked').addEventListener('click', () => {
      sel.clear();
      [...state.marked.pdf].filter(m => bucket.materials.some(x => x.material === m)).forEach(m => sel.add(m));
      renderPdfSelect();
    });
    $('#pdfSelClear').addEventListener('click', () => { sel.clear(); renderPdfSelect(); });
    $('#pdfStart').addEventListener('click', buildPdfPack);
  }

  async function buildPdfPack(){
    const bucket = currentBucket();
    const sel = state._pdfPack.selected;
    const mats = bucket.materials.filter(m => sel.has(m.material));
    if (mats.length === 0) return;

    // Switch modal to progress view
    state._pdfPack.running = true;
    $('#pdfModePill').textContent = 'Building';
    $('#pdfModePill').className = 'mass-mode-pill running';
    const body = $('#pdfBody');
    const foot = $('#pdfFoot');
    body.innerHTML = `
      <div class="mass-progress">
        <span class="label">Progress</span>
        <span class="now" id="pdfNow">Preparing…</span>
        <div class="mass-progress-bar"><div id="pdfBar" style="width:0%"></div></div>
        <span class="mass-progress-pct" id="pdfPct">0 / ${mats.length}</span>
      </div>
      <div class="panel-sub" style="font-size:11.5px;color:var(--text-muted);margin-top:12px;">
        Rendering each material's chart to PNG and laying out the page tables.
        Larger packs (50+ materials) take 15-30 seconds.
      </div>
    `;
    foot.innerHTML = `<span class="ia-foot-info">Hold tight — building the PDF…</span>`;

    try {
      const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
      const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        $('#pdfNow').textContent = `Page ${i + 1} / ${mats.length} · ${m.material}`;
        $('#pdfBar').style.width = `${Math.round((i / mats.length) * 100)}%`;
        $('#pdfPct').textContent = `${i} / ${mats.length}`;
        if (i > 0) doc.addPage();
        await renderMaterialToPdf(doc, m, bucket, i + 1, mats.length);
      }
      $('#pdfBar').style.width = '100%';
      $('#pdfPct').textContent = `${mats.length} / ${mats.length}`;
      $('#pdfNow').textContent = 'Writing file…';

      const assess = (state.json.metadata.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g,'_');
      const safeBucket = bucket.name.replace(/[^A-Za-z0-9_-]+/g,'_');
      doc.save(`PDF_Pack_${assess}_${safeBucket}_${state.result.runDate}.pdf`);

      // Done view
      $('#pdfModePill').textContent = 'Done'; $('#pdfModePill').className = 'mass-mode-pill done';
      body.innerHTML = `
        <div class="ia-empty">
          <span class="big">✓ PDF saved</span>
          ${mats.length} page${mats.length === 1 ? '' : 's'} written to disk.
        </div>
      `;
      foot.innerHTML = `
        <span class="ia-foot-info">PDF Pack downloaded.</span>
        <span class="spacer"></span>
        <button id="pdfDone" class="primary">Close</button>
      `;
      $('#pdfDone').addEventListener('click', closePdfModal);
    } catch (e) {
      console.error(e);
      body.innerHTML = `<div class="ia-empty"><span class="big" style="color:var(--status-crit);">✗ PDF failed</span>${escapeHtml(e.message || String(e))}</div>`;
      foot.innerHTML = `<span class="spacer"></span><button id="pdfDone" class="ghost">Close</button>`;
      $('#pdfDone').addEventListener('click', closePdfModal);
    } finally {
      state._pdfPack.running = false;
    }
  }

  /* ─── Per-material PDF page (A4 portrait, 210×297 mm) ─── */
  async function renderMaterialToPdf(doc, m, bucket, pageIdx, pageTotal){
    const W = 210, H = 297, M = 12;       // mm
    const params = state.json.parameters;
    const assess = state.json.metadata.assessmentName || '(unnamed)';
    const runDate = state.result.runDate;

    // ── Header band ──────────────────────────────────────────────────────
    doc.setFillColor(31, 56, 100);                 // navy
    doc.rect(0, 0, W, 18, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Inventory Optimization · Consumption Profile', M, 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`${assess}  |  Bucket: ${bucket.name}  |  Run: ${runDate}`, M, 13.5);
    doc.text(`Page ${pageIdx} / ${pageTotal}`, W - M, 13.5, { align: 'right' });

    // ── Material title row ──────────────────────────────────────────────
    let y = 24;
    doc.setTextColor(20, 20, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(String(m.material), M, y);
    // TL pill on right
    const tl = m.trafficLight;
    const tlColor = ({ GREEN:[0,176,80], BLUE:[52,152,219], ORANGE:[255,140,0], RED:[192,0,0], PURPLE:[155,89,182], GREY:[191,191,191] })[tl] || [127,127,127];
    doc.setFillColor(tlColor[0], tlColor[1], tlColor[2]);
    const pillW = 26, pillX = W - M - pillW, pillY = y - 5.5;
    doc.rect(pillX, pillY, pillW, 7, 'F');
    doc.setTextColor(tl === 'GREY' ? 0 : 255, tl === 'GREY' ? 0 : 255, tl === 'GREY' ? 0 : 255);
    doc.setFontSize(10);
    doc.text(tl, pillX + pillW/2, y - 0.5, { align: 'center' });

    y += 5;
    doc.setTextColor(80, 80, 90);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    const descLines = doc.splitTextToSize(m.description || '', W - 2*M - 30);
    doc.text(descLines, M, y);
    y += descLines.length * 4.2;

    // Action banner
    y += 3;
    doc.setFillColor(245, 247, 250);
    doc.setDrawColor(tlColor[0], tlColor[1], tlColor[2]);
    doc.setLineWidth(0.8);
    doc.rect(M, y, W - 2*M, 12, 'FD');
    doc.setTextColor(40, 40, 50);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('ALGORITHMIC RECOMMENDATION', M + 3, y + 4.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const actLines = doc.splitTextToSize(m.action || '', W - 2*M - 6);
    doc.text(actLines.slice(0, 2), M + 3, y + 9);
    y += 16;

    // ── Chart ────────────────────────────────────────────────────────────
    try {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1100px;height:430px;visibility:hidden;background:#0C2D3B;';
      document.body.appendChild(host);
      const svg = AppChart.render(host, m, { width: 1100, height: 430 });
      const png = await AppChart.toPng(svg, 1.6);
      document.body.removeChild(host);
      const chartW = W - 2*M;
      const chartH = chartW * (430 / 1100);
      doc.addImage(png, 'PNG', M, y, chartW, chartH);
      y += chartH + 4;
    } catch (e) {
      doc.setTextColor(192, 0, 0);
      doc.text(`Chart render error: ${e.message || e}`, M, y);
      y += 5;
    }

    // ── Stat grid (2 columns) — replaced by autoTable for cleaner output ──
    const rcDisp = m.rateChange != null ? `${m.rateChange}%` : 'N/A';
    const adjDisp = (m.hceP2 && m.hceP2.length && m.adjP2Flag === 'OK') ? `${m.adjP2Rate.toFixed(2)} / mo` : '—';
    const stats = [
      ['P1 rate',          m.p1Flag === 'OK' ? `${m.p1Rate.toFixed(2)} / mo` : '—',
       'P2 rate',          m.p2Flag === 'OK' ? `${m.p2Rate.toFixed(2)} / mo` : '—'],
      ['Adj P2 (HCE excl)', adjDisp,
       'P1 → P2 change',   rcDisp],
      ['Total (window)',   String(m.totalNet ?? '—'),
       'Pattern',          m.pattern || '—'],
      ['Stock on hand',    m.stock != null ? String(m.stock) : '—',
       'Runway @ P2',      m.runway != null ? `${m.runway} mo` : '—'],
      ['WO count (window)', m.woCount != null ? String(m.woCount) : '—',
       'Multi-model',      m.multiModelFlag || 'Single']
    ];
    doc.autoTable({
      startY: y,
      head: [['Stat', 'Value', 'Stat', 'Value']],
      body: stats,
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 1.6, lineColor: [200, 200, 210], lineWidth: 0.15 },
      headStyles: { fillColor: [64, 64, 64], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 36, fillColor: [240, 240, 245] },
        1: { cellWidth: 56 },
        2: { fontStyle: 'bold', cellWidth: 36, fillColor: [240, 240, 245] },
        3: { cellWidth: 56 }
      },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 4;

    // ── MRP Settings Comparison ──────────────────────────────────────────
    const cmpBody = [
      ['MRP type', m.mrpType || '—', m.recMrpType || m.mrpType || '—'],
      ['Min',      m.cmin != null ? String(m.cmin) : '—',  m.recMin != null ? String(m.recMin) : '—'],
      ['Max',      m.cmax != null ? String(m.cmax) : '—',  m.recMax != null ? String(m.recMax) : '—'],
      ['Safety stock', m.safetyStock != null ? String(m.safetyStock) : '—', '—']
    ];
    doc.autoTable({
      startY: y,
      head: [['MRP Settings', 'Current', 'Recommended']],
      body: cmpBody,
      theme: 'grid',
      styles: { fontSize: 8.5, cellPadding: 1.6, lineColor: [200, 200, 210], lineWidth: 0.15 },
      headStyles: { fillColor: [48, 84, 150], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      columnStyles: {
        0: { fontStyle: 'bold', cellWidth: 36, fillColor: [240, 240, 245] },
        1: { cellWidth: 56, halign: 'center' },
        2: { cellWidth: 56, halign: 'center', textColor: [22, 138, 145] }
      },
      didParseCell: (data) => {
        if (data.row.section === 'body' && data.column.index >= 1 && data.row.index < 3) {
          const cur = cmpBody[data.row.index][1];
          const rec = cmpBody[data.row.index][2];
          if (cur !== '—' && rec !== '—' && cur !== rec) {
            data.cell.styles.fillColor = [255, 243, 205];
          }
        }
      },
      margin: { left: M, right: M }
    });
    y = doc.lastAutoTable.finalY + 4;

    // ── HCE events table (if any) ────────────────────────────────────────
    if (m.hceP2 && m.hceP2.length && y < H - 50) {
      doc.autoTable({
        startY: y,
        head: [['Period', 'WO', 'Date', 'Equipment', 'Qty', '% of P2']],
        body: m.hceP2.map(e => [e.period || 'P2', String(e.order || '—'), e.date || '', e.equipment || '—', String(e.qty), `${e.pct}%`]),
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 1.4, lineColor: [200, 200, 210], lineWidth: 0.15 },
        headStyles: { fillColor: [198, 89, 17], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        bodyStyles:  { fillColor: [255, 242, 204] },
        margin: { left: M, right: M },
        didDrawPage: () => {
          doc.setFontSize(9); doc.setTextColor(123, 79, 0); doc.setFont('helvetica', 'bold');
          doc.text('High Consumption Events — P2', M, y - 1);
        }
      });
      y = doc.lastAutoTable.finalY + 3;
    }

    // ── Inv Adj events (if any) ──────────────────────────────────────────
    if (m.invAdj && m.invAdj.length && y < H - 40) {
      doc.autoTable({
        startY: y,
        head: [['Date', 'Order', 'Equipment', 'Qty', 'Reason']],
        body: m.invAdj.map(e => [e.date || '', String(e.order || '—'), e.equipment || '—', String(e.qty), e.reasons || '']),
        theme: 'grid',
        styles: { fontSize: 8, cellPadding: 1.4, lineColor: [200, 200, 210], lineWidth: 0.15 },
        headStyles: { fillColor: [155, 89, 182], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        bodyStyles:  { fillColor: [232, 216, 240] },
        margin: { left: M, right: M },
        didDrawPage: () => {
          doc.setFontSize(9); doc.setTextColor(110, 50, 130); doc.setFont('helvetica', 'bold');
          doc.text('Inventory Adjustments (excluded from rate)', M, y - 1);
        }
      });
      y = doc.lastAutoTable.finalY + 3;
    }

    // ── Footer (every page) ──────────────────────────────────────────────
    doc.setFontSize(7);
    doc.setTextColor(140, 140, 150);
    doc.setFont('helvetica', 'normal');
    doc.text(`Generated ${AppLocale.localDateTimeISO().slice(0, 16)}  ·  Inventory Optimization v2.0.0-dev  ·  CAD  ·  github.com/aisandbox-bj/Inventory_Optimization`, M, H - 6);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     INVENTORY ADJUSTMENT REVIEW (v2.0)
     Auto-popup after first analysis when day-count spikes (≥ N·σ) are
     detected. User checks dates to confirm; pipeline re-runs with those
     dates excluded from rate calculations (HCE-equivalent, labelled Inv Adj).
  ═════════════════════════════════════════════════════════════════════════ */

  function openInvAdjModal(){
    const modal = $('#invAdjModal');
    if (!modal || !state.result) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    renderInvAdjModal();
    // Close handlers (idempotent — same handler added each open)
    const closeBtn = $('#invAdjClose');
    if (closeBtn && !closeBtn._iaBound) {
      closeBtn.addEventListener('click', closeInvAdjModal);
      closeBtn._iaBound = true;
    }
    const backdrop = modal.querySelector('.mass-backdrop');
    if (backdrop && !backdrop._iaBound) {
      backdrop.addEventListener('click', closeInvAdjModal);
      backdrop._iaBound = true;
    }
  }
  async function closeInvAdjModal(){
    const modal = $('#invAdjModal');
    if (modal) {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
    }
    // APP-E25 (2026-05-17) — ANY close of the Inv-Adj modal counts as
    // "reviewed" for the current assessment so the auto-popup doesn't fire
    // again on subsequent Analysis page loads. Skip / X / backdrop / Confirm
    // all flow through here (Confirm has its own state update + persist
    // before calling close; this guard is idempotent for that path).
    if (state.json && state.json.parameters && !state.json.parameters.invAdjReviewed) {
      state.json.parameters.invAdjReviewed = true;
      try { await AppStorage.set('intake.current', state.json); } catch {}
    }
  }

  function renderInvAdjModal(){
    const ia = state.result && state.result.invAdjAnalysis;
    const body = $('#invAdjBody');
    const foot = $('#invAdjFoot');
    if (!ia) { body.innerHTML = '<div class="ia-empty">no analysis loaded</div>'; foot.innerHTML = ''; return; }

    const confirmed = new Set(state.json.parameters.invAdjConfirmedDates || []);

    // Summary tiles
    const summaryHtml = `
      <div class="ia-summary">
        <div class="ia-stat">
          <span class="lab">Days analysed</span>
          <div class="v">${ia.dayCount.toLocaleString()}</div>
        </div>
        <div class="ia-stat">
          <span class="lab">Avg daily issues</span>
          <div class="v">${ia.mean.toLocaleString()} <small>/ day</small></div>
        </div>
        <div class="ia-stat">
          <span class="lab">Std deviation</span>
          <div class="v">${ia.stddev.toLocaleString()} <small>σ</small></div>
        </div>
        <div class="ia-stat">
          <span class="lab">Threshold</span>
          <div class="v">${ia.threshold.toLocaleString()} <small>mean + ${ia.sigmaN}σ</small></div>
        </div>
      </div>
    `;

    // Empty state
    if (ia.candidates.length === 0) {
      body.innerHTML = summaryHtml + `
        <div class="ia-empty">
          <span class="big">✓ No anomalies</span>
          No MB51 days exceed <b>mean + ${ia.sigmaN}σ</b> issue counts at the current threshold.
          Lower <code>invAdjSigmaThreshold</code> in Settings to surface more candidates.
        </div>
      `;
      foot.innerHTML = `
        <span class="ia-foot-info">Threshold configurable in Settings → Parameter defaults.</span>
        <span class="spacer"></span>
        <button id="iaSkip" class="ghost">Close</button>
      `;
      $('#iaSkip').addEventListener('click', closeInvAdjModal);
      return;
    }

    // Find the max count to scale the bar visualisation
    const maxCount   = Math.max(...ia.candidates.map(c => c.count), ia.mean);
    const avgFracPct = Math.min(100, (ia.mean / maxCount) * 100);

    const rowsHtml = ia.candidates.map(c => {
      const dayFracPct = Math.min(100, (c.count / maxCount) * 100);
      const wasConfirmed = confirmed.has(c.date);
      return `
        <tr class="${wasConfirmed ? 'previously-confirmed' : ''}">
          <td class="chk">
            <input type="checkbox" data-date="${escapeAttr(c.date)}" ${wasConfirmed ? 'checked' : ''} />
          </td>
          <td class="date">${escapeHtml(c.date)}</td>
          <td class="dow">${escapeHtml(c.dayOfWeek)}</td>
          <td class="num">${c.count.toLocaleString()}</td>
          <td class="ia-bar-cell">
            <div class="ia-bar">
              <div class="day-fill" style="width:${dayFracPct.toFixed(1)}%"></div>
              <div class="avg-marker" style="left:${avgFracPct.toFixed(1)}%"></div>
              <div class="day-count">${c.count}</div>
            </div>
          </td>
          <td class="sigma">${c.sigmaAbove}σ</td>
          <td class="num">${c.materialsAffected.toLocaleString()}</td>
          <td class="num">${c.totalQty.toLocaleString()}</td>
        </tr>
      `;
    }).join('');

    body.innerHTML = summaryHtml + `
      <div class="ia-intro">
        <b>${ia.candidates.length} MB51 date${ia.candidates.length === 1 ? '' : 's'}</b> exceed the
        <b>${ia.sigmaN}σ</b> threshold — these days have an unusually high count of issue
        transactions and are likely cycle counts or stock adjustments rather than genuine
        consumption. Tick the dates you want to <b>exclude from the rate calculation</b>; the
        pipeline will re-run and treat those transactions as <em>Inv Adj</em> events (same
        exclusion mechanic as HCE, different label).
        <span class="hint">Sigma threshold configurable in <a href="../settings/settings.html#params">Settings</a> · current default ${ia.sigmaN}σ.</span>
      </div>

      <table class="ia-table">
        <thead>
          <tr>
            <th class="chk">✓</th>
            <th>Date</th>
            <th>Day</th>
            <th class="num">Count</th>
            <th>Avg vs day</th>
            <th class="num">σ above</th>
            <th class="num">Materials</th>
            <th class="num">Total qty</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;

    foot.innerHTML = `
      <span class="ia-foot-info"><b id="iaSelectedCount">${ia.candidates.filter(c => confirmed.has(c.date)).length}</b> of ${ia.candidates.length} selected</span>
      <button id="iaAllOn"  class="ghost">Select all</button>
      <button id="iaAllOff" class="ghost">Clear</button>
      <span class="spacer"></span>
      <button id="iaSkip" class="ghost">Skip / Cancel</button>
      <button id="iaConfirm" class="primary">✓ Confirm &amp; re-run analysis</button>
    `;

    // Wire checkbox change → live counter
    body.querySelectorAll('input[type=checkbox][data-date]').forEach(cb => {
      cb.addEventListener('change', () => {
        const n = body.querySelectorAll('input[type=checkbox][data-date]:checked').length;
        const el = $('#iaSelectedCount');
        if (el) el.textContent = n;
      });
    });
    $('#iaAllOn').addEventListener('click', () => {
      body.querySelectorAll('input[type=checkbox][data-date]').forEach(cb => cb.checked = true);
      body.querySelectorAll('input[type=checkbox][data-date]').forEach(cb => cb.dispatchEvent(new Event('change')));
    });
    $('#iaAllOff').addEventListener('click', () => {
      body.querySelectorAll('input[type=checkbox][data-date]').forEach(cb => cb.checked = false);
      body.querySelectorAll('input[type=checkbox][data-date]').forEach(cb => cb.dispatchEvent(new Event('change')));
    });
    $('#iaSkip').addEventListener('click', closeInvAdjModal);
    $('#iaConfirm').addEventListener('click', applyInvAdjConfirmations);
  }

  async function applyInvAdjConfirmations(){
    const body  = $('#invAdjBody');
    const dates = [...body.querySelectorAll('input[type=checkbox][data-date]:checked')]
                    .map(cb => cb.dataset.date)
                    .sort();
    state.json.parameters.invAdjConfirmedDates = dates;
    // Persist back to the canonical JSON in storage so re-loads keep the choice
    try { await AppStorage.set('intake.current', state.json); } catch {}
    closeInvAdjModal();
    toast(`Excluded ${dates.length} inventory-adjustment date${dates.length===1?'':'s'} — re-running analysis…`, 'ok');
    // Re-run pipeline (don't re-popup the modal)
    await runPipelineNow(false);
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
    // Pre-check materials marked for review via right-click (capped at MAX_SELECTION)
    const max = AppMassLlm.MAX_SELECTION;
    const preChecked = new Set();
    for (const mat of b.materials) {
      if (state.marked.review.has(mat.material) && preChecked.size < max) {
        preChecked.add(mat.material);
      }
    }
    state.mass.selected = preChecked;
    showMassModal();
  }

  function showMassModal(){
    const modal = $('#massModal');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    $('#massBucketName').textContent = currentBucket() ? currentBucket().name : '—';
    hideMassChip();
    renderMassView();
    // v2.1.1: isolate the modal from background interactions.
    // Locks body scroll + marks every direct body child EXCEPT the modal as
    // `inert` so pointer/keyboard events on the background page are ignored
    // entirely. Reversed in hideMassModal.
    document.body.style.overflow = 'hidden';
    Array.from(document.body.children).forEach(el => {
      if (el === modal || el.id === 'massChip' || el.classList.contains('toast')) return;
      try { el.inert = true; } catch (_) { el.setAttribute('inert', ''); }
    });
    // Move focus into the dialog so Tab order starts there.
    setTimeout(() => {
      const closeBtn = modal.querySelector('#massClose');
      if (closeBtn) closeBtn.focus();
    }, 0);
    // Esc to dismiss (treats as soft close)
    document.addEventListener('keydown', massEscHandler);
  }
  function hideMassModal(){
    const modal = $('#massModal');
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    // v2.1.1: restore background interactions
    document.body.style.overflow = '';
    Array.from(document.body.children).forEach(el => {
      if (el === modal) return;
      try { el.inert = false; } catch (_) { el.removeAttribute('inert'); }
    });
    document.removeEventListener('keydown', massEscHandler);
  }
  function massEscHandler(e){ if (e.key === 'Escape') softCloseMassReview(); }

  /* Soft close — close window. State (mass session + cached LLM verdicts) is
     retained in memory and survives across modal opens/closes for the rest of
     the browser-tab session. v2.1.1 changed this behaviour: previously, closing
     the Results view forced a wipe with a confirm dialog. Operators wanted
     the verdicts to stick around for drill-down and (in later phases) PDF
     inclusion. Explicit wipe is now driven from the "⌫ Clear LLM data" button
     in the Results view footer. */
  function softCloseMassReview(){
    if (!state.mass) { hideMassModal(); return; }
    const s = state.mass.session;
    if (s && (s.status === 'running' || s.status === 'paused')) {
      hideMassModal();
      showMassChip();
      return;
    }
    // v2.1.1: results-view close is no longer destructive. Keep the chip
    // visible as a "results available — click to reopen" indicator.
    hideMassModal();
    if (state.mass && state.mass.session) showMassChip();
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
    const txt = chip.querySelector('.mass-chip-text');
    const reopen = chip.querySelector('.mass-chip-open');
    if (s.status === 'running' || s.status === 'paused') {
      txt.textContent = `Mass review: ${done} / ${s.total}`;
      if (reopen) reopen.textContent = 'Reopen';
    } else {
      // v2.1.1: completed/cancelled session — chip stays as a "results available" affordance
      txt.textContent = `Mass review · ${done} reviewed`;
      if (reopen) reopen.textContent = 'Reopen results';
    }
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
  // v2.1.1: Mass LLM selection table column definitions (Excel-style filterable).
  const MASS_SELECT_COLS = [
    { k:'trafficLight', l:'TL',          picker:'set'   },
    { k:'material',     l:'Material',    picker:'text'  },
    { k:'description',  l:'Description', picker:'text'  },
    { k:'totalNet',     l:'Total',       picker:'range' },
    { k:'p2Rate',       l:'P2/mo',       picker:'range' },
    { k:'pattern',      l:'Pattern',     picker:'set'   }
  ];

  function renderMassSelect(){
    const bucket = currentBucket();
    const body = $('#massBody');
    const foot = $('#massFoot');
    if (!bucket) { body.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted);">No bucket selected.</div>'; return; }

    const sel = state.mass.selected;
    const max = AppMassLlm.MAX_SELECTION;
    const overCap = sel.size > max;
    const filters = state._massSelectFilters;
    const sort    = state._massSelectSort;

    // Filter + sort the bucket's materials
    let rows = bucket.materials.filter(m => passesColFilters(m, filters));
    if (sort.key) {
      rows.sort((a, b) => {
        const va = a[sort.key], vb = b[sort.key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') {
          return sort.dir === 'asc' ? va - vb : vb - va;
        }
        return sort.dir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }

    const filteredVisible = rows.length;
    const totalInBucket   = bucket.materials.length;

    // Column headers: checkbox column (no filter) + Excel-style filter headers
    const thead = `<th class="mass-chk-th"></th>` + MASS_SELECT_COLS.map(c => {
      const sorted  = sort.key === c.k ? `sorted ${sort.dir === 'asc' ? 'asc' : ''}` : '';
      const fActive = colFilterActive(c.k, filters);
      return `
        <th class="sortable ${sorted}" data-k="${c.k}">
          <span class="th-inner">
            <span class="th-label" data-sort="${c.k}">${c.l}</span>
            <button class="th-filter ${fActive ? 'active' : ''}" data-filter="${c.k}" title="Filter ${c.l}">▾</button>
          </span>
        </th>`;
    }).join('');

    const tbody = rows.map(m => {
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

    const filterBadge = (filteredVisible !== totalInBucket)
      ? `<span class="mass-filter-badge">${filteredVisible} of ${totalInBucket} visible</span>` : '';

    body.innerHTML = `
      <div class="mass-select-info">
        <span>Pick materials to review — max <b>${max}</b>:</span>
        <span class="mass-select-counter ${overCap ? 'over' : ''}" id="massSelCounter">${sel.size} / ${max} selected</span>
        ${filterBadge}
      </div>
      <div class="list-table-wrap" style="max-height:480px;">
        <table class="list-table">
          <thead><tr id="massSelHead">${thead}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;

    // Checkbox change handlers
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

    // Sort by clicking column label
    $$('#massSelHead .th-label').forEach(lab => {
      lab.addEventListener('click', (e) => {
        e.stopPropagation();
        const k = lab.dataset.sort;
        if (sort.key === k) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else { sort.key = k; sort.dir = 'desc'; }
        renderMassSelect();
      });
    });
    // Filter caret click → popover scoped to mass-select state
    $$('#massSelHead .th-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openColFilterPopover(btn, {
          colDefs:    MASS_SELECT_COLS,
          colFilters: filters,
          data:       bucket.materials,
          onChange:   renderMassSelect
        });
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
      // v2.1.1: "Select all visible" respects the current filter
      rows.forEach(m => { if (!sel.has(m.material) && sel.size < max) sel.add(m.material); });
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

  // v2.1.1: Mass LLM results table column definitions (Excel-style filterable).
  const MASS_RESULTS_COLS = [
    { k:'status',      l:'Status',      picker:'set'   },
    { k:'material',    l:'Material',    picker:'text'  },
    { k:'description', l:'Description', picker:'text'  },
    { k:'preTL',       l:'Pre-LLM',     picker:'set'   },
    { k:'verdict',     l:'LLM verdict', picker:'set'   },
    { k:'notes',       l:'Notes',       picker:'text'  },
    { k:'latencyMs',   l:'Latency',     picker:'range' }
  ];

  /* v2.1.1: filter+sort the results array against modal-local filter state. */
  function filteredMassResults(results){
    const filters = state._massResultsFilters;
    const sort    = state._massResultsSort;
    let out = results.filter(r => passesColFilters(r, filters));
    if (sort.key) {
      out.sort((a, b) => {
        const va = a[sort.key], vb = b[sort.key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') {
          return sort.dir === 'asc' ? va - vb : vb - va;
        }
        return sort.dir === 'asc'
          ? String(va).localeCompare(String(vb))
          : String(vb).localeCompare(String(va));
      });
    }
    return out;
  }

  /* v2.1.1: shared thead markup + handler binding for Run + Results views. */
  function massResultsTheadHtml(){
    const filters = state._massResultsFilters;
    const sort    = state._massResultsSort;
    const cols = MASS_RESULTS_COLS.map(c => {
      const sorted  = sort.key === c.k ? `sorted ${sort.dir === 'asc' ? 'asc' : ''}` : '';
      const fActive = colFilterActive(c.k, filters);
      return `
        <th class="sortable ${sorted}" data-k="${c.k}">
          <span class="th-inner">
            <span class="th-label" data-sort="${c.k}">${c.l}</span>
            <button class="th-filter ${fActive ? 'active' : ''}" data-filter="${c.k}" title="Filter ${c.l}">▾</button>
          </span>
        </th>`;
    }).join('');
    return `<tr id="massResHead">${cols}</tr>`;
  }

  function bindMassResultsHeaders(s, refresh){
    $$('#massResHead .th-label').forEach(lab => {
      lab.addEventListener('click', (e) => {
        e.stopPropagation();
        const k = lab.dataset.sort;
        const sort = state._massResultsSort;
        if (sort.key === k) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
        else { sort.key = k; sort.dir = 'desc'; }
        refresh();
      });
    });
    $$('#massResHead .th-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openColFilterPopover(btn, {
          colDefs:    MASS_RESULTS_COLS,
          colFilters: state._massResultsFilters,
          data:       s.results,
          onChange:   refresh
        });
      });
    });
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

    const visible = filteredMassResults(s.results);
    const filterBadge = (visible.length !== s.results.length)
      ? `<span class="mass-filter-badge">${visible.length} of ${s.results.length} visible</span>` : '';

    const body = $('#massBody');
    body.innerHTML = `
      <div class="mass-progress">
        <span class="label">Progress</span>
        <span class="now" id="massNow">${escapeHtml(nowText)}</span>
        <div class="mass-progress-bar"><div style="width:${pct}%"></div></div>
        <span class="mass-progress-pct">${done} / ${s.total} ${filterBadge}</span>
      </div>
      <div class="list-table-wrap" style="max-height:440px;">
        <table class="mass-results-table">
          <thead>${massResultsTheadHtml()}</thead>
          <tbody>${renderMassRows(visible)}</tbody>
        </table>
      </div>
    `;
    bindMassResultsHeaders(s, renderMassRun);
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

  // v2.1.1: now accepts a rows array directly (filtered/sorted by caller)
  // rather than reaching for s.results — same callers, easier composition.
  function renderMassRows(rows){
    return rows.map(r => {
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
    const visible = filteredMassResults(s.results);
    const filterBadge = (visible.length !== s.results.length)
      ? `<span class="mass-filter-badge">${visible.length} of ${s.results.length} visible</span>` : '';
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
        <span class="mass-progress-pct">${s.results.filter(r => r.status !== 'pending').length} / ${s.total} ${filterBadge}</span>
      </div>
      <div class="list-table-wrap" style="max-height:540px;">
        <table class="mass-results-table">
          <thead>${massResultsTheadHtml()}</thead>
          <tbody>${renderMassRows(visible)}</tbody>
        </table>
      </div>
      <div class="panel-sub" style="margin-top:12px;font-size:11px;color:var(--text-muted);">
        Click any row to drill into that material's chart + LLM commentary on the main analysis page.
        <b>Results are retained in session</b> — closing this modal keeps them available; the floating chip
        will let you re-open. Click <b>⌫ Clear LLM data</b> when you're done to wipe.
      </div>
    `;
    const foot = $('#massFoot');
    foot.innerHTML = `
      <button id="massDownloadXlsx" class="primary">⤓ Download Excel</button>
      <button id="massDownloadJson" class="primary">⤓ Download JSON</button>
      <span class="spacer"></span>
      <span class="stat">Hash: <b>${escapeHtml(s.promptHash || '—')}</b></span>
      <button id="massClearData" class="danger">⌫ Clear LLM data</button>
    `;
    $('#massDownloadXlsx').addEventListener('click', downloadMassXlsx);
    $('#massDownloadJson').addEventListener('click', downloadMassJson);
    $('#massClearData').addEventListener('click', () => {
      if (confirm('Clear all in-memory LLM data — this mass-review session AND any single-review notes from this session. Make sure you have downloaded the Excel and / or JSON first. Proceed?')) {
        wipeAllLlm();
        hideMassModal();
      }
    });
    // v2.1.1: bind sortable/filterable headers + row drill-down
    bindMassResultsHeaders(s, renderMassResults);
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
