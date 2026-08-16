# Calibre Tune — Inventory Optimization App

Browser-only, single-file-per-page app for mining MRO inventory optimization. Replaces a Python-script + Excel-handoff workflow with a self-contained tool: drop SAP exports → validate → scope → parameterise → build a canonical JSON → run the deterministic analysis → review per-material → export (Excel / PDF / JSON). An optional LLM second opinion **annotates only** — it never changes the math.

Calibre Tune is one of three tools in the **Calibre Suite** (Tune · Trace · Compose). Trace now ships as a sibling page inside this app; Compose is paused.

## Status

**v2.1.5-dev** — current dev tip (v2.1.4-dev now frozen as the rollback snapshot); last released tag `v2.1.1` (roll back with a clone + `git checkout v2.1.1`). Canonical `SCHEMA_VERSION` = `1.0.0`, `APP_VERSION` = `2.1.5-dev`. **origin/main = `1d83614`** (the whole 2026-08-15 dev day pushed as three area-grouped commits — Trace `0f342be` · Trend+shared `8d3f2ae` · Docs `74baea5` — plus a doc-accuracy follow-up `1d83614`; no SCHEMA_VERSION change). **The "16-Aug feedback pass" (2026-08-16) is BUILT + browser-verified clean but NOT yet pushed** — it sits on top of `1d83614` in the working folder, awaiting push approval (toggle fix · cadence per-material · lead-time in DAYS + colour + the Trend/Screener/Sandbox calc tie-up · banner 3-col · fleet cross-fleet · MRP-template tweaks · dashboard Upload-JSON · notes-drag · pop-out aspect/notes-grow · sandbox analyst). All work is **pending operator off-repo validation** (test procedure in the handover folder). Full history + rollback steps live in [`record-of-change.html`](record-of-change.html); operator manual in [`user-manual.html`](user-manual.html).

