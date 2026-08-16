# Handover Prompt — Calibre Tune (Inventory Optimization App)

Paste this into a fresh Claude Code session to bring me up to speed on the project state. Don't edit — copy verbatim. Claude will read this, check the listed files, and confirm before doing anything.

> **Note:** This file ships at the repo root (it mirrors `v2.1.5-dev/`). The richer, project-level session-start protocol lives in `CLAUDE.md` and `_Hand-over docs/` in the working folder — prefer those when the full project folder is available. This file is the orientation for a repo-only context.

---

> ## ⚠ Above everything else — never hide issues. Credibility is the key currency.
>
> Never describe a sidestepped symptom as "gone." Never frame a partial fix as complete. Every wrap-up must separate **what shipped** from **what still produces the symptom but was suppressed / re-anchored / queued.** Impossible values the operator sees (negative SOH, NaN, blank cells, suspicious zeros) are signals of a math/data assumption being wrong — investigate the cause; do not dim, filter, guard, or substitute. The full principle and the 2026-05-16 APP-E11 "Negative SOH gone" overclaim that prompted this rule live in auto-memory `feedback_never_hide_issues.md` (read it if the memory store is present — see note under "Before doing anything").

---

## Context

I'm continuing work on **Calibre Tune** (the Inventory Optimization App) — a browser-only single-file-per-page tool for mining MRO inventory optimization (consumption profiling, traffic-light Min/Max recommendations, LLM-reviewable Excel/PDF deliverables). It replaces a legacy Python-script + Excel-handoff workflow. Tune is one of three tools in the **Calibre Suite** (Tune · Trace · Compose).

