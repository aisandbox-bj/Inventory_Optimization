/* ═══════════════════════════════════════════════════════════════════════════
   shared/material-detail.js · APP-SCR-01 (2026-06-25)
   ───────────────────────────────────────────────────────────────────────────
   Single source of truth for the Analysis material-detail render. Extracted
   verbatim from analysis/analysis.js renderDetail() + its pure helpers
   (renderMrpCompare / renderInvAdjTable / renderHceTable / renderLlmPanel /
   pillCls / wireChartToggles) so Analysis AND Screener render the SAME panel.

   Decoupled from page `state`: the caller passes the material + bucket +
   parameters in, and receives any LLM result via the onLlmResult callback
   rather than the module reaching into a page-global. The math is untouched —
   this is a pure presentation move (APP-SCR-01 build order Step 1).

   Public API:
     MaterialDetail.render(hostEl, mat, {
        bucket,        // bucket object (needs bucket.name for the LLM review call)
        parameters,    // canonical JSON parameters (for the LLM review call)
        llm,           // cached LLM result for this material (or undefined)
        onLlmResult,   // (materialNo, out) => void — called after a review run
        enableLlm,     // default true — render + wire the "Run LLM review" button
        chartWidth,    // default 936  (Analysis parity)
        chartHeight,   // default 320
        enableTraceLink// default false — render a "Trace it!" button (Analysis only;
                       //   opens ../trace/trace.html#mat=<material>)
     })

   Depends on globals: AppChart, AppLocale, AppLlm (only when enableLlm).
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function escapeHtml(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }

  // Tracks an in-flight single-material LLM review so a re-render keeps the
  // button disabled (mirrors analysis.js state.llmInflight semantics).
  let _inflight = false;

  function pillCls(tl){
    return ({ GREEN:'ok', BLUE:'cyan', ORANGE:'warn', RED:'crit', PURPLE:'wr', GREY:'' })[tl] || '';
  }

  /* ─── APP-OPI-01 (2026-06-27) · open-procurement 3-lamp indicator ──────────
     opts.openProc comes from TracePhase.openProcurement(json, material):
       { hasPr, openPR[], onOrder[], inTransit[], imOpenPO, imInTransit }
     Lamps: PR (amber) · PO (cyan) · In Transit (violet). A lamp lights when its
     state has chain items OR an Inventory-Master snapshot qty. Click any lamp
     → popover with each item (number · created date · qty · age). Hidden when
     there's no PR history and no IM open qty. */
  function opiNum(v){ return (v == null || v === '') ? '—' : Number(v).toLocaleString(); }
  function opiAge(d){
    if (!d) return '';
    const t = Date.parse(String(d).slice(0, 10));
    if (isNaN(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    return days >= 0 ? days + 'd' : '';
  }
  function renderOpenProcLamps(op){
    if (!op) return '';
    const prN = (op.openPR || []).length;
    const poN = (op.onOrder || []).length;
    const itN = (op.inTransit || []).length;
    const imPO = (op.imOpenPO   != null && op.imOpenPO   > 0) ? op.imOpenPO   : 0;
    const imIT = (op.imInTransit != null && op.imInTransit > 0) ? op.imInTransit : 0;
    if (!op.hasPr && !imPO && !imIT) return '';   // nothing to show
    const lamps = [
      { key:'pr', lab:'PR', lit: prN > 0,            n: prN,            title:`Open PR: ${prN}` },
      { key:'po', lab:'PO', lit: poN > 0 || imPO > 0, n: poN || imPO,   title:`Open PO: ${poN}${imPO ? ` · SAP qty ${imPO}` : ''}` },
      { key:'it', lab:'IT', lit: itN > 0 || imIT > 0, n: itN || imIT,   title:`In transit: ${itN}${imIT ? ` · SAP qty ${imIT}` : ''}` }
    ];
    const lampHtml = lamps.map(l =>
      `<span class="opi-lamp opi-${l.key} ${l.lit ? 'lit' : 'off'}" title="${escapeAttr(l.title)}">`
      + `<span class="opi-dot"></span><span class="opi-lab">${l.lab}</span>`
      + `${l.lit && l.n ? `<span class="opi-n">${l.n}</span>` : ''}</span>`
    ).join('');
    return `<div class="opi-wrap"><div class="opi-lamps" id="opiLamps" title="Open procurement — PR / PO / In Transit (click for detail)">${lampHtml}</div>${renderOpiPopover(op)}</div>`;
  }
  function renderOpiPopover(op){
    const fmtDate = d => d ? String(d).slice(0, 10) : '—';
    const section = (title, items, idFn, dateFn) => {
      if (!items || !items.length) return '';
      const rows = items.map(c =>
        `<tr><td>${escapeHtml(idFn(c))}</td><td>${fmtDate(dateFn(c))}</td><td class="num">${opiNum(c.qty)}</td><td class="num">${opiAge(dateFn(c))}</td></tr>`
      ).join('');
      return `<div class="opi-sec"><div class="opi-sec-h">${title} <span class="opi-sec-n">${items.length}</span></div>`
        + `<table class="opi-tbl"><thead><tr><th>Ref</th><th>Created</th><th class="num">Qty</th><th class="num">Age</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const prSec = section('Open PR', op.openPR, c => 'PR ' + c.pr, c => c.prDate);
    const poSec = section('Open PO · on order', op.onOrder, c => 'PO ' + c.po, c => c.poDate);
    const itSec = section('In transit · at 3PL', op.inTransit, c => 'PO ' + c.po, c => c.gr3pl);
    const body = (prSec + poSec + itSec) || '<div class="opi-empty">No open PR / PO / in-transit chains.</div>';
    const imLine = (op.imOpenPO != null || op.imInTransit != null)
      ? `<div class="opi-im">SAP snapshot (Inventory Master) — open PO: <b>${opiNum(op.imOpenPO)}</b> · in transit: <b>${opiNum(op.imInTransit)}</b></div>`
      : '';
    return `<div class="opi-pop hidden" id="opiPop"><div class="opi-pop-h">Open procurement</div>${body}${imLine}`
      + `<div class="opi-pop-cav">Ref · created date · qty · days open. PR/PO/in-transit from PR History + MB51 movements; SAP snapshot from Inventory Master.</div></div>`;
  }

  /* ─── MRP Settings Comparison: Current (shaded) vs Recommended (shaded) ─ */
  function renderMrpCompare(mat){
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
        ${mat.mrpReclassRecommended ? `<div class="mrp-reclass-note">⚑ ${escapeHtml(mat.mrpReclassNote || '')}</div>` : ''}
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

  /* ─── APP-E11 · Chart legend toggle wiring (scoped to hostEl) ──────────── */
  function wireChartToggles(hostEl){
    const host = hostEl.querySelector('#chartHost');
    const cb1  = hostEl.querySelector('#chartToggleConsumption');
    const cb2  = hostEl.querySelector('#chartToggleSoh');
    if (!host) return;
    function apply(){
      if (cb1) host.classList.toggle('hide-cum', !cb1.checked);
      if (cb2) host.classList.toggle('hide-soh', !cb2.checked);
    }
    apply();
    if (cb1 && !cb1._wired) { cb1.addEventListener('change', apply); cb1._wired = true; }
    if (cb2 && !cb2._wired) { cb2.addEventListener('change', apply); cb2._wired = true; }
  }

  async function runLlmReview(hostEl, mat, opts){
    _inflight = true;
    const btn = hostEl.querySelector('#btnLlm');
    if (btn) btn.disabled = true;
    const statusEl = hostEl.querySelector('#llmStatus');
    if (statusEl) statusEl.innerHTML = '<span class="llm-spinner">Reviewing chart…</span>';
    try {
      const svg = hostEl.querySelector('#chartHost svg');
      const out = await AppLlm.review(mat, opts.bucket ? opts.bucket.name : '', opts.parameters, svg);
      if (typeof opts.onLlmResult === 'function') opts.onLlmResult(mat.material, out);
      render(hostEl, mat, Object.assign({}, opts, { llm: out }));
    } catch (e) {
      console.error(e);
      const msg = e.message || String(e);
      const hint = /failed to fetch|cors/i.test(msg)
        ? ' — if you opened the page via file://, serve it via http://localhost instead (run: python -m http.server 8000 in the app folder).'
        : '';
      const s2 = hostEl.querySelector('#llmStatus');
      if (s2) s2.innerHTML = `<span class="llm-error">✗ ${escapeHtml(msg)}${hint}</span>`;
    } finally {
      _inflight = false;
      const b2 = hostEl.querySelector('#btnLlm');
      if (b2) b2.disabled = false;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     render — build the full material-detail panel into hostEl
  ═════════════════════════════════════════════════════════════════════════ */
  function render(hostEl, mat, opts){
    opts = opts || {};
    const enableLlm   = opts.enableLlm !== false;       // default true
    const chartWidth  = opts.chartWidth  || 936;        // APP-E11 parity
    const chartHeight = opts.chartHeight || 320;
    const llmCfg      = opts.llm;

    const rcDisp = mat.rateChange != null ? `${mat.rateChange}%` : 'N/A';
    const adjDisp = (mat.hceP2 && mat.hceP2.length)
                  ? (mat.adjP2Flag === 'OK' ? `${mat.adjP2Rate.toFixed(2)}` : `0 [${mat.adjP2Flag || 'NO_DATA'}]`)
                  : '—';

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

    const llmActionsHtml = enableLlm
      ? `
      <div class="actions-row">
        <button id="btnLlm" class="primary" ${_inflight ? 'disabled' : ''}>${llmCfg ? '↻ Re-run LLM review' : '✦ Run LLM review'}</button>
        <span id="llmStatus"></span>
      </div>`
      : '';

    hostEl.innerHTML = `
      <div class="detail-head ${mat.trafficLight}">
        <div class="detail-head-id">
          <div class="mat-row">
            <span class="mat">${escapeHtml(mat.material)}</span>
            <button class="mat-copy" id="btnCopyMat" title="Copy material number to clipboard" aria-label="Copy material number">⧉</button>
            ${opts.enableTraceLink ? `<button class="mat-trace" id="btnTraceIt" title="Open this material in Calibre Trace">Trace it! &rarr;</button>` : ''}
          </div>
          <div class="desc">${escapeHtml(mat.description || '')}${mat.manufacturer ? ' <span class="desc-mfr">(' + escapeHtml(mat.manufacturer) + ')</span>' : ''}</div>
        </div>
        <div class="detail-head-rec">
          <span class="rec-lab">Algorithmic recommendation</span>
          <div class="rec-text">${escapeHtml(mat.action)}</div>
        </div>
        ${renderOpenProcLamps(opts.openProc)}
        <span class="pill ${pillCls(mat.trafficLight)}"><span class="dot"></span>${mat.trafficLight}</span>
      </div>

      <div class="chart-toolbar">
        <span class="chart-toolbar-lab">Show:</span>
        <label class="chart-toggle"><input type="checkbox" id="chartToggleConsumption" checked> Consumption</label>
        <label class="chart-toggle"><input type="checkbox" id="chartToggleSoh" checked> Stock on Hand</label>
        ${opts.whereUsedFn ? '<span class="wu-spacer"></span><button type="button" class="wu-btn" id="wuBtn" title="Where has this material been consumed? Work-order issues by Sort Field / Fleet model + cost centre, net of reversals, by year. Needs IW39.">⊞ Where used</button>' : ''}
      </div>
      ${opts.whereUsedFn ? '<div class="wu-pop hidden" id="wuPop"></div>' : ''}
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

      ${llmActionsHtml}
      ${llmCfg ? renderLlmPanel(llmCfg) : ''}
    `;

    // APP-E11 — chart 30% wider (was 720). Caveat caption + legend toggles
    // wired right after render so toggle state applies to the freshly drawn SVG.
    AppChart.render(hostEl.querySelector('#chartHost'), mat, { width: chartWidth, height: chartHeight });
    wireChartToggles(hostEl);

    // Bind LLM (only when the run button is present)
    if (enableLlm) {
      const llmBtn = hostEl.querySelector('#btnLlm');
      if (llmBtn) llmBtn.addEventListener('click', () => runLlmReview(hostEl, mat, opts));
    }

    // APP-E26 — material-number copy button (async Clipboard API + fallback).
    const copyBtn = hostEl.querySelector('#btnCopyMat');
    if (copyBtn && !copyBtn._wired) {
      copyBtn._wired = true;
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const orig = copyBtn.textContent;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(mat.material);
          } else {
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

    // APP-T-07 — "Trace it!" cross-tool deep link (opt-in; Analysis only). Opens
    // this material directly in Calibre Trace via the URL hash; trace.js reads it
    // on boot. Not rendered on the Screener (Trace is already inline there).
    if (opts.enableTraceLink) {
      const traceBtn = hostEl.querySelector('#btnTraceIt');
      if (traceBtn && !traceBtn._wired) {
        traceBtn._wired = true;
        traceBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.href = '../trace/trace.html#mat=' + encodeURIComponent(mat.material);
        });
      }
    }

    // APP-WU-01 — "Where used" button toggles an inline panel; computed lazily
    // on first open (full MB51 scan) and cached.
    const wuBtn = hostEl.querySelector('#wuBtn');
    const wuPop = hostEl.querySelector('#wuPop');
    if (wuBtn && wuPop && opts.whereUsedFn) {
      wuBtn.addEventListener('click', () => {
        if (wuPop.classList.contains('hidden')) {
          if (!wuPop._rendered) {
            try { wuPop.innerHTML = WhereUsed.renderPopup(opts.whereUsedFn(), mat.material); }
            catch (e) { wuPop.innerHTML = '<div class="wu-empty">Where-used failed to compute.</div>'; console.warn('WhereUsed:', e); }
            wuPop._rendered = true;
          }
          wuPop.classList.remove('hidden');
          wuBtn.classList.add('active');
        } else {
          wuPop.classList.add('hidden');
          wuBtn.classList.remove('active');
        }
      });
    }

    // APP-OPI-01 — open-procurement lamps: click a lamp to toggle the detail
    // popover. One guarded document-level handler closes any open popover.
    const opiLamps = hostEl.querySelector('#opiLamps');
    const opiPop   = hostEl.querySelector('#opiPop');
    if (opiLamps && opiPop) {
      opiLamps.addEventListener('click', (e) => { e.stopPropagation(); opiPop.classList.toggle('hidden'); });
      opiPop.addEventListener('click', (e) => e.stopPropagation());
      if (!window._opiDocCloseWired) {
        window._opiDocCloseWired = true;
        document.addEventListener('click', () => {
          document.querySelectorAll('.opi-pop:not(.hidden)').forEach(p => p.classList.add('hidden'));
        });
      }
    }
  }

  window.MaterialDetail = { render, pillCls };

})();
