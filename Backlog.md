# Calibre Tune v2.1.3-dev — Deferred items / next-version backlog

**Updated:** 2026-06-25 (after APP-E8 · MRP type vs Min/Max applicability)
**Status:** APP-E8 built + self-verified (synthetic pipeline run + live UI render). **Pending operator validation** and a decision to push. The user manual (`user-manual.html`) was also rebuilt to the full v2.1.3-dev surface (APP-DOC-MANUAL) — adds Settings reference + Calibre Trace sections, stock-on-hand methodology, APP-E8 reclass.

**Update 2026-06-25 (batch 2):** APP-E8 (#21), APP-DOC-MANUAL + APP-FIX-VER pushed (origin `579cf99`). Then: **APP-FIX-PD-POLISH (#1)** built + verified (Trace Phase Distribution: uniform scale + transposed stats table + on-plot mean) — unpushed. **APP-E21 (#15)** investigation complete (findings + ranked reduction plan in RoC); reduction implementation queued as **APP-E21b** (deferred). **APP-E9 (#22)** not yet built — see below.

## Deferred / queued (new)
- **APP-E21b** — implement the memory-bloat reduction per the APP-E21 findings: drop the unused `cumulative` field (safe); MB51 column-prune at parse (needs field-usage audit); lazy `stockOnHandSeries` (medium). NOT safe: blanking `data.*` from the handoff (breaks the analysis re-run + Inv-Adj σ math).
- **APP-E9 (#22)** — ✅ BUILT + verified (2026-06-25). Scoped down per operator to a simple screening parameter (no warnings panel, no toggles): `minEventsThreshold` (default 3) beside the qty threshold; event = WO (261) OR cost-centre (201) issue. canonical-schema + pipeline + settings + intake + manual. Unpushed at time of writing → see push status.

## Needs an operator decision
- **APP-E8 PURPLE-PD nuance** — A Working-Redundant (PURPLE) PD item that carries a recommended Min/Max now also gets the "reclassify to V1" flag/note, on top of its "review for destocking" action. Confirm this is wanted, or scope the reclass flag to RED rule-6 only.
- **Stale version label** — `index.html`, `intake.html`, `analysis.html` still show `v2.0.0-dev` (HTML comment + `<meta app-version>` + visible nav label); `trace.html` + RoC read `v2.1.3-dev`. Trivial 3-page tweak; held pending go-ahead (not bundled into APP-E8).
- **Push** — local dev tip was confirmed in sync with origin/main (`2ae7b26`) before APP-E8; APP-E8 is now the only unpushed change. No push performed — awaiting explicit go-ahead per session instruction.

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
_rollback/APP-E8-pre/   ← rollback point for APP-E8 (pipeline.js, analysis.js/.css, excel.js, llm.js, RoC)
record-of-change.html   ← APP-E8 entry added at top
Backlog.md              ← this file
```
