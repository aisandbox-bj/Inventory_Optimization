/* ═══════════════════════════════════════════════════════════════════════════
   Report Builder (APP-SCR-REPORT, v2.2.0-dev) — customisable per-material
   Screener report.

   The operator picks a page size (US Letter portrait, or Widescreen 16:9 for
   1080p / 4K monitors), then picks + reorders which blocks appear, sets a couple
   of per-block options, adds a comment, and exports a PDF. Blocks reuse the
   existing analytical renderers (AppChart, TracePhase) — this module is
   presentation + composition only; it computes no new numbers.

   Blocks
     trend      1. Trend — consumption chart + key metrics + MRP compare
     avgDur     2. Trace — average supply duration (chevron) + optional box&whisker
     yoy        3. Trace — annual progression (year-over-year supply duration)
     rawpr      4. Trace — last X PRs (raw data table)
     chains     5. Trace — last X procurement chains
     cadence    6. Trace — MRP run cadence (both graphs)  [Increment 2 — disabled]
     comment    7. Comment — free text included in the report

   Depends on (all already loaded on the Screener page): jsPDF + autoTable (lazy),
   AppChart, TracePhase, AppLocale (optional).

   Public API:  ReportBuilder.open(ctx)
   ctx = { json, m, bucket, hasPr, analyst, traceFilters, assessmentName }
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* ─── small utils ───────────────────────────────────────────────────────── */
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function hexRgb(h){ h = String(h).replace('#',''); return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
  const TL_RGB = { GREEN:[0,176,80], BLUE:[52,152,219], ORANGE:[255,140,0], RED:[192,0,0], PURPLE:[155,89,182], GREY:[150,150,150] };

  // Birchwood palette (report chrome) — dark navy surfaces + cyan accent.
  const BW = {
    navy:   [12, 45, 59],    // deep-navy header fill
    midnight:[8, 30, 43],
    cyan:   [31, 206, 216],  // primary accent
    ink:    [24, 34, 44],
    grey:   [120, 130, 138],
    white:  [240, 244, 243]
  };

  // jsPDF core fonts are Latin-1 only — map the few Unicode glyphs our copy uses.
  function pdfSafe(s){
    return String(s == null ? '' : s)
      .replace(/→/g,'->').replace(/←/g,'<-').replace(/↑/g,'^').replace(/↓/g,'v')
      .replace(/★/g,'*').replace(/⚑/g,'>').replace(/≤/g,'<=').replace(/≥/g,'>=')
      .replace(/σ/g,'sd').replace(/≈/g,'~').replace(/·/g,'-').replace(/✓/g,'OK').replace(/[✗✕]/g,'x')
      .replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/–/g,'-').replace(/—/g,'-');
  }

  let _libsReady = false;
  function loadScript(src){
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureLibs(){
    if (_libsReady) return;
    if (!(global.jspdf && global.jspdf.jsPDF)) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
    _libsReady = true;
  }
  let _h2cReady = false;
  async function ensureH2C(){
    if (_h2cReady || global.html2canvas) { _h2cReady = true; return; }
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    _h2cReady = true;
  }

  // SVG → JPEG dataURL (dark bg fill, small files). Reads viewBox for size.
  function svgToJpeg(svgEl, scale, quality){
    scale = scale || 1.8; quality = quality || 0.72;
    return new Promise((resolve, reject) => {
      try {
        const vb = svgEl.getAttribute('viewBox').split(/\s+/);
        const w = parseFloat(vb[2]), h = parseFloat(vb[3]);
        const xml = new XMLSerializer().serializeToString(svgEl);
        const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = w * scale; c.height = h * scale;
          const cx = c.getContext('2d');
          cx.fillStyle = '#0C2D3B'; cx.fillRect(0, 0, c.width, c.height);
          cx.drawImage(img, 0, 0, c.width, c.height);
          resolve({ data: c.toDataURL('image/jpeg', quality), ar: h / w });
        };
        img.onerror = reject;
        img.src = svg64;
      } catch (e) { reject(e); }
    });
  }

  /* ─── block catalogue ───────────────────────────────────────────────────── */
  const BLOCKS = [
    { id:'trend',   label:'Trend — graph + key metrics',            needs:null, on:true  },
    { id:'avgDur',  label:'Trace — average supply duration',        needs:'pr', on:true,  opt:'box' },
    { id:'yoy',     label:'Trace — annual progression (YoY)',       needs:'pr', on:false },
    { id:'rawpr',   label:'Trace — last X PRs (raw data)',          needs:'pr', on:false, opt:'lastN', lastN:8 },
    { id:'chains',  label:'Trace — last X procurement chains',      needs:'pr', on:false, opt:'lastN', lastN:5 },
    { id:'cadence', label:'Trace — MRP run cadence (both graphs)',  needs:'pr', on:false, soon:true },
    { id:'comment', label:'Comment',                                needs:null, on:false, opt:'comment' }
  ];

  /* ─── page geometry ─────────────────────────────────────────────────────── */
  function geomFor(pageSize){
    if (pageSize === 'wide'){
      // 16:9 landscape, PowerPoint "widescreen" size in mm (13.33 x 7.5in).
      return { W:338.7, H:190.5, M:12, orientation:'landscape', format:[338.7,190.5], wide:true };
    }
    return { W:216, H:279, M:12, orientation:'portrait', format:'letter', wide:false };
  }

  /* ─── header (branded) ──────────────────────────────────────────────────── */
  function drawHeader(doc, g, ctx, continuation){
    const W = g.W, M = g.M;
    const bandH = continuation ? 12 : 20;
    doc.setFillColor(BW.navy[0], BW.navy[1], BW.navy[2]);
    doc.rect(0, 0, W, bandH, 'F');
    // cyan accent rule
    doc.setDrawColor(BW.cyan[0], BW.cyan[1], BW.cyan[2]); doc.setLineWidth(0.7);
    doc.line(0, bandH, W, bandH);
    const m = ctx.m;
    // eyebrow
    doc.setTextColor(BW.cyan[0], BW.cyan[1], BW.cyan[2]);
    doc.setFont('helvetica','bold'); doc.setFontSize(6.5);
    doc.text(pdfSafe('CALIBRE  ·  SCREENER REPORT'), M, continuation ? 4.6 : 6);
    // material no + description
    doc.setTextColor(255,255,255);
    doc.setFont('helvetica','bold'); doc.setFontSize(continuation ? 10 : 14);
    doc.text(String(m.material), M, continuation ? 9.5 : 13.5);
    if (!continuation){
      doc.setFont('helvetica','normal'); doc.setFontSize(9);
      const desc = doc.splitTextToSize(pdfSafe(m.description || ''), W - 2*M - 42)[0] || '';
      doc.text(desc, M, 18.4);
    }
    // TL pill, top-right
    const tl = m.trafficLight, c = TL_RGB[tl] || [127,127,127];
    const pw = 28, px = W - M - pw, py = continuation ? 3.4 : 5;
    doc.setFillColor(c[0], c[1], c[2]); doc.rect(px, py, pw, continuation ? 5.5 : 7, 'F');
    doc.setTextColor(tl === 'GREY' ? 20 : 255, tl === 'GREY' ? 20 : 255, tl === 'GREY' ? 20 : 255);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    doc.text(String(tl || ''), px + pw/2, py + (continuation ? 3.9 : 4.9), { align:'center' });
    // assessment name, small, right under pill on page 1
    if (!continuation){
      doc.setTextColor(200, 214, 220); doc.setFont('helvetica','normal'); doc.setFontSize(7);
      doc.text(pdfSafe((ctx.assessmentName || '').slice(0, 60)), W - M, 18.4, { align:'right' });
    }
    return bandH + 6;
  }

  /* ─── pager ─────────────────────────────────────────────────────────────── */
  function makePager(doc, g, ctx){
    const P = { doc, g, ctx, y: 0, firstBlock: true };
    P.top = drawHeader(doc, g, ctx, false);
    P.y = P.top;
    P.ensure = (need) => {
      if (P.y + need > g.H - g.M){
        doc.addPage(g.format, g.orientation);
        P.y = drawHeader(doc, g, ctx, true);
      }
    };
    // Section heading. `keep` = mm to hold together with the heading so a title
    // never orphans at the foot of a page (professional, no sub-standard splits).
    P.sectionLabel = (txt, keep) => {
      keep = keep || 34;
      // keep the heading with a chunk of its content
      if (P.y + keep > g.H - g.M){ doc.addPage(g.format, g.orientation); P.y = drawHeader(doc, g, ctx, true); P.firstBlock = false; }
      // discreet partial-width separator between blocks (not before the first)
      if (!P.firstBlock){
        P.y += 3.5;
        doc.setDrawColor(206, 214, 219); doc.setLineWidth(0.25);
        doc.line(g.M, P.y, g.M + (g.W - 2*g.M) * 0.26, P.y);
        P.y += 5.5;
      }
      P.firstBlock = false;
      doc.setTextColor(BW.navy[0], BW.navy[1], BW.navy[2]);
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
      doc.text(pdfSafe(txt), g.M, P.y); P.y += 2;
      doc.setDrawColor(BW.cyan[0], BW.cyan[1], BW.cyan[2]); doc.setLineWidth(0.4);
      doc.line(g.M, P.y, g.W - g.M, P.y); P.y += 4.5;
    };
    return P;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BLOCK RENDERERS  —  each: async (P, host, opts, fit) => void  (advances P.y)
     fit = { imgScale } for force-fit
  ═════════════════════════════════════════════════════════════════════════ */

  async function blockTrend(P, host, opts, fit){
    const { doc, g, ctx } = P; const m = ctx.m; const M = g.M; const CW = g.W - 2*M;
    P.sectionLabel('Consumption trend');
    // recommendation / analyst line
    const anRec = ctx.analyst ? ctx.analyst.getRec(m.material) : {};
    const anHas = !!(anRec && (anRec.mrpType || anRec.min || anRec.max || anRec.safety));
    const flagged = !!(ctx.analyst && ctx.analyst.isAction(m.material));
    const line = (flagged ? '* For Action  -  ' : '') + (anHas
      ? `Analyst: MRP ${anRec.mrpType||'-'} - Min ${anRec.min||'-'} - Max ${anRec.max||'-'} - SS ${anRec.safety||'-'}`
      : ('Recommendation: ' + (m.action || '-')));
    doc.setTextColor(70,70,80); doc.setFont('helvetica','italic'); doc.setFontSize(8.5);
    doc.splitTextToSize(pdfSafe(line), CW).slice(0,2).forEach(l => { P.ensure(5); doc.text(l, M, P.y); P.y += 4; });
    doc.setFont('helvetica','normal'); P.y += 1;
    // chart
    try {
      host.innerHTML = '<div id="rbCh"></div>';
      const svg = AppChart.render(host.querySelector('#rbCh'), m, { width: 936, height: 300 });
      const jpg = await svgToJpeg(svg, 1.8, 0.66);
      let chH = CW * (300/936);
      if (fit && fit.imgScale) chH *= fit.imgScale;
      P.ensure(chH + 2);
      doc.addImage(jpg.data, 'JPEG', M, P.y, CW, chH); P.y += chH + 4;
    } catch (e) {
      doc.setTextColor(192,0,0); doc.setFontSize(8.5); doc.text('Chart render error: ' + (e.message||e), M, P.y); P.y += 5;
    }
    // metrics table (2 pairs per row)
    const cad = (typeof AppLocale !== 'undefined' && AppLocale.fmtCAD) ? AppLocale.fmtCAD(m.totValueOh) : String(m.totValueOh ?? '-');
    const rc  = m.rateChange != null ? m.rateChange + '%' : 'N/A';
    const rows = [
      ['Stock on hand', m.stock ?? '-', 'Stock value', cad],
      ['P1 rate', m.p1Flag==='OK' ? m.p1Rate.toFixed(2)+' /mo' : '-', 'P2 rate', m.p2Flag==='OK' ? m.p2Rate.toFixed(2)+' /mo' : '-'],
      ['Runway @ P2', m.runway!=null ? m.runway+' mo' : '-', 'P1 -> P2 change', rc],
      ['Total (window)', String(m.totalNet ?? '-'), 'Last consumption', m.lastConsumptionDate || '-'],
      ['Pattern', m.pattern || '-', 'Traffic light', m.trafficLight || '-']
    ];
    P.ensure((rows.length + 1) * 5.2 + 4);
    doc.autoTable({
      startY: P.y, body: rows.map(r => r.map(pdfSafe)), theme:'grid', pageBreak:'avoid', rowPageBreak:'avoid',
      styles:{ fontSize:8, cellPadding:1.4, lineColor:[210,214,220], lineWidth:0.1 },
      columnStyles:{ 0:{fontStyle:'bold',fillColor:[238,243,244]}, 2:{fontStyle:'bold',fillColor:[238,243,244]} },
      tableWidth: CW, margin:{ left:M, right:M }
    });
    P.y = doc.lastAutoTable.finalY + 3;
    // MRP compare
    const anR = anRec || {};
    const mrp = [
      ['MRP type', m.mrpType||'-', m.recMrpType||'-', anR.mrpType||'-'],
      ['Min', m.cmin!=null?String(m.cmin):'-', m.recMin!=null?String(m.recMin):'-', anR.min||'-'],
      ['Max', m.cmax!=null?String(m.cmax):'-', m.recMax!=null?String(m.recMax):'-', anR.max||'-'],
      ['Safety stock', m.safetyStock!=null?String(m.safetyStock):'-', '-', anR.safety||'-']
    ];
    P.ensure((mrp.length + 1) * 5.2 + 6);
    doc.autoTable({
      startY: P.y, head:[['MRP setting','Current','Recommended','Analyst']], body: mrp.map(r=>r.map(pdfSafe)), theme:'grid', pageBreak:'avoid', rowPageBreak:'avoid',
      styles:{ fontSize:8, cellPadding:1.4, lineColor:[210,214,220], lineWidth:0.1 },
      headStyles:{ fillColor:[12,45,59], textColor:255, fontStyle:'bold', fontSize:8, halign:'center' },
      columnStyles:{ 0:{fontStyle:'bold',fillColor:[238,243,244]}, 1:{halign:'center'}, 2:{halign:'center',textColor:[22,138,145]}, 3:{halign:'center',textColor:[176,122,22],fontStyle:'bold'} },
      tableWidth: CW, margin:{ left:M, right:M },
      didParseCell:(d)=>{ if (d.row.section==='body' && d.column.index>=1 && d.row.index<3){ const cur=mrp[d.row.index][1], rec=mrp[d.row.index][2]; if (cur!=='-' && rec!=='-' && cur!==rec) d.cell.styles.fillColor=[255,243,205]; } }
    });
    P.y = doc.lastAutoTable.finalY + 5;
  }

  // shared: compute the drawn/complete chain set for this material (post-suppression)
  function drawnChains(ctx){
    if (typeof TracePhase === 'undefined') return { chains:[], drawn:[] };
    const chains = TracePhase.computeChains(ctx.json, ctx.m.material);
    const act = TracePhase.activeChains(chains, ctx.traceFilters || {});
    const drawn = act.filter(c => !!c.siteWH);
    return { chains, act, drawn };
  }

  async function blockAvgDur(P, host, opts, fit){
    const { doc, g, ctx } = P; const M = g.M; const CW = g.W - 2*M;
    P.sectionLabel('Average supply duration');
    if (!ctx.hasPr){ noPrNote(P, 'the average supply duration'); return; }
    const { drawn } = drawnChains(ctx);
    if (drawn.length < 2){ thinNote(P, `Only ${drawn.length} complete chain(s) reached Site WH — need at least 2.`); return; }
    const PK = TracePhase.PHASE_KEYS, PL = TracePhase.PHASE_LABELS, COLORS = TracePhase.PHASE_COLORS;
    const pstats = PK.map(ph => ({ key:ph, label:PL[ph], s:TracePhase.boxStats(drawn.map(c => c[ph])) }));
    const flowMean = TracePhase.totalToSiteMean(drawn);
    const ePh = pstats.find(x => x.key==='E'); const eMean = (ePh && ePh.s) ? ePh.s.mean : 0;
    // chevron (A–D proportional) + total-to-site readout
    const flowPhases = pstats.filter(x => x.key !== 'E');
    P.ensure(24);
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(95,95,105);
    doc.text(pdfSafe(`Total lead time to site availability - phase decomposition - avg across ${drawn.length} chains`), M, P.y); P.y += 2.6;
    const barW = CW * 0.70, barH = 13; let cx = M;
    flowPhases.forEach((p, i) => {
      const frac = flowMean > 0 ? (p.s ? p.s.mean : 0)/flowMean : 0;
      const segW = Math.max(barW*frac, 0.5); const rgb = hexRgb(COLORS[i]);
      doc.setFillColor(rgb[0],rgb[1],rgb[2]); doc.rect(cx, P.y, segW, barH, 'F');
      if (segW > 10){
        doc.setTextColor(15,22,32); doc.setFont('helvetica','bold'); doc.setFontSize(6);
        doc.splitTextToSize(pdfSafe(p.label||''), segW-2.5).slice(0,2).forEach((ln,li)=>doc.text(ln, cx+1.8, P.y+4+li*2.5));
        doc.setFontSize(7.5); doc.text((p.s?p.s.mean.toFixed(1):'-')+'d', cx+1.8, P.y+barH-1.8);
        doc.setFont('helvetica','normal');
      }
      cx += segW;
    });
    const totX = M + barW + 5;
    doc.setTextColor(95,95,105); doc.setFontSize(7); doc.text('Total to site', totX, P.y+5);
    doc.setTextColor(28,44,64); doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.text(flowMean.toFixed(1)+'d', totX, P.y+11);
    doc.setFont('helvetica','normal'); P.y += barH + 3.5;
    doc.setTextColor(120,95,175); doc.setFontSize(7.5);
    doc.text(pdfSafe(`then on shelf - E - Time to First Use: ${eMean.toFixed(1)}d`), M, P.y); P.y += 5;
    // optional box & whisker (suppressed under force-fit to save the page)
    if (opts && opts.box && !(fit && fit.noBox)){
      host.innerHTML = '<div id="rbTp"></div>';
      TracePhase.render(host.querySelector('#rbTp'), ctx.json, ctx.m.material, { filters: ctx.traceFilters || {} });
      const svgs = [...host.querySelectorAll('.pd-plot-svg')];
      if (svgs.length){
        const gap = 3, n = svgs.length; const pw = (CW - (n-1)*gap)/n;
        let ph = Math.min(pw * (220/168), 34); if (fit && fit.imgScale) ph *= fit.imgScale;
        const titleH = 6; P.ensure(titleH + ph + 3);
        for (let k=0;k<n;k++){
          const x = M + k*(pw+gap), cxp = x + pw/2; const ps = pstats[k] || {};
          doc.setTextColor(45,55,70); doc.setFont('helvetica','bold'); doc.setFontSize(6.5);
          doc.splitTextToSize(pdfSafe(ps.label||''), pw-1).slice(0,2).forEach((ln,li)=>doc.text(ln, cxp, P.y+3+li*2.6, {align:'center'}));
          doc.setFont('helvetica','normal');
          try { const p = await svgToJpeg(svgs[k], 2, 0.66); doc.addImage(p.data,'JPEG', x, P.y+titleH, pw, ph); } catch(e){}
        }
        P.y += titleH + ph + 4;
      }
    }
  }

  async function blockYoY(P, host, opts, fit){
    const { doc, g, ctx } = P; const M = g.M; const CW = g.W - 2*M;
    P.sectionLabel('Annual progression — supply duration by year');
    if (!ctx.hasPr){ noPrNote(P, 'the year-over-year view'); return; }
    const { drawn } = drawnChains(ctx);
    if (drawn.length < 2){ thinNote(P, `Only ${drawn.length} complete chain(s) — need at least 2 for the year comparison.`); return; }
    const PK = TracePhase.PHASE_KEYS, PL = TracePhase.PHASE_LABELS, COLORS = TracePhase.PHASE_COLORS;
    // group by year of prDate
    const byYear = new Map();
    drawn.forEach(c => { const yr = (c.prDate||'').slice(0,4); if (!yr) return; if (!byYear.has(yr)) byYear.set(yr, []); byYear.get(yr).push(c); });
    const years = [...byYear.keys()].sort();
    if (!years.length){ thinNote(P, 'No dated chains to compare by year.'); return; }
    // shared scale = max total-to-site across years
    const yearStats = years.map(yr => {
      const cs = byYear.get(yr);
      const means = PK.map(ph => { const s = TracePhase.boxStats(cs.map(c => c[ph])); return s ? s.mean : 0; });
      const toSite = means[0]+means[1]+means[2]+means[3];
      return { yr, n:cs.length, means, toSite, shelf:means[4] };
    });
    const maxToSite = Math.max(1, ...yearStats.map(s => s.toSite));
    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(95,95,105);
    doc.text(pdfSafe('Completed chains only (received POs) - phases A-D to site, plus shelf time E - bars on a shared scale'), M, P.y); P.y += 3;
    const barMaxW = CW * 0.66, rowH = 12, gap = 5;
    yearStats.forEach(ys => {
      P.ensure(rowH + gap);
      // year label
      doc.setTextColor(40,52,66); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
      doc.text(ys.yr, M, P.y + 7);
      doc.setFont('helvetica','normal'); doc.setFontSize(6); doc.setTextColor(120,128,136);
      doc.text('n=' + ys.n, M, P.y + 10.5);
      const bx = M + 16; let cx = bx; const scale = (ys.toSite / maxToSite) * barMaxW;
      // A–D segments proportional within this year's total, bar length ∝ toSite/maxToSite
      const segTotal = ys.toSite || 1;
      for (let i=0;i<4;i++){
        const segW = Math.max((ys.means[i]/segTotal) * scale, ys.means[i] > 0 ? 0.6 : 0);
        if (segW <= 0) continue;
        const rgb = hexRgb(COLORS[i]);
        doc.setFillColor(rgb[0],rgb[1],rgb[2]); doc.rect(cx, P.y, segW, rowH, 'F');
        if (segW > 9){
          doc.setTextColor(15,22,32); doc.setFont('helvetica','bold'); doc.setFontSize(6.5);
          doc.text(ys.means[i].toFixed(1)+'d', cx+1.6, P.y+rowH-3);
          doc.setFont('helvetica','normal');
        }
        cx += segW;
      }
      // total-to-site readout
      const tX = bx + barMaxW + 6;
      doc.setTextColor(95,95,105); doc.setFontSize(6.5); doc.text('to site', tX, P.y+4.5);
      doc.setTextColor(28,44,64); doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.text(ys.toSite.toFixed(1)+'d', tX, P.y+10);
      doc.setFont('helvetica','normal');
      // shelf E
      doc.setTextColor(120,95,175); doc.setFontSize(6.5);
      doc.text(pdfSafe('shelf E ' + ys.shelf.toFixed(1) + 'd'), tX + 22, P.y+10);
      P.y += rowH + gap;
    });
    // legend
    P.ensure(6);
    let lx = M; doc.setFontSize(6.5);
    PK.slice(0,4).forEach((ph,i)=>{ const rgb=hexRgb(COLORS[i]); doc.setFillColor(rgb[0],rgb[1],rgb[2]); doc.rect(lx, P.y-2.4, 3, 3, 'F'); doc.setTextColor(90,96,104); doc.text(pdfSafe(PL[ph]), lx+4, P.y); lx += doc.getTextWidth(pdfSafe(PL[ph])) + 12; });
    P.y += 5;
  }

  async function blockRawPr(P, host, opts, fit){
    const { doc, g, ctx } = P; const M = g.M; const CW = g.W - 2*M;
    let N = Math.max(1, (opts && opts.lastN) || 8);
    if (fit && fit.capN) N = Math.min(N, fit.capN);
    P.sectionLabel(`Raw data — last ${N} PRs`, (N + 1) * 4.9 + 24);   // keep heading + whole table together
    if (!ctx.hasPr){ noPrNote(P, 'the raw PR table'); return; }
    const { act } = drawnChains(ctx);
    const rows = (act || []).slice(0, N).map(c => [
      c.pr || '-',
      (c.creationIndicator === 'B') ? 'MRP' : 'Manual',
      c.prDate || '-', c.po || '-', c.poDate || '-', c.gr3pl || '-', c.siteWH || '-', c.c261 || '-',
      c.A!=null?String(c.A):'-', c.B!=null?String(c.B):'-', c.C!=null?String(c.C):'-', c.D!=null?String(c.D):'-', c.E!=null?String(c.E):'-',
      c.total!=null?String(c.total):'-', c.qty!=null?String(c.qty):'-', (c.state||'-').replace(/_/g,' ')
    ].map(pdfSafe));
    if (!rows.length){ thinNote(P, 'No PRs for this material.'); return; }
    P.ensure((rows.length + 1) * 4.9 + 6);   // reserve room for the whole table
    doc.autoTable({
      startY: P.y,
      head: [['PR','Trig','PR date','PO','PO date','3PL GR','Site WH','1st 261','A','B','C','D','E','Tot','Qty','State']],
      body: rows, theme:'grid', pageBreak:'avoid', rowPageBreak:'avoid',
      styles:{ fontSize:6.6, cellPadding:1, lineColor:[214,220,224], lineWidth:0.1, overflow:'ellipsize' },
      headStyles:{ fillColor:[12,45,59], textColor:255, fontStyle:'bold', fontSize:6.6, halign:'center' },
      columnStyles:{ 8:{halign:'center'},9:{halign:'center'},10:{halign:'center'},11:{halign:'center'},12:{halign:'center'},13:{halign:'center',fontStyle:'bold'},14:{halign:'center'} },
      tableWidth: CW, margin:{ left:M, right:M },
      didParseCell:(d)=>{
        if (d.row.section !== 'body') return;
        const canc = /CANCELL/i.test((rows[d.row.index] || [])[15] || '');   // State column
        if (canc){ d.cell.styles.textColor = [229,57,53]; d.cell.styles.fontStyle = 'bold'; }
        else if (d.column.index === 1){ d.cell.styles.fontStyle = 'bold'; d.cell.styles.textColor = d.cell.raw === 'Manual' ? [186,117,23] : [90,110,120]; }
      },
      didDrawCell:(d)=>{
        if (d.row.section !== 'body') return;
        if (/CANCELL/i.test((rows[d.row.index] || [])[15] || '')){
          doc.setDrawColor(229,45,45); doc.setLineWidth(0.35);
          const yy = d.cell.y + d.cell.height/2;
          doc.line(d.cell.x + 0.6, yy, d.cell.x + d.cell.width - 0.6, yy);   // strikethrough
        }
      }
    });
    P.y = doc.lastAutoTable.finalY + 5;
  }

  async function blockChains(P, host, opts, fit){
    const { doc, g, ctx } = P; const M = g.M; const CW = g.W - 2*M;
    let N = Math.max(1, (opts && opts.lastN) || 5);
    if (fit && fit.capN) N = Math.min(N, fit.capN);
    P.sectionLabel(`Last ${N} procurement chains`, (N + 1) * 6 + 24);   // keep heading + whole table together
    if (!ctx.hasPr){ noPrNote(P, 'the procurement chains'); return; }
    const { drawn } = drawnChains(ctx);
    const chains = (drawn || []).slice(0, N);
    if (!chains.length){ thinNote(P, 'No completed procurement chains for this material.'); return; }
    const rows = chains.map(c => [
      c.pr||'-', c.po||'-', c.prDate||'-', c.siteWH||'-',
      c.A!=null?c.A+'d':'-', c.B!=null?c.B+'d':'-', c.C!=null?c.C+'d':'-', c.D!=null?c.D+'d':'-',
      (c.totalToSite!=null?c.totalToSite.toFixed(0)+'d':'-'), c.E!=null?c.E+'d':'-', c.qty!=null?String(c.qty):'-'
    ].map(pdfSafe));
    P.ensure((rows.length + 1) * 6 + 6);   // reserve room for the whole table
    doc.autoTable({
      startY: P.y,
      head: [['PR','PO','PR date','Site WH','A','B','C','D','To site','Shelf E','Qty']],
      body: rows, theme:'grid', pageBreak:'avoid', rowPageBreak:'avoid',
      styles:{ fontSize:7.4, cellPadding:1.3, lineColor:[214,220,224], lineWidth:0.1 },
      headStyles:{ fillColor:[12,45,59], textColor:255, fontStyle:'bold', fontSize:7.4, halign:'center' },
      columnStyles:{ 4:{halign:'center'},5:{halign:'center'},6:{halign:'center'},7:{halign:'center'},8:{halign:'center',fontStyle:'bold'},9:{halign:'center',textColor:[120,95,175]},10:{halign:'center'} },
      tableWidth: CW, margin:{ left:M, right:M }
    });
    P.y = doc.lastAutoTable.finalY + 5;
  }

  function blockComment(P, host, opts){
    const { doc, g } = P; const M = g.M; const CW = g.W - 2*M;
    const txt = (opts && opts.comment || '').trim();
    if (!txt) return;
    P.sectionLabel('Comments');
    doc.setDrawColor(BW.cyan[0],BW.cyan[1],BW.cyan[2]); doc.setLineWidth(0.3);
    const lines = doc.splitTextToSize(pdfSafe(txt), CW - 6);
    const boxH = Math.max(10, lines.length * 4.4 + 5);
    P.ensure(boxH + 2);
    doc.setFillColor(246,249,250); doc.rect(M, P.y, CW, boxH, 'F');
    doc.setDrawColor(BW.cyan[0],BW.cyan[1],BW.cyan[2]); doc.rect(M, P.y, 1.4, boxH, 'F'); // cyan left edge
    doc.setTextColor(40,48,58); doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
    let ty = P.y + 5; lines.forEach(l => { doc.text(l, M+4, ty); ty += 4.4; });
    P.y += boxH + 5;
  }

  function noPrNote(P, what){
    const { doc, g } = P; const M = g.M; const CW = g.W - 2*M;
    doc.setTextColor(120,80,0); doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.splitTextToSize(pdfSafe(`Trace needs PR History - this assessment has none, so ${what} is unavailable.`), CW).forEach(l => { P.ensure(5); doc.text(l, M, P.y); P.y += 4; });
    P.y += 2;
  }
  function thinNote(P, msg){
    const { doc, g } = P; const M = g.M; const CW = g.W - 2*M;
    doc.setTextColor(120,90,10); doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.splitTextToSize(pdfSafe(msg), CW).forEach(l => { P.ensure(5); doc.text(l, M, P.y); P.y += 4; });
    P.y += 2;
  }

  const RENDERERS = { trend:blockTrend, avgDur:blockAvgDur, yoy:blockYoY, rawpr:blockRawPr, chains:blockChains, comment:blockComment };

  // very rough per-block height estimate (mm) for the overflow warning
  function estimate(id, opts, ctx, g){
    const CW = g.W - 2*g.M;
    switch(id){
      case 'trend':  return 16 + CW*(300/936) + 30 + 24;
      case 'avgDur': return 16 + 22 + (opts && opts.box ? Math.min((CW/5)*(220/168),34)+9 : 0);
      case 'yoy':    { const { drawn } = safeDrawn(ctx); const yrs = new Set((drawn||[]).map(c=>(c.prDate||'').slice(0,4))).size || 1; return 16 + 6 + yrs*17 + 6; }
      case 'rawpr':  { const n = Math.min((opts&&opts.lastN)||8, (safeDrawn(ctx).act||[]).length); return 16 + 8 + n*5.5; }
      case 'chains': { const n = Math.min((opts&&opts.lastN)||5, (safeDrawn(ctx).drawn||[]).length); return 16 + 8 + n*7; }
      case 'comment':{ const t=(opts&&opts.comment||''); return t.trim()? 16 + Math.max(10, Math.ceil(t.length/90)*4.4+5) : 0; }
      default: return 0;
    }
  }
  function safeDrawn(ctx){ try { return drawnChains(ctx); } catch(e){ return { chains:[], act:[], drawn:[] }; } }

  /* ═════════════════════════════════════════════════════════════════════════
     BUILD
  ═════════════════════════════════════════════════════════════════════════ */
  async function build(ctx, pageSize, order, fitMode, mode, onProg){
    await ensureLibs();
    const jsPDFCtor = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
    if (!jsPDFCtor) throw new Error('jsPDF unavailable');
    const g = geomFor(pageSize);
    const doc = new jsPDFCtor({ orientation: g.orientation, unit:'mm', format: g.format, compress:true });

    // Reports are never crammed onto one page — full quality, clean multi-page
    // always (each block at full size, blocks kept intact across page breaks).
    const fit = null;

    // The flagged SET (configure once → a page-set per material). Falls back to the
    // single reference material if no batch was passed.
    const list = (ctx.batch && ctx.batch.list && ctx.batch.list.length)
      ? ctx.batch.list : [{ m: ctx.m, bucket: ctx.bucket }];

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1000px;';
    document.body.appendChild(host);
    try {
      const pageMat = [];   // 1-based page index → material label (for per-material footers)
      for (let i = 0; i < list.length; i++){
        if (onProg) onProg(i + 1, list.length);
        const mctx = ctxForEntry(ctx, list[i]);
        if (i > 0) doc.addPage(g.format, g.orientation);   // each material starts a fresh page-set
        const startPage = doc.getNumberOfPages();
        const P = makePager(doc, g, mctx);
        for (const b of order){
          const fn = RENDERERS[b.id];
          if (!fn) continue;
          await fn(P, host, b.opts || {}, fit);
        }
        for (let p = startPage; p <= doc.getNumberOfPages(); p++) pageMat[p] = mctx.m.material;
        if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));   // yield so the UI can repaint on big sets
      }
      // footers (per-material label + running page number)
      const pages = doc.getNumberOfPages();
      for (let i=1;i<=pages;i++){
        doc.setPage(i);
        doc.setTextColor(140,148,156); doc.setFont('helvetica','normal'); doc.setFontSize(7);
        doc.text(pdfSafe(`${pageMat[i] || ctx.m.material}  -  ${ctx.assessmentName||''}`), g.M, g.H - 5);
        doc.text(`Page ${i} / ${pages}`, g.W - g.M, g.H - 5, { align:'right' });
      }
      const safe = (ctx.assessmentName || 'assessment').replace(/[^A-Za-z0-9_-]+/g,'_');
      const filename = list.length > 1
        ? `Screener_Report_SET_${list.length}_${safe}.pdf`
        : `Screener_Report_${list[0].m.material}_${safe}.pdf`;
      if (mode === 'preview'){
        // Render in-app instead of downloading — the operator downloads explicitly.
        const url = URL.createObjectURL(doc.output('blob'));
        return { pages, url, filename };
      }
      doc.save(filename);
      return { pages, filename };
    } finally {
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  /* ═════════════════════════════════════════════════════════════════════════
     UI  —  builder modal
  ═════════════════════════════════════════════════════════════════════════ */
  function open(ctx){
    if (!ctx || !ctx.m){ return; }
    const nMat = (ctx.batch && ctx.batch.list && ctx.batch.list.length) || 1;
    // seed working list from catalogue (respecting availability)
    const items = BLOCKS.map(b => ({
      id:b.id, label:b.label, needs:b.needs, soon:!!b.soon, opt:b.opt,
      on: b.on && (b.needs !== 'pr' || ctx.hasPr) && !b.soon,
      box: b.id==='avgDur',
      lastN: b.lastN || 8,
      comment: ''
    }));

    const ov = document.createElement('div');
    ov.className = 'rb-overlay';
    ov.innerHTML = `
      <div class="rb-modal" role="dialog" aria-label="Build report">
        <div class="rb-head">
          <div>
            <div class="rb-eyebrow">Calibre · Screener report</div>
            <div class="rb-title">${nMat > 1 ? 'Build report — ' + nMat + ' flagged materials' : 'Build report — ' + esc(ctx.m.material)}</div>
            <div class="rb-sub">${nMat > 1 ? 'Configure once → one page-set per material. Reference for layout: ' + esc(ctx.m.material) + ' ' + esc(ctx.m.description || '') : esc(ctx.m.description || '')}</div>
          </div>
          <button class="rb-x" title="Close">✕</button>
        </div>

        <div class="rb-body">
          <div class="rb-sec">
            <div class="rb-sec-h">1 · Page size</div>
            <div class="rb-size">
              <label class="rb-size-opt active"><input type="radio" name="rbsize" value="letter" checked><span class="rb-size-name">US Letter</span><span class="rb-size-d">Portrait · stacked report</span></label>
              <label class="rb-size-opt"><input type="radio" name="rbsize" value="wide"><span class="rb-size-name">Widescreen 16:9</span><span class="rb-size-d">Landscape · for 1080p / 4K screens</span></label>
            </div>
            <div class="rb-wide-note" hidden>Widescreen exports a landscape PDF. The drag-and-drop 2D layout tool is a later pass.</div>
            <div class="rb-theme" hidden>
              <span class="rb-theme-lab">Widescreen appearance</span>
              <label class="rb-theme-opt active"><input type="radio" name="rbtheme" value="light" checked> Light — report style</label>
              <label class="rb-theme-opt"><input type="radio" name="rbtheme" value="dark"> Dark — on-screen look</label>
            </div>
          </div>

          <div class="rb-sec">
            <div class="rb-sec-h">2 · Blocks <span class="rb-hint">— tick to include, drag ⠿ to reorder</span></div>
            <ul class="rb-blocks"></ul>
          </div>
        </div>

        <div class="rb-foot">
          <div class="rb-warn" hidden></div>
          <div class="rb-actions">
            <button class="rb-btn ghost rb-cancel">Cancel</button>
            <button class="rb-btn primary rb-gen">Preview →</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const listEl = ov.querySelector('.rb-blocks');
    function drawRow(it){
      const li = document.createElement('li');
      li.className = 'rb-row' + (it.on ? ' on' : '') + (it.soon ? ' soon' : '');
      li.draggable = true; li.dataset.id = it.id;
      const disabled = (it.needs === 'pr' && !ctx.hasPr) || it.soon;
      let optHtml = '';
      if (it.opt === 'box') optHtml = `<label class="rb-optb"><input type="checkbox" class="rb-box" ${it.box?'checked':''}> box &amp; whisker</label>`;
      if (it.opt === 'lastN') optHtml = `<label class="rb-optb">last <input type="number" class="rb-n" min="1" max="50" value="${it.lastN}"> </label>`;
      if (it.opt === 'comment') optHtml = `<textarea class="rb-comment" placeholder="Type comments to include in the report…" rows="2">${esc(it.comment)}</textarea>`;
      li.innerHTML = `
        <span class="rb-grip" title="Drag to reorder">⠿</span>
        <label class="rb-chk"><input type="checkbox" class="rb-on" ${it.on?'checked':''} ${disabled?'disabled':''}></label>
        <span class="rb-lab">${esc(it.label)}${it.soon?' <em class="rb-soon">coming next</em>':''}${(it.needs==='pr'&&!ctx.hasPr)?' <em class="rb-na">needs PR History</em>':''}</span>
        <span class="rb-opt">${optHtml}</span>`;
      // wire
      const onBox = li.querySelector('.rb-on');
      if (onBox) onBox.addEventListener('change', () => { it.on = onBox.checked; li.classList.toggle('on', it.on); refreshWarn(); });
      const box = li.querySelector('.rb-box'); if (box) box.addEventListener('change', () => { it.box = box.checked; refreshWarn(); });
      const n = li.querySelector('.rb-n'); if (n) n.addEventListener('input', () => { it.lastN = Math.max(1, Math.min(50, parseInt(n.value||'1',10)||1)); refreshWarn(); });
      const cm = li.querySelector('.rb-comment'); if (cm) cm.addEventListener('input', () => { it.comment = cm.value; });
      // DnD
      li.addEventListener('dragstart', e => { li.classList.add('drag'); e.dataTransfer.setData('text/plain', it.id); });
      li.addEventListener('dragend',   () => li.classList.remove('drag'));
      li.addEventListener('dragover',  e => { e.preventDefault(); const d=ov.querySelector('.rb-row.drag'); if(!d||d===li) return; const r=li.getBoundingClientRect(); const after=(e.clientY-r.top)/r.height>0.5; listEl.insertBefore(d, after?li.nextSibling:li); });
      return li;
    }
    items.forEach(it => listEl.appendChild(drawRow(it)));

    function currentOrder(){
      return [...listEl.querySelectorAll('.rb-row')].map(li => items.find(x => x.id === li.dataset.id)).filter(Boolean);
    }
    function selectedBlocks(){
      return currentOrder().filter(it => it.on && !it.soon).map(it => ({
        id: it.id,
        opts: { box: it.box, lastN: it.lastN, comment: it.comment }
      }));
    }

    // page size
    let pageSize = 'letter';
    ov.querySelectorAll('input[name="rbsize"]').forEach(r => r.addEventListener('change', () => {
      pageSize = ov.querySelector('input[name="rbsize"]:checked').value;
      ov.querySelectorAll('.rb-size-opt').forEach(o => o.classList.toggle('active', o.querySelector('input').checked));
      ov.querySelector('.rb-wide-note').hidden = pageSize !== 'wide';
      ov.querySelector('.rb-theme').hidden = pageSize !== 'wide';
      ov.querySelector('.rb-gen').textContent = pageSize === 'wide' ? 'Arrange →' : 'Preview →';
      refreshWarn();
    }));
    ov.querySelectorAll('input[name="rbtheme"]').forEach(r => r.addEventListener('change', () => {
      ov.querySelectorAll('.rb-theme-opt').forEach(o => o.classList.toggle('active', o.querySelector('input').checked));
    }));

    // overflow estimate
    const warnEl = ov.querySelector('.rb-warn');
    function refreshWarn(){
      const g = geomFor(pageSize);
      const usable = (g.H - g.M) - 26;
      const blocks = selectedBlocks();
      const total = blocks.reduce((s,b) => s + estimate(b.id, b.opts, ctx, g), 0);
      const pages = Math.max(1, Math.ceil(total / usable));
      if (blocks.length && pages > 1){
        warnEl.hidden = false; warnEl.className = 'rb-warn info';
        warnEl.innerHTML = `This report will run to about <b>${pages} pages</b> — laid out at full size with a header on each page.`;
      } else { warnEl.hidden = true; warnEl.className = 'rb-warn'; }
      return { pages };
    }
    refreshWarn();

    function close(){ ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.querySelector('.rb-x').addEventListener('click', close);
    ov.querySelector('.rb-cancel').addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    // Preview panel (renders the PDF in-app; download is explicit).
    function showPreview(res){
      const pv = document.createElement('div');
      pv.className = 'rb-preview';
      pv.innerHTML = `
        <div class="rb-pv-bar">
          <span class="rb-pv-meta">${res.pages} page${res.pages===1?'':'s'} · ${pageSize==='wide'?'Widescreen 16:9':'US Letter'}</span>
          <span class="rb-pv-actions">
            <button class="rb-btn ghost rb-pv-back">‹ Back to blocks</button>
            <button class="rb-btn ghost rb-pv-print">🖨 Print</button>
            <a class="rb-btn primary rb-pv-dl" download="${esc(res.filename)}" href="${res.url}">⤓ Download PDF</a>
          </span>
        </div>
        <iframe class="rb-pv-frame" title="Report preview" src="${res.url}#toolbar=1&navpanes=0"></iframe>`;
      const modal = ov.querySelector('.rb-modal');
      modal.classList.add('rb-has-preview');
      modal.style.width = 'min(1100px,100%)'; modal.style.height = 'min(90vh,960px)';
      modal.appendChild(pv);
      pv.querySelector('.rb-pv-back').addEventListener('click', () => { pv.remove(); modal.classList.remove('rb-has-preview'); modal.style.width=''; modal.style.height=''; try { URL.revokeObjectURL(res.url); } catch(e){} });
      pv.querySelector('.rb-pv-print').addEventListener('click', () => { try { pv.querySelector('.rb-pv-frame').contentWindow.print(); } catch(e){ window.open(res.url, '_blank'); } });
    }

    ov.querySelector('.rb-gen').addEventListener('click', async () => {
      const blocks = selectedBlocks();
      if (!blocks.length){ warnEl.hidden = false; warnEl.className='rb-warn'; warnEl.innerHTML = '⚠ Pick at least one block to include.'; return; }
      const gen = ov.querySelector('.rb-gen'); const orig = gen.textContent;
      gen.disabled = true; gen.textContent = pageSize === 'wide' ? 'Building cards…' : 'Rendering…';
      try {
        if (pageSize === 'wide'){
          const theme = (ov.querySelector('input[name="rbtheme"]:checked') || {}).value || 'light';
          await openWideCanvas(ov, close, ctx, blocks, theme);
        } else {
          const res = await build(ctx, pageSize, blocks, 'multi', 'preview', (k, n) => { if (n > 1) gen.textContent = `Rendering ${k}/${n}…`; });
          showPreview(res);
        }
        gen.disabled = false; gen.textContent = orig;
      } catch (e){
        console.error(e);
        warnEl.hidden = false; warnEl.className='rb-warn'; warnEl.innerHTML = '⚠ Report failed: ' + esc(e.message || String(e));
        gen.disabled = false; gen.textContent = orig;
      }
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     WIDESCREEN — drag-and-drop layout canvas (APP-SCR-REPORT-WIDE)

     Each selected block becomes a themed HTML "card". The operator drags cards
     on a 16:9 stage and resizes them (aspect ratio fixed per card, size free).
     The arrangement is a reusable TEMPLATE (block id -> {x,y,w} in 0..1) that is
     material-independent, so the same layout can later be printed for many
     materials. Export rasterises each card (html2canvas) onto a landscape PDF at
     its placed rectangle.
  ═════════════════════════════════════════════════════════════════════════ */

  const CARD_W = 640;   // logical render width of a card (px); AR derived from content

  function cardTheme(theme){
    return theme === 'dark'
      ? { bg:'#0c2d3b', text:'#e7eef0', sub:'#9bb0b6', border:'rgba(31,206,216,.28)', head:'#081e2b', headText:'#dff3f5', alt:'rgba(255,255,255,.03)', keyBg:'#0f3948', accent:'#1FCED8', chip:'#0f3948' }
      : { bg:'#ffffff', text:'#1a2a2e', sub:'#5c7270', border:'#d6dfde', head:'#0c2d3b', headText:'#ffffff', alt:'#f4f7f7', keyBg:'#eef3f4', accent:'#1FCED8', chip:'#eef3f4' };
  }

  async function chartDataUrl(ctx){
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1000px;'; document.body.appendChild(host);
    try { const svg = AppChart.render(host, ctx.m, { width: 936, height: 300 }); const j = await svgToJpeg(svg, 1.7, 0.82); return j.data; }
    finally { host.remove(); }
  }
  async function boxPlotDataUrls(ctx){
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1000px;'; document.body.appendChild(host);
    try {
      TracePhase.render(host, ctx.json, ctx.m.material, { filters: ctx.traceFilters || {} });
      const svgs = [...host.querySelectorAll('.pd-plot-svg')];
      const out = [];
      for (const s of svgs){ try { out.push((await svgToJpeg(s, 2, 0.8)).data); } catch(e){} }
      return out;
    } finally { host.remove(); }
  }

  function htmlTable(TH, head, rows, opts){
    opts = opts || {};
    const th = head.map(h => `<th style="background:${TH.head};color:${TH.headText};font-weight:700;font-size:10px;padding:4px 5px;text-align:center;border:1px solid ${TH.border};white-space:nowrap">${esc(h)}</th>`).join('');
    const body = rows.map((r,ri) => {
      const struck = opts.strike && opts.strike(r);            // cancelled PR → red strikethrough, eye-catching
      const rowBg = struck ? 'background:rgba(239,68,68,.16)' : `background:${ri%2?TH.alt:'transparent'}`;
      const cellFx = struck ? `color:#ff5a5a;text-decoration:line-through;text-decoration-color:#ff2d2d;text-decoration-thickness:2px;font-weight:700` : `color:${TH.text}`;
      return `<tr style="${rowBg}">${r.map((c,ci)=>`<td style="font-size:10px;padding:3px 5px;border:1px solid ${TH.border};text-align:${(opts.center&&opts.center.includes(ci))?'center':'left'};white-space:nowrap;${cellFx}">${esc(c)}</td>`).join('')}</tr>`;
    }).join('');
    return `<table style="border-collapse:collapse;width:100%;font-family:'JetBrains Mono',monospace">${th?`<thead><tr>${th}</tr></thead>`:''}<tbody>${body}</tbody></table>`;
  }
  function keyGrid(TH, pairs){
    return `<div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:1px;background:${TH.border};border:1px solid ${TH.border}">` +
      pairs.map(([k,v]) => `<div style="background:${TH.keyBg};padding:4px 7px;font-weight:700;font-size:11px;color:${TH.text}">${esc(k)}</div><div style="background:${TH.bg};padding:4px 7px;font-size:11px;color:${TH.text};font-family:'JetBrains Mono',monospace">${esc(v)}</div>`).join('') +
      `</div>`;
  }
  function sectionTitle(TH, txt){
    return `<div style="font-family:'Rajdhani','Barlow',sans-serif;font-weight:700;font-size:14px;color:${TH.text};margin:0 0 3px">${esc(txt)}</div><div style="height:2px;background:${TH.accent};margin-bottom:8px"></div>`;
  }

  // Convert every inline SVG in a subtree to a raster <img> so html2canvas
  // captures charts/box-plots crisply (html2canvas SVG support is patchy).
  async function snapshotSvgsToImgs(root){
    const svgs = [...root.querySelectorAll('svg')];
    for (const svg of svgs){
      try {
        if (!svg.getAttribute('viewBox')) continue;
        const jp = await svgToJpeg(svg, 1.9, 0.86);
        const img = new Image(); img.src = jp.data;
        img.style.display = 'block'; img.style.width = '100%'; img.style.height = 'auto';
        await new Promise(r => { img.onload = img.onerror = r; });
        if (svg.parentNode) svg.parentNode.replaceChild(img, svg);
      } catch (e) { /* leave the SVG as-is */ }
    }
  }

  // DARK cards for blocks that have a real on-screen renderer are an EXACT grab of
  // the live app component (same MaterialDetail / TracePhase the app draws, same
  // CSS — loaded on the Screener page), not a re-style.
  async function buildExactCard(id, ctx){
    const el = document.createElement('div');
    el.style.cssText = `width:${CARD_W}px;box-sizing:border-box;background:#0c2d3b;border:1px solid rgba(31,206,216,.28);border-radius:8px;padding:6px`;
    if (id === 'trend' && typeof MaterialDetail !== 'undefined'){
      MaterialDetail.render(el, ctx.m, { bucket: ctx.bucket, parameters: ctx.json.parameters, enableLlm:false, chartWidth: 900, chartHeight: 300 });
      // Operator ask (2026-09-25): chart + short stat table only. Drop the "More
      // stats" toggle + secondary grid and the Current-vs-Recommended MRP table
      // (the recommendation already reads in the header).
      ['#statExpandBtn', '#statGridExtra', '.stat-grid-extra', '.mrp-compare', '.mrp-reclass-note'].forEach(sel => {
        el.querySelectorAll(sel).forEach(n => n.remove());
      });
    } else if (id === 'avgDur' && typeof TracePhase !== 'undefined'){
      TracePhase.render(el, ctx.json, ctx.m.material, { filters: ctx.traceFilters || {} });
    }
    await snapshotSvgsToImgs(el);
    return el;
  }

  async function buildCardDom(id, ctx, opts, theme){
    if (theme === 'dark' && (id === 'trend' || id === 'avgDur')){
      return await buildExactCard(id, ctx);
    }
    const TH = cardTheme(theme);
    const m = ctx.m;
    const el = document.createElement('div');
    el.style.cssText = `width:${CARD_W}px;box-sizing:border-box;background:${TH.bg};color:${TH.text};border:1px solid ${TH.border};border-radius:8px;padding:14px 16px;font-family:'Barlow',system-ui,sans-serif;overflow:hidden`;
    let inner = '';

    if (id === 'trend'){
      const cad = (typeof AppLocale!=='undefined'&&AppLocale.fmtCAD)?AppLocale.fmtCAD(m.totValueOh):String(m.totValueOh??'—');
      const img = await chartDataUrl(ctx);
      inner = sectionTitle(TH,'Consumption trend')
        + `<img src="${img}" style="width:100%;display:block;border:1px solid ${TH.border};border-radius:4px;margin-bottom:8px"/>`
        + keyGrid(TH, [
            ['Stock on hand', String(m.stock??'—')], ['Stock value', cad],
            ['P1 rate', m.p1Flag==='OK'?m.p1Rate.toFixed(2)+' /mo':'—'], ['P2 rate', m.p2Flag==='OK'?m.p2Rate.toFixed(2)+' /mo':'—'],
            ['Runway @ P2', m.runway!=null?m.runway+' mo':'—'], ['Last cons.', m.lastConsumptionDate||'—']
          ])
        + `<div style="height:6px"></div>`
        + htmlTable(TH, ['MRP','Current','Recommended','Analyst'], [
            ['Type', m.mrpType||'—', m.recMrpType||'—', (ctx.analyst&&ctx.analyst.getRec(m.material).mrpType)||'—'],
            ['Min', m.cmin!=null?String(m.cmin):'—', m.recMin!=null?String(m.recMin):'—', (ctx.analyst&&ctx.analyst.getRec(m.material).min)||'—'],
            ['Max', m.cmax!=null?String(m.cmax):'—', m.recMax!=null?String(m.recMax):'—', (ctx.analyst&&ctx.analyst.getRec(m.material).max)||'—']
          ], { center:[1,2,3] });
    }
    else if (id === 'avgDur'){
      inner = sectionTitle(TH,'Average supply duration');
      if (!ctx.hasPr){ inner += `<div style="color:${TH.sub};font-size:12px">Needs PR History.</div>`; }
      else {
        const { drawn } = drawnChains(ctx);
        if (drawn.length < 2){ inner += `<div style="color:${TH.sub};font-size:12px">Fewer than 2 complete chains.</div>`; }
        else {
          const PK=TracePhase.PHASE_KEYS, PL=TracePhase.PHASE_LABELS, CO=TracePhase.PHASE_COLORS;
          const ps = PK.map(ph=>({key:ph,label:PL[ph],s:TracePhase.boxStats(drawn.map(c=>c[ph]))}));
          const flowMean = TracePhase.totalToSiteMean(drawn);
          const flow = ps.filter(x=>x.key!=='E');
          const bar = flow.map((p,i)=>{ const frac=flowMean>0?((p.s?p.s.mean:0)/flowMean):0; return `<div style="flex:${Math.max(frac,0.02)};background:${CO[i]};color:#0f1620;font-size:9px;font-weight:700;padding:6px 3px;text-align:center;overflow:hidden">${p.label.split(' ')[0]}<br>${p.s?p.s.mean.toFixed(1):'—'}d</div>`; }).join('');
          inner += `<div style="display:flex;gap:1px;border-radius:4px;overflow:hidden;margin-bottom:6px">${bar}</div>`
            + `<div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${TH.text}">Total to site <b style="color:${TH.accent}">${flowMean.toFixed(1)}d</b> · then shelf E ${(ps.find(x=>x.key==='E')?.s?.mean||0).toFixed(1)}d</div>`;
          if (opts && opts.box){
            const imgs = await boxPlotDataUrls(ctx);
            if (imgs.length) inner += `<div style="display:flex;gap:3px;margin-top:8px">${imgs.map(d=>`<img src="${d}" style="flex:1;min-width:0;border:1px solid ${TH.border};border-radius:3px"/>`).join('')}</div>`;
          }
        }
      }
    }
    else if (id === 'yoy'){
      inner = sectionTitle(TH,'Annual progression (YoY)');
      const { drawn } = drawnChains(ctx);
      if (!ctx.hasPr || drawn.length < 2){ inner += `<div style="color:${TH.sub};font-size:12px">Needs 2+ complete chains.</div>`; }
      else {
        const PK=TracePhase.PHASE_KEYS, CO=TracePhase.PHASE_COLORS;
        const byYear=new Map(); drawn.forEach(c=>{const y=(c.prDate||'').slice(0,4);if(!y)return;(byYear.get(y)||byYear.set(y,[]).get(y)).push(c);});
        const years=[...byYear.keys()].sort();
        const stats=years.map(y=>{const cs=byYear.get(y);const mn=PK.map(ph=>{const s=TracePhase.boxStats(cs.map(c=>c[ph]));return s?s.mean:0;});return {y,n:cs.length,mn,toSite:mn[0]+mn[1]+mn[2]+mn[3]};});
        const mx=Math.max(1,...stats.map(s=>s.toSite));
        inner += stats.map(s=>{
          const segs=s.mn.slice(0,4).map((v,i)=>v>0?`<div style="width:${(v/s.toSite*100)*(s.toSite/mx)}%;background:${CO[i]};min-width:${v>0?'3px':'0'}"></div>`:'').join('');
          return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><div style="width:52px;font-size:11px;color:${TH.text}"><b>${s.y}</b> <span style="color:${TH.sub}">n=${s.n}</span></div><div style="flex:1;display:flex;height:16px;border-radius:3px;overflow:hidden;background:${TH.alt}">${segs}</div><div style="width:56px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:${TH.accent}"><b>${s.toSite.toFixed(1)}d</b></div></div>`;
        }).join('');
      }
    }
    else if (id === 'rawpr' || id === 'chains'){
      const N = Math.max(1,(opts&&opts.lastN)||(id==='rawpr'?8:5));
      inner = sectionTitle(TH, id==='rawpr'?`Raw data — last ${N} PRs`:`Last ${N} procurement chains`);
      if (!ctx.hasPr){ inner += `<div style="color:${TH.sub};font-size:12px">Needs PR History.</div>`; }
      else {
        const dc = drawnChains(ctx);
        if (id==='rawpr'){
          const rows=(dc.act||[]).slice(0,N).map(c=>[c.pr||'—',(c.creationIndicator==='B')?'MRP':'Manual',c.prDate||'—',c.po||'—',c.siteWH||'—',c.A!=null?String(c.A):'—',c.B!=null?String(c.B):'—',c.C!=null?String(c.C):'—',c.D!=null?String(c.D):'—',c.total!=null?String(c.total):'—',c.qty!=null?String(c.qty):'—',(c.state||'—').replace(/_/g,' ')]);
          inner += rows.length?htmlTable(TH,['PR','Trig','PR date','PO','Site WH','A','B','C','D','Tot','Qty','State'],rows,{center:[5,6,7,8,9,10], strike:(r)=>/CANCELL/i.test(r[11])}):`<div style="color:${TH.sub};font-size:12px">No PRs.</div>`;
        } else {
          const rows=(dc.drawn||[]).slice(0,N).map(c=>[c.pr||'—',c.po||'—',c.prDate||'—',c.siteWH||'—',c.A!=null?c.A+'d':'—',c.B!=null?c.B+'d':'—',c.C!=null?c.C+'d':'—',c.D!=null?c.D+'d':'—',c.totalToSite!=null?c.totalToSite.toFixed(0)+'d':'—',c.qty!=null?String(c.qty):'—']);
          inner += rows.length?htmlTable(TH,['PR','PO','PR date','Site WH','A','B','C','D','To site','Qty'],rows,{center:[4,5,6,7,8,9]}):`<div style="color:${TH.sub};font-size:12px">No chains.</div>`;
        }
      }
    }
    else if (id === 'comment'){
      const txt=(opts&&opts.comment||'').trim();
      inner = sectionTitle(TH,'Comments') + `<div style="border-left:3px solid ${TH.accent};padding:6px 10px;background:${TH.alt};font-size:13px;color:${TH.text};white-space:pre-wrap;min-height:40px">${esc(txt)||'<span style="color:'+TH.sub+'">(empty)</span>'}</div>`;
    }
    el.innerHTML = inner;
    return el;
  }

  // Render each card DOM offscreen, measure natural AR, build canvas + PDF export.
  async function openWideCanvas(ov, close, ctx, blocks, theme){
    await ensureH2C();
    const stage_host = document.createElement('div'); stage_host.style.cssText='position:fixed;left:-99999px;top:0;width:1400px;'; document.body.appendChild(stage_host);
    const cards = [];
    for (const b of blocks){
      const el = await buildCardDom(b.id, ctx, b.opts||{}, theme);
      stage_host.appendChild(el);
      // wait for embedded images to load so the natural height is correct
      const imgs = [...el.querySelectorAll('img')];
      await Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(res => { im.onload = im.onerror = res; })));
      const ar = el.offsetHeight / el.offsetWidth || 1;
      cards.push({ id:b.id, opts:b.opts||{}, el, ar });
    }
    // default auto-layout (0..1 coords): flow into up to 3 columns
    const cols = Math.min(3, Math.max(1, Math.round(Math.sqrt(cards.length))));
    const gap = 0.015, colW = (1 - gap*(cols+1))/cols;
    const colY = new Array(cols).fill(gap);
    cards.forEach(c => {
      const col = colY.indexOf(Math.min(...colY));
      c.w = colW; c.x = gap + col*(colW+gap); c.y = colY[col];
      const h = c.w * 1.7778 * c.ar;   // height as fraction of stage height (16:9)
      colY[col] += h + gap;
    });

    const modal = ov.querySelector('.rb-modal');
    modal.classList.add('rb-has-preview');
    modal.style.width = 'min(1180px,100%)'; modal.style.height = 'min(90vh,960px)';
    const pane = document.createElement('div');
    pane.className = 'rb-wide';
    pane.innerHTML = `
      <div class="rb-pv-bar">
        <span class="rb-pv-meta">Widescreen 16:9 · ${theme==='dark'?'Dark':'Light'} · drag to place, drag a corner to resize</span>
        <span class="rb-pv-actions">
          <button class="rb-btn ghost rb-w-back">‹ Back</button>
          <button class="rb-btn ghost rb-w-add">+ Add tile</button>
          <button class="rb-btn ghost rb-w-reset">Reset layout</button>
          <button class="rb-btn ghost rb-w-batch">Print set…</button>
          <button class="rb-btn primary rb-w-render">Preview PDF →</button>
        </span>
      </div>
      <div class="rb-stage-wrap"><div class="rb-stage"></div></div>`;
    modal.appendChild(pane);
    const stage = pane.querySelector('.rb-stage');
    stage.style.background = theme === 'dark' ? '#0c2d3b' : '#ffffff';   // WYSIWYG page colour

    function place(c){
      c.box.style.left = (c.x*100)+'%'; c.box.style.top = (c.y*100)+'%'; c.box.style.width = (c.w*100)+'%';
      // height follows fixed aspect ratio
      const wpx = c.w * stage.clientWidth; c.box.style.height = (wpx * c.ar) + 'px';
      // scale the card DOM to the box width
      const s = wpx / CARD_W; c.el.style.transform = `scale(${s})`;
    }
    function makeBox(c){
      const box = document.createElement('div'); box.className='rb-cardbox'; c.box = box;
      const scaler = document.createElement('div'); scaler.className='rb-cardscale';
      c.el.style.transformOrigin='top left'; scaler.appendChild(c.el); box.appendChild(scaler);
      const grip = document.createElement('div'); grip.className='rb-cardgrip'; grip.title='Drag to resize'; box.appendChild(grip);
      const del = document.createElement('div'); del.className='rb-carddel'; del.title='Remove this tile'; del.textContent='✕'; box.appendChild(del);
      del.addEventListener('pointerdown', e => e.stopPropagation());
      del.addEventListener('click', e => { e.stopPropagation(); const i = cards.indexOf(c); if (i >= 0) cards.splice(i,1); box.remove(); });
      stage.appendChild(box); place(c);
      // drag move
      box.addEventListener('pointerdown', (e) => {
        if (e.target === grip) return;
        e.preventDefault(); box.setPointerCapture(e.pointerId); box.classList.add('drag');
        const r = stage.getBoundingClientRect(); const sx=e.clientX, sy=e.clientY, ox=c.x, oy=c.y;
        const mv = (ev) => { c.x = Math.max(0, Math.min(1-c.w, ox + (ev.clientX-sx)/r.width)); c.y = Math.max(0, Math.min(1, oy + (ev.clientY-sy)/r.height)); c.x=Math.round(c.x/0.005)*0.005; c.y=Math.round(c.y/0.005)*0.005; place(c); };
        const up = () => { box.classList.remove('drag'); box.releasePointerCapture(e.pointerId); box.removeEventListener('pointermove',mv); box.removeEventListener('pointerup',up); };
        box.addEventListener('pointermove',mv); box.addEventListener('pointerup',up);
      });
      // resize (width only; height follows AR)
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation(); grip.setPointerCapture(e.pointerId);
        const r = stage.getBoundingClientRect(); const sx=e.clientX, ow=c.w;
        const mv = (ev) => { c.w = Math.max(0.12, Math.min(1-c.x, ow + (ev.clientX-sx)/r.width)); place(c); };
        const up = () => { grip.releasePointerCapture(e.pointerId); grip.removeEventListener('pointermove',mv); grip.removeEventListener('pointerup',up); };
        grip.addEventListener('pointermove',mv); grip.addEventListener('pointerup',up);
      });
    }
    cards.forEach(makeBox);
    // reflow on resize
    const ro = new ResizeObserver(() => cards.forEach(place)); ro.observe(stage);

    pane.querySelector('.rb-w-back').addEventListener('click', () => { ro.disconnect(); stage_host.remove(); pane.remove(); modal.classList.remove('rb-has-preview'); modal.style.width=''; modal.style.height=''; });
    pane.querySelector('.rb-w-reset').addEventListener('click', () => {
      const colY2=new Array(cols).fill(gap); cards.forEach(c=>{const col=colY2.indexOf(Math.min(...colY2)); c.w=colW; c.x=gap+col*(colW+gap); c.y=colY2[col]; place(c); colY2[col]+=c.w*1.7778*c.ar+gap;});
    });
    pane.querySelector('.rb-w-render').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget; const orig = btn.textContent; btn.disabled=true; btn.textContent='Rendering…';
      try {
        const res = await renderWidePdf(ctx, cards, theme);
        showWidePreview(modal, res);
      } catch(e){ console.error(e); btn.textContent='Failed'; setTimeout(()=>{btn.textContent=orig;btn.disabled=false;},1500); return; }
      btn.disabled=false; btn.textContent=orig;
    });
    pane.querySelector('.rb-w-batch').addEventListener('click', () => {
      if (!ctx.batch || !ctx.batch.list || !ctx.batch.list.length){ return; }
      openBatchPicker(modal, ctx, cards, theme);
    });
    // + Add tile — build a fresh card and drop it top-left for the operator to place.
    async function addCard(blockId){
      const bdef = BLOCKS.find(b => b.id === blockId) || {};
      const opts = { box: blockId === 'avgDur', lastN: bdef.lastN || 8, comment: '' };
      const el = await buildCardDom(blockId, ctx, opts, theme);
      stage_host.appendChild(el);
      const imgs = [...el.querySelectorAll('img')];
      await Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(r => { im.onload = im.onerror = r; })));
      const ar = el.offsetHeight / el.offsetWidth || 1;
      const c = { id: blockId, opts, el, ar, w: 0.3, x: 0.03, y: 0.03 };
      cards.push(c); makeBox(c);
    }
    pane.querySelector('.rb-w-add').addEventListener('click', (e) => {
      pane.parentNode.querySelector('.rb-addmenu')?.remove();
      const menu = document.createElement('div'); menu.className = 'rb-addmenu';
      const avail = BLOCKS.filter(b => !b.soon && (b.needs !== 'pr' || ctx.hasPr));
      menu.innerHTML = avail.map(b => `<div class="rb-addmenu-item" data-id="${b.id}">${esc(b.label)}</div>`).join('');
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.left = Math.max(8, r.left) + 'px'; menu.style.top = (r.bottom + 4) + 'px';
      document.body.appendChild(menu);
      const close = () => { menu.remove(); document.removeEventListener('click', off, true); };
      const off = (ev) => { if (!menu.contains(ev.target) && ev.target !== e.currentTarget) close(); };
      setTimeout(() => document.addEventListener('click', off, true), 0);
      menu.querySelectorAll('.rb-addmenu-item').forEach(it => it.addEventListener('click', async () => { const id = it.dataset.id; close(); await addCard(id); }));
    });
  }

  // ctx for one material in a batch (same shape open() passes for a single one)
  function ctxForEntry(base, entry){
    return {
      json: base.json, m: entry.m, bucket: entry.bucket, hasPr: base.hasPr,
      analyst: base.analyst,
      traceFilters: (base.batch && base.batch.traceFiltersFor) ? base.batch.traceFiltersFor(entry.m.material) : {},
      assessmentName: base.assessmentName
    };
  }

  // "Print set" — pick which materials, then render the SAME arranged layout for
  // each onto its own landscape page.
  function openBatchPicker(modal, base, cards, theme){
    const list = base.batch.list;
    const pick = document.createElement('div');
    pick.className = 'rb-choice';
    pick.innerHTML = `
      <div class="rb-choice-card" style="width:min(560px,94%);max-height:82%;display:flex;flex-direction:column">
        <div class="rb-choice-h">Print this layout for a set of materials</div>
        <div class="rb-choice-b">Every selected material prints on its own landscape page using the layout you just arranged.</div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button class="rb-btn ghost rb-bp-all" style="padding:4px 10px">Select all</button>
          <button class="rb-btn ghost rb-bp-none" style="padding:4px 10px">None</button>
          <span class="rb-bp-count" style="margin-left:auto;align-self:center;font-size:12px;color:#9bb0b6"></span>
        </div>
        <div class="rb-bp-list" style="flex:1;overflow:auto;border:1px solid rgba(155,176,182,.25);border-radius:6px">
          ${list.map((e,i)=>`<label style="display:flex;gap:8px;align-items:center;padding:5px 9px;border-bottom:1px solid rgba(155,176,182,.12);font-size:12.5px;color:#dbe7e9"><input type="checkbox" class="rb-bp-chk" data-i="${i}" checked style="accent-color:#1FCED8"><b style="font-family:'JetBrains Mono',monospace">${esc(e.m.material)}</b><span style="color:#9bb0b6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.m.description||'')}</span></label>`).join('')}
        </div>
        <div class="rb-choice-a" style="margin-top:12px">
          <button class="rb-btn ghost rb-bp-cancel">Cancel</button>
          <button class="rb-btn primary rb-bp-go">Render pages →</button>
        </div>
      </div>`;
    modal.appendChild(pick);
    const chks = () => [...pick.querySelectorAll('.rb-bp-chk')];
    const countEl = pick.querySelector('.rb-bp-count');
    const upd = () => { countEl.textContent = chks().filter(c=>c.checked).length + ' of ' + list.length + ' selected'; };
    pick.addEventListener('change', upd); upd();
    pick.querySelector('.rb-bp-all').addEventListener('click', ()=>{ chks().forEach(c=>c.checked=true); upd(); });
    pick.querySelector('.rb-bp-none').addEventListener('click', ()=>{ chks().forEach(c=>c.checked=false); upd(); });
    pick.querySelector('.rb-bp-cancel').addEventListener('click', ()=> pick.remove());
    pick.querySelector('.rb-bp-go').addEventListener('click', async (ev) => {
      const idxs = chks().filter(c=>c.checked).map(c=>+c.dataset.i);
      if (!idxs.length) return;
      const btn = ev.currentTarget; btn.disabled = true;
      const entries = idxs.map(i => list[i]);
      try {
        for (let k=0;k<entries.length;k++){ btn.textContent = `Rendering ${k+1}/${entries.length}…`; }
        const res = await renderWidePdfBatch(base, cards, entries, theme, (k,n)=>{ btn.textContent = `Rendering ${k}/${n}…`; });
        pick.remove();
        showWidePreview(modal, res);
      } catch(e){ console.error(e); btn.textContent='Failed'; btn.disabled=false; }
    });
  }

  async function renderWidePdfBatch(base, cards, entries, theme, onProg){
    await ensureLibs(); await ensureH2C();
    const jsPDFCtor = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
    const g = geomFor('wide');
    const doc = new jsPDFCtor({ orientation:'landscape', unit:'mm', format:g.format, compress:true });
    const host = document.createElement('div'); host.style.cssText='position:fixed;left:-99999px;top:0;width:1400px;'; document.body.appendChild(host);
    try {
      for (let pi=0; pi<entries.length; pi++){
        if (onProg) onProg(pi+1, entries.length);
        if (pi>0) doc.addPage(g.format,'landscape');
        if (theme==='dark'){ doc.setFillColor(12,45,59); doc.rect(0,0,g.W,g.H,'F'); }
        const ectx = ctxForEntry(base, entries[pi]);
        for (const c of cards){
          const el = await buildCardDom(c.id, ectx, c.opts||{}, theme);
          host.appendChild(el);
          const imgs=[...el.querySelectorAll('img')];
          await Promise.all(imgs.map(im => im.complete ? Promise.resolve() : new Promise(r=>{im.onload=im.onerror=r;})));
          const cardH = el.offsetHeight || CARD_W;
          // box (mm) from the arranged template; contain-scale this material's card
          const bx=c.x*g.W, by=c.y*g.H, bw=c.w*g.W, bh=bw*c.ar;
          let sc = bw/CARD_W; if (cardH*sc > bh) sc = bh/cardH;
          const iw = CARD_W*sc, ih = cardH*sc;
          const canvas = await global.html2canvas(el, { scale:2, backgroundColor: theme==='dark'?'#0c2d3b':'#ffffff', logging:false });
          doc.addImage(canvas.toDataURL('image/jpeg',0.86), 'JPEG', bx, by, iw, ih);
          host.removeChild(el);
        }
      }
      const safe=(base.assessmentName||'assessment').replace(/[^A-Za-z0-9_-]+/g,'_');
      return { url: URL.createObjectURL(doc.output('blob')), filename:`Screener_Report_SET_${entries.length}_${safe}_wide.pdf`, pages:entries.length };
    } finally { host.remove(); }
  }

  async function renderWidePdf(ctx, cards, theme){
    await ensureLibs();
    const jsPDFCtor = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
    const g = geomFor('wide');
    const doc = new jsPDFCtor({ orientation:'landscape', unit:'mm', format:g.format, compress:true });
    // page background for dark theme
    if (theme === 'dark'){ doc.setFillColor(12,45,59); doc.rect(0,0,g.W,g.H,'F'); }
    for (const c of cards){
      const prevT = c.el.style.transform; c.el.style.transform = 'none';   // capture at natural resolution
      let img;
      try {
        const canvas = await global.html2canvas(c.el, { scale: 2, backgroundColor: theme==='dark' ? '#0c2d3b' : '#ffffff', logging:false });
        img = canvas.toDataURL('image/jpeg', 0.88);
      } finally { c.el.style.transform = prevT; }
      const x = c.x*g.W, y = c.y*g.H, w = c.w*g.W, h = w * c.ar;
      doc.addImage(img, 'JPEG', x, y, w, h);
    }
    const safe = (ctx.assessmentName||'assessment').replace(/[^A-Za-z0-9_-]+/g,'_');
    const filename = `Screener_Report_${ctx.m.material}_${safe}_wide.pdf`;
    return { url: URL.createObjectURL(doc.output('blob')), filename, pages:1 };
  }

  function showWidePreview(modal, res){
    const pv = document.createElement('div'); pv.className='rb-preview';
    pv.innerHTML = `<div class="rb-pv-bar"><span class="rb-pv-meta">Widescreen · ${res.pages} page${res.pages===1?'':'s'}</span><span class="rb-pv-actions"><button class="rb-btn ghost rb-pv-back">‹ Back to layout</button><button class="rb-btn ghost rb-pv-print">🖨 Print</button><a class="rb-btn primary rb-pv-dl" download="${esc(res.filename)}" href="${res.url}">⤓ Download PDF</a></span></div><iframe class="rb-pv-frame" title="Report preview" src="${res.url}"></iframe>`;
    modal.appendChild(pv);
    pv.querySelector('.rb-pv-back').addEventListener('click', ()=>{ pv.remove(); try{URL.revokeObjectURL(res.url);}catch(e){} });
    pv.querySelector('.rb-pv-print').addEventListener('click', ()=>{ try { pv.querySelector('.rb-pv-frame').contentWindow.print(); } catch(e){ window.open(res.url, '_blank'); } });
  }

  global.ReportBuilder = { open };

})(window);
