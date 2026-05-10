/* ═══════════════════════════════════════════════════════════════════════════
   Intake engine — wires the six-section workflow together.
   Depends on (loaded earlier in HTML): SheetJS (XLSX), PapaParse (Papa),
   AppParsers, AppStorage, AppConfig, CanonicalSchema.
═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Sources required and conditional ──────────────────────────────────── */
  const REQUIRED_SOURCES   = ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'];
  const CONDITIONAL_SOURCES= ['materialVendor', 'leadTimes'];

  const SOURCE_LABEL = {
    mb51:            'MB51 — Material Movements',
    iw39:            'IW39 — Work Orders',
    fleetMaster:     'Fleet Master',
    inventoryMaster: 'Inventory Master',
    materialVendor:  'Material — Vendor mapping',
    leadTimes:       'Lead Times'
  };

  /* ─── Mutable module state ──────────────────────────────────────────────── */
  const state = {
    files:    {},                                    // source → File
    parsed:   {},                                    // source → parseAndMap result
    dq:       null,                                  // { passed, issues, warnings, tiles }
    scope:    CanonicalSchema.emptyScope('fleet'),
    paramsSaved: { ...CanonicalSchema.FACTORY_DEFAULTS },
    paramsRun:   { ...CanonicalSchema.FACTORY_DEFAULTS },
    aliases:  {},
    runDate:  new Date().toISOString().slice(0, 10),
    name:     ''
  };

  /* ─── DOM refs ──────────────────────────────────────────────────────────── */
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 1 — Upload
  ═════════════════════════════════════════════════════════════════════════ */

  function setupDropZones(){
    REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES).forEach(source => {
      const drop = document.querySelector(`.drop[data-source="${source}"]`);
      if (!drop) return;
      const input = drop.querySelector('input[type="file"]');
      drop.addEventListener('dragover',  (e) => { e.preventDefault(); drop.classList.add('dragover'); });
      drop.addEventListener('dragleave', ()  => drop.classList.remove('dragover'));
      drop.addEventListener('drop',      (e) => {
        e.preventDefault();
        drop.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(source, e.dataTransfer.files[0]);
      });
      input.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(source, e.target.files[0]);
      });
    });
  }

  async function handleFile(source, file){
    state.files[source] = file;
    const drop = document.querySelector(`.drop[data-source="${source}"]`);
    drop.classList.add('loaded');
    drop.querySelector('.file').textContent = `${file.name} · parsing…`;

    try {
      const result = await AppParsers.parseAndMap(file, source, state.aliases);
      state.parsed[source] = result;
      const sheetTxt = result.sheet ? ` · sheet: "${result.sheet}"` : '';
      drop.querySelector('.file').textContent = `${file.name} · ${result.rowCount.toLocaleString()} rows${sheetTxt}`;
      onParseUpdated();
    } catch (e) {
      console.error(e);
      drop.classList.remove('loaded');
      drop.querySelector('.file').textContent = `${file.name} · ERROR: ${e.message || e}`;
      toast('Parse failed: ' + (e.message || e), 'crit');
    }
  }

  function onParseUpdated(){
    renderSchema();
    if (REQUIRED_SOURCES.every(s => state.parsed[s])) {
      runDqGate();
    }
    renderJsonPreview();
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 2 — Schema mapping
  ═════════════════════════════════════════════════════════════════════════ */

  function renderSchema(){
    const host = $('#schemaRows');
    host.innerHTML = '';
    const order = REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES);
    let totalMissing = 0, totalMatched = 0;

    for (const source of order) {
      const parsed = state.parsed[source];
      if (!parsed) continue;
      const fields = Object.keys(AppParsers.ALIASES[source] || {});
      for (const field of fields) {
        const header = parsed.fieldMap[field];
        const matched = !!header;
        if (matched) totalMatched++; else totalMissing++;

        const row = document.createElement('div');
        row.className = 'schema-row ' + (matched ? 'matched' : 'missing');

        const opts = ['<option value="">— choose header —</option>']
          .concat(parsed.headers.map(h => `<option value="${escapeAttr(h)}" ${h === header ? 'selected' : ''}>${escapeHtml(h)}</option>`))
          .join('');

        row.innerHTML = `
          <div class="src">${SOURCE_LABEL[source].split('—')[0].trim()}</div>
          <div class="field">${field}</div>
          <div class="header">${matched ? `<select data-source="${source}" data-field="${field}">${opts}</select>` : `<em>not matched</em><select data-source="${source}" data-field="${field}">${opts}</select>`}</div>
          <div class="ok">${matched ? '✓' : '!'}</div>
        `;
        host.appendChild(row);
      }
    }

    $('#schemaSummary').textContent =
      totalMatched + totalMissing === 0
        ? 'no files parsed yet'
        : `${totalMatched} matched · ${totalMissing} unmatched`;
    $('#schemaSummary').className = 'step-status ' + (totalMissing === 0 ? 'done' : 'warn');

    // Wire override dropdowns — user picks a header → save as session alias → re-parse
    $$('#schemaRows select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const source    = e.target.dataset.source;
        const field     = e.target.dataset.field;
        const newHeader = e.target.value;
        if (!state.files[source]) return;

        state.aliases[source] = state.aliases[source] || {};
        if (newHeader) state.aliases[source][field] = [newHeader];
        else           delete state.aliases[source][field];

        try {
          const result = await AppParsers.parseAndMap(state.files[source], source, state.aliases);
          state.parsed[source] = result;
          _matNetCacheKey = null;                  // invalidate net-consumption cache
          if (state.dq) runDqGate();
          renderSchema();
          populateScopeOptions();
          renderJsonPreview();
        } catch (err) {
          toast('Re-parse failed: ' + (err.message || err), 'crit');
        }
      });
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 3 — Data Quality Gate (port of 01_data_quality.py)
  ═════════════════════════════════════════════════════════════════════════ */

  function runDqGate(){
    const issues = [];
    const warnings = [];
    const tiles = [];

    const mb51 = state.parsed.mb51?.canonical || [];
    const iw39 = state.parsed.iw39?.canonical || [];
    const fleet = state.parsed.fleetMaster?.canonical || [];
    const master = state.parsed.inventoryMaster?.canonical || [];

    // ── MB51 ─────────────────────────────────────────────────────────
    if (mb51.length === 0) {
      issues.push({ code:'mb51_empty', sev:'crit', msg:'MB51 has no rows' });
    } else {
      const dates = mb51.map(r => r.postingDate).filter(Boolean).sort();
      const minD = dates[0], maxD = dates[dates.length-1];
      const months = monthsBetween(minD, maxD);
      tiles.push({ lab:'MB51 rows',           v:mb51.length.toLocaleString(),  desc:`${minD || '?'} → ${maxD || '?'}` });
      tiles.push({ lab:'MB51 span (months)',  v:months.toString(),             desc:'≥ 12 required',
                   cls: months < 12 ? 'crit' : 'ok' });
      if (months < 12) issues.push({ code:'mb51_span', sev:'crit', msg:`MB51 spans only ${months} months — minimum 12 required` });

      const movs = uniq(mb51.map(r => String(r.movementType || '').trim())).filter(Boolean).sort();
      const expected = ['261','262','201','202'];
      const unexpected = movs.filter(m => !expected.includes(m));
      if (unexpected.length) warnings.push({ code:'mb51_movts', sev:'warn', msg:`MB51 has unexpected movement types: ${unexpected.join(', ')} — will be ignored downstream` });

      const has261 = movs.includes('261');
      const has262 = movs.includes('262');
      if (!has261) issues.push({ code:'mb51_no_261', sev:'crit', msg:'MB51 has no 261 (goods issue) movements' });
      if (!has262) warnings.push({ code:'mb51_no_262', sev:'warn', msg:'MB51 has no 262 (return) movements — net = gross' });

      const uniqMats = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
      tiles.push({ lab:'MB51 unique materials', v:uniqMats.size.toLocaleString(), desc:'distinct material numbers' });
    }

    // ── IW39 ─────────────────────────────────────────────────────────
    if (iw39.length === 0) {
      warnings.push({ code:'iw39_empty', sev:'warn', msg:'IW39 has no rows — fleet scope will be empty' });
    } else {
      const histRows = iw39.filter(r => r.basicStartDate && r.basicStartDate <= state.runDate);
      const futRows  = iw39.filter(r => r.basicStartDate && r.basicStartDate >  state.runDate);
      tiles.push({ lab:'IW39 historical', v:histRows.length.toLocaleString(), desc:`vs ${futRows.length} future (excluded)` });
      if (histRows.length === 0) issues.push({ code:'iw39_no_hist', sev:'crit', msg:'IW39 has no historical orders after future-date filter' });

      // Coverage: % of MB51 orders found in IW39
      if (mb51.length) {
        const iw39Orders = new Set(iw39.map(r => String(r.order || '').trim()).filter(Boolean));
        const mb51Orders = new Set(mb51.map(r => String(r.order || '').trim()).filter(Boolean));
        const overlap    = [...mb51Orders].filter(o => iw39Orders.has(o)).length;
        const pct        = mb51Orders.size ? (overlap / mb51Orders.size * 100).toFixed(1) : '0';
        tiles.push({ lab:'IW39 ⊃ MB51 orders', v:`${pct}%`, desc:`${overlap.toLocaleString()} / ${mb51Orders.size.toLocaleString()}`,
                     cls: parseFloat(pct) < 50 ? 'warn' : 'ok' });
        if (parseFloat(pct) < 50) warnings.push({ code:'iw39_coverage', sev:'warn', msg:`Only ${pct}% of MB51 orders found in IW39 — fleet WO filter will exclude many MB51 rows` });
      }
    }

    // ── Fleet Master ─────────────────────────────────────────────────
    if (fleet.length === 0) {
      warnings.push({ code:'fleet_empty', sev:'warn', msg:'Fleet Master has no rows — fleet scope mode unavailable' });
    } else {
      const models = uniq(fleet.map(r => String(r.model || '').trim()).filter(Boolean));
      tiles.push({ lab:'Fleet models',    v:models.length.toString(), desc:`${fleet.length} units total` });
      // Case-dupe check
      const lowerMap = {};
      models.forEach(m => {
        const k = m.toLowerCase();
        (lowerMap[k] = lowerMap[k] || []).push(m);
      });
      const caseDupes = Object.values(lowerMap).filter(arr => arr.length > 1);
      caseDupes.forEach(arr => {
        issues.push({ code:'fleet_case_dupe', sev:'crit', msg:`Fleet model case conflict: ${JSON.stringify(arr)} — confirm merge before proceeding` });
      });
    }

    // ── Inventory Master ──────────────────────────────────────────────
    if (master.length === 0) {
      issues.push({ code:'master_empty', sev:'crit', msg:'Inventory Master has no rows' });
    } else {
      const mats = new Set(master.map(r => String(r.material || '').trim()).filter(Boolean));
      tiles.push({ lab:'Inv Master materials', v:mats.size.toLocaleString(), desc:'with MRP settings' });
      // Reconciliation against MB51
      if (mb51.length) {
        const mb51Mats = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
        const matched  = [...mb51Mats].filter(m => mats.has(m)).length;
        const unmatch  = mb51Mats.size - matched;
        const pct      = mb51Mats.size ? (matched / mb51Mats.size * 100).toFixed(1) : '0';
        tiles.push({ lab:'Reconciliation', v:`${pct}%`, desc:`${unmatch.toLocaleString()} not in Master`,
                     cls: parseFloat(pct) < 80 ? 'warn' : 'ok' });
        if (unmatch > 0) {
          warnings.push({ code:'master_recon', sev:'warn', msg:`${unmatch} MB51 materials not in Inventory Master — will be excluded from MRP analysis` });
        }
      }
      // Case-dupe check on materials
      const lower = {};
      master.forEach(r => {
        const m = String(r.material || '').trim();
        if (!m) return;
        const k = m.toLowerCase();
        (lower[k] = lower[k] || []).push(m);
      });
      const dupes = Object.values(lower).filter(a => uniq(a).length > 1);
      if (dupes.length) issues.push({ code:'master_case_dupe', sev:'crit', msg:`${dupes.length} material case-conflict(s) in Inventory Master` });
    }

    state.dq = {
      issues, warnings, tiles,
      passed: issues.length === 0
    };
    renderDq();
    renderJsonPreview();
    populateScopeOptions();
  }

  function renderDq(){
    const dq = state.dq;
    if (!dq) return;
    const tilesHost = $('#dqTiles'); tilesHost.innerHTML = '';
    dq.tiles.forEach(t => {
      const el = document.createElement('div');
      el.className = 'dq-tile';
      el.innerHTML = `<span class="lab">${t.lab}</span><div class="v ${t.cls || ''}">${t.v}</div><div class="desc">${t.desc || ''}</div>`;
      tilesHost.appendChild(el);
    });
    const listHost = $('#dqList'); listHost.innerHTML = '';
    dq.issues.concat(dq.warnings).forEach(i => {
      const li = document.createElement('li');
      li.className = i.sev;
      li.innerHTML = `<span class="sev">${i.sev}</span><span>${escapeHtml(i.msg)}</span>`;
      listHost.appendChild(li);
    });
    if (dq.issues.length === 0 && dq.warnings.length === 0) {
      listHost.innerHTML = '<li class="ok"><span class="sev">ok</span><span>All checks passed.</span></li>';
    }
    const status = $('#step3Status');
    if (dq.issues.length)        { status.textContent = `${dq.issues.length} critical · halt`; status.className = 'step-status crit'; }
    else if (dq.warnings.length) { status.textContent = `${dq.warnings.length} warning${dq.warnings.length>1?'s':''} · review`; status.className = 'step-status warn'; }
    else                          { status.textContent = 'green'; status.className = 'step-status done'; }

    // enable / disable scope step
    const scopeStep = $('#step4');
    if (dq.passed) scopeStep.classList.remove('disabled');
    else           scopeStep.classList.add('disabled');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 4 — Scope selector
  ═════════════════════════════════════════════════════════════════════════ */

  function setupScopeTabs(){
    $$('.scope-tabs .tab').forEach(t => {
      t.addEventListener('click', () => {
        const mode = t.dataset.mode;
        state.scope.mode = mode;
        $$('.scope-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
        $$('.scope-pane').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
        // show/hide conditional drops
        document.querySelector('.drop[data-source="materialVendor"]').parentElement.classList.toggle('hidden', mode !== 'byVendor');
        renderScopePreview();
        renderJsonPreview();
      });
    });
  }

  function populateScopeOptions(){
    // Fleet — chips for each model
    const fleet = state.parsed.fleetMaster?.canonical || [];
    const models = uniq(fleet.map(r => String(r.model || '').trim()).filter(Boolean)).sort();
    const fleetHost = $('#fleetModels'); fleetHost.innerHTML = '';
    models.forEach(m => {
      const c = chip(m, () => {
        const arr = state.scope.fleet.models;
        const i = arr.indexOf(m);
        if (i >= 0) arr.splice(i, 1); else arr.push(m);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.fleet.models.includes(m)) c.classList.add('selected');
      fleetHost.appendChild(c);
    });

    // Classification — populate inventory types & MRP classifiers
    const master = state.parsed.inventoryMaster?.canonical || [];
    const invTypes = uniq(master.map(r => String(r.inventoryType || '').trim()).filter(Boolean)).sort();
    const mrpInds  = uniq(master.map(r => String(r.mrpInd || '').trim()).filter(Boolean)).sort();

    const invHost = $('#classifInvTypes'); invHost.innerHTML = '';
    invTypes.forEach(t => {
      const c = chip(t, () => {
        const arr = state.scope.byClassification.inventoryTypes;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1); else arr.push(t);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.byClassification.inventoryTypes.includes(t)) c.classList.add('selected');
      invHost.appendChild(c);
    });

    const mrpHost = $('#classifMrp'); mrpHost.innerHTML = '';
    mrpInds.forEach(t => {
      const c = chip(t, () => {
        const arr = state.scope.byClassification.mrpClassifiers;
        const i = arr.indexOf(t);
        if (i >= 0) arr.splice(i, 1); else arr.push(t);
        c.classList.toggle('selected');
        renderScopePreview();
        renderJsonPreview();
      });
      if (state.scope.byClassification.mrpClassifiers.includes(t)) c.classList.add('selected');
      mrpHost.appendChild(c);
    });

    // Vendor — populated only if materialVendor parsed
    const vmap = state.parsed.materialVendor?.canonical || [];
    const vendors = uniq(vmap.map(r => String(r.vendor || '').trim()).filter(Boolean)).sort();
    const vendorHost = $('#vendorList'); vendorHost.innerHTML = '';
    if (vendors.length === 0) {
      vendorHost.innerHTML = '<div class="hint">Upload a Material-Vendor mapping file (Step 1, conditional zone) to populate this list.</div>';
    } else {
      vendors.forEach(v => {
        const c = chip(v, () => {
          const arr = state.scope.byVendor.vendors;
          const i = arr.indexOf(v);
          if (i >= 0) arr.splice(i, 1); else arr.push(v);
          c.classList.toggle('selected');
          renderScopePreview();
          renderJsonPreview();
        });
        if (state.scope.byVendor.vendors.includes(v)) c.classList.add('selected');
        vendorHost.appendChild(c);
      });
    }

    renderScopePreview();
  }

  function chip(label, onclick){
    const el = document.createElement('span');
    el.className = 'chip';
    el.textContent = label;
    el.addEventListener('click', onclick);
    return el;
  }

  function renderScopePreview(){
    const mode = state.scope.mode;
    const host = document.querySelector(`.scope-pane[data-mode="${mode}"] .scope-preview`);
    if (!host) return;

    const fleet  = state.parsed.fleetMaster?.canonical || [];
    const iw39   = state.parsed.iw39?.canonical || [];
    const master = state.parsed.inventoryMaster?.canonical || [];
    const mb51   = state.parsed.mb51?.canonical || [];
    const vmap   = state.parsed.materialVendor?.canonical || [];

    if (mode === 'fleet') {
      const sel = state.scope.fleet.models;
      const units = fleet.filter(r => sel.includes(String(r.model || '').trim()));
      const sortFields = new Set(units.map(u => String(u.sortField || '').trim()).filter(Boolean));
      const fleetOrders = iw39.filter(o => sortFields.has(String(o.sortField || '').trim()) && o.basicStartDate <= state.runDate);
      host.innerHTML = sel.length === 0
        ? `<span class="v warn">no models selected</span> &middot; pick one or more from the chips above`
        : `selected <span class="v">${sel.length}</span> model${sel.length>1?'s':''} &middot; <span class="v">${units.length}</span> equipment unit${units.length===1?'':'s'} &middot; <span class="v">${fleetOrders.length.toLocaleString()}</span> qualifying historical work order${fleetOrders.length===1?'':'s'}`;
    }

    if (mode === 'manual') {
      const list = state.scope.manual.materials;
      const masterMats = new Set(master.map(r => String(r.material || '').trim()));
      const mb51Mats   = new Set(mb51.map(r => String(r.material || '').trim()));
      const inMaster   = list.filter(m => masterMats.has(m)).length;
      const inMb51     = list.filter(m => mb51Mats.has(m)).length;
      host.innerHTML = list.length === 0
        ? `<span class="v warn">no materials provided</span> &middot; paste or upload below`
        : `<span class="v">${list.length}</span> material${list.length===1?'':'s'} &middot; in MB51: <span class="v">${inMb51}</span> &middot; in Inventory Master: <span class="v">${inMaster}</span>`;
    }

    if (mode === 'byClassification') {
      const f = state.scope.byClassification;
      const matching = master.filter(r => {
        if (f.inventoryTypes.length && !f.inventoryTypes.includes(String(r.inventoryType || '').trim())) return false;
        if (f.mrpClassifiers.length && !f.mrpClassifiers.includes(String(r.mrpInd || '').trim())) return false;
        return true;
      });
      // Movement amount filter is applied per-material against MB51 net consumption
      let withinMvmt = matching;
      if (f.movementAmount.min != null || f.movementAmount.max != null) {
        const matNet = computeNetConsumption(mb51);
        withinMvmt = matching.filter(r => {
          const m = String(r.material || '').trim();
          const net = matNet[m] || 0;
          if (f.movementAmount.min != null && net < f.movementAmount.min) return false;
          if (f.movementAmount.max != null && net > f.movementAmount.max) return false;
          return true;
        });
      }
      const byMrp = {};
      withinMvmt.forEach(r => {
        const k = String(r.mrpInd || '—').trim();
        byMrp[k] = (byMrp[k] || 0) + 1;
      });
      const mrpBreakdown = Object.entries(byMrp).map(([k,v]) => `<span class="v">${k}</span>:${v}`).join(' &middot; ') || '—';
      host.innerHTML = `<span class="v">${withinMvmt.length}</span> material${withinMvmt.length===1?'':'s'} match &middot; ${mrpBreakdown}`;
    }

    if (mode === 'byVendor') {
      const sel = state.scope.byVendor.vendors;
      const matsByVendor = {};
      vmap.forEach(r => {
        const v = String(r.vendor || '').trim();
        if (!sel.includes(v)) return;
        (matsByVendor[v] = matsByVendor[v] || new Set()).add(String(r.material || '').trim());
      });
      const total = Object.values(matsByVendor).reduce((a, s) => a + s.size, 0);
      // total consumption
      const matNet = computeNetConsumption(mb51);
      let consumption = 0;
      Object.values(matsByVendor).forEach(s => s.forEach(m => { consumption += matNet[m] || 0; }));
      host.innerHTML = sel.length === 0
        ? `<span class="v warn">no vendors selected</span>`
        : `<span class="v">${sel.length}</span> vendor${sel.length===1?'':'s'} &middot; <span class="v">${total}</span> material${total===1?'':'s'} &middot; net consumption (12mo): <span class="v">${Math.round(consumption).toLocaleString()}</span>`;
    }
  }

  // Net consumption per material (cached)
  let _matNetCache = null;
  let _matNetCacheKey = null;
  function computeNetConsumption(mb51){
    const key = mb51.length;
    if (_matNetCacheKey === key && _matNetCache) return _matNetCache;
    const out = {};
    for (const r of mb51) {
      const m = String(r.material || '').trim();
      if (!m) continue;
      const mt = String(r.movementType || '').trim();
      const q  = parseFloat(r.quantity);
      if (isNaN(q)) continue;
      out[m] = out[m] || 0;
      if (mt === '261' || mt === '201') out[m] += Math.abs(q);
      if (mt === '262' || mt === '202') out[m] -= Math.abs(q);
    }
    _matNetCache = out; _matNetCacheKey = key;
    return out;
  }

  /* ─── Manual paste handling ─────────────────────────────────────────────── */
  function setupManualPaste(){
    const ta = $('#manualPaste');
    ta.addEventListener('input', () => {
      state.scope.manual.materials = ta.value
        .split(/[\s,;\t]+/)
        .map(s => s.trim())
        .filter(Boolean);
      renderScopePreview();
      renderJsonPreview();
    });
  }

  function setupClassifInputs(){
    const minI = $('#mvmtMin'), maxI = $('#mvmtMax');
    minI.addEventListener('input', () => {
      const v = parseFloat(minI.value);
      state.scope.byClassification.movementAmount.min = isNaN(v) ? null : v;
      renderScopePreview(); renderJsonPreview();
    });
    maxI.addEventListener('input', () => {
      const v = parseFloat(maxI.value);
      state.scope.byClassification.movementAmount.max = isNaN(v) ? null : v;
      renderScopePreview(); renderJsonPreview();
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 5 — Parameters
  ═════════════════════════════════════════════════════════════════════════ */

  async function loadDefaults(){
    state.aliases = await AppConfig.getAliases();
    state.paramsSaved = await AppConfig.getDefaults();
    state.paramsRun   = { ...state.paramsSaved };
    renderParams();
  }

  function renderParams(){
    const factory = CanonicalSchema.FACTORY_DEFAULTS;
    const saved   = state.paramsSaved;
    const run     = state.paramsRun;

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
      cell.className = 'param-cell' + (run[f.key] !== saved[f.key] ? ' dirty' : '');

      let input;
      if (f.type === 'select') {
        input = `<select data-pkey="${f.key}">${f.opts.map(o => `<option value="${o}" ${run[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
      } else if (f.type === 'date') {
        input = `<input type="date" data-pkey="${f.key}" value="${run[f.key] || ''}">`;
      } else {
        input = `<input type="number" data-pkey="${f.key}" value="${run[f.key]}" step="${f.step || 1}">`;
      }
      const factoryNote = factory[f.key] !== saved[f.key] ? `<div class="factory-note">factory: ${factory[f.key]} · saved: ${saved[f.key]}</div>` : '';
      cell.innerHTML = `<label>${f.label}</label>${input}${factoryNote}`;
      host.appendChild(cell);
    }
    $$('#paramsGrid [data-pkey]').forEach(el => {
      el.addEventListener('change', (e) => {
        const k = el.dataset.pkey;
        let v;
        if (el.type === 'number') v = parseFloat(el.value);
        else                       v = el.value;
        state.paramsRun[k] = v;
        if (k === 'minMaxMethod') toggleLeadTimesDrop();
        renderParams();
        renderJsonPreview();
      });
    });
    toggleLeadTimesDrop();
  }

  function toggleLeadTimesDrop(){
    const drop = document.querySelector('.drop[data-source="leadTimes"]');
    if (!drop) return;
    const wrap = drop.parentElement;
    wrap.classList.toggle('hidden', state.paramsRun.minMaxMethod !== 'leadTimeBased');
  }

  function setupParamButtons(){
    $('#paramsReset').addEventListener('click', () => {
      state.paramsRun = { ...state.paramsSaved };
      renderParams(); renderJsonPreview();
      toast('Reverted to saved defaults', 'ok');
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 6 — Review & Export
  ═════════════════════════════════════════════════════════════════════════ */

  function buildJson(){
    const json = CanonicalSchema.emptyJson();
    json.metadata.assessmentName = state.name || $('#assessmentName').value || '';
    json.metadata.createdBy      = $('#createdBy').value || '';
    json.metadata.createdAt      = new Date().toISOString();
    json.scope                   = JSON.parse(JSON.stringify(state.scope));
    json.parameters              = { ...state.paramsRun };
    for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
      if (state.parsed[s]) json.data[s === 'fleetMaster' ? 'fleetMaster'
                                  : s === 'inventoryMaster' ? 'inventoryMaster'
                                  : s] = state.parsed[s].canonical;
    }
    json.validation = state.dq ? {
      passed: state.dq.passed,
      issues: state.dq.issues.concat(state.dq.warnings).map(i => ({
        severity: i.sev, code: i.code, message: i.msg
      }))
    } : { passed:false, issues:[{ severity:'crit', code:'no_dq', message:'DQ gate not run' }] };
    return json;
  }

  function renderJsonPreview(){
    const json = buildJson();
    const host = $('#jsonPreview');
    // Strip the heavy data.* arrays for preview, replace with summaries
    const summary = JSON.parse(JSON.stringify(json));
    for (const key of Object.keys(summary.data)) {
      const arr = summary.data[key] || [];
      summary.data[key] = arr.length > 0 ? `[ … ${arr.length} rows … ]` : `[ ]`;
    }
    host.textContent = JSON.stringify(summary, null, 2);

    const sizeBytes = new Blob([JSON.stringify(json)]).size;
    $('#jsonSize').textContent = humanBytes(sizeBytes);
  }

  function setupReviewActions(){
    $('#assessmentName').addEventListener('input', () => { state.name = $('#assessmentName').value; renderJsonPreview(); });
    $('#createdBy').addEventListener('input', renderJsonPreview);
    $('#runDate').addEventListener('change', () => { state.runDate = $('#runDate').value; if (state.parsed.mb51) runDqGate(); });
    $('#runDate').value = state.runDate;

    $('#btnSaveLocal').addEventListener('click', async () => {
      const json = buildJson();
      const name = state.name || `intake-${new Date().toISOString().slice(0,10)}`;
      const result = await AppStorage.set('intake.' + name, json);
      // also update an "intakes" index list
      const idx = (await AppStorage.get('intakes.index')) || [];
      const idxClean = idx.filter(e => e.name !== name);
      idxClean.unshift({ name, createdAt: json.metadata.createdAt, mode: json.scope.mode });
      await AppStorage.set('intakes.index', idxClean.slice(0, 50));
      // also save as "current" for analysis engine handoff
      await AppStorage.set('intake.current', json);
      toast(`Saved to ${result.store === 'idb' ? 'IndexedDB' : 'localStorage'} (${humanBytes(result.size)})`, 'ok');
    });

    $('#btnDownload').addEventListener('click', () => {
      const json = buildJson();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const name = (state.name || `intake-${new Date().toISOString().slice(0,10)}`).replace(/[^A-Za-z0-9_-]+/g, '_');
      a.href = url; a.download = `${name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

    $('#btnUpload').addEventListener('click', () => $('#uploadJsonInput').click());
    $('#uploadJsonInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const v = CanonicalSchema.validateShape(json);
        if (!v.ok) { toast('Invalid JSON: ' + v.errors.join('; '), 'crit'); return; }
        // Repopulate state from the JSON
        state.scope = json.scope;
        state.paramsRun = { ...json.parameters };
        state.name = json.metadata.assessmentName || '';
        // Stuff data into parsed slots so downstream UI works
        for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
          if (json.data[s] && json.data[s].length) {
            state.parsed[s] = {
              canonical: json.data[s],
              headers:   Object.keys(json.data[s][0] || {}),
              fieldMap:  Object.fromEntries(Object.keys(json.data[s][0] || {}).map(k => [k,k])),
              rowCount:  json.data[s].length,
              unmatched: [],
              missingFields: []
            };
            const drop = document.querySelector(`.drop[data-source="${s}"]`);
            if (drop) {
              drop.classList.add('loaded');
              drop.querySelector('.file').textContent = `${json.data[s].length.toLocaleString()} rows · loaded from JSON`;
            }
          }
        }
        $('#assessmentName').value = state.name;
        $('#createdBy').value = json.metadata.createdBy || '';
        runDqGate();
        renderParams(); renderScopePreview(); renderJsonPreview();
        toast('JSON loaded', 'ok');
      } catch (e) {
        toast('Failed to load JSON: ' + e.message, 'crit');
      }
    });

    $('#btnOpenAnalysis').addEventListener('click', async () => {
      // Save current and navigate to analysis page (built next)
      const json = buildJson();
      await AppStorage.set('intake.current', json);
      window.location.href = '../analysis/analysis.html';
    });
  }

  /* ═════════════════════════════════════════════════════════════════════════
     Helpers
  ═════════════════════════════════════════════════════════════════════════ */

  function uniq(arr){ return [...new Set(arr)]; }
  function monthsBetween(a, b){
    if (!a || !b) return 0;
    const da = new Date(a), db = new Date(b);
    return (db.getFullYear() - da.getFullYear()) * 12 + (db.getMonth() - da.getMonth());
  }
  function humanBytes(n){
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/1024/1024).toFixed(1) + ' MB';
  }
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

  document.addEventListener('DOMContentLoaded', async () => {
    await loadDefaults();
    setupDropZones();
    setupScopeTabs();
    setupManualPaste();
    setupClassifInputs();
    setupParamButtons();
    setupReviewActions();
    renderJsonPreview();

    // Keyboard hint: Esc clears toasts
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.toast').forEach(t => t.remove()); });
  });

})();
