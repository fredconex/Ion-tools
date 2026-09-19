// duckduckgo_search - tool definition.
const TOOL_META = {
    "name": "duckduckgo_search",
    "description": "Search the web via DuckDuckGo and return the top results (title, url, snippet).",
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
    "toolBox": 1,
    "settings": [
        {
            "key": "maxResults",
            "label": "Max Results",
            "type": "number",
            "default": 8,
            "min": 1,
            "max": 25,
            "description": "Maximum number of search results to return."
        },
        {
            "key": "safeSearch",
            "label": "SafeSearch",
            "type": "boolean",
            "default": true,
            "description": "Filter explicit or adult content from search results."
        }
    ]
};

async function handler(args, api) {
    if (!args.query || !args.query.trim()) {
        return "ERROR: A search query must be provided.";
    }

    const maxResults = (await api.getSetting('maxResults')) ?? 8;
    const safeSearch = (await api.getSetting('safeSearch')) ?? true;

    // DuckDuckGo kp parameter: 1 = strict/safe, -2 = off
    const kpParam = safeSearch ? '1' : '-2';
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}&kp=${kpParam}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    let html;
    try {
        const res = await fetch(searchUrl, { signal: controller.signal });
        if (!res.ok) return `ERROR: DuckDuckGo request failed (HTTP ${res.status})`;
        html = await res.text();
    } catch (e) {
        if (e.name === 'AbortError') return "ERROR: DuckDuckGo search timed out after 12s.";
        return `ERROR: Failed to fetch DuckDuckGo search: ${e.message}`;
    } finally {
        clearTimeout(timer);
    }

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
    while ((block = blockRe.exec(html)) !== null && results.length < maxResults) {
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

    if (!results.length) return "(no results)";
    return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}