**Project lives at:** `C:\Users\Test_Home\Documents\ClaudeCode\Projects\2026_05_12 - Inventory Optimization\`

**Active working directory:** `4 - Build Output\Inventory Optimization App\v2.1.5-dev\` (current development). Frozen — do NOT edit: `archive\v1 (frozen)`, `archive\v1.0.0`, `archive\v1.1.0`. Immediate rollback snapshot (pre-v2.1.5 bump): `4 - Build Output\Inventory Optimization App\v2.1.4-dev\`. Rollback snapshot of the last released tag: `4 - Build Output\Inventory Optimization App\v2.1.1\`.

**GitHub repo:** [aisandbox-bj/Inventory_Optimization](https://github.com/aisandbox-bj/Inventory_Optimization) — repo root content mirrors `v2.1.5-dev/` (excludes `_rollback/`). Tags `v1.0.0` / `v1.1.0` preserve prior releases for rollback. `gh` CLI authenticated as `aisandbox-bj`.

**Current version:** `v2.1.5-dev` (bumped from v2.1.4-dev on 2026-08-15; v2.1.4-dev frozen as the immediate rollback snapshot). **origin/main = `1d83614`** — the whole 2026-08-15 dev day pushed as three area-grouped commits on top of `57219eb` (Trace `0f342be` · Trend+shared `8d3f2ae` · Docs `74baea5`) plus a doc-accuracy follow-up `1d83614` (no SCHEMA_VERSION change). **The "16-Aug feedback pass" (2026-08-16) is pushed as `76b521f`** on top of `1d83614`; see `_Hand-over docs\Session handover - 2026-08-16 - 16-Aug feedback pass.md` (has the test procedure). **Status: pending operator off-repo validation.** Confirm the live tip against the **newest entry in `v2.1.5-dev\record-of-change.html`** — don't hard-pin a SHA in your head, it goes stale. Rollback for the 16-Aug pass: remote `backup/pre-feedback-0816` branch + `checkpoint/pre-feedback-0816` tag (both `1d83614`) + local `_rollback/FEEDBACK-0816-pre/`; `git revert 76b521f` undoes it. Last released tag: `v2.1.1`. Each chunk's pre-push tip also gets a remote `backup/pre-*` branch + annotated `checkpoint/pre-*` tag.

## Before doing anything

1. Read these in order — they are the source of truth:
   - `v2.1.5-dev\record-of-change.html` — full changelog with rollback steps (newest entry = current origin/main tip)
   - `v2.1.5-dev\user-manual.html` — operator manual with the analytical methodology
   - `v2.1.5-dev\PLAN_v2.1.0.md` ★ — the LLM-boundary plan: threat model + durable LLM data-security principles. **Read §0 in full — it codifies why we made specific decisions about data-egress to the third-party LLM.**
   - `v2.1.5-dev\shared\canonical-schema.js` — JSON contract + parameter defaults (SCHEMA_VERSION 1.0.0)
   - `v2.1.5-dev\shared\pipeline.js` — the analytical engine (deterministic, no LLM)
2. Project memory (if present on this machine) is at `C:\Users\Test_Home\.claude\projects\C--Users-Test-Home-Documents-ClaudeCode-Projects-2026-05-12---Inventory-Optimization\memory\MEMORY.md`. It records the GitHub push pattern, the "act, don't narrate" and "never hide issues" feedback rules, and "read source, don't rebuild from doc-comments". **Note: as of 2026-06-25 this memory store was not present at that path on the working machine — don't assume it loaded.**
3. After reading the above, **summarise what you found in one short paragraph** and ask what I want to work on next — do not start editing files until I've confirmed direction.

## Architectural sketch (so you don't need to reverse-engineer)

```
v2.1.5-dev/
├── index.html                  Dashboard (recent intakes + per-row delete, "Clear session data")
├── record-of-change.html       The RoC — every release entry, rollback steps
├── user-manual.html            Operator manual ★
├── shared/
│   ├── canonical-schema.js     v1.0.0 schema, factory defaults, parameter descriptors
│   ├── storage.js              localStorage + IndexedDB transparent fallback
│   ├── locale.js               LOCAL-TIME display helpers + CAD currency
│   ├── parsers.js              XLSX/CSV parsers + column-alias map (incl. Inventory Master Fiori + PR History)
│   ├── config.js               Settings r/w + prompt-template + clearSessionData()
│   ├── pipeline.js             Analytical engine — period rates, HCE, lumpy, traffic-light,
│   │                           Inv Adj detection, 10-rule decision tree (incl PURPLE/WR)
│   ├── inventory-back-calc.js  SOH back-calculation from MB51 + current snapshot (UTC day-keys)
│   ├── chart.js                Inline SVG chart (SOH line, stockout bands, per-event hover), PNG/JPEG capture
│   ├── material-detail.js      Shared detail render (chart+stats+MRP compare+For-Action/Analyst+Where-used) — Trend + Screener
│   ├── analyst-marks.js        Sidecar store for For-Action flags + Analyst Recommendation (NOT canonical JSON) — APP-ACT-01
│   ├── movement-detail.js      Per-material MB51 movement lists for chart-hover tooltips (APP-TREND-HOV)
│   ├── where-used.js           Consumption destinations by Fleet model × year + WO drill (APP-WU-01/02)
│   ├── trace-phase.js          Procurement-chain engine (computeChains) + phase-distribution render — Trace/Screener/lamps
│   ├── consumption-profile.js  Consumption histogram + profile helpers (Sandbox testbed)
│   ├── llm.js                  Provider-agnostic review (Anthropic + OpenAI), editable template
│   ├── mass-llm.js             Mass LLM orchestrator (sequential, cancel/pause/resume)
│   ├── client-context.js       Operational Context library (fixed-pick + capped Custom slot)
│   └── excel.js                ExcelJS workbook builder (per-bucket / combined / mass-review)
├── intake/   intake.html / .js / .css   (multi-step intake incl. PR History + multi-plant infra)
├── analysis/ analysis.html / .js / .css (pipeline runner, material table, detail panel, exports)
├── settings/ settings.html / .js / .css (params, LLM providers/keys, alias overrides, multi-plant toggle)
└── trace/    trace.html / .js / .css    Calibre Trace as a sibling page (D1) — procurement chain,
                                         phase distribution, procurement-flow funnel, volume cumulative
