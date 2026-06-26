# Calibre Tune v2.1.3-dev — Deferred items / next-version backlog

**Updated:** 2026-06-26 (after APP-SCR-01d Screener band overhaul — pushed origin `dac65d8`)
**Status:** Screener (APP-SCR-01) + operator-review refinements & PDF export (APP-SCR-01b) + the back-calc parse fix (APP-FIX-BACKCALC-PARSE) built, pushed to origin/main (`966e045`) after a remote backup, and **operator-validated 2026-06-26 ("working pretty well")**. More work to follow (see deferred/queued). Earlier 2026-06-25 work (APP-E8, APP-DOC-MANUAL, APP-FIX-VER, APP-FIX-PD-POLISH, APP-E21 investigation, APP-E9, APP-FIX-PD-CHEVRON, README rebuild) was already on origin (`f7063f9`).

**Update 2026-06-25 (batch 2):** APP-E8 (#21), APP-DOC-MANUAL + APP-FIX-VER pushed (origin `579cf99`). Then: **APP-FIX-PD-POLISH (#1)** built + verified (Trace Phase Distribution: uniform scale + transposed stats table + on-plot mean) — unpushed. **APP-E21 (#15)** investigation complete (findings + ranked reduction plan in RoC); reduction implementation queued as **APP-E21b** (deferred). **APP-E9 (#22)** not yet built — see below.

**Update 2026-06-25 (batch 3 · APP-SCR-01 — Screener):** Built the new **Screener** page (post-analysis band filter + combined Analysis+Trace detail). Load-bearing refactor: the Analysis detail render and the Trace phase-distribution render were extracted into shared modules (`shared/material-detail.js` + `shared/trace-phase.js`, single source of truth; `analysis.js` + `trace.js` refactored to consume them; `.pd-*` CSS moved to `shared/trace-phase.css`). Self-verified in the live preview (regression gate: Analysis + all Trace views render identically, zero console errors; Screener: bands filter, both visuals, persistence, graceful no-PR degradation). Repo reconciliation this session found **origin/main is `f7063f9`** (= `834fff8` + a README rebuild); CLAUDE.md's `834fff8` is **stale** and should be corrected.

**Update 2026-06-25 (batch 4 · operator review → APP-SCR-01b + APP-FIX-BACKCALC-PARSE):**
- **APP-FIX-BACKCALC-PARSE** — found + fixed a *shipped* parse error in `shared/inventory-back-calc.js` (a `*/` embedded in a comment from APP-FIX-BACKCALC-TZ / origin `2ae7b26`) that had **silently disabled the entire back-calc app-wide since 2ae7b26** — no Stock-on-Hand line, no stockout bands, no stockout-aware math on Analysis *or* Screener. Fixed (comment rephrased). SOH line + bands render again. Measured back-calc cost ≈32&nbsp;ms / 110 materials.
- **APP-SCR-01b** — operator-review refinements: vertical (stacked) combined detail on screen + print; widened shell; **new per-material PDF export** (one letter page each: chart + stats + MRP above a visual timeline chevron + named box plots), built from SVG→JPEG + jsPDF autoTable (no html2canvas), libs lazy-loaded on Export click.
- **Pushed to origin/main** (`966e045`) 2026-06-25 after a remote backup (`backup/pre-APP-SCR-01-f7063f9` branch + `checkpoint/pre-APP-SCR-01` tag). **Operator-validated 2026-06-26 ("working pretty well") — more work to follow.**

**Update 2026-06-26 (batch 5 · APP-SCR-01d — Screener band overhaul):** Per operator feedback on the Screener:
- **Phase-distribution table trimmed on screen** — hidden on the Screener via a CSS rule scoped to `#scrCellTrace .pd-stats-wrap`; the table code stays in `shared/trace-phase.js` and still renders on Trace (verified `display:block`/8 rows on Trace, `display:none` but in-DOM on Screener).
- **Bands removed:** Pattern, Reclass flag, Rec Min, Rec Max, Stock value (CAD).
- **Bands added:** PO status (Open/None), PR status (Open/None), a "SoH below" risk card (below P2 = <1 mo cover · below current SAP Min), and a "Min below lead-time cover" risk card (current SAP Min < P2/mo × avg procurement lead time in months). Risk-card checks OR within a card; cards AND with other bands.
- New per-material fields computed at boot via `TracePhase.computeChains` (PO/PR open status, avg lead time = mean phases A–D, Min-vs-lead-time). **Min comparisons use current SAP Min** (operator decision 2026-06-26). Unevaluable cases marked `NA` (not silently "not at risk"); PR-dependent cards hidden when no PR History. Stale persisted bands dropped on load.
- Built + browser-verified (5-material PR-bearing sample; zero console errors), then **pushed as `dac65d8`** (2026-06-26) after a remote backup (`backup/pre-APP-SCR-01d-966e045` branch + `checkpoint/pre-APP-SCR-01d` tag at `966e045`) + local snapshot `_rollback/APP-SCR-01d-pre/`. Pending operator validation. Files: `screener/screener.js`, `screener/screener.css`, `record-of-change.html`, `Backlog.md`.

## Deferred / queued (new)
- **APP-DOC-SCREENER** — add a Screener section to `user-manual.html` (the nav link is in place but the manual has no Screener page yet): bands, the combined detail, and the PDF export. User-facing doc; not a blocker for testing.
- **APP-SCR-02** — consolidate the Analysis detail-panel CSS into `shared/material-detail.css` and have `analysis.html` link it (removing the moved rules from `analysis.css`), so the detail *styling* is single-source like the render *logic*. APP-SCR-01 deliberately left `analysis.css` untouched and duplicated the rules into the shared file (zero Analysis-CSS regression risk); this closes that gap. Verify Analysis renders identically after the move.
- **APP-E21b** — implement the memory-bloat reduction per the APP-E21 findings: drop the unused `cumulative` field (safe); MB51 column-prune at parse (needs field-usage audit); lazy `stockOnHandSeries` (medium). NOT safe: blanking `data.*` from the handoff (breaks the analysis re-run + Inv-Adj σ math).
- **APP-E9 (#22)** — ✅ BUILT + verified (2026-06-25). Scoped down per operator to a simple screening parameter (no warnings panel, no toggles): `minEventsThreshold` (default 3) beside the qty threshold; event = WO (261) OR cost-centre (201) issue. canonical-schema + pipeline + settings + intake + manual. Unpushed at time of writing → see push status.

## Needs an operator decision
- **APP-E8 PURPLE-PD nuance** — A Working-Redundant (PURPLE) PD item that carries a recommended Min/Max now also gets the "reclassify to V1" flag/note, on top of its "review for destocking" action. Confirm this is wanted, or scope the reclass flag to RED rule-6 only.
- **Stale version label** — `index.html`, `intake.html`, `analysis.html` still show `v2.0.0-dev` (HTML comment + `<meta app-version>` + visible nav label); `trace.html` + RoC read `v2.1.3-dev`. Trivial 3-page tweak; held pending go-ahead (not bundled into APP-E8).
- **Push** — origin/main is now **`f7063f9`** (verified by clone this session; CLAUDE.md's `834fff8` is stale = `f7063f9` minus the README rebuild). The local working folder content-matches `f7063f9` except the APP-SCR-01 changes, so a push will be a clean, minimal diff. No push performed — awaiting explicit go-ahead. **Before pushing**, follow `_rollback/APP-SCR-01-ROLLBACK-PLAN.md` §3.0 (push the `backup/pre-APP-SCR-01-f7063f9` branch + `checkpoint/pre-APP-SCR-01` tag first) and exclude `_patch_tmp/` + `_rollback/` from the copy.

## Deferred to next version (carried from roadmap, operator-priority order)
- **APP-FIX-PD-POLISH** — Phase Distribution: uniform scale + transposed stats table + mean labels on plots (operator PPT 2026-05-26).
- **APP-FIX-VOL-V03-PARITY** — Volume cumulative: restore v0.3 colours/line-styles (operator PPT 2026-05-26).
- **APP-V03-PORT-6** — Trace Year-on-Year annual progression (port v0.3 `buildYoY()`).
- **APP-E20** — Below-min trigger list (F1 + V1/PD branches of three-branch F2).
- **APP-E21** — Intake→Analysis memory-bloat diagnosis (~15 MB at handoff for 10 materials).
- **APP-E9** — Events-vs-qty screening + consolidated pre-run warnings panel.
- **APP-N-01 / APP-N-01b** — Dev Notes shared module (local-first, then GitHub sync).
- **APP-T-05 / APP-T-06 / APP-T-07** — remaining Trace SAP sources, `leadTimes.json` contract (D21), "Trace it!" cross-page handoff.
- **APP-E23 / APP-E24 / APP-E5** — sticky nav, analysis-page UX polish, PowerBI-style filter UX.

## Paused / parked (with reason)
- **COMPOSE-V0.1** — ⏸ PAUSED indefinitely (operator decision 2026-05-24): focus on maturing Tune + Trace. Two pre-build syncs (module sharing, `leadTimes.json` contract) pause with it. Design materials canonical in `_Hand-over docs/Compose - design/`.
- **APP-L-01+** — Deeper-Dive conversational LLM mode (design doc `_Hand-over docs/Calibre Deeper-Dive - design/`, 2026-05-18); not yet coded.
- **T9 (CDHDR/CDPOS), APP-T-08** — Trace future items.

## Environment notes (machine-specific, 2026-06-25)
- Auto-memory store (`~/.claude/projects/.../memory/`) and master plan (`~/.claude/plans/please-read-this-handover-iterative-falcon.md`) referenced by CLAUDE.md are **absent on this machine** — operator chose to leave them; orientation ran from CLAUDE.md + handovers + RoC instead.
- No Node in this environment → product-dev Gate 1 (`node --check`) substituted by a clean browser load.

## Snapshots in this version folder
```
_rollback/APP-SCR-01-extract-pre/        ← pre-edit copies of every file APP-SCR-01 modifies
_rollback/RESTORE_APP-SCR-01.py          ← one-shot local restore (dry-run unless --confirm)
_rollback/origin-main-f7063f9-PREPUSH.zip ← immutable copy of the current live GH tree
_rollback/APP-SCR-01-ROLLBACK-PLAN.md    ← repo + local rollback procedure (anchor f7063f9)
_rollback/APP-E8-pre/                    ← rollback point for APP-E8
record-of-change.html                    ← APP-SCR-01 entry added at top
Backlog.md                               ← this file
```
