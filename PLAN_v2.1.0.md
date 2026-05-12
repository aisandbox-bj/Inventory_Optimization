# Plan — v2.1.0: Tighter LLM Reviews + PDF Pack Selection UX

> **Status:** Pending — build after v2.0.0 ships (manual testing in progress).
> **Predecessor:** v2.0.0-dev (mass LLM review, PDF pack via right-click marks, batch mode for reuse).
> **Read this with:** [`record-of-change.html`](record-of-change.html), [`user-manual.html`](user-manual.html), [`HANDOVER.md`](HANDOVER.md).

---

## 0 · Why this plan exists — and why it's tighter than the first draft

The first draft of this plan (which proposed a free-form **Client Profile** with `fleetTypes`, `seasonalNotes`, `priorities`, import / export, per-intake override, and LLM commentary on by default in the client PDF) was a **silent data-security regression** from v2.0.0. Documenting the reasoning here so it doesn't get lost on a fresh context.

### Threat model (v2.0.0 baseline → v2.1.0 target)

The app sends data to a third-party LLM provider (Anthropic / OpenAI) on every review. The boundary matters:

| Boundary crossing | v2.0.0 behaviour | What we MUST preserve |
|---|---|---|
| **Browser → LLM provider** | Sends: material number, description, stats, recommendation, chart PNG. <br>No client identifiers. | Keep the prompt **generic by default**. Any additional context is opt-in, capped, and visible to the operator BEFORE it leaves the browser. |
| **Browser → localStorage** | Stores: parameter defaults, LLM API keys, prompt template, column aliases. <br>**No LLM review results**, **no per-intake client metadata**. | Session-only state stays session-only. Don't smuggle LLM-related metadata into the canonical JSON contract. |
| **Browser → canonical intake JSON** | Schema v1.0.0 — math + raw data. No LLM annotations, no client profile, no LLM keys. | The JSON is the math deliverable. Adding LLM-coupling fields breaks portability (intake from machine A on machine B) and creates implicit client-identification on a file that gets emailed around. |
| **Browser → Excel / PDF client deliverable** | Excel: math only. PDF (v2.0): math only by default; mass-LLM JSON / Excel is a separate opt-in artefact, downloaded then wiped on close. | Client deliverables get LLM commentary **only by explicit opt-in per export**, with a visible caveat that it's model-generated. |
| **Mass LLM session** | In-memory only. Wipe-on-close. No localStorage / IndexedDB writes for review data. | Don't loosen. |

### Durable principles for any future LLM-adjacent feature

These belong in our memory and the handover prompt:

1. **Every byte added to the LLM prompt is a data-egress vector.** Justify each addition by the actionability it produces.
2. **Free-form operator text in Settings is a leak channel.** Prefer fixed-pick lists. If free-form is needed, cap the length, lint for likely client-identifying patterns, and surface it for verification before send.
3. **The canonical-JSON / deliverable boundary does not carry LLM metadata.** Profile selection is a session UI choice, not a serialised field.
4. **Defaults bias toward safety.** "Include LLM commentary in PDF" defaults to OFF, not ON. Auto-upgrades of saved prompts default to "notify + diff", not "silently replace".
5. **Make outgoing data inspectable.** A "Preview outgoing prompt" affordance in Settings beats trust-the-hash for verifying nothing has leaked.
6. **Don't bump SCHEMA_VERSION unless you have to.** Additive-optional fields are fine; LLM-coupling fields are not.
7. **The LLM annotates, the math decides.** Verdicts can change colour pills in a UI; they cannot change the deterministic Min/Max recommendation.

### What v2.0.0 got right that we keep

- Chart PNG goes to the LLM (good — multimodal, no client codes in image)
- Mass review wipe-on-close (good — no persistence of LLM data)
- Prompt template hash recorded in mass-review JSON (good — audit trail)
- LLM provider keys + chosen model in Settings only (good — Settings ≠ deliverable)

### What v2.0.0 falls short on (the real targets for v2.1.0)

