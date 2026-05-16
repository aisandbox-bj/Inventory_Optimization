/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.1.0 · released 2026-05-12
   LLM review surface — provider-agnostic chart review.

   v2.0 baseline:
     • Prompt template sourced from AppConfig.getPromptTemplate() — user can
       edit it in Settings. Placeholders {material}, {p2Rate}, etc. resolved
       at call-time.
     • Prompt hash (SHA-256 of the template, first 16 hex chars) exposed so
       mass-review JSONs can record which prompt was used.
     • Single-review and Mass-review share this module. Mass uses the
       lower-level reviewWithPng() to avoid re-capturing PNGs unnecessarily.

   v2.1.0 additions:
     • buildPrompt() resolves the active Operational Context (via
       AppClientContext) and injects it as {customerContext} so the model
       sees site character before the per-material stats.
     • buildContext() exposes new signal tokens to the template:
       {netSign}, {rateChangeFlag}, {invAdjCount}, {daysSinceLastIssue}.
       These are pure pipeline-derived fields — no client identifiers.
     • parseJsonResponse() now extracts a structured signals[] array
       (e.g. ["negativeNet","sharpDrop"]). Rendered in v2.1.1 as chips.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Resolve {placeholders} in a template against material context ─── */
  function interpolate(template, ctx){
    return String(template || '').replace(/\{(\w+)\}/g, (match, key) => {
      if (key in ctx) {
        const v = ctx[key];
        return (v == null || v === '') ? '—' : String(v);
      }
      return match;   // unknown placeholder — leave intact for debugging
    });
  }

  /* ─── Build the per-material context object the template reads from ─────
     v2.1.0: accepts an optional `customerContext` string from the active
     Operational Context entry; resolved by buildPrompt() before calling. */
  function buildContext(material, bucketName, parameters, customerContext){
    const hceText = (material.hceP2 || []).length
      ? (material.hceP2.map(e => `WO ${e.order} (${e.date}) ${e.equipment} ${e.qty} EA · ${e.pct}% of P2 · ${e.reasons}`).join(' · '))
      : 'none';
    const rcText = material.rateChange != null ? `${material.rateChange}%` : 'N/A';
    const adjP2  = (material.adjP2Rate != null) ? `${material.adjP2Rate.toFixed(2)} / mo` : '—';
    // APP-E1 (v2.1.3) — stockout-aware drop signal. When a sharp drop is
    // traceable to a stockout window in the back-calc, name the cause so the
    // model doesn't narrate "demand softening" on what's really a supply gap.
    // APP-E11 — STOCKOUT-DOMINATED short-circuits everything: when multiple
    // stockouts fall inside the P2 window, the rate verdict isn't trustworthy
    // and the math has already forced GREY. Tell the model not to push a
    // demand-rate narrative; the issue is supply continuity.
    let rateChangeFlag;
    if (material.stockoutDominated) {
      rateChangeFlag = '⚠ STOCKOUT-DOMINATED RECENT-RATE WINDOW — multiple stockouts inside P2 make the rate untrustworthy; verify supply continuity, do NOT recommend Min/Max change on the basis of P2 rate';
    } else if (material.rateDropFlag) {
      if (material.rateDropCause === 'STOCKOUT_DRIVEN') {
        rateChangeFlag = '⚠ SHARP DROP — STOCKOUT-DRIVEN (consumption stopped because stock ran out, not because demand dropped)';
      } else if (material.rateDropCause === 'GENUINE_DEMAND_DROP') {
        rateChangeFlag = '⚠ SHARP DROP — GENUINE DEMAND DROP (stock was available; consumption fell anyway)';
      } else {
        rateChangeFlag = '⚠ SHARP DROP';
      }
    } else if (material.rateRiseFlag) {
      rateChangeFlag = '⚠ SHARP RISE';
    } else {
      rateChangeFlag = '';
    }
    // Stockout summary string for the prompt — terse, useful for the model
    const _swCount = (material.stockoutWindows || []).length;
    const _swDays  = (material.stockoutWindows || []).reduce((s, w) => s + (w.days || 0), 0);
    const stockoutSummary = _swCount === 0
      ? 'no stockouts in back-calc window'
      : `${_swCount} stockout window${_swCount === 1 ? '' : 's'} totalling ${_swDays} day${_swDays === 1 ? '' : 's'}`;
    return {
      customerContext: (customerContext == null || customerContext === '') ? '(none)' : String(customerContext),
      material:     material.material,
      description:  material.description || '',
      bucket:       bucketName,
      pattern:      material.pattern,
      totalNet:     material.totalNet,
      netSign:      material.netSign || 'NO_DATA',
      p1Rate:       material.p1Rate,
      p1Flag:       material.p1Flag,
      p2Rate:       material.p2Rate,
      p2Flag:       material.p2Flag,
      p2Months:     parameters.p2Months,
      rateChange:   rcText,
      rateChangeFlag,
      adjP2,
      hceText,
      invAdjCount:  (material.invAdjCount != null) ? material.invAdjCount : ((material.invAdj || []).length),
      daysSinceLastIssue: (material.daysSinceLastIssue == null) ? 'no issues in window' : String(material.daysSinceLastIssue),
      woCount:      (material.woCount != null) ? material.woCount : '—',
      mrpType:      material.mrpType,
      stock:        (material.stock != null) ? material.stock : '—',
      cmin:         (material.cmin != null) ? material.cmin : '—',
      cmax:         (material.cmax != null) ? material.cmax : '—',
      runway:       (material.runway != null) ? material.runway : '—',
      recMin:       (material.recMin != null) ? material.recMin : '—',
      recMax:       (material.recMax != null) ? material.recMax : '—',
      recMrpType:   material.recMrpType || '—',
      trafficLight: material.trafficLight,
      action:       material.action,
      // APP-E1 tokens — surface stockout diagnostic to the prompt template
      lastConsumptionDate: material.lastConsumptionDate || '—',
      rateDropCause:       material.rateDropCause || '—',
      stockoutSummary,
      // APP-E11 tokens — P2 anchor + stockout-dominated state
      p2AnchorMode:        material.p2AnchorMode || 'runDate',
      stockoutDominated:   !!material.stockoutDominated,
      p2StockoutCount:     (material.p2StockoutCount != null) ? material.p2StockoutCount : 0
    };
  }

  async function buildPrompt(material, bucketName, parameters, templateOverride){
    const tpl = templateOverride || await AppConfig.getPromptTemplate();
    // v2.1.0: resolve active Operational Context for the {customerContext}
    // token. Guarded so older code paths still work if client-context.js
    // isn't loaded.
    let customerContext = '';
    if (typeof AppClientContext !== 'undefined' && AppClientContext.resolveContextText) {
      try { customerContext = await AppClientContext.resolveContextText(); } catch { customerContext = ''; }
    }
    return interpolate(tpl, buildContext(material, bucketName, parameters, customerContext));
  }

  /* ─── Hash the *template itself* (not the resolved per-material version) ─
     Used by mass-review JSONs for audit trail. SHA-256 → hex (first 16 chars). */
  async function hashTemplate(template){
    try {
      const data = new TextEncoder().encode(String(template || ''));
      const buf  = await crypto.subtle.digest('SHA-256', data);
      const hex  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return 'sha256-' + hex.slice(0, 16);
    } catch {
      return '';
    }
  }

  /* ─── Provider call dispatchers ─────────────────────────────────────────── */
  async function callAnthropic(apiKey, model, prompt, pngDataUrl){
    const base64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':                              'application/json',
        'x-api-key':                                 apiKey,
        'anthropic-version':                         '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text',  text: prompt }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const blocks = j.content || [];
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  }

  async function callOpenAI(apiKey, model, prompt, pngDataUrl){
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type':  'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text',      text: prompt },
            { type: 'image_url', image_url: { url: pngDataUrl } }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const choice = (j.choices && j.choices[0]) || {};
    return ((choice.message && choice.message.content) || '').trim();
  }

  /* ─── Response parsing — strip markdown fences if present ─────────────────
     v2.1.0: extracts a structured `signals` array alongside verdict / notes /
     suggestedEdits. Older responses without `signals` produce an empty array
     (backward-compatible with cached and saved mass-review JSONs). */
  function parseJsonResponse(raw){
    let s = String(raw || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) s = fence[1].trim();
    const first = s.indexOf('{');
    const last  = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try {
      const obj = JSON.parse(s);
      const verdict = ['ok','tweak','review'].includes(obj.verdict) ? obj.verdict : 'review';
      const notes   = String(obj.notes || '');
      const signals = Array.isArray(obj.signals)
                    ? obj.signals.filter(x => typeof x === 'string').slice(0, 8)
                    : [];
      const edits   = Array.isArray(obj.suggestedEdits) ? obj.suggestedEdits : [];
      return { verdict, notes, signals, suggestedEdits: edits, raw };
    } catch (e) {
      return { verdict: 'review', notes: '(could not parse model response — see raw)', signals: [], suggestedEdits: [], raw };
    }
  }

  /* ─── Public: single-material review (capture SVG → PNG, call, parse) ─── */
  async function review(material, bucketName, parameters, svgEl, opts){
    opts = opts || {};
    const provider = opts.provider || (await guessProvider());
    if (!provider) throw new Error('No LLM provider configured — set one in Settings.');
    const cfg = await AppConfig.getLlm(provider);
    if (!cfg.apiKey) throw new Error(`No API key saved for ${provider} — open Settings.`);
    if (!cfg.model)  throw new Error(`No model selected for ${provider} — open Settings and Fetch + pick a model.`);

    const png    = await AppChart.toPng(svgEl, 2);
    const prompt = await buildPrompt(material, bucketName, parameters);
    const startedAt = performance.now();
    let raw;
    if (provider === 'anthropic')   raw = await callAnthropic(cfg.apiKey, cfg.model, prompt, png);
    else if (provider === 'openai') raw = await callOpenAI   (cfg.apiKey, cfg.model, prompt, png);
    else throw new Error(`Unknown provider: ${provider}`);
    const latencyMs = Math.round(performance.now() - startedAt);

    return Object.assign({ provider, model: cfg.model, latencyMs, source:'single' }, parseJsonResponse(raw));
  }

  /* ─── Public: review one material from an arbitrary PNG (mass-loop entry) ─ */
  async function reviewWithPng(material, bucketName, parameters, pngDataUrl, opts){
    opts = opts || {};
    const provider = opts.provider || (await guessProvider());
    if (!provider) throw new Error('No LLM provider configured — set one in Settings.');
    const cfg = await AppConfig.getLlm(provider);
    if (!cfg.apiKey) throw new Error(`No API key saved for ${provider} — open Settings.`);
    if (!cfg.model)  throw new Error(`No model selected for ${provider} — open Settings and Fetch + pick a model.`);

    const prompt = await buildPrompt(material, bucketName, parameters, opts.template);
    const startedAt = performance.now();
    let raw;
    if (provider === 'anthropic')   raw = await callAnthropic(cfg.apiKey, cfg.model, prompt, pngDataUrl);
    else if (provider === 'openai') raw = await callOpenAI   (cfg.apiKey, cfg.model, prompt, pngDataUrl);
    else throw new Error(`Unknown provider: ${provider}`);
    const latencyMs = Math.round(performance.now() - startedAt);

    return Object.assign({ provider, model: cfg.model, latencyMs }, parseJsonResponse(raw));
  }

  async function guessProvider(){
    for (const p of ['anthropic', 'openai']) {
      const c = await AppConfig.getLlm(p);
      if (c.apiKey && c.model) return p;
    }
    return null;
  }

  async function configuredProviders(){
    const out = [];
    for (const p of ['anthropic', 'openai']) {
      const c = await AppConfig.getLlm(p);
      if (c.apiKey && c.model) out.push({ provider: p, model: c.model });
    }
    return out;
  }

  global.AppLlm = Object.freeze({
    review, reviewWithPng, configuredProviders, guessProvider,
    buildPrompt, interpolate, buildContext, parseJsonResponse, hashTemplate
  });

})(window);
