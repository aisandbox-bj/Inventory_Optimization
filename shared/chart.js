/* ═══════════════════════════════════════════════════════════════════════════
   Chart — inline SVG consumption chart with P1/P2 trend lines + WO annotations.
   Mirrors the matplotlib output from 03_build_charts.py.

   Usage:
     AppChart.render(targetEl, material, { width:720, height:340 });
     AppChart.toPng(svgEl).then(dataUrl => …)
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /* ─── Palette (Birchwood-aligned, slightly muted for data legibility) ───── */
  const PAL = {
    bg:       '#0C2D3B',
    grid:     '#164049',
    axis:     '#9BABA8',
    cumLine:  '#FBBF24',  // amber/orange — cumulative actual
    p1Line:   '#5DD9E2',  // brighter cyan — P1 baseline trend
    p2Line:   '#7CDDB2',  // brighter green — P2 current trend
    p1Zone:   'rgba(31,206,216,0.055)',
    p2Zone:   'rgba(90,182,157,0.075)',
    text:     '#D6DFDE',
    textDim:  '#9BABA8',
    annot:    '#FBBF24',
    annotDim: '#9BABA8',
    crit:     '#EF4444',
    // APP-E1 (v2.1.3) — stockout-aware diagnostic palette
    sohLine:    '#A78BFA',                   // soft violet — SOH back-calc line (right axis)
    stockBand:  'rgba(239,83,80,0.16)',      // muted red wash — stockout windows
    stockEdge:  'rgba(239,83,80,0.55)',      // crisp red edge — stockout window borders
    lastCons:   '#FB923C'                    // burnt orange — vertical "last consumption" marker
  };

  function el(name, attrs, children){
    const node = document.createElementNS(NS, name);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      node.setAttribute(k, String(v));
    }
    if (children) for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  function text(x, y, content, opts){
    opts = opts || {};
    const t = el('text', {
      x, y,
      fill: opts.fill || PAL.text,
      'font-family': opts.font || 'JetBrains Mono, monospace',
      'font-size':   opts.size || 10,
      'font-weight': opts.weight || 400,
      'letter-spacing': opts.tracking || .3,
      'text-anchor': opts.anchor || 'start',
      opacity: opts.opacity != null ? opts.opacity : 1
    });
    t.textContent = String(content);
    if (opts.rotate) t.setAttribute('transform', `rotate(${opts.rotate} ${x} ${y})`);
    return t;
  }

  function line(x1, y1, x2, y2, opts){
    opts = opts || {};
    return el('line', {
      x1, y1, x2, y2,
      stroke: opts.stroke || PAL.axis,
      'stroke-width': opts.width || 1,
      'stroke-dasharray': opts.dash || null,
      'stroke-linecap': opts.cap || 'square',
      opacity: opts.opacity != null ? opts.opacity : 1
    });
  }

  function rect(x, y, w, h, opts){
    opts = opts || {};
    return el('rect', { x, y, width: w, height: h, fill: opts.fill || 'none', opacity: opts.opacity != null ? opts.opacity : 1, stroke: opts.stroke || 'none' });
  }

  function polyline(points, opts){
    opts = opts || {};
    return el('polyline', {
      points,
      fill: 'none',
      stroke: opts.stroke || PAL.cumLine,
      'stroke-width': opts.width || 2,
      'stroke-linejoin': opts.join || 'miter',
      'stroke-linecap':  opts.cap  || 'square',
      'stroke-dasharray': opts.dash || null,
      opacity: opts.opacity != null ? opts.opacity : 1,
      class: opts.class || null
    });
  }

  /* ─── Render a chart into a target element ──────────────────────────────── */
  function render(target, material, opts){
    opts = opts || {};
    const W = opts.width  || 720;
    const H = opts.height || 340;
    const MARGIN = { top: 28, right: 70, bottom: 50, left: 60 };
    const innerW = W - MARGIN.left - MARGIN.right;
    const innerH = H - MARGIN.top  - MARGIN.bottom;

    while (target.firstChild) target.removeChild(target.firstChild);

    const svg = el('svg', {
      xmlns: NS,
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: H,
      'preserveAspectRatio': 'xMidYMid meet',
      style: 'display:block'
    });
    target.appendChild(svg);

    // APP-TREND-DYN — custom-period select-mode flag, declared early so the
    // hover handler (added later) can suppress its tooltip while the operator
    // is picking the start/end of a custom period.
    let cpMode = false;

    // background
    svg.appendChild(rect(0, 0, W, H, { fill: PAL.bg }));

    // Build domain
    let cum = material.cumulative || [];

    // ── Empty-state: truly no transactions on file ─────────────────────────
    if (cum.length === 0) {
      svg.appendChild(text(W/2, H/2, 'no consumption transactions found', { anchor: 'middle', fill: PAL.textDim, size: 12 }));
      return svg;
    }

    // ── Sparse-data pad ─────────────────────────────────────────────────────
    // A material whose issues all landed on a single posting date (typical for
    // a one-shot rebuild or a single batch order) collapses to ONE cumulative
    // point. Without padding the chart bails. Add a synthetic zero-anchor at
    // the start of the P1 window so the step-line can render, and a trailing
    // flat point at the analysis end (run date / P2 end) so the post-event
    // plateau is visible.
    const startISO = material.p1Start || cum[0].date;
    const endISO   = material.p2End   || cum[cum.length - 1].date;
    if (new Date(startISO).getTime() < new Date(cum[0].date).getTime() && cum[0].cum !== 0) {
      cum = [{ date: startISO, delta: 0, cum: 0 }, ...cum];
    }
    if (new Date(endISO).getTime() > new Date(cum[cum.length - 1].date).getTime()) {
      cum = [...cum, { date: endISO, delta: 0, cum: cum[cum.length - 1].cum }];
    }
    // Final safety: if we still have < 2 points, duplicate the lone point so
    // the polyline has somewhere to step to.
    if (cum.length < 2) {
      const only = cum[0];
      cum = [{ date: startISO, delta: 0, cum: 0 }, only];
    }

    const dates = cum.map(p => new Date(p.date).getTime());
    const cums  = cum.map(p => p.cum);
    let xMin = Math.min(...dates);
    let xMax = Math.max(...dates);
    // Pad x by 7 days
    const xPad = (xMax - xMin) * 0.02 || 7 * 86400000;
    xMin -= xPad; xMax += xPad;
    const yMin = Math.min(0, ...cums);
    const yMax = Math.max(...cums) * 1.08 || 1;

    const xScale = (t) => MARGIN.left + (t - xMin) / (xMax - xMin) * innerW;
    const yScale = (v) => MARGIN.top + (1 - (v - yMin) / (yMax - yMin)) * innerH;

    // ─── Period zones (P1 cyan, P2 green) ─────────────────────────────────
    const p1S = new Date(material.p1Start).getTime();
    const p1E = new Date(material.p1End  ).getTime();
    const p2S = new Date(material.p2Start).getTime();
    const p2E = new Date(material.p2End  ).getTime();
    if (p1S >= xMin && p1S <= xMax) {
      const x1 = xScale(Math.max(xMin, p1S));
      const x2 = xScale(Math.min(xMax, p1E));
      svg.appendChild(rect(x1, MARGIN.top, x2 - x1, innerH, { fill: PAL.p1Zone }));
      svg.appendChild(text((x1+x2)/2, MARGIN.top + 12, 'P1 · BASELINE', { anchor:'middle', fill: PAL.p1Line, size: 9.5, tracking: 1.3 }));
    }
    if (p2S >= xMin && p2S <= xMax) {
      const x1 = xScale(Math.max(xMin, p2S));
      const x2 = xScale(Math.min(xMax, p2E));
      svg.appendChild(rect(x1, MARGIN.top, x2 - x1, innerH, { fill: PAL.p2Zone }));
      svg.appendChild(text((x1+x2)/2, MARGIN.top + 12, 'P2 · ROLLING', { anchor:'middle', fill: PAL.p2Line, size: 9.5, tracking: 1.3 }));
    }

    // ─── Gridlines + Y-axis ticks ─────────────────────────────────────────
    const yTicks = niceTicks(yMin, yMax, 4);
    for (const v of yTicks) {
      const y = yScale(v);
      svg.appendChild(line(MARGIN.left, y, MARGIN.left + innerW, y, { stroke: PAL.grid, width: 1, opacity: .7 }));
      svg.appendChild(text(MARGIN.left - 8, y + 3, fmtNum(v), { anchor: 'end', fill: PAL.textDim, size: 9 }));
    }
    // Y-axis label
    svg.appendChild(text(14, MARGIN.top + innerH/2, 'CUMULATIVE QTY', { anchor: 'middle', fill: PAL.textDim, size: 9, rotate: -90, tracking: 1.3 }));

    // ─── X-axis ticks (months) ────────────────────────────────────────────
    const xTicks = monthTicks(xMin, xMax, 6);
    for (const t of xTicks) {
      const x = xScale(t);
      svg.appendChild(line(x, MARGIN.top + innerH, x, MARGIN.top + innerH + 4, { stroke: PAL.axis, width: 1 }));
      svg.appendChild(text(x, MARGIN.top + innerH + 16, fmtMonth(t), { anchor: 'middle', fill: PAL.textDim, size: 9 }));
    }
    // axes
    svg.appendChild(line(MARGIN.left, MARGIN.top, MARGIN.left, MARGIN.top + innerH, { stroke: PAL.axis, width: 1 }));
    svg.appendChild(line(MARGIN.left, MARGIN.top + innerH, MARGIN.left + innerW, MARGIN.top + innerH, { stroke: PAL.axis, width: 1 }));

    // ─── Cumulative step line ─────────────────────────────────────────────
    const points = [];
    for (let i = 0; i < cum.length; i++) {
      const t = new Date(cum[i].date).getTime();
      const x = xScale(t);
      const y = yScale(cum[i].cum);
      if (i > 0) {
        const prev = cum[i-1];
        const xPrev = xScale(new Date(prev.date).getTime());
        const yPrev = yScale(prev.cum);
        points.push(`${x},${yPrev}`); // step horizontal
      }
      points.push(`${x},${y}`);
    }
    // APP-E11 — tag for legend toggle (.chart-host.hide-cum hides this).
    svg.appendChild(polyline(points.join(' '), { stroke: PAL.cumLine, width: 2, class: 'chart-cumulative-line' }));

    // ─── Trend lines ──────────────────────────────────────────────────────
    // Anchor both endpoints to the cumulative line itself so the trend is a
    // visual chord across the period. Slope of the chord equals avg net
    // consumption per month over the actual period — what a planner expects.
    function cumAt(t){
      // Find latest cum value at or before t (step semantics)
      let v = 0, found = false;
      for (const p of cum) {
        const pt = new Date(p.date).getTime();
        if (pt <= t) { v = p.cum; found = true; }
        else break;
      }
      return found ? v : (cum.length ? cum[0].cum : 0);
    }
    function trendLine(startISO, endISO, rate, color, label){
      if (rate == null) return;
      const sT = new Date(startISO).getTime();
      const eT = new Date(endISO).getTime();
      const yStart = cumAt(sT - 1);          // value going INTO the period
      const yEnd   = cumAt(eT);              // value at the end of the period
      const x1 = xScale(sT), y1 = yScale(yStart);
      const x2 = xScale(eT), y2 = yScale(yEnd);
      svg.appendChild(line(x1, y1, x2, y2, { stroke: color, width: 2.5, dash: '7 4' }));
      // Anchor markers
      svg.appendChild(el('circle', { cx: x1, cy: y1, r: 3.2, fill: color, opacity: 0.95 }));
      svg.appendChild(el('circle', { cx: x2, cy: y2, r: 3.2, fill: color, opacity: 0.95 }));
      // Rate label — placed above-right of end anchor with a thin connector
      const labX = x2 + 8;
      const labY = y2 - 6;
      svg.appendChild(line(x2 + 3, y2 - 1, labX - 1, labY + 3, { stroke: color, width: 1, opacity: 0.55 }));
      svg.appendChild(text(labX, labY, label, { fill: color, size: 10.5, weight: 600 }));
    }
    if (material.p1Flag === 'OK') {
      trendLine(material.p1Start, material.p1End, material.p1Rate, PAL.p1Line, `P1 · ${material.p1Rate.toFixed(1)}/mo`);
    }
    if (material.p2Flag === 'OK') {
      trendLine(material.p2Start, material.p2End, material.p2Rate, PAL.p2Line, `P2 · ${material.p2Rate.toFixed(1)}/mo`);
    }

    // ─── APP-E1 · SOH back-calc overlay + stockout bands + last-cons marker ─
    // Renders on a SECONDARY right-side Y-axis (SOH is in units-in-stock,
    // not cumulative consumption — distinct scale). Stockout windows render
    // as red wash bands behind the main chart. Last consumption marker is a
    // vertical orange dashed line so the operator can read "this is where
    // consumption stopped" at a glance.
    const sohSeries = material.stockOnHandSeries || [];
    const stockoutWindows = material.stockoutWindows || [];
    const lastConsDate = material.lastConsumptionDate || null;
    const hasSohOverlay = sohSeries.length > 0;
    let yScaleSOH = null;
    if (hasSohOverlay) {
      // APP-E11 — wrap the SOH overlay (bands + line + right Y-axis) in a
      // single <g class="chart-grp-soh"> so the legend toggle can hide the
      // whole stock-on-hand layer with one CSS rule.
      const gSoh = el('g', { class: 'chart-grp-soh' });

      // Build SOH y-scale independent of cumulative scale
      const sohVals = sohSeries.map(p => p.soh);
      const sohMin = Math.min(0, ...sohVals);
      const sohMax = Math.max(...sohVals, 1) * 1.08;
      yScaleSOH = (v) => MARGIN.top + (1 - (v - sohMin) / (sohMax - sohMin)) * innerH;

      // (a) Stockout bands — render FIRST so they sit behind the SOH line
      for (const w of stockoutWindows) {
        const ws = new Date(w.start).getTime();
        const we = new Date(w.end).getTime();
        // Add a half-day pad on each side so single-day stockouts are visible
        const x1 = xScale(Math.max(xMin, ws - 43200000));
        const x2 = xScale(Math.min(xMax, we + 43200000));
        if (x2 <= x1) continue;
        gSoh.appendChild(rect(x1, MARGIN.top, x2 - x1, innerH, { fill: PAL.stockBand }));
        // Crisp edge lines top + bottom of the band for definition
        gSoh.appendChild(line(x1, MARGIN.top, x2, MARGIN.top, { stroke: PAL.stockEdge, width: 0.7, opacity: 0.8 }));
        gSoh.appendChild(line(x1, MARGIN.top + innerH, x2, MARGIN.top + innerH, { stroke: PAL.stockEdge, width: 0.7, opacity: 0.8 }));
        // Label centered above the band
        const cx = (x1 + x2) / 2;
        const lab = w.days >= 2 ? `STOCKOUT · ${w.days}d` : 'STOCKOUT';
        gSoh.appendChild(text(cx, MARGIN.top + innerH - 6, lab, { anchor: 'middle', fill: PAL.stockEdge, size: 8.5, weight: 600, tracking: 1 }));
      }

      // (b) SOH back-calc line — daily, drawn as a smooth polyline
      const sohPts = sohSeries
        .filter(p => {
          const t = new Date(p.date).getTime();
          return t >= xMin && t <= xMax;
        })
        .map(p => {
          const x = xScale(new Date(p.date).getTime());
          const y = yScaleSOH(p.soh);
          return `${x},${y}`;
        });
      if (sohPts.length >= 2) {
        gSoh.appendChild(polyline(sohPts.join(' '), { stroke: PAL.sohLine, width: 1.8, opacity: 0.95, cap: 'round', join: 'round' }));
      }

      // (c) Right Y-axis for SOH — ticks + label
      const sohTicks = niceTicks(sohMin, sohMax, 4);
      for (const v of sohTicks) {
        const y = yScaleSOH(v);
        gSoh.appendChild(line(MARGIN.left + innerW, y, MARGIN.left + innerW + 4, y, { stroke: PAL.sohLine, width: 1, opacity: 0.7 }));
        gSoh.appendChild(text(MARGIN.left + innerW + 8, y + 3, fmtNum(v), { anchor: 'start', fill: PAL.sohLine, size: 9, opacity: 0.85 }));
      }
      gSoh.appendChild(text(W - 14, MARGIN.top + innerH/2, 'STOCK ON HAND', { anchor: 'middle', fill: PAL.sohLine, size: 9, rotate: 90, tracking: 1.3 }));
      svg.appendChild(gSoh);
    }

    // (d) Last consumption marker — vertical orange dashed line
    if (lastConsDate) {
      const t = new Date(lastConsDate).getTime();
      if (t >= xMin && t <= xMax) {
        const x = xScale(t);
        svg.appendChild(line(x, MARGIN.top, x, MARGIN.top + innerH, {
          stroke: PAL.lastCons, width: 1.6, dash: '5 3', opacity: 0.9
        }));
        // Label placed at the bottom of the marker so it doesn't collide with the
        // P1/P2 zone labels at the top
        svg.appendChild(text(x + 4, MARGIN.top + innerH - 22, 'LAST CONSUMPTION', {
          fill: PAL.lastCons, size: 8.5, weight: 600, tracking: 1.2
        }));
        svg.appendChild(text(x + 4, MARGIN.top + innerH - 12, lastConsDate, {
          fill: PAL.lastCons, size: 8.5, opacity: 0.85
        }));
      }
    }

    // ─── Inv Adj annotations (vertical dashed purple lines on confirmed dates) ─
    const invAdj = material.invAdj || [];
    for (const ev of invAdj) {
      const t = new Date(ev.date).getTime();
      if (t < xMin || t > xMax) continue;
      const x = xScale(t);
      // Vertical dashed line across plot, distinct purple to differentiate from HCE
      svg.appendChild(line(x, MARGIN.top, x, MARGIN.top + innerH, {
        stroke: '#B07CC6', width: 1.5, dash: '4 3', opacity: 0.85
      }));
      svg.appendChild(text(x + 3, MARGIN.top + 12, `INV ADJ`, {
        fill: '#B07CC6', size: 9, weight: 600, tracking: 1.2
      }));
    }

    // ─── WO annotations (HCE events, top 3 by qty) ────────────────────────
    const hceAll = (material.hceP1 || []).concat(material.hceP2 || []);
    const annots = hceAll.slice().sort((a, b) => b.qty - a.qty).slice(0, 3);
    for (const ev of annots) {
      const t = new Date(ev.date).getTime();
      if (t < xMin || t > xMax) continue;
      const x = xScale(t);
      // find cum value at this date
      let yv = 0;
      for (const p of cum) {
        const pt = new Date(p.date).getTime();
        if (pt <= t) yv = p.cum;
      }
      const yPt = yScale(yv);
      // marker dot
      svg.appendChild(el('circle', { cx: x, cy: yPt, r: 3.5, fill: PAL.annot }));
      // leader line + label box up-right
      const labX = x + 8;
      const labY = Math.max(MARGIN.top + 22, yPt - 30);
      svg.appendChild(line(x, yPt, labX, labY, { stroke: PAL.annotDim, width: 1, dash: '2 2', opacity: 0.7 }));
      svg.appendChild(text(labX, labY,      `↓ WO ${ev.order}`,    { fill: PAL.annot, size: 9.5, weight: 500 }));
      const desc = (ev.description || '').slice(0, 28);
      if (desc) svg.appendChild(text(labX, labY + 11, desc.toUpperCase(), { fill: PAL.annotDim, size: 8.5, tracking: .3 }));
      svg.appendChild(text(labX, labY + 22, `${ev.equipment || '—'} · ${ev.qty} EA`, { fill: PAL.annotDim, size: 8.5 }));
    }

    // ─── Legend (top-right) ───────────────────────────────────────────────
    // APP-E1: extra entries added when SOH overlay or stockout windows present.
    const legY = MARGIN.top - 14;
    const legHasSoh = hasSohOverlay;
    const legHasStockout = stockoutWindows.length > 0;
    const legEntries = 3 + (legHasSoh ? 1 : 0) + (legHasStockout ? 1 : 0);
    // Push legend left when entries grow so it doesn't run off the right edge
    let legX = W - MARGIN.right - (legEntries * 64);
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.cumLine, width: 2 }));
    svg.appendChild(text(legX + 24, legY + 3, 'CUMULATIVE', { fill: PAL.text, size: 9, tracking: 1 }));
    legX += 100;
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.p1Line, width: 2, dash: '5 3' }));
    svg.appendChild(text(legX + 24, legY + 3, 'P1', { fill: PAL.text, size: 9, tracking: 1 }));
    legX += 50;
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.p2Line, width: 2, dash: '5 3' }));
    svg.appendChild(text(legX + 24, legY + 3, 'P2', { fill: PAL.text, size: 9, tracking: 1 }));
    if (legHasSoh) {
      legX += 50;
      svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.sohLine, width: 1.8 }));
      svg.appendChild(text(legX + 24, legY + 3, 'STOCK', { fill: PAL.text, size: 9, tracking: 1 }));
    }
    if (legHasStockout) {
      legX += 60;
      svg.appendChild(rect(legX, legY - 5, 18, 9, { fill: PAL.stockBand, stroke: PAL.stockEdge, opacity: 1 }));
      svg.appendChild(text(legX + 24, legY + 3, 'STOCKOUT', { fill: PAL.text, size: 9, tracking: 1 }));
    }

    // ─── APP-TREND-HOV · per-event hover tooltips (consumption + SOH lines) ──
    // opts.movements = { consumption:[{date,mt,mtDesc,qty}], stock:[…] } (built
    // by MovementDetail). A faint hit dot sits on each line at every date that
    // has movements; hovering it shows that date's movements (code · descr · qty,
    // absolute — direction is in the description). Tagged with the same toggle
    // classes so a hidden line's dots disappear (and stop receiving hover) too.
    if (opts.movements && (opts.movements.consumption || opts.movements.stock)) {
      const groupByDate = (arr) => {
        const m = new Map();
        for (const mv of (arr || [])) { if (!m.has(mv.date)) m.set(mv.date, []); m.get(mv.date).push(mv); }
        return m;
      };
      const consByDate  = groupByDate(opts.movements.consumption);
      const stockByDate  = groupByDate(opts.movements.stock);
      const sohByDate = new Map();
      for (const p of sohSeries) sohByDate.set(p.date, p.soh);

      target.style.position = 'relative';
      const tip = document.createElement('div');
      tip.className = 'chart-tip hidden';
      target.appendChild(tip);

      const fmtQ = (q) => (Math.round(q * 100) / 100).toLocaleString();
      function tipHtml(date, movs, line, sohFoot){
        const MAXR = 8;
        let rows = movs.slice(0, MAXR).map(mv =>
          `<div class="ct-row"><span class="ct-mt">${mv.mt}</span><span class="ct-desc">${mv.mtDesc}</span><span class="ct-q">${fmtQ(mv.qty)}</span></div>`
        ).join('');
        if (movs.length > MAXR) rows += `<div class="ct-more">+${movs.length - MAXR} more…</div>`;
        const foot = (sohFoot != null) ? `<div class="ct-foot">Stock after: ${fmtQ(sohFoot)}</div>` : '';
        return `<div class="ct-date ${line === 'soh' ? 'soh' : 'cum'}">${date}</div>${rows}${foot}`;
      }
      function positionTip(e){
        const r = target.getBoundingClientRect();
        let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        if (x + tw > r.width)  x = (e.clientX - r.left) - tw - 14;
        if (y + th > r.height) y = Math.max(2, (e.clientY - r.top) - th - 14);
        tip.style.left = Math.max(2, x) + 'px';
        tip.style.top  = Math.max(2, y) + 'px';
      }
      svg.addEventListener('mouseover', (e) => {
        if (cpMode) return;   // APP-TREND-DYN — no hover tooltip while picking a custom period
        const t = e.target;
        if (!t || !t.classList || !t.classList.contains('chart-hit')) return;
        const line = t.getAttribute('data-line');
        const date = t.getAttribute('data-date');
        const movs = (line === 'soh' ? stockByDate : consByDate).get(date);
        if (!movs) return;
        const sohFoot = (line === 'soh' && sohByDate.has(date)) ? sohByDate.get(date) : null;
        tip.innerHTML = tipHtml(date, movs, line, sohFoot);
        tip.classList.remove('hidden');
        positionTip(e);
      });
      svg.addEventListener('mousemove', (e) => { if (!tip.classList.contains('hidden')) positionTip(e); });
      svg.addEventListener('mouseout', (e) => {
        const t = e.target;
        if (t && t.classList && t.classList.contains('chart-hit')) tip.classList.add('hidden');
      });

      const gCum = el('g', { class: 'chart-cumulative-line chart-hit-grp' });
      for (const p of cum) {
        const movs = consByDate.get(p.date);
        if (!movs) continue;
        const x = xScale(new Date(p.date).getTime());
        const y = yScale(p.cum);
        gCum.appendChild(el('circle', { cx: x, cy: y, r: 6, class: 'chart-hit', fill: PAL.cumLine, 'fill-opacity': 0.08, 'data-line': 'cum', 'data-date': p.date }));
      }
      svg.appendChild(gCum);

      if (hasSohOverlay && yScaleSOH) {
        const gSohHit = el('g', { class: 'chart-grp-soh chart-hit-grp' });
        for (const [date] of stockByDate) {
          const tt = new Date(date).getTime();
          if (tt < xMin || tt > xMax || !sohByDate.has(date)) continue;
          gSohHit.appendChild(el('circle', { cx: xScale(tt), cy: yScaleSOH(sohByDate.get(date)), r: 6, class: 'chart-hit', fill: PAL.sohLine, 'fill-opacity': 0.08, 'data-line': 'soh', 'data-date': date }));
        }
        svg.appendChild(gSohHit);
      }
    }

    // ─── Pattern marker (LUMPY badge top-left) ────────────────────────────
    if (material.pattern === 'LUMPY') {
      const bx = MARGIN.left + 4, by = MARGIN.top - 14;
      svg.appendChild(rect(bx, by - 9, 56, 14, { fill: 'rgba(251,191,36,0.18)', stroke: PAL.annot, opacity: .9 }));
      svg.appendChild(text(bx + 4, by + 1, 'LUMPY', { fill: PAL.annot, size: 9, weight: 600, tracking: 1.5 }));
    }

    // ─── APP-TREND-DYN · custom-period rate selector ────────────────────────
    // Right-click → "Dynamic period select" → click START then END on the
    // chart → a pink dashed "P" chord shows the net consumption rate (net ÷
    // months — same basis as P1/P2, drawn as the chord between the cumulative
    // values at the two endpoints) over the hand-picked window. For reading a
    // clean rate between P1 and P2 when those windows are contaminated by a
    // return or a stockout. Endpoints are free (operator decision); a readout
    // shows the resolved dates · net units · months so the math is transparent.
    {
      target.style.position = 'relative';
      const dataMin = new Date(cum[0].date).getTime();
      const dataMax = new Date(cum[cum.length - 1].date).getTime();
      const CP_COL = '#C77DFF';   // distinct purple (operator: "purple beats pink")
      const cpGroup = el('g', { class: 'chart-custom-period' });
      svg.appendChild(cpGroup);
      let cpStart = null, cpEnd = null;

      const menu = document.createElement('div');
      menu.className = 'chart-ctx-menu hidden';
      target.appendChild(menu);
      const hint = document.createElement('div');
      hint.className = 'chart-cp-hint hidden';
      target.appendChild(hint);

      const showHint = (m) => { hint.textContent = m; hint.classList.remove('hidden'); };
      const hideHint = () => hint.classList.add('hidden');
      const hideMenu = () => menu.classList.add('hidden');

      function isoDayOf(ms){ const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
      function eventToDate(e){
        const ctm = svg.getScreenCTM();
        if (!ctm) return null;
        const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
        const p = pt.matrixTransform(ctm.inverse());
        let frac = (p.x - MARGIN.left) / innerW;
        frac = Math.max(0, Math.min(1, frac));
        const ms = xMin + frac * (xMax - xMin);
        return Math.max(dataMin, Math.min(dataMax, ms));
      }
      function draw(sMs, eMs, preview){
        while (cpGroup.firstChild) cpGroup.removeChild(cpGroup.firstChild);
        if (sMs == null || eMs == null) return;
        const a = Math.min(sMs, eMs), b = Math.max(sMs, eMs);
        const ya = cumAt(a), yb = cumAt(b);
        const net = yb - ya;
        const months = Math.abs(b - a) / (30.44 * 86400000);
        const rate = months > 0 ? net / months : 0;
        const x1 = xScale(a), y1 = yScale(ya), x2 = xScale(b), y2 = yScale(yb);
        cpGroup.appendChild(rect(Math.min(x1, x2), MARGIN.top, Math.abs(x2 - x1), innerH, { fill: 'rgba(199,125,255,0.08)' }));
        cpGroup.appendChild(line(x1, MARGIN.top, x1, MARGIN.top + innerH, { stroke: CP_COL, width: 1, dash: '3 3', opacity: 0.5 }));
        cpGroup.appendChild(line(x2, MARGIN.top, x2, MARGIN.top + innerH, { stroke: CP_COL, width: 1, dash: '3 3', opacity: 0.5 }));
        cpGroup.appendChild(line(x1, y1, x2, y2, { stroke: CP_COL, width: 2.5, dash: '7 4', opacity: preview ? 0.6 : 1 }));
        cpGroup.appendChild(el('circle', { cx: x1, cy: y1, r: 3.2, fill: CP_COL }));
        cpGroup.appendChild(el('circle', { cx: x2, cy: y2, r: 3.2, fill: CP_COL }));
        let labX = x2 + 8, labY = y2 - 8;
        if (labX + 112 > MARGIN.left + innerW) { labX = Math.min(x1, x2) - 112; if (labX < MARGIN.left + 2) labX = MARGIN.left + 2; }
        if (labY < MARGIN.top + 12) labY = MARGIN.top + 12;
        const cpLabel   = text(labX, labY, `P · ${rate.toFixed(1)}/mo`, { fill: CP_COL, size: 11.5, weight: 700 });
        const cpReadout = text(labX, labY + 11, `${isoDayOf(a)}→${isoDayOf(b)} · ${Math.round(net * 10) / 10}u · ${months.toFixed(2)}mo`, { fill: CP_COL, size: 8.5, opacity: 0.95 });
        cpGroup.appendChild(cpLabel);
        cpGroup.appendChild(cpReadout);
        // APP-FIX-DYN-LEGIBILITY — grey backing behind the text so it stays legible
        // over busy chart areas (operator request). Sized from the rendered text bbox.
        try {
          const b1 = cpLabel.getBBox(), b2 = cpReadout.getBBox();
          const minX = Math.min(b1.x, b2.x), minY = Math.min(b1.y, b2.y);
          const maxX = Math.max(b1.x + b1.width, b2.x + b2.width), maxY = Math.max(b1.y + b1.height, b2.y + b2.height);
          const pad = 3.5;
          cpGroup.insertBefore(el('rect', { x: minX - pad, y: minY - pad, width: (maxX - minX) + 2 * pad, height: (maxY - minY) + 2 * pad, rx: 3, fill: 'rgba(16,24,30,0.86)', stroke: CP_COL, 'stroke-width': 0.8, 'stroke-opacity': 0.4 }), cpLabel);
        } catch (e) { /* getBBox unavailable — text stays without backing */ }
      }
      function clearPeriod(){ cpMode = false; cpStart = null; cpEnd = null; svg.style.cursor = ''; hideHint(); while (cpGroup.firstChild) cpGroup.removeChild(cpGroup.firstChild); }
      function startSelect(){ cpMode = true; cpStart = null; cpEnd = null; svg.style.cursor = 'crosshair'; const t = target.querySelector('.chart-tip'); if (t) t.classList.add('hidden'); showHint('Click the START of the period…'); }

      svg.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const r = target.getBoundingClientRect();
        menu.innerHTML = `<div class="cm-item" data-act="select">⤢ Dynamic period select</div>` + ((cpStart != null || cpEnd != null) ? `<div class="cm-item" data-act="clear">✕ Clear period</div>` : '');
        menu.classList.remove('hidden');
        let mx = e.clientX - r.left, my = e.clientY - r.top;
        if (mx + menu.offsetWidth > r.width) mx = r.width - menu.offsetWidth - 2;
        if (my + menu.offsetHeight > r.height) my = r.height - menu.offsetHeight - 2;
        menu.style.left = Math.max(0, mx) + 'px';
        menu.style.top = Math.max(0, my) + 'px';
      });
      menu.addEventListener('click', (e) => {
        const it = e.target.closest && e.target.closest('.cm-item'); if (!it) return;
        const act = it.getAttribute('data-act');
        hideMenu();
        if (act === 'select') startSelect();
        else if (act === 'clear') clearPeriod();
      });
      svg.addEventListener('mousedown', hideMenu);

      svg.addEventListener('click', (e) => {
        if (!cpMode) return;
        const d = eventToDate(e);
        if (d == null) return;
        if (cpStart == null){ cpStart = d; showHint('Click the END of the period…'); draw(cpStart, d, true); return; }
        if (Math.abs(d - cpStart) < 6 * 86400000){ showHint('Pick a wider end point (≥ ~1 week)…'); return; }
        cpEnd = d; cpMode = false; svg.style.cursor = ''; hideHint(); draw(cpStart, cpEnd, false);
      });
      svg.addEventListener('mousemove', (e) => {
        if (!cpMode || cpStart == null) return;
        const d = eventToDate(e);
        if (d != null) draw(cpStart, d, true);
      });
    }

    return svg;
  }

  /* ─── Helpers: nice ticks and month formatting ──────────────────────────── */
  function niceTicks(min, max, count){
    const span = max - min;
    if (span <= 0) return [min];
    const step0 = span / count;
    const mag   = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm  = step0 / mag;
    const step  = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + 1e-9; v += step) out.push(v);
    return out;
  }
  // APP-FIX-CHART-TZ — month ticks + labels are computed in UTC, not local time.
  // Data dates are 'YYYY-MM-DD' strings, which Date parses as UTC midnight, and
  // the whole app's date math is UTC (APP-FIX-BACKCALC-TZ). Using local getters
  // here (setDate/setMonth/getMonth) placed each tick ~7h off the data and could
  // shift a tick across a day/month boundary under a DST change — so ticks now
  // align exactly to the UTC-parsed data points.
  function monthTicks(xMin, xMax, target){
    const months = (xMax - xMin) / (30.44 * 86400000);
    const step   = Math.max(1, Math.round(months / target));
    const out = [];
    const d = new Date(xMin); d.setUTCDate(1); d.setUTCHours(0,0,0,0);
    while (d.getTime() <= xMax) {
      if (d.getTime() >= xMin) out.push(d.getTime());
      d.setUTCMonth(d.getUTCMonth() + step);
    }
    return out;
  }
  function fmtMonth(t){
    const d = new Date(t);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${months[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  }
  function fmtNum(v){
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
    if (Math.abs(v) >= 10)   return Math.round(v).toString();
    return (Math.round(v * 10) / 10).toString();
  }

  /* ─── SVG → PNG conversion (for LLM image input) ────────────────────────── */
  function _rasterize(svgEl, scale){
    scale = scale || 2;
    return new Promise((resolve, reject) => {
      try {
        const w = parseInt(svgEl.getAttribute('viewBox').split(' ')[2], 10);
        const h = parseInt(svgEl.getAttribute('viewBox').split(' ')[3], 10);
        const xml = new XMLSerializer().serializeToString(svgEl);
        const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width  = w * scale;
          canvas.height = h * scale;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#0C2D3B';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        };
        img.onerror = (e) => reject(e);
        img.src = svg64;
      } catch (e) { reject(e); }
    });
  }
  function toPng(svgEl, scale){ return _rasterize(svgEl, scale).then(c => c.toDataURL('image/png')); }
  /* APP-E3-PDF — JPEG export for PDF embedding. JPEG is far smaller than PNG for
     the dark chart fills; the on-screen render path is unchanged and still uses
     toPng. Default quality 0.65 (operator-chosen). */
  function toJpeg(svgEl, scale, quality){ return _rasterize(svgEl, scale).then(c => c.toDataURL('image/jpeg', quality == null ? 0.65 : quality)); }

  global.AppChart = Object.freeze({ render, toPng, toJpeg, PAL });

})(window);
