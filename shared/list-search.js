/*═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · shared/list-search.js · v2.2.0-dev
   APP-LIST-SEARCH (operator 2026-09-29)

   One search behaviour for the Trend, Trace and Canvas search boxes:
     • ordinary text  → material number or description CONTAINS the text (as before);
     • two or more material numbers (separated by spaces, commas, semicolons or
       new lines — e.g. pasted from Excel) → the list shows exactly those
       materials (leading zeros ignored).
   A list is capped at MAX (20). Pasting more keeps the first 20 and shows a
   note naming what was dropped; the same note names pasted numbers that aren't
   in the list being searched. The note floats over the page (nothing moves).

   API:
     ListSearch.MAX
     ListSearch.parse(text)            → { list: [..] | null, dropped: [..] }
     ListSearch.test(text, mat, desc)  → true when the row matches
     ListSearch.attach(input, { universe: () => iterable of material numbers })
═════════════════════════════════════════════════════════════════════════════*/
(function (global) {
  'use strict';

  var MAX = 20;
  var NUM = /^\d{3,18}$/;
  var norm = function (s) { s = String(s == null ? '' : s).trim(); return /^\d+$/.test(s) ? (s.replace(/^0+(?=\d)/, '')) : s.toLowerCase(); };

  // A "list" = 2+ tokens that all look like material numbers. Anything else is text.
  function parse(text) {
    var toks = String(text || '').split(/[\s,;|]+/).filter(Boolean);
    if (toks.length < 2 || !toks.every(function (t) { return NUM.test(t); })) return { list: null, dropped: [] };
    var seen = {}, list = [];
    toks.forEach(function (t) { var k = norm(t); if (!seen[k]) { seen[k] = 1; list.push(t); } });
    return { list: list.slice(0, MAX), dropped: list.slice(MAX) };
  }

  var cache = { text: null, set: null, q: '' };
  function test(text, mat, desc) {
    if (!text) return true;
    if (cache.text !== text) {
      var p = parse(text);
      cache = { text: text, set: p.list ? p.list.reduce(function (o, m) { o[norm(m)] = 1; return o; }, {}) : null, q: String(text).trim().toLowerCase() };
    }
    if (cache.set) return !!cache.set[norm(mat)];
    return String(mat || '').toLowerCase().indexOf(cache.q) >= 0 || String(desc || '').toLowerCase().indexOf(cache.q) >= 0;
  }

  // Floating note just under the box (position:fixed — no layout shift).
  var noteEl = null, noteT = null;
  function note(input, html) {
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.setAttribute('role', 'status');
      noteEl.style.cssText = 'position:fixed;z-index:9500;max-width:460px;padding:9px 30px 9px 12px;border-radius:6px;' +
        'background:#1a2a2e;border:1px solid #FBBF24;color:#F0F4F3;font:13px/1.45 Barlow,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.45)';
      noteEl.addEventListener('click', function (e) { if (e.target.closest('[data-x]')) hide(); });
      document.body.appendChild(noteEl);
    }
    noteEl.innerHTML = html + '<button data-x type="button" aria-label="Close" style="position:absolute;top:5px;right:6px;background:none;border:none;color:#9BABA8;font-size:15px;cursor:pointer">✕</button>';
    var r = input.getBoundingClientRect();
    noteEl.style.left = Math.max(8, Math.min(window.innerWidth - 470, r.left)) + 'px';
    noteEl.style.top = (r.bottom + 6) + 'px';
    noteEl.hidden = false;
    clearTimeout(noteT); noteT = setTimeout(hide, 14000);
  }
  function hide() { if (noteEl) noteEl.hidden = true; }
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function attach(input, opts) {
    if (!input || input._listSearch) return;
    input._listSearch = true;
    opts = opts || {};
    input.addEventListener('paste', function (e) {
      var txt = (e.clipboardData || global.clipboardData) ? (e.clipboardData || global.clipboardData).getData('text') : '';
      var p = parse(txt);
      if (!p.list) return;                        // ordinary text — normal paste
      e.preventDefault();
      input.value = p.list.join(' ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var msgs = [];
      if (p.dropped.length) {
        msgs.push('<b style="color:#FBBF24">Only the first ' + MAX + ' materials were kept.</b> You pasted ' + (p.list.length + p.dropped.length) +
          ' — these ' + p.dropped.length + ' were dropped: ' + esc(p.dropped.join(', ')));
      }
      if (opts.universe) {
        var have = {};
        try { for (var m of opts.universe()) have[norm(m)] = 1; } catch (err) {}
        var missing = p.list.filter(function (m) { return !have[norm(m)]; });
        if (missing.length) msgs.push(missing.length + ' of the ' + p.list.length + ' kept ' + (missing.length === 1 ? 'isn’t' : 'aren’t') + ' in this list: ' + esc(missing.join(', ')));
      }
      if (msgs.length) note(input, msgs.join('<br>')); else hide();
    });
    input.addEventListener('input', function () { if (!input.value) hide(); });
  }

  global.ListSearch = { MAX: MAX, parse: parse, test: test, attach: attach };
})(window);
