// preview_mermaid - tool definition for Ion / agent.html.
// - Uses mermaid.parse for pre-flight syntax verification.
// - Uses api.showUI for rendering the interactive vector diagram.
// - Uses geometry-ready rendering so text labels are never measured as 0px.
// - Respects defaultHeight configured in Settings > Tools.
const TOOL_META = {
    "name": "preview_mermaid",
    "description": "Renders Mermaid diagram syntax directly in chat with infinite-resolution vector zoom, cursor-centered panning, auto-fitting, and view-source toggle. Pre-validates diagram rendering and presents an interactive preview while preserving Mermaid code in context.",
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
                "description": "Optional height for the preview frame (e.g. '360px', '480px'). Overrides the tool setting."
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
            "type": "text",
            "default": "420px",
            "description": "Height of the diagram frame (e.g. 320px, 420px, 500px)."
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
        return "ERROR: 'code' is required.";
    }

    const cleanSyntax = args.code
        .replace(/^```(?:mermaid)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    if (!cleanSyntax) {
        return "ERROR: Mermaid code cannot be empty.";
    }

    const lineCount = cleanSyntax.split('\n').length;

    // Read the user-configured setting from Settings > Tools > preview_mermaid
    const configuredHeight = sanitizeHeight(await api.getSetting?.('defaultHeight'), '420px');
    const height = sanitizeHeight(args.height, configuredHeight);
    const title = (typeof args.title === 'string' && args.title.trim()) ? args.title.trim() : 'Diagram';

    const safeTitleAttr = escapeHTMLAttr(title);
    const safeTitleText = escapeHTMLText(title);
    const safeHeightAttr = escapeHTMLAttr(height);

    const b64Syntax = btoa(unescape(encodeURIComponent(cleanSyntax)));

    // 1) Fast syntax validation using mermaid.parse
    const validationHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script>
        function reportOk() {
            try { window.parent.postMessage({ __displayHtmlStatusOk: true }, '*'); } catch (e) {}
        }
        function reportErr(msg) {
            try { window.parent.postMessage({ __displayHtmlStatusErr: String(msg || '') }, '*'); } catch (e) {}
        }
        window.addEventListener('error', function(e) { reportErr(e.message || 'Script error'); });
        window.addEventListener('unhandledrejection', function(e) {
            var r = e.reason;
            reportErr((r && r.message) ? r.message : String(r));
        });
    </script>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
</head>
<body>
    <script>
        const rawCode = decodeURIComponent(escape(atob("${b64Syntax}")));
        mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });
        (async function() {
            try {
                await mermaid.parse(rawCode);
                reportOk();
            } catch (err) {
                reportErr((err && err.message) ? err.message : String(err));
            }
        })();
    </script>
</body>
</html>`;

    if (typeof api?.validateDisplayHtml === 'function') {
        const v = await api.validateDisplayHtml(validationHtml, { timeoutMs: 5000 });
        if (!v || !v.ok) {
            const errText = (v && v.error) ? v.error : 'Failed to render preview';
            return `ERROR: Mermaid preview failed to render.\n\n${errText}\n\nCode:\n\`\`\`mermaid\n${cleanSyntax}\n\`\`\``;
        }
    }

    // 2) Full interactive preview document with geometry-ready rendering
    const iframeHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
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
            overflow: hidden; cursor: grab; background: #141414;
        }
        #viewport.dragging { cursor: grabbing; }
        #output { width: 100%; height: 100%; }

        /* Ensure Mermaid text labels are always visible and sharp */
        .node text, .node .label, .node span, .nodeLabel, text, tspan {
            fill: #dcdfe7 !important;
            color: #dcdfe7 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.4 !important;
        }

        .zoom-bar {
            position: absolute; bottom: 10px; right: 10px;
            display: flex; align-items: center; gap: 2px;
            background: rgba(24, 24, 24, 0.9);
            border: 1px solid #2e2e2e; border-radius: 6px;
            padding: 2px; backdrop-filter: blur(4px); z-index: 10;
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
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            flowchart: {
                htmlLabels: true,
                useMaxWidth: false
            },
            themeVariables: {
                darkmode: true,
                background: '#141414',
                primaryColor: '#1e293b',
                primaryTextColor: '#dcdfe7',
                primaryBorderColor: '#38bdf8',
                lineColor: '#737791',
                textColor: '#dcdfe7',
                nodeTextColor: '#dcdfe7',
                mainBkg: '#1e293b'
            }
        });

        let scale = 1, panX = 0, panY = 0;
        let bbox = { x: 0, y: 0, width: 500, height: 300 };
        let isDragging = false, startX = 0, startY = 0;

        const viewport = document.getElementById('viewport');
        const output = document.getElementById('output');
        let panGroup = null, svgElement = null;

        function updateTransform() {
            if (!panGroup) return;
            panGroup.setAttribute('transform', 'translate(' + panX + ', ' + panY + ') scale(' + scale + ')');
        }

        function refreshBBox() {
            if (!panGroup) return;
            try {
                const b = panGroup.getBBox();
                if (b.width > 0 && b.height > 0) {
                    bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
                }
            } catch (e) {}
        }

        function autoFit() {
            if (!svgElement || !panGroup) return;
            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            if (vw === 0 || vh === 0) return;

            refreshBBox();

            const padX = Math.min(60, Math.max(24, vw * 0.06));
            const padY = Math.min(40, Math.max(20, vh * 0.06));

            const fitScaleX = (vw - padX * 2) / Math.max(1, bbox.width);
            const fitScaleY = (vh - padY * 2) / Math.max(1, bbox.height);
            const fitScale = Math.min(fitScaleX, fitScaleY);

            scale = Math.min(1.7, Math.max(0.15, fitScale));

            panX = Math.round((vw - bbox.width * scale) / 2 - bbox.x * scale);
            panY = Math.round((vh - bbox.height * scale) / 2 - bbox.y * scale);

            svgElement.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh);
            updateTransform();
        }

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

        viewport.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!panGroup) return;

            const rect = viewport.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const factor = e.deltaY < 0 ? 1.15 : 0.87;
            const newScale = Math.max(0.1, Math.min(8.0, scale * factor));
            if (newScale === scale) return;

            panX = cx - (cx - panX) * (newScale / scale);
            panY = cy - (cy - panY) * (newScale / scale);
            scale = newScale;

            updateTransform();
        }, { passive: false });

        function zoomCenter(factor) {
            const cx = viewport.clientWidth / 2;
            const cy = viewport.clientHeight / 2;
            const newScale = Math.max(0.1, Math.min(8.0, scale * factor));
            panX = cx - (cx - panX) * (newScale / scale);
            panY = cy - (cy - panY) * (newScale / scale);
            scale = newScale;
            updateTransform();
        }

        document.getElementById('btn-zoom-in').addEventListener('click', () => zoomCenter(1.25));
        document.getElementById('btn-zoom-out').addEventListener('click', () => zoomCenter(0.8));
        document.getElementById('btn-zoom-reset').addEventListener('click', autoFit);
        window.addEventListener('resize', () => { if (!isDragging) autoFit(); });

        async function renderDiagram() {
            try {
                // Critical: Ensure viewport has non-zero width/height so Mermaid can measure text metrics
                if (viewport.clientWidth === 0 || viewport.clientHeight === 0) {
                    await new Promise(resolve => {
                        const ro = new ResizeObserver(() => {
                            if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
                                ro.disconnect();
                                resolve();
                            }
                        });
                        ro.observe(viewport);
                        ro.observe(document.body);
                        setTimeout(resolve, 250);
                    });
                }

                const uniqueId = 'mm_' + Math.random().toString(36).substring(2, 9);
                const { svg } = await mermaid.render(uniqueId, rawCode);
                output.innerHTML = svg;

                svgElement = output.querySelector('svg');
                if (!svgElement) return;

                const vb = svgElement.getAttribute('viewBox');
                if (vb) {
                    const parts = vb.trim().split(/[\\s,]+/).map(Number);
                    bbox = {
                        x: parts[0] || 0,
                        y: parts[1] || 0,
                        width: parts[2] || 500,
                        height: parts[3] || 300
                    };
                }

                svgElement.removeAttribute('width');
                svgElement.removeAttribute('height');
                svgElement.removeAttribute('style');
                svgElement.setAttribute('preserveAspectRatio', 'none');
                svgElement.style.width = '100%';
                svgElement.style.height = '100%';
                svgElement.style.display = 'block';

                panGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                panGroup.id = 'pan-group';

                // Array.from prevents live NodeList index mutation glitches
                const nodesToMove = Array.from(svgElement.childNodes).filter(node => {
                    return node.nodeName !== 'style' && node.nodeName !== 'defs';
                });
                nodesToMove.forEach(node => panGroup.appendChild(node));
                svgElement.appendChild(panGroup);

                autoFit();
                requestAnimationFrame(() => {
                    autoFit();
                    setTimeout(autoFit, 80);
                });
            } catch (err) {
                const msg = (err && err.message) ? err.message : String(err);
                output.innerHTML = '<div class="error-card">⚠️ Mermaid Syntax Error<br><br>' +
                    msg.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
            }
        }
        renderDiagram();
    <\/script>
