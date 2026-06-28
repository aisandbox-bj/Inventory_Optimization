# Calibre Tune v2.1.4-dev — Deferred items / next-version backlog

**Updated:** 2026-06-27 (version bump v2.1.3-dev → v2.1.4-dev; two SOH back-calc changes)
**Status:** origin/main tip = the newest entry in `record-of-change.html` (don't hard-pin a SHA here — it goes stale). Everything from `966e045` onward is **pending operator validation** except the Screener trio (`966e045`), which was operator-validated 2026-06-26 ("working pretty well"). The canonical, blow-by-blow log is `record-of-change.html`; this file is the forward-looking tracker only.

## Shipped 2026-06-27 (Trend dynamic period selector + Trend-CSS fix) — NOT yet pushed · pending operator validation
- **APP-FIX-TREND-CSS** — root-cause fix: `analysis.html` (Trend) wasn't loading `shared/material-detail.css` (only the Screener did), so every detail-panel style added to the shared CSS — the **open-procurement lamps** (APP-OPI-01, the operator's "PRP0 11"), the **Where-used modal**, the **chart hover tooltip**, and the **dynamic-period menu/hint** — was unstyled on Trend. Fixed by linking `material-detail.css` before `analysis.css` (mirrors the Screener; analysis.css still wins duplicated rules → no regression). Verified: OPI dot now the proper cyan circle on Trend, no layout regression, zero console errors. Visible half of the deferred **APP-SCR-02** (the full analysis.css de-dup remains a follow-up). Files: `analysis/analysis.html` (one `<link>`).
- **APP-TREND-DYN** — ad-hoc custom-period rate tool on the consumption chart (Trend + Screener): **right-click → "Dynamic period select" → click START then END** → a **purple** dashed **P · {rate}/mo** chord over the hand-picked window, with a **grey-backed** readout (start→end · net units · months) that ties out and stays legible over busy areas (operator feedback: grey backing + pink→purple). Rate = net ÷ months, same basis as P1/P2 (chord between the cumulative endpoints); free endpoints; live preview; right-click → "Clear period". For reading a clean rate when P1/P2 is contaminated by a return or stockout. Verified on 1001220 ("P · 55.0/mo", 564u ÷ 10.25mo = 55.0 by independent MB51 recompute; readout self-ties-out; backing sized to text + behind it; clear + material-switch reset; hover coexists; Trend + Screener; zero console errors). Snapshot: `_rollback/APP-TREND-DYN-pre/`.

## Shipped 2026-06-27 (Trend per-event stat + chart hover) — pushed origin `2ca2871` · pending operator validation
- **APP-TREND-PEC** — new "Per event cons" stat cell (Trend + Screener detail): mean ± sample std of units issued per consumptive event (event = WO 261 / CC 201, full window). New `perEventStats` on the pipeline result. Verified on 1001220 = 1.1 ± 1.1 across 817 events (independent Python recompute matched exactly).
- **APP-TREND-HOV** — hover any point on the consumption (orange) or stock (violet) line → tooltip of that date's movements (date · type code + plain-English description · absolute qty; stock line also shows "Stock after"). New shared `movement-detail.js`; stock-line classification reuses `InventoryBackCalc.MVT_SIGN`/`DIRECTIONAL_MVTS` so it ties to the line (3PL/101/107 excluded). Lazy per-open-material (no payload growth). Verified: harness 22/22 + real app (307 cum / 151 stock dots, correct tooltips, dots hide with toggled-off line, zero console errors). Snapshot: `_rollback/APP-TREND-EVT-pre/`.

