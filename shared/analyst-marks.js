/* ═══════════════════════════════════════════════════════════════════════════
   shared/analyst-marks.js · APP-ACT-01 (2026-08-15)
   ───────────────────────────────────────────────────────────────────────────
   Sidecar store for ANALYST working data — the operator's "For Action" flags
   and their hand-entered "Analyst Recommendation" (MRP type + Min/Max/Safety).

   DELIBERATELY separate from the canonical intake JSON. Per the project's
   locked principles, the canonical dataset stays pure (no analyst opinion, no
   LLM verdicts, no client identifiers) so it can be shared / re-loaded / joined
   across Tune · Trace · Compose without a SCHEMA_VERSION bump. This module keeps
   the analyst layer in its own browser-local key, keyed by assessment name.

   Storage: plain localStorage (this payload is tiny — a handful of flags and
   numbers per material — so it never approaches the ~5MB cap that pushes the
   canonical JSON to AppStorage's IndexedDB fallback). Synchronous access is
   what the detail-panel render needs, so localStorage direct is the right tool.

   Shape on disk (JSON under key `tune.analyst.<assessmentName>`):
     { "<material>": { forAction: true, rec: { mrpType, min, max, safety } } }
   Min/Max/Safety are stored as free-text strings exactly as typed (the request
   is "free text numbers") — no coercion, so a blank stays blank.

   Public API:
     AnalystMarks.forAssessment(name) → handle bound to one assessment:
        .isAction(material)            → bool
        .toggleAction(material)        → bool (new state)
        .setAction(material, on)       → void
        .getRec(material)              → { mrpType, min, max, safety } (always an
                                          object; blanks are '')
        .setRec(material, rec)         → void
        .actionMaterials()             → string[] of flagged material numbers
        .actionCount()                 → number
        .raw()                         → the underlying map (live reference)
     AnalystMarks.load(name)           → raw map (read-only convenience)
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

  function forAssessment(name){
    const data = load(name);

    const handle = {
      assessment: name,

      isAction(material){
        return !!(data[material] && data[material].forAction);
      },

      setAction(material, on){
        on = !!on;
        if (!data[material]) data[material] = {};
        data[material].forAction = on;
        // Prune a material that carries neither a flag nor a recommendation so
        // the store never fills with empty shells.
        if (!on && !recHasContent(data[material])) delete data[material];
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
        // If the material was never flagged and the analyst cleared every field,
        // drop the empty shell.
        if (!data[material].forAction && !recHasContent(data[material])) delete data[material];
        persist(name, data);
      },

      actionMaterials(){
        return Object.keys(data).filter(m => data[m] && data[m].forAction);
      },
      actionCount(){
        return this.actionMaterials().length;
      },
      raw(){ return data; }
    };

    return handle;
  }

  window.AnalystMarks = { forAssessment, load };
})();
