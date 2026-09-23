// preview_mermaid - tool definition.
// Uses the { output, displayHtml } return contract:
//   - output:      clean Mermaid syntax preserved for model context and follow-up edits.
//   - displayHtml: interactive UI rendered in chat (never added to context).
const TOOL_META = {
    "name": "preview_mermaid",
    "description": "Renders Mermaid diagram syntax directly in chat with infinite-resolution vector zoom, cursor-centered panning, auto-fitting, and view-source toggle. The interactive preview is rendered in the chat UI, while the Mermaid code is preserved in context.",
    "parameters": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The raw Mermaid diagram syntax."
            },
            "title": {
                "type": "string",
                "description": "Optional title for the diagram."
            },
            "height": {
                "type": "string",
                "description": "Optional height for the preview frame (default: '480px')."
            }
        },
        "required": [
            "code"
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
            "key": "defaultHeight",
            "label": "Default Height",
            "type": "string",
            "default": "480px",
            "description": "Default height applied when not specified by the model."
        }
    ]
};

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

async function handler(args, api) {
    if (!args.code || typeof args.code !== 'string') {
        return { output: "ERROR: 'code' is required." };
    }

    const cleanSyntax = args.code
        .replace(/^```(?:mermaid)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    if (!cleanSyntax) {
        return { output: "ERROR: Mermaid code cannot be empty." };
    }

    const defaultHeight = sanitizeHeight(await api.getSetting?.('defaultHeight'), '480px');
    const height = sanitizeHeight(args.height, defaultHeight);
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : 'Diagram';

    const safeTitleAttr = escapeHTMLAttr(title);
    const safeTitleText = escapeHTMLText(title);
    const safeHeightAttr = escapeHTMLAttr(height);

    // Encode diagram safely via base64
    const b64Syntax = btoa(unescape(encodeURIComponent(cleanSyntax)));

    const iframeHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
    <style>
        * { box-sizing: border-box; }
        html, body {
            margin: 0; padding: 0; width: 100%; height: 100%;
            background: #141414; overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #dcdfe7; user-select: none;
        }
        #viewport {
            width: 100%; height: 100%; position: relative;
            overflow: hidden; cursor: grab;
            background: #141414;
        }
        #viewport.dragging { cursor: grabbing; }
        #output {
            width: 100%; height: 100%;
        }
        /* Floating zoom bar bottom-right */
        .zoom-bar {
            position: absolute; bottom: 12px; right: 12px;
            display: flex; align-items: center; gap: 2px;
            background: rgba(24, 24, 24, 0.88);
            border: 1px solid #2e2e2e; border-radius: 6px;
            padding: 3px; backdrop-filter: blur(4px); z-index: 10;
        }
        .zoom-btn {
            background: transparent; border: none; color: #737791;
            font-family: inherit; font-size: 11px; font-weight: 600;
            padding: 3px 8px; border-radius: 4px; cursor: pointer;
            transition: all 0.12s ease;
        }
        .zoom-btn:hover { background: #262626; color: #dcdfe7; }
        .error-card {
            background: rgba(224, 108, 117, 0.08);
            border: 1px solid rgba(224, 108, 117, 0.35);
            border-radius: 8px; padding: 16px; margin: 20px;
            font-family: monospace; font-size: 12px; line-height: 1.5; color: #e06c75;
            white-space: pre-wrap; word-break: break-word;
        }
    </style>
</head>
<body>
    <div id="viewport">
        <div id="output"></div>

        <div class="zoom-bar">
            <button type="button" class="zoom-btn" id="btn-zoom-in" title="Zoom in">+</button>
            <button type="button" class="zoom-btn" id="btn-zoom-reset" title="Fit to screen">Fit</button>
            <button type="button" class="zoom-btn" id="btn-zoom-out" title="Zoom out">-</button>
        </div>
    </div>

    <script>
        const rawCode = decodeURIComponent(escape(atob("${b64Syntax}")));
        mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'loose',
            themeVariables: {
                darkmode: true,
                background: '#141414',
                primaryColor: '#1e293b',
                primaryTextColor: '#dcdfe7',
                primaryBorderColor: '#38bdf8',
                lineColor: '#737791'
            }
        });

        let scale = 1;
        let panX = 0;
        let panY = 0;
        let origW = 100;
        let origH = 100;
        let isDragging = false;
        let startX = 0;
        let startY = 0;

        const viewport = document.getElementById('viewport');
        const output = document.getElementById('output');
        let panGroup = null;
        let svgElement = null;

        function updateTransform() {
            if (!panGroup) return;
            // Native SVG vector transform (infinite resolution, never blurry)
            panGroup.setAttribute('transform', 'translate(' + panX + ', ' + panY + ') scale(' + scale + ')');
        }

        function autoFit() {
            if (!svgElement) return;
            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            if (vw === 0 || vh === 0) return;

            // Fit diagram, capping at 1.0 so small diagrams are not blown up
            const pad = 60;
            const fitScale = Math.min((vw - pad) / origW, (vh - pad) / origH);
            scale = Math.min(1.0, Math.max(0.15, fitScale));

            panX = Math.round((vw - origW * scale) / 2);
            panY = Math.round((vh - origH * scale) / 2);

            svgElement.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
            updateTransform();
        }

        // Mouse Drag Panning
        viewport.addEventListener('mousedown', (e) => {
            if (e.target.closest('.zoom-bar')) return;
            isDragging = true;
            viewport.classList.add('dragging');
            startX = e.clientX - panX;
            startY = e.clientY - panY;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panX = e.clientX - startX;
            panY = e.clientY - startY;
            updateTransform();
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
            viewport.classList.remove('dragging');
        });

        // Crisp Vector Cursor-Centered Zoom
        viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!panGroup) return;

            const rect = viewport.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const factor = e.deltaY < 0 ? 1.15 : 0.87;
            const newScale = Math.max(0.1, Math.min(6.0, scale * factor));
            if (newScale === scale) return;

            // Anchor point under cursor
            panX = cx - (cx - panX) * (newScale / scale);
            panY = cy - (cy - panY) * (newScale / scale);
            scale = newScale;

            updateTransform();
        }, { passive: false });

        // Center zoom helpers for + / - buttons
        function zoomCenter(factor) {
            const cx = viewport.clientWidth / 2;
            const cy = viewport.clientHeight / 2;
            const newScale = Math.max(0.1, Math.min(6.0, scale * factor));
            panX = cx - (cx - panX) * (newScale / scale);
            panY = cy - (cy - panY) * (newScale / scale);
            scale = newScale;
            updateTransform();
        }

        document.getElementById('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
        document.getElementById('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
        document.getElementById('btn-zoom-reset').addEventListener('click', autoFit);

        async function renderDiagram() {
            try {
                const uniqueId = 'mm_' + Math.random().toString(36).substring(2, 9);
                const { svg } = await mermaid.render(uniqueId, rawCode);
                output.innerHTML = svg;

                svgElement = output.querySelector('svg');
                if (!svgElement) return;

                // Read natural diagram bounds from viewBox
                const vb = svgElement.getAttribute('viewBox');
                if (vb) {
                    const parts = vb.split(' ').map(Number);
                    origW = parts[2] || 500;
                    origH = parts[3] || 300;
                }

                // Make SVG fill the entire viewport canvas
                svgElement.style.width = '100%';
                svgElement.style.height = '100%';
                svgElement.style.display = 'block';
                svgElement.removeAttribute('style');
                svgElement.style.width = '100%';
                svgElement.style.height = '100%';

                // Wrap graphic nodes into an SVG <g> vector group (leaves <defs>/<style> intact)
                panGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                panGroup.id = 'pan-group';

                const nodesToMove = [];
                for (let i = 0; i < svgElement.childNodes.length; i++) {
                    const node = svgElement.childNodes[i];
                    if (node.nodeName !== 'style' && node.nodeName !== 'defs') {
                        nodesToMove.push(node);
                    }
                }
                nodesToMove.forEach(node => panGroup.appendChild(node));
                svgElement.appendChild(panGroup);

                requestAnimationFrame(autoFit);
            } catch (err) {
                output.innerHTML = '<div class="error-card">⚠️ Mermaid Syntax Error<br><br>' +
                    (err.message || String(err)).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                    '</div>';
            }
        }
        renderDiagram();
    <\/script>
</body>
</html>`;

    const escapedSrcdoc = iframeHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedCode = cleanSyntax.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lineCount = cleanSyntax.split('\n').length;

    const displayHtml = `<div class="artifact-card" style="width: 100%; border: 1px solid var(--border, #2e2e2e); border-radius: 8px; overflow: hidden; background: var(--bg-panel, #161616); margin: 6px 0; font-family: var(--font-mono, monospace);">
    <!-- Top Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: rgba(0, 0, 0, 0.25); border-bottom: 1px solid var(--border, #2e2e2e);">
        <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--fg, #dcdfe7);">
            <span class="icon" style="font-size: 14px; color: var(--cyan, #56b6c2);">schema</span>
            <span style="font-weight: 600;">${safeTitleText}</span>
            <span style="font-size: 10px; color: var(--dim, #737791);">(${lineCount} lines)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 3px;">
            <!-- Toggle Diagram / Code View Button -->
            <button type="button" class="icon-btn" title="Toggle diagram / source code"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var preview = card.querySelector('.artifact-preview-pane');
                    var code = card.querySelector('.artifact-code-pane');
                    var isPreview = preview.style.display !== 'none';
                    preview.style.display = isPreview ? 'none' : 'block';
                    code.style.display = isPreview ? 'block' : 'none';
                    btn.querySelector('.icon').style.color = isPreview ? 'var(--cyan, #56b6c2)' : '';
                })(this)">
                <span class="icon" style="font-size: 14px;">code</span>
            </button>

            <!-- Copy Syntax Button -->
            <button type="button" class="icon-btn" title="Copy Mermaid syntax"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var code = card.querySelector('.artifact-code-pane code');
                    if (!code) return;
                    navigator.clipboard.writeText(code.textContent).then(function(){
                        var icon = btn.querySelector('.icon');
                        var orig = icon.textContent;
                        icon.textContent = 'check';
                        icon.style.color = 'var(--green, #98c379)';
                        setTimeout(function(){ icon.textContent = orig; icon.style.color = ''; }, 1500);
                    });
                })(this)">
                <span class="icon" style="font-size: 14px;">content_copy</span>
            </button>

            <!-- Open in New Tab Button -->
            <button type="button" class="icon-btn" title="Open in new browser tab"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var ifr = card.querySelector('iframe');
                    var src = ifr.getAttribute('srcdoc');
                    var w = window.open('about:blank', '_blank');
                    if (w && src) {
                        w.document.open();
                        w.document.write(src);
                        w.document.close();
                    }
                })(this)">
                <span class="icon" style="font-size: 14px;">open_in_new</span>
            </button>
        </div>
    </div>

    <!-- Live Mermaid Diagram Pane (Crisp Vector Pan & Zoom) -->
    <div class="artifact-preview-pane" style="width: 100%; height: ${safeHeightAttr}; background: #141414;">
        <iframe title="${safeTitleAttr}" srcdoc="${escapedSrcdoc}" sandbox="allow-scripts" style="width: 100%; height: 100%; border: none; display: block;" loading="lazy"></iframe>
    </div>

    <!-- Code Block Pane -->
    <div class="artifact-code-pane" style="display: none; width: 100%; height: ${safeHeightAttr}; overflow: auto; background: #141414; padding: 12px; box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #2e2e2e transparent;">
        <pre style="margin: 0; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; color: var(--fg, #dcdfe7); white-space: pre;"><code>${escapedCode}</code></pre>
    </div>
</div>`;

    // Preserves the clean Mermaid syntax in context so the model can easily inspect or modify it later
    const output = `Rendered Mermaid diagram "${title}":\n\n\`\`\`mermaid\n${cleanSyntax}\n\`\`\``;

    return { output, displayHtml };
}