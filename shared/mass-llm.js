/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.0.0-dev · released 2026-05-12
   Mass LLM Review — orchestrator. Pure orchestration; no UI.

   Runs an LLM review (via AppLlm.reviewWithPng) sequentially over a set of
   materials. Emits progress events. Supports cancel + pause + per-row error
   capture. Caller owns the UI (modal, table, drill-down).

   DATA SECURITY: everything is in-memory only. No localStorage / IndexedDB
   touches at any point. Caller is expected to wipe results on modal close.

   Depends on: AppLlm (reviewWithPng + hashTemplate), AppChart (PNG render),
   AppConfig (getPromptTemplate).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  const MAX_SELECTION = 50;   // hard cap, per design decision (V2 plan §1)

  /**
   * Render one chart offscreen and capture PNG.
   * Mirrors AppExcel.renderChartPng's offscreen-DOM pattern.
   */
  async function renderMaterialPng(material){
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;width:1100px;height:470px;visibility:hidden;background:#0C2D3B;';
    document.body.appendChild(host);
    try {
      const svg = AppChart.render(host, material, { width: 1100, height: 470 });
      return await AppChart.toPng(svg, 1.6);
    } finally {
      document.body.removeChild(host);
    }
  }

  /**
   * Run a mass review.
   *
   * @param {Array<Object>} materials   Per-material objects (from pipeline result)
   * @param {string}        bucketName  Bucket display name (passed to prompt)
   * @param {Object}        parameters  Run parameters (from canonical JSON)
   * @param {Object}        opts
   *   - onProgress(state)   called after each result row finalises
   *   - onComplete(session) called once all materials processed
   *   - signal              an object { cancelled: bool, paused: bool }
   *                         the caller mutates externally — orchestrator
   *                         checks it before each call. Caller can also
   *                         call session.cancel() / session.pause() /
   *                         session.resume() on the returned handle.
   *
   * @returns {Object} session
   *   - results[]    array of result rows (filled live as the loop runs)
   *   - status       'running' | 'paused' | 'cancelled' | 'done'
   *   - promptHash   prompt hash for audit trail
   *   - provider/model captured at start
   *   - cancel(), pause(), resume(), waitFor() helpers
   */
  function createSession(materials, bucketName, parameters, opts){
    opts = opts || {};
    const onProgress = opts.onProgress || (() => {});
    const onComplete = opts.onComplete || (() => {});

    if (!Array.isArray(materials) || materials.length === 0) {
      throw new Error('No materials provided to Mass LLM Review.');
    }
    if (materials.length > MAX_SELECTION) {
      throw new Error(`Selection exceeds ${MAX_SELECTION} materials.`);
    }

    const session = {
      status: 'pending',
      bucketName,
      startedAt: null,
      completedAt: null,
      provider: null,
      model: null,
      promptHash: '',
      total: materials.length,
      cursor: 0,
      results: materials.map(m => ({
        material:        m.material,
        description:     m.description || '',
        preTL:           m.trafficLight,
        preAction:       m.action,
        verdict:         null,
        notes:           '',
        suggestedEdits: [],
        latencyMs:       null,
        error:           null,
        status:          'pending',     // 'pending'|'inflight'|'done'|'error'|'skipped'
        timestamp:       null
      })),
      _flags: { cancelled: false, paused: false },
      _resolvers: []
    };

    session.cancel = function() {
      session._flags.cancelled = true;
      if (session.status === 'paused') session.status = 'cancelled';
    };
    session.pause = function() {
      if (session.status === 'running') {
        session._flags.paused = true;
      }
    };
    session.resume = function() {
      session._flags.paused = false;
      if (session.status === 'paused') {
        session.status = 'running';
        runLoop(session, materials, bucketName, parameters, onProgress, onComplete);
      }
    };
    session.waitFor = function() {
      return new Promise(resolve => session._resolvers.push(resolve));
    };

    // Kick off async
    setTimeout(() => runLoop(session, materials, bucketName, parameters, onProgress, onComplete), 0);
    return session;
  }

  async function runLoop(session, materials, bucketName, parameters, onProgress, onComplete){
    if (!session.startedAt) {
      session.startedAt = AppLocale.localDateTimeISO();
      session.status = 'running';
      // Capture provider + prompt hash up-front for audit trail
      try {
        const tpl = await AppConfig.getPromptTemplate();
        session.promptHash = await AppLlm.hashTemplate(tpl);
        // Provider not finalised until first call; fill from AppLlm.guessProvider
        const prov = await AppLlm.guessProvider();
        session.provider = prov;
        if (prov) {
          const c = await AppConfig.getLlm(prov);
          session.model = c.model;
        }
      } catch (e) {
        // Non-fatal — call will fail with a clearer message if provider not configured
      }
    }

    onProgress(session);

    while (session.cursor < materials.length) {
      if (session._flags.cancelled) {
        // Mark remaining as skipped
        for (let i = session.cursor; i < materials.length; i++) {
          if (session.results[i].status === 'pending') session.results[i].status = 'skipped';
        }
        session.status = 'cancelled';
        break;
      }
      if (session._flags.paused) {
        session.status = 'paused';
        onProgress(session);
        return;   // resume() will re-enter
      }

      const i = session.cursor;
      const m = materials[i];
      const row = session.results[i];
      row.status = 'inflight';
      row.timestamp = AppLocale.localDateTimeISO();
      onProgress(session);

      try {
        const png = await renderMaterialPng(m);
        const out = await AppLlm.reviewWithPng(m, bucketName, parameters, png);
        row.verdict        = out.verdict;
        row.notes          = out.notes;
        row.suggestedEdits = out.suggestedEdits || [];
        row.latencyMs      = out.latencyMs;
        row.status         = 'done';
        session.provider = out.provider || session.provider;
        session.model    = out.model    || session.model;
      } catch (e) {
        row.error  = e && e.message ? e.message : String(e);
        row.status = 'error';
      }

      session.cursor = i + 1;
      onProgress(session);
    }

    if (session.status !== 'cancelled' && session.status !== 'paused') {
      session.status = 'done';
    }
    session.completedAt = AppLocale.localDateTimeISO();
    onComplete(session);
    session._resolvers.forEach(r => r(session));
    session._resolvers.length = 0;
  }

  /* ─── Hydrate from a saved mass-review JSON (re-load after wipe-on-close) ── */
  /**
   * Given a previously-downloaded mass-review JSON and the current pipeline
   * result, rebuild a session-like object that the UI can render in Results
   * view. Materials are matched by material number against the active bucket.
   */
  function hydrate(savedJson, pipelineResult, bucketKey){
    if (!savedJson || savedJson.kind !== 'mass-llm-review') {
      throw new Error('Not a mass-llm-review JSON.');
    }
    const bucket = pipelineResult.buckets.find(b => b.key === bucketKey || b.name === savedJson.metadata.bucketKey);
    if (!bucket) {
      throw new Error(`Bucket "${savedJson.metadata.bucketKey}" not found in the current analysis.`);
    }
    const byMat = new Map(bucket.materials.map(m => [m.material, m]));
    const results = [];
    for (const [matKey, r] of Object.entries(savedJson.results || {})) {
      const m = byMat.get(matKey);
      results.push({
        material:        matKey,
        description:     m ? (m.description || '') : '',
        preTL:           r.preTL,
        preAction:       r.preAction || (m ? m.action : ''),
        verdict:         r.verdict,
        notes:           r.notes || '',
        suggestedEdits:  r.suggestedEdits || [],
        latencyMs:       r.latencyMs || null,
        error:           r.error || null,
        status:          r.error ? 'error' : (r.verdict ? 'done' : 'skipped'),
        timestamp:       r.timestamp || null,
        _hydrated:       true
      });
    }
    return {
      status:      'done',
      bucketName:  bucket.name,
      startedAt:   savedJson.metadata.ranAt,
      completedAt: savedJson.metadata.ranAt,
      provider:    savedJson.metadata.provider,
      model:       savedJson.metadata.model,
      promptHash:  savedJson.metadata.promptHash || '',
      total:       results.length,
      cursor:      results.length,
      results,
      _hydrated:   true,
      _flags:      { cancelled:false, paused:false },
      cancel:      () => {},
      pause:       () => {},
      resume:      () => {}
    };
  }

  /* ─── Public: serialize session → mass-review JSON download blob ───────── */
  function toJson(session, assessmentName){
    const out = {
      schemaVersion: '1.0.0',
      kind: 'mass-llm-review',
      metadata: {
        assessmentName: assessmentName || '',
        bucketKey:      session.bucketName,
        ranAt:          session.startedAt,
        completedAt:    session.completedAt,
        provider:       session.provider,
        model:          session.model,
        promptHash:     session.promptHash,
        total:          session.total,
        completed:      session.results.filter(r => r.status === 'done').length,
        errored:        session.results.filter(r => r.status === 'error').length,
        skipped:        session.results.filter(r => r.status === 'skipped').length
      },
      results: {}
    };
    for (const r of session.results) {
      out.results[r.material] = {
        preTL:          r.preTL,
        preAction:      r.preAction,
        verdict:        r.verdict,
        notes:          r.notes,
        suggestedEdits: r.suggestedEdits,
        latencyMs:      r.latencyMs,
        error:          r.error,
        timestamp:      r.timestamp
      };
    }
    return out;
  }

  global.AppMassLlm = Object.freeze({
    MAX_SELECTION,
    createSession,
    hydrate,
    toJson
  });

})(window);
