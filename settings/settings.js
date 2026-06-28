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
      { key:'minEventsThreshold',  label:'Min consumption events', type:'number', step:1 },
      { key:'hcePctThreshold',     label:'HCE % threshold', type:'number', step:0.05 },
      { key:'hceMultThreshold',    label:'HCE multiplier',  type:'number', step:0.5 },
      { key:'lumpyCvThreshold',    label:'Lumpy CV',        type:'number', step:0.1 },
      { key:'lumpyTopWoThreshold', label:'Lumpy top-WO',    type:'number', step:0.05 },
      { key:'invAdjSigmaThreshold',label:'Inv Adj σ threshold', type:'number', step:0.5 },
      { key:'wrSoftMonths',        label:'WR soft months',  type:'number', step:1 },
      { key:'wrHardMonths',        label:'WR hard months',  type:'number', step:1 },
      { key:'wrMrpTypes',          label:'WR MRP types',    type:'list',   placeholder:'PD, ZE' },
      { key:'socBackCalcMonths',   label:'Stock history window (months)', type:'number', step:1 },
      { key:'p2StockoutDomFraction', label:'Stockout-dominance fraction (P2)', type:'number', step:0.05 }
    ];

    const descs = CanonicalSchema.PARAMETER_DESCRIPTIONS || {};
    const host = $('#paramsGrid');
    host.innerHTML = '';
    for (const f of fields) {
      const cell = document.createElement('div');
      const dirty = JSON.stringify(edit[f.key]) !== JSON.stringify(saved[f.key]);
      cell.className = 'param-cell' + (dirty ? ' dirty' : '');

      let input;
      if (f.type === 'select') {
        input = `<select data-pkey="${f.key}">${f.opts.map(o => `<option value="${o}" ${edit[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
      } else if (f.type === 'date') {
        input = `<input type="date" data-pkey="${f.key}" value="${edit[f.key] || ''}">`;
      } else if (f.type === 'list') {
        const v = Array.isArray(edit[f.key]) ? edit[f.key].join(', ') : '';
        input = `<input type="text" data-pkey="${f.key}" value="${escapeAttr(v)}" placeholder="${escapeAttr(f.placeholder || '')}">`;
      } else {
        input = `<input type="number" data-pkey="${f.key}" value="${edit[f.key]}" step="${f.step || 1}">`;
      }
      const desc = descs[f.key] || '';
      const factoryDiff = JSON.stringify(factory[f.key]) !== JSON.stringify(saved[f.key]);
      const factoryDisplay = Array.isArray(factory[f.key]) ? factory[f.key].join(', ') : factory[f.key];
      const factoryNote = factoryDiff ? `<div class="factory-note">factory: ${escapeHtml(String(factoryDisplay))}</div>` : '';
      cell.innerHTML = `<label>${f.label}${dirty ? ' · UNSAVED' : ''}</label><div class="param-desc">${desc}</div>${input}${factoryNote}`;
      host.appendChild(cell);
    }

    $$('#paramsGrid [data-pkey]').forEach(el => {
      el.addEventListener('change', () => {
        const k = el.dataset.pkey;
        const f = fields.find(x => x.key === k);
        let v = el.value;
        if (el.type === 'number') v = parseFloat(el.value);
        else if (f && f.type === 'list') {
          v = String(el.value || '')
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(Boolean);
        }
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
     OPERATIONAL CONTEXT (v2.1.0) — fixed-pick library + capped Custom slot
     with privacy lint. See shared/client-context.js for the boundary rules.
  ═════════════════════════════════════════════════════════════════════════ */

  async function renderCtxPanel(){
    if (typeof AppClientContext === 'undefined') return;
    const sel = $('#ctxActive');
    const preview = $('#ctxPreview');
    const custom  = $('#ctxCustomText');
    const counter = $('#ctxCustomCounter');
    const block   = $('#ctxCustomBlock');
    const saveBtn = $('#ctxCustomSave');
    if (!sel || !preview) return;

    // Populate dropdown: factory entries + a Custom slot.
    const lib = AppClientContext.list();
    const activeId = await AppClientContext.getActiveId();
    sel.innerHTML = lib.map(e =>
      `<option value="${escapeAttr(e.id)}" ${e.id === activeId ? 'selected' : ''}>${escapeHtml(e.name)}</option>`
    ).join('') + `<option value="${AppClientContext.CUSTOM_ID}" ${activeId === AppClientContext.CUSTOM_ID ? 'selected' : ''}>Custom (advanced)</option>`;

    // Custom textarea + counter
    if (custom) {
      const customText = await AppClientContext.getCustomText();
      custom.value = customText;
      if (counter) counter.textContent = `${customText.length}/${AppClientContext.MAX_CUSTOM_CHARS}`;
      if (block && activeId === AppClientContext.CUSTOM_ID) block.open = true;
      renderCtxLint(custom.value, saveBtn);
    }

    // Preview reflects the currently-saved active selection
    const active = await AppClientContext.getActive();
    renderCtxPreview(preview, active);
  }

  function renderCtxPreview(host, active){
    const txt = String(active.text || '');
    if (!txt) {
      host.innerHTML = `<span class="ctx-preview-empty">(no context — {customerContext} will resolve to "(none)")</span>`;
    } else {
      host.innerHTML = `<span class="ctx-preview-text">${escapeHtml(txt)}</span>` +
                      `<span class="ctx-preview-meta">${active.isCustom ? 'Custom' : 'Library'} · ${txt.length} chars</span>`;
    }
  }

  function renderCtxLint(text, saveBtn){
    const host = $('#ctxLint');
    if (!host) return;
    const hits = AppClientContext.lintCustomText(text);
    if (!hits.length) {
      host.innerHTML = '';
      host.classList.remove('has-hits');
      if (saveBtn) saveBtn.textContent = 'Save Custom';
      return;
    }
    host.classList.add('has-hits');
    const tokens = hits.map(h =>
      `<span class="ctx-lint-token ${h.kind}" title="${escapeAttr(AppClientContext.lintKindLabel(h.kind))}">${escapeHtml(h.token)}</span>`
    ).join('');
    host.innerHTML = `<span class="ctx-lint-lab">⚠ Possible client identifiers:</span> ${tokens}`;
    if (saveBtn) saveBtn.textContent = 'Save Custom (lint warnings)';
  }

  function setupCtxPanel(){
    if (typeof AppClientContext === 'undefined') return;
    const sel     = $('#ctxActive');
    const custom  = $('#ctxCustomText');
    const counter = $('#ctxCustomCounter');
    const saveBtn = $('#ctxCustomSave');
    const clearBtn= $('#ctxCustomClear');
    const useBtn  = $('#ctxCustomUse');
    const preview = $('#ctxPreview');
    if (!sel) return;

    sel.addEventListener('change', async () => {
      await AppClientContext.setActive(sel.value);
      const active = await AppClientContext.getActive();
      renderCtxPreview(preview, active);
      toast(`Active context: ${active.name}`, 'ok');
    });

    if (custom) {
      custom.addEventListener('input', () => {
        if (counter) counter.textContent = `${custom.value.length}/${AppClientContext.MAX_CUSTOM_CHARS}`;
        renderCtxLint(custom.value, saveBtn);
      });
    }

    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const text = (custom && custom.value) || '';
      const hits = AppClientContext.lintCustomText(text);
      if (hits.length) {
        const flagged = hits.map(h => `${h.token} (${AppClientContext.lintKindLabel(h.kind)})`).join('\n  ');
        const ok = confirm(
          'Lint detected possible client identifiers in your Custom context:\n  ' + flagged +
          '\n\nThis text will cross the browser → LLM provider boundary if you set Custom as active. Save anyway?'
        );
        if (!ok) return;
      }
      try {
        await AppClientContext.saveCustomText(text);
        toast('Custom context saved' + (hits.length ? ' · lint warnings logged' : ''), hits.length ? 'warn' : 'ok');
        const active = await AppClientContext.getActive();
        renderCtxPreview(preview, active);
      } catch (e) {
        toast('Save failed: ' + (e.message || e), 'crit');
      }
    });

    if (clearBtn) clearBtn.addEventListener('click', async () => {
      await AppClientContext.clearCustomText();
      if (custom) custom.value = '';
      if (counter) counter.textContent = `0/${AppClientContext.MAX_CUSTOM_CHARS}`;
      renderCtxLint('', saveBtn);
      // If Custom was active, preview now shows empty Custom
      const active = await AppClientContext.getActive();
      renderCtxPreview(preview, active);
      toast('Custom context cleared', 'ok');
    });

    if (useBtn) useBtn.addEventListener('click', async () => {
      // Save (with lint confirm if needed) AND set Custom as active.
      const text = (custom && custom.value) || '';
      const hits = AppClientContext.lintCustomText(text);
      if (hits.length) {
        const flagged = hits.map(h => `${h.token} (${AppClientContext.lintKindLabel(h.kind)})`).join('\n  ');
        const ok = confirm(
          'Lint detected possible client identifiers in your Custom context:\n  ' + flagged +
          '\n\nSet Custom as active and use this text in every LLM prompt? It will cross the browser → LLM provider boundary.'
        );
        if (!ok) return;
      }
      try {
        await AppClientContext.saveCustomText(text);
        await AppClientContext.setActive(AppClientContext.CUSTOM_ID);
        sel.value = AppClientContext.CUSTOM_ID;
        const active = await AppClientContext.getActive();
        renderCtxPreview(preview, active);
        toast('Custom context is now active', hits.length ? 'warn' : 'ok');
      } catch (e) {
        toast('Save failed: ' + (e.message || e), 'crit');
      }
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
     MULTI-PLANT (APP-T-01d) — toggle preference, default OFF per D25.
     Stores boolean under 'settings.multiPlant'. No analytical effect in
     this chunk — the scope-picker modal (T-01e) and the plant-conditional
     column logic (T-01f) will read this flag once they land.
  ═════════════════════════════════════════════════════════════════════════ */

  async function renderMultiPlant(){
    const cb = $('#multiPlantToggle');
    if (!cb) return;
    const enabled = await AppConfig.getMultiPlant();
    cb.checked = enabled;
    updateMultiPlantStatus(enabled, /*dirty*/ false);
  }

  function updateMultiPlantStatus(enabled, dirty){
    const el = $('#multiPlantStatus');
    if (!el) return;
    const onOff = enabled ? 'ON' : 'OFF (default)';
    el.textContent = dirty ? `Unsaved · ${onOff}` : `Saved · ${onOff}`;
    el.className = 'mp-toggle-status' + (dirty ? ' dirty' : '');
  }

  function setupMultiPlantButtons(){
    const cb   = $('#multiPlantToggle');
    const save = $('#multiPlantSave');
    if (!cb || !save) return;
    cb.addEventListener('change', () => updateMultiPlantStatus(cb.checked, /*dirty*/ true));
    save.addEventListener('click', async () => {
      await AppConfig.setMultiPlant(cb.checked);
      updateMultiPlantStatus(cb.checked, /*dirty*/ false);
      toast(`Multi-plant analysis ${cb.checked ? 'enabled' : 'disabled'}`, 'ok');
    });
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
    await renderCtxPanel();
    renderAliases();
    await renderPromptEditor();
    await renderPromptEditorV();                                      /* APP-LLM-V */
    await renderMultiPlant();                                         /* APP-T-01d */
    await renderAbout();
  }

  /* ─── LLM prompt template editor (v2.0) ───────────────────────────────── */
  async function renderPromptEditor(){
    const ta = document.querySelector('#promptTemplate');
    if (!ta) return;
    const tpl = await AppConfig.getPromptTemplate();
    ta.value = tpl;

    const phHost = document.querySelector('#promptPlaceholders');
    if (phHost) {
      phHost.innerHTML = '';
      (AppConfig.PROMPT_PLACEHOLDERS || []).forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'ph-chip';
        chip.textContent = '{' + p + '}';
        chip.title = 'Click to insert at cursor';
        chip.addEventListener('click', () => insertAtCursor(ta, '{' + p + '}'));
        phHost.appendChild(chip);
      });
    }
    await refreshPromptHash(tpl);
  }

  /* APP-LLM-V — the "(v)" variant editor (own slot, own factory fallback) */
  async function renderPromptEditorV(){
    const ta = document.querySelector('#promptTemplateV');
    if (!ta) return;
    ta.value = await AppConfig.getPromptTemplateV();
    const phHost = document.querySelector('#promptPlaceholdersV');
    if (phHost) {
      phHost.innerHTML = '';
      (AppConfig.PROMPT_PLACEHOLDERS || []).forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'ph-chip';
        chip.textContent = '{' + p + '}';
        chip.title = 'Click to insert at cursor';
        chip.addEventListener('click', () => insertAtCursor(ta, '{' + p + '}', '#promptHashV'));
        phHost.appendChild(chip);
      });
    }
    await refreshPromptHash(ta.value, '#promptHashV');
  }

  function insertAtCursor(textarea, text, hashSel){
    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    const v     = textarea.value;
    textarea.value = v.slice(0, start) + text + v.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    refreshPromptHash(textarea.value, hashSel);
  }

  async function refreshPromptHash(text, sel){
    const out = document.querySelector(sel || '#promptHash');
    if (!out || typeof AppLlm === 'undefined') return;
    const h = await AppLlm.hashTemplate(text);
    out.textContent = h || '(unavailable)';
  }

  function setupPromptButtons(){
    const ta = document.querySelector('#promptTemplate');
    if (ta) {
      ta.addEventListener('input', () => refreshPromptHash(ta.value));
      document.querySelector('#promptSave').addEventListener('click', async () => {
        await AppConfig.savePromptTemplate(ta.value);
        toast('Prompt template (base) saved', 'ok');
        refreshPromptHash(ta.value);
      });
      document.querySelector('#promptReset').addEventListener('click', async () => {
        if (!confirm('Reset the (base) prompt to the factory default? Your edits will be lost.')) return;
        await AppConfig.resetPromptTemplate();
        await renderPromptEditor();
        toast('Prompt template (base) reset to factory', 'ok');
      });
    }
    // APP-LLM-V — the "(v)" variant editor
    const taV = document.querySelector('#promptTemplateV');
    if (taV) {
      taV.addEventListener('input', () => refreshPromptHash(taV.value, '#promptHashV'));
      document.querySelector('#promptSaveV').addEventListener('click', async () => {
        await AppConfig.savePromptTemplateV(taV.value);
        toast('Prompt template (v) saved', 'ok');
        refreshPromptHash(taV.value, '#promptHashV');
      });
      document.querySelector('#promptResetV').addEventListener('click', async () => {
        if (!confirm('Reset the (v) prompt to the factory default? Your edits will be lost.')) return;
        await AppConfig.resetPromptTemplateV();
        await renderPromptEditorV();
        toast('Prompt template (v) reset to factory', 'ok');
      });
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadAll();
    setupParamButtons();
    setupLlmCards();
    setupCtxPanel();
    setupAliasButtons();
    setupPromptButtons();
    setupMultiPlantButtons();                                         /* APP-T-01d */
    setupAboutButtons();
  });

})();
