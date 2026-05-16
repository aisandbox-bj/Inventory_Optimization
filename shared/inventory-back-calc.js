/* ═══════════════════════════════════════════════════════════════════════════
   Inventory back-calc — reconstruct stock-on-hand over time by walking MB51
   movements backwards from the current SOH (from Inventory Master).

   Used by:
     - Calibre Tune APP-E1 (stockout-aware drop detection — v2.1.3-dev)
     - Calibre Trace D14 (Progression-tab inventory overlay — planned)
   The math lives here once; both tools call it.

   Movement-type semantics (effect on SOH walking FORWARD in time):
     +109   GR to unrestricted stock           → SOH += qty   (walking back: SOH -= qty)
     -261   Goods issue (consumption to order) → SOH -= qty   (walking back: SOH += qty)
     -201   Goods issue (consumption to cost center) → same as 261
     +101   GR to misc stock                   → SOH += qty   (walking back: SOH -= qty)
     -102   Reversal of 101                    → SOH -= qty   (walking back: SOH += qty)
     +262   Reversal of 261 (return to stock)  → SOH += qty   (walking back: SOH -= qty)
     +202   Reversal of 201                    → SOH += qty   (walking back: SOH -= qty)
     other  No SOH effect (e.g. inventory adjustments)

   Pure module — no DOM, no localStorage, no side effects. Deterministic.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Movement-type sign map (forward-in-time effect) ─────────────────────
     Positive sign = increases SOH (receipts, returns).
     Negative sign = decreases SOH (issues).
     Zero / absent = no SOH effect (adjustments, transfers between storage
     locations, etc. — we deliberately exclude these because they don't
     represent real demand or supply). */
  const MVT_SIGN = Object.freeze({
    '109':  +1,
    '101':  +1,
    '102':  -1,    // reversal of 101
    '261':  -1,
    '262':  +1,    // reversal / return of 261
    '201':  -1,
    '202':  +1,    // reversal / return of 201
  });

  /* ─── Date helpers ──────────────────────────────────────────────────────── */
  function toMs(s) {
    if (s == null || s === '') return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  function toIsoDay(ms) {
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  function addDays(ms, n) { return ms + n * 86400000; }
  function addMonths(ms, n) {
    const d = new Date(ms);
    d.setMonth(d.getMonth() + n);
    return d.getTime();
  }

  /**
   * Find the last consumption date for a material from a slice of MB51 rows.
   * "Consumption" = movement types 261 OR 201 (matches the existing Tune
   * pipeline's ISSUE_TYPES). Returns ISO date or null.
   */
  function lastConsumptionDate(mb51Rows) {
    let latest = null;
    for (const r of mb51Rows) {
      const mt = String(r.movementType || '').trim();
      if (mt !== '261' && mt !== '201') continue;
      const d = String(r.postingDate || '');
      if (d && (latest == null || d > latest)) latest = d;
    }
    return latest;
  }

  /**
   * Back-calc the SOH series for a single material.
   *
   * @param {Object}  args
   * @param {string}  args.material        — material number (informational)
   * @param {number}  args.currentSOH      — totQtyOh from Inventory Master (snapshot value)
   * @param {Array}   args.mb51Rows        — array of MB51 rows for THIS material only
   *                                          (caller filters; we don't re-filter)
   * @param {string}  args.windowStart     — ISO date, inclusive
   * @param {string}  args.windowEnd       — ISO date, inclusive (typically today)
   * @returns {{
   *   series:           Array<{date:string, soh:number}>,
   *   stockoutWindows:  Array<{start:string, end:string, days:number}>,
   *   currentSOH:       number,
   *   error:            string|null
   * }}
   */
  function backCalcSOH({ material, currentSOH, mb51Rows, windowStart, windowEnd }) {
    // Guard: no current SOH = can't anchor the walk
    if (currentSOH == null || !Number.isFinite(currentSOH)) {
      return { series: [], stockoutWindows: [], currentSOH: null, error: 'no current SOH on Inventory Master' };
    }
    const startMs = toMs(windowStart);
    const endMs   = toMs(windowEnd);
    if (startMs == null || endMs == null || startMs >= endMs) {
      return { series: [], stockoutWindows: [], currentSOH, error: 'invalid window' };
    }

    // Group MB51 rows by day. Each day's net delta = Σ (sign × qty).
    // Rows outside [windowStart, today] are still processed if they touch the
    // walk path between windowEnd and today — but since we anchor at currentSOH
    // (today), the walk effectively spans [windowStart, windowEnd].
    const deltasByDay = new Map();   // isoDay → net forward-in-time qty
    for (const r of (mb51Rows || [])) {
      const mt = String(r.movementType || '').trim();
      const sign = MVT_SIGN[mt];
      if (!sign) continue;                              // adjustments etc. ignored
      const d = String(r.postingDate || '');
      if (!d) continue;
      const ms = toMs(d);
      if (ms == null) continue;
      const q = Math.abs(parseFloat(r.quantity) || 0);
      if (q === 0) continue;
      // Only days from windowStart through windowEnd matter to the visible series.
      if (ms < startMs - 86400000 || ms > endMs + 86400000) continue;
      deltasByDay.set(d, (deltasByDay.get(d) || 0) + sign * q);
    }

    // Walk backward: SOH(t) = SOH(t+1) - delta(t+1)
    // We render the series in forward chronological order.
    // First pass: walk back from today (currentSOH known) to windowStart,
    // recording SOH at the end of each day in the window.
    const days = [];
    for (let t = startMs; t <= endMs; t = addDays(t, 1)) days.push(toIsoDay(t));

    // Compute SOH at each day-end by walking from endMs backwards.
    // Strategy: produce a map dayEndSOH[isoDay] = SOH at end of that day.
    const dayEndSOH = new Map();
    // SOH at end of windowEnd = currentSOH (snapshot value taken at "today").
    // Then for each prior day t: SOH(t) = SOH(t+1) - delta(t+1)
    let cursor = currentSOH;
    // Walk backwards day by day
    for (let i = days.length - 1; i >= 0; i--) {
      const isoDay = days[i];
      dayEndSOH.set(isoDay, cursor);
      // Step BACKWARD across the boundary between this day and the previous:
      // the SOH at end of (isoDay-1) = SOH at end of isoDay MINUS net delta on isoDay
      const todayDelta = deltasByDay.get(isoDay) || 0;
      cursor = cursor - todayDelta;
    }

    // Build forward-ordered series
    const series = days.map(d => ({ date: d, soh: round1(dayEndSOH.get(d)) }));

    // Identify stockout windows (SOH ≤ 0). Treat exact zero as stockout —
    // the operator's definitional point: "you cannot consume what you don't
    // have". Float noise: use a small epsilon.
    const EPS = 0.001;
    const stockoutWindows = [];
    let win = null;
    for (const p of series) {
      if (p.soh <= EPS) {
        if (win == null) win = { start: p.date, end: p.date };
        else win.end = p.date;
      } else {
        if (win) {
          win.days = daysBetween(win.start, win.end) + 1;
          stockoutWindows.push(win);
          win = null;
        }
      }
    }
    if (win) {
      win.days = daysBetween(win.start, win.end) + 1;
      stockoutWindows.push(win);
    }

    return { series, stockoutWindows, currentSOH, error: null };
  }

  /**
   * Compute the diagnostic verdict for a material:
   *   - 'STOCKOUT_DRIVEN'  — the P2 drop window overlaps a stockout window
   *   - 'GENUINE_DEMAND_DROP' — drop happened with stock available throughout
   *   - null               — no drop, or insufficient data to judge
   *
   * @param {Object} args
   * @param {boolean} args.rateDropFlag        — existing pipeline flag
   * @param {string}  args.p2Start             — ISO date
   * @param {string}  args.p2End               — ISO date
   * @param {Array}   args.stockoutWindows     — output from backCalcSOH
   * @returns {string|null}
   */
  function classifyRateDropCause({ rateDropFlag, p2Start, p2End, stockoutWindows }) {
    if (!rateDropFlag) return null;
    if (!stockoutWindows || stockoutWindows.length === 0) return 'GENUINE_DEMAND_DROP';
    const p2sMs = toMs(p2Start);
    const p2eMs = toMs(p2End);
    if (p2sMs == null || p2eMs == null) return 'GENUINE_DEMAND_DROP';
    // Any overlap between a stockout window and [p2Start, p2End] = STOCKOUT_DRIVEN
    for (const w of stockoutWindows) {
      const ws = toMs(w.start);
      const we = toMs(w.end);
      if (ws == null || we == null) continue;
      // Standard interval overlap test
      if (ws <= p2eMs && we >= p2sMs) return 'STOCKOUT_DRIVEN';
    }
    return 'GENUINE_DEMAND_DROP';
  }

  /* ─── Local utilities ──────────────────────────────────────────────────── */
  function round1(n) { return Math.round((n || 0) * 10) / 10; }
  function daysBetween(isoA, isoB) {
    const a = toMs(isoA), b = toMs(isoB);
    if (a == null || b == null) return 0;
    return Math.round((b - a) / 86400000);
  }

  /**
   * Build the effective back-calc window for a material:
   *   windowStart = lastConsumptionDate − backCalcMonths   (if last cons exists)
   *                                  else  windowEnd − backCalcMonths
   *   windowEnd   = today (runDate)
   * Returns { windowStart, windowEnd, anchor } with anchor = 'lastConsumption' or 'today'.
   */
  function buildWindow({ lastConsDate, runDate, backCalcMonths }) {
    const endMs = toMs(runDate);
    if (endMs == null) return null;
    const anchorMs = lastConsDate ? toMs(lastConsDate) : endMs;
    if (anchorMs == null) return null;
    const startMs = addMonths(anchorMs, -Math.max(1, backCalcMonths || 6));
    return {
      windowStart: toIsoDay(startMs),
      windowEnd:   toIsoDay(endMs),
      anchor:      lastConsDate ? 'lastConsumption' : 'today'
    };
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */
  global.InventoryBackCalc = Object.freeze({
    backCalcSOH,
    lastConsumptionDate,
    classifyRateDropCause,
    buildWindow,
    MVT_SIGN
  });

})(window);
