# Calibre Tune v2.1.3-dev — Deferred items / next-version backlog

**Updated:** 2026-06-26 (after the Trace deck + operator-feedback fixes + the full doc refresh)
**Status:** origin/main = `fd47cdc` (will advance by one when this Backlog refresh is pushed). Everything from `966e045` onward is **pending operator validation** except the Screener trio (`966e045`), which was operator-validated 2026-06-26 ("working pretty well"). The canonical, blow-by-blow log is `record-of-change.html`; this file is the forward-looking tracker only.

## Built + verified locally — pending operator validation, NOT yet pushed (2026-06-27)
- **APP-Y-01** — Trace context banner shows material details (Manufacturer · current MRP/Min/Max/SS · SOH · P2 rate · Last consumption); Trace now runs the pipeline at boot (loads back-calc + pipeline) so values match Trend. All single-material Trace views.
- **APP-Y-02** — YoY trend indicators back to red/green >10%, blue within ±10%, with directional glyph + %.
- **APP-E27** — Trend detail: manufacturer in brackets after the description; id/desc column can grow to ~48% and wrap, pushing the Algorithmic Recommendation block right.
- **APP-FIX-SIGMA-PROC** — sigma outlier-trim keys off `totalToSite` (phases A–D) instead of full A–E; excludes phase E (Time to First Use). ⚠ changes which chains are flagged → exclusion counts + downstream averages may shift (intended). Snapshot: `_rollback/APP-YoY-Trend-pre/`. Verified in preview (5-mat sample, 142 PRs; zero console errors; Screener regression clean).

## Next planned (major feature — planning, not built)
- **APP-WU-01 — "Where used"** popup per material (consumption destinations). Needs IW39 (order→sortField); enriched by Fleet (sortField→model) for a Model rollup; 261 = WO/sort-field/model usage, 201 = cost-centre usage. Button on graph headers, live only when IW39 is loaded. Always show explicit "Unmapped WO / Unmapped model" buckets (never silently drop). **Operator decisions (2026-06-27):** CC = **single aggregate "Cost centre (CC)" bucket for v1** (per-CC breakdown — needs a new MB51 cost-centre parser alias, additive, no schema bump — deferred); window = **all-time, split into annual buckets** for the data's date range. Still open: reversal (262/202) netting; exact button placement (Trend chart header / Trace views / Screener). No SCHEMA_VERSION bump.

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