- **LLM responses are wordy and neutral**, don't flag the most operator-actionable signals (negative net consumption, steep rate drops, spike-without-HCE, long flat tails).
- **No structured response**, just prose `notes`. Hard to filter / aggregate.
- **PDF Pack selection is coarse** — right-click rows only, no filter-and-bulk-mark.
- **PDF Pack doesn't carry LLM verdicts** — Mass-LLM run sits in memory, but the PDF deliverable can't pull from it.
- **No on-screen indication** of which rows have already been LLM-reviewed.

---

## 1 · Scope

### A. LLM prompt — structured signals + minimal generic context

**A1 · `shared/context-library.js`** (new file, fixed-pick list, no free-form profiles)
- Exports a static `CONTEXT_LIBRARY` — small set of pre-written, generic operational blurbs (no client / fleet / vendor / site identifiers):
  ```js
  const CONTEXT_LIBRARY = [
    { id:'none',           label:'No context',
      context:'' },
    { id:'mining-surface', label:'Mining — surface MRO',
      context:'Surface mining MRO inventory. Fleet-driven consumption with seasonal access constraints. Reliability prioritised over working capital.' },
    { id:'mining-uground', label:'Mining — underground MRO',
      context:'Underground mining MRO inventory. High consumption variability driven by ground conditions. Long replenishment lead times.' },
    { id:'generic-mro',    label:'Generic heavy-industry MRO',
      context:'Heavy-industry MRO spares inventory. Mix of scheduled-maintenance and breakdown-driven consumption.' }
  ];
  ```
- **Single "Custom (advanced)" slot** allowed via a Settings toggle. When enabled:
  - 300-char hard cap
  - Inline warning: "*Do NOT include client / site / vendor / equipment-serial names. This text is sent verbatim to a third-party LLM.*"
  - Regex-based privacy lint on Save — flags strings matching common client-identifier shapes (8-digit material numbers in sequence, "Ltd / Inc / Corp", probable vendor codes, mine / site names per a small block-list of obvious red flags). Warn, don't block.
- **No import / export** — removes file sprawl. Reduces attack surface.
- **Active selection is session-only.** Stored on `state` in memory; never persisted to localStorage, never written to the canonical JSON. Reset to "No context" on page reload.

> **Why fixed-pick over free-form:** the field operators have access to is the leak channel. A dropdown with 4 generic options cannot leak client identifiers. A textarea inevitably does. v2.0.0 took zero context at all; v2.1.0 should add the minimum needed for actionability, no more.

**A2 · `shared/llm.js` — `buildContext()` additions** ([llm.js:30-61])
- Inject `{customerContext}` from the active library entry (or empty string for "No context").
- Add new interpolation fields (sourced from the pipeline output A4):
  - `{netSign}` — `"POSITIVE"`, `"NEGATIVE (returns dominate)"`, or `"MIXED"`
  - `{rateDropFlag}` — `"SHARP DROP"` if P2 ≤ 0.6 × P1, else empty
  - `{rateRiseFlag}` — `"SHARP RISE"` if P2 ≥ 1.6 × P1, else empty
  - `{invAdjCount}` — count of operator-confirmed Inv-Adj exclusion dates
  - `{daysSinceLastIssue}` — int, or `"no issues in window"`

**A3 · Prompt restructured to structured-signals schema** ([config.js:20-67])

Replace prose with a machine-readable response schema. Tighter, more actionable, lower tokens, easier to filter on downstream:

```
Material {material} ({description}) — bucket {bucket}.
Algorithm verdict: {trafficLight} — {action}
Stats: P1={p1Rate}/mo  P2={p2Rate}/mo  total={totalNet}
       runway={runway}mo  pattern={pattern}  woCount={woCount}
       netSign={netSign}  rateChange={rateChange}  {rateDropFlag}{rateRiseFlag}
HCE-P2: {hceText}     Inv-Adj dates excluded: {invAdjCount}
Days since last issue: {daysSinceLastIssue}

Look at the attached chart. Reply ONLY with this JSON, no prose:
{
  "signals": {
    "negativeNet":     boolean,   // returns dominate issues?
    "sharpRateDrop":   boolean,   // P2 ≤ 0.6·P1?
    "sharpRateRise":   boolean,   // P2 ≥ 1.6·P1?
    "spikeWithoutHCE": boolean,   // big step the algorithm did NOT flag?
    "longFlatTail":    boolean,   // no recent issues but stock on hand?
    "fewEventsNoise":  boolean    // ≤2 issuing work orders?
  },
  "verdict":        "ok | tweak | review",
  "notes":          "<≤200 chars — name the SPECIFIC signal you saw>",
  "suggestedEdits": [ { "field":"recMin|recMax|trafficLight|action",
                        "newValue":<value>, "rationale":"<why>" } ]
}

Operational context (background only, not the question):
{customerContext}
```

