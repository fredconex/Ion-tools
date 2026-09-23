// show_options - presents choices and WAITS for the user to pick one.
const TOOL_META = {
    "name": "show_options",
    "description": "Presents 2-4 options to the user as clickable cards and WAITS for them to pick one. Returns the value of the chosen option. Use plain text only (strictly NO emojis).",
    "interactive": true,
    "toolBox": 1,
    "expanded": true,
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": { 
                "type": "string", 
                "description": "Question to ask the user. Plain text only, no emojis." 
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
                        "value": { "type": "string" },
                        "description": { 
                            "type": "string", 
                            "description": "Short explanation. Plain text only, do NOT use emojis or icons." 
                        }
                    },
                    "required": ["label", "value"]
                },
                "description": "2-4 options to present. No emojis."
            }
        },
        "required": ["prompt", "options"]
    },
    "permission": "always"
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

function buildCardsHTML(promptText, options, selectedValue) {
    const btnBase = "all:unset;display:block;width:100%;box-sizing:border-box;"
        + "padding:5px 10px;margin:0;border-radius:5px;"
        + "background:rgba(255,255,255,.04);text-align:left;white-space:normal;line-height:1.3;";

    const buttons = options.map((opt, i) => {
        const cleanLabel = removeEmojis(opt.label) || `Option ${i + 1}`;
        const cleanDesc = removeEmojis(opt.description);
        const value = esc(opt.value || opt.label || `option_${i + 1}`);
        const label = esc(cleanLabel);
        const desc = cleanDesc
            ? `<span style="display:block;font-size:10.5px;opacity:.65;margin-top:1px;">${esc(cleanDesc)}</span>` : '';

        // Determine styling based on whether an option was chosen
        let stateStyle = "cursor:pointer;border:1px solid var(--border,#333);";
        if (selectedValue !== undefined) {
            if (value === selectedValue || opt.label === selectedValue || opt.value === selectedValue) {
                stateStyle = "cursor:default;border:1px solid var(--accent,#61afef);box-shadow:0 0 0 1px var(--accent,#61afef);";
            } else {
                stateStyle = "cursor:default;border:1px solid var(--border,#333);opacity:0.35;";
            }
        }

        return `<button type="button" data-choice="${value}" style="${btnBase}${stateStyle}"><span style="display:block;font-size:12px;font-weight:600;">${label}</span>${desc}</button>`;
    }).join('');

    const cleanPrompt = removeEmojis(promptText) || "Please select an option:";
    return `<div class="choice-card" style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--border,#2e2e2e);border-radius:6px;background:var(--bg-panel,#181818);margin:2px 0;white-space:normal;"><div style="font-size:12.5px;font-weight:500;margin:0 0 2px 0;">${esc(cleanPrompt)}</div>${buttons}</div>`;
}

async function handler(args, api) {
    const options = (args.options || []).slice(0, 4);
    if (options.length < 2) return "ERROR: provide at least 2 options.";

    // 1. Render interactive clickable buttons
    const initialHtml = buildCardsHTML(args.prompt, options);
    const result = await api.showUI(initialHtml);

    if (result.cancelled) {
        return "User cancelled the selection without choosing.";
    }

    // 2. Build the completed display with selected item highlighted and others faint
    const completedHtml = buildCardsHTML(args.prompt, options, result.choice);

    return {
        output: `User selected: ${result.choice}`,
        displayHtml: completedHtml
    };
}