</body>
</html>`;

    // 3) Display artifact
    const escapedSrcdoc = iframeHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedCode = cleanSyntax.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const displayHtml = `<div class="artifact-card" style="width: 100%; border: 1px solid var(--border, #2e2e2e); border-radius: 8px; overflow: hidden; background: var(--bg-panel, #1a1a1a); margin: 0; font-family: var(--font-mono, monospace);">
    <!-- Top Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: rgba(0, 0, 0, 0.25); border-bottom: 1px solid var(--border, #2e2e2e);">
        <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--fg, #dcdfe7);">
            <span class="icon" style="font-size: 14px; color: var(--cyan, #56b6c2);">schema</span>
            <span style="font-weight: 600;">${safeTitleText}</span>
            <span style="font-size: 10px; color: var(--dim, #737791);">(${lineCount} lines)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 3px;">
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

    <!-- Live Mermaid Diagram Pane (no loading="lazy" to ensure immediate frame layout) -->
    <div class="artifact-preview-pane" style="width: 100%; height: ${safeHeightAttr}; background: #141414;">
        <iframe title="${safeTitleAttr}" srcdoc="${escapedSrcdoc}" sandbox="allow-scripts" style="width: 100%; height: 100%; border: none; display: block;"></iframe>
    </div>

    <!-- Code Block Pane -->
    <div class="artifact-code-pane" style="display: none; width: 100%; height: ${safeHeightAttr}; overflow: auto; background: #141414; padding: 12px; box-sizing: border-box; scrollbar-width: thin; scrollbar-color: #2e2e2e transparent;">
        <pre style="margin: 0; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; color: var(--fg, #dcdfe7); white-space: pre;"><code>${escapedCode}</code></pre>
    </div>
</div>`;

    await api.showUI(displayHtml);

    return `Rendered Mermaid diagram "${title}":\n\n\`\`\`mermaid\n${cleanSyntax}\n\`\`\``;
}