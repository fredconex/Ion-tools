// preview_html - tool definition for Ion / agent.html.
// - Uses api.validateDisplayHtml for pre-flight runtime console error trapping.
// - Uses api.showUI for rendering the interactive HTML preview artifact.
// - Returns full console errors, warnings, and HTML lint diagnostics to the model.
const TOOL_META = {
    "name": "preview_html",
    "description": "Renders an HTML file from the workspace in chat with live preview controls, source toggle, copy, and open-in-tab. Pre-flights execution to capture and report all console.error, console.warn, uncaught runtime errors, and HTML syntax issues back to the model.",
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
                "description": "Optional height for the preview box (e.g. '450px', '600px')."
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
            "key": "autoRun",
            "label": "Auto-Run Preview",
            "type": "boolean",
            "default": false,
            "description": "Automatically run the live preview without requiring an extra click on 'Show preview'."
        },
        {
            "key": "defaultHeight",
            "label": "Default Height",
            "type": "text",
            "default": "480px",
            "description": "Default height applied when not specified by the model."
        },
        {
            "key": "sandboxPolicy",
            "label": "Sandbox Policy",
            "type": "text",
            "default": "allow-scripts allow-forms allow-modals allow-popups",
            "description": "Security permissions granted to the iframe. 'allow-same-origin' and top-navigation tokens are always stripped for security."
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

// --- Static HTML/JS Linter ----------------------------------------------------

function lintHtmlForPreview(rawHtml) {
    const warnings = [];
    if (!/<!doctype html>/i.test(rawHtml)) {
        warnings.push('Missing <!DOCTYPE html> declaration.');
    }

    if (rawHtml.length > 500_000) {
        return warnings;
    }

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
        const unclosed = stack.slice(0, 4).map(s => `<${s.tag}> (line ${s.line})`).join(', ');
        warnings.push(`Unclosed tag${stack.length > 1 ? 's' : ''}: ${unclosed}${stack.length > 4 ? `, +${stack.length - 4} more` : ''}.`);
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
        return "ERROR: 'filepath' is required.";
    }

    if (await api.isBinary(args.filepath)) {
        return `ERROR: ${args.filepath} is a binary file and cannot be rendered as HTML.`;
    }

    const rawHtml = await api.readFile(args.filepath);
    if (rawHtml === undefined || rawHtml === null) {
        return `ERROR: File "${args.filepath}" not found in workspace.`;
    }

    const staticWarnings = lintHtmlForPreview(rawHtml);

    // In-memory storage shim (prevents SecurityError when sandbox blocks localStorage)
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

    // 1) Pre-flight Runtime Console Sniffer
    // Injected into an offscreen execution to capture console.error, console.warn, and unhandled runtime exceptions
    const runtimeSniffer = `<script>
(function() {
    var logs = [];
    var origError = console.error;
    var origWarn = console.warn;

    function formatArg(a) {
        try {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object' && a !== null) return JSON.stringify(a);
            return String(a);
        } catch(e) { return String(a); }
    }

    console.error = function() {
        var msg = Array.prototype.slice.call(arguments).map(formatArg).join(' ');
        logs.push('[console.error] ' + msg);
        if (origError) origError.apply(console, arguments);
    };

    console.warn = function() {
        var msg = Array.prototype.slice.call(arguments).map(formatArg).join(' ');
        logs.push('[console.warn] ' + msg);
        if (origWarn) origWarn.apply(console, arguments);
    };

    window.addEventListener('error', function(e) {
        var file = e.filename ? e.filename.split('/').pop() : '';
        var loc = file ? (' (' + file + ':' + e.lineno + ':' + e.colno + ')') : '';
        logs.push('[uncaught error] ' + (e.message || 'Script error') + loc);
    });

    window.addEventListener('unhandledrejection', function(e) {
        var reason = e.reason;
        var msg = reason ? (reason.stack || reason.message || String(reason)) : 'Promise rejected';
        logs.push('[unhandled rejection] ' + msg);
    });

    function sendReport() {
        if (logs.length > 0) {
            window.parent.postMessage({ __displayHtmlStatusErr: logs.join('\\n') }, '*');
        } else {
            window.parent.postMessage({ __displayHtmlStatusOk: true }, '*');
        }
    }

    if (document.readyState === 'complete') {
        setTimeout(sendReport, 150);
    } else {
        window.addEventListener('load', function() { setTimeout(sendReport, 150); });
        setTimeout(sendReport, 1200);
    }
})();
<\/script>`;

    let validationHtml = rawHtml;
    if (/<head[^>]*>/i.test(validationHtml)) {
        validationHtml = validationHtml.replace(/<head[^>]*>/i, match => match + '\n' + storageShim + '\n' + runtimeSniffer);
    } else {
        validationHtml = storageShim + '\n' + runtimeSniffer + '\n' + validationHtml;
    }

    const runtimeErrors = [];
    const runtimeWarnings = [];

    if (typeof api?.validateDisplayHtml === 'function') {
        const v = await api.validateDisplayHtml(validationHtml, { timeoutMs: 2500 });
        if (v && !v.ok && v.error) {
            const lines = v.error.split('\n');
            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;
                if (trimmed.startsWith('[console.warn]')) {
                    runtimeWarnings.push(trimmed);
                } else {
                    runtimeErrors.push(trimmed);
                }
            });
        }
    }

    // 2) Build Live Preview Document
    let liveHtml = rawHtml;
    if (/<head[^>]*>/i.test(liveHtml)) {
        liveHtml = liveHtml.replace(/<head[^>]*>/i, match => match + '\n' + storageShim);
    } else {
        liveHtml = storageShim + '\n' + liveHtml;
    }

    const autoRun = (await api.getSetting?.('autoRun')) !== false;
    const defaultHeight = sanitizeHeight(await api.getSetting?.('defaultHeight'), '480px');
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

    const escapedForStorage = liveHtml
        .replace(/&/g, '&amp;')
        .replace(/<\/textarea>/gi, '&lt;/textarea&gt;');

    const escapedSrcdoc = liveHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const totalIssues = runtimeErrors.length + runtimeWarnings.length + staticWarnings.length;
    const issueBadge = totalIssues > 0
        ? `<span style="font-size: 10px; color: var(--yellow, #e5c07b); background: rgba(229,192,123,0.15); padding: 1px 5px; border-radius: 4px; font-weight: 600;">${totalIssues} issue${totalIssues === 1 ? '' : 's'}</span>`
        : `<span style="font-size: 10px; color: var(--green, #98c379); opacity: 0.85;">clean</span>`;

    // 3) Artifact Card
    const displayHtml = `<div class="artifact-card" style="width: 100%; border: 1px solid var(--border, #2e2e2e); border-radius: 8px; overflow: hidden; background: var(--bg-panel, #181818); margin: 0; font-family: var(--font-mono, monospace); contain: content;">
    <!-- Top Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(0, 0, 0, 0.25); border-bottom: 1px solid var(--border, #2e2e2e);">
        <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--fg, #dcdfe7);">
            <span class="icon" style="font-size: 14px; color: var(--orange, #e5c07b);">html</span>
            <span style="font-weight: 600;" title="${safeFilepathAttr}">${safeTitleText}</span>
            <span style="font-size: 10px; color: var(--dim, #737791);">(${lineCount.toLocaleString()} lines)</span>
            ${issueBadge}
        </div>
        <div style="display: flex; align-items: center; gap: 3px;">
            <!-- 1. Play / Stop Toggle Button -->
            <button type="button" class="icon-btn artifact-play-btn" title="${autoRun ? 'Stop preview & view source' : 'Run live preview'}"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var warning = card.querySelector('.artifact-warning-pane');
                    var code = card.querySelector('.artifact-code-pane');
                    var ifr = card.querySelector('iframe');
                    var srcEl = card.querySelector('.artifact-raw-source');
                    var icon = btn.querySelector('.icon');
                    var isRunning = ifr && ifr.srcdoc && ifr.srcdoc.length > 0 && (!warning || warning.style.display === 'none') && code.style.display === 'none';

                    if (isRunning) {
                        ifr.srcdoc = '';
                        if (warning) warning.style.display = 'none';
                        code.style.display = 'block';
                        btn.title = 'Run live preview';
                        icon.textContent = 'play_arrow';
                    } else {
                        if (warning) warning.style.display = 'none';
                        code.style.display = 'none';
                        ifr.srcdoc = srcEl ? srcEl.value : '';
                        btn.title = 'Stop preview & view source';
                        icon.textContent = 'stop';
                    }
                })(this)">
                <span class="icon" style="font-size: 15px;">${autoRun ? 'stop' : 'play_arrow'}</span>
            </button>

            <!-- 2. Copy Source Button -->
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

        <!-- Security Warning Gate (Shown only if autoRun is false) -->
        ${autoRun ? '' : `<div class="artifact-warning-pane" style="position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--bg-panel, #181818); padding: 20px; box-sizing: border-box; text-align: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="width: 100%; max-width: 440px; font-size: 12.5px; line-height: 1.5; color: #a9adb8; text-align: center; margin: 0 auto 16px auto;">
                Previewing this file may trigger external network requests. Proceed only if this chat is not sensitive.
            </div>
            <div style="display: flex; gap: 8px; justify-content: center; align-items: center; width: 100%;">
                <button type="button" style="all: unset !important; box-sizing: border-box !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; height: 30px !important; padding: 0 14px !important; border-radius: 5px !important; font-size: 12px !important; font-weight: 500 !important; background: #2f333d !important; color: #f0f3f6 !important; border: 1px solid #444853 !important; cursor: pointer !important;"
                    onclick="(function(btn){
                        var card = btn.closest('.artifact-card');
                        var warning = card.querySelector('.artifact-warning-pane');
                        var code = card.querySelector('.artifact-code-pane');
                        var ifr = card.querySelector('iframe');
                        var srcEl = card.querySelector('.artifact-raw-source');
                        var playBtn = card.querySelector('.artifact-play-btn');

                        if (warning) warning.style.display = 'none';
                        if (code) code.style.display = 'none';
                        if (ifr) ifr.srcdoc = srcEl ? srcEl.value : '';
                        if (playBtn) {
                            playBtn.title = 'Stop preview & view source';
                            var icon = playBtn.querySelector('.icon');
                            if (icon) icon.textContent = 'stop';
                        }
                    })(this)">Show preview</button>
            </div>
        </div>`}

        <!-- Live Preview Pane -->
        <div class="artifact-preview-pane" style="width: 100%; height: 100%; background: #ffffff;">
            <iframe title="${safeTitleAttr}" srcdoc="${autoRun ? escapedSrcdoc : ''}" sandbox="${safeSandboxAttr}" style="width: 100%; height: 100%; border: none; display: block;"></iframe>
        </div>

        <!-- Code Block Pane -->
        <div class="artifact-code-pane" style="display: none; position: absolute; inset: 0; z-index: 4; overflow: auto; background: #141414; padding: 10px; box-sizing: border-box;">
            <pre style="margin: 0; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5; color: var(--fg, #dcdfe7); white-space: pre;"><code>${escapedCode}</code></pre>
        </div>
    </div>
</div>`;

    // 4) Render via showUI
    //await api.showUI(displayHtml);

    // 5) Build Comprehensive Diagnostic Output for Model Context
    let output = `Rendered ${args.filepath} (${lineCount} line${lineCount === 1 ? '' : 's'}) with live preview in chat.`;

    if (runtimeErrors.length > 0 || runtimeWarnings.length > 0 || staticWarnings.length > 0) {
        output += `\n\n⚠️ Issues Detected:`;

        if (runtimeErrors.length > 0) {
            output += `\nRuntime Console Errors (${runtimeErrors.length}):\n- ${runtimeErrors.slice(0, 10).join('\n- ')}`;
            if (runtimeErrors.length > 10) output += `\n- ... (+${runtimeErrors.length - 10} more)`;
        }

        if (runtimeWarnings.length > 0) {
            output += `\nConsole Warnings (${runtimeWarnings.length}):\n- ${runtimeWarnings.slice(0, 8).join('\n- ')}`;
            if (runtimeWarnings.length > 8) output += `\n- ... (+${runtimeWarnings.length - 8} more)`;
        }

        if (staticWarnings.length > 0) {
            output += `\nHTML Lint Warnings (${staticWarnings.length}):\n- ${staticWarnings.slice(0, 8).join('\n- ')}`;
            if (staticWarnings.length > 8) output += `\n- ... (+${staticWarnings.length - 8} more)`;
        }
    } else {
        output += `\nStatus: Clean — No console errors, runtime warnings, or HTML syntax issues detected.`;
    }

    return {output, displayHtml};
}