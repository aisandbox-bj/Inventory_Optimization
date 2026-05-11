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
    crit:     '#EF4444'
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
      opacity: opts.opacity != null ? opts.opacity : 1
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

    // background
    svg.appendChild(rect(0, 0, W, H, { fill: PAL.bg }));

    // Build domain
    const cum = material.cumulative || [];
    if (cum.length < 2) {
      svg.appendChild(text(W/2, H/2, 'no consumption data', { anchor: 'middle', fill: PAL.textDim, size: 12 }));
      return svg;
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
    svg.appendChild(polyline(points.join(' '), { stroke: PAL.cumLine, width: 2 }));

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
    const legY = MARGIN.top - 14;
    let legX = W - MARGIN.right - 160;
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.cumLine, width: 2 }));
    svg.appendChild(text(legX + 24, legY + 3, 'CUMULATIVE', { fill: PAL.text, size: 9, tracking: 1 }));
    legX += 100;
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.p1Line, width: 2, dash: '5 3' }));
    svg.appendChild(text(legX + 24, legY + 3, 'P1', { fill: PAL.text, size: 9, tracking: 1 }));
    legX += 50;
    svg.appendChild(line(legX, legY, legX + 18, legY, { stroke: PAL.p2Line, width: 2, dash: '5 3' }));
    svg.appendChild(text(legX + 24, legY + 3, 'P2', { fill: PAL.text, size: 9, tracking: 1 }));

    // ─── Pattern marker (LUMPY badge top-left) ────────────────────────────
    if (material.pattern === 'LUMPY') {
      const bx = MARGIN.left + 4, by = MARGIN.top - 14;
      svg.appendChild(rect(bx, by - 9, 56, 14, { fill: 'rgba(251,191,36,0.18)', stroke: PAL.annot, opacity: .9 }));
      svg.appendChild(text(bx + 4, by + 1, 'LUMPY', { fill: PAL.annot, size: 9, weight: 600, tracking: 1.5 }));
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
  function monthTicks(xMin, xMax, target){
    const months = (xMax - xMin) / (30.44 * 86400000);
    const step   = Math.max(1, Math.round(months / target));
    const out = [];
    const d = new Date(xMin); d.setDate(1); d.setHours(0,0,0,0);
    while (d.getTime() <= xMax) {
      if (d.getTime() >= xMin) out.push(d.getTime());
      d.setMonth(d.getMonth() + step);
    }
    return out;
  }
  function fmtMonth(t){
    const d = new Date(t);
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    return `${months[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  }
  function fmtNum(v){
    if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
    if (Math.abs(v) >= 10)   return Math.round(v).toString();
    return (Math.round(v * 10) / 10).toString();
  }

  /* ─── SVG → PNG conversion (for LLM image input) ────────────────────────── */
  function toPng(svgEl, scale){
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
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = (e) => reject(e);
        img.src = svg64;
      } catch (e) { reject(e); }
    });
  }

  global.AppChart = Object.freeze({ render, toPng, PAL });

})(window);
