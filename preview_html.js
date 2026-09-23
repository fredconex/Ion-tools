// preview_html - tool definition.
const TOOL_META = {
    "name": "preview_html",
    "description": "Renders an HTML file from the workspace in chat with controls to Play/Stop the live preview, copy the source code, and open it in a new browser tab. The rendered preview is shown only in the chat UI; the model only sees a short summary plus any HTML validation warnings.",
    "parameters": {
        "type": "object",
        "properties": {
            "filepath": {
                "type": "string",
                "description": "Path to the HTML file in the workspace (e.g. 'index.html', 'dist/preview.html')."
            },
            "title": {
                "type": "string",
                "description": "Optional title or label for the preview frame."
            },
            "height": {
                "type": "string",
                "description": "Optional height for the preview box (e.g. '500px', '650px'). Defaults to 500px."
            }
        },
        "required": [
            "filepath"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1,
    "expanded": true,
    "settings": [
        {
            "key": "autoExpand",
            "label": "Expand by Default",
            "type": "boolean",
            "default": true,
            "description": "Automatically show the preview expanded in chat without needing to click to open."
        },
        {
            "key": "defaultHeight",
            "label": "Default Height",
            "type": "string",
            "default": "480px",
            "description": "Default height applied when not specified by the model."
        },
        {
            "key": "sandboxPolicy",
            "label": "Sandbox Policy",
            "type": "string",
            "default": "allow-scripts allow-forms allow-modals allow-popups",
            "description": "Security permissions granted to the iframe. Tokens 'allow-same-origin', 'allow-top-navigation(-by-user-activation)', and 'allow-popups-to-escape-sandbox' are always stripped, regardless of this setting."
        }
    ]
};

// --- Sandbox hardening helpers ------------------------------------------------

const FORBIDDEN_SANDBOX_TOKENS = new Set([
    'allow-same-origin',
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-popups-to-escape-sandbox'
]);

const DEFAULT_SANDBOX_POLICY = 'allow-scripts allow-forms allow-modals allow-popups';

function sanitizeSandboxPolicy(raw) {
    const s = (typeof raw === 'string' && raw.trim()) ? raw : DEFAULT_SANDBOX_POLICY;
    const tokens = s.split(/\s+/).filter(t => t && !FORBIDDEN_SANDBOX_TOKENS.has(t.toLowerCase()));
    return tokens.length ? tokens.join(' ') : 'allow-scripts';
}

function sanitizeHeight(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    const s = raw.trim();
    if (!s) return fallback;
    if (/^\d+(\.\d+)?(px|em|rem|vh|vw|vmin|vmax|%|pt|pc|cm|mm|in|ch|ex)?$/i.test(s)) return s;
    if (/^calc\(\s*[-+*/().%\d\sa-z]+\s*\)$/i.test(s)) return s;
    return fallback;
}

function escapeHTMLText(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function escapeHTMLAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// --- High-Performance HTML/JS lint --------------------------------------------
function lintHtmlForPreview(rawHtml) {
    const warnings = [];
    if (!/<!doctype html>/i.test(rawHtml)) {
        warnings.push('Missing <!DOCTYPE html> declaration.');
    }

    // Skip deep AST-style linting for very large files (>500KB) to keep execution instant
    if (rawHtml.length > 500_000) {
        return warnings;
    }

    // Precompute line offsets for O(log N) line lookups instead of O(N) string slicing
    const lineOffsets = [0];
    for (let i = 0; i < rawHtml.length; i++) {
        if (rawHtml.charCodeAt(i) === 10) lineOffsets.push(i + 1);
    }
    const lineOf = (idx) => {
        let low = 0, high = lineOffsets.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (lineOffsets[mid] <= idx) low = mid + 1;
            else high = mid - 1;
        }
        return low;
    };

    const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const scrubbed = rawHtml
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

    const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
    const stack = [];
    let match;

    while ((match = tagPattern.exec(scrubbed))) {
        const tagName = match[1].toLowerCase();
        const isClosing = match[0][1] === '/';
        const isSelfClosing = match[2] === '/' || VOID_TAGS.has(tagName);
        if (isClosing) {
            if (stack.length && stack[stack.length - 1].tag === tagName) {
                stack.pop();
            } else {
                const openIdx = [...stack].reverse().findIndex(s => s.tag === tagName);
                if (openIdx === -1) {
                    warnings.push(`Closing tag </${tagName}> with no matching open tag near line ${lineOf(match.index)}.`);
                } else {
                    const removed = stack.splice(stack.length - 1 - openIdx);
                    warnings.push(`Tag <${removed[removed.length - 1].tag}> (line ${removed[removed.length - 1].line}) closed out of order near line ${lineOf(match.index)}.`);
                }
            }
        } else if (!isSelfClosing) {
            stack.push({ tag: tagName, line: lineOf(match.index) });
        }
    }

    if (stack.length) {
        const unclosed = stack.slice(0, 5).map(s => `<${s.tag}> (line ${s.line})`).join(', ');
        warnings.push(`Unclosed tag${stack.length > 1 ? 's' : ''}: ${unclosed}${stack.length > 5 ? `, +${stack.length - 5} more` : ''}.`);
    }

    const ids = new Map();
    const idPattern = /\sid=["']([^"']+)["']/g;
    while ((match = idPattern.exec(rawHtml))) {
        ids.set(match[1], (ids.get(match[1]) || 0) + 1);
    }
    const dupes = [...ids.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    if (dupes.length) {
        warnings.push(`Duplicate id attribute${dupes.length > 1 ? 's' : ''}: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? ', ...' : ''}.`);
    }

    const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let scriptIdx = 0;
    while ((match = scriptPattern.exec(rawHtml))) {
        scriptIdx++;
        const attrs = match[1] || '';
        if (/\bsrc\s*=/.test(attrs)) continue;
        if (/type\s*=\s*["'](?!text\/javascript|module|application\/javascript)[^"']*["']/i.test(attrs)) continue;
        const body = match[2];
        if (!body.trim() || body.length > 100_000) continue;
        try {
            new Function(body);
        } catch (e) {
            warnings.push(`JS syntax error in inline <script> #${scriptIdx}: ${e.message}.`);
        }
    }

    return warnings;
}

async function handler(args, api) {
    if (!args.filepath) {
        return { output: "ERROR: 'filepath' is required." };
    }

    if (await api.isBinary(args.filepath)) {
        return { output: `ERROR: ${args.filepath} is a binary file and cannot be rendered as HTML.` };
    }

    const rawHtml = await api.readFile(args.filepath);
    if (rawHtml === undefined || rawHtml === null) {
        return { output: `ERROR: File "${args.filepath}" not found in workspace.` };
    }

    const warnings = lintHtmlForPreview(rawHtml);

    // In-memory storage shim
    const storageShim = `<script>
(function(){
    try { localStorage.getItem('x'); return; } catch(e) {}
    var mem = Object.create(null);
    var fake = {
        getItem: function(k){ return mem[k] ?? null; },
        setItem: function(k,v){ mem[k] = String(v); },
        removeItem: function(k){ delete mem[k]; },
        clear: function(){ for (var k in mem) delete mem[k]; },
        key: function(i){ return Object.keys(mem)[i] || null; },
        get length(){ return Object.keys(mem).length; }
    };
    try {
        Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
        Object.defineProperty(window, 'sessionStorage', { value: fake, configurable: true });
    } catch(e) {}
})();
<\/script>`;

    let finalHtml = rawHtml;
    if (/<head[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/<head[^>]*>/i, match => match + '\n' + storageShim);
    } else {
        finalHtml = storageShim + '\n' + finalHtml;
    }

    const defaultHeight = sanitizeHeight(await api.getSetting?.('defaultHeight'), '500px');
    const sandboxPolicy = sanitizeSandboxPolicy(await api.getSetting?.('sandboxPolicy'));

    const height = sanitizeHeight(args.height, defaultHeight);
    const title  = (typeof args.title === 'string' && args.title) ? args.title : args.filepath;

    const safeTitleAttr    = escapeHTMLAttr(title);
    const safeTitleText    = escapeHTMLText(title);
    const safeFilepathAttr = escapeHTMLAttr(args.filepath);
    const safeHeightAttr   = escapeHTMLAttr(height);
    const safeSandboxAttr  = escapeHTMLAttr(sandboxPolicy);

    const allLines = rawHtml.split('\n');
    const lineCount = allLines.length;

    // PERFORMANCE FIX: Cap the visible code block to 500 lines to prevent DOM lockup
    const MAX_CODE_LINES = 500;
    let codeForDisplay = rawHtml;
    if (lineCount > MAX_CODE_LINES) {
        codeForDisplay = allLines.slice(0, MAX_CODE_LINES).join('\n') +
            `\n\n/* ... [Truncated for display performance: showing 500 of ${lineCount.toLocaleString()} lines. Click 'Copy source' for full file] ... */`;
    }

    const escapedCode = codeForDisplay
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const escapedForStorage = finalHtml
        .replace(/&/g, '&amp;')
        .replace(/<\/textarea>/gi, '&lt;/textarea&gt;');

    // CSS containment isolates layout/render cycles from the chat thread
    const displayHtml = `<div class="artifact-card" style="width: 100%; border: 1px solid var(--border, #2e2e2e); border-radius: 8px; overflow: hidden; background: var(--bg-panel, #181818); margin: 6px 0; font-family: var(--font-mono, monospace); contain: content; content-visibility: auto; contain-intrinsic-size: ${safeHeightAttr};">
    <!-- Top Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(0, 0, 0, 0.25); border-bottom: 1px solid var(--border, #2e2e2e);">
        <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--fg, #dcdfe7);">
            <span class="icon" style="font-size: 14px; color: var(--orange, #e5c07b);">html</span>
            <span style="font-weight: 600;" title="${safeFilepathAttr}">${safeTitleText}</span>
            <span style="font-size: 10px; color: var(--dim, #737791);">(${lineCount.toLocaleString()} lines)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
            <!-- 1. Play / Stop Toggle Button -->
            <button type="button" class="icon-btn artifact-play-btn" title="Run live preview"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var warning = card.querySelector('.artifact-warning-pane');
                    var code = card.querySelector('.artifact-code-pane');
                    var ifr = card.querySelector('iframe');
                    var srcEl = card.querySelector('.artifact-raw-source');
                    var icon = btn.querySelector('.icon');
                    var isRunning = ifr && ifr.srcdoc && ifr.srcdoc.length > 0 && warning.style.display === 'none' && code.style.display === 'none';

                    if (isRunning) {
                        ifr.srcdoc = '';
                        warning.style.display = 'none';
                        code.style.display = 'block';
                        btn.title = 'Run live preview';
                        icon.textContent = 'play_arrow';
                    } else {
                        ifr.onload = function(){
                            warning.style.display = 'none';
                            code.style.display = 'none';
                            ifr.onload = null;
                        };
                        ifr.srcdoc = srcEl ? srcEl.value : '';
                        btn.title = 'Stop preview & view source';
                        icon.textContent = 'stop';
                    }
                })(this)">
                <span class="icon" style="font-size: 15px; font-variation-settings: 'FILL' 1;">play_arrow</span>
            </button>

            <!-- 2. Copy Source Button (Always copies 100% of the original content) -->
            <button type="button" class="icon-btn" title="Copy source"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var srcEl = card.querySelector('.artifact-raw-source');
                    if (!srcEl) return;
                    navigator.clipboard.writeText(srcEl.value).then(function(){
                        var icon = btn.querySelector('.icon');
                        var orig = icon.textContent;
                        icon.textContent = 'check';
                        icon.style.color = 'var(--green, #98c379)';
                        setTimeout(function(){
                            icon.textContent = orig;
                            icon.style.color = '';
                        }, 1500);
                    });
                })(this)">
                <span class="icon" style="font-size: 14px;">content_copy</span>
            </button>

            <!-- 3. Open in New Browser Tab Button -->
            <button type="button" class="icon-btn" title="Open in new browser tab"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var srcEl = card.querySelector('.artifact-raw-source');
                    var ifr = card.querySelector('iframe');
                    if (!srcEl) return;
                    var htmlContent = srcEl.value;
                    var policy = (ifr && ifr.getAttribute('sandbox')) || 'allow-scripts';
                    var w = window.open('about:blank', '_blank');
                    if (!w) return;
                    try { w.opener = null; } catch(e) {}
                    var d = w.document;
                    d.open();
                    d.write('<!DOCTYPE html><html><head><title>Preview</title></head><body></body></html>');
                    d.close();
                    d.body.style.margin = '0';
                    d.body.style.height = '100vh';
                    d.body.style.overflow = 'hidden';
                    d.body.style.background = '#ffffff';
                    var popupIframe = d.createElement('iframe');
                    popupIframe.setAttribute('sandbox', policy);
                    popupIframe.style.width = '100%';
                    popupIframe.style.height = '100%';
                    popupIframe.style.border = '0';
                    popupIframe.style.display = 'block';
                    popupIframe.srcdoc = htmlContent;
                    d.body.appendChild(popupIframe);
                })(this)">
                <span class="icon" style="font-size: 14px;">open_in_new</span>
            </button>
        </div>
    </div>

    <!-- Main Content Container -->
    <div style="position: relative; width: 100%; height: ${safeHeightAttr}; background: var(--bg-panel, #181818);">
        <!-- Exact Fidelity Source Storage -->
        <textarea class="artifact-raw-source" style="display: none;" aria-hidden="true">${escapedForStorage}</textarea>

        <!-- Security Warning Gate (Overlay) -->
        <div class="artifact-warning-pane" style="position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--bg-panel, #181818); padding: 20px; box-sizing: border-box; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="width: 100%; max-width: 440px; font-size: 12.5px; line-height: 1.5; color: #a9adb8; text-align: center; margin: 0 auto 16px auto;">
                Previewing this file may trigger external network requests. Proceed only if this chat is not sensitive.
            </div>
            <div style="display: flex; gap: 8px; justify-content: center; align-items: center; width: 100%;">
                <button type="button" style="all: unset !important; box-sizing: border-box !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; height: 30px !important; min-height: 30px !important; max-height: 30px !important; padding: 0 14px !important; border-radius: 5px !important; font-size: 12px !important; font-weight: 500 !important; line-height: 30px !important; text-align: center !important; vertical-align: middle !important; background: #2f333d !important; color: #f0f3f6 !important; border: 1px solid #444853 !important; cursor: pointer !important; flex: 0 0 auto !important; margin: 0 !important; transition: background 0.12s;"
                    onmouseover="this.style.background='#3b404d'" onmouseout="this.style.background='#2f333d'"
                    onclick="(function(btn){
                        var card = btn.closest('.artifact-card');
                        var warning = card.querySelector('.artifact-warning-pane');
                        var code = card.querySelector('.artifact-code-pane');
                        var ifr = card.querySelector('iframe');
                        var srcEl = card.querySelector('.artifact-raw-source');
                        var playBtn = card.querySelector('.artifact-play-btn');

                        ifr.onload = function() {
                            warning.style.display = 'none';
                            code.style.display = 'none';
                            ifr.onload = null;
                        };
                        ifr.srcdoc = srcEl ? srcEl.value : '';

                        setTimeout(function(){
                            warning.style.display = 'none';
                            code.style.display = 'none';
                        }, 250);

                        if (playBtn) {
                            playBtn.title = 'Stop preview & view source';
                            var icon = playBtn.querySelector('.icon');
                            if (icon) icon.textContent = 'stop';
                        }
                    })(this)"><span style="display: block; line-height: 1; text-align: center;">Show preview</span></button>
                <button type="button" style="all: unset !important; box-sizing: border-box !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; height: 30px !important; min-height: 30px !important; max-height: 30px !important; padding: 0 14px !important; border-radius: 5px !important; font-size: 12px !important; font-weight: 500 !important; line-height: 30px !important; text-align: center !important; vertical-align: middle !important; background: transparent !important; color: #9da5b4 !important; border: 1px solid #363a45 !important; cursor: pointer !important; flex: 0 0 auto !important; margin: 0 !important; transition: background 0.12s, color 0.12s;"
                    onmouseover="this.style.background='rgba(255,255,255,0.06)'; this.style.color='#dcdfe7';" onmouseout="this.style.background='transparent'; this.style.color='#9da5b4';"
                    onclick="(function(btn){
                        var card = btn.closest('.artifact-card');
                        var warning = card.querySelector('.artifact-warning-pane');
                        var code = card.querySelector('.artifact-code-pane');
                        var playBtn = card.querySelector('.artifact-play-btn');

                        warning.style.display = 'none';
                        code.style.display = 'block';

                        if (playBtn) {
                            playBtn.title = 'Run live preview';
                            var icon = playBtn.querySelector('.icon');
                            if (icon) icon.textContent = 'play_arrow';
                        }
                    })(this)"><span style="display: block; line-height: 1; text-align: center;">Cancel</span></button>
            </div>
        </div>

        <!-- Live Preview Pane -->
        <div class="artifact-preview-pane" style="width: 100%; height: 100%; background: var(--bg-panel, #181818);">
            <iframe title="${safeTitleAttr}" srcdoc="" sandbox="${safeSandboxAttr}" style="width: 100%; height: 100%; border: none; display: block;" loading="lazy"></iframe>
        </div>

        <!-- Code Block Pane (Containment added to avoid global reflows) -->
        <div class="artifact-code-pane" style="display: none; position: absolute; inset: 0; z-index: 4; overflow: auto; background: #141414; padding: 10px; box-sizing: border-box; contain: strict;">
            <pre style="margin: 0; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; color: var(--fg, #dcdfe7); white-space: pre;"><code>${escapedCode}</code></pre>
        </div>
    </div>
</div>`;

    let output = `Rendered ${args.filepath} (${lineCount} line${lineCount === 1 ? '' : 's'}). Preview is shown in the chat UI above and is not included in this result.`;
    if (warnings.length) {
        output += `\nWarnings:\n- ${warnings.slice(0, 10).join('\n- ')}`;
        if (warnings.length > 10) output += `\n- +${warnings.length - 10} more`;
    }

    return { output, displayHtml };
}