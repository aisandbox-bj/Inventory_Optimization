/* ═══════════════════════════════════════════════════════════════════════════
   shared/analyst-marks.js · APP-ACT-01 (2026-08-15) · +notes/+restore Phase 1
   · APP-ANALYST-IN-JSON (2026-09-27)
   ───────────────────────────────────────────────────────────────────────────
   The operator's ANALYST work — "For Action" ★ flags, the hand-entered "Analyst
   Recommendation" (MRP type + Min/Max/Safety) and per-material NOTES.

   APP-ANALYST-IN-JSON (operator decision 2026-09-27): the review work now LIVES
   IN THE ASSESSMENT JSON as an additive top-level block, keyed by SAP material:
       json.analyst = { v:1, updatedAt, materials: { "<material>": {
                          forAction, rec:{ mrpType, min, max, safety }, note,
                          reviewed, updatedAt, cleared } } }
   `reviewed` (APP-CANVAS-REVIEWED, 2026-09-27) = the date the material was ticked
   "✓ Reviewed" on its Canvas page (ISO string); absent = not reviewed yet.
   so Save / Download / Upload / Reuse all carry it and RENAMING a run no longer
   loses it. (It used to sit only in a browser store keyed by the assessment NAME;
   a run saved under a new name came up empty — operator lost a month's stars,
   2026-09-27, recovered by restoring the old name.) Additive → no SCHEMA_VERSION
   change; older builds ignore the block. Analyst opinion only — never LLM output.

   The browser store (localStorage `tune.analyst.<assessmentName>`) is kept as a
   fast, synchronous working copy and a safety net: pages read/write it instantly,
   and every change is written back into the JSON (auto-save, debounced, plus on
   leaving the page). On load the JSON block and the browser copy are MERGED per
   material — the most recent edit wins (each entry carries updatedAt; a cleared
   entry is kept as a dated "cleared" marker so it can't be resurrected by an
   older copy). Legacy entries with no timestamp merge as before (live first, ★
   union).

   Public API:
     AnalystMarks.forJson(json[, opts]) → handle bound to the assessment JSON: merges
        json.analyst (+ legacy json._analystData) into the browser copy, keeps
        json.analyst current and auto-saves it (opts.save(json) overrides the
        default saver; default = intake.current + the saved copy of this run).
     AnalystMarks.forAssessment(name) → handle bound by name only (no JSON sync).
        Handle: .isAction .toggleAction .setAction .getRec .setRec .getNote
                .setNote .hasNote .isReviewed .reviewedOn .setReviewed .clearReviewed .actionMaterials .actionCount .noteMaterials
                .noteCount .raw() .block() .flush()
     AnalystMarks.load(name)            → the browser copy's map (read-only use)
     AnalystMarks.restore(name, map)    → merge a map into the browser copy (newest wins)
     AnalystMarks.mapFromJson(json)     → the map carried in a JSON (new block + legacy)
     AnalystMarks.mergeMaps(a, b)       → per-material newest-wins merge
     AnalystMarks.toBlock(map)          → { v:1, updatedAt, materials }
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const PREFIX = 'tune.analyst.';
  function keyFor(name){ return PREFIX + (name && String(name).trim() ? String(name).trim() : '_unnamed'); }
  const nowIso = () => new Date().toISOString();

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
  function hasAnyContent(o){ return !!(o && (o.forAction || o.reviewed || recHasContent(o) || noteHasContent(o))); }
  function ts(e){ const t = (e && e.updatedAt) ? Date.parse(e.updatedAt) : 0; return Number.isFinite(t) ? t : 0; }

  // Keep only the known shape (a hand-edited file can't inject junk).
  function sanitizeEntry(e){
    if (!e || typeof e !== 'object') return null;
    const out = {};
    if (e.forAction) out.forAction = true;
    if (e.rec && typeof e.rec === 'object'){
      const s = (v) => (v != null ? String(v) : '');
      const rec = { mrpType: s(e.rec.mrpType), min: s(e.rec.min), max: s(e.rec.max), safety: s(e.rec.safety) };
      if (rec.mrpType || rec.min || rec.max || rec.safety) out.rec = rec;
    }
    if (e.note && String(e.note).trim()) out.note = String(e.note);
    if (e.reviewed) out.reviewed = (typeof e.reviewed === 'string' && Number.isFinite(Date.parse(e.reviewed))) ? e.reviewed : nowIso();
    if (e.updatedAt && Number.isFinite(Date.parse(e.updatedAt))) out.updatedAt = String(e.updatedAt);
    if (e.cleared && !hasAnyContent(out)) out.cleared = true;
    if (!hasAnyContent(out) && !out.cleared) return null;
    return out;
  }

  /* Legacy (no timestamps on either side) merge — live wins per field, ★ union.
     APP-FIX-ANALYST-MERGE (2026-08-16) semantics, kept for pre-2026-09-27 data. */
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
    if (cur.reviewed || inc.reviewed) out.reviewed = cur.reviewed || inc.reviewed;   // union, like ★
    return out;
  }

  // Per material: the most recent edit wins. `a` is treated as the live side.
  function mergeMaps(a, b){
    const out = {};
    Object.keys(a || {}).forEach(m => { const e = sanitizeEntry(a[m]); if (e) out[m] = e; });
    Object.keys(b || {}).forEach(m => {
      const inc = sanitizeEntry(b[m]); if (!inc) return;
      const cur = out[m];
      if (!cur){ out[m] = inc; return; }
      const tc = ts(cur), ti = ts(inc);
      if (ti > tc) out[m] = inc;
      else if (tc === 0 && ti === 0){ const e = mergeEntry(cur, inc); if (hasAnyContent(e)) out[m] = e; }
      // else: the live/current side is newer (or the same edit) — keep it
    });
    return out;
  }

  function mapFromJson(json){
    if (!json || typeof json !== 'object') return {};
    let map = {};
    const blk = json.analyst;
    if (blk && typeof blk === 'object' && blk.materials && typeof blk.materials === 'object') map = mergeMaps(map, blk.materials);
    if (json._analystData && typeof json._analystData === 'object') map = mergeMaps(map, json._analystData);   // pre-2026-09-27 files
    return map;
  }
  function toBlock(map){ return { v: 1, updatedAt: nowIso(), materials: map || {} }; }

  function forAssessment(name, hooks){
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

    const changed = () => { persist(name, data); if (hooks && hooks.onChange) hooks.onChange(); };
    // Start an edit on a material: a "cleared" marker becomes a live entry again.
    function entry(material){
      if (!data[material] || data[material].cleared) data[material] = {};
      return data[material];
    }
    // After an edit: stamp it; an entry left with no content becomes a dated
    // "cleared" marker (so an older copy elsewhere can't bring it back).
    function finish(material){
      const e = data[material]; if (!e) return;
      if (hasAnyContent(e)) { delete e.cleared; e.updatedAt = nowIso(); }
      else data[material] = { cleared: true, updatedAt: nowIso() };
    }
    const live = (m) => data[m] && !data[m].cleared ? data[m] : null;

    const handle = {
      assessment: name,

      isAction(material){ const e = live(material); return !!(e && e.forAction); },

      setAction(material, on){
        on = !!on;
        const e = entry(material);
        if (on) e.forAction = true; else delete e.forAction;
        finish(material);
        changed();
      },

      toggleAction(material){
        this.setAction(material, !this.isAction(material));
        return this.isAction(material);
      },

      getRec(material){
        const e = live(material);
        const r = (e && e.rec) || {};
        return {
          mrpType: r.mrpType || '',
          min:     r.min     || '',
          max:     r.max     || '',
          safety:  r.safety  || ''
        };
      },

      setRec(material, rec){
        rec = rec || {};
        const e = entry(material);
        const r = {
          mrpType: rec.mrpType != null ? String(rec.mrpType) : '',
          min:     rec.min     != null ? String(rec.min)     : '',
          max:     rec.max     != null ? String(rec.max)     : '',
          safety:  rec.safety  != null ? String(rec.safety)  : ''
        };
        if (r.mrpType || r.min || r.max || r.safety) e.rec = r; else delete e.rec;
        finish(material);
        changed();
      },

      /* ─── APP-TREND-NOTES (Phase 1) — per-material analyst notes ─── */
      getNote(material){
        const e = live(material);
        return (e && e.note) ? String(e.note) : '';
      },
      setNote(material, text){
        text = (text == null) ? '' : String(text);
        const e = entry(material);
        if (String(text).trim()) e.note = text; else delete e.note;
        finish(material);
        changed();
        // APP-COMMENT-DURABLE — mirror EVERY note write (Trend notes drawer, report
        // editor, …) into the durable per-material store when it's loaded, so an edit
        // or a delete anywhere stays in sync and a cleared note can't be resurrected.
        try { if (typeof CommentStore !== 'undefined') CommentStore.set(material, text, name || ''); } catch (e2) {}
      },
      hasNote(material){ return noteHasContent(live(material)); },

      /* ─── APP-CANVAS-REVIEWED — "✓ Reviewed" tick per Canvas page ─── */
      isReviewed(material){ const e = live(material); return !!(e && e.reviewed); },
      reviewedOn(material){ const e = live(material); return (e && e.reviewed) ? String(e.reviewed) : ''; },
      setReviewed(material, on){
        const e = entry(material);
        if (on){ if (!e.reviewed) e.reviewed = nowIso(); } else delete e.reviewed;
        finish(material);
        changed();
      },
      reviewedMaterials(){ return Object.keys(data).filter(m => live(m) && data[m].reviewed); },
      // Clear the ✓ on the given materials (default: every material) in one save —
      // e.g. to start next month's review from a run re-saved from this one.
      clearReviewed(materials){
        const list = (materials || this.reviewedMaterials()).filter(m => this.isReviewed(m));
        list.forEach(m => { delete data[m].reviewed; finish(m); });
        if (list.length) changed();
        return list.length;
      },

      actionMaterials(){ return Object.keys(data).filter(m => live(m) && data[m].forAction); },
      actionCount(){ return this.actionMaterials().length; },
      noteMaterials(){ return Object.keys(data).filter(m => noteHasContent(live(m))); },
      noteCount(){ return this.noteMaterials().length; },

      raw(){ return data; },
      block(){ return toBlock(data); },
      flush(){ if (hooks && hooks.flush) return hooks.flush(); }
    };

    return handle;
  }

  /* ─── Merge a map (from a file) into the browser copy. NON-DESTRUCTIVE
     (APP-FIX-ANALYST-MERGE, 2026-08-16): existing work is never dropped; per
     material the most recent edit wins (timestamps, 2026-09-27); legacy entries
     without timestamps keep the old live-first / ★-union rule. ─── */
  function restore(name, mapObj){
    if (!mapObj || typeof mapObj !== 'object') return;
    persist(name, mergeMaps(load(name), mapObj));
  }

  /* ─── APP-ANALYST-IN-JSON — bind to the assessment JSON and auto-save. ─── */
  function forJson(json, opts){
    opts = opts || {};
    const name = (json && json.metadata && json.metadata.assessmentName) || '';
    const fromFile = mapFromJson(json);
    if (Object.keys(fromFile).length) restore(name, fromFile);
    if (json && json._analystData) delete json._analystData;   // superseded by json.analyst

    let timer = null, pending = false, saving = null;
    async function defaultSave(j){
      if (typeof AppStorage === 'undefined') return;
      await AppStorage.set('intake.current', j);
      // Keep the saved copy of this run (Dashboard "Open" / Intake "Save") in step
      // too — only its review-work block is replaced; its data stays as saved.
      if (name){
        const saved = await AppStorage.get('intake.' + name);
        if (saved && saved.metadata && saved.metadata.assessmentName === name){
          saved.analyst = j.analyst;
          await AppStorage.set('intake.' + name, saved);
        }
      }
    }
    async function flush(){
      if (timer){ clearTimeout(timer); timer = null; }
      if (!pending) return saving;
      pending = false;
      saving = (async () => {
        try {
          await (opts.save ? opts.save(json) : defaultSave(json));
          try { document.dispatchEvent(new CustomEvent('calibre:analyst-saved')); } catch (e) {}
        } catch (e) { console.warn('AnalystMarks: auto-save failed —', e); pending = true; }
      })();
      return saving;
    }
    function schedule(){ pending = true; if (timer) clearTimeout(timer); timer = setTimeout(flush, 1200); }

    let handle = null;
    handle = forAssessment(name, {
      onChange(){ if (json) json.analyst = toBlock(handle.raw()); schedule(); },
      flush
    });
    // Bring the JSON up to date with the merged copy; write it back only if the
    // stored JSON was missing something (no needless rewrite on every page open).
    if (json){
      const before = JSON.stringify((json.analyst && json.analyst.materials) || {});
      const merged = handle.raw();
      if (JSON.stringify(merged) !== before){
        json.analyst = toBlock(merged);
        if (Object.keys(merged).length) schedule();
      }
    }
    // Leaving the page: write any pending change straight away. (The browser copy
    // is already current, so even a cut-short write loses nothing — the next load
    // merges it back into the JSON.)
    try {
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    } catch (e) {}
    return handle;
  }

  window.AnalystMarks = { forJson, forAssessment, load, restore, mapFromJson, mergeMaps, toBlock };
})();
