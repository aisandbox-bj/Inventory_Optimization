/* ═══════════════════════════════════════════════════════════════════════════
   Calibre Trace · v0.4-dev (sibling page bootstrap) · APP-T-03 · 2026-05-17
   ───────────────────────────────────────────────────────────────────────────
   Reads canonical JSON from AppStorage (key 'intake.current' — same source
   Analysis uses). Computes procurement chains for the selected material:
     Phase A : PR raised → PR released         (EBAN-BADAT → EBAN-FRGDT)
     Phase B : PR released → PO raised         (EBAN-FRGDT → EKKO-BEDAT)
     Phase C : PO raised → 3PL GR              (PO Date → MB51 MVT 107)
     Phase D : 3PL GR → Site WH receipt        (MB51 MVT 107 → MB51 MVT 109)
     Phase E : Site WH → first 261 consumption (MB51 MVT 109 → MB51 MVT 261)

   Chart rendering ports v0.3's swimlane (horizontal stacked bar, 5 phase
   datasets). v0.4 reads from canonical JSON instead of v0.3's hard-coded
   CHAINS array.

   Out of scope for T-03:
     - YoY / supplier scorecard / cancellation diagnostic / unit-cost views
       (port in T-04).
     - Sigma filter / right-click exclude (T-04 with the other views).
     - leadTimes.json export (T-06).
   ═════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const state = {
    json:             null,
    materials:        [],          // [{ material, description, prCount, mb51Count }]
    selectedMaterial: null,
    matSearch:        '',
    chains:           [],          // computed per selected material
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

  /* ═════════════════════════════════════════════════════════════════════════
     BOOT
  ═════════════════════════════════════════════════════════════════════════ */

  async function boot(){
    const json = await AppStorage.get('intake.current');
    if (!json) { renderNoIntake(); return; }
    state.json = json;
    const prHistory = (json.data && json.data.prHistory) || [];
    if (prHistory.length === 0) { renderNoPrHistory(); return; }

    renderBanner();
    state.materials = buildMaterialIndex(json);
    if (state.materials.length === 0) { renderNoMaterials(); return; }

    state.selectedMaterial = state.materials[0].material;
    showSection('materialPicker');
    showSection('materialDetail');
    renderMaterialList();
    renderMaterialDetail();
    bindSearch();
  }

  function showSection(id){
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function renderNoIntake(){
    $('#root').innerHTML = `
      <section class="loaded-banner">
        <div>
          <span class="lab">No intake loaded</span>
          <h2>Build a canonical JSON first</h2>
          <div class="sub">Go to the Intake page, drop your SAP exports including PR History, save → return here.</div>
        </div>
        <div class="row" style="grid-column:span 2;align-items:flex-end;">
          <a href="../intake/intake.html"><button class="primary">Go to Intake →</button></a>
        </div>
      </section>
    `;
  }

  function renderNoPrHistory(){
    const j = state.json;
    $('#root').innerHTML = `
      <section class="loaded-banner">
        <div>
          <span class="lab">Loaded intake — but no PR History</span>
          <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
          <div class="sub">Trace needs PR History data to render procurement chains. Re-open this assessment in Intake and drop your PR History export, then save and return here.</div>
        </div>
        <div class="row" style="grid-column:span 2;align-items:flex-end;">
          <a href="../intake/intake.html"><button class="primary">Add PR History →</button></a>
        </div>
      </section>
    `;
  }

  function renderNoMaterials(){
    $('#root').innerHTML = `
      <section class="loaded-banner">
        <div>
          <span class="lab">PR History loaded — but no usable rows</span>
          <h2>No materials matched after parse</h2>
          <div class="sub">Every PR History row has a blank material number, or every PR is fully cancelled / deleted. Check the source export.</div>
        </div>
      </section>
    `;
  }

  function renderBanner(){
    const j = state.json;
    const counts = countRows(j);
    $('#banner').innerHTML = `
      <div>
        <span class="lab">Loaded intake</span>
        <h2>${escapeHtml(j.metadata.assessmentName || '(unnamed assessment)')}</h2>
        <div class="sub">created ${escapeHtml((j.metadata.createdAt || '').replace('T', ' ').slice(0, 16))}</div>
      </div>
      <div class="row">
        <span class="lab">PR History</span>
        <span class="v">${(counts.prHistory || 0).toLocaleString()} lines</span>
        <span class="v">${state.materials ? state.materials.length.toLocaleString() : '—'} materials</span>
      </div>
      <div class="row">
        <span class="lab">Source data</span>
        <span class="v">${(counts.mb51 || 0).toLocaleString()} MB51</span>
        <span class="v">${(counts.inventoryMaster || 0).toLocaleString()} Inventory Master</span>
      </div>
    `;
  }

  function countRows(j){
    const out = {};
    for (const k of Object.keys(j.data || {})) out[k] = (j.data[k] || []).length;
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL INDEX — materials that appear in PR History
  ═════════════════════════════════════════════════════════════════════════ */

  function buildMaterialIndex(json){
    const prHistory = json.data.prHistory || [];
    const mb51      = json.data.mb51 || [];
    const master    = json.data.inventoryMaster || [];

    // Build description lookup from Inventory Master first (authoritative)
    const descByMat = new Map();
    for (const r of master) {
      const m = String(r.material || '').trim();
      if (m && r.description) descByMat.set(m, r.description);
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

    // Annotate with MB51 counts
    for (const r of mb51) {
      const m = String(r.material || '').trim();
      const entry = prByMat.get(m);
      if (entry) entry.mb51Count++;
    }

    return Array.from(prByMat.values()).map(e => ({
      material:    e.material,
      description: descByMat.get(e.material) || e.descFallback || '',
      prCount:     e.prCount,
      mb51Count:   e.mb51Count
    })).sort((a, b) => b.prCount - a.prCount);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL PICKER — searchable list of materials with PR History
  ═════════════════════════════════════════════════════════════════════════ */

  function renderMaterialList(){
    const q = state.matSearch.trim().toLowerCase();
    const filtered = q
      ? state.materials.filter(m =>
          m.material.toLowerCase().includes(q) ||
          (m.description || '').toLowerCase().includes(q))
      : state.materials;

    const max = 30;
    const shown = filtered.slice(0, max);
    $('#pickerMeta').textContent = filtered.length === state.materials.length
      ? `${state.materials.length} total · click to load`
      : `${filtered.length} of ${state.materials.length} · click to load`;

    $('#matList').innerHTML = shown.map(m => `
      <div class="mat-item ${m.material === state.selectedMaterial ? 'active' : ''}" data-mat="${escapeAttr(m.material)}">
        <div class="mat-id">${escapeHtml(m.material)}</div>
        <div class="mat-desc">${escapeHtml(m.description || '—')}</div>
        <div class="mat-meta">${m.prCount} PR${m.prCount === 1 ? '' : 's'} · ${m.mb51Count} MB51 row${m.mb51Count === 1 ? '' : 's'}</div>
      </div>
    `).join('') + (filtered.length > max
      ? `<div class="mat-more">… ${(filtered.length - max).toLocaleString()} more — refine search</div>`
      : '');

    $$('#matList .mat-item').forEach(el => {
      el.addEventListener('click', () => {
        state.selectedMaterial = el.dataset.mat;
        renderMaterialList();
        renderMaterialDetail();
      });
    });
  }

  function bindSearch(){
    const input = $('#matSearch');
    if (!input || input._bound) return;
    input.addEventListener('input', () => {
      state.matSearch = input.value;
      renderMaterialList();
    });
    input._bound = true;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     CHAIN COMPUTE — PR → PO → 107 → 109 → 261 per material
  ═════════════════════════════════════════════════════════════════════════ */

  function computeChainsForMaterial(material){
    const j = state.json;
    const prHistory = j.data.prHistory || [];
    const mb51      = j.data.mb51 || [];

    const prRows = prHistory.filter(r => String(r.material || '').trim() === material);

    // Pre-index MB51 by (purchaseOrder, movementType) — first qualifying date per
    // PO/MVT pair is what we want.
    const mb51ForMat = mb51.filter(r => String(r.material || '').trim() === material);
    const firstByPoMvt = new Map();   // 'PO|MVT' → { date, qty }
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

    // Also need first 261 (consumption) AFTER siteWH — index 261 dates for this
    // material sorted ascending so we can binary-pick the first >= siteWH.
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

      const cancelled = String(r.deletionIndicator || '').toLowerCase() === 'true'
                     || String(r.processingStatus || '').trim().toUpperCase() === 'N';

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
    }).sort((a, b) => {
      // Most recent PR first (by prDate string compare — ISO is sortable)
      return (b.prDate || '').localeCompare(a.prDate || '');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     MATERIAL DETAIL — banner + chart + chain table
  ═════════════════════════════════════════════════════════════════════════ */

  function renderMaterialDetail(){
    const mat = state.materials.find(m => m.material === state.selectedMaterial);
    if (!mat) return;
    state.chains = computeChainsForMaterial(mat.material);

    $('#dMat').textContent  = mat.material;
    $('#dDesc').textContent = mat.description || '—';

    const complete = state.chains.filter(c => c.state === 'COMPLETE');
    const inFlight = state.chains.filter(c => c.state === 'IN_FLIGHT' || c.state === 'NOT_YET_CONSUMED');
    const prOnly   = state.chains.filter(c => c.state === 'PR_ONLY');
    const cancelled= state.chains.filter(c => c.state === 'CANCELLED');
    const avgLT    = complete.length
      ? Math.round(complete.reduce((s, c) => s + c.total, 0) / complete.length)
      : null;
    const manualPR = state.chains.filter(c => c.creationIndicator === 'R').length;

    $('#dSummary').innerHTML = `
      <div class="sum-cell"><span class="lab">Complete chains</span><span class="v">${complete.length}</span></div>
      <div class="sum-cell"><span class="lab">In-flight</span><span class="v">${inFlight.length}</span></div>
      <div class="sum-cell"><span class="lab">PR only</span><span class="v">${prOnly.length}</span></div>
      <div class="sum-cell"><span class="lab">Cancelled</span><span class="v ${cancelled.length ? 'warn' : ''}">${cancelled.length}</span></div>
      <div class="sum-cell"><span class="lab">Avg total LT</span><span class="v">${avgLT != null ? avgLT + 'd' : '—'}</span></div>
      <div class="sum-cell"><span class="lab">Manual PRs</span><span class="v ${manualPR ? 'warn' : ''}">${manualPR}</span></div>
    `;

    $('#chainCount').textContent = `${state.chains.length} chain${state.chains.length === 1 ? '' : 's'} · ${complete.length} complete · ${inFlight.length} in-flight · ${cancelled.length} cancelled`;

    renderSwimlane();
    renderChainTable();
  }

  function renderSwimlane(){
    // Show only chains that have at least PR + PO so the bar has any phases.
    // Cancelled PRs render with dimmed bars so they're visible but de-emphasised.
    const drawn = state.chains.filter(c => c.state !== 'PR_ONLY');
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
          x: { stacked: true, grid: { color: 'rgba(31,206,216,.08)' }, ticks: { color: '#9BABA8', font: { family: 'JetBrains Mono', size: 10 } }, title: { display: true, text: 'Calendar Days', color: '#9BABA8', font: { size: 10 } } },
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
  function fmtISO(d){
    if (!d) return null;
    return d.toISOString().slice(0, 10);
  }
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
  function cellNum(n){
    if (n == null || n === 0) return '—';
    return n.toString();
  }

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }

  document.addEventListener('DOMContentLoaded', boot);

})();
