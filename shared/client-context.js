/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.1.0 · released 2026-05-12
   Operational Context library — session-only generic site-character text
   that prefixes every LLM prompt.

   DATA-SECURITY POSTURE (v2.1.x):
     • Library entries are deliberately GENERIC — no fleet codes, no site
       names, no client identifiers. The operator picks the closest match;
       specifics never cross the browser → LLM provider boundary.
     • A 300-char "Custom" slot is available for site-specific wording. It is
       lint-checked for likely client identifiers (long numeric sequences,
       company suffixes, all-caps site codes, emails, IPs) and the operator
       must explicitly confirm to send when lint hits exist.
     • Active selection and Custom text live in localStorage under
       `settings.client.*` keys. They are NEVER written to the canonical
       intake JSON (no LLM-coupling on the math deliverable).
   Depends on: AppStorage (must load BEFORE this file).
   Loaded BEFORE shared/llm.js (which reads the active context at call time).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const KEY_ACTIVE = 'settings.client.activeContextId';
  const KEY_CUSTOM = 'settings.client.customText';

  const CUSTOM_ID = 'custom';
  const MAX_CUSTOM_CHARS = 300;

  /* ─── Factory library (generic, non-identifying) ────────────────────────── */
  const FACTORY_CONTEXT_LIBRARY = Object.freeze([
    Object.freeze({
      id:   'default-mining',
      name: 'Open-pit mining (default)',
      text: 'Open-pit mining operation, medium-sized client. Mixed heavy fleet. Reliability priority over cost. Some materials have seasonal staging requirements.'
    }),
    Object.freeze({
      id:   'underground-mining',
      name: 'Underground mining',
      text: 'Underground hard-rock mining operation, medium-sized client. Confined-space-rated equipment. Reliability priority; restricted access windows.'
    }),
    Object.freeze({
      id:   'heavy-civil',
      name: 'Heavy civil / construction',
      text: 'Heavy civil construction operation, medium-sized client. Mixed fleet, mobile + stationary. Cost-sensitive; some materials are project-bounded.'
    }),
    Object.freeze({
      id:   'minimal',
      name: 'Minimal — no context',
      text: ''
    })
  ]);

  /* ─── Lint patterns for the Custom slot ─────────────────────────────────── */
  // All-caps allowlist — tokens that legitimately appear in operational text
  // and shouldn't be flagged as site/project codes.
  const ALLCAPS_ALLOW = new Set([
    'MRO','MRP','PD','V1','HCE','WR','FLOC','SOH','SAP','CAT','MB51','IW39',
    'CSV','PDF','API','LLM','JSON','HTML','URL','UTC','CAD','USD','EUR','GBP',
    'OK','YES','NO','TBD','ASAP','EOL','EOQ','ETA','KPI','LTM','YTD','TODO',
    'PURPLE','GREEN','BLUE','RED','ORANGE','GREY','GRAY','OEM'
  ]);

  function lintCustomText(text) {
    const hits = [];
    const s = String(text || '');
    if (!s) return hits;

    // long numeric sequences (≥4 digits): unit numbers, site IDs
    for (const m of s.matchAll(/\b\d{4,}\b/g)) {
      hits.push({ token: m[0], kind: 'longNumeric', index: m.index });
    }
    // company suffixes (case-insensitive)
    const suffixRe = /\b(\w+)\s+(Inc|Corp|Ltd|LLC|Pty|PLC|GmbH|AG|SA|SARL|BV|NV|AB)\.?/gi;
    for (const m of s.matchAll(suffixRe)) {
      hits.push({ token: m[0], kind: 'companySuffix', index: m.index });
    }
    // all-caps tokens (3+ caps) NOT in the allow-list
    for (const m of s.matchAll(/\b[A-Z]{3,}\b/g)) {
      if (!ALLCAPS_ALLOW.has(m[0])) {
        hits.push({ token: m[0], kind: 'allCapsToken', index: m.index });
      }
    }
    // email-like
    for (const m of s.matchAll(/\S+@\S+\.\S+/g)) {
      hits.push({ token: m[0], kind: 'emailLike', index: m.index });
    }
    // IP-address-like
    for (const m of s.matchAll(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g)) {
      hits.push({ token: m[0], kind: 'ipLike', index: m.index });
    }
    return hits;
  }

  function lintKindLabel(kind) {
    switch (kind) {
      case 'longNumeric':   return 'long numeric';
      case 'companySuffix': return 'company suffix';
      case 'allCapsToken':  return 'site/project code?';
      case 'emailLike':     return 'email';
      case 'ipLike':        return 'IP address';
      default:              return kind;
    }
  }

  /* ─── Listing + active selection ────────────────────────────────────────── */
  function list() {
    return FACTORY_CONTEXT_LIBRARY.map(entry => ({ ...entry }));
  }

  function findById(id) {
    return FACTORY_CONTEXT_LIBRARY.find(e => e.id === id) || null;
  }

  async function getActiveId() {
    const saved = await AppStorage.get(KEY_ACTIVE);
    if (typeof saved === 'string' && (findById(saved) || saved === CUSTOM_ID)) return saved;
    return FACTORY_CONTEXT_LIBRARY[0].id;  // default
  }

  async function getActive() {
    const id = await getActiveId();
    if (id === CUSTOM_ID) {
      const customText = await getCustomText();
      return { id: CUSTOM_ID, name: 'Custom (advanced)', text: customText, isCustom: true };
    }
    const entry = findById(id) || FACTORY_CONTEXT_LIBRARY[0];
    return { ...entry, isCustom: false };
  }

  async function setActive(id) {
    if (id !== CUSTOM_ID && !findById(id)) {
      throw new Error(`Unknown context id: ${id}`);
    }
    return AppStorage.set(KEY_ACTIVE, id);
  }

  /* ─── Custom slot ───────────────────────────────────────────────────────── */
  async function getCustomText() {
    const v = await AppStorage.get(KEY_CUSTOM);
    return (typeof v === 'string') ? v : '';
  }

  async function saveCustomText(text) {
    const s = String(text || '');
    if (s.length > MAX_CUSTOM_CHARS) {
      throw new Error(`Custom context exceeds ${MAX_CUSTOM_CHARS} character cap (got ${s.length})`);
    }
    return AppStorage.set(KEY_CUSTOM, s);
  }

  async function clearCustomText() {
    return AppStorage.del(KEY_CUSTOM);
  }

  /* ─── Resolve the actual text injected into the LLM prompt ──────────────── */
  async function resolveContextText() {
    const active = await getActive();
    return String(active.text || '');
  }

  async function hasLintHits() {
    const id = await getActiveId();
    if (id !== CUSTOM_ID) return false;
    const text = await getCustomText();
    return lintCustomText(text).length > 0;
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.AppClientContext = Object.freeze({
    FACTORY_LIBRARY: FACTORY_CONTEXT_LIBRARY,
    CUSTOM_ID,
    MAX_CUSTOM_CHARS,
    list,
    getActive,
    getActiveId,
    setActive,
    getCustomText,
    saveCustomText,
    clearCustomText,
    resolveContextText,
    lintCustomText,
    lintKindLabel,
    hasLintHits
  });

})(window);
