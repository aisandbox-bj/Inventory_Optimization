/* ═══════════════════════════════════════════════════════════════════════════
   Intake engine — wires the six-section workflow together.
   Depends on (loaded earlier in HTML): SheetJS (XLSX), PapaParse (Papa),
   AppParsers, AppStorage, AppConfig, CanonicalSchema.
═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ─── Sources required and conditional ──────────────────────────────────── */
  const REQUIRED_SOURCES   = ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'];
  const CONDITIONAL_SOURCES= ['userList', 'materialVendor', 'leadTimes'];

  const SOURCE_LABEL = {
    mb51:            'MB51 — Material Movements',
    iw39:            'IW39 — Work Orders',
    fleetMaster:     'Fleet Master',
    inventoryMaster: 'Inventory Master',
    userList:        'User material list',
    materialVendor:  'Material — Vendor mapping',
    leadTimes:       'Lead Times'
  };

  /* ─── Per-field notes — what each canonical field is used for ───────────── */
  const FIELD_NOTES = {
    mb51: {
      postingDate:  'When the movement happened. <b>Drives P1/P2 windowing</b> and the 12-month history check.',
      order:        'Work order number. <b>Joined to IW39</b> for fleet scope mode (filters MB51 to fleet WOs only).',
      material:     'SAP material number. <b>The unit of analysis</b> — every recommendation is per-material.',
      description:  'Material description. Display only — appears alongside the material number in dashboards and Excel.',
      quantity:     'Movement quantity. <b>Combined with movement type</b> to compute net consumption (issues − returns).',
      movementType: '261 / 262 / 201 / 202. <b>261+201 = goods issue, 262+202 = return.</b> Determines the sign of quantity.'
    },
    iw39: {
      order:          'Work order key. <b>Joins to MB51</b> via Order — links each transaction to a piece of equipment.',
      sortField:      'Equipment unit (e.g. TD402). <b>Bridge field</b> — joined to Fleet Master to roll WOs up to model.',
      basicStartDate: 'When the WO started. <b>Future-dated orders are filtered out</b> so we count realised demand only.',
      description:    "WO description (e.g. 'Undercarriage rebuild'). <b>Annotated on charts</b> to explain consumption spikes."
    },
    fleetMaster: {
      model:               'Fleet model code (e.g. 775G, D9T). <b>Defines the buckets</b> in fleet scope mode.',
      sortField:           'Equipment unit. <b>Bridge field</b>: model → sort fields → IW39 orders → MB51 transactions.',
      unitType:            "e.g. 'CAT Dump Truck'. Display only — used in the fleet asset tree.",
      manufacturer:        'OEM name. Display only — useful when multiple OEMs are in scope.',
      functLocDescription: 'SAP functional location label. Display only — operational context per unit.'
    },
    inventoryMaster: {
      material:      'Material number — <b>the join key</b> against MB51 materials.',
      totQtyOh:      'Stock on hand. <b>Used for runway calculation</b> (months of cover at current rate).',
      mrpInd:        'MRP type (PD, V1, …). <b>Drives the traffic-light rules</b> in the analysis engine.',
      mrpMin:        'Current MRP minimum. <b>Compared to recommended Min</b> to set the action (raise / lower / leave).',
      mrpMax:        'Current MRP maximum. <b>Compared to recommended Max</b> the same way.',
      inventoryType: 'Inventory category (NORM, INSP, …). <b>Filter dimension</b> in byClassification scope mode.',
      primaryVendor: 'Vendor for this material. Optional fallback if no separate Material-Vendor file is uploaded.'
    },
    materialVendor: {
      material:            'Join key to MB51 / Inventory Master.',
      vendor:              'Vendor number. <b>Defines the buckets</b> in byVendor scope mode.',
      vendorName:          'Display label for the vendor.',
      sourceListIndicator: 'Primary / approved / single-source flag. Display in v1; reserved for sole-source-risk flags later.'
    },
    leadTimes: {
      material:     'Join key to the rest of the dataset.',
      leadTimeDays: 'Time from re-order trigger to goods receipt. <b>Replaces minMonths</b> in the leadTimeBased Min/Max formula.',
      safetyStock:  'Buffer added on top of lead-time consumption to size the recommended Min.',
      source:       "How this lead-time was derived (e.g. 'SAP MARC', 'supplier-confirmed', 'measured')."
    }
  };

  function sourceTagline(source){
    const map = {
      mb51:            'consumption history',
      iw39:            'fleet WO link',
      fleetMaster:     'equipment → model rollup',
      inventoryMaster: 'stock + MRP settings',
      materialVendor:  'material → vendor mapping',
      leadTimes:       'per-material lead time + safety stock'
    };
    return map[source] || '';
  }

  /* ─── Mutable module state ──────────────────────────────────────────────── */
  const state = {
    files:    {},                                    // source → File
    parsed:   {},                                    // source → parseAndMap result
    dq:       null,                                  // { passed, issues, warnings, tiles }
    scope:    CanonicalSchema.emptyScope('fleet'),
    paramsSaved: { ...CanonicalSchema.FACTORY_DEFAULTS },
    paramsRun:   { ...CanonicalSchema.FACTORY_DEFAULTS },
    aliases:  {},
    runDate:  (typeof AppLocale !== 'undefined' ? AppLocale.localDateISO() : new Date().toISOString().slice(0, 10)),
    name:     '',
    assessmentType: null,                            // 'unitFloc' | 'userList' | 'paramSearch'
    psFilters: [],                                   // Parameter-Search filter cards
    alignmentAck: null                               // APP-E6 · { acknowledgedAt, dimensions } once operator confirms scope alignment
  };

  /* ─── Parameter-Search dimension catalogue ──────────────────────────────── */
  /* Each dimension declares its data source, value type, and pickers. */
  const PS_DIMENSIONS = [
    { key:'mb51Movement',   label:'MB51 movement',   type:'number', from:'mb51_net',  unit:'units' },
    { key:'materialGroup',  label:'Material group',  type:'string', from:'master',    field:'materialGroup' },
    { key:'manufacturer',   label:'Manufacturer',    type:'string', from:'master',    field:'manufacturer' },
    { key:'totValueOh',     label:'Value on hand',   type:'number', from:'master',    field:'totValueOh',  unit:'currency' },
    { key:'totQtyOh',       label:'Qty on hand',     type:'number', from:'master',    field:'totQtyOh',    unit:'units' },
    { key:'inventoryType',  label:'Inventory type',  type:'string', from:'master',    field:'inventoryType' },
    { key:'mrpInd',         label:'MRP indicator',   type:'string', from:'master',    field:'mrpInd' }
  ];

  /* ─── DOM refs ──────────────────────────────────────────────────────────── */
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 0 — Assessment type
  ═════════════════════════════════════════════════════════════════════════ */

  function setupAssessmentType(){
    $$('.atype-card').forEach(card => {
      card.addEventListener('click', (e) => {
        // Avoid double-fire from inner radio click
        if (e.target.tagName === 'INPUT') return;
        const radio = card.querySelector('input[type=radio]');
        radio.checked = true;
        applyAssessmentType(card.dataset.atype);
      });
      const radio = card.querySelector('input[type=radio]');
      radio.addEventListener('change', () => applyAssessmentType(card.dataset.atype));
    });
  }

  function applyAssessmentType(type){
    state.assessmentType = type;
    $$('.atype-card').forEach(c => c.classList.toggle('selected', c.dataset.atype === type));

    // Grey out drop zones not OFFERED by this type. A drop is "offered" if its
    // data-needed-by attribute includes the current type. This is a superset
    // of ASSESSMENT_TYPE_REQUIRES — e.g. userList file is offered (optional)
    // for the userList type even though it's not required for DQ pass.
    $$('.drop[data-source]').forEach(drop => {
      const source = drop.dataset.source;
      // The conditional zones (materialVendor, leadTimes) are managed by scope/method toggles —
      // don't override their hidden state from here.
      if (source === 'materialVendor' || source === 'leadTimes') return;
      const neededBy = (drop.getAttribute('data-needed-by') || '').split(',').map(s => s.trim());
      const offered = neededBy.includes(type);
      drop.classList.toggle('atype-disabled', !offered);
      const inp = drop.querySelector('input[type=file]');
      if (inp) inp.disabled = !offered;
    });

    // Scope tab visibility — restrict to scope modes valid for this assessment type
    const allowedScopes = new Set(CanonicalSchema.ASSESSMENT_TYPE_SCOPE[type] || []);
    $$('.scope-tabs .tab').forEach(tab => {
      const valid = allowedScopes.has(tab.dataset.mode);
      tab.style.display = valid ? '' : 'none';
    });
    // Auto-pick the first valid scope mode for this type
    const firstValid = CanonicalSchema.ASSESSMENT_TYPE_SCOPE[type][0];
    if (firstValid && state.scope.mode !== firstValid) {
      switchScopeMode(firstValid);
    }

    // Show/hide Parameter-Search panel
    const psStep = $('#stepParamSearch');
    if (psStep) psStep.classList.toggle('hidden', type !== 'paramSearch');

    // Step 4 (scope) collapsed for paramSearch — its scope is the filter panel itself
    const scopeStep = $('#step4');
    if (scopeStep) scopeStep.classList.toggle('hidden', type === 'paramSearch');

    $('#step0Status').textContent = `${labelForType(type)} selected`;
    $('#step0Status').className = 'step-status done';
    $('#step1Status').textContent = `awaiting ${[...needed].join(' · ')}`;

    if (type === 'paramSearch') renderParamSearch();
    renderJsonPreview();
  }

  function labelForType(t){
    return { unitFloc:'UNIT/FLOC', userList:'User list', paramSearch:'Parameter search' }[t] || t;
  }

  /* Helper to swap the active scope tab + pane programmatically */
  function switchScopeMode(mode){
    state.scope.mode = mode;
    $$('.scope-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    $$('.scope-pane').forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
    const mv = document.querySelector('.drop[data-source="materialVendor"]');
    if (mv) mv.parentElement.classList.toggle('hidden', mode !== 'byVendor');
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 1 — Upload
  ═════════════════════════════════════════════════════════════════════════ */

  function setupDropZones(){
    REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES).forEach(source => {
      const drop = document.querySelector(`.drop[data-source="${source}"]`);
      if (!drop) return;
      const input = drop.querySelector('input[type="file"]');
      drop.addEventListener('dragover',  (e) => {
        if (drop.classList.contains('atype-disabled')) return;
        e.preventDefault(); drop.classList.add('dragover');
      });
      drop.addEventListener('dragleave', ()  => drop.classList.remove('dragover'));
      drop.addEventListener('drop',      (e) => {
        if (drop.classList.contains('atype-disabled')) { e.preventDefault(); return; }
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
      // Re-render every drop so cross-file reconciliation chips refresh too
      renderAllDropStats();
      onParseUpdated();
    } catch (e) {
      console.error(e);
      drop.classList.remove('loaded');
      drop.querySelector('.file').textContent = `${file.name} · ERROR: ${e.message || e}`;
      toast('Parse failed: ' + (e.message || e), 'crit');
    }
  }

  /* ─── Per-drop key-parameter stats ──────────────────────────────────────── */
  function computeSourceStats(source, rows){
    if (!rows || !rows.length) return [];
    const uniqOf = (key) => new Set(rows.map(r => String(r[key] || '').trim()).filter(Boolean)).size;
    switch (source) {
      case 'mb51':
        return [
          { lab:'Transactions', v:rows.length.toLocaleString() },
          { lab:'Materials',    v:uniqOf('material').toLocaleString() },
          { lab:'Orders',       v:uniqOf('order').toLocaleString() }
        ];
      case 'iw39':
        return [
          { lab:'Work orders', v:rows.length.toLocaleString() },
          { lab:'Units',       v:uniqOf('sortField').toLocaleString() }
        ];
      case 'fleetMaster':
        return [
          { lab:'Units',  v:rows.length.toLocaleString() },
          { lab:'Models', v:uniqOf('model').toLocaleString() }
        ];
      case 'inventoryMaster':
        return [
          { lab:'Materials',     v:uniqOf('material').toLocaleString() },
          { lab:'MRP types',     v:uniqOf('mrpInd').toLocaleString() },
          { lab:'Inv. types',    v:uniqOf('inventoryType').toLocaleString() }
        ];
      case 'userList':
        return [{ lab:'Materials', v:uniqOf('material').toLocaleString() }];
      case 'materialVendor':
        return [
          { lab:'Mat→vendor rows', v:rows.length.toLocaleString() },
          { lab:'Materials',       v:uniqOf('material').toLocaleString() },
          { lab:'Vendors',         v:uniqOf('vendor').toLocaleString() }
        ];
      case 'leadTimes':
        return [{ lab:'Materials', v:uniqOf('material').toLocaleString() }];
      default:
        return [];
    }
  }

  function renderDropStats(source){
    const drop = document.querySelector(`.drop[data-source="${source}"]`);
    if (!drop) return;
    let wrap = drop.querySelector('.drop-stats');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'drop-stats';
      drop.appendChild(wrap);
    }
    const parsed = state.parsed[source];
    if (!parsed) { wrap.innerHTML = ''; return; }
    const stats = computeSourceStats(source, parsed.canonical)
                    .concat(computeCrossFileChips(source));
    wrap.innerHTML = stats.map(s => `
      <span class="drop-stat${s.cls ? ' ' + s.cls : ''}">
        <span class="lab">${escapeHtml(s.lab)}</span>
        <span class="v">${s.v}</span>
      </span>`).join('');
  }

  function renderAllDropStats(){
    Object.keys(state.parsed).forEach(s => renderDropStats(s));
  }

  /* ─── Cross-file reconciliation chips ─── shows up only if the relevant
     second file is also parsed; flags amber/red when below thresholds. */
  function computeCrossFileChips(source){
    const out = [];
    const p = state.parsed;

    const setOfKey = (rows, key) => new Set((rows || []).map(r => String(r[key] || '').trim()).filter(Boolean));

    if (source === 'mb51') {
      const mb51Mats = setOfKey(p.mb51?.canonical, 'material');
      if (p.inventoryMaster) {
        const mMats = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...mb51Mats].filter(m => mMats.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, mb51Mats.size));
      }
      if (p.iw39) {
        const mb51Ords = setOfKey(p.mb51.canonical, 'order');
        const iwOrds   = setOfKey(p.iw39.canonical, 'order');
        const overlap  = [...mb51Ords].filter(o => iwOrds.has(o)).length;
        out.push(reconChip('orders in IW39', overlap, mb51Ords.size));
      }
    }
    if (source === 'iw39') {
      if (p.mb51) {
        const iwOrds  = setOfKey(p.iw39.canonical, 'order');
        const mbOrds  = setOfKey(p.mb51.canonical, 'order');
        const overlap = [...iwOrds].filter(o => mbOrds.has(o)).length;
        out.push(reconChip('orders in MB51', overlap, iwOrds.size));
      }
      if (p.fleetMaster) {
        const iwSf  = setOfKey(p.iw39.canonical, 'sortField');
        const flSf  = setOfKey(p.fleetMaster.canonical, 'sortField');
        const overlap = [...iwSf].filter(s => flSf.has(s)).length;
        out.push(reconChip('units in Fleet', overlap, iwSf.size));
      }
    }
    if (source === 'fleetMaster') {
      if (p.iw39) {
        const flSf  = setOfKey(p.fleetMaster.canonical, 'sortField');
        const iwSf  = setOfKey(p.iw39.canonical, 'sortField');
        const overlap = [...flSf].filter(s => iwSf.has(s)).length;
        out.push(reconChip('units with WOs', overlap, flSf.size));
      }
    }
    if (source === 'inventoryMaster') {
      if (p.mb51) {
        const mMats = setOfKey(p.inventoryMaster.canonical, 'material');
        const mb51M = setOfKey(p.mb51.canonical, 'material');
        const overlap = [...mb51M].filter(m => mMats.has(m)).length;
        out.push(reconChip('MB51 mats covered', overlap, mb51M.size));
      }
    }
    if (source === 'userList') {
      if (p.mb51) {
        const ul = setOfKey(p.userList.canonical, 'material');
        const mb = setOfKey(p.mb51.canonical, 'material');
        const overlap = [...ul].filter(m => mb.has(m)).length;
        out.push(reconChip('in MB51', overlap, ul.size));
      }
      if (p.inventoryMaster) {
        const ul = setOfKey(p.userList.canonical, 'material');
        const im = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...ul].filter(m => im.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, ul.size));
      }
    }
    if (source === 'materialVendor') {
      if (p.inventoryMaster) {
        const mv = setOfKey(p.materialVendor.canonical, 'material');
        const im = setOfKey(p.inventoryMaster.canonical, 'material');
        const overlap = [...mv].filter(m => im.has(m)).length;
        out.push(reconChip('in Inv Master', overlap, mv.size));
      }
    }
    return out;
  }

  function reconChip(label, overlap, total){
    if (!total) return { lab: label, v: '—' };
    const pct = overlap / total * 100;
    const cls = pct < 50 ? 'crit' : (pct < 90 ? 'warn' : '');
    return {
      lab: label,
      v:   `${overlap.toLocaleString()} / ${total.toLocaleString()} (${pct.toFixed(0)}%)`,
      cls
    };
  }

  function onParseUpdated(){
    renderSchema();
    const required = currentRequiredSources();
    if (required.length && required.every(s => state.parsed[s])) {
      runDqGate();
    }
    // Auto-populate manual list textarea when user-list type + file uploaded
    if (state.assessmentType === 'userList' && state.parsed.userList) {
      const mats = uniq(state.parsed.userList.canonical
        .map(r => String(r.material || '').trim())
        .filter(Boolean));
      state.scope.manual.materials = mats;
      const ta = $('#manualPaste');
      if (ta) ta.value = mats.join('\n');
      renderScopePreview();
    }
    if (state.assessmentType === 'paramSearch') renderParamSearch();
    renderJsonPreview();
  }

  function currentRequiredSources(){
    if (!state.assessmentType) return [];
    return CanonicalSchema.ASSESSMENT_TYPE_REQUIRES[state.assessmentType] || [];
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
      const fields  = Object.keys(AppParsers.ALIASES[source] || {});
      const isReq   = REQUIRED_SOURCES.includes(source);
      let groupMatched = 0;

      const group = document.createElement('div');
      group.className = 'schema-group ' + (isReq ? 'required' : 'optional');

      const labelLeft = SOURCE_LABEL[source].split('—')[0].trim();
      const sheetTxt  = parsed.sheet ? `sheet "${parsed.sheet}" · ` : '';
      const head = document.createElement('div');
      head.className = 'schema-group-head';
      head.innerHTML = `
        <div class="name">${escapeHtml(labelLeft)}</div>
        <div class="desc">${escapeHtml(sourceTagline(source))} · ${sheetTxt}${parsed.rowCount.toLocaleString()} rows</div>
        <div class="count" data-count></div>
      `;
      group.appendChild(head);

      for (const field of fields) {
        const header  = parsed.fieldMap[field];
        const matched = !!header;
        if (matched) { totalMatched++; groupMatched++; } else { totalMissing++; }

        const row = document.createElement('div');
        row.className = 'schema-row ' + (matched ? 'matched' : 'missing');

        const opts = ['<option value="">— choose header —</option>']
          .concat(parsed.headers.map(h => `<option value="${escapeAttr(h)}" ${h === header ? 'selected' : ''}>${escapeHtml(h)}</option>`))
          .join('');

        const note = (FIELD_NOTES[source] && FIELD_NOTES[source][field]) || '—';

        row.innerHTML = `
          <div class="field">${escapeHtml(field)}</div>
          <div class="notes">${note}</div>
          <div class="header">${matched ? '' : '<em>not matched · </em>'}<select data-source="${source}" data-field="${field}">${opts}</select></div>
          <div class="ok">${matched ? '✓' : '!'}</div>
        `;
        group.appendChild(row);
      }

      const countEl = head.querySelector('[data-count]');
      countEl.textContent = `${groupMatched} / ${fields.length} matched`;
      countEl.classList.add(groupMatched === fields.length ? 'ok' : 'warn');

      host.appendChild(group);
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
          renderAllDropStats();                    // refresh per-drop counts + cross-file recon
          populateScopeOptions();
          // If user re-mapped the userList file, re-derive scope.manual.materials
          if (state.assessmentType === 'userList' && source === 'userList' && state.parsed.userList) {
            const mats = uniq(state.parsed.userList.canonical
              .map(r => String(r.material || '').trim())
              .filter(Boolean));
            state.scope.manual.materials = mats;
            const ta = $('#manualPaste');
            if (ta) ta.value = mats.join('\n');
            renderScopePreview();
          }
          renderJsonPreview();
          renderScopeSummary();
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
     STEP 4b — Parameter Search filter panel
     PBI-style: drag a dimension from the bar onto the canvas. Each card
     supports Simple (chips / range) and Advanced (custom min-max, regex,
     comma-separated list) modes. Filters AND together.
  ═════════════════════════════════════════════════════════════════════════ */

  function setupParamSearch(){
    const bar = $('#psDimBar');
    if (!bar) return;
    bar.innerHTML = '';
    PS_DIMENSIONS.forEach(dim => {
      const pill = document.createElement('div');
      pill.className = 'ps-dim';
      pill.draggable = true;
      pill.dataset.dim = dim.key;
      pill.textContent = dim.label;
      pill.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', dim.key);
        e.dataTransfer.effectAllowed = 'copy';
      });
      pill.addEventListener('click', () => addPsFilter(dim.key));   // click = quick-add
      bar.appendChild(pill);
    });
    const canvas = $('#psCanvas');
    canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      canvas.classList.add('drag-over');
      e.dataTransfer.dropEffect = 'copy';
    });
    canvas.addEventListener('dragleave', () => canvas.classList.remove('drag-over'));
    canvas.addEventListener('drop', (e) => {
      e.preventDefault();
      canvas.classList.remove('drag-over');
      const key = e.dataTransfer.getData('text/plain');
      if (key) addPsFilter(key);
    });
  }

  function addPsFilter(dimKey){
    if (state.psFilters.find(f => f.dim === dimKey)) return;   // already added
    const dim = PS_DIMENSIONS.find(d => d.key === dimKey);
    if (!dim) return;
    const filter = {
      dim:    dimKey,
      mode:   'simple',
      values: [],
      min:    null,
      max:    null,
      regex:  ''
    };
    state.psFilters.push(filter);
    renderParamSearch();
  }

  function removePsFilter(dimKey){
    state.psFilters = state.psFilters.filter(f => f.dim !== dimKey);
    renderParamSearch();
  }

  function renderParamSearch(){
    const canvas = $('#psCanvas');
    const bar    = $('#psDimBar');
    if (!canvas) return;

    // Mark in-use dimensions in the bar
    if (bar) {
      $$('#psDimBar .ps-dim').forEach(p => p.classList.toggle('in-use', !!state.psFilters.find(f => f.dim === p.dataset.dim)));
    }

    canvas.innerHTML = '';
    if (state.psFilters.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ps-canvas-empty';
      empty.textContent = 'Drag a dimension here to start filtering.';
      canvas.appendChild(empty);
      $('#paramSearchStatus').textContent = 'no filters set';
      updatePsPreview();
      return;
    }

    state.psFilters.forEach(f => canvas.appendChild(renderPsFilterCard(f)));
    $('#paramSearchStatus').textContent = `${state.psFilters.length} filter${state.psFilters.length === 1 ? '' : 's'} active`;
    updatePsPreview();
  }

  function renderPsFilterCard(filter){
    const dim = PS_DIMENSIONS.find(d => d.key === filter.dim);
    const card = document.createElement('div');
    card.className = 'ps-filter';
    card.dataset.dim = filter.dim;

    card.innerHTML = `
      <div class="ps-filter-head">
        <span class="ps-filter-name">${escapeHtml(dim.label)}</span>
        <div class="ps-filter-mode">
          <button data-mode="simple" class="${filter.mode === 'simple' ? 'active' : ''}">Simple</button>
          <button data-mode="advanced" class="${filter.mode === 'advanced' ? 'active' : ''}">Advanced</button>
        </div>
        <span class="ps-filter-count" data-count></span>
        <button class="ps-filter-remove">✕ Remove</button>
      </div>
      <div class="ps-filter-body"></div>
    `;
    const body = card.querySelector('.ps-filter-body');

    if (dim.type === 'string') {
      if (filter.mode === 'simple') {
        const values = uniqueValuesFor(dim).sort();
        const chips = document.createElement('div');
        chips.className = 'ps-chip-row';
        values.forEach(v => {
          const chip = document.createElement('span');
          chip.className = 'ps-chip' + (filter.values.includes(v) ? ' on' : '');
          chip.textContent = v || '(blank)';
          chip.addEventListener('click', () => {
            const idx = filter.values.indexOf(v);
            if (idx >= 0) filter.values.splice(idx, 1); else filter.values.push(v);
            renderParamSearch();
          });
          chips.appendChild(chip);
        });
        if (values.length === 0) {
          chips.innerHTML = '<span class="ps-chip-summary">no values available — Inventory Master may not include this field</span>';
        }
        body.appendChild(chips);
      } else {
        // Advanced: comma-separated values OR regex
        body.innerHTML = `
          <div class="row-input">
            <label>Values</label>
            <input type="text" data-pskey="values"
              placeholder="comma-separated, e.g. VOLVO, KOMATSU"
              value="${escapeAttr(filter.values.join(', '))}">
          </div>
          <div class="row-input">
            <label>Regex</label>
            <input type="text" data-pskey="regex"
              placeholder="optional — overrides values, e.g. ^CAT-"
              value="${escapeAttr(filter.regex)}">
          </div>
        `;
      }
    } else {
      // numeric — both Simple and Advanced share min/max; Advanced just lets user enter precise decimals
      const stepAttr = (dim.unit === 'currency') ? 'step="100"' : 'step="1"';
      body.innerHTML = `
        <div class="row-input">
          <label>min</label>
          <input type="number" data-pskey="min" ${stepAttr}
            placeholder="—" value="${filter.min == null ? '' : filter.min}">
        </div>
        <div class="row-input">
          <label>max</label>
          <input type="number" data-pskey="max" ${stepAttr}
            placeholder="—" value="${filter.max == null ? '' : filter.max}">
        </div>
        <div class="ps-chip-summary">${dim.unit === 'currency' ? 'Currency units as stored on inventory master (currency unaware).' : 'Net consumption (issues − returns) over the analysis window.'}</div>
      `;
    }

    // Mode toggle
    card.querySelectorAll('.ps-filter-mode button').forEach(b => {
      b.addEventListener('click', () => {
        filter.mode = b.dataset.mode;
        renderParamSearch();
      });
    });
    // Remove
    card.querySelector('.ps-filter-remove').addEventListener('click', () => removePsFilter(filter.dim));
    // Input wiring
    body.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.pskey;
        if (k === 'min' || k === 'max') {
          const n = parseFloat(inp.value);
          filter[k] = isNaN(n) ? null : n;
        } else if (k === 'values') {
          filter.values = inp.value.split(',').map(s => s.trim()).filter(Boolean);
        } else if (k === 'regex') {
          filter.regex = inp.value;
        }
        updatePsPreview();
      });
    });

    // Per-card match count
    setTimeout(() => {
      const match = countMatchingMaterials([filter]);
      const c = card.querySelector('[data-count]');
      if (c) c.textContent = `${match.size} match${match.size === 1 ? '' : 'es'}`;
    }, 0);

    return card;
  }

  function uniqueValuesFor(dim){
    if (dim.from === 'master') {
      const master = state.parsed.inventoryMaster?.canonical || [];
      return uniq(master.map(r => String(r[dim.field] || '').trim()).filter(Boolean));
    }
    return [];
  }

  /* ─── Apply filters → resolved material set ─────────────────────────────── */
  function countMatchingMaterials(filters){
    const master = state.parsed.inventoryMaster?.canonical || [];
    if (master.length === 0) return new Set();

    // Per-material net consumption (cached)
    const matNet = computeNetConsumption(state.parsed.mb51?.canonical || []);

    const matched = new Set();
    for (const r of master) {
      const mat = String(r.material || '').trim();
      if (!mat) continue;
      if (passesAllFilters(r, mat, matNet, filters)) matched.add(mat);
    }
    return matched;
  }

  function passesAllFilters(masterRow, mat, matNet, filters){
    for (const f of filters) {
      const dim = PS_DIMENSIONS.find(d => d.key === f.dim);
      if (!dim) continue;

      if (dim.from === 'mb51_net') {
        const net = matNet[mat] || 0;
        if (f.min != null && net < f.min) return false;
        if (f.max != null && net > f.max) return false;
        continue;
      }

      if (dim.type === 'string') {
        const v = String(masterRow[dim.field] || '').trim();
        if (f.mode === 'advanced' && f.regex) {
          let re;
          try { re = new RegExp(f.regex); } catch { return false; }
          if (!re.test(v)) return false;
        } else {
          if (f.values.length === 0) continue;            // no constraint set
          if (!f.values.includes(v)) return false;
        }
      } else {
        const n = parseFloat(masterRow[dim.field]);
        if (isNaN(n)) {
          // If filter is set, NaN doesn't satisfy
          if (f.min != null || f.max != null) return false;
          continue;
        }
        if (f.min != null && n < f.min) return false;
        if (f.max != null && n > f.max) return false;
      }
    }
    return true;
  }

  function updatePsPreview(){
    const matched = countMatchingMaterials(state.psFilters);
    const master  = state.parsed.inventoryMaster?.canonical || [];
    const matNet  = computeNetConsumption(state.parsed.mb51?.canonical || []);

    let netSum = 0, valSum = 0;
    for (const r of master) {
      const m = String(r.material || '').trim();
      if (!matched.has(m)) continue;
      netSum += matNet[m] || 0;
      const v = parseFloat(r.totValueOh);
      if (!isNaN(v)) valSum += v;
    }
    const fmt = (n) => Math.round(n).toLocaleString('en-CA');

    if ($('#psMatCount'))      $('#psMatCount').textContent      = matched.size.toLocaleString('en-CA');
    if ($('#psNetConsumption'))$('#psNetConsumption').textContent= fmt(netSum);
    if ($('#psOnHandValue'))   $('#psOnHandValue').textContent   = AppLocale.fmtCAD(valSum);

    // Update resolvedMaterials on scope object for JSON serialization
    state.scope.parameterSearch = {
      filters: JSON.parse(JSON.stringify(state.psFilters)),
      resolvedMaterials: [...matched]
    };
    renderJsonPreview();
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
      { key:'lumpyTopWoThreshold', label:'Lumpy top-WO',    type:'number', step:0.05 },
      { key:'invAdjSigmaThreshold',label:'Inv Adj σ threshold', type:'number', step:0.5 },
      { key:'wrSoftMonths',        label:'WR soft months',  type:'number', step:1 },
      { key:'wrHardMonths',        label:'WR hard months',  type:'number', step:1 },
      { key:'wrMrpTypes',          label:'WR MRP types',    type:'list',   placeholder:'PD, ZE' }
    ];

    const descs = CanonicalSchema.PARAMETER_DESCRIPTIONS || {};
    const host = $('#paramsGrid');
    host.innerHTML = '';
    for (const f of fields) {
      const cell = document.createElement('div');
      cell.className = 'param-cell' + (JSON.stringify(run[f.key]) !== JSON.stringify(saved[f.key]) ? ' dirty' : '');

      let input;
      if (f.type === 'select') {
        input = `<select data-pkey="${f.key}">${f.opts.map(o => `<option value="${o}" ${run[f.key]===o?'selected':''}>${o}</option>`).join('')}</select>`;
      } else if (f.type === 'date') {
        input = `<input type="date" data-pkey="${f.key}" value="${run[f.key] || ''}">`;
      } else if (f.type === 'list') {
        const v = Array.isArray(run[f.key]) ? run[f.key].join(', ') : '';
        input = `<input type="text" data-pkey="${f.key}" value="${escapeAttr(v)}" placeholder="${escapeAttr(f.placeholder || '')}">`;
      } else {
        input = `<input type="number" data-pkey="${f.key}" value="${run[f.key]}" step="${f.step || 1}">`;
      }
      const desc = descs[f.key] || '';
      const factoryDiff = JSON.stringify(factory[f.key]) !== JSON.stringify(saved[f.key]);
      const factoryDisplay = Array.isArray(factory[f.key]) ? factory[f.key].join(', ') : factory[f.key];
      const savedDisplay   = Array.isArray(saved[f.key])   ? saved[f.key].join(', ')   : saved[f.key];
      const factoryNote = factoryDiff ? `<div class="factory-note">factory: ${escapeHtml(String(factoryDisplay))} · saved: ${escapeHtml(String(savedDisplay))}</div>` : '';
      cell.innerHTML = `<label>${f.label}</label><div class="param-desc">${desc}</div>${input}${factoryNote}`;
      host.appendChild(cell);
    }
    $$('#paramsGrid [data-pkey]').forEach(el => {
      el.addEventListener('change', (e) => {
        const k = el.dataset.pkey;
        const f = fields.find(x => x.key === k);
        let v;
        if (el.type === 'number') v = parseFloat(el.value);
        else if (f && f.type === 'list') {
          v = String(el.value || '')
            .split(',')
            .map(s => s.trim().toUpperCase())
            .filter(Boolean);
        }
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
     STEP 6 — Final scope summary (what will actually be analyzed)
     Runs the pipeline's bucket builder against the current JSON and reports
     materials per bucket + total. Cross-file mismatch flags surfaced.
  ═════════════════════════════════════════════════════════════════════════ */

  function renderScopeSummary(){
    const host   = $('#scopeSummaryBody');
    const status = $('#scopeSummaryStatus');
    if (!host) return;

    const required = currentRequiredSources();
    if (!required.length || !required.every(s => state.parsed[s])) {
      const missing = required.filter(s => !state.parsed[s]);
      host.innerHTML = `<div class="scope-summary-empty">awaiting upload: ${missing.length ? missing.join(' · ') : 'all required files'}</div>`;
      status.textContent = 'awaiting data';
      status.className = 'step-status';
      return;
    }

    let json;
    try {
      json = buildJson();
    } catch (e) {
      host.innerHTML = `<div class="scope-summary-empty">error building scope: ${escapeHtml(e.message)}</div>`;
      status.textContent = 'error';
      status.className = 'step-status crit';
      return;
    }

    if (typeof AppPipeline === 'undefined') {
      host.innerHTML = '<div class="scope-summary-empty">pipeline module not loaded</div>';
      return;
    }

    let buckets = [];
    try {
      buckets = AppPipeline.buildBuckets(json);
    } catch (e) {
      console.error(e);
      host.innerHTML = `<div class="scope-summary-empty">error computing buckets: ${escapeHtml(e.message)}</div>`;
      status.textContent = 'error';
      status.className = 'step-status crit';
      return;
    }

    // Per-bucket: count materials that PASS the threshold filter
    // (i.e. would actually be analyzed by the pipeline)
    const threshold = json.parameters.threshold || 0;
    let totalQualifying = 0, totalRaw = 0;
    const bucketRows = buckets.map(b => {
      const raw = (b.materials instanceof Set) ? b.materials.size : (Array.isArray(b.materials) ? b.materials.length : 0);
      // Compute net consumption per material in this bucket → count above threshold
      const netByMat = AppPipeline.netConsumptionByMaterial(b.transactions, new Map());
      let qualifying = 0;
      for (const [, agg] of netByMat) {
        if (agg.net >= threshold) qualifying++;
      }
      totalRaw         += raw;
      totalQualifying  += qualifying;
      const rowCls = b.kind === 'multi' ? 'multi' : '';
      return `
        <tr class="${rowCls}">
          <td class="bname">${escapeHtml(b.name)}</td>
          <td class="bkind">${escapeHtml(b.kind)}</td>
          <td class="num">${raw.toLocaleString()}</td>
          <td class="num">${qualifying.toLocaleString()}</td>
          <td class="num">${b.transactions.length.toLocaleString()}</td>
        </tr>`;
    }).join('');

    // Mismatch advisories
    const mismatch = computeMismatch(json);
    const mismatchHtml = mismatch.length ? `
      <div class="scope-mismatch">
        <b>⚠ Cross-file consistency notes:</b>
        ${mismatch.map(m => `<div>· ${m}</div>`).join('')}
      </div>` : '';

    const scopeDescr = describeScope(json);

    host.innerHTML = `
      <div class="scope-summary-head">
        <div class="key">
          <span class="lab">Materials to be analyzed</span>
          <span class="v big">${totalQualifying.toLocaleString()}</span>
        </div>
        <div class="key">
          <span class="lab">Buckets</span>
          <span class="v">${buckets.length}</span>
        </div>
        <div class="key">
          <span class="lab">Pre-threshold materials</span>
          <span class="v">${totalRaw.toLocaleString()}</span>
        </div>
        <div class="sub">
          Scope: <b style="color:var(--text-pri)">${escapeHtml(scopeDescr)}</b><br>
          Threshold: <b style="color:var(--text-pri)">net consumption ≥ ${threshold}</b> over the analysis window.<br>
          Materials below threshold are excluded automatically.
        </div>
      </div>
      ${mismatchHtml}
      <table class="scope-summary-table">
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Kind</th>
            <th class="num">Materials (raw)</th>
            <th class="num">≥ threshold</th>
            <th class="num">Transactions</th>
          </tr>
        </thead>
        <tbody>
          ${bucketRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);font-family:var(--font-mono);padding:14px;">no buckets — check scope selections</td></tr>'}
          ${buckets.length > 1 ? `
            <tr class="totals">
              <td class="bname">TOTAL</td>
              <td class="bkind">—</td>
              <td class="num">${totalRaw.toLocaleString()}</td>
              <td class="num">${totalQualifying.toLocaleString()}</td>
              <td class="num">—</td>
            </tr>` : ''}
        </tbody>
      </table>
    `;

    if (totalQualifying === 0) {
      status.textContent = '0 materials qualify · review scope or threshold';
      status.className = 'step-status warn';
    } else {
      status.textContent = `${totalQualifying.toLocaleString()} material${totalQualifying === 1 ? '' : 's'} ready for analysis`;
      status.className = 'step-status done';
    }
  }

  /* ─── Describe the current scope in plain English ───────────────────────── */
  function describeScope(json){
    const m = json.scope.mode;
    if (m === 'fleet')              return `Fleet · ${(json.scope.fleet?.models || []).join(' / ') || '—'}`;
    if (m === 'manual') {
      const n = (json.scope.manual?.materials || []).length;
      return `Manual list · ${n} material${n === 1 ? '' : 's'}`;
    }
    if (m === 'byClassification') {
      const f = json.scope.byClassification || {};
      const bits = [];
      if (f.inventoryTypes?.length) bits.push(`type: ${f.inventoryTypes.join('/')}`);
      if (f.mrpClassifiers?.length) bits.push(`MRP: ${f.mrpClassifiers.join('/')}`);
      if (f.movementAmount?.min != null || f.movementAmount?.max != null)
        bits.push(`mvmt: ${f.movementAmount.min ?? '—'} … ${f.movementAmount.max ?? '—'}`);
      return `By classification · ${bits.join(' · ') || 'no filters'}`;
    }
    if (m === 'byVendor') {
      const n = (json.scope.byVendor?.vendors || []).length;
      return `By vendor · ${n} vendor${n === 1 ? '' : 's'}`;
    }
    if (m === 'parameterSearch') {
      const f = (json.scope.parameterSearch?.filters || []).length;
      return `Parameter search · ${f} filter${f === 1 ? '' : 's'}`;
    }
    return m;
  }

  /* ─── Cross-file mismatch advisories ────────────────────────────────────── */
  function computeMismatch(json){
    const out  = [];
    const mb51 = json.data.mb51 || [];
    const iw39 = json.data.iw39 || [];
    const fleet = json.data.fleetMaster || [];
    const master = json.data.inventoryMaster || [];

    const mb51Mats   = new Set(mb51.map(r => String(r.material || '').trim()).filter(Boolean));
    const masterMats = new Set(master.map(r => String(r.material || '').trim()).filter(Boolean));

    if (mb51Mats.size && masterMats.size) {
      const missing = [...mb51Mats].filter(m => !masterMats.has(m));
      if (missing.length) {
        const pct = (missing.length / mb51Mats.size * 100).toFixed(1);
        out.push(`<b>${missing.length.toLocaleString()}</b> of ${mb51Mats.size.toLocaleString()} MB51 materials (${pct}%) are NOT in Inventory Master — they'll be excluded from MRP-driven assessments.`);
      }
    }

    if (mb51.length && iw39.length && json.metadata.assessmentType === 'unitFloc') {
      const mb51Orders = new Set(mb51.map(r => String(r.order || '').trim()).filter(Boolean));
      const iw39Orders = new Set(iw39.map(r => String(r.order || '').trim()).filter(Boolean));
      const missing = [...mb51Orders].filter(o => !iw39Orders.has(o));
      if (missing.length && mb51Orders.size > 0) {
        const pct = (missing.length / mb51Orders.size * 100).toFixed(1);
        if (parseFloat(pct) > 5) {
          out.push(`<b>${missing.length.toLocaleString()}</b> of ${mb51Orders.size.toLocaleString()} MB51 orders (${pct}%) are NOT in IW39 — those transactions can't be attributed to a fleet unit.`);
        }
      }
    }

    if (iw39.length && fleet.length && json.metadata.assessmentType === 'unitFloc') {
      const iw39Sf  = new Set(iw39.map(r => String(r.sortField || '').trim()).filter(Boolean));
      const fleetSf = new Set(fleet.map(r => String(r.sortField || '').trim()).filter(Boolean));
      const missing = [...iw39Sf].filter(s => !fleetSf.has(s));
      if (missing.length && iw39Sf.size > 0) {
        const pct = (missing.length / iw39Sf.size * 100).toFixed(1);
        if (parseFloat(pct) > 5) {
          out.push(`<b>${missing.length.toLocaleString()}</b> of ${iw39Sf.size.toLocaleString()} IW39 sort-field units (${pct}%) are NOT in Fleet Master — those WOs won't roll up to a fleet model bucket.`);
        }
      }
    }

    return out;
  }

  /* ═════════════════════════════════════════════════════════════════════════
     STEP 7 — Review & Export
  ═════════════════════════════════════════════════════════════════════════ */

  function buildJson(){
    const json = CanonicalSchema.emptyJson();
    json.metadata.assessmentName = state.name || $('#assessmentName').value || '';
    json.metadata.createdBy      = $('#createdBy').value || '';
    json.metadata.createdAt      = AppLocale.localStampCompact();
    json.metadata.assessmentType = state.assessmentType;
    json.scope                   = JSON.parse(JSON.stringify(state.scope));
    // For userList type: scope.manual.materials is already maintained by
    // either the file-upload handler (onParseUpdated) OR the textarea paste
    // handler (setupManualPaste). Whichever was most recent is the source
    // of truth. We just lock scope.mode = 'manual'.
    if (state.assessmentType === 'userList') {
      json.scope.mode = 'manual';
      // If neither file nor paste populated, fall back to userList canonical
      if ((!json.scope.manual || !json.scope.manual.materials || !json.scope.manual.materials.length) && state.parsed.userList) {
        const mats = state.parsed.userList.canonical
          .map(r => String(r.material || '').trim())
          .filter(Boolean);
        json.scope.manual = { materials: uniq(mats) };
      }
    }
    json.parameters              = { ...state.paramsRun };
    for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
      if (state.parsed[s]) json.data[s] = state.parsed[s].canonical;
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

    // Scope summary updates with the JSON preview — same upstream triggers
    renderScopeSummary();
  }

  /* ─── Mandatory Assessment-Name validation (v2.1) ─────────────────────── */
  function requireAssessmentName(){
    const input = $('#assessmentName');
    const errEl = $('#assessmentNameError');
    const name = (state.name || '').trim();
    if (!name) {
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (errEl) errEl.style.display = '';
      toast('Assessment name is required — name it before saving / running analysis.', 'crit');
      return false;
    }
    if (input) input.removeAttribute('aria-invalid');
    if (errEl) errEl.style.display = 'none';
    return true;
  }

  function setupReviewActions(){
    $('#assessmentName').addEventListener('input', () => {
      state.name = $('#assessmentName').value;
      // Clear the error styling as soon as the user starts typing
      if (state.name.trim()) {
        const input = $('#assessmentName');
        const errEl = $('#assessmentNameError');
        if (input) input.removeAttribute('aria-invalid');
        if (errEl) errEl.style.display = 'none';
      }
      renderJsonPreview();
    });
    $('#createdBy').addEventListener('input', renderJsonPreview);
    $('#runDate').addEventListener('change', () => { state.runDate = $('#runDate').value; if (state.parsed.mb51) runDqGate(); });
    $('#runDate').value = state.runDate;

    $('#btnSaveLocal').addEventListener('click', async () => {
      if (!requireAssessmentName()) return;
      const json = buildJson();
      const name = state.name.trim();
      const result = await AppStorage.set('intake.' + name, json);
      // also update an "intakes" index list
      const idx = (await AppStorage.get('intakes.index')) || [];
      const idxClean = idx.filter(e => e.name !== name);
      idxClean.unshift({ name, createdAt: json.metadata.createdAt, mode: json.scope.mode });
      await AppStorage.set('intakes.index', idxClean.slice(0, 50));
      // also save as "current" for analysis engine handoff
      await AppStorage.set('intake.current', json);
      toast(`Saved as "${name}" to ${result.store === 'idb' ? 'IndexedDB' : 'localStorage'} (${humanBytes(result.size)})`, 'ok');
    });

    $('#btnDownload').addEventListener('click', () => {
      if (!requireAssessmentName()) return;
      const json = buildJson();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const name = state.name.trim().replace(/[^A-Za-z0-9_-]+/g, '_');
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
        // Render all drop-stats so cross-file recon chips populate
        renderAllDropStats();
        // Re-apply assessment type if it was set on the JSON
        if (json.metadata && json.metadata.assessmentType) {
          applyAssessmentType(json.metadata.assessmentType);
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
      if (!requireAssessmentName()) return;
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

  /* ═════════════════════════════════════════════════════════════════════════
     REUSE COMMON DATA FROM SAVED INTAKE (batch mode, v2.1)
     Lets the operator skip re-uploading MB51 / IW39 / Fleet / Inv Master
     when running multiple batches against the same SAP extracts.
  ═════════════════════════════════════════════════════════════════════════ */

  /* Tile-level panel — visible when saved intakes exist. Click opens modal. */
  async function setupReusePanel(){
    const panel    = $('#reusePanel');
    const btnOpen  = $('#reuseOpen');
    const summary  = $('#reuseSummary');
    if (!panel || !btnOpen) return;

    const idx = (await AppStorage.get('intakes.index')) || [];
    if (idx.length === 0) {
      panel.hidden = true;
      return;
    }
    panel.hidden  = false;
    btnOpen.disabled = false;
    if (summary) summary.textContent = `${idx.length} saved intake${idx.length === 1 ? '' : 's'} available`;

    btnOpen.addEventListener('click', () => openReuseModal(idx));

    // Modal close handlers (idempotent)
    const closeBtn = $('#reuseModalClose');
    if (closeBtn && !closeBtn._bound) {
      closeBtn.addEventListener('click', closeReuseModal);
      closeBtn._bound = true;
    }
    const backdrop = $('#reuseModal').querySelector('.mass-backdrop');
    if (backdrop && !backdrop._bound) {
      backdrop.addEventListener('click', closeReuseModal);
      backdrop._bound = true;
    }
  }

  function closeReuseModal(){
    const m = $('#reuseModal');
    if (!m) return;
    m.classList.add('hidden'); m.setAttribute('aria-hidden', 'true');
  }

  /* ─── Reuse modal — pick source + which datasets to hydrate ─────────────── */
  // Friendly labels per source key
  const REUSE_LABELS = {
    mb51:            { label:'MB51',               desc:'Material movements — the consumption transactional file' },
    iw39:            { label:'IW39',               desc:'Work orders — bridges MB51 to fleet equipment' },
    fleetMaster:     { label:'Fleet Master',       desc:'Equipment / unit master — fleet model definitions' },
    inventoryMaster: { label:'Inventory Master',   desc:'Stock + MRP settings + classification + value' },
    materialVendor:  { label:'Material → Vendor',  desc:'Vendor mapping — only used for by-vendor scope' },
    leadTimes:       { label:'Lead Times',         desc:'Per-material lead-time + safety stock (rare)' },
    userList:        { label:'User list',          desc:'Pre-loaded material list — usually you want to set a fresh one' }
  };
  // Datasets in the order we present them, separated into "heavy common" + "specifier"
  const REUSE_GROUPS = [
    { groupLabel: 'Common heavy files (typically reused across batches)',
      sources: ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'],
      defaultChecked: true },
    { groupLabel: 'Specifier / optional files (usually new per batch — leave unchecked)',
      sources: ['userList', 'materialVendor', 'leadTimes'],
      defaultChecked: false }
  ];

  async function openReuseModal(idx){
    const modal = $('#reuseModal');
    const body  = $('#reuseModalBody');
    const foot  = $('#reuseModalFoot');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    let selectedName = idx[0] ? idx[0].name : '';

    function render(){
      // Pull the current source intake to see what datasets it actually has
      let sourceJson = null;
      if (selectedName) sourceJson = window._reuseCache && window._reuseCache.name === selectedName ? window._reuseCache.json : null;
      // We'll fetch lazily on render and cache on the modal scope
      body.innerHTML = `
        <div class="reuse-step">
          <span class="step-lab">Step 1</span>
          <h4>Pick the source intake to copy data from</h4>
          <select id="reuseModalSelect" class="reuse-select">
            ${idx.map(e => `
              <option value="${escapeAttr(e.name)}" ${e.name === selectedName ? 'selected' : ''}>
                ${escapeHtml(e.name)} · ${escapeHtml(e.mode || '—')} · ${escapeHtml((e.createdAt || '').replace('T', ' ').slice(0, 16))}
              </option>`).join('')}
          </select>
        </div>

        <div class="reuse-step">
          <span class="step-lab">Step 2</span>
          <h4>Pick which datasets to hydrate</h4>
          <div id="reuseSourcesHost"></div>
        </div>

        <div class="reuse-notes">
          <b>What happens on load:</b>
          <ul>
            <li>Selected datasets are copied into the current intake state (no re-upload).</li>
            <li>Parameter defaults carry over as a starting point (you can override per-run).</li>
            <li><b>Assessment type is NOT inherited</b> — pick fresh in Step 0 below.</li>
            <li><b>Scope is reset</b> — that's the whole point of a new batch.</li>
            <li>Assessment name auto-suggests <code>{source} — batch HHMM</code>; rename freely.</li>
          </ul>
        </div>
      `;
      // Lazy-fetch the source JSON to count rows + filter available sources
      AppStorage.get('intake.' + selectedName).then(json => {
        window._reuseCache = { name: selectedName, json };
        renderSourcesList(json);
      });
      // Bind dropdown
      $('#reuseModalSelect').addEventListener('change', e => {
        selectedName = e.target.value;
        render();
      });
    }

    function renderSourcesList(json){
      const host = $('#reuseSourcesHost');
      if (!host || !json) return;
      const data = json.data || {};
      let html = '';
      for (const group of REUSE_GROUPS) {
        html += `<div style="margin-top:10px;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.6px;color:var(--text-muted);text-transform:uppercase;margin-bottom:6px;">${group.groupLabel}</div>`;
        html += '<div class="reuse-sources">';
        for (const src of group.sources) {
          const rows = (Array.isArray(data[src]) ? data[src].length : 0);
          const avail = rows > 0;
          const checked = avail && group.defaultChecked;
          html += `
            <label class="reuse-source-row ${avail ? '' : 'unavailable'}">
              <input type="checkbox" data-src="${src}" ${avail ? '' : 'disabled'} ${checked ? 'checked' : ''} />
              <span class="name">${REUSE_LABELS[src].label}</span>
              <span class="desc">${REUSE_LABELS[src].desc}</span>
              <span class="rows">${avail ? rows.toLocaleString('en-CA') + ' rows' : '— not in source —'}</span>
            </label>
          `;
        }
        html += '</div>';
      }
      host.innerHTML = html;
    }

    foot.innerHTML = `
      <button id="reuseCancel" class="ghost">Cancel</button>
      <span class="spacer"></span>
      <button id="reuseLoadDo" class="primary">↻ Load selected datasets</button>
    `;
    $('#reuseCancel').addEventListener('click', closeReuseModal);
    $('#reuseLoadDo').addEventListener('click', async () => {
      const cbs = body.querySelectorAll('input[type=checkbox][data-src]:checked');
      const sources = [...cbs].map(c => c.dataset.src);
      if (sources.length === 0) { toast('Pick at least one dataset to load.', 'warn'); return; }
      const json = (window._reuseCache && window._reuseCache.json) || await AppStorage.get('intake.' + selectedName);
      if (!json) { toast('Saved intake not found: ' + selectedName, 'crit'); return; }
      closeReuseModal();
      await hydrateFromSavedIntake(json, selectedName, sources);
    });

    render();
  }

  /**
   * Hydrate state.parsed.* + state.paramsRun from a saved canonical JSON,
   * limited to the explicitly-selected sources. Does NOT inherit the source's
   * assessment type or scope (operator picks fresh).
   */
  async function hydrateFromSavedIntake(json, sourceName, selectedSources){
    const sources = Array.isArray(selectedSources) ? selectedSources : REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES);
    const reusedSources = [];
    for (const s of sources) {
      const arr = json.data && json.data[s];
      if (Array.isArray(arr) && arr.length > 0) {
        state.parsed[s] = {
          canonical: arr,
          headers:   Object.keys(arr[0] || {}),
          fieldMap:  Object.fromEntries(Object.keys(arr[0] || {}).map(k => [k, k])),
          rowCount:  arr.length,
          unmatched: [],
          missingFields: []
        };
        reusedSources.push(s);
        const drop = document.querySelector(`.drop[data-source="${s}"]`);
        if (drop) {
          drop.classList.add('loaded');
          const fileEl = drop.querySelector('.file');
          if (fileEl) fileEl.textContent = `↻ reused from "${sourceName}" · ${arr.length.toLocaleString('en-CA')} rows`;
        }
      }
    }
    // Carry parameters as starting point
    if (json.parameters) {
      state.paramsRun = Object.assign({}, state.paramsSaved, json.parameters);
    }

    // Do NOT inherit assessmentType — operator picks fresh per the batch-mode design.
    // (Removed automatic applyAssessmentType call from prior behaviour.)

    // Auto-suggest name only if blank (don't overwrite a name the user typed)
    const nameInput = $('#assessmentName');
    if (nameInput && !nameInput.value) {
      const base = (json.metadata && json.metadata.assessmentName) || sourceName;
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      nameInput.value = `${base} — batch ${hhmm}`;
      state.name = nameInput.value;
      nameInput.removeAttribute('aria-invalid');
      const errEl = $('#assessmentNameError'); if (errEl) errEl.style.display = 'none';
    }

    renderAllDropStats();
    renderSchema();
    if (state.assessmentType) runDqGate();   // only if a type is selected
    renderParams();
    populateScopeOptions();
    renderScopePreview();
    renderJsonPreview();
    renderScopeSummary();

    const statusEl = $('#reuseStatus');
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.innerHTML = `✓ Reused <b>${reusedSources.length}</b> dataset${reusedSources.length === 1 ? '' : 's'} from <span class="src">${escapeHtml(sourceName)}</span>: <b>${reusedSources.join(' · ')}</b><br>Next: pick an <b>assessment type</b> in Step 0 below, then set scope + parameters and save under a new name.`;
    }
    toast(`Loaded ${reusedSources.length} dataset${reusedSources.length===1?'':'s'} from "${sourceName}" — pick assessment type next.`, 'ok');

    // Scroll to the assessment-type step so the operator sees the next action
    const step0 = document.getElementById('step0');
    if (step0) step0.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * Hydrate state.parsed.* + state.scope + state.paramsRun from a saved
   * canonical JSON. After this runs, the operator can skip Steps 1-2-3
   * and jump straight to Step 0 (pick new assessment type) + Step 4 (scope)
   * + Step 5 (parameters) + Step 7 (save as a new named intake).
   */
  async function hydrateFromSavedIntake(json, sourceName){
    const reusedSources = [];
    for (const s of REQUIRED_SOURCES.concat(CONDITIONAL_SOURCES)) {
      const arr = json.data && json.data[s];
      if (Array.isArray(arr) && arr.length > 0) {
        state.parsed[s] = {
          canonical: arr,
          headers:   Object.keys(arr[0] || {}),
          fieldMap:  Object.fromEntries(Object.keys(arr[0] || {}).map(k => [k, k])),
          rowCount:  arr.length,
          unmatched: [],
          missingFields: []
        };
        reusedSources.push(s);
        const drop = document.querySelector(`.drop[data-source="${s}"]`);
        if (drop) {
          drop.classList.add('loaded');
          const fileEl = drop.querySelector('.file');
          if (fileEl) fileEl.textContent = `↻ reused from "${sourceName}" · ${arr.length.toLocaleString()} rows`;
        }
      }
    }
    // Carry over parameters as starting point (operator can change per-run)
    if (json.parameters) {
      state.paramsRun = Object.assign({}, state.paramsSaved, json.parameters);
    }
    // Do NOT carry over the scope — that's exactly what we want to change.
    // We DO carry the assessmentType as a starting point (operator can change Step 0).
    if (json.metadata && json.metadata.assessmentType) {
      applyAssessmentType(json.metadata.assessmentType);
    }
    // Suggest a default new name (don't overwrite if user typed one)
    const nameInput = $('#assessmentName');
    if (nameInput && !nameInput.value) {
      const base = (json.metadata && json.metadata.assessmentName) || sourceName;
      const now = new Date();
      const hhmm = String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
      nameInput.value = `${base} — batch ${hhmm}`;
      state.name = nameInput.value;
    }

    // Re-render everything that depends on parsed data
    renderAllDropStats();
    renderSchema();
    runDqGate();
    renderParams();
    populateScopeOptions();
    renderScopePreview();
    renderJsonPreview();
    renderScopeSummary();

    const statusEl = $('#reuseStatus');
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.innerHTML = `✓ Reused <b>${reusedSources.length}</b> source${reusedSources.length === 1 ? '' : 's'} from <span class="src">${escapeHtml(sourceName)}</span> · <b>${reusedSources.join(' · ')}</b><br>Now pick a new <b>assessment type + scope</b> below, then save as a new named intake.`;
    }
    toast(`Loaded ${reusedSources.length} source${reusedSources.length===1?'':'s'} from ${sourceName} — set new scope + save as new intake.`, 'ok');

    // Scroll the metadata header into view so the user sees the rename prompt
    $('#assessmentName').focus();
    $('#assessmentName').select();
  }

  /* ─── APP-E6 · Alignment acknowledgement gate ───────────────────────────
     Per-assessment gate. On page load, if state.alignmentAck is null, dim
     Step 0 / Step 1 / Reuse panel + metadata header via body.intake-gated
     and show the modal. Only the "I confirm…" button clears it. Backdrop +
     ✕ are intentionally non-acknowledging — the gate is binary.            */
  function setupAlignmentGate(){
    const modal = $('#alignModal');
    const btn   = $('#alignConfirm');
    if (!modal || !btn) return;

    if (state.alignmentAck) return;  // already acknowledged for this assessment

    document.body.classList.add('intake-gated');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    btn.addEventListener('click', () => {
      const nowIso = (typeof AppLocale !== 'undefined' && AppLocale.localDateTimeISO)
        ? AppLocale.localDateTimeISO()
        : new Date().toISOString();
      state.alignmentAck = {
        acknowledgedAt: nowIso,
        dimensions: ['plant', 'dateRange', 'materials', 'fleet']
      };
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('intake-gated');
      // Focus first interactive control after gate clears
      const nameInput = $('#assessmentName');
      if (nameInput) nameInput.focus();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await loadDefaults();
    setupAlignmentGate();   // APP-E6 · fires before anything else interactive
    setupAssessmentType();
    setupDropZones();
    setupScopeTabs();
    setupManualPaste();
    setupClassifInputs();
    setupParamSearch();
    setupParamButtons();
    setupReviewActions();
    await setupReusePanel();
    renderJsonPreview();

    // Keyboard hint: Esc clears toasts
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.toast').forEach(t => t.remove()); });
  });

})();
