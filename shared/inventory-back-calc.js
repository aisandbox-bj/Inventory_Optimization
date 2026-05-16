/* ═══════════════════════════════════════════════════════════════════════════
   Inventory back-calc — reconstruct stock-on-hand over time by walking MB51
   movements backwards from the current SOH (from Inventory Master).

   Used by:
     - Calibre Tune APP-E1 (stockout-aware drop detection — v2.1.3-dev)
     - Calibre Trace D14 (Progression-tab inventory overlay — planned)
   The math lives here once; both tools call it.

   Movement-type semantics — SITE STOCK only (matches Inventory Master.totQtyOh):

     +109   Goods receipt onto SITE (this is what arrives at the site warehouse
            and becomes available for consumption)              → SOH += qty
     -261   Goods issue · consumption to a work order           → SOH -= qty
     -201   Goods issue · consumption to a cost center          → SOH -= qty
     +262   Reversal of 261 (return into site stock)            → SOH += qty
     +202   Reversal of 201 (return into site stock)            → SOH += qty

     Movement types DELIBERATELY EXCLUDED — they don't touch the site's
     stock-on-hand value tracked on Inventory Master:

     101 / 102  Goods receipt / reversal at the 3PL holding location. The
                3PL is offsite — material that arrives here has NOT yet
                transferred onto site, so site SOH is unchanged. (Transfer
                from 3PL onto site is the 109 above.)
     other      Inventory adjustments, cycle counts, transfer postings
                between non-site storage locations, etc. — none change the
                site's unrestricted-use stock balance.

   When walking the back-calc BACKWARD in time, the sign flips: subtract a
   forward-positive delta to recover the prior day's SOH.

   Operator-specific transfer types (e.g. plant→plant 411/412, storage-
   location moves 311/312 that land in or out of site) can be added to
   MVT_SIGN below if a particular site uses them as supply paths onto site.

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
    '109':  +1,    // receipt onto SITE (replenishment that lands at site warehouse)
    '261':  -1,    // issue to work order (consumes site stock)
    '201':  -1,    // issue to cost center (consumes site stock)
    '262':  +1,    // reversal of 261 — material returns into site stock
    '202':  +1     // reversal of 201 — material returns into site stock
    // 101 / 102 are 3PL events (not site) and are intentionally excluded.
    // Other site-stock transfer types can be appended per operator setup.
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

  /* ═════════════════════════════════════════════════════════════════════════
     APP-E11 — Stockout-aware P2 anchoring + dominance detection
     ═════════════════════════════════════════════════════════════════════════
     The APP-E1 back-calc surfaces stockout windows from the MB51 movements.
     APP-E11 uses those windows to decide:
       (a) where to anchor the P2 (recent-rate) comparison window when the
           material has been in a stockout for too long; the answer is the
           LAST consumption date, not runDate — analysing zero-consumption
           ongoing-stockout days as "demand" misleads the rate-drop verdict.
       (b) whether the chosen P2 window is so dominated by stockouts that
           a numeric P2-vs-P1 verdict cannot be trusted at all (multiple
           stockout windows inside P2); in that case the pipeline flags the
           material STOCKOUT-DOMINATED and the traffic-light is forced GREY.
  ═════════════════════════════════════════════════════════════════════════ */

  /**
   * Does the tail of the back-calc series end in an ongoing stockout of
   * sufficient duration to invalidate runDate-anchored P2?
   *
   * "Ongoing at runDate" means the last stockout window's `end` is at or
   * within 1 day of runDate. "Sufficient duration" defaults to 7 days
   * (configurable). Returns boolean.
   *
   * @param {Array}  stockoutWindows — output from backCalcSOH
   * @param {string} runDate         — ISO date the analysis is run against
   * @param {number} [minDays=7]     — minimum stockout duration to count
   */
  function isTailInOngoingStockout(stockoutWindows, runDate, minDays) {
    if (!Array.isArray(stockoutWindows) || stockoutWindows.length === 0) return false;
    const rdMs = toMs(runDate);
    if (rdMs == null) return false;
    const thr = (typeof minDays === 'number' && minDays > 0) ? minDays : 7;
    // Inspect the LATEST stockout window (last entry — they're chronological)
    const last = stockoutWindows[stockoutWindows.length - 1];
    const endMs = toMs(last.end);
    if (endMs == null) return false;
    // "Ongoing at runDate" — end is at or within 1 day of runDate
    const stillOngoing = (rdMs - endMs) <= 86400000;
    if (!stillOngoing) return false;
    const days = (typeof last.days === 'number') ? last.days : (daysBetween(last.start, last.end) + 1);
    return days >= thr;
  }

  /**
   * Count distinct stockout windows that overlap [rangeStart, rangeEnd].
   * Used to detect "stockout-dominated" P2 windows.
   *
   * @param {Array}  stockoutWindows
   * @param {string} rangeStart — ISO date inclusive
   * @param {string} rangeEnd   — ISO date inclusive
   * @returns {number}
   */
  function countStockoutsInRange(stockoutWindows, rangeStart, rangeEnd) {
    if (!Array.isArray(stockoutWindows) || stockoutWindows.length === 0) return 0;
    const rsMs = toMs(rangeStart);
    const reMs = toMs(rangeEnd);
    if (rsMs == null || reMs == null) return 0;
    let n = 0;
    for (const w of stockoutWindows) {
      const ws = toMs(w.start);
      const we = toMs(w.end);
      if (ws == null || we == null) continue;
      // Standard interval overlap test
      if (ws <= reMs && we >= rsMs) n++;
    }
    return n;
  }

  /**
   * Choose the P2 (recent-rate) comparison window.
   *
   * Default behaviour: anchor at runDate, step back p2Months.
   *
   * APP-E11 override: when `tailInOngoingStockout` is true AND a valid
   * `lastConsDate` is available, re-anchor at lastConsDate — analysing the
   * trailing ongoing-stockout days as "recent demand" misleads the rate
   * comparison. The recent-rate window then represents the operator's
   * last observation of true demand before the stockout began.
   *
   * @param {Object} args
   * @param {string} args.runDate                 — ISO date
   * @param {string|null} args.lastConsDate       — ISO date or null
   * @param {number} args.p2Months                — months to step back
   * @param {boolean} args.tailInOngoingStockout  — see isTailInOngoingStockout()
   * @returns {{ p2Start:string, p2End:string, anchor:'runDate'|'lastConsumption' }}
   */
  function chooseP2Window({ runDate, lastConsDate, p2Months, tailInOngoingStockout }) {
    const months = Math.max(1, p2Months || 3);
    const rdMs = toMs(runDate);
    if (rdMs == null) return { p2Start: null, p2End: null, anchor: 'runDate' };
    if (tailInOngoingStockout && lastConsDate) {
      const lcMs = toMs(lastConsDate);
      if (lcMs != null) {
        return {
          p2Start: toIsoDay(addMonths(lcMs, -months)),
          p2End:   toIsoDay(lcMs),
          anchor:  'lastConsumption'
        };
      }
    }
    return {
      p2Start: toIsoDay(addMonths(rdMs, -months)),
      p2End:   toIsoDay(rdMs),
      anchor:  'runDate'
    };
  }

  /* ─── Public API ──────────────────────────────────────────────────────── */
  global.InventoryBackCalc = Object.freeze({
    backCalcSOH,
    lastConsumptionDate,
    classifyRateDropCause,
    buildWindow,
    isTailInOngoingStockout,
    countStockoutsInRange,
    chooseP2Window,
    MVT_SIGN
  });

})(window);
