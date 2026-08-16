/* ═══════════════════════════════════════════════════════════════════════════
   shared/analyst-marks.js · APP-ACT-01 (2026-08-15) · +notes/+restore Phase 1
   ───────────────────────────────────────────────────────────────────────────
   Sidecar store for ANALYST working data — the operator's "For Action" flags,
   their hand-entered "Analyst Recommendation" (MRP type + Min/Max/Safety), and
   (Phase 1) per-material NOTES.

   DELIBERATELY separate from the canonical intake JSON. Per the project's
   locked principles the canonical dataset stays pure (no analyst opinion, no
   LLM verdicts, no client identifiers) so it can be shared / re-loaded / joined
   across Tune · Trace · Compose without a SCHEMA_VERSION bump. This module keeps
   the analyst layer in its own browser-local key, keyed by assessment name.

   APP-ACT-PERSIST (Phase 1): the whole map for an assessment can be exported
   (raw()) and re-imported (AnalystMarks.restore) so it round-trips inside the
   downloaded JSON's `_analystData` block — the operator can save + reload their
   analyst work (flags + Min/Max + notes), even on another machine.

   Storage: plain localStorage (tiny payload — flags, a few numbers and short
   notes per material — well under the ~5MB cap). Synchronous access is what the
   detail-panel render needs, so localStorage direct is the right tool.

   Shape on disk (JSON under key `tune.analyst.<assessmentName>`):
     { "<material>": { forAction: true, rec: { mrpType, min, max, safety }, note: "…" } }
   Min/Max/Safety are stored as free-text strings exactly as typed; note is a
   free-text string. Blanks stay blank.

   Public API:
     AnalystMarks.forAssessment(name) → handle bound to one assessment:
        .isAction(material)  .toggleAction(material)  .setAction(material,on)
        .getRec(material)     .setRec(material,rec)
        .getNote(material)    .setNote(material,text)  .hasNote(material)
        .actionMaterials()    .actionCount()
        .noteMaterials()      .noteCount()
        .raw()                → the underlying map (live reference)
     AnalystMarks.load(name)              → raw map (read-only convenience)
     AnalystMarks.restore(name, mapObj)   → overwrite the assessment's map (import)
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const PREFIX = 'tune.analyst.';
  function keyFor(name){ return PREFIX + (name && String(name).trim() ? String(name).trim() : '_unnamed'); }

  function load(name){
    try {
      const raw = localStorage.getItem(keyFor(name));
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e){
      console.warn('AnalystMarks: load failed —', e);
      return {};
    }
  }
  function persist(name, data){
    try { localStorage.setItem(keyFor(name), JSON.stringify(data)); }
    catch (e){ console.warn('AnalystMarks: persist failed —', e); }
  }

  function recHasContent(o){
    if (!o || !o.rec) return false;
    const r = o.rec;
    return !!(r.mrpType || r.min || r.max || r.safety);
  }
  function noteHasContent(o){ return !!(o && o.note && String(o.note).trim()); }
  function hasAnyContent(o){ return !!(o && (o.forAction || recHasContent(o) || noteHasContent(o))); }

  function forAssessment(name){
    let data = load(name);

    // APP-FIX-ANALYST-KEY migration (Phase 1) — earlier builds bound the sidecar
    // with `metadata.name` (undefined), so ALL analyst work landed under the
    // `_unnamed` bucket. If this named assessment has no sidecar yet but the
    // legacy `_unnamed` bucket holds data, adopt it once (then clear `_unnamed`
    // so a second assessment opened later doesn't also inherit it). Best-effort
    // recovery of pre-fix work; single-assessment case is exact.
    try {
      if (name && String(name).trim() && Object.keys(data).length === 0) {
        const legacyRaw = localStorage.getItem(PREFIX + '_unnamed');
        if (legacyRaw) {
          const legacy = JSON.parse(legacyRaw) || {};
          if (Object.keys(legacy).length) {
            data = legacy;
            persist(name, data);
            localStorage.removeItem(PREFIX + '_unnamed');
          }
        }
      }
    } catch (e) { console.warn('AnalystMarks: legacy migration skipped —', e); }

    function pruneIfEmpty(material){
      if (data[material] && !hasAnyContent(data[material])) delete data[material];
    }

    const handle = {
      assessment: name,

      isAction(material){ return !!(data[material] && data[material].forAction); },

      setAction(material, on){
        on = !!on;
        if (!data[material]) data[material] = {};
        data[material].forAction = on;
        if (!on) pruneIfEmpty(material);
        persist(name, data);
      },

      toggleAction(material){
        this.setAction(material, !this.isAction(material));
        return this.isAction(material);
      },

      getRec(material){
        const r = (data[material] && data[material].rec) || {};
        return {
          mrpType: r.mrpType || '',
          min:     r.min     || '',
          max:     r.max     || '',
          safety:  r.safety  || ''
        };
      },

      setRec(material, rec){
        rec = rec || {};
        if (!data[material]) data[material] = {};
        data[material].rec = {
          mrpType: rec.mrpType != null ? String(rec.mrpType) : '',
          min:     rec.min     != null ? String(rec.min)     : '',
          max:     rec.max     != null ? String(rec.max)     : '',
          safety:  rec.safety  != null ? String(rec.safety)  : ''
        };
        pruneIfEmpty(material);
        persist(name, data);
      },

      /* ─── APP-TREND-NOTES (Phase 1) — per-material analyst notes ─── */
      getNote(material){
        return (data[material] && data[material].note) ? String(data[material].note) : '';
      },
      setNote(material, text){
        text = (text == null) ? '' : String(text);
        if (!data[material]) data[material] = {};
        if (String(text).trim()) data[material].note = text;
        else if (data[material]) delete data[material].note;
        pruneIfEmpty(material);
        persist(name, data);
      },
      hasNote(material){ return noteHasContent(data[material]); },

      actionMaterials(){ return Object.keys(data).filter(m => data[m] && data[m].forAction); },
      actionCount(){ return this.actionMaterials().length; },
      noteMaterials(){ return Object.keys(data).filter(m => noteHasContent(data[m])); },
      noteCount(){ return this.noteMaterials().length; },

      raw(){ return data; }
    };

    return handle;
  }

  /* ─── APP-ACT-PERSIST — bulk import from a file's `_analystData` block. Used by
     the Intake + Dashboard JSON-upload hooks. Sanitises to the known shape so a
     hand-edited file can't inject junk.

     APP-FIX-ANALYST-MERGE (2026-08-16) — NON-DESTRUCTIVE. Previously this REPLACED
     the whole sidecar, so uploading a file (e.g. combining a JSON + IW39 through
     Intake) deleted any analyst work not represented in that file — the operator's
     "it wipes my comments/tags" bug. It now MERGES: existing (live) work is never
     dropped, the file fills gaps and adds materials, and on a per-field conflict
     the LIVE value wins (it is the most-recent edit; the file may pre-date it).
     forAction is a union (flagged on either side stays flagged). ─── */
  function mergeEntry(cur, inc){
    cur = cur || {}; inc = inc || {};
    const out = {};
    if (cur.forAction || inc.forAction) out.forAction = true;
    const cr = cur.rec || {}, ir = (inc.rec && typeof inc.rec === 'object') ? inc.rec : {};
    const pick = (a, b) => (a != null && String(a) !== '') ? String(a)
                         : (b != null ? String(b) : '');
    const rec = {
      mrpType: pick(cr.mrpType, ir.mrpType),
      min:     pick(cr.min,     ir.min),
      max:     pick(cr.max,     ir.max),
      safety:  pick(cr.safety,  ir.safety)
    };
    if (rec.mrpType || rec.min || rec.max || rec.safety) out.rec = rec;
    const note = (cur.note && String(cur.note).trim()) ? String(cur.note)
               : (inc.note && String(inc.note).trim()) ? String(inc.note) : '';
    if (note) out.note = note;
    return out;
  }
  function restore(name, mapObj){
    if (!mapObj || typeof mapObj !== 'object') return;
    const merged = Object.assign({}, load(name));   // start from LIVE — never dropped
    Object.keys(mapObj).forEach(function(mat){
      const inc = mapObj[mat]; if (!inc || typeof inc !== 'object') return;
      merged[mat] = mergeEntry(merged[mat], inc);
    });
    const clean = {};
    Object.keys(merged).forEach(function(mat){
      const e = merged[mat];
      if (e && (e.forAction || recHasContent(e) || noteHasContent(e))) clean[mat] = e;
    });
    persist(name, clean);
  }

  window.AnalystMarks = { forAssessment, load, restore };
})();
