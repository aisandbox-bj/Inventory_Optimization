/* ═══════════════════════════════════════════════════════════════════════════
   shared/no-hovers.js · APP-HOVER-KILL (2026-08-17) · TEMPORARY, reversible
   ───────────────────────────────────────────────────────────────────────────
   The operator asked to suppress ALL native hover tooltips across the app "for
   the time being" — moving the cursor around was firing a `title` tooltip on
   nearly every description, cell and button.

   Rather than delete every `title=` from source (hundreds of them, across every
   page + shared module — and that would lose the text permanently), this strips
   `title` attributes at RUNTIME: an initial sweep of the DOM plus a
   MutationObserver so anything the app renders/re-renders later is stripped too.
   Native `title` is the ONLY thing that produces those hover bubbles, so nothing
   else needs touching. Deliberate hover VISUALS (Chart.js tooltips, the cadence
   MRP/Manual hover table, the consumption-chart hover) are NOT `title`-based, so
   they are untouched.

   TO RESTORE hovers later: remove the single `<script src=".../shared/no-hovers.js">`
   tag from the pages (or delete this file). The source `title=` attributes are
   left intact, so removing this script brings every tooltip straight back.
═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function stripEl(el){ if (el && el.nodeType === 1 && el.removeAttribute) el.removeAttribute('title'); }
  function stripTree(root){
    if (!root) return;
    stripEl(root);
    if (root.querySelectorAll) root.querySelectorAll('[title]').forEach(stripEl);
  }
  // Watch from the earliest possible moment (documentElement always exists, even
  // mid-head-parse) so parser-inserted and script-rendered titles are both caught.
  try {
    var mo = new MutationObserver(function (muts){
      for (var i = 0; i < muts.length; i++){
        var m = muts[i];
        if (m.type === 'attributes') stripEl(m.target);
        if (m.addedNodes) for (var k = 0; k < m.addedNodes.length; k++) stripTree(m.addedNodes[k]);
      }
    });
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
  } catch (e) { /* MutationObserver unavailable — the sweeps below still cover load-time */ }
  function sweep(){ stripTree(document.documentElement); }
  sweep();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  window.addEventListener('load', sweep);
})();
