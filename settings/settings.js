/* ═══════════════════════════════════════════════════════════════════════════
   Settings page — parameter defaults · LLM provider config · alias overrides
   Depends on: AppStorage, AppConfig, CanonicalSchema
═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ─── State ─────────────────────────────────────────────────────────────── */
  const state = {
    paramsSaved: { ...CanonicalSchema.FACTORY_DEFAULTS },
    paramsEdit:  { ...CanonicalSchema.FACTORY_DEFAULTS },
    llm: {
      anthropic: { apiKey: '', model: '', models: [], status: '' },
      openai:    { apiKey: '', model: '', models: [], status: '' }
    },
    aliases: {}
  };

  /* ═════════════════════════════════════════════════════════════════════════
     PARAMETERS
  ═════════════════════════════════════════════════════════════════════════ */

  function renderParams(){
    const factory = CanonicalSchema.FACTORY_DEFAULTS;
    const saved   = state.paramsSaved;
    const edit    = state.paramsEdit;

    const fields = [
      { key:'minMaxMethod',        label:'Min/Max method',  type:'select', opts:['monthsBased','leadTimeBased'] },
      { key:'p1Start',             label:'P1 start',        type:'date' },
      { key:'p1End',               label:'P1 end',          type:'date' },
      { key:'p2Months',            label:'P2 months',       type:'number', step:1 },
      { key:'minMonths',           label:'Min months',      type:'number', step:1 },
      { key:'maxMonths',           label:'Max months',      type:'number', step:1 },
      { key:'threshold',           label:'Threshold',       type:'number', step:1 },
      { key:'hcePctThreshold',     label:'HCE % threshold', type:'number', step:0.05 },
      { key:'hceMultThreshold',    label:'HCE multiplier',  type:'number', step:0.5 },
      { key:'lumpyCvThreshold',    label:'Lumpy CV',        type:'number', step:0.1 },
      { key:'lumpyTopWoThreshold', label:'Lumpy top-WO',    type:'number', step:0.05 }
    ];

    const host = $('#paramsGrid');
    host.innerHTML = '';
    for (const f of fields) {
      const cell = document.createElement('div');
      const dirty = edit[f.key] !== saved[f.key];
      cell.className = 'param-cell' + (dirty ? ' dirty' : '');

      let input;
      if (f.type === 'select') {
        input = `<select data-pkey="${f.key}">${f.opts.map(o => `<option value="${o}" ${edit[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
      } else if (f.type === 'date') {
        input = `<input type="date" data-pkey="${f.key}" value="${edit[f.key] || ''}">`;
      } else {
        input = `<input type="number" data-pkey="${f.key}" value="${edit[f.key]}" step="${f.step || 1}">`;
      }
      const factoryDiff = factory[f.key] !== saved[f.key];
      const factoryNote = factoryDiff ? `<div class="factory-note">factory: ${factory[f.key]}</div>` : '';
      cell.innerHTML = `<label>${f.label}${dirty ? ' · UNSAVED' : ''}</label>${input}${factoryNote}`;
      host.appendChild(cell);
    }

    $$('#paramsGrid [data-pkey]').forEach(el => {
      el.addEventListener('change', () => {
        const k = el.dataset.pkey;
        let v = el.value;
        if (el.type === 'number') v = parseFloat(el.value);
        state.paramsEdit[k] = v;
        renderParams();
      });
    });
  }

  function setupParamButtons(){
    $('#paramsSave').addEventListener('click', async () => {
      const v = CanonicalSchema.validateParameters(state.paramsEdit);
      if (!v.ok) { toast('Invalid parameters: ' + v.errors.join('; '), 'crit'); return; }
      await AppConfig.saveDefaults(state.paramsEdit);
      state.paramsSaved = { ...state.paramsEdit };
      renderParams();
      toast('Defaults saved', 'ok');
    });
    $('#paramsRevert').addEventListener('click', () => {
      state.paramsEdit = { ...state.paramsSaved };
      renderParams();
      toast('Reverted to saved', 'ok');
    });
    $('#paramsFactory').addEventListener('click', async () => {
      if (!confirm('Restore factory defaults? This overwrites your saved parameters.')) return;
      await AppConfig.resetDefaults();
      state.paramsSaved = { ...CanonicalSchema.FACTORY_DEFAULTS };
      state.paramsEdit  = { ...CanonicalSchema.FACTORY_DEFAULTS };
      renderParams();
      toast('Factory defaults restored', 'ok');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     LLM PROVIDERS
  ═════════════════════════════════════════════════════════════════════════ */

  async function loadLlm(provider){
    const cfg = await AppConfig.getLlm(provider);
    state.llm[provider].apiKey = cfg.apiKey || '';
    state.llm[provider].model  = cfg.model  || '';
  }

  function renderLlm(provider){
    const card = $(`.llm-card[data-provider="${provider}"]`);
    const s    = state.llm[provider];
    card.querySelector('input.apikey').value = s.apiKey;
    const sel = card.querySelector('select.model');
    sel.innerHTML = '';
    if (s.models.length === 0) {
      sel.innerHTML = `<option value="">— fetch models to populate —</option>`;
      sel.disabled = true;
    } else {
      sel.disabled = false;
      sel.innerHTML = `<option value="">— pick model —</option>` +
        s.models.map(m => `<option value="${escapeAttr(m)}" ${m === s.model ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
    }
    const stat = card.querySelector('.status');
    stat.textContent = s.status || '';
    stat.className = 'status ' + (s.status?.startsWith('✓') ? 'ok' : (s.status?.startsWith('✗') ? 'crit' : ''));
  }

  function setupLlmCards(){
    $$('.llm-card').forEach(card => {
      const provider = card.dataset.provider;
      const apiKeyIn = card.querySelector('input.apikey');
      const modelSel = card.querySelector('select.model');
      const fetchBtn = card.querySelector('.btnFetch');
      const saveBtn  = card.querySelector('.btnSave');
      const clearBtn = card.querySelector('.btnClear');

      apiKeyIn.addEventListener('input', () => { state.llm[provider].apiKey = apiKeyIn.value; });
      modelSel.addEventListener('change', () => { state.llm[provider].model = modelSel.value; });

      fetchBtn.addEventListener('click', async () => {
        if (!state.llm[provider].apiKey) { toast('API key required', 'warn'); return; }
        state.llm[provider].status = 'fetching models…';
        renderLlm(provider);
        try {
          const models = await fetchModels(provider, state.llm[provider].apiKey);
          state.llm[provider].models = models;
          state.llm[provider].status = `✓ ${models.length} model${models.length===1?'':'s'} available`;
          renderLlm(provider);
        } catch (e) {
          state.llm[provider].status = `✗ ${e.message || e}`;
          renderLlm(provider);
        }
      });

      saveBtn.addEventListener('click', async () => {
        const s = state.llm[provider];
        await AppConfig.saveLlm(provider, { apiKey: s.apiKey, model: s.model });
        toast(`${provider} config saved`, 'ok');
      });

      clearBtn.addEventListener('click', async () => {
        if (!confirm(`Clear ${provider} API key and model?`)) return;
        await AppConfig.deleteLlm(provider);
        state.llm[provider] = { apiKey: '', model: '', models: [], status: '' };
        renderLlm(provider);
        toast(`${provider} cleared`, 'ok');
      });
    });
  }

  /* ─── Provider model fetch ──────────────────────────────────────────────── */
  async function fetchModels(provider, apiKey){
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0,120)}`);
      const j = await res.json();
      // Anthropic returns { data: [ { id, ... } ], ... }
      return (j.data || []).map(m => m.id).filter(Boolean).sort();
    }
    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + apiKey }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} — ${(await res.text()).slice(0,120)}`);
      const j = await res.json();
      return (j.data || []).map(m => m.id).filter(Boolean).sort();
    }
    throw new Error(`Unknown provider: ${provider}`);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     COLUMN ALIASES
  ═════════════════════════════════════════════════════════════════════════ */

  function renderAliases(){
    const tbody = $('#aliasBody');
    tbody.innerHTML = '';
    const sources = Object.keys(AppParsers.ALIASES);
    for (const source of sources) {
      const fields = Object.keys(AppParsers.ALIASES[source]);
      for (const field of fields) {
        const builtIns = AppParsers.ALIASES[source][field].join(' · ');
        const userArr  = (state.aliases[source] && state.aliases[source][field]) || [];
        const userStr  = userArr.join('; ');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="src">${source}</td>
          <td class="field">${field}</td>
          <td class="empty" title="built-in aliases">${escapeHtml(builtIns)}</td>
          <td><input type="text" placeholder="extra header(s) · semicolon-separated"
                     data-src="${source}" data-field="${field}"
                     value="${escapeAttr(userStr)}"></td>
        `;
        tbody.appendChild(tr);
      }
    }
    $$('#aliasBody input[data-src]').forEach(inp => {
      inp.addEventListener('change', () => {
        const src = inp.dataset.src, field = inp.dataset.field;
        const arr = inp.value.split(';').map(s => s.trim()).filter(Boolean);
        state.aliases[src] = state.aliases[src] || {};
        if (arr.length) state.aliases[src][field] = arr;
        else            delete state.aliases[src][field];
      });
    });
  }

  function setupAliasButtons(){
    $('#aliasSave').addEventListener('click', async () => {
      // Strip empty source maps
      const cleaned = {};
      for (const [src, fields] of Object.entries(state.aliases)) {
        if (Object.keys(fields).length) cleaned[src] = fields;
      }
      await AppConfig.saveAliases(cleaned);
      toast('Alias overrides saved', 'ok');
    });
    $('#aliasReset').addEventListener('click', async () => {
      if (!confirm('Clear all alias overrides?')) return;
      state.aliases = {};
      await AppConfig.saveAliases({});
      renderAliases();
      toast('Alias overrides cleared', 'ok');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     ABOUT
  ═════════════════════════════════════════════════════════════════════════ */

  async function renderAbout(){
    $('#aboutSchema').textContent = CanonicalSchema.SCHEMA_VERSION;
    $('#aboutApp').textContent    = CanonicalSchema.APP_VERSION;
    const ks = await AppStorage.keys();
    $('#aboutKeys').textContent   = `${ks.length} key${ks.length===1?'':'s'} stored`;
    $('#aboutScopes').textContent = CanonicalSchema.SCOPE_MODES.join(' · ');
  }

  function setupAboutButtons(){
    $('#wipeAll').addEventListener('click', async () => {
      if (!confirm('WIPE ALL local data — every saved intake, every alias override, every LLM key. This cannot be undone. Proceed?')) return;
      await AppStorage.wipeAll();
      await loadAll();
      toast('All local data wiped', 'ok');
    });
    $('#factoryReset').addEventListener('click', async () => {
      if (!confirm('Restore factory defaults — clears parameters, LLM keys, alias overrides. Saved intakes are preserved. Proceed?')) return;
      await AppConfig.factoryReset();
      await loadAll();
      toast('Settings reset to factory', 'ok');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */

  function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]); }
  function escapeAttr(s){ return escapeHtml(s).replace(/'/g, '&#39;'); }
  function toast(msg, kind){
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Boot
  ═════════════════════════════════════════════════════════════════════════ */

  async function loadAll(){
    state.paramsSaved = await AppConfig.getDefaults();
    state.paramsEdit  = { ...state.paramsSaved };
    state.aliases     = await AppConfig.getAliases();
    await loadLlm('anthropic');
    await loadLlm('openai');
    renderParams();
    renderLlm('anthropic');
    renderLlm('openai');
    renderAliases();
    await renderAbout();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadAll();
    setupParamButtons();
    setupLlmCards();
    setupAliasButtons();
    setupAboutButtons();
  });

})();