Highlights since v1.x:
- **"Everything on one screen" — one-screen review layout** (Phase 3, v2.1.5-dev). On Trend: a **★ Action filter** chip (ANDs with the traffic-light filter), a **"Lead (mo)"** list column (avg total-to-site procurement lead time from the Trace engine; "—" without PR History), an **expandable stat grid** (always-shown primary block + a blue-triangle "More stats" block whose state sticks across Prev/Next), a **"Unit cost (CAD)"** cell from the Inventory Master moving-average price (replaces Stock value; "—" when absent), and a **floating, draggable, resizable graph pop-out** (APP-ACT-04, full detail + Notes, Prev/Next, close via ✕/backdrop/Esc). Trace views are re-ordered (**Phase Distribution** now default) with a **"← Back to Trend"** round-trip link. The Trend lead-time figure **honours the operator's Trace outlier suppression** (manual excludes + sigma), so suppressing a PO in Trace moves the number on return.
- **MRP Request Template + export/LLM split** (APP-MRP-REQ Part B + APP-ACT-02b, v2.1.5-dev). A **"⤓ MRP Request Template"** Excel export (module `shared/mrp-request.js`) for the ★ For-Action SAP materials — current / algorithmic-recommended / analyst MRP·Min·Max·Safety, stock on hand, unit cost, open reservations, where-used models, observed units, an **estimated unit population** (Manufacturer + base-model match over the Fleet register, carrying a "verify against SAP" caveat — never presented as exact), and Basis %. It greys out with a plain reason unless Fleet Master + IW39 are loaded **and** at least one material is flagged. The LLM-review tools split into their own collapsible panel above Exports, and a **"Selected fleets ▾"** export scope (fleet checkbox picker with material + unit counts) joins Full set / ★ For action. Trace gains **open reservations** in the banner (APP-TRACE-DEMAND; "—" when absent) and an **MRP-run cadence** view (APP-T-MRPFREQ — MRP-created PRs per Day/Week/Month, split Converted-to-PO / Cancelled / Open).
- **Analyst review layer — For Action · Analyst Recommendation · Notes · save/reload** (APP-ACT-01 + APP-ACT-02 + Phase 1, v2.1.5-dev). On Trend: a gold-★ **For Action** flag (right-click / detail-banner star / clicking the "Analyst" MRP header); an editable **Analyst Recommendation** 3rd column (V1/PD + free-text Min/Max/Safety, live only when flagged); a per-material **Notes** drawer docked on the right (✎ badge on note-bearing rows); and ‹ Prev / Next › list stepping. All of it is stored in a **sidecar** (`shared/analyst-marks.js`, localStorage per assessment — out of the canonical JSON, no schema bump) and **round-trips inside the exported JSON** (a co-packaged `_analystData` block: the Canonical-dataset download embeds it, Intake upload restores it — so analyst work + notes save & reload across machines). The flags + Analyst Rec also carry into the **PDF/Excel exports** (flagged items only) via the collapsed **format × scope** export grid (Full set / ★ For action / Selected fleets; Excel Full-pack vs Summary).
- **Stockout-aware drop detection** (APP-E1) — stock-on-hand back-calc from MB51, violet SOH line + red stockout wash bands on the chart, and a stockout-driven-vs-genuine-demand-drop classifier.
- **Inventory Master → standard SAP Material Master (Fiori)** (APP-T-01) + multi-plant detection/consistency infra; **PR History intake** (APP-T-02).
- **Calibre Trace** ported in as the `trace/` sibling page (APP-T-03/T-04 + APP-V03-PORT-1→6) — procurement-chain swimlane + funnel, phase-distribution box plots (mean line + total-average shared scale) + lead-time chevron, volume cumulative, **year-on-year** per-phase comparison, raw data; a **"Trace it!"** button jumps from a material on the Trend page straight into Trace (APP-T-07).
- **Intake data-needs flags** (APP-INT-NEEDS-01) — every upload is flagged ★ required / ☆ optional-unlocks-a-feature / — not used per assessment type; nothing is blocked, so IW39/Fleet can feed "Where used" on any run.
- **Where used** (APP-WU-01/02) — consumption destinations by Fleet model × year (net of reversals) in a modal, with click-to-drill into the underlying work orders.
- **Per-event stat + chart hover** (APP-TREND-PEC / -HOV) — "Per event cons" (mean ± std units/event) and hover-a-point-to-see-that-day's-movements on both the consumption and stock lines.
- **Output-size deck** (APP-E3) — opt-in "trim to materials in use" (a real 54 MB export → ~4 MB) + compact JSON + PDF Pack at JPEG q0.65 + jsPDF compression (~4.7 MB/page → ~75 KB).
- **MRP type vs Min/Max** (APP-E8) — recommend PD→V1 when a Min/Max is warranted (PD can't hold Min/Max); filterable "Reclass" column.
- **Screener** (APP-SCR-01) — post-analysis band filter (category / numeric / procurement-risk bands incl. PO-open, PR-open, and Min-below-lead-time-cover) that shows the Trend consumption detail + the Trace phase distribution together per material, with a per-material PDF export.
- **Critical fix** (APP-FIX-BACKCALC-PARSE) — a stray `*/` in a comment had silently disabled the entire stock-on-hand back-calc app-wide for ~a month; restored, so the SOH line, stockout bands, and stockout-aware Min/Max math run again.

## Pages

```
index.html              Dashboard (recent intakes, per-row delete, clear-session)
intake/                 Upload → schema-map → DQ gate → scope → parameters → review → export
analysis/               Trend — pipeline runner + material list + detail panel (chart + MRP/reclass + For-Action ★ + Analyst Rec + Prev/Next) + Excel/PDF/JSON + Mass LLM  (nav label is "Trend"; folder stays analysis/)
trace/                  Calibre Trace — procurement-chain timeline (reads PR History + MB51): Procurement Chain · Phase Distribution · Volume · Year-on-Year · Raw Data
screener/               Screener — post-analysis band filter -> combined Trend + Trace detail per material + per-material PDF export
settings/               Parameter defaults, LLM providers/keys, Operational Context, prompt template, alias overrides, multi-plant toggle, maintenance
record-of-change.html   Full changelog + rollback steps
user-manual.html        Operator + engineering manual
```

## Shared engine (`shared/`)

```
canonical-schema.js   Schema, FACTORY_DEFAULTS, PARAMETER_DESCRIPTIONS (SCHEMA_VERSION 1.0.0, APP_VERSION 2.1.5-dev)
storage.js            localStorage + IndexedDB transparent fallback
analyst-marks.js      Sidecar store for For-Action flags + Analyst Recommendation + Notes (localStorage per assessment; round-trips in the JSON's _analystData block) — APP-ACT-01 + Phase 1
locale.js             Local-time display helpers + CAD currency
parsers.js            XLSX/CSV parsers + column-alias map (MB51 / IW39 / Fleet / Inventory Master Fiori / PR History)
config.js             Settings read/write + prompt template + clearSessionData()
inventory-back-calc.js  Stock-on-hand back-calc from MB51 (UTC day-keys) → SOH series + stockout windows (APP-E1)
pipeline.js           Deterministic analytical engine — period rates, per-event/batch stats, HCE, lumpy/smooth, Inv-Adj detection, 10-rule traffic-light tree, Min/Max + MRP reclass, screens
material-detail.js    Shared material-detail render (chart + stats + MRP compare + For-Action/Analyst + Where-used modal) — single source of truth for Trend + Screener
chart.js              Inline SVG chart (cumulative + SOH line + stockout bands + markers + per-event hover), PNG/JPEG capture for LLM + PDF
movement-detail.js    Per-material MB51 movement lists for the chart-hover tooltips (APP-TREND-HOV)
where-used.js         Consumption destinations by Fleet model × year + per-cell work-order drill (APP-WU-01/02)
trace-phase.js        Procurement-chain engine (computeChains) + phase-distribution render, shared by Trace + Screener + open-procurement lamps
consumption-profile.js  Consumption histogram + profile helpers (Sandbox testbed)
llm.js / mass-llm.js  Provider-agnostic single + batch review (Anthropic / OpenAI); in-memory only
client-context.js     Operational Context library (fixed-pick + capped 300-char custom slot, privacy-linted)
excel.js              ExcelJS workbook builder (per-bucket / combined / mass-review)
brand-tokens.css      Palette, typography, panel grammar
```

## Canonical JSON contract (v1.0.0)

Intake writes it; Analysis + Trace consume it. Schema in [`shared/canonical-schema.js`](shared/canonical-schema.js).

```json
{
  "metadata":   { "assessmentName", "createdAt", "uploadedAt", "createdBy", "appVersion" },
  "scope":      { "mode": "fleet|manual|byClassification|byVendor|parameterSearch", … },
  "parameters": { "minMaxMethod", "p1Start", "p1End", "p2Months", "minMonths", "maxMonths",
                  "threshold", "minEventsThreshold", "hcePctThreshold", "hceMultThreshold",
                  "lumpyCvThreshold", "lumpyTopWoThreshold", "invAdjSigmaThreshold",
                  "invAdjConfirmedDates", "wrSoftMonths", "wrHardMonths", "wrMrpTypes",
                  "socBackCalcMonths" },
  "data":       { "mb51", "inventoryMaster", "iw39"?, "fleetMaster"?,
                  "materialVendor"?, "leadTimes"?, "prHistory"? },
  "validation": { "passed", "issues" }
}
```

## Scope modes

- **fleet** — multi-select fleet models; MB51 filtered through IW39 work orders to fleet-relevant transactions (one bucket per model + a MULTI bucket).
- **manual** — paste material numbers OR work orders (auto-detect + override; APP-E22).
- **byClassification** — Inventory Type ∈ {…} AND MRP classifier ∈ {…} AND movement amount in range (logical AND).
- **byVendor** — multi-select vendors (requires a Material → Vendor mapping); one bucket per vendor + MULTI.
- **parameterSearch** — PowerBI-style filter builder over Inventory Master attributes + MB51 movement.

## Screening

A material qualifies for analysis only if net consumption ≥ `threshold` (default 10) **AND** distinct consumption events ≥ `minEventsThreshold` (default 3; APP-E9). Both are editable in Settings and per-run in intake Step 5.

## Running it

Serve over HTTP (CORS for LLM model-list fetch + multi-page features):

```bash
cd "4 - Build Output/Inventory Optimization App/v2.1.5-dev"
python -m http.server 8000
# open http://localhost:8000/intake/intake.html
```

CDN-loaded SheetJS + PapaParse parse XLSX/CSV; jsPDF + autoTable for the PDF Pack; ExcelJS for workbooks; the rest is vanilla JS.

## Repo / rollback

Pushes to GitHub `aisandbox-bj/Inventory_Optimization` (this repo root mirrors `v2.1.5-dev/`, excluding `_rollback/`). Per-change rollback snapshots live in `_rollback/`; the last released tag is `v2.1.1`, and the pre-push tip of each chunk gets a remote `backup/pre-*` branch + `checkpoint/pre-*` tag. Push protocol (clone-to-tmp, identity flags) is documented in `HANDOVER.md`.

## Design references

- **NumaCore Lens** — front-end-shell + modular-page architectural shape.
- The four Python scripts in `3 - Source Tools/Legacy Python pipeline/` are the analytical spec; the JS port preserves their rule semantics.
