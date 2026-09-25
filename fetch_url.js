// fetch_url - tool definition.
const TOOL_META = {
    "name": "fetch_url",
    "description": "Fetch a web page or file by URL and return its text content. Tries a direct request first, then falls back to configured public read-only CORS proxies if blocked.",
    "parameters": {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Full URL, including https://"
            },
            "raw": {
                "type": "boolean",
                "description": "If true, return the raw response body (e.g. JSON/HTML) instead of extracting readable text from HTML. Default false."
            }
        },
        "required": [
            "url"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "never",
    "toolBox": 1,
    "settings": [
        {
            "key": "enableDirect",
            "label": "Enable Direct Fetch",
            "type": "boolean",
            "default": true,
            "description": "Try direct request first (fastest, but may fail on CORS-restricted sites in browsers)."
        },
        {
            "key": "enableJina",
            "label": "Enable r.jina.ai",
            "type": "boolean",
            "default": true,
            "description": "Use r.jina.ai reader CORS proxy (extracts clean markdown/content)."
        },
        {
            "key": "enableAllorigins",
            "label": "Enable allorigins.win",
            "type": "boolean",
            "default": true,
            "description": "Use api.allorigins.win CORS proxy."
        },
        {
            "key": "enableCodetabs",
            "label": "Enable codetabs.com",
            "type": "boolean",
            "default": true,
            "description": "Use api.codetabs.com CORS proxy."
        },
        {
            "key": "enableCorsproxy",
            "label": "Enable corsproxy.io",
            "type": "boolean",
            "default": true,
            "description": "Use corsproxy.io CORS proxy."
        },
        {
            "key": "timeoutMs",
            "label": "Request Timeout (ms)",
            "type": "number",
            "default": 12000,
            "min": 2000,
            "max": 60000,
            "description": "Timeout per request attempt in milliseconds."
        },
        {
            "key": "maxChars",
            "label": "Max Output Chars",
            "type": "number",
            "default": 15000,
            "min": 500,
            "max": 100000,
            "description": "Maximum character length of returned text content."
        }
    ]
};

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            api.setHeaderMsg(msg);
        }
    };

    // Helper to read boolean settings safely (handles boolean, string, or undefined)
    async function getBoolSetting(key, defaultValue = true) {
        if (typeof api?.getSetting !== 'function') return defaultValue;
        const val = await api.getSetting(key);
        if (val === undefined || val === null) return defaultValue;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
        return Boolean(val);
    }

    // Read configured settings
    const timeoutSetting = Number(await api?.getSetting?.("timeoutMs"));
    const TIMEOUT_MS = Number.isFinite(timeoutSetting) && timeoutSetting > 0 ? timeoutSetting : 12000;

    const maxCharsSetting = Number(await api?.getSetting?.("maxChars"));
    const MAX_CHARS = Number.isFinite(maxCharsSetting) && maxCharsSetting > 0 ? maxCharsSetting : 15000;

    // Validate URL and filter out local paths, non-HTTP protocols, and localhost
    let parsedUrl;
    try {
        parsedUrl = new URL(args.url);
    } catch {
        return `ERROR: Invalid URL "${args.url}". Only valid http:// and https:// URLs are supported (local file paths are not allowed).`;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return `ERROR: Unsupported protocol "${parsedUrl.protocol}". Local files (like file://) cannot be fetched; only http:// and https:// URLs are allowed.`;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLocalHost = hostname === 'localhost' ||
                        hostname === '127.0.0.1' ||
                        hostname === '0.0.0.0' ||
                        hostname === '::1' ||
                        hostname.endsWith('.local');
    if (isLocalHost) {
        return `ERROR: Localhost requests (${parsedUrl.hostname}) are not supported.`;
    }

    // Available providers mapped to their setting keys
    const PROXY_DEFINITIONS = [
        {
            key: "enableDirect",
            label: "direct",
            buildUrl: (u) => u.href
        },
        {
            key: "enableJina",
            label: "r.jina.ai",
            buildUrl: (u) => 'https://r.jina.ai/' + u.href
        },
        {
            key: "enableAllorigins",
            label: "allorigins.win",
            buildUrl: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u.href)
        },
        {
            key: "enableCodetabs",
            label: "codetabs.com",
            buildUrl: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u.href)
        },
        {
            key: "enableCorsproxy",
            label: "corsproxy.io",
            buildUrl: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u.href)
        }
    ];

    // Filter providers based on user settings
    const activeAttempts = [];
    for (const p of PROXY_DEFINITIONS) {
        if (await getBoolSetting(p.key, true)) {
            activeAttempts.push({
                label: p.label,
                url: p.buildUrl(parsedUrl)
            });
        }
    }

    if (activeAttempts.length === 0) {
        return "ERROR: All proxies and direct fetch are disabled in the tool settings. Please enable at least one in settings.";
    }

    function extractReadableText(html) {
        let text = html
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');
        text = text
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
        return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    }

    async function tryFetch(url, label) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const contentType = res.headers.get('content-type') || '';
            const text = await res.text();
            if (!text || !text.trim()) throw new Error('empty response');
            return { text, contentType, label };
        } catch (e) {
            if (e.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
            throw new Error(e.message === 'Failed to fetch' ? 'blocked (network/CORS error)' : e.message);
        } finally {
            clearTimeout(timer);
        }
    }

    let result = null;
    const errors = [];

    for (let i = 0; i < activeAttempts.length; i++) {
        const attempt = activeAttempts[i];
        const stepNum = i + 1;
        const total = activeAttempts.length;

        if (attempt.label === 'direct') {
            updateStatus(`[${stepNum}/${total}] Trying direct fetch: ${parsedUrl.hostname}...`);
        } else if (i > 0) {
            updateStatus(`[${stepNum}/${total}] Fallback trying proxy ${attempt.label}...`);
        } else {
            updateStatus(`[${stepNum}/${total}] Trying proxy ${attempt.label}...`);
        }

        try {
            result = await tryFetch(attempt.url, attempt.label);
            break;
        } catch (e) {
            errors.push(`${attempt.label}: ${e.message}`);
        }
    }

    if (!result) {
        updateStatus(`Failed after ${activeAttempts.length} attempts`);
        return `ERROR: Could not fetch ${parsedUrl.href} - all enabled attempts (${activeAttempts.map(a => a.label).join(', ')}) failed:\n${errors.join('\n')}\n\n(Public proxies have no uptime guarantee and can rate-limit or block certain sites/regions. If this keeps happening for the same URL, the site itself may be actively blocking proxy IP ranges.)`;
    }

    updateStatus(`Extracting content via ${result.label}...`);

    let output = result.text;
    const isHtml = result.contentType.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(output);
    if (isHtml && !args.raw) {
        output = extractReadableText(output);
    }

    const truncated = output.length > MAX_CHARS;
    if (truncated) output = output.slice(0, MAX_CHARS);

    updateStatus(`Completed via ${result.label}`);

    return `[fetched via ${result.label}]\n\n${output}${truncated ? `\n\n...[truncated, ${result.text.length} total chars]` : ''}`;
}