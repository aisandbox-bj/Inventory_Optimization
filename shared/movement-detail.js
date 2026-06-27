/* ═══════════════════════════════════════════════════════════════════════════
   shared/movement-detail.js · APP-TREND-HOV (2026-06-27)
   ───────────────────────────────────────────────────────────────────────────
   Per-material MB51 movement detail for the Trend-chart hover tooltips.

   Splits a material's movements into the two lines the chart draws:
     · consumption — the goods-issue line (orange / cumulative). Movement types
       261 / 201 / 262 / 202 (matches the pipeline's VALID_TYPES).
     · stock — every movement that actually shifts the back-calc Stock-on-Hand
       line (violet). Uses InventoryBackCalc's OWN classification (MVT_SIGN +
       DIRECTIONAL_MVTS) so the hover ties out to what the line shows — this
       site's back-calc excludes the 3PL / 101 / 107 flow, so those never appear.

   Quantities are ABSOLUTE (operator decision 2026-06-27); the movement-type
   description carries the direction (GI = out, GR = in, reversal = back).

   Public API:
     MovementDetail.forMaterial(json, material) -> { consumption:[], stock:[] }
         each row: { date, mt, mtDesc, qty (absolute), order }
     MovementDetail.describe(code) -> plain-English movement-type label
═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // Plain-English movement-type labels (b2mb51 + this site's back-calc semantics).
  const DESC = Object.freeze({
    '261': 'GI for order',
    '201': 'GI to cost centre',
    '221': 'GI to project',
    '291': 'GI to account assignment',
    '551': 'GI scrapping',
    '543': 'GI subcontract consumption',
    '262': 'Reversal of GI for order',
    '202': 'Reversal of GI to cost centre',
    '222': 'Reversal of GI to project',
    '292': 'Reversal of GI to account assignment',
    '552': 'Reversal of scrapping',
    '109': 'Goods receipt (site WH)',
    '712': 'Inventory count surplus',
    '110': 'Reversal of goods receipt',
    '711': 'Inventory count shortage',
    '541': 'Transfer to subcontractor',
    '542': 'Reversal of transfer to subcontractor',
    '309': 'Transfer (material to material)',
    '310': 'Reversal of transfer (material to material)',
    '411': 'Transfer (storage location)',
    '412': 'Reversal of storage-location transfer'
  });

  // Consumption (orange line) — matches pipeline VALID_TYPES (261/201 + reversals).
  const CONS_TYPES = new Set(['261', '201', '262', '202']);

  function describe(code){
    const c = String(code == null ? '' : code).trim();
    return DESC[c] || ('Movement ' + c);
  }

  // Signed effect on the back-calc Stock-on-Hand line — mirrors the exact logic
  // in inventory-back-calc.js (DIRECTIONAL row-signed, else MVT_SIGN × |qty|,
  // else excluded → 0). Returns 0 when the movement doesn't move the line.
  function stockSignedDelta(row){
    const BC = global.InventoryBackCalc;
    if (!BC) return 0;
    const mt = String(row.movementType || '').trim();
    const q  = parseFloat(row.quantity);
    if (!Number.isFinite(q) || q === 0) return 0;
    if (BC.DIRECTIONAL_MVTS && BC.DIRECTIONAL_MVTS.has(mt)) return q;   // row-signed leg
    const sign = BC.MVT_SIGN ? BC.MVT_SIGN[mt] : null;
    if (sign == null) return 0;                                        // excluded / unknown
    return sign * Math.abs(q);
  }

  function forMaterial(json, material){
    const data  = (json && json.data) || {};
    const mb51  = data.mb51 || [];
    const mat   = String(material == null ? '' : material).trim();
    const consumption = [];
    const stock = [];
    for (const r of mb51){
      if (String(r.material || '').trim() !== mat) continue;
      const date = String(r.postingDate || '').trim();
      if (!date) continue;
      const mt    = String(r.movementType || '').trim();
      const order = String(r.order || '').trim();
      if (CONS_TYPES.has(mt)){
        consumption.push({ date, mt, mtDesc: describe(mt), qty: Math.abs(parseFloat(r.quantity) || 0), order });
      }
      const sd = stockSignedDelta(r);
      if (sd !== 0){
        stock.push({ date, mt, mtDesc: describe(mt), qty: Math.abs(sd), order });
      }
    }
    return { consumption, stock };
  }

  global.MovementDetail = { forMaterial, describe };
})(window);
