// preview_chart - tool definition for Ion / agent.html.
// - Draws bold data value labels on top of bars (with headroom padding).
// - Adds rounded bar corners (borderRadius: 4).
// - Slices for pie, doughnut, and polarArea charts receive distinct palette colors.
// - Full area chart support with smooth curves and translucent fills.
// - Radar charts automatically begin at 0, limit tick density, and pad category labels.
// - Automatic {x, y} coordinate normalization for scatter charts with primitive values.
// - Always dark theme visualization.
// - Direct CSV/TSV/Markdown table input + pre-flight validation.
const TOOL_META = {
    "name": "preview_chart",
    "description": "Renders interactive charts directly in chat. Supports bar, line, area, pie, doughnut, polarArea, radar, and scatter. Automatically formats scatter points, colors pie slices, normalizes radar scaling to 0, and handles CSV or Chart.js JSON specs.",
    "parameters": {
        "type": "object",
        "properties": {
            "csv": {
                "type": "string",
                "description": "Raw CSV, TSV, or Markdown table text directly. No file creation required."
            },
            "type": {
                "type": "string",
                "enum": ["bar", "line", "area", "pie", "doughnut", "radar", "scatter", "polarArea"],
                "description": "Chart type when using 'csv' or 'filepath'. Defaults to 'bar'."
            },
            "spec": {
                "type": "string",
                "description": "Optional full Chart.js JSON configuration."
            },
            "filepath": {
                "type": "string",
                "description": "Optional path to a CSV or JSON file in the workspace."
            },
            "title": {
                "type": "string",
                "description": "Optional title for the chart card."
            },
            "height": {
                "type": "string",
                "description": "Height of the chart frame (e.g. '380px', '450px'). Defaults to '380px'."
            }
        }
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
            "default": "380px",
            "description": "Default height of the chart frame."
        }
    ]
};

function normalizeType(t) {
    if (!t) return 'bar';
    const s = String(t).trim().toLowerCase();
    if (s === 'polararea' || s === 'polar-area' || s === 'polar_area') return 'polarArea';
    if (s === 'donut') return 'doughnut';
    return s;
}

function normalizeScatterData(cfg) {
    if (!cfg || cfg.type !== 'scatter' || !cfg.data || !Array.isArray(cfg.data.datasets)) return;
    
    cfg.options = cfg.options || {};
    cfg.options.scales = cfg.options.scales || {};
    cfg.options.scales.x = cfg.options.scales.x || {};

    const labels = cfg.data.labels;
    const hasLabels = Array.isArray(labels) && labels.length > 0;
    const areLabelsNumeric = hasLabels && labels.every(l => !isNaN(Number(l)) && l !== '');

    cfg.data.datasets.forEach(ds => {
        if (Array.isArray(ds.data) && ds.data.length > 0) {
            if (typeof ds.data[0] !== 'object' || ds.data[0] === null) {
                if (hasLabels && areLabelsNumeric) {
                    ds.data = ds.data.map((val, i) => ({
                        x: Number(labels[i] !== undefined ? labels[i] : i + 1),
                        y: typeof val === 'number' ? val : (parseFloat(val) || 0)
                    }));
                } else if (hasLabels) {
                    ds.data = ds.data.map((val, i) => ({
                        x: String(labels[i] !== undefined ? labels[i] : i + 1),
                        y: typeof val === 'number' ? val : (parseFloat(val) || 0)
                    }));
                    cfg.options.scales.x.type = 'category';
                } else {
                    ds.data = ds.data.map((val, i) => ({
                        x: i + 1,
                        y: typeof val === 'number' ? val : (parseFloat(val) || 0)
                    }));
                }
            }
        }
        if (ds.pointRadius === undefined) ds.pointRadius = 5;
        if (ds.pointHoverRadius === undefined) ds.pointHoverRadius = 7;
    });
}

function sanitizeHeight(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    const s = raw.trim();
    if (!s) return fallback;
    if (/^\d+(\.\d+)?(px|em|rem|vh|vw|%)?$/i.test(s)) return s;
    return fallback;
}

