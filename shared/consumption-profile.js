/* ═══════════════════════════════════════════════════════════════════════════
   shared/consumption-profile.js · Sandbox (2026-06-27)
   ───────────────────────────────────────────────────────────────────────────
   Consumption-distribution helpers for the classifier Sandbox — kept in a
   shared module so a winning hypothesis can be promoted to the live pages
   without a rewrite.

     · eventQtys(json, material)  → units issued per consumptive EVENT
         (event = a work order's 261 / a cost-centre 201-by-day — same unit the
          pipeline's event-count + "Per event cons" stat use).
     · woQtys(json, material)     → units per WORK ORDER (Calc A's basis).
     · describe(qtys)             → {n, mean, median, std, min, max, skew, cv}
         skew = mean ÷ median (>1 ⇒ a few big draws pull the mean above the
         median = the "lumpy / hard-to-MRP" signal).
     · calcANumbers(woQtys)       → the numbers behind the CURRENT classifier
         (top-1 share, CV, WO count). Verdict itself = pipeline mat.pattern.
     · calcB(stats, {skewThreshold, minEvents}) → proposed mean-vs-median rule.
     · renderHistogram(qtys, opts)→ SVG of the per-event quantity distribution
         with mean (amber) + median (green dashed) markers.
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const ISSUE = new Set(['261', '201']);
  function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }

  function eventQtys(json, material){
    const mb51 = (json && json.data && json.data.mb51) || [];
    const mat  = String(material).trim();
    const ev = new Map();
    for (const r of mb51){
      if (String(r.material || '').trim() !== mat) continue;
      const mt = String(r.movementType || '').trim();
      if (!ISSUE.has(mt)) continue;
      const q = Math.abs(num(r.quantity));
      const o = String(r.order || '').trim();
      const key = o ? ('WO|' + o) : ('CC|' + String(r.postingDate || '').trim());
      ev.set(key, (ev.get(key) || 0) + q);
    }
    return [...ev.values()];
  }

  function woQtys(json, material){
    const mb51 = (json && json.data && json.data.mb51) || [];
    const mat  = String(material).trim();
    const byOrder = new Map();
    let i = 0;
    for (const r of mb51){
      if (String(r.material || '').trim() !== mat) continue;
      const mt = String(r.movementType || '').trim();
      if (!ISSUE.has(mt)) continue;
      const q = Math.abs(num(r.quantity));
      const o = String(r.order || '').trim() || ('__row_' + (i++));
      byOrder.set(o, (byOrder.get(o) || 0) + q);
    }
    return [...byOrder.values()];
  }

  function median(sorted){
    const n = sorted.length; if (!n) return 0;
    const m = Math.floor(n / 2);
    return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  function describe(qtys){
    const n = qtys.length;
    if (!n) return { n: 0, sum: 0, mean: 0, median: 0, std: 0, min: 0, max: 0, skew: null, cv: null };
    const sorted = [...qtys].sort((a, b) => a - b);
    const sum  = qtys.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const med  = median(sorted);
    const variance = n > 1 ? qtys.reduce((a, q) => a + (q - mean) * (q - mean), 0) / (n - 1) : 0;
    const std  = Math.sqrt(variance);
    return {
      n, sum, mean, median: med, std,
      min: sorted[0], max: sorted[n - 1],
      skew: med > 0 ? mean / med : null,
      cv:   mean > 0 ? std / mean : null
    };
  }

  function calcANumbers(wq){
    const n = wq.length;
    if (!n) return { woCount: 0, total: 0, top1: null, cv: null };
    const total = wq.reduce((a, b) => a + b, 0);
    const max   = Math.max(...wq);
    const mean  = total / n;
    const variance = wq.reduce((a, q) => a + (q - mean) * (q - mean), 0) / n;   // population — matches classifyPattern
    return { woCount: n, total, top1: total > 0 ? max / total : null, cv: mean > 0 ? Math.sqrt(variance) / mean : null };
  }

  function calcB(stats, opts){
    opts = opts || {};
    const skewT = (typeof opts.skewThreshold === 'number') ? opts.skewThreshold : 1.6;
    const minEv = (typeof opts.minEvents === 'number') ? opts.minEvents : 3;
    if (!stats || stats.n === 0) return { lumpy: false, verdict: 'SMOOTH', reasons: ['no events'] };
    const bySkew = stats.skew != null && stats.skew >= skewT;
    const byFew  = stats.n <= minEv;
    const reasons = [];
    if (bySkew) reasons.push(`skew ${stats.skew.toFixed(2)} ≥ ${skewT}`);
    if (byFew)  reasons.push(`${stats.n} event${stats.n === 1 ? '' : 's'} ≤ ${minEv}`);
    const lumpy = bySkew || byFew;
    if (!lumpy) reasons.push(`skew ${stats.skew == null ? 'n/a' : stats.skew.toFixed(2)} < ${skewT} · ${stats.n} events > ${minEv}`);
    return { lumpy, verdict: lumpy ? 'LUMPY' : 'SMOOTH', reasons };
  }

  function renderHistogram(qtys, opts){
    opts = opts || {};
    // APP-FIX-HISTO-LEGIBLE — bigger canvas + readable fonts. The panel is wide,
    // so a wide viewBox fills it and the (viewBox-unit) font sizes render near 1:1.
    const W = opts.width || 1040, H = opts.height || 320;
    const M = { top: 34, right: 24, bottom: 62, left: 76 };
    const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
    const FS = { bar: 16, axis: 16, name: 15, marker: 19 };   // font sizes
    const head = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" style="display:block">`;
    if (!qtys.length) {
      return `${head}<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9BABA8" font-family="monospace" font-size="20">no consumption events</text></svg>`;
    }
    const st  = describe(qtys);
    // APP-FIX-HISTO-BUCKETS — nice round buckets (5–20 of them) instead of
    // ceil(sqrt(n)), which collapsed to a single bucket on few/clustered events.
    // Edges snap to 1/2/5×10^k, bars get gaps, and each edge is labelled.
    const dataMin = st.min, dataMax = st.max;
    function niceStep(x){
      if (!(x > 0)) return 1;
      const exp = Math.floor(Math.log10(x)), base = Math.pow(10, exp), f = x / base;
      const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
      return nf * base;
    }
    const MINB = 5, MAXB = 20, TARGET = 10;
    let width = Math.max(1, niceStep((dataMax - dataMin) / TARGET || 1));   // ~TARGET buckets over the data range; integer-floored
    // start at 0 when the min sits inside the first bucket of zero; else snap a nice floor below the min (zoom to a tight cluster)
    const loFor = w => (dataMin >= 0 && dataMin < w) ? 0 : Math.floor(dataMin / w) * w;
    let lo = loFor(width);
    let bins = Math.max(1, Math.ceil((dataMax - lo + 1e-9) / width));
    while (bins > MAXB) { width = niceStep(width * 1.5); lo = loFor(width); bins = Math.max(1, Math.ceil((dataMax - lo + 1e-9) / width)); }
    bins = Math.max(MINB, bins);                 // never fewer than 5 buckets
    const hi = lo + bins * width;
    const counts = new Array(bins).fill(0);
    for (const q of qtys){ let bi = Math.floor((q - lo) / width); if (bi >= bins) bi = bins - 1; if (bi < 0) bi = 0; counts[bi]++; }
    const cmax = Math.max(...counts, 1);
    const col  = opts.color || '#5DD9E2';
    const xAt  = v => M.left + ((v - lo) / (hi - lo)) * iw;       // value → px
    const clampX = v => Math.max(M.left, Math.min(M.left + iw, xAt(v)));
    const fmtEdge = v => (Math.round(v * 100) / 100).toLocaleString();
    const GAP = 0.16;                                            // gap each side of a bar (operator: "spaces in between")
    let bars = '';
    for (let i = 0; i < bins; i++){
      const x0 = xAt(lo + i * width), x1 = xAt(lo + (i + 1) * width);
      const bw = x1 - x0, pad = bw * GAP;
      const h = (counts[i] / cmax) * ih, y = M.top + ih - h;
      bars += `<rect x="${(x0 + pad).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 2 * pad).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${col}" fill-opacity="0.62" stroke="${col}" stroke-opacity="0.95"/>`;
      if (counts[i] > 0) bars += `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle" fill="#D6DFDE" font-family="monospace" font-size="${FS.bar}">${counts[i]}</text>`;
    }
    const axisY = M.top + ih;
    const axis = `<line x1="${M.left}" y1="${axisY}" x2="${M.left + iw}" y2="${axisY}" stroke="#9BABA8" stroke-width="1.4"/>`;
    const everyN = Math.ceil((bins + 1) / 11);                   // ≤ ~11 edge labels so they don't collide
    let edges = '';
    for (let i = 0; i <= bins; i++){
      if (i % everyN !== 0 && i !== bins) continue;
      const xe = xAt(lo + i * width);
      edges += `<line x1="${xe.toFixed(1)}" y1="${axisY}" x2="${xe.toFixed(1)}" y2="${(axisY + 5).toFixed(1)}" stroke="#9BABA8" stroke-width="1"/>`
             + `<text x="${xe.toFixed(1)}" y="${(axisY + 22).toFixed(1)}" text-anchor="middle" fill="#9BABA8" font-family="monospace" font-size="${FS.axis}">${fmtEdge(lo + i * width)}</text>`;
    }
    const xtitle = `<text x="${M.left + iw / 2}" y="${H - 6}" text-anchor="middle" fill="#9BABA8" font-family="monospace" font-size="${FS.axis}" letter-spacing="1.5">UNITS PER EVENT (bucket ${fmtEdge(width)})</text>`;
    const ylab = `<text x="10" y="${M.top + 12}" fill="#9BABA8" font-family="monospace" font-size="${FS.axis}">${cmax}</text>`
               + `<text transform="rotate(-90 18 ${M.top + ih / 2})" x="18" y="${M.top + ih / 2}" text-anchor="middle" fill="#9BABA8" font-family="monospace" font-size="${FS.axis}" letter-spacing="1.5">EVENTS</text>`;
    const meanLine = `<line x1="${clampX(st.mean).toFixed(1)}" y1="${M.top}" x2="${clampX(st.mean).toFixed(1)}" y2="${axisY}" stroke="#FBBF24" stroke-width="2.4"/>`
                   + `<text x="${(clampX(st.mean) + 5).toFixed(1)}" y="${M.top + 16}" fill="#FBBF24" font-family="monospace" font-size="${FS.marker}">mean ${Math.round(st.mean * 10) / 10}</text>`;
    const medLine  = `<line x1="${clampX(st.median).toFixed(1)}" y1="${M.top}" x2="${clampX(st.median).toFixed(1)}" y2="${axisY}" stroke="#7CDDB2" stroke-width="2.4" stroke-dasharray="4 3"/>`
                   + `<text x="${(clampX(st.median) + 5).toFixed(1)}" y="${M.top + 38}" fill="#7CDDB2" font-family="monospace" font-size="${FS.marker}">med ${Math.round(st.median * 10) / 10}</text>`;
    return `${head}${axis}${edges}${bars}${meanLine}${medLine}${xtitle}${ylab}</svg>`;
  }

  global.ConsumptionProfile = { eventQtys, woQtys, describe, calcANumbers, calcB, renderHistogram };
})(window);
