/* ═══════════════════════════════════════════════════════════════════════════
   MRP-run cadence — shared static renderer (APP-SCR-REPORT-CADENCE, v2.2.0-dev)

   A faithful, self-contained port of the Trace page's MRP-run cadence view
   (trace.js renderMrpCadence) so the Screener Report Builder can drop the two
   graphs — the cadence bars (PR→PO vs Cancelled per period) and the replenishment
   chart (stock + incoming PO qty vs Min/Max) — into a report as static images.

   The interactive bits (toolbar, click tooltips, resize grip, dot-strip legend
   card) are deliberately left out; the four custom canvas plugins (stacked date
   axis, per-day stock dots, Min/Max lines, cancelled-PR dots) and the hatch are
   kept so the picture matches the on-screen chart. Charts render with
   animation:false + responsive:false into offscreen canvases, so the capture
   works even when the browser pane is not composited.

   Depends on: Chart.js (global Chart), TracePhase.computeChains,
   InventoryBackCalc.backCalcSOH (optional — degrades to no dots), AppLocale.

   API:  await MrpCadence.renderImages(json, material, mRec, opts)
         mRec = { soh, mrpInd, safetyStock, mrpMin, mrpMax }  (Current-SAP values)
         opts = { period:'day'|'week'|'month', width, cadenceH, replenH }
         → { empty, reason?, cadence, replen, meta:{chains,complete,inflight,
             cancelled,manualCt,emptySlots,period,repAny,repCancelAny} }
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const MF_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const COMP = '#2FBF88', CAN = '#EF4444';
  const STK_BLUE = '#2E6BE6', PO_GREEN = '#37D399', REP_SEP = '#0d1414';

  function mfPad(x){ return ('0' + x).slice(-2); }
  function isMrpChain(c){ return (String(c.creationIndicator || '').trim() || 'B') === 'B'; }
  function chainOutcome(c){
    if (c.state === 'CANCELLED') return 'cancelled';
    if (c.state === 'COMPLETE' || c.state === 'NOT_YET_CONSUMED') return 'complete';
    return 'inflight';
  }
  function mfSlotStart(dateStr, period){
    const s = String(dateStr || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (period === 'month') return Date.UTC(y, m - 1, 1);
    if (period === 'week'){ const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; return Date.UTC(y, m - 1, d) - dow * 864e5; }
    return Date.UTC(y, m - 1, d);
  }
  function mfNextSlot(ms, period){
    const dt = new Date(ms);
    if (period === 'month') return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1);
    if (period === 'week')  return ms + 7 * 864e5;
    return ms + 864e5;
  }
  function mfIso(ms){ const d = new Date(ms); return d.getUTCFullYear() + '-' + mfPad(d.getUTCMonth() + 1) + '-' + mfPad(d.getUTCDate()); }
  function isoMonthsAgo(iso, n){
    const s = String(iso || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    const dt = new Date(Date.UTC(y, m - 1 - n, d));
    return dt.getUTCFullYear() + '-' + mfPad(dt.getUTCMonth() + 1) + '-' + mfPad(dt.getUTCDate());
  }
  function stockDotColor(soh, info){
    if (soh == null) return null;
    if (soh <= 0.0001) return '#EF4444';
    if (info.isPD && !(info.ss > 0)) return '#2FBF88';
    if (info.thr == null || !(info.thr > 0)) return '#2FBF88';
    return soh >= info.thr ? '#2FBF88' : '#FBBF24';
  }
  function buildStockDotMap(json, mat, mRec, firstSlotMs){
    const out = { sohByDay: new Map(), ok:false, isPD:false, ss:null, min:null, max:null, thr:null, thrLabel:'', currentSOH:null };
    const soh0 = (typeof mRec.soh === 'number' && Number.isFinite(mRec.soh)) ? mRec.soh : null;
    out.currentSOH = soh0;
    out.isPD = String(mRec.mrpInd || '').toUpperCase() === 'PD';
    out.ss   = (typeof mRec.safetyStock === 'number') ? mRec.safetyStock : null;
    out.min  = (typeof mRec.mrpMin === 'number') ? mRec.mrpMin : null;
    out.max  = (typeof mRec.mrpMax === 'number') ? mRec.mrpMax : null;
    if (out.isPD){ if (out.ss && out.ss > 0){ out.thr = out.ss; out.thrLabel = 'SS'; } }
    else        { if (out.min && out.min > 0){ out.thr = out.min; out.thrLabel = 'Min'; } }
    if (soh0 == null || firstSlotMs == null || typeof InventoryBackCalc === 'undefined') return out;
    const endIso   = (typeof AppLocale !== 'undefined' && AppLocale.localDateISO) ? AppLocale.localDateISO() : mfIso(Date.now());
    const startIso = mfIso(firstSlotMs);
    const mb51Rows = ((json && json.data && json.data.mb51) || []).filter(r => String(r.material || '').trim() === String(mat));
    let res;
    try { res = InventoryBackCalc.backCalcSOH({ material: mat, currentSOH: soh0, mb51Rows, windowStart: startIso, windowEnd: endIso }); }
    catch (e){ return out; }
    if (!res || res.error || !res.series || !res.series.length) return out;
    for (const p of res.series) out.sohByDay.set(p.date, p.soh);
    out.ok = true;
    return out;
  }

  async function renderImages(json, material, mRec, opts){
    opts = opts || {};
    mRec = mRec || {};
    const period = opts.period || 'month';
    const W = opts.width || 900;
    if (typeof Chart === 'undefined') return { empty:true, reason:'Chart.js unavailable' };
    if (typeof TracePhase === 'undefined' || !TracePhase.computeChains) return { empty:true, reason:'TracePhase unavailable' };
    const chains = TracePhase.computeChains(json, material);
    if (!chains.length) return { empty:true, reason:'no requisition chains' };

    // aggregate by slot × outcome × source
    const agg = new Map();
    let undated = 0, complete = 0, inflight = 0, cancelled = 0, manualCt = 0;
    for (const c of chains){
      const oc = chainOutcome(c), mrp = isMrpChain(c);
      if (!mrp) manualCt++;
      const start = mfSlotStart(c.prDate, period);
      if (start == null){ undated++; continue; }
      let e = agg.get(start); if (!e){ e = { cMrp:0,cMan:0,iMrp:0,iMan:0,xMrp:0,xMan:0 }; agg.set(start, e); }
      e[(oc === 'complete' ? 'c' : oc === 'inflight' ? 'i' : 'x') + (mrp ? 'Mrp' : 'Man')]++;
      if (oc === 'complete') complete++; else if (oc === 'inflight') inflight++; else cancelled++;
    }
    if (!(complete + inflight + cancelled)) return { empty:true, reason:'no dated requisitions' };

    // continuous slots. If the caller passes an explicit span (opts.spanStart /
    // spanEnd) — e.g. the Trend consumption chart's date range, so the two line up
    // for assessing system behaviour — use exactly that; otherwise fall back to
    // "first PR .. today, ≥ 3 months".
    const used = [...agg.keys()].sort((a,b)=>a-b);
    const optS = opts.spanStart ? mfSlotStart(opts.spanStart, period) : null;
    const optE = opts.spanEnd   ? mfSlotStart(opts.spanEnd,   period) : null;
    let spanStart, spanEnd;
    if (optS != null && optE != null){
      spanStart = Math.min(optS, optE); spanEnd = Math.max(optS, optE);
    } else {
      const todayIso  = (typeof AppLocale !== 'undefined' && AppLocale.localDateISO) ? AppLocale.localDateISO() : mfIso(Date.now());
      const todaySlot = mfSlotStart(todayIso, period);
      const minStart  = mfSlotStart(isoMonthsAgo(todayIso, 3), period);
      spanStart = Math.min(used[0], minStart != null ? minStart : used[0]);
      spanEnd   = Math.max(used[used.length-1], todaySlot != null ? todaySlot : used[used.length-1]);
    }
    const slots = []; let cur = spanStart, guard = 0;
    while (cur <= spanEnd && guard++ < 8000){ slots.push(cur); cur = mfNextSlot(cur, period); }
    const emptySlots = slots.filter(ms => !agg.has(ms)).length;

    const dotInfo = buildStockDotMap(json, material, mRec, slots[0]);
    const slotIdx = new Map(); slots.forEach((ms,i)=>slotIdx.set(ms,i));
    const repStock = new Array(slots.length).fill(null);
    const repPoMrp = new Array(slots.length).fill(0), repPoMan = new Array(slots.length).fill(0), repPo = new Array(slots.length).fill(0);
    const repCancelStock = new Array(slots.length).fill(null);
    const repLatestDay = new Array(slots.length).fill(null), repCancelDay = new Array(slots.length).fill(null);
    let repAny = false, repCancelAny = false;
    for (const c of chains){
      const sm = mfSlotStart(c.prDate, period); if (sm == null || !slotIdx.has(sm)) continue;
      const i = slotIdx.get(sm); const day = String(c.prDate || '').slice(0,10);
      if (c.state === 'CANCELLED'){ if (!repCancelDay[i] || day > repCancelDay[i]) repCancelDay[i] = day; repCancelAny = true; continue; }
      if (!c.po) continue;
      const q = (typeof c.qty === 'number' && c.qty > 0) ? c.qty : 0;
      if (isMrpChain(c)) repPoMrp[i] += q; else repPoMan[i] += q;
      repPo[i] += q; repAny = true;
      if (!repLatestDay[i] || day > repLatestDay[i]) repLatestDay[i] = day;
    }
    if (dotInfo.ok){
      for (let i=0;i<slots.length;i++){
        if (repPo[i] > 0 && repLatestDay[i] && dotInfo.sohByDay.has(repLatestDay[i])) repStock[i] = Math.max(0, dotInfo.sohByDay.get(repLatestDay[i]));
        if (repCancelDay[i] && dotInfo.sohByDay.has(repCancelDay[i])) repCancelStock[i] = Math.max(0, dotInfo.sohByDay.get(repCancelDay[i]));
      }
    }
    const slotMonthKey = slots.map(ms => { const dt = new Date(ms); return dt.getUTCFullYear() + '-' + mfPad(dt.getUTCMonth()+1); });
    const labels = slots.map(ms => { const dt = new Date(ms); return period === 'month' ? MF_MONTHS[dt.getUTCMonth()] : mfPad(dt.getUTCDate()); });
    const gv = (ms,k) => (agg.get(ms)||{})[k] || 0;
    const dPoMrp = slots.map(ms => gv(ms,'cMrp') + gv(ms,'iMrp'));
    const dPoMan = slots.map(ms => gv(ms,'cMan') + gv(ms,'iMan'));
    const dPo    = slots.map((_,i)=> dPoMrp[i] + dPoMan[i]);
    const dCan   = slots.map(ms => gv(ms,'xMrp') + gv(ms,'xMan'));

    const Y_AX_W = 58, DAY_PAD_TOP = 14;

    // Dark background so the (dark-theme) chart text is readable on any report page,
    // matching how the Trend chart already sits on the page.
    const bgPlugin = { id:'bg', beforeDraw(chart){ const { ctx, width, height } = chart; ctx.save(); ctx.fillStyle = '#0c2d3b'; ctx.fillRect(0, 0, width, height); ctx.restore(); } };

    const makeDateAxis = (tickPad) => ({
      id: 'dateAxis' + tickPad,
      afterDatasetsDraw(chart){
        const { ctx, chartArea } = chart; const n = slots.length; if (!n) return;
        const w = (chartArea.right - chartArea.left) / n;
        const ctr = (idx) => chartArea.left + w * (idx + 0.5);
        const top = chartArea.top, bot = chartArea.bottom, isMonth = period === 'month';
        const spansBy = (key) => { const out = []; let s = 0; for (let i=1;i<=n;i++){ if (i!==n && key(i)===key(i-1)) continue; out.push([s,i-1]); s = i; } return out; };
        const yearOf = (i) => slotMonthKey[i].slice(0,4);
        const monthRowY = bot + tickPad + 24, yearRowY = bot + tickPad + (isMonth ? 22 : 40);
        ctx.save();
        if (!isMonth){
          const mspans = spansBy((i)=>slotMonthKey[i]);
          ctx.strokeStyle = 'rgba(155,171,168,.20)'; ctx.lineWidth = 1;
          for (let s=1;s<mspans.length;s++){ const bx = chartArea.left + w*mspans[s][0]; ctx.beginPath(); ctx.moveTo(bx, top); ctx.lineTo(bx, monthRowY+11); ctx.stroke(); }
          ctx.fillStyle = '#C7D6D2'; ctx.font = '600 9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          for (const [a,b] of mspans){ ctx.fillText(MF_MONTHS[new Date(slots[a]).getUTCMonth()], (ctr(a)+ctr(b))/2, monthRowY); }
        }
        const yspans = spansBy(yearOf);
        ctx.strokeStyle = 'rgba(155,171,168,.40)'; ctx.lineWidth = 1;
        for (let s=1;s<yspans.length;s++){ const bx = chartArea.left + w*yspans[s][0]; ctx.beginPath(); ctx.moveTo(bx, top); ctx.lineTo(bx, yearRowY+11); ctx.stroke(); }
        ctx.fillStyle = '#9BABA8'; ctx.font = '700 10px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const [a,b] of yspans){ ctx.fillText(yearOf(a), (ctr(a)+ctr(b))/2, yearRowY); }
        ctx.restore();
      }
    });
    const stockDots = { id:'stockDots', afterDatasetsDraw(chart){
      if (!dotInfo.ok) return; const { ctx, chartArea } = chart; const n = slots.length; if (!n) return;
      const w = (chartArea.right - chartArea.left) / n, yDot = chartArea.bottom + 9;
      const endMs = mfNextSlot(slots[n-1], period); ctx.save();
      let si = 0, guard = 0;
      for (let t = slots[0]; t <= endMs && guard < 20000; t += 864e5, guard++){
        while (si+1 < n && slots[si+1] <= t) si++;
        const s0 = slots[si], s1 = (si+1 < n) ? slots[si+1] : mfNextSlot(slots[si], period);
        const f = s1 > s0 ? Math.max(0, Math.min(1,(t-s0)/(s1-s0))) : 0;
        const x = chartArea.left + w*(si+f), iso = mfIso(t);
        const soh = dotInfo.sohByDay.has(iso) ? dotInfo.sohByDay.get(iso) : null;
        const col = stockDotColor(soh, dotInfo); if (!col) continue;
        ctx.beginPath(); ctx.fillStyle = col; ctx.arc(x, yDot, 1.7, 0, Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }};
    const minmaxLines = { id:'minmaxLines', afterDatasetsDraw(chart){
      const { ctx, chartArea, scales } = chart; const y = scales.y; if (!y) return;
      const drawLine = (val, color, label) => {
        if (val == null || !Number.isFinite(val) || val <= 0) return;
        const yp = y.getPixelForValue(val); if (yp < chartArea.top-1 || yp > chartArea.bottom+1) return;
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(chartArea.left, yp); ctx.lineTo(chartArea.right, yp); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = color; ctx.font = '600 10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(label + ' ' + Math.round(val).toLocaleString(), chartArea.left + 4, yp - 2); ctx.restore();
      };
      drawLine(dotInfo.max, '#2FBF88', 'Max'); drawLine(dotInfo.min, '#EF4444', 'Min');
    }};
    const cancelDots = { id:'cancelDots', afterDatasetsDraw(chart){
      if (!dotInfo.ok) return; const { ctx, chartArea, scales } = chart; const y = scales.y; if (!y) return;
      const n = slots.length, w = (chartArea.right - chartArea.left)/n, off = Math.min(6, w*0.30); ctx.save();
      for (let i=0;i<n;i++){ const sv = repCancelStock[i]; if (sv == null) continue;
        const x = chartArea.left + w*(i+0.5)+off, yp = y.getPixelForValue(sv);
        if (yp < chartArea.top-2 || yp > chartArea.bottom+2) continue;
        ctx.beginPath(); ctx.fillStyle = '#EF4444'; ctx.arc(x, yp, 3, 0, Math.PI*2); ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(13,20,20,.85)'; ctx.stroke(); }
      ctx.restore();
    }};
    const makeHatch = (base) => {
      const p = document.createElement('canvas'); p.width = 7; p.height = 7; const pc = p.getContext('2d');
      pc.fillStyle = base; pc.fillRect(0,0,7,7); pc.strokeStyle = 'rgba(11,18,18,.55)'; pc.lineWidth = 1.6;
      pc.beginPath(); pc.moveTo(0,7); pc.lineTo(7,0); pc.stroke();
      pc.beginPath(); pc.moveTo(-2,2); pc.lineTo(2,-2); pc.stroke();
      pc.beginPath(); pc.moveTo(5,9); pc.lineTo(9,5); pc.stroke();
      return pc.createPattern(p, 'repeat');
    };

    // ── cadence chart ────────────────────────────────────────────────────────
    const c1 = document.createElement('canvas'); c1.width = W; c1.height = opts.cadenceH || 300;
    c1.style.width = W + 'px'; c1.style.height = (opts.cadenceH || 300) + 'px';
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0'; host.appendChild(c1);
    const chart1 = new Chart(c1, {
      type:'bar',
      data:{ labels, datasets:[ { label:'PR → PO', data:dPo, backgroundColor:COMP, stack:'s' }, { label:'Cancelled', data:dCan, backgroundColor:CAN, stack:'s' } ] },
      options:{ responsive:false, animation:false, maintainAspectRatio:false, events:[],
        layout:{ padding:{ right:26, bottom: period==='month'?48:70 } },
        scales:{ x:{ stacked:true, grid:{display:false}, ticks:{ color:'#9BABA8', maxRotation:0, autoSkip:true, maxTicksLimit:20, padding:DAY_PAD_TOP, font:{family:'JetBrains Mono',size:9} } },
                 y:{ stacked:true, beginAtZero:true, afterFit:(s)=>{s.width=Y_AX_W;}, ticks:{ color:'#9BABA8', precision:0, font:{family:'JetBrains Mono',size:10} }, grid:{ color:'rgba(31,206,216,.06)' } } },
        plugins:{ legend:{ labels:{ color:'#DBE9F0', font:{family:'JetBrains Mono',size:11}, boxWidth:12 } }, tooltip:{ enabled:false } } },
      plugins:[ bgPlugin, makeDateAxis(DAY_PAD_TOP), stockDots ]
    });

    // ── replenishment chart ──────────────────────────────────────────────────
    const repStockD = repStock.slice();
    const repPoMrpD = repPoMrp.map(v => (v>0?v:null));
    const repPoManD = repPoMan.map(v => (v>0?v:null));
    let repMaxVal = 0;
    for (let i=0;i<slots.length;i++){ const s = repStock[i]||0, p = repPo[i]||0; if (s+p > repMaxVal) repMaxVal = s+p; if (repCancelStock[i] != null && repCancelStock[i] > repMaxVal) repMaxVal = repCancelStock[i]; }
    if (dotInfo.max != null && dotInfo.max > repMaxVal) repMaxVal = dotInfo.max;
    const repSuggMax = repMaxVal > 0 ? repMaxVal*1.1 : 10;
    const PO_HATCH = makeHatch(PO_GREEN);
    const c2 = document.createElement('canvas'); c2.width = W; c2.height = opts.replenH || 230;
    c2.style.width = W + 'px'; c2.style.height = (opts.replenH || 230) + 'px'; host.appendChild(c2);
    const chart2 = new Chart(c2, {
      type:'bar',
      data:{ labels, datasets:[
        { label:'Stock on hand', data:repStockD, backgroundColor:STK_BLUE, borderColor:REP_SEP, borderWidth:{top:1.5,right:0,bottom:0,left:0}, stack:'r' },
        { label:'PO qty (MRP)',  data:repPoMrpD, backgroundColor:PO_GREEN, borderColor:REP_SEP, borderWidth:{top:1.5,right:0,bottom:0,left:0}, borderSkipped:false, stack:'r' },
        { label:'PO qty (manual)', data:repPoManD, backgroundColor:PO_HATCH, borderColor:REP_SEP, borderWidth:{top:1.5,right:0,bottom:0,left:0}, borderSkipped:false, stack:'r' }
      ] },
      options:{ responsive:false, animation:false, maintainAspectRatio:false, events:[],
        layout:{ padding:{ right:26, bottom: period==='month'?42:62 } },
        scales:{ x:{ stacked:true, grid:{display:false}, ticks:{ color:'#9BABA8', maxRotation:0, autoSkip:true, maxTicksLimit:20, padding:8, font:{family:'JetBrains Mono',size:9} } },
                 y:{ stacked:true, beginAtZero:true, suggestedMax:repSuggMax, afterFit:(s)=>{s.width=Y_AX_W;}, ticks:{ color:'#9BABA8', font:{family:'JetBrains Mono',size:10} }, grid:{ color:'rgba(31,206,216,.06)' } } },
        plugins:{ legend:{ labels:{ color:'#DBE9F0', font:{family:'JetBrains Mono',size:11}, boxWidth:12 } }, tooltip:{ enabled:false } } },
      plugins:[ bgPlugin, makeDateAxis(8), minmaxLines, cancelDots ]
    });

    document.body.appendChild(host);
    await new Promise(r => setTimeout(r, 30));   // let the synchronous draw settle
    let cadence = null, replen = null;
    try { chart1.draw(); cadence = c1.toDataURL('image/png'); } catch(e){}
    try { chart2.draw(); replen  = c2.toDataURL('image/png'); } catch(e){}
    try { chart1.destroy(); } catch(e){}
    try { chart2.destroy(); } catch(e){}
    if (host.parentNode) host.parentNode.removeChild(host);

    return {
      empty:false, cadence, replen,
      cadenceAR: (opts.cadenceH||300)/W, replenAR: (opts.replenH||230)/W,
      meta:{ chains:chains.length, complete, inflight, cancelled, manualCt, emptySlots, undated, period, repAny, repCancelAny, hasDots:dotInfo.ok }
    };
  }

  global.MrpCadence = { renderImages };

})(window);