## Shipped 2026-06-27 (Where-used modal + intake flags) — pushed origin `014c793` · pending operator validation
- **APP-INT-NEEDS-01** — Intake now **flags** each upload (★ Required · ☆ Optional-enables-a-feature · — Not used) per assessment type instead of greying-out + rejecting drops. Any source is loadable on any type, so a User-list run can load IW39/Fleet to feed "Where used". DQ gate unchanged (still `ASSESSMENT_TYPE_REQUIRES`). Material→Vendor flips to ★ under By-Vendor scope. Verified in preview (userList / unitFloc / byVendor; inputs enabled; legend + colours). Snapshot: `_rollback/APP-INT-NEEDS-01-pre/`.
- **APP-WU-02** — "Where used" inline panel → **centred modal** (✕ / backdrop / Esc) with **click-to-drill on year cells** into the underlying work orders (columns: Fleet · Unit · Date yyyy-Mmm · WO# · WO description · Qty; description from IW39). CC / Unmapped-WO / (unmapped-model) rows all drill (best-effort). Same net-of-reversal math, re-derived via new `WhereUsed.drill`; `compute` shape (and APP-WU-01 totals) unchanged. Verified two ways: engine harness 18/18 tie-out checks, and real app on 1001220 (grand 877 ties out; SF-100/2025 drill = 217; Trend + Screener; zero console errors). Snapshot: `_rollback/APP-WU-02-pre/`.

## Shipped + pushed 2026-06-27 (v2.1.4-dev — SOH back-calc) — pending operator validation
- **APP-FIX-SNAPSHOT-ALIGN** — capture Inventory Master extract date at intake (`metadata.inventoryMasterDate`, pre-filled from filename), warn-and-proceed if it ≠ the last MB51 posting date (validation issue + live note + amber chart caption), and root-fix the back-calc to anchor `runDate` to the extract date. Verified on LV (gap 2 days → re-anchor + warning + caption).
- **APP-E11b** — stockout-dominance now also triggers by DURATION: `stockoutDaysInRange` + new `p2StockoutDomFraction` (default 0.25) force GREY on a single long P2 stockout. Verified on LV: 1017248 (41%) + 1020332 (52%) flip BLUE→GREY; multi-window stay GREY; 0%-stockout materials unchanged.
- **Version bump** — v2.1.3-dev copied to v2.1.4-dev (live folder + repo mirror); v2.1.3-dev frozen as rollback. Both new fields additive; no SCHEMA_VERSION bump.

## Shipped + pushed 2026-06-27 (APP-WU-01 where-used) — pending operator validation
- **APP-WU-01** — "⊞ Where used" button on the Trend + Screener consumption-chart toolbar → inline panel: MB51 261/262 net work-order usage by Sort Field → Fleet model, plus a Cost-centre (CC) row (201/202), bucketed by year, with explicit Unmapped-WO / (unmapped-model) buckets and a grand total. New shared `where-used.js`; button gated on IW39; lazy compute. Verified (1000640 w/ synthesized IW39+Fleet → 639 total ties out). Snapshot: `_rollback/APP-WU-01-pre/`. Follow-ups: per-cost-centre breakdown (needs MB51 cost-centre alias); Trace placement if wanted.

## Shipped + pushed 2026-06-27 (APP-PD-SPREAD chevron spread) — pending operator validation
- **APP-PD-SPREAD** — the Phase-Distribution chevron's "Total to site" gains a small +/- (superscript +Q3 / subscript −Q1, anchored on the displayed average) showing the box top/bottom of the per-chain total-to-site (complete-A–D chains). Shared render → shows on Trace + Screener. Verified (1003380 → 30.0d +7.5/−7.5, box 22.5–37.5). Snapshot: `_rollback/APP-PD-SPREAD-pre/`. YoY per-year chevrons = candidate follow-up.

## Shipped + pushed 2026-06-27 (APP-OPI-01 open-procurement indicator) — pending operator validation
- **APP-OPI-01** — 3-lamp PR · PO · In-Transit indicator on the detail header (Trend + Screener), left of the classifier pill; click → popover with each item (ref · created date · qty · age) + the SAP Inventory-Master snapshot qty. New shared `TracePhase.openProcurement(json, material)`; In-Transit lamp also lights from the IM snapshot (covers the "PO closed at 3PL GR" gap). Verified in preview (1003380 → PR/PO/IT all lit; gap case confirmed). Snapshot: `_rollback/APP-OPI-01-pre/`. **Not yet on Trace** (banner has no classifier) — fast follow-up.

## Shipped + pushed 2026-06-27 (Intake reuse fixes) — pending operator validation
- **APP-FIX-REUSE** — "Reuse common data" ignored the dataset checkboxes (root cause: a duplicate older `hydrateFromSavedIntake` shadowed the selective one via hoisting), so it loaded every source incl. User list when unchecked + force-inherited the assessment type. Fixed — only ticked datasets load. Also: a pasted manual list is now user-owned (`userEdited`) and never overwritten by an auto-fill.
- **APP-INT-XREF** — "Check cross-reference" button under the manual paste box: counts pasted materials found in MB51 / Inv Master / PR History + lists the ones missing per source.
- **APP-INT-DATE** — reuse picker shows each dataset's date + age and flags ⚠ stale (>90 days). Verified in preview (5-mat sample + a synthetic stale userList intake). Snapshot: `_rollback/APP-FIX-REUSE-pre/`.

## Shipped + pushed 2026-06-27 (origin `0f5aef9`) — pending operator validation
- **APP-Y-01** — Trace context banner shows material details (Manufacturer · current MRP/Min/Max/SS · SOH · P2 rate · Last consumption); Trace now runs the pipeline at boot (loads back-calc + pipeline) so values match Trend. All single-material Trace views.
- **APP-Y-02** — YoY trend indicators back to red/green >10%, blue within ±10%, with directional glyph + %.
- **APP-E27** — Trend detail: manufacturer in brackets after the description; id/desc column can grow to ~48% and wrap, pushing the Algorithmic Recommendation block right.
- **APP-FIX-SIGMA-PROC** — sigma outlier-trim keys off `totalToSite` (phases A–D) instead of full A–E; excludes phase E (Time to First Use). ⚠ changes which chains are flagged → exclusion counts + downstream averages may shift (intended). Snapshot: `_rollback/APP-YoY-Trend-pre/`. Verified in preview (5-mat sample, 142 PRs; zero console errors; Screener regression clean).

## Next planned
The 3-item build queue (APP-OPI-01 · APP-PD-SPREAD · APP-WU-01) is **all shipped** (see shipped sections above, all 2026-06-27, pending operator validation). Remaining follow-ups carried forward:
- **APP-WU-01/02 follow-ups** — the modal + per-cell drill shipped (APP-WU-02). Still open: per-cost-centre breakdown (needs a new MB51 cost-centre parser alias, additive, no schema bump); "Where used" button on the Trace views if wanted. Possible polish: the drill is "year cells only" per operator — revisit if row/total drill is later wanted; the user-manual §Where-used screenshots/wording aren't updated yet (manual touch deferred).
- **APP-OPI-01 follow-ups** — add the 3-lamp indicator to the Trace banner (no classifier pill there); decide whether to hide the all-dim indicator when a material has procurement history but nothing currently open.
- **APP-PD-SPREAD follow-up** — add the same +/- box spread to the YoY per-year "Total to site" chevrons.
- Pre-existing queue: **APP-SCR-02** (consolidate detail-panel CSS into `shared/material-detail.css`), **APP-E21b** (lazy `stockOnHandSeries`), **APP-E20** (below-min trigger list), **APP-E23/E5**, **APP-N-01**, **APP-T-05/T-06** (`leadTimes.json` D21).

## Shipped since the last Backlog update (newest first — see RoC for detail)

**2026-06-26 session — Trace deck + feedback fixes + doc refresh (origin `e407b1a` → `fd47cdc`, pending validation):**
- **APP-DOC-SCREENER** (`1ca4e92` + `fd47cdc`) — full doc refresh: `user-manual.html` gained a Screener section (§14) + Trace Phase-Distribution / Year-on-Year / release-date-quality updates; Roadmap moved the shipped deck out of "What's coming next" (counts → Shipped 68 · Pending 11) and added a "Shipped · 2026-06-26 session" slide; two stale Trace view-button tooltips corrected (`trace.html`).
- **APP-E24 + Trend rename** (`d817548`) — Analysis-page UX polish (4 touches) + visible "Analysis" → "Trend" relabel across all 8 shells (file/folder stays `analysis/analysis.html`).
- **APP-V03-PORT-6c** (`1402fd6`) — YoY layout: phase name as the heading, change comment underneath.
- **APP-FIX-REL-DATE** (`1402fd6`) — impossible PR release dates no longer fabricate a PR-Approval (phase A) time; shown n/a with an amber data-quality note (credibility principle).
- **APP-E-PD-RESTYLE + APP-V03-PORT-6b** (`27a8221` / `7e92fe1`) — Phase Distribution adopts the YoY box-plot look + total-average shared scale; YoY gains per-year total-timeline chevrons on a shared scale.
- **APP-FIX-SCR-EXCL** (`1380acd`) — Screener honours Trace's excluded chains when it computes average lead time.
- **APP-FIX-YOY-CALC** (`6092673`) — YoY now averages over completed chains (received POs), not all PRs incl. incomplete.
- **APP-V03-PORT-6** (`43f49b2`) — Trace Year-on-Year view ported from v0.3 (per-phase box plots compared across years).
- **APP-FIX-VOL-V03-PARITY** (`e407b1a`) — Trace Volume cumulative restored to v0.3's deliberate per-series styling.
- **APP-T-07** (`e407b1a`) — "Trace it!" one-click handoff from an Analysis material to Calibre Trace.

**Earlier (already on origin before this session):** APP-SCR-01/01b/01d (Screener page + PDF export + band overhaul, `966e045`/`dac65d8`), APP-FIX-BACKCALC-PARSE (critical — a stray `*/` had silently killed the whole back-calc app-wide for ~a month; fixed), APP-E8 (PD→V1 reclass), APP-DOC-MANUAL (manual rebuild), APP-FIX-VER (version-label sync — the stale `v2.0.0-dev` labels are gone), APP-FIX-PD-POLISH (uniform scale + transposed table + on-plot mean), APP-E9 (min-consumption-events screen), APP-FIX-PD-CHEVRON, README rebuild.

## Deferred / queued (still open)
- **APP-SCR-02** — consolidate the Analysis detail-panel CSS into `shared/material-detail.css` and link it from `analysis.html` (removing the moved rules from `analysis.css`), so the detail *styling* is single-source like the render *logic*. APP-SCR-01 deliberately left `analysis.css` untouched and duplicated the rules into the shared file (zero Analysis-CSS regression risk); this closes that gap. Verify Analysis renders identically after the move.
- **APP-E21b** — implement the memory-bloat reduction per the APP-E21 findings: drop the unused `cumulative` field (safe); MB51 column-prune at parse (needs a field-usage audit); **lazy `stockOnHandSeries`** (medium — only worth it if the now-active back-calc drags on the operator's large datasets). NOT safe: blanking `data.*` from the handoff (breaks the analysis re-run + Inv-Adj σ math).
- **APP-E20** — Below-min trigger list (F1 + V1/PD branches of the three-branch F2).
- **APP-E23 / APP-E5** — sticky nav, PowerBI-style filter UX.
- **APP-N-01 / APP-N-01b** — Dev Notes shared module (local-first, then GitHub sync).
- **APP-T-05 / APP-T-06** — remaining Trace SAP sources + the `leadTimes.json` Trace→Tune contract (D21).

## Open — needs reproduction (operator-reported)
- **Rare chart date-rendering glitch (2026-06-27, operator screenshots 1014869 + 1009607).** Operator saw a few Trend graphs where the X-axis dates "didn't render correctly" (circled the OCT/NOV region). **Could NOT reproduce** — those materials aren't in the LV test data, and LV charts render dates correctly (labels right, ticks evenly spaced). Did a principled **UTC hygiene fix** (`APP-FIX-CHART-TZ`: `monthTicks`/`fmtMonth` now use UTC getters, matching the app's UTC convention from APP-FIX-BACKCALC-TZ; aligns ticks to the UTC-parsed data + removes a DST edge case) — but measured the visible effect at **~1px**, so this is NOT the operator's symptom. **Next:** need a repro — one of those materials' MB51 rows or the actual extract, + which tick was wrong / what was expected. Prime suspect: a **non-ISO posting-date format** in that extract (e.g. with a time component, US M/D/Y, or no zero-pad) that `new Date()` misparses → data at the wrong X. (LV dates are all clean `YYYY-MM-DD`.)

## Needs an operator decision
- **APP-E8 PURPLE-PD nuance** — a Working-Redundant (PURPLE) PD item that carries a recommended Min/Max also gets the "reclassify to V1" flag/note on top of its "review for destocking" action. Confirm this is wanted, or scope the reclass flag to RED rule-6 only.

## Paused / parked (with reason)
- **COMPOSE-V0.1** — ⏸ PAUSED indefinitely (operator decision 2026-05-24): focus on maturing Tune + Trace. Two pre-build syncs (module sharing, `leadTimes.json` contract) pause with it. Design materials canonical in `_Hand-over docs/Compose - design/`.
- **APP-L-01+** — Deeper-Dive conversational LLM mode (design doc `_Hand-over docs/Calibre Deeper-Dive - design/`, 2026-05-18); not yet coded.
- **T9 (CDHDR/CDPOS), APP-T-08** — Trace future items.

## Resolved since the last update (cleared off the open lists)
- **APP-DOC-SCREENER** — done (this session). **APP-FIX-VOL-V03-PARITY · APP-V03-PORT-6 (+6b/6c) · APP-T-07 · APP-E24 · APP-FIX-PD-POLISH · APP-E9** — all shipped (see above). **Stale `v2.0.0-dev` version label** — fixed by APP-FIX-VER. **Push backlog** — all chunks pushed (origin `fd47cdc`).

## Environment notes (machine-specific)
- Auto-memory store (`~/.claude/projects/.../memory/`) and master plan (`~/.claude/plans/please-read-this-handover-iterative-falcon.md`) referenced by CLAUDE.md are **absent on this machine** — operator chose to leave them; orientation runs from CLAUDE.md + handovers + RoC instead.
- No Node in this environment → product-dev Gate 1 (`node --check`) substituted by a clean browser load; Python 3.12 available for corruption/JSON checks.
- **Preview tooling quirk (this session):** in the headless preview instance the viewport can be 0×0, `preview_screenshot` times out, and `preview_click` reports "success" but dispatches **no DOM click event** (verified: a capture-phase body listener saw 0 clicks). Verify interactions via `preview_eval` + DOM event dispatch / `element.click()` (geometry-independent, fires the same handlers) and read state back from the DOM. `preview_resize` to an explicit W×H (not the "desktop" preset, which reset to native 0×0) restores normal element geometry for measurements.

## Snapshots in this version folder
```
_rollback/<CHUNK>-pre/                    ← pre-edit copies per chunk (APP-T-07-pre, APP-FIX-VOL-V03-PARITY-pre,
                                            APP-V03-PORT-6-pre, APP-FIX-YOY-CALC-pre, APP-E-PD-RESTYLE-pre,
                                            APP-V03-PORT-6b-pre, APP-FIX-SCR-EXCL-pre, APP-FIX-REL-DATE-pre,
                                            APP-V03-PORT-6c-pre, APP-E24-TREND-pre, …)
record-of-change.html                     ← canonical changelog (one entry per chunk, newest first)
Backlog.md                                ← this file (forward-looking tracker)
```
Each shipped chunk also has its own remote `backup/pre-*` branch + `checkpoint/pre-*` tag (see RoC entries and CLAUDE.md for the exact names).
