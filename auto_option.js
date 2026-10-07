// auto_option - like show_options, but a decision model picks the option.
// Backend: llama.cpp server /v1/systemone (decision models: Julia-1, Laya, Kev-4B, lev, OpenJev).
// The model is chosen with the "Decision Model" picker (populated from .agent/models.json).
// The tool only ever sees an opaque model UUID: Ion resolves it to the URL, model name and API key
// and makes the request itself (api.callModel), so this tool never has access to connection details.
const TOOL_META = {
    "name": "auto_option",
    "description": "Picks one of 2-10 options automatically using a local decision model (llama.cpp /v1/systemone) instead of asking the user. The model scores every option in a single forward pass and returns the winner with a probability and confidence. Give each option a clear description: it greatly improves accuracy. Provide a 'state' with the context the decision depends on. If confidence is below the configured cutoff, the tool reports LOW_CONFIDENCE so you can ask the user with show_options instead. Plain text only (strictly NO emojis).",
    "toolBox": 1,
    "expanded": true,
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "The decision question, e.g. 'Which team should handle this?'. Plain text only, no emojis."
            },
            "state": {
                "type": "string",
                "description": "The context the model decides on (user message, error output, JSON, etc.). Include everything relevant; the model sees only this and the options."
            },
            "options": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "Short option name. Plain text only, do NOT use emojis or icons."
                        },
                        "value": { "type": "string", "description": "Returned value. Must be unique. Defaults to label." },
                        "description": {
                            "type": "string",
                            "description": "What this option means / when it applies. Strongly recommended. Plain text only, no emojis."
                        }
                    },
                    "required": ["label", "value"]
                },
                "description": "2-10 options to choose from. No emojis."
            },
            "minConfidence": {
                "type": "number",
                "description": "Optional per-call confidence cutoff (0-1). Overrides the tool setting."
            }
        },
        "required": ["prompt", "state", "options"]
    },
    "permission": "ask",
    "settings": [
        {
            "key": "decisionModel",
            "label": "Decision Model",
            "type": "model",
            "default": "",
            "description": "Pick a decision model from your models.json providers (it must be a decision model such as Kev-4B, Julia-1, Laya, lev or OpenJev). Ion connects to it for this tool; the tool never sees its URL or API key."
        },
        {
            "key": "minConfidence",
            "label": "Confidence Cutoff (0-1)",
            "type": "number",
            "default": 0,
            "min": 0,
            "max": 1,
            "description": "Below this confidence the tool returns LOW_CONFIDENCE instead of a decision. 0 disables the cutoff. The right value differs per model, so test on your own examples."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 15000,
            "min": 1000,
            "max": 120000,
            "description": "Timeout for the decision request in milliseconds."
        }
    ]
};

function removeEmojis(str) {
    if (!str) return '';
    return String(str)
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\uFE0E\uFE0F]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// status: 'pending' | 'done' | 'low' | 'error'
function buildResultHTML(promptText, options, info) {
    const { status, chosen, probs, confidence, model, note } = info;
    const cleanPrompt = removeEmojis(promptText) || 'Decision';

    const rows = options.map(opt => {
        const p = probs && typeof probs[opt.key] === 'number' ? probs[opt.key] : null;
        const isChosen = status === 'done' && chosen === opt.key;
        const border = isChosen
            ? "border:1px solid var(--accent,#61afef);box-shadow:0 0 0 1px var(--accent,#61afef);"
            : "border:1px solid var(--border,#333);" + (status === 'done' ? "opacity:0.45;" : "");
        const desc = opt.cleanDesc
            ? `<span style="display:block;font-size:10.5px;opacity:.65;margin-top:1px;">${esc(opt.cleanDesc)}</span>` : '';
        const pct = p === null ? '' : `${(p * 100).toFixed(1)}%`;
        const bar = p === null ? '' :
            `<span style="display:block;height:3px;margin-top:3px;border-radius:2px;background:rgba(255,255,255,.08);">`
            + `<span style="display:block;height:3px;width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%;border-radius:2px;background:var(--accent,#61afef);"></span></span>`;
        return `<div style="box-sizing:border-box;padding:5px 10px;border-radius:5px;background:rgba(255,255,255,.04);${border}">`
            + `<span style="display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:600;"><span>${esc(opt.cleanLabel)}</span><span style="opacity:.8;font-weight:500;">${pct}</span></span>`
            + desc + bar + `</div>`;
    }).join('');

    let footer = '';
    if (status === 'pending') footer = 'Asking decision model...';
    else if (status === 'done') footer = `Decision model chose: ${esc(opts_label(options, chosen))}`
        + (confidence !== null && confidence !== undefined ? ` (confidence ${(confidence * 100).toFixed(0)}%)` : '')
        + (model ? ` - ${esc(model)}` : '');
    else if (status === 'low') footer = `Low confidence${confidence !== null && confidence !== undefined ? ` (${(confidence * 100).toFixed(0)}%)` : ''} - no decision made`;
    else if (status === 'error') footer = `Error: ${esc(note || 'unknown')}`;

    return `<div class="choice-card" style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--border,#2e2e2e);border-radius:6px;background:var(--bg-panel,#181818);margin:2px 0;white-space:normal;">`
        + `<div style="font-size:12.5px;font-weight:500;margin:0 0 2px 0;">${esc(cleanPrompt)}</div>${rows}`
        + `<div style="font-size:10.5px;opacity:.7;margin-top:2px;">${footer}</div></div>`;
}

