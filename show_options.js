// show_options - presents choices and WAITS for the user to pick one.
const TOOL_META = {
    "name": "show_options",
    "description": "Presents 2-4 options to the user as clickable cards and WAITS for them to pick one. Returns the value of the chosen option. Use plain text only (strictly NO emojis).",
    "interactive": true,
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
    }
};

// Strips emojis, pictographs, symbols, and extra dangling spaces
function removeEmojis(str) {
    if (!str) return '';
    return String(str)
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/[\uFE0E\uFE0F]/g, '') // Variation selectors
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function handler(args, api) {
    const options = (args.options || []).slice(0, 4);
    if (options.length < 2) return "ERROR: provide at least 2 options.";

    const btnStyle = "all:unset;cursor:pointer;display:block;width:100%;box-sizing:border-box;"
        + "padding:5px 10px;margin:0;border:1px solid var(--border,#333);border-radius:5px;"
        + "background:rgba(255,255,255,.04);text-align:left;white-space:normal;line-height:1.3;";

    const buttons = options.map((opt, i) => {
        // Strip emojis and escape HTML
        const cleanLabel = removeEmojis(opt.label) || `Option ${i + 1}`;
        const cleanDesc = removeEmojis(opt.description);
        const value = esc(opt.value || opt.label || `option_${i + 1}`);

        const label = esc(cleanLabel);
        const desc = cleanDesc
            ? `<span style="display:block;font-size:10.5px;opacity:.65;margin-top:1px;">${esc(cleanDesc)}</span>` : '';
            
        return `<button type="button" data-choice="${value}" style="${btnStyle}"><span style="display:block;font-size:12px;font-weight:600;">${label}</span>${desc}</button>`;
    }).join('');

    const cleanPrompt = removeEmojis(args.prompt) || "Please select an option:";
    const html = `<div class="choice-card" style="display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--border,#2e2e2e);border-radius:6px;background:var(--bg-panel,#181818);margin:2px 0;white-space:normal;"><div style="font-size:12.5px;font-weight:500;margin:0 0 2px 0;">${esc(cleanPrompt)}</div>${buttons}</div>`;

    const result = await api.showUI(html);

    if (result.cancelled) return "User cancelled the selection without choosing.";
    return `User selected: ${result.choice}`;
}