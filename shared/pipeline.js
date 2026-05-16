/* ═══════════════════════════════════════════════════════════════════════════
   Pipeline — analytical core for the Analysis engine.
   Port of scripts/02_extract_model.py, 03_build_charts.py, 04_mrp_analysis.py.
   Rule semantics preserved line-for-line; deterministic, no inference.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Movement types ────────────────────────────────────────────────────── */
  const ISSUE_TYPES  = new Set(['261', '201']);   // goods issue
  const RETURN_TYPES = new Set(['262', '202']);   // returns
  const VALID_TYPES  = new Set([...ISSUE_TYPES, ...RETURN_TYPES]);

  /* ─── Date helpers ──────────────────────────────────────────────────────── */
  function toDate(s){ if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  function inRange(d, start, end){ const dd = toDate(d); if (!dd) return false; const ds = toDate(start), de = toDate(end); return ds && de && dd >= ds && dd <= de; }
  function addMonths(iso, months){
    const d = toDate(iso);
    if (!d) return null;
    const r = new Date(d.getTime());
    r.setMonth(r.getMonth() + months);
    return r.toISOString().slice(0, 10);
  }
  function monthsBetween(a, b){
    const da = toDate(a), db = toDate(b);
    if (!da || !db) return 0;
    return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
  }

  /* ─── Group-by helper ───────────────────────────────────────────────────── */
  function groupBy(rows, keyFn){
    const out = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return out;
  }

  /* ─── Net consumption per material from a transaction set ───────────────── */
  /**
   * Net = sum(quantity of issues) − sum(quantity of returns), per material.
   * Returns Map material → { net, tx261, qty261 (gross), description }.
   */
  function netConsumptionByMaterial(transactions, materialDescIndex){
    const agg = new Map();
    for (const r of transactions) {
      const m = String(r.material || '').trim();
      if (!m) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);

      const cur = agg.get(m) || { net: 0, qty261: 0, tx261: 0, qty262: 0 };
      if (ISSUE_TYPES.has(mt))   { cur.net += q; cur.qty261 += q; if (mt === '261') cur.tx261++; }
      if (RETURN_TYPES.has(mt))  { cur.net -= q; cur.qty262 += q; }
      agg.set(m, cur);
    }
    // Attach description (first non-null seen) from the index if available
    if (materialDescIndex) {
      for (const [m, v] of agg) v.description = materialDescIndex.get(m) || '';
    }
    return agg;
  }

  function buildMaterialDescIndex(mb51){
    const idx = new Map();
    for (const r of mb51) {
      const m = String(r.material || '').trim();
      if (!m || idx.has(m)) continue;
      const d = String(r.description || '').trim();
      if (d) idx.set(m, d);
    }
    return idx;
  }

  /* ─── Period rate (port of calc_rate from 03_build_charts.py) ───────────── */
  /**
   * net = |sum issues in [start,end]| − |sum returns in [start,end]|
   * rate = net / months
   * flag: 'OK' | 'NO_DATA' (no rows in window) | 'NEGATIVE_NET'
   *
   * `excludeDates` (optional) is a Set<string> of postingDate values to skip
   * — used to drop confirmed inventory-adjustment days from the rate. The
   * row is still counted toward `rows` so we don't mis-flag NO_DATA.
   */
  function calcPeriodRate(transactions, start, end, months, excludeDates){
    let issues = 0, returns = 0, rows = 0;
    const xd = (excludeDates instanceof Set) ? excludeDates : null;
    for (const r of transactions) {
      if (!inRange(r.postingDate, start, end)) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      rows++;
      if (xd && xd.has(r.postingDate)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      if (ISSUE_TYPES.has(mt))   issues  += q;
      if (RETURN_TYPES.has(mt))  returns += q;
    }
    if (rows === 0) return { rate: 0, flag: 'NO_DATA' };
    const net = issues - returns;
    if (net < 0)   return { rate: 0, flag: 'NEGATIVE_NET' };
    return { rate: net / months, flag: 'OK' };
  }

  /* ─── Inventory-adjustment day detector ────────────────────────────────────
     Groups MB51 issue rows by postingDate, computes the daily-count mean +
     stddev, and returns dates with count ≥ mean + N·σ as candidates.
     The user confirms which dates are real cycle-count / adjustment days;
     confirmed dates' transactions are then excluded from rate calculations
     (same mechanic as HCE, labelled 'Inv Adj'). */
  function detectInvAdjCandidates(mb51, params){
    const sigmaN = (params && params.invAdjSigmaThreshold) || 5;
    const dailyMap = new Map();   // date → { date, count, materials:Set, totalQty }
    for (const r of (mb51 || [])) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;          // adjustments post as issues (typically 201)
      const d = r.postingDate;
      if (!d) continue;
      const e = dailyMap.get(d) || { date: d, count: 0, materials: new Set(), totalQty: 0 };
      e.count++;
      const m = String(r.material || '').trim();
      if (m) e.materials.add(m);
      e.totalQty += Math.abs(parseFloat(r.quantity) || 0);
      dailyMap.set(d, e);
    }
    const days = [...dailyMap.values()];
    if (days.length < 3) {
      return { sigmaN, mean: 0, stddev: 0, threshold: 0, dayCount: days.length, candidates: [] };
    }
    const counts = days.map(d => d.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + sigmaN * stddev;
    const candidates = days
      .filter(d => stddev > 0 && d.count > threshold)
      .map(d => {
        const dow = new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' });
        return {
          date:              d.date,
          dayOfWeek:         dow,
          count:             d.count,
          sigmaAbove:        stddev > 0 ? Math.round((d.count - mean) / stddev * 10) / 10 : 0,
          materialsAffected: d.materials.size,
          totalQty:          Math.round(d.totalQty * 10) / 10
        };
      })
      .sort((a, b) => b.count - a.count);
    return {
      sigmaN,
      mean:      Math.round(mean * 10) / 10,
      stddev:    Math.round(stddev * 10) / 10,
      threshold: Math.round(threshold * 10) / 10,
      dayCount:  days.length,
      candidates
    };
  }

  /* ─── Per-material Inv Adj events from confirmed dates ────────────────────
     For a material's transactions, gather any rows that fall on a confirmed
     adjustment date. Returns an array shaped like the HCE event array so the
     downstream UI / Excel can render them with the same shape. */
  function buildInvAdjEvents(transactions, confirmedDates){
    if (!Array.isArray(confirmedDates) || confirmedDates.length === 0) return [];
    const set = new Set(confirmedDates);
    const byDate = new Map();
    for (const r of transactions) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;
      const d = r.postingDate;
      if (!d || !set.has(d)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const e = byDate.get(d) || { date: d, qty: 0, orders: new Set(), nRows: 0 };
      e.qty   += q;
      e.nRows += 1;
      const o = String(r.order || '').trim();
      if (o) e.orders.add(o);
      byDate.set(d, e);
    }
    return [...byDate.values()].map(e => ({
      kind:      'INV_ADJ',
      period:    'INV_ADJ',
      date:      e.date,
      order:     e.orders.size === 1 ? [...e.orders][0] : `(${e.orders.size} orders)`,
      equipment: '— Inv Adj —',
      description: 'Inventory adjustment / cycle count',
      qty:       Math.round(e.qty * 10) / 10,
      pct:       null,
      reasons:   `Confirmed inventory-adjustment date (${e.nRows} rows, ${e.orders.size || 0} orders)`
    })).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /* ─── HCE detection (port of detect_hce) ────────────────────────────────── */
  /**
   * Flag a WO as a High Consumption Event in a period if either:
   *   A) qty ≥ hcePctThreshold (fraction, e.g. 0.50) × period total
   *   B) qty ≥ hceMultThreshold × avg WO qty  (only when n_orders > 1)
   * Uses ISSUE rows only (261, 201) — returns are not events.
   * Returns array sorted by qty desc.
   */
  function detectHce(transactions, pStart, pEnd, periodLabel, params){
    const pctThresh  = params.hcePctThreshold;
    const multThresh = params.hceMultThreshold;

    const issueRows = transactions.filter(r => {
      if (!inRange(r.postingDate, pStart, pEnd)) return false;
      return ISSUE_TYPES.has(String(r.movementType || '').trim());
    });
    if (issueRows.length === 0) return [];

    // Aggregate per Order
    const byOrder = new Map();
    for (const r of issueRows) {
      const o = String(r.order || '').trim() || '(no order)';
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const cur = byOrder.get(o) || { order: o, qty: 0, firstDate: r.postingDate, equipment: r.equipmentUnit || r.sortField || '—', description: r.woDescription || r.description || '' };
      cur.qty += q;
      if (r.postingDate < cur.firstDate) cur.firstDate = r.postingDate;
      if (!cur.equipment || cur.equipment === '—') cur.equipment = r.equipmentUnit || r.sortField || cur.equipment;
      byOrder.set(o, cur);
    }
    const woAgg = [...byOrder.values()];
    const totalQty = woAgg.reduce((a, w) => a + w.qty, 0);
    if (totalQty === 0) return [];
    const nOrders  = woAgg.length;
    const avgQty   = totalQty / nOrders;

    const out = [];
    for (const w of woAgg) {
      const pctFrac = w.qty / totalQty;
      const critA = pctFrac >= pctThresh;
      const critB = nOrders > 1 && w.qty >= multThresh * avgQty;
      if (!critA && !critB) continue;
      const reasons = [];
      if (critA) reasons.push(`${Math.round(pctFrac * 100)}% of period total`);
      if (critB) reasons.push(`${(w.qty / avgQty).toFixed(1)}× avg WO qty`);
      out.push({
        period:    periodLabel,
        order:     w.order,
        date:      w.firstDate,
        equipment: w.equipment,
        description: w.description || '',
        qty:       Math.round(w.qty),
        pct:       Math.round(pctFrac * 1000) / 10,
        reasons:   reasons.join(' | '),
        totalQty:  Math.round(totalQty),
        nOrders,
        avgQty:    Math.round(avgQty * 10) / 10
      });
    }
    out.sort((a, b) => b.qty - a.qty);
    return out;
  }

  /* ─── Adjusted P2 rate (HCE-excluded) ───────────────────────────────────── */
  function calcAdjustedP2Rate(transactions, p2s, p2e, hceOrders, p2Months){
    const excluded = new Set(hceOrders);
    const filtered = transactions.filter(r => !excluded.has(String(r.order || '').trim()));
    return calcPeriodRate(filtered, p2s, p2e, p2Months);
  }

  /* ─── Lumpy/Smooth classification (port of SKILL.md rule) ───────────────── */
  /**
   * is_lumpy = top1_pct >= lumpyTopWoThreshold
   *           OR cv > lumpyCvThreshold
   *           OR (wo_count <= 3 AND total_qty >= threshold)
   * Operates on the full analysis window's issue rows.
   */
  function classifyPattern(transactions, params){
    const issueRows = transactions.filter(r => ISSUE_TYPES.has(String(r.movementType || '').trim()));
    if (issueRows.length === 0) return 'SMOOTH';
    const byOrder = new Map();
    for (const r of issueRows) {
      const o = String(r.order || '').trim() || `__row_${Math.random()}`;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      byOrder.set(o, (byOrder.get(o) || 0) + q);
    }
    const qtys = [...byOrder.values()];
    const total = qtys.reduce((a, b) => a + b, 0);
    if (total === 0) return 'SMOOTH';
    const max  = Math.max(...qtys);
    const mean = total / qtys.length;
    const variance = qtys.reduce((a, q) => a + (q - mean) ** 2, 0) / qtys.length;
    const sd   = Math.sqrt(variance);
    const cv   = mean > 0 ? sd / mean : 0;
    const top1 = max / total;
    const woCount = qtys.length;

    const isLumpy =
      (top1 >= params.lumpyTopWoThreshold) ||
      (cv > params.lumpyCvThreshold) ||
      (woCount <= 3 && total >= params.threshold);
    return isLumpy ? 'LUMPY' : 'SMOOTH';
  }

  /* ─── Cumulative consumption series ─────────────────────────────────────── */
  /**
   * Returns array of { date: ISO, delta, cum } sorted by date asc.
   * delta = +qty for issues, −qty for returns.
   */
  function cumulativeSeries(transactions){
    const byDate = new Map();
    for (const r of transactions) {
      const d = r.postingDate;
      if (!d) continue;
      const mt = String(r.movementType || '').trim();
      if (!VALID_TYPES.has(mt)) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      const delta = ISSUE_TYPES.has(mt) ? q : -q;
      byDate.set(d, (byDate.get(d) || 0) + delta);
    }
    const sorted = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const out = [];
    let cum = 0;
    for (const [d, delta] of sorted) {
      cum += delta;
      out.push({ date: d, delta, cum });
    }
    return out;
  }

  /* ─── Traffic-light decision (port of assess() in 04_mrp_analysis.py) ───── */
  /**
   * Rules in priority order:
   *  1. p2Flag != OK or p2Rate == 0           → GREY   ("no recent consumption")
   *  2. mrpType == "NOT IN MASTER"             → GREY   ("excluded")
   *  3. recMin is null                         → GREY   ("not calculable")
   *  4. PD AND stock-runway > 12 mo            → PURPLE ("likely Working Redundant")     ← v1.1.0
   *  5. PD AND stock-runway > 6 mo             → PURPLE ("possible Working Redundant")   ← v1.1.0
   *  6. mrp=PD AND total ≥ threshold           → RED    ("change to V1")
   *  7. mrp=V1 AND rec=current                 → GREEN  ("no action")
   *  8. mrp=V1 AND ALL rec < current           → BLUE   ("lower, safe")
   *  9. mrp=V1 AND any rec > current           → ORANGE ("raise, insufficient")
   * 10. else                                   → GREY   ("manual review")
   *
   * Then a FEW-EVENTS overlay: if the material had ≤ 2 issuing work orders
   * over the full analysis window AND the primary code was GREEN/BLUE, the
   * outcome is upgraded to ORANGE with a "few events" rationale. RED, GREY,
   * and PURPLE keep their priority (they're already review-priority).
   */
  function assess(mrpType, total, threshold, p2r, p2f, cmin, cmax, rmin, rmax, stock, woCount, params){
    // ── GREY gates ───────────────────────────────────────────────────────
    if (p2f !== 'OK' || p2r === 0) {
      return finalise({ code:'GREY', action:'Refer for manual review — no recent (P2) consumption', recMin:null, recMax:null }, woCount);
    }
    if (String(mrpType || '').trim() === 'NOT IN MASTER') {
      return finalise({ code:'GREY', action:'Not in Inventory Master — excluded', recMin:null, recMax:null }, woCount);
    }
    if (rmin == null) {
      return finalise({ code:'GREY', action:'Recommended Min/Max not calculable', recMin:null, recMax:null }, woCount);
    }
    const mt = String(mrpType || '').trim().toUpperCase();

    // ── PURPLE — Working Redundant check (configurable thresholds, v2.0.1) ─
    // Runway = months of cover at the P2 rate. Items on a watched MRP type
    // (default PD) with a surplus runway indicate the Min/Max are mis-sized
    // or the item shouldn't be stocked at this level. V1 is consumption-driven
    // and self-corrects; not in the default watch-list.
    const wrSoft  = (params && typeof params.wrSoftMonths === 'number') ? params.wrSoftMonths : 6;
    const wrHard  = (params && typeof params.wrHardMonths === 'number') ? params.wrHardMonths : 9;
    const wrTypes = (params && Array.isArray(params.wrMrpTypes) && params.wrMrpTypes.length)
                    ? params.wrMrpTypes.map(s => String(s || '').trim().toUpperCase()).filter(Boolean)
                    : ['PD'];

    if (wrTypes.includes(mt) && typeof stock === 'number' && stock > 0 && p2r > 0) {
      const runway = stock / p2r;
      if (runway > wrHard) {
        return finalise({
          code:'PURPLE',
          action:`Likely Working Redundant — ${runway.toFixed(1)} months of stock at P2 rate (>${wrHard}mo with ${mt}). Review for destocking / write-down.`,
          recMin: rmin, recMax: rmax
        }, woCount);
      }
      if (runway > wrSoft) {
        return finalise({
          code:'PURPLE',
          action:`Possible Working Redundant — ${runway.toFixed(1)} months of stock at P2 rate (>${wrSoft}mo with ${mt}). Review stocking necessity.`,
          recMin: rmin, recMax: rmax
        }, woCount);
      }
    }

    // ── Standard MRP-type rules ──────────────────────────────────────────
    if (mt === 'PD' && total >= threshold) {
      return finalise({ code:'RED', action:`Change MRP type to V1. Set Min=${rmin}, Max=${rmax}`, recMin:rmin, recMax:rmax }, woCount);
    }
    if (mt === 'V1') {
      const minOk = cmin != null && Math.round(parseFloat(cmin)) === rmin;
      const maxOk = cmax != null && Math.round(parseFloat(cmax)) === rmax;
      if (minOk && maxOk) {
        return finalise({ code:'GREEN', action:'No action required — MRP type and parameters correct', recMin:rmin, recMax:rmax }, woCount);
      }
      const parts = [];
      const dirs  = [];
      if (!minOk) {
        const cur = cmin != null ? Math.round(parseFloat(cmin)) : null;
        parts.push(`Min: current=${cur != null ? cur : 'blank'}, rec=${rmin}`);
        if (cur != null) dirs.push(rmin < cur ? 'down' : 'up');
      }
      if (!maxOk) {
        const cur = cmax != null ? Math.round(parseFloat(cmax)) : null;
        parts.push(`Max: current=${cur != null ? cur : 'blank'}, rec=${rmax}`);
        if (cur != null) dirs.push(rmax < cur ? 'down' : 'up');
      }
      if (dirs.length && dirs.every(d => d === 'down')) {
        return finalise({ code:'BLUE', action:`Lower Min/Max (low risk). ${parts.join('; ')}`, recMin:rmin, recMax:rmax }, woCount);
      }
      return finalise({ code:'ORANGE', action:`Increase Min/Max (insufficient). ${parts.join('; ')}`, recMin:rmin, recMax:rmax }, woCount);
    }
    return finalise({ code:'GREY', action:`${mrpType} not assessed — manual review`, recMin:null, recMax:null }, woCount);
  }

  /**
   * Few-events overlay: a material with ≤ 2 issuing work orders in the
   * analysis window has an unreliable rate (statistical noise dominates).
   * Override GREEN / BLUE to ORANGE so the planner reviews the pattern
   * manually before accepting the recommendation. RED / GREY / PURPLE
   * stay — they're already review-priority states.
   */
  function finalise(tl, woCount){
    if (woCount != null && woCount <= 2 && (tl.code === 'GREEN' || tl.code === 'BLUE')) {
      return {
        code:'ORANGE',
        action:`Only ${woCount} consumption event${woCount === 1 ? '' : 's'} over the analysis window — pattern unreliable, manual review of rate + Min/Max recommended. (Original: ${tl.code} — ${tl.action})`,
        recMin: tl.recMin,
        recMax: tl.recMax,
        fewEvents: true
      };
    }
    return tl;
  }

  /* ─── Count distinct issue work orders for a material's transactions ─── */
  function countIssueWorkOrders(transactions){
    const orders = new Set();
    for (const r of transactions) {
      const mt = String(r.movementType || '').trim();
      if (!ISSUE_TYPES.has(mt)) continue;
      const o = String(r.order || '').trim();
      if (o) orders.add(o);
    }
    return orders.size;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     BUCKET BUILDING
     Builds analysis buckets from canonical JSON based on scope mode.
     Returns array of { key, name, materials: Set<string>, transactions: [...] }.
  ═════════════════════════════════════════════════════════════════════════ */
  function buildBuckets(json){
    const mode    = json.scope.mode;
    const mb51    = json.data.mb51 || [];
    const iw39    = json.data.iw39 || [];
    const fleet   = json.data.fleetMaster || [];
    const master  = json.data.inventoryMaster || [];
    const vendors = json.data.materialVendor || [];

    if (mode === 'fleet') return bucketsFleet(json, mb51, iw39, fleet);
    if (mode === 'manual') return bucketsManual(json, mb51);
    if (mode === 'byClassification') return bucketsByClassification(json, mb51, master);
    if (mode === 'byVendor') return bucketsByVendor(json, mb51, vendors);
    if (mode === 'parameterSearch') return bucketsParameterSearch(json, mb51);
    return [];
  }

  /* ─── Parameter Search bucketing ────────────────────────────────────────────
     The intake page resolves filters → list of materials. The pipeline simply
     uses that resolved list — same shape as 'manual'. */
  function bucketsParameterSearch(json, mb51){
    const ps   = (json.scope && json.scope.parameterSearch) || {};
    const mats = new Set(ps.resolvedMaterials || []);
    const transactions = mb51.filter(t => {
      const m = String(t.material || '').trim();
      if (!mats.has(m)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    return [{
      key: 'paramSearch',
      name: `Parameter search · ${mats.size} mat${mats.size === 1 ? '' : 's'}`,
      kind: 'parameterSearch',
      materials: mats,
      transactions
    }];
  }

  /* ─── Fleet bucketing + multi-model detection ───────────────────────────── */
  function bucketsFleet(json, mb51, iw39, fleet){
    const runDate = new Date().toISOString().slice(0, 10);
    const threshold = json.parameters.threshold;
    const models = (json.scope.fleet && json.scope.fleet.models) || [];

    // Per-model: sortFields → orders → transactions
    const perModel = [];
    for (const model of models) {
      const sortFields = new Set(
        fleet
          .filter(f => String(f.model || '').trim().toUpperCase() === model.trim().toUpperCase())
          .map(f => String(f.sortField || '').trim())
          .filter(Boolean)
      );
      const orderSf = new Map(); // order → equipmentUnit
      for (const w of iw39) {
        const sf = String(w.sortField || '').trim();
        const o  = String(w.order || '').trim();
        if (!sf || !o) continue;
        if (!sortFields.has(sf)) continue;
        if (w.basicStartDate && w.basicStartDate > runDate) continue;
        if (!orderSf.has(o)) orderSf.set(o, sf);
      }
      const orders = new Set(orderSf.keys());
      const transactions = [];
      for (const t of mb51) {
        const o = String(t.order || '').trim();
        if (!orders.has(o)) continue;
        const mt = String(t.movementType || '').trim();
        if (!VALID_TYPES.has(mt)) continue;
        transactions.push({ ...t, equipmentUnit: orderSf.get(o) });
      }
      perModel.push({ key: model, name: model, transactions });
    }

    // Multi-model detection: per-material net per model
    const materialModels = new Map();   // material → Set<model>
    for (const bucket of perModel) {
      const desc = buildMaterialDescIndex(bucket.transactions);
      const net  = netConsumptionByMaterial(bucket.transactions, desc);
      for (const [mat, agg] of net) {
        if (agg.net < threshold) continue;
        if (!materialModels.has(mat)) materialModels.set(mat, new Set());
        materialModels.get(mat).add(bucket.key);
      }
    }
    const multiSet = new Set();
    for (const [mat, mods] of materialModels) {
      if (mods.size >= 2) multiSet.add(mat);
    }

    // Strip multi materials from per-model buckets; build MULTI bucket from all selected models' transactions
    const out = [];
    for (const bucket of perModel) {
      const filtered = bucket.transactions.filter(t => !multiSet.has(String(t.material || '').trim()));
      out.push({
        key: bucket.key,
        name: bucket.name,
        kind: 'fleet',
        materials: null,
        transactions: filtered
      });
    }
    if (multiSet.size > 0) {
      // MULTI bucket = transactions across all per-model buckets for these materials
      const allTx = [];
      for (const bucket of perModel) {
        for (const t of bucket.transactions) {
          if (multiSet.has(String(t.material || '').trim())) allTx.push(t);
        }
      }
      out.push({ key: '__MULTI__', name: 'MULTI · cross-fleet', kind: 'multi', materials: multiSet, transactions: allTx });
    }
    return out;
  }

  function bucketsManual(json, mb51){
    const mats = new Set((json.scope.manual && json.scope.manual.materials) || []);
    const transactions = mb51.filter(t => {
      const m = String(t.material || '').trim();
      if (!mats.has(m)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    return [{ key: 'manual', name: 'Manual list', kind: 'manual', materials: mats, transactions }];
  }

  function bucketsByClassification(json, mb51, master){
    const f = json.scope.byClassification || {};
    const types = new Set((f.inventoryTypes || []).map(s => String(s).trim()));
    const mrps  = new Set((f.mrpClassifiers || []).map(s => String(s).trim()));
    const mmin  = f.movementAmount && f.movementAmount.min;
    const mmax  = f.movementAmount && f.movementAmount.max;

    // Filter master to matching materials
    const matSet = new Set();
    for (const r of master) {
      const it = String(r.inventoryType || '').trim();
      const mp = String(r.mrpInd || '').trim();
      if (types.size && !types.has(it)) continue;
      if (mrps.size  && !mrps.has(mp)) continue;
      matSet.add(String(r.material || '').trim());
    }
    // Movement-amount filter is applied per-material against MB51 net
    let transactions = mb51.filter(t => {
      const m = String(t.material || '').trim();
      if (!matSet.has(m)) return false;
      const mt = String(t.movementType || '').trim();
      return VALID_TYPES.has(mt);
    });
    if (mmin != null || mmax != null) {
      const desc = buildMaterialDescIndex(transactions);
      const net  = netConsumptionByMaterial(transactions, desc);
      const pass = new Set();
      for (const [mat, agg] of net) {
        if (mmin != null && agg.net < mmin) continue;
        if (mmax != null && agg.net > mmax) continue;
        pass.add(mat);
      }
      transactions = transactions.filter(t => pass.has(String(t.material || '').trim()));
    }
    return [{ key: 'classif', name: 'By Classification', kind: 'classification', materials: matSet, transactions }];
  }

  function bucketsByVendor(json, mb51, vendors){
    const sel = new Set((json.scope.byVendor && json.scope.byVendor.vendors) || []);
    const matToVendors = new Map();  // material → Set<vendor>
    for (const r of vendors) {
      const m = String(r.material || '').trim();
      const v = String(r.vendor || '').trim();
      if (!sel.has(v)) continue;
      if (!matToVendors.has(m)) matToVendors.set(m, new Set());
      matToVendors.get(m).add(v);
    }
    // Multi-vendor materials → MULTI bucket
    const multi = new Set();
    for (const [mat, vs] of matToVendors) if (vs.size >= 2) multi.add(mat);
    const out = [];
    for (const vendor of sel) {
      const mats = new Set();
      for (const [mat, vs] of matToVendors) {
        if (multi.has(mat)) continue;
        if (vs.has(vendor)) mats.add(mat);
      }
      const tx = mb51.filter(t => {
        const m = String(t.material || '').trim();
        if (!mats.has(m)) return false;
        const mt = String(t.movementType || '').trim();
        return VALID_TYPES.has(mt);
      });
      out.push({ key: vendor, name: vendor, kind: 'vendor', materials: mats, transactions: tx });
    }
    if (multi.size > 0) {
      const tx = mb51.filter(t => {
        const m = String(t.material || '').trim();
        if (!multi.has(m)) return false;
        const mt = String(t.movementType || '').trim();
        return VALID_TYPES.has(mt);
      });
      out.push({ key: '__MULTI__', name: 'MULTI · cross-vendor', kind: 'multi', materials: multi, transactions: tx });
    }
    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     RUN PIPELINE
     For each bucket, produce a per-material result with all derived stats.
     Returns { buckets: [...], runDate, parameters, summary }.
  ═════════════════════════════════════════════════════════════════════════ */
  function runPipeline(json, options){
    options = options || {};
    const runDate    = options.runDate || new Date().toISOString().slice(0, 10);
    const params     = json.parameters;
    const threshold  = params.threshold;
    const minMonths  = params.minMonths;
    const maxMonths  = params.maxMonths;
    const p2Months   = params.p2Months;
    const p1Start    = params.p1Start;
    const p1End      = params.p1End;
    const p1Months   = Math.max(1, monthsBetween(p1Start, p1End) + 1);
    const p2Start    = addMonths(runDate, -p2Months);
    const p2End      = runDate;

    const master = json.data.inventoryMaster || [];
    const masterIdx = new Map();
    for (const r of master) {
      masterIdx.set(String(r.material || '').trim(), r);
    }

    // APP-E1 (v2.1.3-dev FIX-1) — Pre-group the FULL MB51 by material for the
    // stock-on-hand back-calc. Bucket-filtered transactions (`bucket.transactions`)
    // are restricted to consumption-related movement types {261,201,262,202} —
    // they DO NOT include goods receipts (109/101) or their reversals (102).
    // The back-calc needs supply events too; without receipts, walking backward
    // through only-issues makes stock appear to monotonically rise — the
    // "infinite supply" bug. Pre-grouping here keeps it O(n) instead of per-loop.
    const mb51FullByMat = groupBy(json.data.mb51 || [], r => String(r.material || '').trim());

    // Inv-Adj candidates (always detected) + user-confirmed exclusion set
    const invAdjAnalysis = detectInvAdjCandidates(json.data.mb51 || [], params);
    const confirmedInvAdjDates = Array.isArray(params.invAdjConfirmedDates) ? params.invAdjConfirmedDates : [];
    const invAdjSet = new Set(confirmedInvAdjDates);

    const buckets = buildBuckets(json);
    const bucketResults = [];

    const summary = { GREEN:0, BLUE:0, ORANGE:0, RED:0, GREY:0, PURPLE:0, total: 0 };

    for (const bucket of buckets) {
      const desc = buildMaterialDescIndex(bucket.transactions);
      const net  = netConsumptionByMaterial(bucket.transactions, desc);
      const qualifying = [];
      for (const [mat, agg] of net) {
        if (agg.net < threshold) continue;
        qualifying.push({ material: mat, description: agg.description, totalNet: agg.net });
      }
      qualifying.sort((a, b) => b.totalNet - a.totalNet);

      // Group transactions by material for per-material analysis
      const txByMat = groupBy(bucket.transactions, t => String(t.material || '').trim());

      const materials = [];
      const bucketSummary = { GREEN:0, BLUE:0, ORANGE:0, RED:0, GREY:0, PURPLE:0, total: 0 };

      for (const q of qualifying) {
        const tx = txByMat.get(q.material) || [];

        // P1/P2 rates exclude any transactions on confirmed Inv-Adj dates
        const { rate: p1r, flag: p1f } = calcPeriodRate(tx, p1Start, p1End, p1Months, invAdjSet);
        const { rate: p2r, flag: p2f } = calcPeriodRate(tx, p2Start, p2End, p2Months, invAdjSet);

        // HCE detection runs on the FULL transaction set (HCE flags work-order
        // events regardless of Inv-Adj exclusion — they're independent signals)
        const hceP1 = detectHce(tx, p1Start, p1End, 'P1', params);
        const hceP2 = detectHce(tx, p2Start, p2End, 'P2', params);

        // Inv Adj events for THIS material (only those on confirmed dates)
        const invAdj = buildInvAdjEvents(tx, confirmedInvAdjDates);

        // Adjusted P2 rate excludes BOTH HCE work orders AND Inv-Adj dates
        let adjP2 = null;
        if (hceP2.length || invAdj.length) {
          const orders = hceP2.map(e => e.order);
          // Re-implement here so we can pass excludeDates too
          const excluded = new Set(orders);
          const filtered = tx.filter(r => !excluded.has(String(r.order || '').trim()));
          const r = calcPeriodRate(filtered, p2Start, p2End, p2Months, invAdjSet);
          adjP2 = { rate: r.rate, flag: r.flag };
        }

        const pattern = classifyPattern(tx, params);
        const cum = cumulativeSeries(tx);
        const rateChange =
          (p1f === 'OK' && p1r > 0 && p2f === 'OK')
            ? Math.round((p2r - p1r) / p1r * 1000) / 10
            : null;

        const masterRow = masterIdx.get(q.material);
        const mrpType       = masterRow ? (masterRow.mrpInd || '') : 'NOT IN MASTER';
        const stock         = masterRow ? masterRow.totQtyOh : null;
        const cmin          = masterRow ? masterRow.mrpMin   : null;
        const cmax          = masterRow ? masterRow.mrpMax   : null;
        const safetyStock   = masterRow ? masterRow.safetyStock : null;
        const materialGroup = masterRow ? (masterRow.materialGroup || '') : '';
        const manufacturer  = masterRow ? (masterRow.manufacturer  || '') : '';
        const totValueOh    = masterRow ? masterRow.totValueOh : null;

        const rmin = (p2f === 'OK' && p2r > 0) ? Math.round(p2r * minMonths) : null;
        const rmax = (p2f === 'OK' && p2r > 0) ? Math.round(p2r * maxMonths) : null;

        const woCount = countIssueWorkOrders(tx);
        const tl = assess(mrpType, q.totalNet, threshold, p2r, p2f, cmin, cmax, rmin, rmax, stock, woCount, params);
        bucketSummary[tl.code] = (bucketSummary[tl.code] || 0) + 1;
        bucketSummary.total++;
        summary[tl.code]  = (summary[tl.code]  || 0) + 1;
        summary.total++;

        // Derived: runway @ P2 rate (in months of cover), null if no rate / no stock
        const runway = (p2f === 'OK' && p2r > 0 && typeof stock === 'number' && stock > 0)
                          ? Math.round((stock / p2r) * 10) / 10
                          : null;

        // Recommended MRP type: V1 (consumption-driven) for LUMPY / HCE patterns where
        // a fixed Min/Max is a poor fit; otherwise mirror the current setting.
        const recMrpType = (pattern === 'LUMPY' || (hceP2 && hceP2.length))
                              ? 'V1'
                              : (mrpType || 'PD');

        // v2.1.0 signal fields (additive — fed into the LLM prompt's WATCH-FOR
        // block so the model can name the specific signal that tripped).
        // No client identifiers; purely derived from transaction data.
        let _issuesQty = 0, _returnsQty = 0, _lastIssueDate = '';
        for (const r of tx) {
          const mt = String(r.movementType || '').trim();
          if (!VALID_TYPES.has(mt)) continue;
          const qv = Math.abs(parseFloat(r.quantity) || 0);
          if (ISSUE_TYPES.has(mt)) {
            _issuesQty += qv;
            const d = String(r.postingDate || '');
            if (d > _lastIssueDate) _lastIssueDate = d;
          } else if (RETURN_TYPES.has(mt)) {
            _returnsQty += qv;
          }
        }
        let netSign;
        if (_issuesQty === 0 && _returnsQty === 0)   netSign = 'NO_DATA';
        else if (_issuesQty - _returnsQty < 0)       netSign = 'NEGATIVE (returns dominate)';
        else if (_returnsQty >= 0.25 * _issuesQty)   netSign = 'MIXED';
        else                                         netSign = 'POSITIVE';
        let daysSinceLastIssue = null;
        if (_lastIssueDate) {
          const _ms = Date.parse(runDate) - Date.parse(_lastIssueDate);
          if (Number.isFinite(_ms)) daysSinceLastIssue = Math.max(0, Math.floor(_ms / 86400000));
        }
        const rateDropFlag = (p1f === 'OK' && p1r > 0 && p2f === 'OK' && p2r <= 0.6 * p1r);
        const rateRiseFlag = (p1f === 'OK' && p1r > 0 && p2f === 'OK' && p2r >= 1.6 * p1r);
        const invAdjCount  = invAdj.length;

        // ─── APP-E1 · Stockout-aware drop diagnostic (v2.1.3-dev) ─────────
        // Back-calc SOH for the "X months run-up to last consumption" window,
        // then classify whether any rateDropFlag is stockout-driven or genuine.
        // Guarded so older code paths still work if inventory-back-calc.js
        // isn't loaded (graceful no-op).
        let lastConsumptionDate = _lastIssueDate || null;
        let stockOnHandSeries   = [];
        let stockoutWindows     = [];
        let rateDropCause       = null;
        let stockoutDrivenDrop  = false;
        let socBackCalcAnchor   = null;
        if (typeof InventoryBackCalc !== 'undefined' && typeof stock === 'number') {
          const backCalcMonths = (typeof params?.socBackCalcMonths === 'number' && params.socBackCalcMonths > 0)
                                    ? params.socBackCalcMonths
                                    : 6;
          const win = InventoryBackCalc.buildWindow({
            lastConsDate:   lastConsumptionDate,
            runDate,
            backCalcMonths
          });
          if (win) {
            socBackCalcAnchor = win.anchor;
            // FIX-1 — pass the FULL per-material MB51 slice (includes 109
            // site receipts), not `tx` which is bucket-filtered to consumption
            // movement types only. Without 109s the back-calc only saw issues
            // and SOH appeared to monotonically rise as we walked back —
            // "infinite supply" artefact.
            const fullMb51 = mb51FullByMat.get(q.material) || [];
            const out = InventoryBackCalc.backCalcSOH({
              material:     q.material,
              currentSOH:   stock,
              mb51Rows:     fullMb51,
              windowStart:  win.windowStart,
              windowEnd:    win.windowEnd
            });
            stockOnHandSeries = out.series;
            stockoutWindows   = out.stockoutWindows;
            rateDropCause     = InventoryBackCalc.classifyRateDropCause({
              rateDropFlag,
              p2Start, p2End,
              stockoutWindows
            });
            stockoutDrivenDrop = (rateDropCause === 'STOCKOUT_DRIVEN');
          }
        }

        materials.push({
          material:     q.material,
          description:  q.description,
          materialGroup,
          manufacturer,
          totValueOh,
          totalNet:     Math.round(q.totalNet * 10) / 10,
          p1Net:        Math.round((tx.filter(r => inRange(r.postingDate, p1Start, p1End) && VALID_TYPES.has(String(r.movementType || '').trim())).reduce((s, r) => {
                          const mt = String(r.movementType || '').trim();
                          const qv = Math.abs(parseFloat(r.quantity) || 0);
                          return s + (ISSUE_TYPES.has(mt) ? qv : -qv);
                        }, 0)) * 10) / 10,
          p1Rate:       Math.round(p1r * 100) / 100,
          p1Flag:       p1f,
          p2Net:        Math.round((tx.filter(r => inRange(r.postingDate, p2Start, p2End) && VALID_TYPES.has(String(r.movementType || '').trim())).reduce((s, r) => {
                          const mt = String(r.movementType || '').trim();
                          const qv = Math.abs(parseFloat(r.quantity) || 0);
                          return s + (ISSUE_TYPES.has(mt) ? qv : -qv);
                        }, 0)) * 10) / 10,
          p2Rate:       Math.round(p2r * 100) / 100,
          p2Flag:       p2f,
          rateChange,
          adjP2Rate:    adjP2 ? Math.round(adjP2.rate * 100) / 100 : null,
          adjP2Flag:    adjP2 ? adjP2.flag : null,
          hceP1, hceP2,
          invAdj,                                  // events on confirmed Inv-Adj dates (excluded from rate)
          invAdjCount,                             // count of Inv-Adj events for this material (v2.1.0)
          pattern,
          stock, mrpType, cmin, cmax, safetyStock,
          recMin:       tl.recMin,
          recMax:       tl.recMax,
          recMrpType,
          runway,                                  // months of cover at P2 rate
          woCount,                                 // unique issuing work orders in window
          fewEvents:    !!tl.fewEvents,            // true if few-events overlay tripped
          // v2.1.0 signal fields — additive, used by LLM prompt context
          netSign,                                 // 'POSITIVE' | 'NEGATIVE (returns dominate)' | 'MIXED' | 'NO_DATA'
          daysSinceLastIssue,                      // integer or null
          rateDropFlag,                            // boolean — p2Rate <= 0.6 * p1Rate
          rateRiseFlag,                            // boolean — p2Rate >= 1.6 * p1Rate
          // APP-E1 (v2.1.3) — stockout-aware diagnostic fields
          lastConsumptionDate,                     // ISO or null — max(postingDate) where mvt ∈ {261,201}
          stockOnHandSeries,                       // [{date, soh}] daily SOH back-calc over the window
          stockoutWindows,                         // [{start, end, days}] periods where SOH ≤ 0
          rateDropCause,                           // 'STOCKOUT_DRIVEN' | 'GENUINE_DEMAND_DROP' | null
          stockoutDrivenDrop,                      // boolean — true when rateDropFlag + stockout window overlaps P2
          socBackCalcAnchor,                       // 'lastConsumption' | 'today' | null — which date anchored the window
          trafficLight: tl.code,
          action:       tl.action,
          // Multi-model is filled in post-bucketing (see below). Defaults to 'Single'.
          multiModelFlag: bucket.kind === 'multi' ? 'Multi' : 'Single',
          bucketKey:    bucket.key,
          bucketName:   bucket.name,
          cumulative:   cum,
          p2Start, p2End, p1Start, p1End
        });
      }

      bucketResults.push({
        key: bucket.key,
        name: bucket.name,
        kind: bucket.kind,
        summary: bucketSummary,
        materials,
        txCount: bucket.transactions.length
      });
    }

    return {
      runDate,
      parameters: params,
      p2Start, p2End,
      p1Start, p1End,
      buckets: bucketResults,
      summary,
      invAdjAnalysis,                              // { sigmaN, mean, stddev, threshold, dayCount, candidates[] }
      invAdjConfirmedDates: confirmedInvAdjDates   // currently-applied exclusion list
    };
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppPipeline = Object.freeze({
    ISSUE_TYPES, RETURN_TYPES, VALID_TYPES,
    netConsumptionByMaterial,
    calcPeriodRate,
    detectHce,
    calcAdjustedP2Rate,
    detectInvAdjCandidates,
    buildInvAdjEvents,
    classifyPattern,
    cumulativeSeries,
    assess,
    buildBuckets,
    runPipeline,
    addMonths, monthsBetween
  });

})(window);
