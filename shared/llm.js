/* ═══════════════════════════════════════════════════════════════════════════
   LLM review surface — provider-agnostic chart review.
   Captures the rendered chart as PNG, builds a structured prompt with the
   material's stats, sends to the configured provider, parses a JSON response.

   Depends on: AppConfig (provider keys + model), AppChart (PNG capture).
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* ─── Prompt builder ────────────────────────────────────────────────────── */
  function buildPrompt(material, bucketName, parameters){
    const hceText = (material.hceP2 || []).length
      ? (material.hceP2.map(e => `WO ${e.order} (${e.date}) ${e.equipment} ${e.qty} EA · ${e.pct}% of P2 · ${e.reasons}`).join(' · '))
      : 'none';
    const rcText = material.rateChange != null ? `${material.rateChange}%` : 'N/A';
    const adjP2  = material.adjP2Rate != null ? `${material.adjP2Rate.toFixed(2)} / mo` : '—';

    return [
      `You are reviewing a consumption chart for an MRO inventory recommendation.`,
      ``,
      `Material:       ${material.material} — ${material.description}`,
      `Bucket:         ${bucketName}`,
      `Pattern:        ${material.pattern}`,
      ``,
      `STATISTICS`,
      `  Total consumed (analysis window):  ${material.totalNet}`,
      `  P1 rate (baseline, 5 mo):          ${material.p1Rate} / mo  [${material.p1Flag}]`,
      `  P2 rate (current, ${parameters.p2Months} mo): ${material.p2Rate} / mo  [${material.p2Flag}]`,
      `  P1 → P2 rate change:               ${rcText}`,
      `  Adjusted P2 (HCE excluded):        ${adjP2}`,
      `  HCE events (P2):                   ${hceText}`,
      ``,
      `CURRENT MRP STATE`,
      `  MRP type:        ${material.mrpType || '—'}`,
      `  Stock on hand:   ${material.stock != null ? material.stock : '—'}`,
      `  Current Min:     ${material.cmin != null ? material.cmin : '—'}`,
      `  Current Max:     ${material.cmax != null ? material.cmax : '—'}`,
      ``,
      `RECOMMENDATION (algorithmic)`,
      `  Recommended Min: ${material.recMin != null ? material.recMin : '—'}`,
      `  Recommended Max: ${material.recMax != null ? material.recMax : '—'}`,
      `  Traffic light:   ${material.trafficLight}`,
      `  Action:          ${material.action}`,
      ``,
      `The attached chart shows: orange step line = cumulative actual consumption; ` +
      `cyan dashed = P1 trend; green dashed = P2 trend; amber dots/annotations = HCE work orders.`,
      ``,
      `Your job is to look at the chart and the numbers together. Sanity check the recommendation. ` +
      `Look for: a P2 rate skewed by one HCE, a pattern that looks seasonal not steady, ` +
      `a lumpy classification the planner should be told about, anomalies the algorithm missed.`,
      ``,
      `Reply with ONLY a JSON object on a single line — no prose around it, no markdown fences:`,
      `{"verdict":"ok"|"tweak"|"review","notes":"<one or two sentences>","suggestedEdits":[<optional edits>]}`,
      ``,
      `verdict semantics:`,
      `  "ok"     — recommendation looks right given the chart`,
      `  "tweak"  — recommendation is close but a parameter change would improve it`,
      `  "review" — a planner needs to look at this manually (seasonal, anomaly, etc.)`,
      ``,
      `suggestedEdits is optional. Each edit is { "field":"recMin|recMax|trafficLight|action", "newValue":<value>, "rationale":"<why>" }.`
    ].join('\n');
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
    const out = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return out;
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
    // Strip code fences
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fence) s = fence[1].trim();
    // Find first { ... }
    const first = s.indexOf('{');
    const last  = s.lastIndexOf('}');
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
    try {
      const obj = JSON.parse(s);
      // Normalize
      const verdict = ['ok','tweak','review'].includes(obj.verdict) ? obj.verdict : 'review';
      const notes   = String(obj.notes || '');
      const edits   = Array.isArray(obj.suggestedEdits) ? obj.suggestedEdits : [];
      return { verdict, notes, suggestedEdits: edits, raw };
    } catch (e) {
      return { verdict: 'review', notes: '(could not parse model response — see raw)', suggestedEdits: [], raw };
    }
  }

  /* ─── Public review entry point ─────────────────────────────────────────── */
  /**
   * Capture a rendered chart's SVG to PNG, build the prompt, call the
   * configured provider, return the parsed verdict + notes + suggested edits.
   */
  async function review(material, bucketName, parameters, svgEl, opts){
    opts = opts || {};
    const provider = opts.provider || (await guessProvider());
    if (!provider) throw new Error('No LLM provider configured — set one in Settings.');
    const cfg = await AppConfig.getLlm(provider);
    if (!cfg.apiKey) throw new Error(`No API key saved for ${provider} — open Settings.`);
    if (!cfg.model)  throw new Error(`No model selected for ${provider} — open Settings and Fetch + pick a model.`);

    const png = await AppChart.toPng(svgEl, 2);
    const prompt = buildPrompt(material, bucketName, parameters);

    let raw;
    if (provider === 'anthropic') raw = await callAnthropic(cfg.apiKey, cfg.model, prompt, png);
    else if (provider === 'openai') raw = await callOpenAI(cfg.apiKey, cfg.model, prompt, png);
    else throw new Error(`Unknown provider: ${provider}`);

    return Object.assign({ provider, model: cfg.model }, parseJsonResponse(raw));
  }

  /**
   * Pick whichever provider has both apiKey and model set.
   * Preference order: anthropic, openai.
   */
  async function guessProvider(){
    for (const p of ['anthropic', 'openai']) {
      const c = await AppConfig.getLlm(p);
      if (c.apiKey && c.model) return p;
    }
    return null;
  }

  /**
   * Probe which providers are configured — used by the UI to enable buttons.
   */
  async function configuredProviders(){
    const out = [];
    for (const p of ['anthropic', 'openai']) {
      const c = await AppConfig.getLlm(p);
      if (c.apiKey && c.model) out.push({ provider: p, model: c.model });
    }
    return out;
  }

  global.AppLlm = Object.freeze({
    review, configuredProviders, guessProvider,
    buildPrompt, parseJsonResponse
  });

})(window);
