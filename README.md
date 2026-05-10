# Inventory Optimization App

Browser-based, single-file-per-page app for mining MRO inventory optimization. Replaces a Python-script + Excel-handoff workflow with a self-contained tool: drop SAP exports, validate, scope, parameterize, build a canonical JSON, run analysis, review, export.

Architecture follows the NumaCore Lens shape — front-end shell loading modular engine HTMLs as needed. This is a separate service offering, not part of the Lens suite. Brand language is consistent.

## Status

**v1.0 — Phases 1–3 built (intake + settings + shell). Phase 4 (analysis engine + LLM review) is next.**

| Phase | Component | Status |
|---|---|---|
| 1 | Foundations (`shared/*`) | ✓ done |
| 2 | Intake engine | ✓ done |
| 3 | Settings tab + dashboard shell | ✓ done |
| 4 | Analysis engine + LLM review surface + Excel export | placeholder stub only |

## Structure

```
App/v1/
├── index.html                  Dashboard / launchpad
├── shared/
│   ├── brand-tokens.css        NumaCore-aligned palette, typography, panel grammar
│   ├── canonical-schema.js     v1.0.0 schema, factory defaults, validators
│   ├── storage.js              localStorage + IndexedDB transparent fallback
│   ├── parsers.js              XLSX/CSV → canonical with column-alias auto-mapping
│   └── config.js               Settings read/write helpers
├── intake/
│   ├── intake.html             Six-step workflow (upload → schema → DQ → scope → params → export)
│   ├── intake.js               All steps wired, DQ gate ports the existing Python data-quality logic
│   └── intake.css
├── settings/
│   ├── settings.html
│   ├── settings.js             Parameter defaults, dynamic LLM model fetch, alias overrides
│   └── settings.css
└── analysis/
    └── analysis.html           Stub — confirms intake → analysis JSON handoff
```

## Canonical JSON contract (v1.0.0)

The intake engine writes a canonical JSON; the analysis engine consumes it. Schema lives in [`shared/canonical-schema.js`](shared/canonical-schema.js).

```json
{
  "schemaVersion": "1.0.0",
  "metadata":   { "assessmentName", "createdAt", "createdBy", "appVersion" },
  "scope":      { "mode": "fleet|manual|byClassification|byVendor", … },
  "parameters": { "minMaxMethod", "p1Start", "p1End", "p2Months", "minMonths", "maxMonths",
                  "threshold", "hcePctThreshold", "hceMultThreshold",
                  "lumpyCvThreshold", "lumpyTopWoThreshold" },
  "data":       { "mb51", "iw39", "fleetMaster", "inventoryMaster",
                  "materialVendor"?, "leadTimes"? },
  "validation": { "passed", "issues" }
}
```

## Scope modes

Four exclusive modes in v1 (composition is a roadmap item):

- **fleet** — multi-select fleet models. Filters MB51 through IW39 work orders to fleet-relevant transactions only.
- **manual** — paste a list of material numbers.
- **byClassification** — filter Inventory Master by Inventory Type, MRP classifier, and movement-amount range. Logical AND.
- **byVendor** — multi-select vendors. Requires a Material → Vendor mapping file (uploaded in Step 1 when this mode is active).

## Running it

Open `index.html` in Chrome or Edge. Drag SAP exports into the intake page. CDN-loaded SheetJS + PapaParse parse XLSX/CSV; the rest is vanilla JS.

For features that hit external APIs (LLM model-list fetch in Settings), serve over HTTP rather than `file://`:

```bash
cd App/v1
python -m http.server 8000
```

## Design references

- **NumaCore Lens** — architectural shape (front-end shell + modular engine HTMLs)
- **Birchwood Advisory brand pack** — palette, typography, panel grammar
- The four Python scripts in the parent project (`scripts/01_data_quality.py` … `04_mrp_analysis.py`) are the analytical spec; the JS port preserves their rule semantics line-for-line.

## Roadmap

- **Phase 4** — analysis engine, chart rendering, LLM review surface, Excel export via ExcelJS
- **Lead-time + safety-stock-driven Min/Max** — when per-material lead-time data is available, switch from `monthsBased` to `leadTimeBased` in Settings
- **Scope composition** — fleet × byClassification, vendor × byClassification, etc.
- **Per-bucket parameter overrides** — different min/max-months per fleet model
- **Cross-mine benchmarking** — read-only across saved assessments