function escapeHTML(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function parseTableData(text) {
    let lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    let isMarkdown = false;
    let delimiter = ',';

    if (lines[0].includes('|')) {
        isMarkdown = true;
        lines = lines.filter(l => !/^\|?[\s\-:|]+\|?$/.test(l));
    } else if (lines[0].includes('\t')) {
        delimiter = '\t';
    } else if (lines[0].includes(';') && !lines[0].includes(',')) {
        delimiter = ';';
    }

    function splitLine(line) {
        if (isMarkdown) {
            return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(s => s.trim());
        }
        return line.split(delimiter).map(s => s.trim().replace(/^["']|["']$/g, ''));
    }

    const headers = splitLine(lines[0]);
    return lines.slice(1).map(line => {
        const values = splitLine(line);
        const obj = {};
        headers.forEach((h, i) => {
            const raw = values[i] ?? '';
            const num = Number(raw);
            obj[h] = (!isNaN(num) && raw !== '') ? num : raw;
        });
        return obj;
    });
}

function autoBindData(chartConfig, rows) {
    if (!rows || !rows.length) return;
    chartConfig.data = chartConfig.data || {};

    const keys = Object.keys(rows[0]);
    if (!keys.length) return;

    let labelKey = keys.find(k => rows.some(r => typeof r[k] === 'string' && isNaN(Number(r[k]))));
    if (!labelKey) labelKey = keys[0];

    const dataKeys = keys.filter(k => k !== labelKey);

    if (!chartConfig.data.labels || chartConfig.data.labels.length === 0) {
        chartConfig.data.labels = rows.map(r => String(r[labelKey] ?? ''));
    }

    chartConfig.data.datasets = chartConfig.data.datasets || [];

    if (chartConfig.data.datasets.length === 0) {
        chartConfig.data.datasets = dataKeys.map(dk => ({
            label: dk,
            data: rows.map(r => typeof r[dk] === 'number' ? r[dk] : (parseFloat(r[dk]) || 0))
        }));
    } else {
        chartConfig.data.datasets.forEach((ds, idx) => {
            if (!ds.data || ds.data.length === 0) {
                const matchedKey = dataKeys.find(dk => 
                    ds.label && (dk.toLowerCase() === ds.label.toLowerCase() ||
                                 ds.label.toLowerCase().includes(dk.toLowerCase()) ||
                                 dk.toLowerCase().includes(ds.label.toLowerCase()))
                ) || dataKeys[idx] || dataKeys[0];

                if (matchedKey) {
                    ds.data = rows.map(r => typeof r[matchedKey] === 'number' ? r[matchedKey] : (parseFloat(r[matchedKey]) || 0));
                    if (!ds.label) ds.label = matchedKey;
                }
            }
        });
    }
}

async function handler(args, api) {
    if (!args.spec && !args.csv && !args.filepath) {
        return "ERROR: Provide at least one of: 'csv' (direct text), 'filepath' (file path), or 'spec' (Chart.js JSON).";
    }

    let chartConfig;
    if (args.spec) {
        try {
            const cleanJson = args.spec.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
            chartConfig = JSON.parse(cleanJson);
        } catch (e) {
            return `ERROR: Failed to parse chart 'spec' JSON: ${e.message}`;
        }
    } else {
        chartConfig = {
            type: args.type || 'bar',
            data: {},
            options: {}
        };
    }

    // Preserve the intended display type ('area', 'scatter', etc.)
    const rawType = String(args.type || chartConfig.type || 'bar').trim().toLowerCase();
    const isArea = rawType === 'area';
    const displayType = isArea ? 'area' : normalizeType(rawType);

    // Chart.js uses 'line' controller for area charts
    chartConfig.type = isArea ? 'line' : normalizeType(chartConfig.type || rawType);

    // Populate data from CSV or workspace file
    if (args.csv) {
        try {
            const rows = parseTableData(args.csv);
            if (!rows.length) return "ERROR: Provided 'csv' data contains no valid rows.";
            autoBindData(chartConfig, rows);
        } catch (e) {
            return `ERROR parsing direct 'csv' text: ${e.message}`;
        }
    } else if (args.filepath) {
        try {
            const rawContent = await api.readFile(args.filepath);
            if (rawContent === null || rawContent === undefined) {
                return `ERROR: File not found: '${args.filepath}'`;
            }
            const rows = args.filepath.endsWith('.json') ? JSON.parse(rawContent) : parseTableData(rawContent);
            if (!rows.length) return `ERROR: Data file '${args.filepath}' contains no data rows.`;
            autoBindData(chartConfig, rows);
        } catch (e) {
            return `ERROR reading external file '${args.filepath}': ${e.message}`;
        }
    }

    if (!chartConfig.data || (!chartConfig.data.datasets && !chartConfig.data.labels)) {
        return `ERROR: Chart spec must contain a 'data' object with 'datasets' or 'labels'.`;
    }

    // Ensure all datasets have fill: true and smooth curve for area charts
    if (isArea && Array.isArray(chartConfig.data?.datasets)) {
        chartConfig.data.datasets.forEach(ds => {
            if (ds.fill === undefined) ds.fill = true;
            if (ds.tension === undefined) ds.tension = 0.3;
        });
    }

    // Auto-normalize scatter data points if scalar numbers were passed
    normalizeScatterData(chartConfig);

    const title = (typeof args.title === 'string' && args.title.trim()) 
        ? args.title.trim() 
        : `${displayType.toUpperCase()} Visualization`;

    const configuredHeight = sanitizeHeight(await api.getSetting?.('defaultHeight'), '380px');
    const height = sanitizeHeight(args.height, configuredHeight);
    const safeTitle = escapeHTML(title);

    const jsonString = JSON.stringify(chartConfig, null, 2);
    const b64Config = btoa(unescape(encodeURIComponent(jsonString)));

    // 1. PRE-FLIGHT VALIDATION
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
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
</head>
<body>
    <canvas id="testCanvas" width="300" height="300"></canvas>
    <script>
        (function() {
            try {
                const configRaw = decodeURIComponent(escape(atob("${b64Config}")));
                const cfg = JSON.parse(configRaw);
                if (cfg.type && cfg.type.toLowerCase() === 'polararea') cfg.type = 'polarArea';
                cfg.options = cfg.options || {};
                cfg.options.animation = false;
                cfg.options.responsive = false;
                const ctx = document.getElementById('testCanvas').getContext('2d');
                new Chart(ctx, cfg);
                reportOk();
            } catch (err) {
                reportErr(err.message || String(err));
            }
        })();
    </script>
</body>
</html>`;

    if (typeof api?.validateDisplayHtml === 'function') {
        const v = await api.validateDisplayHtml(validationHtml, { timeoutMs: 4000 });
        if (v && !v.ok) {
            const errText = v.error || 'Failed to render chart';
            return `ERROR: Chart failed to render:\n\n${errText}\n\nConfig:\n\`\`\`json\n${jsonString}\n\`\`\``;
        }
    }

    // 2. LIVE DOCUMENT (ALWAYS DARK THEME)
    const iframeHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <style>
        * { box-sizing: border-box; }
        html, body {
            margin: 0; padding: 14px; width: 100%; height: 100%;
            background: #141414;
            color: #dcdfe7;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            overflow: hidden;
        }
        .chart-container {
            position: relative; width: 100%; height: 100%;
        }
    </style>
</head>
<body>
    <div class="chart-container">
        <canvas id="chartCanvas"></canvas>
    </div>

    <script>
        (function() {
            try {
                const configRaw = decodeURIComponent(escape(atob("${b64Config}")));
                const userConfig = JSON.parse(configRaw);

                // Fix Chart.js case-sensitive type names
                if (userConfig.type) {
                    const t = userConfig.type.toLowerCase();
                    if (t === 'polararea' || t === 'polar-area') userConfig.type = 'polarArea';
                    if (t === 'donut') userConfig.type = 'doughnut';
                }

                // Normalization safeguard for scatter data
                if (userConfig.type === 'scatter' && userConfig.data && Array.isArray(userConfig.data.datasets)) {
                    userConfig.options = userConfig.options || {};
                    userConfig.options.scales = userConfig.options.scales || {};
                    userConfig.options.scales.x = userConfig.options.scales.x || {};
                    const labels = userConfig.data.labels;
                    const hasLabels = Array.isArray(labels) && labels.length > 0;
                    const areLabelsNumeric = hasLabels && labels.every(l => !isNaN(Number(l)) && l !== '');

                    userConfig.data.datasets.forEach(ds => {
                        if (Array.isArray(ds.data) && ds.data.length > 0 && (typeof ds.data[0] !== 'object' || ds.data[0] === null)) {
                            if (hasLabels && areLabelsNumeric) {
                                ds.data = ds.data.map((v, i) => ({ x: Number(labels[i]), y: Number(v) || 0 }));
                            } else if (hasLabels) {
                                ds.data = ds.data.map((v, i) => ({ x: String(labels[i]), y: Number(v) || 0 }));
                                userConfig.options.scales.x.type = 'category';
                            } else {
                                ds.data = ds.data.map((v, i) => ({ x: i + 1, y: Number(v) || 0 }));
                            }
                        }
                        if (ds.pointRadius === undefined) ds.pointRadius = 5;
                        if (ds.pointHoverRadius === undefined) ds.pointHoverRadius = 7;
                    });
                }

                const palette = [
                    '#61afef', '#98c379', '#e5c07b', '#e06c75', 
                    '#c678dd', '#56b6c2', '#d19a66', '#be5046',
                    '#4fa6ed', '#a3d487', '#f0a868', '#64c8d6'
                ];

                // INLINE PLUGIN: Draws bold values above each bar
                const barValuesPlugin = {
                    id: 'barValuesPlugin',
                    afterDatasetsDraw(chart) {
                        if (chart.config.type !== 'bar') return;
                        const ctx = chart.ctx;
                        ctx.save();
                        ctx.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillStyle = '#f1f5f9';

                        chart.data.datasets.forEach((dataset, datasetIndex) => {
                            const meta = chart.getDatasetMeta(datasetIndex);
                            if (meta.hidden) return;

                            meta.data.forEach((element, index) => {
                                const val = dataset.data[index];
                                if (val === null || val === undefined || isNaN(val)) return;

                                const text = typeof val === 'number' 
                                    ? (Number.isInteger(val) ? String(val) : String(Math.round(val * 10) / 10))
                                    : String(val);

                                const x = element.x;
                                const isNegative = val < 0;
                                ctx.textBaseline = isNegative ? 'top' : 'bottom';
                                const y = isNegative ? element.y + 4 : element.y - 4;
                                ctx.fillText(text, x, y);
                            });
                        });
                        ctx.restore();
                    }
                };
                Chart.register(barValuesPlugin);

                userConfig.options = userConfig.options || {};
                userConfig.options.responsive = true;
                userConfig.options.maintainAspectRatio = false;

                // Ensure headroom so top bar numbers aren't cut off
                if (userConfig.type === 'bar') {
                    userConfig.options.scales = userConfig.options.scales || {};
                    userConfig.options.scales.y = userConfig.options.scales.y || {};
                    if (userConfig.options.scales.y.grace === undefined) {
                        userConfig.options.scales.y.grace = '10%';
                    }
                }

                const isRadial = userConfig.type === 'radar' || userConfig.type === 'polarArea';
                const isPieFamily = userConfig.type === 'pie' || userConfig.type === 'doughnut' || userConfig.type === 'polarArea';

                // Radial scale styling: begin at 0, limit tick density, pad category labels
                if (isRadial) {
                    userConfig.options.scales = userConfig.options.scales || {};
                    userConfig.options.scales.r = userConfig.options.scales.r || {};
                    
                    if (userConfig.options.scales.r.beginAtZero === undefined && userConfig.options.scales.r.min === undefined) {
                        userConfig.options.scales.r.beginAtZero = true;
                    }

                    userConfig.options.scales.r.ticks = userConfig.options.scales.r.ticks || {};
                    userConfig.options.scales.r.ticks.color = 'rgba(220, 223, 231, 0.3)';
                    userConfig.options.scales.r.ticks.showLabelBackdrop = false;
                    userConfig.options.scales.r.ticks.backdropColor = 'transparent';
                    if (userConfig.options.scales.r.ticks.maxTicksLimit === undefined) {
                        userConfig.options.scales.r.ticks.maxTicksLimit = 5;
                    }
                    userConfig.options.scales.r.ticks.font = Object.assign({ size: 9 }, userConfig.options.scales.r.ticks.font || {});

                    userConfig.options.scales.r.grid = userConfig.options.scales.r.grid || {};
                    userConfig.options.scales.r.grid.color = 'rgba(255, 255, 255, 0.08)';

                    userConfig.options.scales.r.angleLines = userConfig.options.scales.r.angleLines || {};
                    userConfig.options.scales.r.angleLines.color = 'rgba(255, 255, 255, 0.08)';

                    userConfig.options.scales.r.pointLabels = userConfig.options.scales.r.pointLabels || {};
                    userConfig.options.scales.r.pointLabels.color = '#abb2bf';
                    if (userConfig.options.scales.r.pointLabels.padding === undefined) {
                        userConfig.options.scales.r.pointLabels.padding = 10;
                    }
                    userConfig.options.scales.r.pointLabels.font = Object.assign({ size: 11, weight: '600' }, userConfig.options.scales.r.pointLabels.font || {});
                }

                // Auto-colorize & dataset styling
                if (userConfig.data && Array.isArray(userConfig.data.datasets)) {
                    userConfig.data.datasets.forEach((ds, idx) => {
                        if (isPieFamily) {
                            const count = Array.isArray(ds.data) ? ds.data.length : 1;
                            if (!ds.backgroundColor) {
                                ds.backgroundColor = Array.from({ length: count }, (_, i) => palette[i % palette.length]);
                            }
                            if (!ds.borderColor) {
                                ds.borderColor = '#141414';
                            }
                            if (ds.borderWidth === undefined) {
                                ds.borderWidth = 2;
                            }
                        } else {
                            const color = palette[idx % palette.length];
                            const isLine = userConfig.type === 'line';
                            const hasFill = ds.fill === true || ds.fill === 'origin';

                            if (!ds.borderColor) ds.borderColor = color;
                            if (!ds.backgroundColor) {
                                ds.backgroundColor = userConfig.type === 'radar' 
                                    ? color + '26' 
                                    : (hasFill ? color + '33' : color);
                            }
                            if (ds.borderWidth === undefined) {
                                ds.borderWidth = isLine || userConfig.type === 'radar' ? 2 : 1;
                            }
                            if (hasFill && ds.tension === undefined) {
                                ds.tension = 0.3;
                            }
                            if (userConfig.type === 'radar' && ds.pointRadius === undefined) {
                                ds.pointRadius = 3.5;
                            }
                            if (userConfig.type === 'bar' && ds.borderRadius === undefined) {
                                ds.borderRadius = 4;
                            }
                        }
                    });
                }

                // General dark theme colors for Cartesian scales
                const textColor = '#8a8e9b';
                const gridColor = '#23272e';
                Chart.defaults.color = textColor;
                Chart.defaults.borderColor = gridColor;

                if (userConfig.options.scales) {
                    Object.entries(userConfig.options.scales).forEach(([key, scale]) => {
                        if (key !== 'r') {
                            scale.ticks = scale.ticks || {};
                            scale.ticks.color = textColor;
                            scale.grid = scale.grid || {};
                            scale.grid.color = gridColor;
                        }
                    });
                }
                if (userConfig.options.plugins?.legend?.labels) {
                    userConfig.options.plugins.legend.labels.color = '#dcdfe7';
                }

                const ctx = document.getElementById('chartCanvas').getContext('2d');
                new Chart(ctx, userConfig);
            } catch (err) {
                console.error(err);
            }
        })();
    <\/script>
</body>
</html>`;

    const escapedSrcdoc = iframeHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const escapedCode = jsonString.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 3. ARTIFACT CARD
    const displayHtml = `<div class="artifact-card" style="width: 100%; border: 1px solid var(--border, #2e2e2e); border-radius: 8px; overflow: hidden; background: var(--bg-panel, #181818); margin: 0; font-family: var(--font-mono, monospace);">
    <!-- Top Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(0, 0, 0, 0.25); border-bottom: 1px solid var(--border, #2e2e2e);">
        <div style="display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--fg, #dcdfe7);">
            <span class="icon" style="font-size: 14px; color: var(--accent, #61afef);">bar_chart</span>
            <span style="font-weight: 600;">${safeTitle}</span>
            <span style="font-size: 10px; color: var(--dim, #737791);">(${displayType})</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
            <!-- Code / Config Toggle -->
            <button type="button" class="icon-btn" title="Toggle Chart / JSON Config"
                onclick="(function(btn){
                    var card = btn.closest('.artifact-card');
                    var p = card.querySelector('.artifact-preview-pane');
                    var c = card.querySelector('.artifact-code-pane');
                    var isPrev = p.style.display !== 'none';
                    p.style.display = isPrev ? 'none' : 'block';
                    c.style.display = isPrev ? 'block' : 'none';
                })(this)">
                <span class="icon" style="font-size: 14px;">code</span>
            </button>

            <!-- Copy JSON Config -->
            <button type="button" class="icon-btn" title="Copy Configuration JSON"
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

            <!-- Open in New Tab -->
            <button type="button" class="icon-btn" title="Open chart in new browser tab"
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

    <!-- Live Chart Pane -->
    <div class="artifact-preview-pane" style="width: 100%; height: ${height}; background: #141414;">
        <iframe title="${safeTitle}" srcdoc="${escapedSrcdoc}" sandbox="allow-scripts" style="width: 100%; height: 100%; border: none; display: block;"></iframe>
    </div>

    <!-- Raw Config Pane -->
    <div class="artifact-code-pane" style="display: none; width: 100%; height: ${height}; overflow: auto; background: #141414; padding: 12px; box-sizing: border-box;">
        <pre style="margin: 0; font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.45; color: var(--fg, #dcdfe7); white-space: pre;"><code>${escapedCode}</code></pre>
    </div>
</div>`;

    if (typeof api?.showUI === 'function') {
        await api.showUI(displayHtml);
    }

    return {
        output: `Successfully rendered ${displayType} chart titled "${title}".`,
        displayHtml
    };
}