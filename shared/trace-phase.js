/* ═══════════════════════════════════════════════════════════════════════════
   shared/trace-phase.js · APP-SCR-01 (2026-06-25)
   ───────────────────────────────────────────────────────────────────────────
   Single source of truth for the Calibre Trace per-material Phase-Distribution
   render: the A–D timeline chevron + purple "Time to First Use" shelf block
   (per APP-FIX-PD-CHEVRON), the five-box-plot grid (uniform y-scale + Tukey
   fence + on-plot mean, per APP-FIX-PD-POLISH), and the transposed stats table.

   Extracted verbatim from trace/trace.js so Trace AND the Screener render the
   SAME visual. The pieces that were state-coupled in trace.js are reshaped to
   take their inputs explicitly:
     · computeChains(json, material)   — `json` is an argument (was state.json)
     · activeChains/sigmaExcl(chains, filters) — filters passed in, not page state

   trace.js keeps its own filter toolbar (year / sigma / manual-exclude) and its
   own state-coupled active()/sigmaExcl() for the other views; it calls
   renderPhaseEmpty()/renderPhaseVisual() here for the visual. The Screener calls
   render() with default filters (All years, sigma off, no manual excludes).

   No external library deps — pure SVG/HTML. (Chart.js is NOT needed for this
   view.) escapeHtml is self-contained.

   Public API:
     TracePhase.computeChains(json, material) -> chain[]
     TracePhase.boxStats(values) -> stats | null
     TracePhase.getYearsForChains(chains) -> string[]
     TracePhase.sigmaExcl(chains, filters) -> Set<pr>
     TracePhase.activeChains(chains, filters) -> chain[]
     TracePhase.renderPhaseEmpty(material, drawnCount, actCount) -> html
     TracePhase.renderPhaseVisual(drawn) -> html  (chevron + plots + table + caveat)
     TracePhase.render(hostEl, json, material, { filters, toolbarHtml }) -> { chains, act, drawn }
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }

  const PHASE_KEYS   = ['A', 'B', 'C', 'D', 'E'];
  const PHASE_LABELS = {
    A: 'PR Approval',
    B: 'Internal Processing',
    C: 'Vendor Lead Time',
    D: 'Transfer to Site',
    E: 'Time to First Use'
  };
  const PHASE_COLORS = ['#1FCED8', '#5AB69D', '#FBBF24', '#F87171', '#A78BFA'];

  /* ─── Date utils (copied from trace.js — were only used by computeChains) ─ */
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

  /* ═════════════════════════════════════════════════════════════════════════
     computeChains — PR→PO→GR→consumption chains for one material.
     `json` is the canonical intake JSON (was state.json in trace.js).
  ═════════════════════════════════════════════════════════════════════════ */
  function computeChains(json, material){
    const j = json;
    const prHistory = (j.data && j.data.prHistory) || [];
    const mb51      = (j.data && j.data.mb51) || [];

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

      // APP-FIX-T-04c — cancellation = deletion flag AND processingStatus 'N'.
      const cancelled = String(r.deletionIndicator || '').toLowerCase() === 'true'
                     && String(r.processingStatus || '').trim().toUpperCase() === 'N';

      const A = days(prDate, relDate);
      const B = days(relDate, poDate);
      const C = days(poDate, gr3pl);
      const D = days(gr3pl, siteWH);
      const E = days(siteWH, c261);
      const total = [A, B, C, D, E].reduce((s, x) => s + (x || 0), 0);

      // APP-V03-PORT-1 — PR/PO precedence rule (a PO means the need was approved;
      // a PR with no PO is treated as cancelled). adminCancelled is reporting-only.
      let state_ = 'COMPLETE';
      if      (!po && cancelled)  state_ = 'CANCELLED';
      else if (!po)               state_ = 'PR_ONLY';
      else if (!siteWH)           state_ = 'IN_FLIGHT';
      else if (!c261)             state_ = 'NOT_YET_CONSUMED';

      const adminCancelled = !!po && cancelled;

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
        adminCancelled,
        creationIndicator: String(r.creationIndicator || '').trim() || 'B'
      };
    }).sort((a, b) => (b.prDate || '').localeCompare(a.prDate || ''));
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Filter machinery — explicit filters (not page state).
       filters = { yearFilter: 'All'|year, sigmaLimit: null|3|2|1.5, manualExcl: Set<pr> }
  ═════════════════════════════════════════════════════════════════════════ */
  function getChainYear(c){ return (c.prDate || '').substring(0, 4); }

  function getYearsForChains(chains){
    const yrs = new Set();
    for (const c of chains) { const y = getChainYear(c); if (y) yrs.add(y); }
    return [...yrs].sort();
  }

  function sigmaExcl(chains, filters){
    const sigmaLimit = filters && filters.sigmaLimit;
    const yearFilter = (filters && filters.yearFilter) || 'All';
    if (!sigmaLimit) return new Set();
    const inYear = chains.filter(c => yearFilter === 'All' || getChainYear(c) === yearFilter);
    const drawn  = inYear.filter(c => !!c.siteWH);
    if (drawn.length < 2) return new Set();
    const totals = drawn.map(c => c.total);
    const n      = totals.length;
    const mean   = totals.reduce((s, v) => s + v, 0) / n;
    const sd     = Math.sqrt(totals.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1));
    const threshold = mean + sigmaLimit * sd;
    const excl = new Set();
    drawn.forEach(c => { if (c.total > threshold) excl.add(c.pr); });
    return excl;
  }

  function activeChains(chains, filters){
    const yearFilter = (filters && filters.yearFilter) || 'All';
    const manualExcl = (filters && filters.manualExcl) || new Set();
    const sig = sigmaExcl(chains, filters);
    const ex = new Set([...manualExcl, ...sig]);
    return chains.filter(c =>
      (yearFilter === 'All' || getChainYear(c) === yearFilter)
      && !ex.has(c.pr)
    );
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Box-plot math (copied verbatim from trace.js)
  ═════════════════════════════════════════════════════════════════════════ */
  function quantile(sorted, q){
    if (sorted.length === 0) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
      return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
  }

  function boxStats(values){
    const xs = values.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
    if (xs.length === 0) return null;
    const n = xs.length;
    const min = xs[0];
    const max = xs[n - 1];
    const q1 = quantile(xs, 0.25);
    const q2 = quantile(xs, 0.5);
    const q3 = quantile(xs, 0.75);
    const mean = xs.reduce((s, v) => s + v, 0) / n;
    const iqr = q3 - q1;
    const upperFence = q3 + 1.5 * iqr;
    const outliers = xs.filter(v => v > upperFence);
    const inFence = xs.filter(v => v <= upperFence);
    const whiskerUpper = inFence.length ? inFence[inFence.length - 1] : max;
    return { n, min, max, q1, q2, q3, mean, iqr, upperFence, whiskerUpper, outliers };
  }

  // "Nice" axis tick generator — 1/2/5 × 10^n stepping for round numbers
  function niceTicks(min, max, target){
    if (max <= min) return [min];
    const range = max - min;
    const rough = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if      (norm < 1.5) step = 1   * mag;
    else if (norm < 3)   step = 2   * mag;
    else if (norm < 7)   step = 5   * mag;
    else                 step = 10  * mag;
    const ticks = [];
    const start = Math.ceil(min / step) * step;
    for (let v = start; v <= max; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  // SVG box plot — vertical. APP-FIX-PD-POLISH (A): all five plots share one
  // y-domain (yMaxShared) so phase durations compare visually; outliers above
  // the Tukey fence are clipped and flagged numerically.
  function renderBoxPlotSvg(p, yMaxShared){
    const W = 168, H = 220, PAD_T = 14, PAD_B = 50, PAD_L = 36, PAD_R = 12;
    const innerH = H - PAD_T - PAD_B;
    const innerW = W - PAD_L - PAD_R;
    if (!p.stats) {
      return `<div class="pd-plot pd-plot-empty">
        <div class="pd-plot-title" style="border-color:${p.color}">${p.key} · ${p.label}</div>
        <div class="pd-plot-nodata">no data</div>
      </div>`;
    }
    const s = p.stats;
    const yMax = yMaxShared || (Math.max(s.upperFence, s.q3 + 1, 1) * 1.06);
    const yScale = (v) => PAD_T + innerH - (v / yMax) * innerH;
    const boxX = PAD_L + innerW / 2 - 18;
    const boxW = 36;
    const midX = PAD_L + innerW / 2;
    const whiskerW = 18;

    const ticks = niceTicks(0, yMax, 4);
    const tickMarks = ticks.map(t => `
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yScale(t)}" y2="${yScale(t)}" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
      <text x="${PAD_L - 4}" y="${yScale(t) + 3}" text-anchor="end" fill="#9BABA8" font-family="JetBrains Mono, monospace" font-size="9">${t}</text>
    `).join('');

    const outlierMarkers = s.outliers.length
      ? `<g class="pd-outliers" transform="translate(${midX}, ${PAD_T - 4})">
          <text x="0" y="0" text-anchor="middle" fill="#f4c14a" font-family="JetBrains Mono, monospace" font-size="13" font-weight="600">↑ ${s.outliers.length}</text>
        </g>`
      : '';

    return `<div class="pd-plot" data-phase="${p.key}">
      <div class="pd-plot-title" style="border-color:${p.color}"><span class="pd-plot-code">${p.key}</span><span class="pd-plot-name">${p.label}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="pd-plot-svg">
        ${tickMarks}
        <!-- Whiskers -->
        <line x1="${midX}" x2="${midX}" y1="${yScale(s.whiskerUpper)}" y2="${yScale(s.q3)}" stroke="${p.color}" stroke-width="1.5"/>
        <line x1="${midX}" x2="${midX}" y1="${yScale(s.q1)}" y2="${yScale(s.min)}" stroke="${p.color}" stroke-width="1.5"/>
        <line x1="${midX - whiskerW/2}" x2="${midX + whiskerW/2}" y1="${yScale(s.whiskerUpper)}" y2="${yScale(s.whiskerUpper)}" stroke="${p.color}" stroke-width="1.5"/>
        <line x1="${midX - whiskerW/2}" x2="${midX + whiskerW/2}" y1="${yScale(s.min)}" y2="${yScale(s.min)}" stroke="${p.color}" stroke-width="1.5"/>
        <!-- Box -->
        <rect x="${boxX}" y="${yScale(s.q3)}" width="${boxW}" height="${yScale(s.q1) - yScale(s.q3)}" fill="${p.color}" fill-opacity="0.22" stroke="${p.color}" stroke-width="1.5" rx="2"/>
        <!-- Median line -->
        <line x1="${boxX}" x2="${boxX + boxW}" y1="${yScale(s.q2)}" y2="${yScale(s.q2)}" stroke="${p.color}" stroke-width="2.5"/>
        <!-- Mean marker (hollow circle) + value label on the plot -->
        <circle cx="${midX}" cy="${yScale(s.mean)}" r="3.5" fill="rgba(8,12,20,.96)" stroke="${p.color}" stroke-width="1.5"/>
        <text x="${boxX + boxW + 4}" y="${yScale(s.mean) + 3}" text-anchor="start" fill="${p.color}" font-family="JetBrains Mono, monospace" font-size="9.5" font-weight="600">${s.mean.toFixed(1)}</text>
        ${outlierMarkers}
      </svg>
      <div class="pd-plot-foot">
        <span class="pd-foot-lbl" title="Median">M</span><span class="pd-foot-val">${s.q2.toFixed(1)}d</span>
        <span class="pd-foot-sep">·</span>
        <span class="pd-foot-lbl" title="Mean (○)">μ</span><span class="pd-foot-val">on plot</span>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Empty state — fewer than 2 complete (siteWH) chains.
  ═════════════════════════════════════════════════════════════════════════ */
  function renderPhaseEmpty(material, drawnCount, actCount){
    return `
        <div class="pd-empty">
          <div class="pd-empty-lab">Need at least 2 complete chains</div>
          <h3>Phase Distribution requires chains that reached Site WH</h3>
          <p>Currently <b>${drawnCount}</b> chain${drawnCount === 1 ? '' : 's'} with full Phase A–E data for material <b>${escapeHtml(material)}</b>.</p>
          <p>Box plots compute quartiles + Tukey fence per phase across the <em>active set</em> (post year / sigma / manual filters). PR-only and in-flight chains carry null phase values and are excluded from this view; they still appear in Raw Data.</p>
          ${drawnCount === 0 && actCount > 0
            ? `<p class="pd-hint">${actCount} chain${actCount === 1 ? '' : 's'} active but none have a Site WH receipt — see Procurement Chain view for the state breakdown.</p>`
            : ''}
        </div>
      `;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Visual — chevron + box-plot grid + transposed stats table + caveat.
     `drawn` = active chains with a Site WH receipt (>= 2). Copied verbatim
     from trace.js renderPhaseDistribution (the post-empty-state branch).
  ═════════════════════════════════════════════════════════════════════════ */
  function renderPhaseVisual(drawn){
    // ── Per-phase stats ───────────────────────────────────────────────────
    const phaseStats = PHASE_KEYS.map(ph => ({
      key:   ph,
      label: PHASE_LABELS[ph],
      color: PHASE_COLORS[PHASE_KEYS.indexOf(ph)],
      stats: boxStats(drawn.map(c => c[ph]))
    }));

    // Total LT chevron — APP-FIX-PD-CHEVRON: flow covers A–D (up to site
    // availability); phase E (Time to First Use) split out as a purple shelf
    // block. totalMean spans A–E and drives the box-plot shared y-scale.
    const phaseMeans = phaseStats.map(p => (p.stats ? p.stats.mean : 0));
    const totalMean  = phaseMeans.reduce((s, v) => s + v, 0);
    const flowPhases = phaseStats.filter(p => p.key !== 'E');
    const ePhase     = phaseStats.find(p => p.key === 'E');
    const flowMean   = flowPhases.reduce((s, p) => s + (p.stats ? p.stats.mean : 0), 0);
    const eMean      = (ePhase && ePhase.stats) ? ePhase.stats.mean : 0;
    const flowPct    = flowPhases.map(p => (flowMean > 0 ? (p.stats ? p.stats.mean : 0) / flowMean : 0));
    const chevronHtml = `
      <div class="pd-chevron">
        <div class="pd-chevron-lab">Total Lead Time to site availability · phase decomposition · avg across ${drawn.length} chain${drawn.length === 1 ? '' : 's'}</div>
        <div class="pd-chevron-row">
          <div class="pd-chevron-bar">
            ${flowPhases.map((p, i) => `
              <div class="pd-chev-seg" style="flex: ${flowPct[i] || 0.001}; background: ${p.color}; --pd-chev-fill: ${p.color};">
                <div class="pd-chev-inner">
                  <span class="pd-chev-code">${p.key}</span>
                  <span class="pd-chev-name">${p.label}</span>
                  <span class="pd-chev-val">${p.stats ? p.stats.mean.toFixed(1) : '—'}d</span>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="pd-chev-total-site" title="Average total processing time until the material is received at site (phases A–D). Excludes shelf time before first use.">
            <span class="lab">Total to site</span>
            <span class="v">${flowMean.toFixed(1)}d</span>
          </div>
          ${ePhase ? `
          <div class="pd-chev-shelf" style="border-color:${ePhase.color}; background:${ePhase.color}1f;" title="Average time the material sits on the shelf after arriving at site, before its first consumption (phase E). Not part of the lead-time-to-availability total.">
            <span class="pd-chev-shelf-lab">then on shelf</span>
            <span class="pd-chev-shelf-name">${ePhase.key} · ${ePhase.label}</span>
            <span class="pd-chev-shelf-val" style="color:${ePhase.color};">${ePhase.stats ? eMean.toFixed(1) : '—'}d</span>
          </div>` : ''}
        </div>
      </div>
    `;

    // ── Build SVG box plots (uniform y-scale, APP-FIX-PD-POLISH A) ─────────
    const pdFenceMax = Math.max(0, ...phaseStats.map(p => p.stats ? Math.max(p.stats.whiskerUpper, p.stats.q3) : 0));
    let pdYMax = Math.ceil((totalMean * 1.2) / 10) * 10;
    pdYMax = Math.max(pdYMax, Math.ceil(pdFenceMax / 10) * 10, 10);
    const plotHtml = `
      <div class="pd-plots">
        ${phaseStats.map(p => renderBoxPlotSvg(p, pdYMax)).join('')}
      </div>
    `;

    // ── Stats table — transposed (columns = phases A–E) ───────────────────
    const PD_STAT_ROWS = [
      { lab:'N',        fmt: s => String(s.n) },
      { lab:'Min',      fmt: s => s.min.toFixed(1) },
      { lab:'Q1',       fmt: s => s.q1.toFixed(1) },
      { lab:'Median',   fmt: s => s.q2.toFixed(1) },
      { lab:'Mean',     fmt: s => s.mean.toFixed(1), bold:true },
      { lab:'Q3',       fmt: s => s.q3.toFixed(1) },
      { lab:'Max',      fmt: s => s.max.toFixed(1) },
      { lab:'Outliers', fmt: s => String(s.outliers.length), warn: s => s.outliers.length > 0 }
    ];
    const tableHtml = `
      <div class="pd-stats-wrap">
        <table class="pd-stats pd-stats-t">
          <thead>
            <tr>
              <th class="rowlab"></th>
              ${phaseStats.map(p => `<th class="num"><span class="pd-phase-dot" style="background:${p.color}"></span>${p.key}<span class="pd-th-name">${p.label}</span></th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${PD_STAT_ROWS.map(row => `
              <tr>
                <td class="rowlab">${row.lab}</td>
                ${phaseStats.map(p => {
                  if (!p.stats) return `<td class="num mono empty">—</td>`;
                  const warn = row.warn && row.warn(p.stats) ? ' warn' : '';
                  const val  = row.fmt(p.stats);
                  return `<td class="num mono${warn}">${row.bold ? `<b>${val}</b>` : val}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    return `
      ${chevronHtml}
      ${plotHtml}
      ${tableHtml}
      <div class="chart-caveat">All five plots share one y-axis (scaled to avg total LT + 20%) so phase durations compare directly. Box plots show Q1/Median/Q3 per phase. Whiskers extend to min and to the largest value below the <b>Tukey upper fence</b> (Q3 + 1.5·IQR). Outliers above the fence render as <span class="pd-mark">↑</span> markers above each plot. Mean is a hollow circle with its value labelled on the plot. N is the count of <em>complete</em> chains (those that reached Site WH) within the active filter set.</div>
    `;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     render — all-in-one for the Screener (computes + branches + writes host).
       opts.filters    = { yearFilter, sigmaLimit, manualExcl }  (all optional)
       opts.toolbarHtml = optional markup prepended above the visual (Trace's
                          filter toolbar; the Screener passes nothing)
  ═════════════════════════════════════════════════════════════════════════ */
  function render(hostEl, json, material, opts){
    opts = opts || {};
    const filters = opts.filters || {};
    const toolbar = opts.toolbarHtml || '';
    const chains = computeChains(json, material);
    const act    = activeChains(chains, filters);
    const drawn  = act.filter(c => !!c.siteWH);
    if (drawn.length < 2) {
      hostEl.innerHTML = toolbar + renderPhaseEmpty(material, drawn.length, act.length);
    } else {
      hostEl.innerHTML = toolbar + renderPhaseVisual(drawn);
    }
    return { chains, act, drawn };
  }

  window.TracePhase = {
    PHASE_KEYS, PHASE_LABELS, PHASE_COLORS,
    computeChains,
    boxStats,
    getChainYear,
    getYearsForChains,
    sigmaExcl,
    activeChains,
    renderBoxPlotSvg,
    renderPhaseEmpty,
    renderPhaseVisual,
    render
  };

})();
