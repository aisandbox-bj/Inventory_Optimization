/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.0.0-dev · released 2026-05-12
   Config helpers — read / write Settings (parameter defaults, LLM config,
   prompt template, column-alias overrides). Sits on top of AppStorage.

   NOTE: This module only persists SETTINGS (defaults, keys, prompts, aliases).
   LLM REVIEW DATA (single + mass) is NEVER persisted anywhere by design —
   v2.0 data-security posture is in-memory only, with download-and-wipe.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const KEY_PARAMS  = 'settings.parameters';
  const KEY_ALIASES = 'settings.columnAliases';
  const KEY_PROMPT  = 'settings.llm.promptTemplate';
  const KEY_LLM     = (provider) => `settings.llm.${provider}`;

  /* ─── Factory prompt template — placeholders resolved at call-time ──────── */
  const FACTORY_PROMPT_TEMPLATE =
`You are reviewing a consumption chart for an MRO inventory recommendation.

Material:       {material} — {description}
Bucket:         {bucket}
Pattern:        {pattern}

STATISTICS
  Total consumed (analysis window):       {totalNet}
  P1 rate (baseline, 5 mo):               {p1Rate} / mo  [{p1Flag}]
  P2 rate (current, {p2Months} mo):       {p2Rate} / mo  [{p2Flag}]
  P1 → P2 rate change:                    {rateChange}
  Adjusted P2 (HCE excluded):             {adjP2}
  HCE events (P2):                        {hceText}
  Issuing WO count (analysis window):     {woCount}

CURRENT MRP STATE
  MRP type:        {mrpType}
  Stock on hand:   {stock}
  Current Min:     {cmin}
  Current Max:     {cmax}
  Runway @ P2:     {runway} months

RECOMMENDATION (algorithmic)
  Recommended Min: {recMin}
  Recommended Max: {recMax}
  Recommended MRP: {recMrpType}
  Traffic light:   {trafficLight}
  Action:          {action}

The attached chart shows: orange step line = cumulative actual consumption;
cyan dashed = P1 trend; green dashed = P2 trend; amber dots/annotations = HCE work orders.

Your job is to look at the chart and the numbers together. Sanity-check the recommendation.
Look for: a P2 rate skewed by one HCE, a pattern that looks seasonal not steady,
a lumpy classification the planner should be told about, anomalies the algorithm missed,
and whether the few-events overlay (woCount ≤ 2) or Working Redundant (PURPLE) flag is
justified by what the chart actually shows.

Reply with ONLY a JSON object on a single line — no prose around it, no markdown fences:
{"verdict":"ok"|"tweak"|"review","notes":"<one or two sentences>","suggestedEdits":[<optional edits>]}

verdict semantics:
  "ok"     — recommendation looks right given the chart
  "tweak"  — recommendation is close but a parameter change would improve it
  "review" — a planner needs to look at this manually (seasonal, anomaly, etc.)

suggestedEdits is optional. Each edit is { "field":"recMin|recMax|trafficLight|action", "newValue":<value>, "rationale":"<why>" }.`;

  /* ─── Available placeholder names (used by Settings UI for documentation) ── */
  const PROMPT_PLACEHOLDERS = [
    'material', 'description', 'bucket', 'pattern',
    'totalNet', 'p1Rate', 'p1Flag', 'p2Rate', 'p2Flag', 'p2Months', 'rateChange', 'adjP2', 'hceText',
    'mrpType', 'stock', 'cmin', 'cmax', 'recMin', 'recMax', 'recMrpType', 'runway', 'woCount',
    'trafficLight', 'action'
  ];

  /* ─── Parameter defaults (read with factory fallback) ───────────────────── */
  async function getDefaults(){
    const saved = await AppStorage.get(KEY_PARAMS);
    return Object.assign({}, CanonicalSchema.FACTORY_DEFAULTS, saved || {});
  }
  async function saveDefaults(obj){
    const allowed = Object.keys(CanonicalSchema.FACTORY_DEFAULTS);
    const clean   = {};
    for (const k of allowed) if (k in obj) clean[k] = obj[k];
    return AppStorage.set(KEY_PARAMS, clean);
  }
  async function resetDefaults(){
    return AppStorage.del(KEY_PARAMS);
  }

  /* ─── LLM provider config ───────────────────────────────────────────────── */
  async function getLlm(provider){
    const v = await AppStorage.get(KEY_LLM(provider));
    return v || { apiKey: '', model: '' };
  }
  async function saveLlm(provider, cfg){
    const { apiKey = '', model = '' } = cfg || {};
    return AppStorage.set(KEY_LLM(provider), { apiKey, model });
  }
  async function deleteLlm(provider){
    return AppStorage.del(KEY_LLM(provider));
  }

  /* ─── Prompt template (read with factory fallback) ──────────────────────── */
  async function getPromptTemplate(){
    const saved = await AppStorage.get(KEY_PROMPT);
    return (saved && typeof saved === 'string' && saved.trim().length) ? saved : FACTORY_PROMPT_TEMPLATE;
  }
  async function savePromptTemplate(text){
    return AppStorage.set(KEY_PROMPT, String(text || ''));
  }
  async function resetPromptTemplate(){
    return AppStorage.del(KEY_PROMPT);
  }

  /* ─── Column alias overrides ────────────────────────────────────────────── */
  async function getAliases(){
    const v = await AppStorage.get(KEY_ALIASES);
    return v || {};
  }
  async function saveAliases(map){
    return AppStorage.set(KEY_ALIASES, map || {});
  }

  /* ─── Factory reset (wipes Settings only — not intake JSONs) ────────────── */
  async function factoryReset(){
    await resetDefaults();
    await AppStorage.del(KEY_ALIASES);
    await resetPromptTemplate();
    for (const p of ['anthropic', 'openai']) await deleteLlm(p);
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppConfig = Object.freeze({
    FACTORY_PROMPT_TEMPLATE,
    PROMPT_PLACEHOLDERS,
    getDefaults, saveDefaults, resetDefaults,
    getLlm, saveLlm, deleteLlm,
    getPromptTemplate, savePromptTemplate, resetPromptTemplate,
    getAliases, saveAliases,
    factoryReset
  });

})(window);