```

## Headline features as of v2.1.5-dev

- **"Everything on one screen" — one-screen review layout** (Phase 3, v2.1.5-dev): a **★ Action filter** chip (ANDs with the traffic-light filter), a **"Lead (mo)"** list column (avg total-to-site procurement lead time via the Trace engine; "—" without PR History), an **expandable stat grid** (always-shown primary block + a blue-triangle "More stats" block, state sticky across Prev/Next), **"Unit cost (CAD)"** from the Inventory Master moving-average price (replaces Stock value), a **floating draggable/resizable graph pop-out** (APP-ACT-04), Trace views re-ordered (**Phase Distribution** default) + a **"← Back to Trend"** round-trip link, and the Trend lead-time figure now **honours the operator's Trace outlier suppression** (APP-FIX-TREND-LT-SUPPRESS — `TracePhase.activeChains`, Screener parity). Plus review-screen tweaks APP-FIX-ACTHDR-STAR / -NOTES-DOCK / APP-TREND-LISTCOLS.
- **MRP Request Template + export/LLM split + Trace demand/cadence** ("no-test sprint", v2.1.5-dev): a **"⤓ MRP Request Template"** Excel (module `shared/mrp-request.js`) for ★ For-Action SAP materials — current / algorithmic-recommended / analyst MRP·Min·Max·Safety + SoH + unit cost + open reservations + where-used models + observed units + an **estimated unit population** (Manufacturer + base-model match over the Fleet register, carries a "verify against SAP" caveat) + Basis %; greys out with a plain reason unless Fleet Master + IW39 are loaded **and** ≥1 material is flagged (`pipeline.js` now carries `movingAvgPrice` + `totalReservation` per material). LLM-review tools split into their own collapsible panel above Exports; a **"Selected fleets ▾"** export scope (fleet picker with material + unit counts). Trace gains **open reservations** in the banner (APP-TRACE-DEMAND) + banner tidy (APP-FIX-TRACE-BANNER) + an **MRP-run cadence** view (APP-T-MRPFREQ). A **"See <7-digit>" jump** (APP-ACT-03) links in-pack material references. *Deferred (credibility): APP-MRP-REQ **Part A** (intake opt-in — the export-time grey already blocks the dead-end) and APP-ACT-02-CLEANUP (dead legacy-export-code deletion, left in place deliberately).*
- **Analyst review layer — For Action · Analyst Rec · Notes · save-reload · Prev/Next** (APP-ACT-01 + APP-ACT-02a + Phase 1, v2.1.5-dev): on Trend — a gold-★ **For Action** flag (right-click / detail-banner star / clicking the "Analyst" MRP header), an editable **Analyst Recommendation** 3rd column (V1/PD + free-text Min/Max/Safety, live only when flagged), a per-material **Notes** drawer docked on the right (✎ badge on note-bearing rows), and ‹ Prev / Next › list stepping. All stored in the **sidecar** `shared/analyst-marks.js` (localStorage per assessment — out of the canonical JSON, no SCHEMA_VERSION change) and **round-tripping in the exported JSON** (`_analystData` block: Canonical-dataset download embeds it, Intake upload restores it — analyst work + notes save/reload across machines). Flags + Analyst Rec also carry into the **PDF/Excel exports** via the collapsed format × scope grid (Full set / ★ For action / Selected fleets\* / Excel Full-pack vs Summary). *\*Selected-fleets scope = Phase 2b.* Note: **APP-FIX-ANALYST-KEY** fixed a bug where the sidecar was keyed off the undefined `metadata.name` (→ `_unnamed` collision); now `assessmentName` + a one-time migration.
- **Where used + intake data-needs flags + per-event stat/hover** (APP-WU-01/02, APP-INT-NEEDS-01, APP-TREND-PEC/-HOV): consumption destinations by Fleet model × year with WO drill; every upload flagged ★/☆/— per assessment type (nothing blocked); "Per event cons" stat + chart-hover movement tooltips.
- **Output-size deck** (APP-E3): opt-in "trim to materials in use" (54 MB export → ~4 MB), compact JSON download, PDF Pack at JPEG q0.65 + jsPDF compression (~4.7 MB/page → ~75 KB).
- **Stockout-aware consumption drop detection** (APP-E1): SOH back-calc, violet SOH line, red stockout wash bands, last-consumption marker, P2 stockout-anchored math, cause-aware LLM prompt.
- **Inventory Master migration to standard SAP Material Master (Fiori)** (APP-T-01) + plant as a real canonical field; multi-plant infrastructure phases 1–3 (detect / cross-file consistency / Settings opt-in, default OFF per D25).
- **PR History intake** (APP-T-02) — the functional intake link for Trace (`data.prHistory[]`, no schema bump).
- **Calibre Trace as a sibling page** (APP-T-03/T-04 + APP-V03-PORT-1→5) — faithfully ported from the v0.3 master after a read-the-source analysis pass.
- **Decision tree**: 10 rules incl. PURPLE = Working Redundant; few-events overlay (≤2 WOs → ORANGE).
- **Mass LLM Review** (in-memory only, wipe-on-close — security by design), **PDF Pack**, **Excel deliverables**, right-click mark-for-review / mark-for-print, batch "reuse common data".
- **Locale**: timestamps in host-clock local time for display; on-hand value in CAD. (Back-calc day-keys use UTC internally per APP-FIX-BACKCALC-TZ.)

## Push protocol (DO NOT DEVIATE)

- **NEVER** run `git init` in the working folder. It is a plain folder, not a repo.
- Clone to `/tmp/push-Inventory_Optimization`, copy files from `v2.1.5-dev/`, commit with explicit identity flags, push:
  ```
  git -C /tmp/push-Inventory_Optimization -c user.name='aisandbox-bj' -c user.email='aisandbox-bj@users.noreply.github.com' commit -am "..."
  ```
- Use `git add -A` for new files (so they aren't missed by `-am`).
- Annotated tags need identity flags too. Tags are created on the final commit of a release, then `git push origin <tag>`.

## Things to NOT do without asking

- Schema-breaking changes (anything bumping `SCHEMA_VERSION` in `canonical-schema.js`). D7 schema-bump is re-opened (now affects three tools) and needs operator approval.
- Deleting tags or force-pushing main.
- Touching `archive/*` or the `v2.1.1/` rollback snapshot — frozen records. Same for the Trace archive.
- Adding LLM-persistence to localStorage — mass review is in-memory-only by deliberate security design.
- **Widening the LLM prompt with free-form operator text without the guardrails in `PLAN_v2.1.0.md` §A1** (fixed-pick library + capped Custom slot + privacy lint + preview button).
- **Putting LLM-coupling metadata on the canonical JSON.** No `clientProfileId`, no LLM verdicts, no provider info.
- **Defaulting LLM commentary ON in client-facing deliverables (PDF / Excel).** Default OFF, opt-in per export, mandatory caveat banner when enabled.

## Durable data-security principles for LLM-adjacent work

(From `PLAN_v2.1.0.md` §0 — internalise these before changing anything LLM-related.)

1. Every byte added to the LLM prompt is a data-egress vector. Justify each addition.
2. Free-form operator text in Settings is a leak channel. Prefer fixed-pick lists.
3. The canonical-JSON / deliverable boundary does NOT carry LLM metadata.
4. Defaults bias toward safety (LLM-in-deliverable: default OFF).
5. Make outgoing data inspectable (a "Preview outgoing prompt" affordance beats trust-the-hash).
6. Don't bump SCHEMA_VERSION unless you have to.
7. The LLM annotates, the math decides.

## How to surface state quickly

- Last commit on origin/main: `git -C /tmp/push-Inventory_Optimization log --oneline -1 origin/main`
- Recent commits: same with `-5`
- Tags: `git -C /tmp/push-Inventory_Optimization tag -l`

---

When you've read the above, reply with:
1. One-paragraph summary of where the project sits
2. A short list of what you'd recommend tackling next (3 max) — or ask me what I want
3. Any clarifying questions

Don't write code yet.
