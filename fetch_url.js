// fetch_url - tool definition.
const TOOL_META = {
    "name": "fetch_url",
    "description": "Fetch a web page or file by URL and return its text content. Tries a direct request first, then falls back to public read-only CORS proxies for sites that block cross-origin requests (browsers cannot bypass CORS otherwise).",
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
            "label": "Direct Request",
            "type": "boolean",
            "default": true,
            "description": "Try fetching directly without a proxy first."
        },
        {
            "key": "enableJina",
            "label": "Proxy: r.jina.ai",
            "type": "boolean",
            "default": true,
            "description": "Enable r.jina.ai reader fallback proxy."
        },
        {
            "key": "enableAllOrigins",
            "label": "Proxy: allorigins.win",
            "type": "boolean",
            "default": true,
            "description": "Enable allorigins.win fallback proxy."
        },
        {
            "key": "enableCodeTabs",
            "label": "Proxy: codetabs.com",
            "type": "boolean",
            "default": true,
            "description": "Enable codetabs.com fallback proxy."
        },
        {
            "key": "enableCorsProxy",
            "label": "Proxy: corsproxy.io",
            "type": "boolean",
            "default": true,
            "description": "Enable corsproxy.io fallback proxy."
        }
    ]
};

async function handler(args, api) {

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

    const MAX_CHARS = 15000;
    const TIMEOUT_MS = 12000;

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

    // Read configured proxy settings
    const enableDirect = (await api.getSetting('enableDirect')) ?? true;
    const enableJina = (await api.getSetting('enableJina')) ?? true;
    const enableAllOrigins = (await api.getSetting('enableAllOrigins')) ?? true;
    const enableCodeTabs = (await api.getSetting('enableCodeTabs')) ?? true;
    const enableCorsProxy = (await api.getSetting('enableCorsProxy')) ?? true;

    const attempts = [];
    if (enableDirect) {
        attempts.push({ url: parsedUrl.href, label: 'direct' });
    }
    if (enableJina) {
        attempts.push({ url: 'https://r.jina.ai/' + parsedUrl.href, label: 'r.jina.ai' });
    }
    if (enableAllOrigins) {
        attempts.push({ url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(parsedUrl.href), label: 'allorigins.win' });
    }
    if (enableCodeTabs) {
        attempts.push({ url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(parsedUrl.href), label: 'codetabs.com' });
    }
    if (enableCorsProxy) {
        attempts.push({ url: 'https://corsproxy.io/?url=' + encodeURIComponent(parsedUrl.href), label: 'corsproxy.io' });
    }

    if (attempts.length === 0) {
        return `ERROR: All fetch methods and proxies are currently disabled in tool settings. Please enable at least one method to fetch "${parsedUrl.href}".`;
    }

    let result = null;
    const errors = [];
    for (const attempt of attempts) {
        try {
            result = await tryFetch(attempt.url, attempt.label);
            break;
        } catch (e) {
            errors.push(`${attempt.label}: ${e.message}`);
        }
    }

    if (!result) {
        return `ERROR: Could not fetch ${parsedUrl.href} - all enabled request methods failed:\n${errors.join('\n')}\n\n(Public proxies have no uptime guarantee and can rate-limit or block certain sites/regions. If this keeps happening for the same URL, the site itself may be actively blocking proxy IP ranges.)`;
    }

    let output = result.text;
    const isHtml = result.contentType.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(output);
    if (isHtml && !args.raw) {
        output = extractReadableText(output);
    }

    const truncated = output.length > MAX_CHARS;
    if (truncated) output = output.slice(0, MAX_CHARS);

    return `[fetched via ${result.label}]\n\n${output}${truncated ? `\n\n...[truncated, ${result.text.length} total chars]` : ''}`;
}
