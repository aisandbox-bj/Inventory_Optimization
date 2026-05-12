/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v1.1.0 · released 2026-05-12
   Single source of truth for SCHEMA_VERSION and APP_VERSION (line ~17).
   Repo : https://github.com/aisandbox-bj/Inventory_Optimization
   RoC  : record-of-change.html
═══════════════════════════════════════════════════════════════════════════════

   Canonical JSON Schema — the contract between Intake and Analysis engines.
   Versioned. Changes here are breaking changes; bump SCHEMA_VERSION accordingly.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const SCHEMA_VERSION = '1.0.0';
  const APP_VERSION    = '1.1.0';

  /* ─── Factory defaults — seeded from the existing Python skill ──────────── */
  const FACTORY_DEFAULTS = Object.freeze({
    minMaxMethod:        'monthsBased',          // 'monthsBased' | 'leadTimeBased'
    p1Start:             '2025-04-01',
    p1End:               '2025-08-31',
    p2Months:            3,
    minMonths:           3,
    maxMonths:           6,
    threshold:           10,
    hcePctThreshold:     0.50,                   // 50% of period total
    hceMultThreshold:    3.0,                    // 3× avg WO qty
    lumpyCvThreshold:    1.2,
    lumpyTopWoThreshold: 0.40                    // 40% top-WO share
  });

  const SCOPE_MODES = ['fleet', 'manual', 'byClassification', 'byVendor', 'parameterSearch'];

  /* ─── Assessment types (set on intake Step 0) ────────────────────────────
     Determines which inputs are required and which scope modes are valid. */
  const ASSESSMENT_TYPES = ['unitFloc', 'userList', 'paramSearch'];
  const ASSESSMENT_TYPE_REQUIRES = Object.freeze({
    unitFloc:    ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'],
    userList:    ['mb51', 'inventoryMaster', 'userList'],
    paramSearch: ['mb51', 'inventoryMaster']
  });
  const ASSESSMENT_TYPE_SCOPE = Object.freeze({
    unitFloc:    ['fleet', 'byClassification', 'byVendor'],
    userList:    ['manual'],
    paramSearch: ['parameterSearch']
  });

  /* ─── Per-parameter descriptors (used by Intake §5 + Settings §1) ────────
     Kept here so every consumer reads the same wording. */
  const PARAMETER_DESCRIPTIONS = Object.freeze({
    minMaxMethod:        'How recommended Min/Max are computed. <b>monthsBased</b> = P2 rate × months. <b>leadTimeBased</b> = rate × lead-time + safety stock (needs lead-time data).',
    p1Start:             'Baseline period start. Together with P1 end, defines the historical 5-month run-rate window.',
    p1End:               'Baseline period end. P1 rate = net consumption in this window ÷ 5 months.',
    p2Months:            'Rolling current window measured back from the run date. <b>P2 rate drives the Min/Max recommendation.</b>',
    minMonths:           'Months of consumption the recommended <b>Min</b> should cover (only used in monthsBased method).',
    maxMonths:           'Months of consumption the recommended <b>Max</b> should cover (only used in monthsBased method).',
    threshold:           'Minimum net consumption (units) over the analysis window for a material to qualify for analysis.',
    hcePctThreshold:     'Single WO ≥ this share of the period total flags as a <b>High Consumption Event</b> (one-off spike — e.g. rebuild).',
    hceMultThreshold:    'Single WO ≥ this many times the average WO quantity also flags as an HCE.',
    lumpyCvThreshold:    'Coefficient of variation above this classifies a material as <b>LUMPY</b> (clustered demand, not steady draw-down).',
    lumpyTopWoThreshold: 'If a single WO represents this share or more of total consumption, classify as LUMPY.'
  });

  /* ─── Empty scope (one of each mode pre-shaped) ─────────────────────────── */
  function emptyScope(mode) {
    const scope = {
      mode,
      fleet:            { models: [] },
      manual:           { materials: [] },
      byClassification: {
        inventoryTypes: [],
        mrpClassifiers: [],
        movementAmount: { min: null, max: null }
      },
      byVendor:         { vendors: [] },
      parameterSearch:  { filters: [], resolvedMaterials: [] }
    };
    return scope;
  }

  /* ─── Empty canonical JSON shell ────────────────────────────────────────── */
  function emptyJson() {
    return {
      schemaVersion: SCHEMA_VERSION,
      metadata: {
        assessmentName: '',
        createdAt:      new Date().toISOString(),
        createdBy:      '',
        appVersion:     APP_VERSION,
        assessmentType: null
      },
      scope:      emptyScope('fleet'),
      parameters: { ...FACTORY_DEFAULTS },
      data: {
        mb51:            [],
        iw39:            [],
        fleetMaster:     [],
        inventoryMaster: [],
        userList:        [],
        materialVendor:  [],
        leadTimes:       []
      },
      validation: { passed: false, issues: [] }
    };
  }

  /* ─── Validators ────────────────────────────────────────────────────────── */
  /**
   * Validate a canonical JSON object structurally. Returns { ok, errors }.
   * Does NOT validate data quality — that's the DQ gate's job. This is shape only.
   */
  function validateShape(json) {
    const errors = [];

    if (!json || typeof json !== 'object') {
      return { ok: false, errors: ['Not an object'] };
    }
    if (json.schemaVersion !== SCHEMA_VERSION) {
      errors.push(`schemaVersion mismatch: expected ${SCHEMA_VERSION}, got ${json.schemaVersion}`);
    }
    if (!json.metadata || typeof json.metadata !== 'object') errors.push('metadata missing');
    if (!json.scope    || typeof json.scope    !== 'object') errors.push('scope missing');
    if (!json.parameters || typeof json.parameters !== 'object') errors.push('parameters missing');
    if (!json.data     || typeof json.data     !== 'object') errors.push('data missing');

    if (json.scope && !SCOPE_MODES.includes(json.scope.mode)) {
      errors.push(`scope.mode invalid: ${json.scope.mode} (expected one of ${SCOPE_MODES.join(', ')})`);
    }

    if (json.scope && json.scope.mode === 'byVendor') {
      if (!Array.isArray(json.data?.materialVendor) || json.data.materialVendor.length === 0) {
        errors.push('byVendor scope requires data.materialVendor to be populated');
      }
    }

    if (json.parameters && json.parameters.minMaxMethod === 'leadTimeBased') {
      if (!Array.isArray(json.data?.leadTimes) || json.data.leadTimes.length === 0) {
        errors.push('leadTimeBased method requires data.leadTimes to be populated');
      }
    }

    const dataKeys = ['mb51', 'iw39', 'fleetMaster', 'inventoryMaster'];
    for (const k of dataKeys) {
      if (!Array.isArray(json.data?.[k])) {
        errors.push(`data.${k} must be an array`);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  /* ─── Parameter sanity (called after Settings or per-run override) ──────── */
  function validateParameters(p) {
    const errors = [];
    if (!p) return { ok: false, errors: ['parameters missing'] };
    if (p.minMonths < 0 || p.maxMonths < 0) errors.push('months cannot be negative');
    if (p.minMonths > p.maxMonths)         errors.push('minMonths > maxMonths');
    if (p.threshold < 0)                    errors.push('threshold cannot be negative');
    if (p.p2Months < 1)                     errors.push('p2Months must be ≥ 1');
    if (p.hcePctThreshold < 0 || p.hcePctThreshold > 1) errors.push('hcePctThreshold must be 0–1');
    if (p.hceMultThreshold < 1)             errors.push('hceMultThreshold must be ≥ 1');
    if (p.lumpyCvThreshold < 0)             errors.push('lumpyCvThreshold must be ≥ 0');
    if (p.lumpyTopWoThreshold < 0 || p.lumpyTopWoThreshold > 1) errors.push('lumpyTopWoThreshold must be 0–1');
    if (p.p1Start && p.p1End && p.p1Start > p.p1End)            errors.push('p1Start > p1End');
    if (!['monthsBased','leadTimeBased'].includes(p.minMaxMethod)) errors.push('minMaxMethod invalid');
    return { ok: errors.length === 0, errors };
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */
  global.CanonicalSchema = Object.freeze({
    SCHEMA_VERSION,
    APP_VERSION,
    SCOPE_MODES,
    ASSESSMENT_TYPES,
    ASSESSMENT_TYPE_REQUIRES,
    ASSESSMENT_TYPE_SCOPE,
    FACTORY_DEFAULTS,
    PARAMETER_DESCRIPTIONS,
    emptyScope,
    emptyJson,
    validateShape,
    validateParameters
  });

})(window);
