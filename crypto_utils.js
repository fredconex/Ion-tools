// crypto_utils - tool definition.
const TOOL_META = {
    "name": "crypto_utils",
    "description": "Perform cryptographic and encoding operations: generate v4 UUIDs, compute secure hashes (SHA-256, SHA-512, SHA-1), and encode/decode Base64 with full UTF-8 support.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["uuid", "hash", "base64_encode", "base64_decode"],
                "description": "The operation to perform."
            },
            "data": {
                "type": "string",
                "description": "Input text to hash or encode/decode (required for hash and base64 actions)."
            },
            "algorithm": {
                "type": "string",
                "enum": ["SHA-256", "SHA-512", "SHA-1"],
                "description": "Hashing algorithm. Default is 'SHA-256'. (Only used when action='hash')."
            }
        },
        "required": ["action"]
    },
    "modes": ["code", "ask", "plan"],
    "permission": "auto",
    "toolBox": 1
};

async function handler(args, api) {
    // Pure JS UTF-8 safe Base64 encoder
    function utf8ToBase64(str) {
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    // Pure JS UTF-8 safe Base64 decoder
    function base64ToUtf8(b64) {
        const binary = atob(b64.trim());
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    }

    // Pure JS UUID v4 generator (with fallback if crypto.randomUUID is not present)
    function generateUUID() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // Fallback RFC4122 v4
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // Web Crypto API hash digest
    async function hashString(algo, text) {
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            throw new Error("Web Crypto API (crypto.subtle) is not supported in this environment.");
        }
        const data = new TextEncoder().encode(text);
        const buffer = await crypto.subtle.digest(algo, data);
        const hashArray = Array.from(new Uint8Array(buffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    try {
        const action = (args.action || '').toLowerCase();

        if (action === 'uuid') {
            return `UUID: ${generateUUID()}`;
        }

        if (args.data === undefined || args.data === null) {
            return "ERROR: The 'data' parameter is required for this action.";
        }

        const inputStr = String(args.data);

        switch (action) {
            case 'hash': {
                let algo = (args.algorithm || 'SHA-256').toUpperCase();
                if (!['SHA-256', 'SHA-512', 'SHA-1'].includes(algo)) {
                    algo = 'SHA-256';
                }
                const digest = await hashString(algo, inputStr);
                return `Algorithm: ${algo}\nHash: ${digest}`;
            }

            case 'base64_encode': {
                return `Base64 Encoded: ${utf8ToBase64(inputStr)}`;
            }

            case 'base64_decode': {
                return `Base64 Decoded: ${base64ToUtf8(inputStr)}`;
            }

            default:
                return `ERROR: Unknown action '${args.action}'. Supported: uuid, hash, base64_encode, base64_decode`;
        }
    } catch (e) {
        return `ERROR: ${e.message}`;
    }
}