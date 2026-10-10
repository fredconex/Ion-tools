// show_options - presents choices and WAITS for the user to pick one.
const TOOL_META = {
    "name": "show_options",
    "description": "Presents 2-6 options to the user as clickable cards along with an optional text field for custom input, and WAITS for them to pick or enter one. Returns the value of the chosen option. Use plain text only (strictly NO emojis).",
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
                "description": "2-6 options to present. No emojis."
            }
        },
        "required": ["prompt", "options"]
    },
    "permission": "ask"
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
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function buildCardsHTML(promptText, options, selectedValue) {
    const btnBase = "all:unset;display:block;width:100%;box-sizing:border-box;"
        + "padding:6px 10px;margin:0;border-radius:6px;"
        + "background:rgba(255,255,255,.04);text-align:left;white-space:normal;line-height:1.35;";

    const isCustomChoice = selectedValue !== undefined && !options.some(opt => {
        const val = opt.value || opt.label;
        return val === selectedValue || opt.label === selectedValue;
    });

    const buttons = options.map((opt, i) => {
        const cleanLabel = removeEmojis(opt.label) || `Option ${i + 1}`;
        const cleanDesc = removeEmojis(opt.description);
        const value = opt.value || opt.label || `option_${i + 1}`;
        const label = esc(cleanLabel);
        const desc = cleanDesc
            ? `<span style="display:block;font-size:10.5px;opacity:.65;margin-top:2px;">${esc(cleanDesc)}</span>` : '';

        let stateStyle = "cursor:pointer;border:1px solid var(--border,#333);";
        if (selectedValue !== undefined) {
            if (!isCustomChoice && (value === selectedValue || opt.label === selectedValue)) {
                stateStyle = "cursor:default;border:1px solid var(--accent,var(--primary,#61afef));box-shadow:0 0 0 1px var(--accent,var(--primary,#61afef));background:rgba(255,255,255,.08);";
            } else {
                stateStyle = "cursor:default;border:1px solid var(--border,#333);opacity:0.35;";
            }
        }

        return `<button type="button" data-choice="${esc(value)}" style="${btnBase}${stateStyle}"><span style="display:block;font-size:12px;font-weight:600;">${label}</span>${desc}</button>`;
    }).join('');

    let otherFieldHtml = '';
    if (selectedValue === undefined) {
        // Scoped using relative DOM access instead of global IDs
        otherFieldHtml = `
        <div style="display:flex;gap:4px;margin-top:3px;">
            <input 
                type="text" 
                placeholder="Other (type your own)..." 
                style="flex:1;box-sizing:border-box;padding:5px 8px;border-radius:5px;border:1px solid var(--border,#333);background:rgba(255,255,255,.02);color:inherit;font-size:12px;outline:none;"
                oninput="this.nextElementSibling.setAttribute('data-choice', this.value.trim())"
                onkeydown="if(event.key==='Enter' && this.value.trim()){ event.preventDefault(); this.nextElementSibling.click(); }"
            />
            <button 
                type="button" 
                data-choice=""
                onclick="(function(btn){ var inp = btn.previousElementSibling; var val = inp ? inp.value.trim() : ''; if(val){ btn.setAttribute('data-choice', val); } else { event.preventDefault(); event.stopPropagation(); } })(this)"
                style="${btnBase}width:auto;padding:5px 14px;cursor:pointer;border:1px solid var(--border,#333);font-size:12px;font-weight:600;text-align:center;">
                Submit
            </button>
        </div>`;
    } else {
        if (isCustomChoice) {
            otherFieldHtml = `<div style="${btnBase}cursor:default;border:1px solid var(--accent,var(--primary,#61afef));box-shadow:0 0 0 1px var(--accent,var(--primary,#61afef));margin-top:3px;background:rgba(255,255,255,.08);"><span style="display:block;font-size:12px;font-weight:600;">Other: ${esc(selectedValue)}</span></div>`;
        } else {
            otherFieldHtml = `<div style="${btnBase}cursor:default;border:1px solid var(--border,#333);opacity:0.35;margin-top:3px;"><span style="font-size:12px;">Other</span></div>`;
        }
    }

    const cleanPrompt = removeEmojis(promptText) || "Please select an option:";
    return `<div class="choice-card" style="display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px solid var(--border,#2e2e2e);border-radius:8px;background:var(--bg-panel,#181818);margin:2px 0;white-space:normal;"><div style="font-size:12.5px;font-weight:600;color:var(--fg,#ececf1);margin:0 0 2px 0;">${esc(cleanPrompt)}</div>${buttons}${otherFieldHtml}</div>`;
}

async function handler(args, api) {
    const options = (args.options || []).slice(0, 6);
    if (options.length < 2) {
        return "ERROR: Provide at least 2 options.";
    }

    if (api?.setHeaderMsg) {
        api.setHeaderMsg("Awaiting user selection...");
    }

    // 1. Render interactive buttons and wait for user interaction
    const initialHtml = buildCardsHTML(args.prompt, options);
    const result = await api.showUI(initialHtml);

    if (result.cancelled) {
        return "User cancelled the selection without choosing.";
    }

    // 2. Build final rendered card with selected option highlighted
    const choice = removeEmojis(result.choice);
    const completedHtml = buildCardsHTML(args.prompt, options, choice);

    return {
        output: `User selected: ${choice}`,
        displayHtml: completedHtml,
        summary: `Selected: ${choice}`
    };
}