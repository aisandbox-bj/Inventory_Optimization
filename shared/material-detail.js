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
    // APP-FIX-OPI-RECON — the lamp number is the SAP Inventory-Master snapshot
    // QUANTITY where present (operator-confirmed truth, e.g. open PO = 127 units);
    // otherwise the count of chains traced from PR History. Title carries both so
    // a qty is never silently shown as if it were a count. data-opi routes the
    // click to that lamp's own popover (no more one-tile-for-all-lamps).
    const lamps = [
      { key:'pr', lab:'PR', lit: prN > 0,             n: prN,         title:`Open PR — ${prN} traced from PR History` },
      { key:'po', lab:'PO', lit: poN > 0 || imPO > 0, n: imPO || poN, title:`Open PO — SAP snapshot ${imPO ? imPO + ' units' : 'n/a'} · ${poN} on-order traced` },
      { key:'it', lab:'IT', lit: itN > 0 || imIT > 0, n: imIT || itN, title:`In transit — SAP snapshot ${imIT ? imIT + ' units' : 'n/a'} · ${itN} traced` }
    ];
    const lampHtml = lamps.map(l =>
      `<span class="opi-lamp opi-${l.key} ${l.lit ? 'lit' : 'off'}" data-opi="${l.key}" title="${escapeAttr(l.title)}">`
      + `<span class="opi-dot"></span><span class="opi-lab">${l.lab}</span>`
      + `${l.lit && l.n ? `<span class="opi-n">${l.n}</span>` : ''}</span>`
    ).join('');
    return `<div class="opi-wrap"><div class="opi-lamps" id="opiLamps" title="Open procurement — PR / PO / In Transit (click a lamp for detail)">${lampHtml}</div>${renderOpiPopover(op)}</div>`;
  }
  function renderOpiPopover(op){
    const fmtDate = d => d ? String(d).slice(0, 10) : '—';
    const sumQty  = items => (items || []).reduce((a, c) => a + (Number(c.qty) || 0), 0);
    const tbl = (items, idFn, dateFn) => {
      if (!items || !items.length) return '<div class="opi-empty">none traced from PR History.</div>';
      const rows = items.map(c =>
        `<tr><td>${escapeHtml(idFn(c))}</td><td>${fmtDate(dateFn(c))}</td><td class="num">${opiNum(c.qty)}</td><td class="num">${opiAge(dateFn(c))}</td></tr>`
      ).join('');
      return `<table class="opi-tbl"><thead><tr><th>Ref</th><th>Created</th><th class="num">Qty</th><th class="num">Age</th></tr></thead><tbody>${rows}</tbody></table>`;
    };
    // Honest reconciliation: the SAP snapshot is the headline; the PR-History line
    // items are what could be traced. When they don't add up, SAY SO (credibility)
    // rather than showing the snapshot number over a list that can't match it.
    const recon = (label, imQty, tracedItems) => {
      if (imQty == null) return '';
      const traced = sumQty(tracedItems);
      const n = (tracedItems || []).length;
      let note = `SAP snapshot (Inventory Master): <b>${opiNum(imQty)}</b> ${label} units. PR History traces ${n} (${opiNum(traced)} units).`;
      if (imQty > traced)      note += ` The remaining <b>${opiNum(imQty - traced)}</b> are on ${label} lines not in the loaded PR History.`;
      else if (imQty < traced) note += ` Traced exceeds the snapshot — the SAP extract may predate recent activity.`;
      return `<div class="opi-im">${note}</div>`;
    };
    const cav = `<div class="opi-pop-cav">Line items: ref · created date · qty · days open, from PR History + MB51. Headline figure is the SAP Inventory-Master snapshot.</div>`;
    const pop = (key, title, body) =>
      `<div class="opi-pop hidden" id="opiPop-${key}"><div class="opi-pop-h">${title}</div>${body}${cav}</div>`;
    // SAP "open PO" = not yet GR'd at site = on-order PLUS in-transit (received at
    // the 3PL but not at site); reconcile the snapshot against both.
    const poBody = `<div class="opi-sec-h">On order</div>${tbl(op.onOrder, c => 'PO ' + c.po, c => c.poDate)}`
                 + recon('open-PO', op.imOpenPO, [...(op.onOrder || []), ...(op.inTransit || [])]);
    const itBody = `<div class="opi-sec-h">At 3PL · in transit</div>${tbl(op.inTransit, c => 'PO ' + c.po, c => c.gr3pl)}`
                 + recon('in-transit', op.imInTransit, op.inTransit);
    return pop('pr', 'Open PR', tbl(op.openPR, c => 'PR ' + c.pr, c => c.prDate))
         + pop('po', 'Open PO', poBody)
         + pop('it', 'In transit', itBody);
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

    // APP-BATCH-MIN-GOVERNS — one Min block: the governing recommended Min shown
    // big (= the calc Min, or max(calc, batch) when batchedMinGoverns='on'), with
    // BOTH inputs beneath (calc · batch) for comparison. No separate batched row.
    const _minRec   = (mat.recMin     != null) ? mat.recMin     : null;
    const _minCalc  = (mat.recMinCalc != null) ? mat.recMinCalc : _minRec;
    const _minBatch = (mat.batchedMin != null) ? mat.batchedMin : null;
    let _minRecHtml;
    if (_minRec == null)          _minRecHtml = '—';
    else if (_minBatch != null)   _minRecHtml = `<span class="min-gov">${_minRec}</span> <span class="min-sub">calc ${_minCalc} · batch ${_minBatch}</span>`;
    else                          _minRecHtml = `<span class="min-gov">${_minRec}</span>`;

    const rows = [
      { label:'MRP type',     cur: mat.mrpType || '—',                              rec: mat.recMrpType || '—' },
      { label:'Min',          cur: mat.cmin != null ? mat.cmin : '—',               rec: _minRec != null ? String(_minRec) : '—', recHtml: _minRecHtml },
      { label:'Max',          cur: mat.cmax != null ? mat.cmax : '—',               rec: mat.recMax != null ? mat.recMax : '—' },
      { label:'Safety Stock', cur: mat.safetyStock != null ? mat.safetyStock : '—', rec: '—', recOmitted: true }
    ];
    const trs = rows.map(r => {
      const changed = !r.recOmitted && r.cur !== '—' && r.rec !== '—' && !eq(r.cur, r.rec);
      return `
        <tr class="${changed ? 'changed' : ''}">
          <td class="lab">${escapeHtml(r.label)}</td>
          <td class="current">${escapeHtml(String(r.cur))}</td>
          <td class="rec">${r.recHtml || escapeHtml(String(r.rec))}</td>
        </tr>`;
    }).join('');

    return `
      <div class="mrp-compare">
        <div class="mrp-compare-head">
          <h4>MRP Settings · Current vs Recommended</h4>
          <span class="hint">Yellow rows = recommendation differs from current. The <b>Min</b> shows the governing figure with its two inputs beneath — <b>calc</b> (P2 rate × months) and <b>batch</b> (a typical WO batch × factor). Which one governs is a setting (<i>Batched Min governs</i>). Safety Stock is informational.</span>
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
          <h4>LLM review${llm.variant ? ` · ${escapeHtml(llm.variant)}` : ''}</h4>
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

  async function runLlmReview(hostEl, mat, opts, variant){
    variant = (variant === 'v') ? 'v' : 'base';
    _inflight = true;
    const disable = (v) => { const b = hostEl.querySelector(v); if (b) b.disabled = true; };
    disable('#btnLlm'); disable('#btnLlmV');
    const statusEl = hostEl.querySelector('#llmStatus');
    if (statusEl) statusEl.innerHTML = `<span class="llm-spinner">Reviewing chart… (${variant})</span>`;
    try {
      const svg = hostEl.querySelector('#chartHost svg');
      const reviewOpts = { variant };
      // The "(v)" button runs the enhanced variant prompt; base uses the factory.
      if (variant === 'v' && typeof AppConfig !== 'undefined' && AppConfig.getPromptTemplateV) {
        reviewOpts.template = await AppConfig.getPromptTemplateV();
      }
      const out = await AppLlm.review(mat, opts.bucket ? opts.bucket.name : '', opts.parameters, svg, reviewOpts);
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
      const enable = (v) => { const b = hostEl.querySelector(v); if (b) b.disabled = false; };
      enable('#btnLlm'); enable('#btnLlmV');
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

    // APP-TREND-PEC — per-event consumption (units issued per consumptive event).
    const pes = mat.perEventStats || null;
    let perEventDisp = '—', perEventTitle = '';
    if (pes && pes.n > 0 && pes.mean != null) {
      const m = pes.mean.toFixed(1);
      if (pes.std != null) {
        perEventDisp  = `${m} <small>± ${pes.std.toFixed(1)} ea</small>`;
        perEventTitle = `Mean ± sample std of units issued per consumptive event, across ${pes.n} events (full window)`;
      } else {
        perEventDisp  = `${m} <small>ea · 1 event</small>`;
        perEventTitle = `Units issued in the single consumptive event (full window)`;
      }
    }
    const perEventCell = `<div class="stat-cell"${perEventTitle ? ` title="${escapeHtml(perEventTitle)}"` : ''}><span class="lab">Per event cons</span><div class="v">${perEventDisp}</div></div>`;

    const _ranBase = llmCfg && llmCfg.variant !== 'v';
    const _ranV    = llmCfg && llmCfg.variant === 'v';
    const llmActionsHtml = enableLlm
      ? `
      <div class="actions-row">
        <button id="btnLlm" class="primary" ${_inflight ? 'disabled' : ''} title="Current factory prompt">${_ranBase ? '↻ Re-run' : '✦ Run'} LLM review (base)</button>
        <button id="btnLlmV" class="primary" ${_inflight ? 'disabled' : ''} title="Enhanced prompt — batched-consumption + 'why now / what to check' framing">${_ranV ? '↻ Re-run' : '✦ Run'} LLM review (v)</button>
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
      <div class="chart-host" id="chartHost"></div>
      <div class="chart-caveat">Stock-on-hand line is back-calculated from MB51 movements (site stock only, 3PL receipts excluded) — not pulled from SAP.</div>
      ${(opts.snapshotAlign && opts.snapshotAlign.hasImDate && !opts.snapshotAlign.aligned) ? `<div class="chart-caveat soh-misalign">⚠ Stock snapshot dated <b>${escapeHtml(opts.snapshotAlign.imDate)}</b> but MB51 runs to <b>${escapeHtml(opts.snapshotAlign.lastMb51Date)}</b> — ${Math.abs(opts.snapshotAlign.gapDays)} day${Math.abs(opts.snapshotAlign.gapDays) === 1 ? '' : 's'} of movements ${opts.snapshotAlign.gapDays > 0 ? 'after' : 'before'} the stock snapshot. The Stock-on-Hand line and stockout flags are offset by the net of those movements — re-extract both on the same SAP run date.</div>` : ''}

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
        ${perEventCell}
        ${dropCauseCell}
      </div>

      ${renderMrpCompare(mat)}
      ${renderInvAdjTable(mat)}

      <!-- APP-TREND-HCE-RM — on-screen HCE table removed from the detail panel:
           the per-event chart hover (APP-TREND-HOV), Where-used drill (APP-WU-02)
           and the chart's own top-HCE annotations cover this dynamically now.
           (PDF Pack + Excel still carry their own HCE table — unchanged.) -->

      ${llmActionsHtml}
      ${llmCfg ? renderLlmPanel(llmCfg) : ''}
    `;

    // APP-E11 — chart 30% wider (was 720). Caveat caption + legend toggles
    // wired right after render so toggle state applies to the freshly drawn SVG.
    // APP-TREND-HOV — per-event hover movements (lazy; only for the open material).
    let chartMovements = null;
    if (typeof opts.chartMovementsFn === 'function') {
      try { chartMovements = opts.chartMovementsFn(); }
      catch (e) { console.warn('chartMovements:', e); }
    }
    AppChart.render(hostEl.querySelector('#chartHost'), mat, { width: chartWidth, height: chartHeight, movements: chartMovements });
    wireChartToggles(hostEl);

    // Bind LLM (only when the run button is present)
    if (enableLlm) {
      const llmBtn = hostEl.querySelector('#btnLlm');
      if (llmBtn) llmBtn.addEventListener('click', () => runLlmReview(hostEl, mat, opts, 'base'));
      const llmBtnV = hostEl.querySelector('#btnLlmV');
      if (llmBtnV) llmBtnV.addEventListener('click', () => runLlmReview(hostEl, mat, opts, 'v'));
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

    // APP-WU-02 — "Where used" button opens a modal (was an inline panel in
    // APP-WU-01). The table is computed lazily on open; clicking any year cell
    // drills into the underlying work orders.
    const wuBtn = hostEl.querySelector('#wuBtn');
    if (wuBtn && opts.whereUsedFn) {
      wuBtn.addEventListener('click', () => openWhereUsedModal(mat, opts));
    }

    // APP-OPI-01 / APP-FIX-OPI-RECON — click a lamp to toggle ITS OWN popover
    // (PR / PO / IT each have a distinct #opiPop-<key>); clicking another lamp
    // switches; clicking the lit lamp again closes. One guarded document-level
    // handler closes any open popover.
    const opiLamps = hostEl.querySelector('#opiLamps');
    const opiWrap  = hostEl.querySelector('.opi-wrap');
    if (opiLamps && opiWrap) {
      opiLamps.addEventListener('click', (e) => {
        e.stopPropagation();
        const lamp = e.target.closest('.opi-lamp');
        if (!lamp) return;
        const pop = opiWrap.querySelector('#opiPop-' + lamp.getAttribute('data-opi'));
        const reopen = pop && pop.classList.contains('hidden');
        opiWrap.querySelectorAll('.opi-pop').forEach(p => p.classList.add('hidden'));
        if (pop && reopen) pop.classList.remove('hidden');
      });
      opiWrap.querySelectorAll('.opi-pop').forEach(p => p.addEventListener('click', (e) => e.stopPropagation()));
      if (!window._opiDocCloseWired) {
        window._opiDocCloseWired = true;
        document.addEventListener('click', () => {
          document.querySelectorAll('.opi-pop:not(.hidden)').forEach(p => p.classList.add('hidden'));
        });
      }
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     APP-WU-02 — "Where used" modal. Self-contained overlay (appended to body,
     removed on close) so it works identically on Trend + Screener without
     depending on either page's modal CSS. Two views inside one dialog:
     the destination×year table, and the per-cell work-order drill.
  ═════════════════════════════════════════════════════════════════════════ */
  function openWhereUsedModal(mat, opts){
    if (typeof WhereUsed === 'undefined' || !opts.whereUsedFn) return;

    let data;
    try { data = opts.whereUsedFn(); }
    catch (e){ data = { available: false }; console.warn('WhereUsed:', e); }

    const overlay = document.createElement('div');
    overlay.className = 'wu-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="wu-modal-backdrop"></div>
      <div class="wu-dialog">
        <div class="wu-modal-head">
          <div class="wu-modal-title">
            <span class="lab">Where used</span>
            <h3>${escapeHtml(mat.material)}${mat.description ? ' <span class="wu-h-desc">' + escapeHtml(mat.description) + '</span>' : ''}</h3>
          </div>
          <button type="button" class="wu-close" id="wuClose" title="Close (Esc)" aria-label="Close">✕</button>
        </div>
        <div class="wu-modal-body" id="wuBody"></div>
      </div>`;
    document.body.appendChild(overlay);

    const body = overlay.querySelector('#wuBody');

    function showTable(){
      body.innerHTML = WhereUsed.renderPopup(data, mat.material);
      body.scrollTop = 0;
      body.querySelectorAll('.wu-cell').forEach(cell => {
        cell.addEventListener('click', () => {
          const sel = { year: cell.dataset.wuYear };
          if (cell.dataset.wuSf)     sel.sortField = cell.dataset.wuSf;
          if (cell.dataset.wuModel)  sel.model     = cell.dataset.wuModel;
          if (cell.dataset.wuBucket) sel.bucket    = cell.dataset.wuBucket;
          showDrill(sel);
        });
      });
    }
    function showDrill(sel){
      if (!opts.whereUsedDrillFn){ return; }
      let dd;
      try { dd = opts.whereUsedDrillFn(sel); }
      catch (e){ console.warn('WhereUsed drill:', e); body.innerHTML = '<div class="wu-empty">Drill failed to compute.</div>'; return; }
      body.innerHTML = WhereUsed.renderDrill(dd, mat.material);
      body.scrollTop = 0;
      const back = body.querySelector('#wuBack');
      if (back) back.addEventListener('click', showTable);
    }

    function close(){
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e){ if (e.key === 'Escape') close(); }

    overlay.querySelector('.wu-modal-backdrop').addEventListener('click', close);
    overlay.querySelector('#wuClose').addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    showTable();
  }

  window.MaterialDetail = { render, pillCls };

})();
