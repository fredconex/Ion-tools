// duckduckgo_search - tool definition.
const TOOL_META = {
    "name": "duckduckgo_search",
    "description": "Search the web via DuckDuckGo and return the top results (title, url, snippet). Tries direct request first, then falls back to public read-only CORS proxies if blocked.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query"
            }
        },
        "required": [
            "query"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "never",
    "toolBox": 1
};

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            api.setHeaderMsg(msg);
        }
    };

    const query = (args.query || '').trim();
    if (!query) {
        return "ERROR: No search query provided.";
    }

    // Keep header clean even if query is very long
    const displayQuery = query.length > 40 ? query.slice(0, 37) + '...' : query;

    const TIMEOUT_MS = 10000;
    const targetUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);

    async function tryFetch(url, label) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            if (!text || !text.trim()) throw new Error('empty response');
            return { text, label };
        } catch (e) {
            if (e.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
            throw new Error(e.message === 'Failed to fetch' ? 'blocked (network/CORS error)' : e.message);
        } finally {
            clearTimeout(timer);
        }
    }

    // Proxy fallbacks preserving raw HTML for regex parsing
    const attempts = [
        { url: targetUrl, label: 'direct' },
        { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl), label: 'allorigins.win' },
        { url: 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(targetUrl), label: 'codetabs.com' },
        { url: 'https://corsproxy.io/?url=' + encodeURIComponent(targetUrl), label: 'corsproxy.io' }
    ];

    let result = null;
    const errors = [];

    for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        const stepNum = i + 1;
        const total = attempts.length;

        if (attempt.label === 'direct') {
            updateStatus(`[${stepNum}/${total}] Searching "${displayQuery}" (direct)...`);
        } else {
            updateStatus(`[${stepNum}/${total}] Direct failed, searching "${displayQuery}" via ${attempt.label}...`);
        }

        try {
            result = await tryFetch(attempt.url, attempt.label);
            break;
        } catch (e) {
            errors.push(`${attempt.label}: ${e.message}`);
        }
    }

    if (!result) {
        updateStatus(`Failed to search "${displayQuery}" after ${attempts.length} attempts`);
        return `ERROR: DuckDuckGo search failed - direct request and proxy fallbacks failed:\n${errors.join('\n')}`;
    }

    updateStatus(`Parsing results for "${displayQuery}" via ${result.label}...`);

    function decodeEntities(s) {
        return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    }
    function stripTags(s) {
        return decodeEntities(s.replace(/<[^>]*>/g, '')).trim();
    }

    const results = [];
    const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*\bresult\b[^"]*"|$)/g;
    const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/;
    const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/;

    let block;
    while ((block = blockRe.exec(result.text)) !== null && results.length < 8) {
        const chunk = block[0];
        const linkMatch = linkRe.exec(chunk);
        if (!linkMatch) continue;
        let url = linkMatch[1];
        const m = url.match(/uddg=([^&]+)/);
        if (m) url = decodeURIComponent(m[1]);
        const title = stripTags(linkMatch[2]);
        const snippetMatch = snippetRe.exec(chunk);
        const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';
        if (title) results.push({ title, url, snippet });
    }

    if (!results.length) {
        updateStatus(`No results found for "${displayQuery}"`);
        return "(no results)";
    }

    updateStatus(`Found ${results.length} result(s) for "${displayQuery}" via ${result.label}`);

    return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}