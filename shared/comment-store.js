/*═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · shared/comment-store.js · v2.2.0-dev
   APP-COMMENT-DURABLE → APP-NOTE-HISTORY (2026-09-27)

   A durable, assessment-INDEPENDENT per-material note store, keyed by SAP
   material number in its own localStorage key — separate from the assessment
   JSON. So a note survives deleting the JSON, reappears in ANY later assessment
   that contains the material, and can be exported / imported as a backup file.

   APP-NOTE-HISTORY (operator 2026-09-27): each material keeps a dated HISTORY —
   one entry per review (assessment). Writing a note for an assessment overwrites
   THAT assessment's entry (edit = overwrite, operator decision); a different
   assessment adds a new entry, so earlier reviews' notes stay visible as
   "Previous notes" in the Canvas note card. Blank text removes that entry only.

   Storage (localStorage[calibre.comments.v2]):
     { version:2, items: { "<material>": { entries: [
         { id, text, assessment, created, updated } ] } } }
   Migration: the v1 store (one comment per material) becomes the first entry, and
   notes already saved under other assessments in this browser (tune.analyst.*)
   are pulled in as history — once, on first load.

   Back-compat API: get / getMeta return the MOST RECENT entry (what a report
   prints when the current review has no note of its own).
═════════════════════════════════════════════════════════════════════════════*/
(function (global) {
  'use strict';

  var KEY = 'calibre.comments.v2';
  var KEY_V1 = 'calibre.comments.v1';
  var cache = null;

  function key(mat) { return String(mat == null ? '' : mat).trim(); }
  function nowIso() { return new Date().toISOString(); }
  function newId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function t(s) { var v = Date.parse(s || ''); return isFinite(v) ? v : 0; }
  function byNewest(a, b) { return t(b.updated) - t(a.updated); }

  function migrate() {
    var o = { version: 2, items: {} };
    function add(mat, text, assessment, updated) {
      var m = key(mat); if (!m || !text || !String(text).trim()) return;
      var it = o.items[m] || (o.items[m] = { entries: [] });
      var ass = assessment || '';
      if (it.entries.some(function (e) { return e.assessment === ass; })) return;   // one per review
      var u = updated || nowIso();
      it.entries.push({ id: newId(), text: String(text), assessment: ass, created: u, updated: u });
    }
    try {   // v1 durable comments
      var v1 = JSON.parse(global.localStorage.getItem(KEY_V1) || 'null');
      if (v1 && v1.items) Object.keys(v1.items).forEach(function (m) {
        var e = v1.items[m]; if (e) add(m, e.text, e.assessment, e.updated);
      });
    } catch (e) {}
    try {   // notes kept per assessment in this browser (analyst copies)
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k || k.indexOf('tune.analyst.') !== 0) continue;
        var ass = k.slice('tune.analyst.'.length); if (ass === '_unnamed') ass = '';
        var map = JSON.parse(global.localStorage.getItem(k) || 'null') || {};
        Object.keys(map).forEach(function (m) {
          var e = map[m]; if (e && e.note) add(m, e.note, ass, e.updatedAt);
        });
      }
    } catch (e) {}
    return o;
  }

  function load() {
    if (cache) return cache;
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.items && typeof o.items === 'object') { o.version = 2; return (cache = o); }
      }
    } catch (e) {}
    cache = migrate(); save(cache);
    return cache;
  }
  function save(o) {
    cache = o;
    try { global.localStorage.setItem(KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }
  // Another tab (or page) may have written — re-read before each change.
  function fresh() { cache = null; return load(); }

  function history(mat) {
    var m = key(mat); if (!m) return [];
    var it = load().items[m];
    return it ? it.entries.slice().sort(byNewest) : [];
  }
  function latest(mat) { var h = history(mat); return h.length ? h[0] : null; }
  function get(mat) { var e = latest(mat); return e ? e.text : ''; }
  function getMeta(mat) {
    var e = latest(mat); if (!e) return null;
    return { text: e.text, updated: e.updated, assessment: e.assessment };
  }
  function entryFor(mat, assessment) {
    var ass = assessment || '';
    var h = history(mat);
    for (var i = 0; i < h.length; i++) if (h[i].assessment === ass) return h[i];
    return null;
  }

  // Write THIS review's note (edit = overwrite). Blank removes this review's entry.
  function set(mat, text, assessment) {
    var m = key(mat); if (!m) return false;
    var o = fresh(), ass = assessment || '';
    var tx = (text == null ? '' : String(text));
    var it = o.items[m] || { entries: [] };
    var i = -1;
    for (var j = 0; j < it.entries.length; j++) if (it.entries[j].assessment === ass) { i = j; break; }
    if (!tx.trim()) { if (i >= 0) it.entries.splice(i, 1); }
    else if (i >= 0) { it.entries[i].text = tx; it.entries[i].updated = nowIso(); }
    else { var n = nowIso(); it.entries.push({ id: newId(), text: tx, assessment: ass, created: n, updated: n }); }
    if (it.entries.length) o.items[m] = it; else delete o.items[m];
    return save(o);
  }
  // Edit / delete one history entry by id (used by "Previous notes").
  function updateEntry(mat, id, text) {
    var m = key(mat), o = fresh(), it = o.items[m]; if (!it) return false;
    for (var i = 0; i < it.entries.length; i++) if (it.entries[i].id === id) {
      if (!String(text || '').trim()) it.entries.splice(i, 1);
      else { it.entries[i].text = String(text); it.entries[i].updated = nowIso(); }
      if (!it.entries.length) delete o.items[m];
      return save(o);
    }
    return false;
  }
  function deleteEntry(mat, id) { return updateEntry(mat, id, ''); }

  function all() {   // back-compat: material → latest { text, updated, assessment }
    var out = {}, items = load().items;
    Object.keys(items).forEach(function (m) { var e = getMeta(m); if (e) out[m] = e; });
    return out;
  }
  function count() { return Object.keys(load().items).length; }

  function exportObj() {
    return { app: 'calibre', kind: 'comments', version: 2, exported: nowIso(), items: fresh().items };
  }
  function download() {
    try {
      var blob = new Blob([JSON.stringify(exportObj(), null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'calibre-comments.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
      return count();
    } catch (e) { return -1; }
  }

  // Merge a backup. v2 files: per entry, matched by id (else by review name) —
  // the newer edit wins; new entries are added. v1 files (one comment per
  // material) become an entry for their review. Nothing already here is deleted.
  function importObj(obj) {
    var items = (obj && obj.items) ? obj.items
      : (obj && typeof obj === 'object' && !obj.app ? obj : null);
    if (!items || typeof items !== 'object') return { ok: false, added: 0, updated: 0, reason: 'no comments found in that file' };
    var o = fresh(), added = 0, upd = 0;
    Object.keys(items).forEach(function (mm) {
      var m = key(mm), inc = items[mm]; if (!m || !inc) return;
      var list = Array.isArray(inc.entries) ? inc.entries
        : [{ text: (typeof inc === 'string') ? inc : inc.text, assessment: inc.assessment || '', updated: inc.updated || '' }];
      var it = o.items[m] || { entries: [] };
      list.forEach(function (e) {
        if (!e || !e.text || !String(e.text).trim()) return;
        var ass = e.assessment || '';
        var cur = null;
        for (var i = 0; i < it.entries.length; i++) {
          if ((e.id && it.entries[i].id === e.id) || (!e.id && it.entries[i].assessment === ass)) { cur = it.entries[i]; break; }
        }
        if (!cur) {
          var u = e.updated || nowIso();
          it.entries.push({ id: e.id || newId(), text: String(e.text), assessment: ass, created: e.created || u, updated: u });
          added++;
        } else if (t(e.updated) > t(cur.updated)) {
          cur.text = String(e.text); cur.updated = e.updated; upd++;
        }
      });
      if (it.entries.length) o.items[m] = it;
    });
    save(o);
    return { ok: true, added: added, updated: upd };
  }
  function importFile(file, cb) {
    var r = new FileReader();
    r.onload = function () {
      var res;
      try { res = importObj(JSON.parse(r.result)); }
      catch (e) { res = { ok: false, added: 0, updated: 0, reason: 'that file is not valid JSON' }; }
      if (cb) cb(res);
    };
    r.onerror = function () { if (cb) cb({ ok: false, added: 0, updated: 0, reason: 'could not read the file' }); };
    r.readAsText(file);
  }

  global.CommentStore = {
    get: get, getMeta: getMeta, set: set, all: all, count: count,
    history: history, entryFor: entryFor, updateEntry: updateEntry, deleteEntry: deleteEntry,
    download: download, exportObj: exportObj, importObj: importObj, importFile: importFile,
    KEY: KEY
  };

})(window);
