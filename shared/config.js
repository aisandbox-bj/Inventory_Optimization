/* ═══════════════════════════════════════════════════════════════════════════
   Config helpers — read / write Settings (parameter defaults, LLM config,
   column-alias overrides). Sits on top of AppStorage.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const KEY_PARAMS  = 'settings.parameters';
  const KEY_ALIASES = 'settings.columnAliases';
  const KEY_LLM     = (provider) => `settings.llm.${provider}`;

  /* ─── Parameter defaults (read with factory fallback) ───────────────────── */
  async function getDefaults(){
    const saved = await AppStorage.get(KEY_PARAMS);
    return Object.assign({}, CanonicalSchema.FACTORY_DEFAULTS, saved || {});
  }
  async function saveDefaults(obj){
    // strip to known keys only
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
    // Best-effort wipe of LLM keys (we know the providers we support)
    for (const p of ['anthropic', 'openai']) await deleteLlm(p);
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppConfig = Object.freeze({
    getDefaults, saveDefaults, resetDefaults,
    getLlm, saveLlm, deleteLlm,
    getAliases, saveAliases,
    factoryReset
  });

})(window);
