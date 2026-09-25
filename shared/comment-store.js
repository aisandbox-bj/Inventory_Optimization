/*═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · shared/comment-store.js · v2.2.0-dev
   APP-COMMENT-DURABLE

   A durable, assessment-INDEPENDENT per-material comment store. Comments are
   keyed by SAP material number and live in their own localStorage key —
   SEPARATE from the canonical intake JSON and from the per-assessment analyst
   sidecar. So a comment:
     • survives deleting the canonical JSON (different key entirely),
     • reappears when ANY future assessment containing that material is loaded
       (keyed by material, not by assessment name),
     • can be exported to / imported from a tiny backup file so it survives a
       browser-data clear or moving to another machine.

   This does NOT replace the per-assessment analyst note (which still round-trips
   into the downloaded JSON and drives the Trend notes drawer). The Report
   Builder dual-writes to both: the analyst note keeps report ⇄ Trend in sync for
   the current assessment; this store gives the durable, cross-assessment carry.

   Storage shape (localStorage[calibre.comments.v1]):
     { version:1, items: { "<material>": { text, updated, assessment } } }
═════════════════════════════════════════════════════════════════════════════*/
(function (global) {
  'use strict';

  var KEY = 'calibre.comments.v1';

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (!raw) return { version: 1, items: {} };
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return { version: 1, items: {} };
      if (!o.items || typeof o.items !== 'object') o.items = {};
      o.version = 1;
      return o;
    } catch (e) { return { version: 1, items: {} }; }
  }
  function save(o) {
    try { global.localStorage.setItem(KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }
  function key(mat) { return String(mat == null ? '' : mat).trim(); }

  function get(mat) {
    var m = key(mat); if (!m) return '';
    var it = load().items[m];
    return (it && it.text) || '';
  }
  function getMeta(mat) {
    var m = key(mat); if (!m) return null;
    return load().items[m] || null;
  }
  // Writing blank clears the entry, so the store stays small.
  function set(mat, text, assessment) {
    var m = key(mat); if (!m) return false;
    var o = load();
    var t = (text == null ? '' : String(text));
    if (!t.trim()) { delete o.items[m]; }
    else { o.items[m] = { text: t, updated: new Date().toISOString(), assessment: (assessment || '') }; }
    return save(o);
  }
  function all() { return load().items; }
  function count() { return Object.keys(load().items).length; }

  function exportObj() {
    return { app: 'calibre', kind: 'comments', version: 1,
      exported: new Date().toISOString(), items: load().items };
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

  // Merge an imported object. Newer wins on a per-material conflict (by `updated`);
  // an incoming entry with no timestamp never clobbers an existing one.
  function importObj(obj) {
    var items = (obj && obj.items) ? obj.items
      : (obj && typeof obj === 'object' && !obj.app ? obj : null);
    if (!items || typeof items !== 'object') return { ok: false, added: 0, updated: 0, reason: 'no comments found in that file' };
    var o = load(), added = 0, upd = 0;
    Object.keys(items).forEach(function (m) {
      var incoming = items[m]; if (!incoming) return;
      var text = (typeof incoming === 'string') ? incoming : incoming.text;
      if (text == null || !String(text).trim()) return;
      var iUpd = (typeof incoming === 'object' && incoming.updated) || '';
      var iAss = (typeof incoming === 'object' && incoming.assessment) || '';
      var cur = o.items[m];
      if (!cur) {
        o.items[m] = { text: String(text), updated: iUpd || new Date().toISOString(), assessment: iAss };
        added++; return;
      }
      var curT = Date.parse(cur.updated || '') || 0, inT = Date.parse(iUpd) || 0;
      if (inT > curT) {
        o.items[m] = { text: String(text), updated: iUpd, assessment: iAss || cur.assessment || '' };
        upd++;
      }
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
    download: download, exportObj: exportObj, importObj: importObj, importFile: importFile,
    KEY: KEY
  };

})(window);
