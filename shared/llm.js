/* ═══ BUILD-STAMP ═══════════════════════════════════════════════════════════
   Inventory Optimization App · v2.0.0-dev · released 2026-05-12
   LLM review surface — provider-agnostic chart review.

   v2.0 changes:
     • Prompt template sourced from AppConfig.getPromptTemplate() — user can
       edit it in Settings. Placeholders {material}, {p2Rate}, etc. resolved
       at call-time.
     • Prompt hash (SHA-256 of the template, first 16 hex chars) exposed so
       mass-review JSONs can record which prompt was used.
     • Single-review and Mass-review share this module. Mass uses the
       lower-level reviewWithPng() to avoid re-capturing PNGs unnecessarily.
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

  /* ─── Build the per-material context object the template reads from ─── */
  function buildContext(material, bucketName, parameters){
    const hceText = (material.hceP2 || []).length
      ? (material.hceP2.map(e => `WO ${e.order} (${e.date}) ${e.equipment} ${e.qty} EA · ${e.pct}% of P2 · ${e.reasons}`).join(' · '))
      : 'none';
    const rcText = material.rateChange != null ? `${material.rateChange}%` : 'N/A';
    const adjP2  = (material.adjP2Rate != null) ? `${material.adjP2Rate.toFixed(2)} / mo` : '—';
    return {
      material:     material.material,
      description:  material.description || '',
      bucket:       bucketName,
      pattern:      material.pattern,
      totalNet:     material.totalNet,
      p1Rate:       material.p1Rate,
      p1Flag:       material.p1Flag,
      p2Rate:       material.p2Rate,
      p2Flag:       material.p2Flag,
      p2Months:     parameters.p2Months,
      rateChange:   rcText,
      adjP2,
      hceText,
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
      action:       material.action
    };
  }

  async function buildPrompt(material, bucketName, parameters, templateOverride){
    const tpl = templateOverride || await AppConfig.getPromptTemplate();
    return interpolate(tpl, buildContext(material, bucketName, parameters));
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

  /* ─── Response parsing — strip markdown fences if present ───────────────── */
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
      const edits   = Array.isArray(obj.suggestedEdits) ? obj.suggestedEdits : [];
      return { verdict, notes, suggestedEdits: edits, raw };
    } catch (e) {
      return { verdict: 'review', notes: '(could not parse model response — see raw)', suggestedEdits: [], raw };
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