- Bump `FACTORY_PROMPT_TEMPLATE_VERSION` constant (new) — e.g. `"2.1.0-structured"`.
- On Settings load: if the saved template hash matches the PREVIOUS factory hash exactly, the new factory is offered for adoption with a **diff view + manual Apply button**. If the operator has customised, **no auto-upgrade** — they keep their version, with a banner inviting them to review the new factory.
- Parser side (`AppLlm.parseJsonResponse`): extend to validate the new `signals` object and tolerate the v2.0 shape (missing `signals`) for backward compat with already-collected reviews.

**A4 · `shared/pipeline.js` — expose signal fields** (purely additive, no schema bump)

Per-material result gains:
- `m.netSign` — classified from net + return ratio
- `m.daysSinceLastIssue` — `runDate − max(postingDate of issue rows in window)`
- `m.rateDropFlag` / `m.rateRiseFlag` — booleans (≥40% threshold, internal constants for now)
- `m.invAdjCount` — `m.invAdj?.length || 0` (already implicit, surface as named field)

No existing consumer breaks — all additive.

**A5 · Settings — "Operational context" panel** (renamed from "Client profiles")
- Replaces the proposed Client-Profiles CRUD with a **dropdown picker** (no editor, no CRUD UI by default).
- The dropdown lists library entries. Operator picks one. Selection is **in-memory for this session only** — explicitly noted in the UI: "*This selection lives in memory only; refresh the page to clear.*"
- A small toggle "*Enable Custom context (advanced)*" reveals a 300-char textarea with the privacy lint described in A1.
- **New "Preview outgoing prompt" button** — renders the resolved prompt for a sample material (drawn from the current intake if loaded) and shows it in a modal. Use this to verify what's actually leaving the browser.

**A6 · `metadata.clientProfileId` — DROPPED.**

