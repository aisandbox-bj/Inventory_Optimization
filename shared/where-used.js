/* ═══════════════════════════════════════════════════════════════════════════
   shared/where-used.js · APP-WU-01 (2026-06-27)
   ───────────────────────────────────────────────────────────────────────────
   "Where used" — where did a material's consumption actually go?
   Built entirely client-side from the canonical JSON the app already loads.

     · MB51 261 (work-order issue) / 262 (reversal) → net qty by WORK ORDER
       → IW39 (order → Sort Field) → Fleet Master (Sort Field → Model).
     · MB51 201 (cost-centre issue) / 202 (reversal) → a single "Cost centre (CC)"
       bucket (v1 — per-CC breakdown deferred; MB51 has no cost-centre column yet).
     · All-time, split into annual buckets (by posting year).
     · Explicit "Unmapped WO" bucket for orders with no IW39 match — never
       silently dropped (credibility principle).

   Availability: needs IW39 to resolve work orders → Sort Field. Model rollup
   needs Fleet Master; without it the table shows Sort Field directly.

   Public API:
     WhereUsed.compute(json, material) -> render-ready structure
     WhereUsed.renderPopup(data, material) -> HTML string
   No page-state coupling; no SCHEMA_VERSION change.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function num(v){ const x = Number(v); return Number.isFinite(x) ? x : 0; }
  function yearOf(d){ const s = String(d || '').slice(0, 4); return /^\d{4}$/.test(s) ? s : null; }
  function fmt(n){ return n == null ? '—' : Math.round(n).toLocaleString(); }

  function compute(json, material){
    const data  = (json && json.data) || {};
    const mb51  = data.mb51 || [];
    const iw39  = data.iw39 || [];
    const fleet = data.fleetMaster || [];
    const hasIw39  = iw39.length  > 0;
    const hasFleet = fleet.length > 0;

    const orderToSF = new Map();
    for (const o of iw39){
      const ord = String(o.order || '').trim();
      const sf  = String(o.sortField || '').trim();
      if (ord && sf && !orderToSF.has(ord)) orderToSF.set(ord, sf);
    }
    const sfToModel = new Map();
    for (const u of fleet){
      const sf = String(u.sortField || '').trim();
      const m  = String(u.model || '').trim();
      if (sf && m && !sfToModel.has(sf)) sfToModel.set(sf, m);
    }

    const rows = mb51.filter(r => String(r.material || '').trim() === String(material).trim());
    const years = new Set();
    const woMap = new Map();                       // model||sortField → { model, sortField, byYear, total }
    const cc          = { byYear: {}, total: 0 };  // 201/202
    const unmappedWO  = { byYear: {}, total: 0 };  // 261/262 order not in IW39

    for (const r of rows){
      const mvt = String(r.movementType || '').trim();
      let kind;
      if      (mvt === '261' || mvt === '262') kind = 'wo';
      else if (mvt === '201' || mvt === '202') kind = 'cc';
      else continue;
      const yr = yearOf(r.postingDate);
      if (!yr) continue;
      years.add(yr);
      // MB51 issue quantities are negative (stock out) and reversals positive, so
      // negating makes consumption read positive AND nets reversals out
      // automatically (261−262, 201−202).
      const val = -num(r.quantity);

      if (kind === 'cc'){
        cc.byYear[yr] = (cc.byYear[yr] || 0) + val; cc.total += val;
        continue;
      }
      const ord = String(r.order || '').trim();
      const sf  = ord ? orderToSF.get(ord) : null;
      if (!sf){
        unmappedWO.byYear[yr] = (unmappedWO.byYear[yr] || 0) + val; unmappedWO.total += val;
        continue;
      }
      const model = hasFleet ? (sfToModel.get(sf) || '(unmapped model)') : null;
      const key   = (model || '') + '||' + sf;
      let e = woMap.get(key);
      if (!e){ e = { model, sortField: sf, byYear: {}, total: 0 }; woMap.set(key, e); }
      e.byYear[yr] = (e.byYear[yr] || 0) + val; e.total += val;
    }

    const yearList   = [...years].sort();
    const woEntries  = [...woMap.values()];
    let grandByYear  = {};
    yearList.forEach(y => {
      let s = 0;
      woEntries.forEach(e => s += (e.byYear[y] || 0));
      s += (cc.byYear[y] || 0) + (unmappedWO.byYear[y] || 0);
      grandByYear[y] = s;
    });
    const grandTotal = woEntries.reduce((s, e) => s + e.total, 0) + cc.total + unmappedWO.total;

    return { available: hasIw39, hasFleet, years: yearList, woEntries, cc, unmappedWO, grandByYear, grandTotal };
  }

  function yearCells(byYear, years){
    return years.map(y => `<td class="num">${byYear[y] ? fmt(byYear[y]) : '·'}</td>`).join('');
  }

  // APP-WU-02 — like yearCells, but each non-empty destination×year cell is a
  // clickable drill target carrying its selection (sortField / model / bucket
  // + year). Empty cells stay inert.
  function yearCellsSel(byYear, years, sel){
    return years.map(y => {
      const v = byYear[y];
      if (!v) return `<td class="num">·</td>`;
      const attrs = Object.entries(Object.assign({}, sel, { year: y }))
        .map(([k, val]) => ` data-wu-${k}="${esc(val)}"`).join('');
      return `<td class="num wu-cell"${attrs} title="Click to list the work orders behind this number">${fmt(v)}</td>`;
    }).join('');
  }

  function renderPopup(data, material){
    if (!data || !data.available){
      return `<div class="wu-empty">Load <b>IW39</b> (work orders) to see where this material is used — it resolves each work-order issue to its Sort Field. Add <b>Fleet Master</b> for a model rollup.</div>`;
    }
    const years = data.years;
    if (!years.length){
      return `<div class="wu-empty">No work-order (261) or cost-centre (201) consumption recorded for ${esc(material)}.</div>`;
    }
    const yhead = years.map(y => `<th class="num">${esc(y)}</th>`).join('');
    let body = '';

    if (data.hasFleet){
      const byModel = new Map();
      for (const e of data.woEntries){
        const m = e.model || '(unmapped model)';
        if (!byModel.has(m)) byModel.set(m, []);
        byModel.get(m).push(e);
      }
      const models = [...byModel.entries()].map(([m, list]) => {
        const byYear = {}; let total = 0;
        list.forEach(e => { Object.entries(e.byYear).forEach(([y, v]) => byYear[y] = (byYear[y] || 0) + v); total += e.total; });
        return { model: m, list: list.sort((a, b) => b.total - a.total), byYear, total };
      }).sort((a, b) => b.total - a.total);
      for (const mg of models){
        body += `<tr class="wu-model"><td>${esc(mg.model)}</td>${yearCellsSel(mg.byYear, years, { model: mg.model })}<td class="num">${fmt(mg.total)}</td></tr>`;
        for (const e of mg.list){
          body += `<tr class="wu-sf"><td><span class="wu-ind">↳</span>${esc(e.sortField)}</td>${yearCellsSel(e.byYear, years, { sf: e.sortField })}<td class="num">${fmt(e.total)}</td></tr>`;
        }
      }
    } else {
      for (const e of data.woEntries.slice().sort((a, b) => b.total - a.total)){
        body += `<tr class="wu-sf"><td>${esc(e.sortField)}</td>${yearCellsSel(e.byYear, years, { sf: e.sortField })}<td class="num">${fmt(e.total)}</td></tr>`;
      }
    }
    if (data.unmappedWO.total){
      body += `<tr class="wu-unmapped"><td title="Work orders with no match in IW39 — can't resolve a Sort Field">Unmapped WO</td>${yearCellsSel(data.unmappedWO.byYear, years, { bucket: 'unmapped' })}<td class="num">${fmt(data.unmappedWO.total)}</td></tr>`;
    }
    if (data.cc.total){
      body += `<tr class="wu-cc"><td title="Goods issued to a cost centre (mvt 201, net of 202). Per-cost-centre breakdown not yet available.">Cost centre (CC)</td>${yearCellsSel(data.cc.byYear, years, { bucket: 'cc' })}<td class="num">${fmt(data.cc.total)}</td></tr>`;
    }
    if (!body){
      return `<div class="wu-empty">No work-order (261) or cost-centre (201) consumption recorded for ${esc(material)}.</div>`;
    }
    const grand = `<tr class="wu-grand"><td>Total</td>${yearCells(data.grandByYear, years)}<td class="num">${fmt(data.grandTotal)}</td></tr>`;
    const fleetNote = data.hasFleet ? '' : `<div class="wu-note">Fleet Master not loaded — showing Sort Field only (no model rollup).</div>`;
    return `<div class="wu-panel">
      <div class="wu-h">Where used — net consumption by destination</div>
      <div class="wu-hint">Click any yearly number to list the work orders behind it.</div>
      ${fleetNote}
      <table class="wu-tbl">
        <thead><tr><th>Destination</th>${yhead}<th class="num">Total</th></tr></thead>
        <tbody>${body}${grand}</tbody>
      </table>
      <div class="wu-cav">Net of reversals (261−262 work-order issues · 201−202 cost-centre). Destinations from IW39 Sort Field${data.hasFleet ? ' → Fleet model' : ''}; all-time, bucketed by posting year.</div>
    </div>`;
  }

  /* ───────────────────────────────────────────────────────────────────────
     APP-WU-02 — drill: the work orders behind one destination×year cell.
     Re-derives from MB51 (it does NOT read the compute() output), grouping by
     work order (or, for the cost-centre bucket, by posting month), keeping the
     SAME net-of-reversal semantics as the table so the rows tie out to the
     clicked number. Joins IW39 for the work-order description.

       sel = { year, sortField }            — one Sort Field (Unit)
           | { year, model }                — all Sort Fields under a model
           | { year, bucket:'unmapped' }    — 261/262 orders with no IW39 match
           | { year, bucket:'cc' }          — 201/202 cost-centre issues
  ─────────────────────────────────────────────────────────────────────────── */
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function ymOf(d){
    const s = String(d || '');
    const y = s.slice(0, 4);
    if (!/^\d{4}$/.test(y)) return null;
    const mm = s.slice(5, 7);
    const mi = parseInt(mm, 10);
    const mlabel = (mi >= 1 && mi <= 12) ? MONTHS[mi - 1] : '??';
    return { y, sortKey: y + (/^\d{2}$/.test(mm) ? mm : '00'), label: y + '-' + mlabel };
  }
  function dateLabelFor(months){
    const arr = [...months.values()].sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
    if (!arr.length) return '—';
    return arr.length === 1 ? arr[0].label : `${arr[0].label} → ${arr[arr.length - 1].label}`;
  }

  function drill(json, material, sel){
    const data  = (json && json.data) || {};
    const mb51  = data.mb51 || [];
    const iw39  = data.iw39 || [];
    const fleet = data.fleetMaster || [];
    const hasFleet = fleet.length > 0;

    const orderToSF = new Map();
    const orderToDesc = new Map();
    for (const o of iw39){
      const ord = String(o.order || '').trim();
      if (!ord) continue;
      if (!orderToSF.has(ord))   orderToSF.set(ord, String(o.sortField || '').trim());
      if (!orderToDesc.has(ord)) orderToDesc.set(ord, String(o.description || '').trim());
    }
    const sfToModel = new Map();
    for (const u of fleet){
      const sf = String(u.sortField || '').trim();
      const m  = String(u.model || '').trim();
      if (sf && m && !sfToModel.has(sf)) sfToModel.set(sf, m);
    }
    const modelOf = sf => hasFleet ? (sfToModel.get(sf) || '(unmapped model)') : null;

    const year   = sel.year != null ? String(sel.year) : null;
    const bucket = sel.bucket || null;          // 'cc' | 'unmapped' | null
    const isCC   = bucket === 'cc';
    const rows   = mb51.filter(r => String(r.material || '').trim() === String(material).trim());

    const groups = new Map();   // key → { fleet, unit, order, desc, months:Map, qty }
    let total = 0;

    for (const r of rows){
      const mvt = String(r.movementType || '').trim();
      const isWO = (mvt === '261' || mvt === '262');
      const isCc = (mvt === '201' || mvt === '202');
      if (isCC ? !isCc : !isWO) continue;
      const ym = ymOf(r.postingDate);
      if (!ym || (year && ym.y !== year)) continue;
      const val = -num(r.quantity);   // issues negative → consumption positive, nets reversals

      let key, fleetLab, unitLab, orderLab, descLab;
      if (isCC){
        key = 'm:' + ym.sortKey;            // group cost-centre issues by month
        fleetLab = 'Cost centre'; unitLab = '—'; orderLab = '—'; descLab = 'Cost-centre issue (mvt 201/202)';
      } else {
        const ord = String(r.order || '').trim();
        const sf  = ord ? orderToSF.get(ord) : '';
        // selection filter
        if (bucket === 'unmapped'){
          if (sf) continue;                 // only orders with NO Sort Field
          fleetLab = '—'; unitLab = '—'; descLab = '(no IW39 match)';
        } else if (sel.sortField != null){
          if (sf !== sel.sortField) continue;
          fleetLab = modelOf(sf) || '—'; unitLab = sf; descLab = orderToDesc.get(ord) || '(no description)';
        } else if (sel.model != null){
          if (!sf || modelOf(sf) !== sel.model) continue;
          fleetLab = sel.model; unitLab = sf; descLab = orderToDesc.get(ord) || '(no description)';
        } else {
          continue;
        }
        key = 'o:' + ord; orderLab = ord || '—';
      }

      let g = groups.get(key);
      if (!g){ g = { fleet: fleetLab, unit: unitLab, order: orderLab, desc: descLab, months: new Map(), qty: 0 }; groups.set(key, g); }
      g.months.set(ym.sortKey, ym);
      g.qty += val;
      total += val;
    }

    const out = [...groups.values()].map(g => ({
      fleet: g.fleet, unit: g.unit, order: g.order, desc: g.desc,
      dateLabel: dateLabelFor(g.months), qty: g.qty
    })).sort((a, b) => b.qty - a.qty);

    let label;
    if (isCC)                    label = 'Cost centre (CC)';
    else if (bucket === 'unmapped') label = 'Unmapped WO';
    else if (sel.model != null)  label = sel.model;
    else if (sel.sortField != null){
      const m = modelOf(sel.sortField);
      label = (m && m !== '(unmapped model)') ? `${m} · ${sel.sortField}` : sel.sortField;
    } else label = '';

    return { rows: out, total, ctx: { year, label } };
  }

  function renderDrill(d, material){
    const back = `<button type="button" class="wu-back" id="wuBack">‹ Back to where-used</button>`;
    const head = `<div class="wu-drill-h">${esc(d.ctx.label)} · ${esc(d.ctx.year)} <span class="wu-drill-sub">— work orders for ${esc(material)}</span></div>`;
    if (!d.rows.length){
      return `<div class="wu-drill">${back}${head}<div class="wu-empty">No underlying movements found for this destination and year.</div></div>`;
    }
    const body = d.rows.map(r => `<tr>
        <td>${esc(r.fleet)}</td>
        <td>${esc(r.unit)}</td>
        <td class="wu-nowrap">${esc(r.dateLabel)}</td>
        <td>${esc(r.order)}</td>
        <td class="wu-desc">${esc(r.desc)}</td>
        <td class="num">${fmt(r.qty)}</td>
      </tr>`).join('');
    const grand = `<tr class="wu-grand"><td colspan="5">Total</td><td class="num">${fmt(d.total)}</td></tr>`;
    return `<div class="wu-drill">
      ${back}
      ${head}
      <table class="wu-tbl wu-drill-tbl">
        <thead><tr><th>Fleet</th><th>Unit</th><th>Date</th><th>WO#</th><th>WO description</th><th class="num">Qty</th></tr></thead>
        <tbody>${body}${grand}</tbody>
      </table>
      <div class="wu-cav">Net of reversals (261−262 · 201−202). Date is the MB51 posting month (year ${esc(d.ctx.year)}); description from IW39. Rows sum to the number you clicked.</div>
    </div>`;
  }

  window.WhereUsed = { compute, renderPopup, drill, renderDrill };
})();