function opts_label(options, key) {
    const o = options.find(x => x.key === key);
    return o ? o.cleanLabel : String(key);
}

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') api.setHeaderMsg(msg);
    };

    // ---- validate input ----
    const rawOptions = Array.isArray(args.options) ? args.options.slice(0, 10) : [];
    if (rawOptions.length < 2) return "ERROR: provide at least 2 options.";
    if (!args.state || !String(args.state).trim()) return "ERROR: 'state' is required (the context the decision is based on).";
    if (!args.prompt || !String(args.prompt).trim()) return "ERROR: 'prompt' is required (the decision question).";

    // Unique keys: use the option value (falls back to label); de-dupe if needed
    const seen = new Set();
    const options = rawOptions.map((o, i) => {
        const cleanLabel = removeEmojis(o.label) || `Option ${i + 1}`;
        const cleanDesc = removeEmojis(o.description);
        let key = String(o.value || o.label || `option_${i + 1}`);
        while (seen.has(key)) key += `_${i + 1}`;
        seen.add(key);
        return { key, cleanLabel, cleanDesc };
    });

    // ---- settings ----
    const getSetting = async (k, d) => {
        if (typeof api?.getSetting !== 'function') return d;
        const v = await api.getSetting(k);
        return (v === undefined || v === null || v === '') ? d : v;
    };

    // The setting holds an opaque model UUID. Ion does the connecting; no URL or key is visible here.
    const modelId = String(await getSetting('decisionModel', '')).trim();
    if (!modelId) {
        return 'ERROR: no decision model selected. Pick one in the tool settings (Settings > Tools > auto_option > Decision Model), or ask the user with show_options instead.';
    }
    if (typeof api?.callModel !== 'function') {
        return 'ERROR: this version of Ion does not support secure model calls (api.callModel is missing). Update Ion.';
    }

    const timeoutNum = Number(await getSetting('timeoutMs', 15000));
    const TIMEOUT_MS = Number.isFinite(timeoutNum) && timeoutNum > 0 ? timeoutNum : 15000;
    const cutoffSetting = Number(await getSetting('minConfidence', 0));
    let cutoff = Number.isFinite(cutoffSetting) ? cutoffSetting : 0;
    if (typeof args.minConfidence === 'number' && Number.isFinite(args.minConfidence)) cutoff = args.minConfidence;
    cutoff = Math.max(0, Math.min(1, cutoff));

    // ---- show pending card ----
    const pendingHtml = buildResultHTML(args.prompt, options, { status: 'pending' });
    if (typeof api?.showUI === 'function') {
        // Non-blocking display: do not await a user choice
        try { api.showUI(pendingHtml); } catch (_) { /* display is best-effort */ }
    }

    // ---- build /v1/systemone request ----
    const criteria = {};
    options.forEach(o => { criteria[o.key] = o.cleanDesc || null; });

    const body = {
        state: String(args.state),
        questions: {
            decision: {
                type: 'choice',
                instructions: removeEmojis(args.prompt) || String(args.prompt),
                criteria
            }
        }
    };

    const fail = (msg, note) => ({
        output: `ERROR: ${msg}`,
        displayHtml: buildResultHTML(args.prompt, options, { status: 'error', note: note || msg })
    });

    // ---- call the decision model (Ion attaches the URL, key and model name) ----
    updateStatus('Asking decision model...');
    let data;
    try {
        const r = await api.callModel(modelId, {
            path: '/v1/systemone',
            body: JSON.stringify(body),
            timeoutMs: TIMEOUT_MS
        });

        if (!r || r.error) {
            updateStatus('Decision model call failed');
            const err = r && r.error;
            if (err === 'timeout') return fail(`decision model timed out after ${TIMEOUT_MS / 1000}s.`, 'timeout');
            if (err === 'unreachable') return fail('could not reach the decision model. Check that llama-server is running and the provider URL in models.json is correct.', 'unreachable');
            return fail(`${err || 'decision model call failed'}. Re-pick the Decision Model in the tool settings.`, err || 'call failed');
        }

        if (!r.ok) {
            const detail = String(r.text || '').slice(0, 300);
            updateStatus('Decision model call failed');
            if (r.status === 501) {
                return fail('the selected model is not a decision model (server returned 501). Pick a decision model such as Kev-4B, e.g. "llama serve -hf ggml-org/Kev-4B-GGUF".', 'not a decision model (501)');
            }
            return fail(`decision endpoint returned HTTP ${r.status}${detail ? ': ' + detail : ''}`, `HTTP ${r.status}`);
        }
        try {
            data = JSON.parse(r.text);
        } catch (_) {
            updateStatus('Unexpected decision response');
            return fail('decision endpoint did not return JSON: ' + String(r.text).slice(0, 200), 'bad response');
        }
    } catch (e) {
        updateStatus('Decision model call failed');
        return fail(`decision model call failed (${e.message}).`, 'call failed');
    }

    // ---- parse answer ----
    const ans = data?.answers?.decision;
    if (!ans || ans.type !== 'choice' || ans.choice === undefined || ans.choice === null) {
        updateStatus('Unexpected decision response');
        return fail('unexpected response shape from decision endpoint: ' + JSON.stringify(data).slice(0, 300), 'bad response');
    }

    const chosenKey = String(ans.choice);
    const probs = ans.probabilities || {};
    const topProb = typeof probs[chosenKey] === 'number' ? probs[chosenKey] : null;
    const confidence = typeof ans.confidence === 'number' ? ans.confidence : topProb;
    const usedModel = data.model || '';

    const matched = options.find(o => o.key === chosenKey);
    if (!matched) {
        updateStatus('Decision model returned unknown option');
        return fail(`decision model returned "${chosenKey}", which is not one of the provided options.`, 'unknown option');
    }

    const probSummary = options
        .map(o => `${o.key}: ${typeof probs[o.key] === 'number' ? probs[o.key].toFixed(3) : 'n/a'}`)
        .join(', ');

    // ---- confidence gate ----
    if (cutoff > 0 && confidence !== null && confidence < cutoff) {
        updateStatus('Decision model: low confidence');
        return {
            output: `LOW_CONFIDENCE: decision model's top pick was "${chosenKey}" but confidence ${confidence.toFixed(3)} is below the cutoff ${cutoff}. `
                + `Probabilities - ${probSummary}. No decision was made; ask the user (e.g. with show_options) or gather more context.`,
            displayHtml: buildResultHTML(args.prompt, options, { status: 'low', chosen: chosenKey, probs, confidence, model: usedModel })
        };
    }

    updateStatus(`Decision model chose: ${chosenKey}`);
    return {
        output: `Decision model selected: ${chosenKey}`
            + (confidence !== null ? ` (confidence ${confidence.toFixed(3)})` : '')
            + `. Probabilities - ${probSummary}.`,
        displayHtml: buildResultHTML(args.prompt, options, { status: 'done', chosen: chosenKey, probs, confidence, model: usedModel })
    };
}