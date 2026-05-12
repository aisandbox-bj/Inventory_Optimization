# Handover Prompt — Inventory Optimization App

Paste this into a fresh Claude Code session to bring me up to speed on the project state. Don't edit — copy verbatim. Claude will read this, check the listed files, and confirm before doing anything.

---

## Context

I'm continuing work on the **Inventory Optimization App** — a browser-only single-file-per-page tool for mining MRO inventory optimization (consumption profiling, traffic-light Min/Max recommendations, LLM-reviewable Excel/PDF deliverables). It replaces a legacy Python-script + Excel-handoff workflow.

**Project lives at:** `C:\Users\Test_Home\Documents\Claude\Projects\Inventory Optimization\`

**Active working directory:** `App\v2\` (current development). `App\v1\` is frozen — do NOT edit. `App\archive\v1.1.0\` is a local snapshot of the final v1.

**GitHub repo:** [aisandbox-bj/Inventory_Optimization](https://github.com/aisandbox-bj/Inventory_Optimization) — repo root content mirrors `App/v2/`. Tags `v1.0.0` and `v1.1.0` preserve prior releases for rollback. `gh` CLI installed and authenticated as `aisandbox-bj`.

**Current version:** `v2.0.0-dev` (Mass LLM Review is the headline feature).

## Before doing anything

1. Read these in order — they are the source of truth:
   - `App\v2\record-of-change.html` — full changelog with rollback steps
   - `App\v2\user-manual.html` — operator manual with the analytical methodology
   - `App\v2\PLAN_v2.1.0.md` ★ — the **pending** v2.1.0 plan (LLM prompt tightening + PDF Pack UX + Operational Context library). Contains the threat model + durable LLM-boundary principles. **Read §0 in full — it codifies why we made specific decisions about data-egress to the third-party LLM.**
   - `App\v2\shared\canonical-schema.js` — JSON contract + parameter defaults
   - `App\v2\shared\pipeline.js` — the analytical engine (deterministic, no LLM)
2. Check my project memory at `C:\Users\Test_Home\.claude\projects\C--Users-Test-Home-Documents-Claude-Projects-Inventory-Optimization\memory\MEMORY.md` — it points to:
   - GitHub push pattern (clone-to-tmp, never `git init` in the working dir)
   - "Act, don't narrate" feedback note
   - Working-dir pointer to `App/v2/`
   - Skill architecture (analytical engine is pure Python/JS, LLM is orchestration-only)
3. After reading the above, **summarise what you found in one short paragraph** and ask what I want to work on next — do not start editing files until I've confirmed direction.

## Architectural sketch (so you don't need to reverse-engineer)

```
App/v2/
├── index.html                  Dashboard (recent intakes, "Clear session data" button)
├── record-of-change.html       The RoC — every release entry, rollback steps
├── user-manual.html            13-section operator manual ★
├── shared/
│   ├── canonical-schema.js     v1.0.0 schema, factory defaults, parameter descriptors
│   ├── storage.js              localStorage + IndexedDB transparent fallback
│   ├── locale.js               LOCAL-TIME helpers (NOT UTC) + CAD currency
│   ├── parsers.js              XLSX/CSV parsers + column-alias map (Material No., Part No., etc.)
│   ├── config.js               Settings r/w + prompt-template + clearSessionData()
│   ├── pipeline.js             Analytical engine — period rates, HCE, lumpy, traffic-light,
│   │                           Inv Adj detection, 10-rule decision tree (incl PURPLE/WR)
│   ├── chart.js                Inline SVG cumulative chart, PNG capture for LLM image input
│   ├── llm.js                  Provider-agnostic review (Anthropic + OpenAI), editable template
│   ├── mass-llm.js             Mass LLM orchestrator (sequential, cancel/pause/resume)
│   └── excel.js                ExcelJS workbook builder (per-bucket / combined / mass-review)
├── intake/
│   ├── intake.html  / .js / .css
│   │   Steps: 0 Assessment type → 1 Upload → 2 Schema → 3 DQ → 4 Scope (+4b Parameter Search)
│   │          → 5 Parameters → 6 Scope summary → 7 Review/Export.
│   │   Batch mode (v2.1): "Reuse common data" tile + modal to hydrate from saved intake.
│   │   Assessment Name is MANDATORY.
├── analysis/
│   └── analysis.html / .js / .css
│       Pipeline runner + bucket tabs + full-width material table with Excel-style filters
│       + material detail panel with chart + MRP-compare table + HCE/Inv-Adj tables
│       + 4 bulk operations: Inv Adj review, Mass LLM, PDF Pack, Export Excel
│       Right-click rows → mark for LLM review / mark for PDF print (state.marked.{review,pdf})
└── settings/
    └── settings.html / .js / .css
        Parameter defaults, LLM providers + keys + model fetch, prompt template editor,
        column-alias overrides, About / factory reset / wipe-all.
```

## Headline features as of v2.0.0-dev

- **Assessment types** (Step 0): UNIT/FLOC, User list (file OR paste — file is optional), Parameter Search
- **Scope modes**: fleet, manual, byClassification, byVendor, parameterSearch
- **Decision tree**: 10 rules including PURPLE = Working Redundant (PD with >6/12mo runway), few-events overlay (≤2 WOs → ORANGE)
- **Inv Adj detection**: 5σ daily-count detector → modal for operator confirmation → confirmed dates excluded from rate calculations
- **Mass LLM Review**: ≤50 materials per batch, sequential, wipe-on-close (no persistence by design — data security)
- **PDF Pack**: per-material A4 page (chart + stats + MRP comparison + HCE/Inv Adj tables) via jsPDF + autoTable
- **Right-click context menu** on material list: Mark for LLM review / Mark for PDF print / Open detail
- **Batch mode**: reuse common data (MB51/IW39/Fleet/Inv Master) from a saved intake without re-uploading; modal lets operator pick which datasets to hydrate
- **Locale**: every timestamp uses host-clock local time (not UTC); on-hand-value displayed in CAD currency
- **Dashboard** has a "Clear session data" button (wipes intakes, keeps Settings)

## Push protocol (DO NOT DEVIATE)

- **NEVER** run `git init` in `App/v2/`. The working folder is a plain folder, not a repo.
- Clone to `/tmp/push-Inventory_Optimization`, copy files from `App/v2/`, commit with explicit identity flags, push:
  ```
  git -C /tmp/push-Inventory_Optimization -c user.name='aisandbox-bj' -c user.email='aisandbox-bj@users.noreply.github.com' commit -am "..."
  ```
- Use `git add -A` for new files (so they aren't missed by `-am`).
- Tags are created on the final commit of a release, then `git push origin <tag>`.

## Things to NOT do without asking

- Schema-breaking changes (anything bumping `SCHEMA_VERSION` in `canonical-schema.js`) — confirm first.
- Deleting tags or force-pushing main.
- Touching `App/v1/` or `App/archive/*` — those are frozen records.
- Adding LLM-persistence to localStorage — mass review is in-memory-only by deliberate security design.
- **Widening the LLM prompt with free-form operator text without the guardrails described in `PLAN_v2.1.0.md` §A1 (fixed-pick library + capped optional Custom slot + privacy lint + preview button).** Free-form text crossing the browser → third-party-LLM boundary has historically been the easiest path to leak client identifiers.
- **Putting LLM-coupling metadata on the canonical JSON.** No `clientProfileId`, no LLM verdicts, no provider info. The math deliverable doesn't carry LLM metadata.
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