Original plan put a profile id on the canonical JSON. Removed because:
- Couples math deliverable to LLM-side metadata
- Breaks portability (id meaningless on a different operator's machine)
- Implies client-identification on a file that gets emailed
- Makes the schema-bump question stickier than it needs to be

Schema stays at `1.0.0`. No bump needed.

---

### B · PDF Pack modal — Excel-style filtering

(Unchanged from original plan — no security implications.)

**B1 · Refactor `openColFilterPopover`** ([analysis.js:421-550]) to accept a `colFilters` reference and `onChange` callback. Main-list behaviour preserved.

**B2 · `state._pdfPack.colFilters`** — independent of main-list filters. Modal defaults to empty filters on open.

**B3 · Modal table gains `<th>` filter carets** + a "Select all (filtered)" button alongside existing "Select marked only" / "Clear". Same DOM structure as the main list — reuse the existing `passesColFilters()` after parameterising it.

**B4 · CSS reuse** — `.col-filter-pop`, `.th-filter`, `.mark-badge` already exist. Minimal new rules.

---

### C · Bulk-mark from filters (main analysis panel)

(Unchanged — security-neutral, session-only state.)

**C1 · Two new buttons in the bulk-operations row** ([analysis.js:785-808])
- `✦ Mark filtered for LLM review (N)` — additive into `state.marked.review` (never removes existing)
- `⤓ Mark filtered for PDF print (N)` — additive into `state.marked.pdf`

**C2 · Clear-marks buttons** shown when marks > 0:
- `✕ Clear LLM marks` / `✕ Clear PDF marks`

**C3 · No persistence change.** `state.marked` remains in-memory only — matches v2.0.0's wipe-on-close model.

---

### D · PDF includes LLM review — opt-in with caveat

> **Security flip from original plan:** `includeLlm` defaults to **OFF**, not on. Plus a caveat banner.

**D1 · Row badge — LLM verdict dot** (analysis page material list)

In `renderList()` ([analysis.js:292-303]), check `state.llmByMaterial[m.material]`. If a verdict is present, render a small coloured dot alongside the existing review / PDF mark badges:
- Cyan ● for `"ok"`
- Amber ● for `"tweak"`
- Magenta ● for `"review"`

Tooltip shows verdict + first 80 chars of notes. New CSS classes `.mark-badge.llm-ok / .llm-tweak / .llm-review`.

**D2 · LLM column in PDF Pack modal table** — verdict dot or `"—"` if no review present. Filterable like the other columns (B3).

**D3 · "Include LLM review" toggle in modal**

- Single checkbox in the modal footer near the Build PDF button.
- **Defaults to UNCHECKED.** (Changed from original plan.)
- When checked: PDF section appended per-material that has LLM data, with the caveat block below.
- State: `state._pdfPack.includeLlm` (boolean, session-only).

**D4 · PDF builder — conditional LLM section** ([analysis.js:1053-1236])

After the Inv-Adj table block, conditional on `state._pdfPack.includeLlm === true` AND `state.llmByMaterial[material]` present:

- **Caveat banner** (new, mandatory whenever LLM section present):
  > *LLM-generated commentary — not authored by Birchwood Advisory. Verification recommended before action.*
- Section header: "LLM REVIEW"
- Verdict pill: coloured (cyan / amber / magenta) with label
- Notes: word-wrapped, italicised, `[LLM]` prefix on each paragraph
- Signals checklist (from the new structured response): renders only the signals the LLM flagged TRUE, as small badges
- Suggested edits table (if any): `Field | New value | Rationale` via `autoTable`
- Footer line: `{provider} · {model} · {hash} · {timestamp}` — visible audit trail per page

Skip block entirely when either condition is false.

---

## 2 · What was DROPPED from the original plan (and why)

| Dropped | Original intent | Why dropped |
|---|---|---|
| Free-form `context` textarea per profile | Let operator tailor LLM context per client | Free-form = leak channel. Replaced with fixed-pick list + optional capped custom slot. |
| `fleetTypes`, `seasonalNotes`, `priorities` fields | Richer profile metadata | Structured client-identifying fields are the worst form of leak — narrows client universe. Dropped entirely. |
| Profile import / export JSON | Share profiles between operators | Creates client-data files on disk. Removes operational discipline. Dropped. |
| `metadata.clientProfileId` on canonical JSON | Per-intake LLM context override | Couples math deliverable to LLM metadata. Implies client-identification on emailed files. Breaks portability across operators. Dropped. |
| Auto-upgrade of saved prompt template | Keep operators on the latest factory prompt | Silently mutating saved settings is a surprise. Replaced with notify + diff + manual Apply. |
| `includeLlm` default ON in PDF Pack | Make LLM the headline feature of the deliverable | LLM commentary in a client-facing PDF, default-on, blurs the deterministic / probabilistic boundary. Flipped to default OFF + mandatory caveat banner. |

---

## 3 · Critical files

| File | Sections changed | Notes |
|---|---|---|
| [`shared/context-library.js`](shared/context-library.js) | NEW FILE | Fixed-pick library + session-only active selector |
| [`shared/config.js`](shared/config.js) | `FACTORY_PROMPT_TEMPLATE`, add `FACTORY_PROMPT_TEMPLATE_VERSION` | New structured-signals schema |
| [`shared/llm.js`](shared/llm.js) | `buildContext()`, `parseJsonResponse()` | Inject context + new signal fields; tolerate v2.0 response shape |
| [`shared/pipeline.js`](shared/pipeline.js) | per-material result block | Expose netSign, daysSinceLastIssue, rateDropFlag, rateRiseFlag, invAdjCount |
| [`shared/canonical-schema.js`](shared/canonical-schema.js) | — | **No change.** No SCHEMA_VERSION bump. |
| [`settings/settings.html / .js / .css`](settings/) | New "Operational context" panel | Dropdown + advanced-toggle + 300-char Custom slot + Preview-prompt button |
| [`intake/intake.html / .js`](intake/) | — | **No change.** No per-intake override (dropped). |
| [`analysis/analysis.js`](analysis/analysis.js) | Multiple — see scope sections | Filter popover refactor, bulk-mark buttons, modal column filters, LLM badge, PDF builder LLM section |
| [`analysis/analysis.html`](analysis/analysis.html) | PDF modal markup | Filter row, Include-LLM toggle (default OFF) |
| [`analysis/analysis.css`](analysis/analysis.css) | Modal table styles, llm-verdict badges, caveat banner | Re-use existing patterns |
| [`record-of-change.html`](record-of-change.html) | New v2.1.0 entry | Include the "what we DROPPED and why" table verbatim |
| [`user-manual.html`](user-manual.html) | §06 Parameter Search, §09 Analysis UI, §10 Excel deliverable, §11 LLM | Document context library, bulk-mark, modal filters, opt-in PDF LLM section, caveat |
| [`HANDOVER.md`](HANDOVER.md) | "Things to NOT do without asking" | Add: don't widen LLM context beyond fixed-pick library without operator sign-off; don't put LLM metadata on canonical JSON. |

---

## 4 · Out of scope (defer to v2.2)

- LLM verdict in Excel exports (`shared/excel.js`)
- Mass LLM session UI changes (current modal / results view untouched)
- Profile sharing / sync across machines (deliberately out — see "what we DROPPED")
- Localising the context library (English only)

---

## 5 · Verification

1. **Prompt structure** — Settings → Prompt Template, confirm new factory shows the structured-signals JSON schema. Run a single review on a known case (negative net consumption); response must return `signals.negativeNet: true` and a ≤200-char `notes` field naming the signal.
2. **Fixed-pick context** — Settings → Operational context dropdown: switch to "Mining — surface MRO", run a review, verify the prompt sent contains that exact string (Preview button or DevTools).
3. **Custom slot guardrails** — enable Custom advanced, type a string containing a fake vendor code or 8-digit material sequence, hit Save. Confirm the privacy lint warns. Confirm the 300-char cap is enforced (typing past it is blocked, paste truncates).
4. **No localStorage write for active context** — pick a non-default context, refresh the page, confirm it resets to "No context".
5. **No `clientProfileId` on canonical JSON** — save an intake, open the JSON, confirm `metadata.clientProfileId` is absent.
6. **Bulk-mark from filters** — apply column filter (e.g., TL = ORANGE), click "Mark filtered for LLM review", confirm marked count matches filtered count.
7. **PDF Pack modal filters** — open Export PDF Pack, filter inside modal, click "Select all (filtered)", confirm modal selection reflects the filter; close modal; confirm main-list filters are unchanged.
8. **LLM badge on rows** — run a single review, confirm cyan / amber / magenta dot renders.
9. **PDF without LLM by default** — run Mass LLM, open PDF Pack, do NOT tick "Include LLM review", build PDF; confirm no LLM section appears anywhere.
10. **PDF with LLM (opt-in)** — same as 9 but tick the toggle. Confirm: caveat banner present on every page that has LLM data; verdict pill rendered; `[LLM]` prefix on notes; signals badges only show flagged signals; suggested-edits table renders when present; provider / model / hash / timestamp footer line present.
11. **No regression** — re-run the v2.0.0-dev verification surface (Mass LLM cancel/pause/resume, Inv-Adj modal, reuse-data modal, Assessment Name validation, Clear-session-data button).
12. **Schema version unchanged** — `1.0.0` everywhere.

---

## 6 · Release artefacts

- **`record-of-change.html`** — new v2.1.0 entry with:
  - Header: feature / enhancement bullets
  - "Why this is tighter than the v2.0.0 prompt path" — abbreviated version of §0 above
  - "What we DROPPED from the original draft and why" — table from §2
  - Rollback note: revert to `v2.0.0` tag, all schema-compat (no migration needed because schema didn't bump)
- **`user-manual.html`** — sections 06 / 09 / 10 / 11 updated; new section "11c · Operational context library + Preview outgoing prompt".
- **Push protocol** per [HANDOVER.md](HANDOVER.md): clone-to-tmp, copy from `App/v2/`, commit with explicit identity flags, tag `v2.1.0` on the final commit.
- **Memory update:** add a new note `feedback_data_security_llm_boundary.md` to project memory codifying the seven principles in §0 above.
