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
    "permission": "ask",
    "toolBox": 1
};

async function handler(args, api) {
    function utf8ToBase64(str) {
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(str, 'utf8').toString('base64');
        }
        const bytes = new TextEncoder().encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    function base64ToUtf8(b64) {
        if (typeof Buffer !== 'undefined') {
            return Buffer.from(b64.trim(), 'base64').toString('utf8');
        }
        const binary = atob(b64.trim());
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function generateUUID() {
        const c = typeof crypto !== 'undefined' ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
        if (c && typeof c.randomUUID === 'function') {
            return c.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    // --- Pure JS SHA-1 (RFC 3174) ---
    function pureJsSha1(ascii) {
        const utf8 = new TextEncoder().encode(ascii);
        const len = utf8.length;
        const words = [];
        for (let i = 0; i < len; i++) {
            words[i >> 2] |= utf8[i] << ((3 - (i % 4)) * 8);
        }
        words[len >> 2] |= 0x80 << ((3 - (len % 4)) * 8);
        words[(((len + 8) >> 6) << 4) + 15] = len * 8;

        let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
        const w = new Uint32Array(80);

        for (let i = 0; i < words.length; i += 16) {
            for (let j = 0; j < 16; j++) w[j] = words[i + j] | 0;
            for (let j = 16; j < 80; j++) {
                const val = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
                w[j] = (val << 1) | (val >>> 31);
            }

            let a = h0, b = h1, c = h2, d = h3, e = h4;
            for (let j = 0; j < 80; j++) {
                let f, k;
                if (j < 20) {
                    f = (b & c) | ((~b) & d);
                    k = 0x5a827999;
                } else if (j < 40) {
                    f = b ^ c ^ d;
                    k = 0x6ed9eba1;
                } else if (j < 60) {
                    f = (b & c) | (b & d) | (c & d);
                    k = 0x8f1bbcdc;
                } else {
                    f = b ^ c ^ d;
                    k = 0xca62c1d6;
                }
                const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
                e = d;
                d = c;
                c = (b << 30) | (b >>> 2);
                b = a;
                a = temp;
            }

            h0 = (h0 + a) | 0;
            h1 = (h1 + b) | 0;
            h2 = (h2 + c) | 0;
            h3 = (h3 + d) | 0;
            h4 = (h4 + e) | 0;
        }

        return [h0, h1, h2, h3, h4].map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
    }

    // --- Pure JS SHA-256 ---
    function pureJsSha256(ascii) {
        function rightRotate(value, amount) {
            return (value >>> amount) | (value << (32 - amount));
        }

        const mathPow = Math.pow;
        const maxWord = mathPow(2, 32);
        const words = [];
        const hash = [];
        const k = [];
        let primeCounter = 0;

        const isPrime = {};
        for (let candidate = 2; primeCounter < 64; candidate++) {
            if (!isPrime[candidate]) {
                for (let i = candidate * 2; i <= 311; i += candidate) isPrime[i] = true;
                if (primeCounter < 8) hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
                k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
                primeCounter++;
            }
        }

        const utf8 = new TextEncoder().encode(ascii);
        const length = utf8.length;
        for (let i = 0; i < length; i++) words[i >> 2] |= utf8[i] << ((3 - (i % 4)) * 8);
        words[length >> 2] |= 0x80 << ((3 - (length % 4)) * 8);
        words[(((length + 8) >> 6) << 4) + 15] = length * 8;

        for (let j = 0; j < words.length; j += 16) {
            const w = [];
            for (let i = 0; i < 16; i++) w[i] = words[j + i] | 0;
            for (let i = 16; i < 64; i++) {
                const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }

            let [a, b, c, d, e, f, g, h] = hash;
            for (let i = 0; i < 64; i++) {
                const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
                const ch = (e & f) ^ ((~e) & g);
                const temp1 = (h + s1 + ch + k[i] + w[i]) | 0;
                const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (s0 + maj) | 0;

                h = g; g = f; f = e;
                e = (d + temp1) | 0;
                d = c; c = b; b = a;
                a = (temp1 + temp2) | 0;
            }

            hash[0] = (hash[0] + a) | 0;
            hash[1] = (hash[1] + b) | 0;
            hash[2] = (hash[2] + c) | 0;
            hash[3] = (hash[3] + d) | 0;
            hash[4] = (hash[4] + e) | 0;
            hash[5] = (hash[5] + f) | 0;
            hash[6] = (hash[6] + g) | 0;
            hash[7] = (hash[7] + h) | 0;
        }

        return hash.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
    }

    // --- Pure JS SHA-512 (FIPS 180-4 using BigInt) ---
    function pureJsSha512(ascii) {
        const MASK64 = 0xffffffffffffffffn;
        function rotr(x, n) {
            const shift = BigInt(n);
            return ((x >> shift) | (x << (64n - shift))) & MASK64;
        }

        const K512 = [
            0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
            0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
            0xd807aa98a3030242n, 0x12835b0145706fb2n, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
            0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
            0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
            0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
            0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
            0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
            0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
            0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
            0x9b867c41ff61ee4fn, 0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc2478794456b7efdn,
            0xc76c51a30654be30n, 0xd192e819d6ef5218n, 0xd699064f5565a910n, 0xf40e35855771202an,
            0x106aa07032bbd1b8n, 0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n,
            0x34b0bcb5e19b48a8n, 0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n,
            0x682e6ff3d6b2b8a3n, 0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n,
            0x8cc702081a6439ecn, 0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n,
            0xc67178f2e372532bn, 0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en,
            0xf57d4f7fee6ed178n, 0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen,
            0x1b710b35131c471bn, 0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9beben,
            0x431d67c49c100d4cn, 0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn
        ];

        let H = [
            0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
            0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n
        ];

        const utf8 = new TextEncoder().encode(ascii);
        const bitLen = BigInt(utf8.length) * 8n;
        const padLen = (utf8.length % 128 < 112) ? (112 - (utf8.length % 128)) : (240 - (utf8.length % 128));
        const totalLen = utf8.length + padLen + 16;
        const padded = new Uint8Array(totalLen);
        padded.set(utf8);
        padded[utf8.length] = 0x80;

        const view = new DataView(padded.buffer);
        view.setBigUint64(totalLen - 8, bitLen, false);

        const W = new BigUint64Array(80);
        for (let i = 0; i < totalLen; i += 128) {
            for (let j = 0; j < 16; j++) {
                W[j] = view.getBigUint64(i + (j * 8), false);
            }
            for (let j = 16; j < 80; j++) {
                const s0 = rotr(W[j - 15], 1) ^ rotr(W[j - 15], 8) ^ (W[j - 15] >> 7n);
                const s1 = rotr(W[j - 2], 19) ^ rotr(W[j - 2], 61) ^ (W[j - 2] >> 6n);
                W[j] = (W[j - 16] + s0 + W[j - 7] + s1) & MASK64;
            }

            let [a, b, c, d, e, f, g, h] = H;
            for (let j = 0; j < 80; j++) {
                const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
                const ch = (e & f) ^ ((~e) & g);
                const temp1 = (h + S1 + ch + K512[j] + W[j]) & MASK64;
                const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
                const maj = (a & b) ^ (a & c) ^ (b & c);
                const temp2 = (S0 + maj) & MASK64;

                h = g; g = f; f = e;
                e = (d + temp1) & MASK64;
                d = c; c = b; b = a;
                a = (temp1 + temp2) & MASK64;
            }

            H[0] = (H[0] + a) & MASK64;
            H[1] = (H[1] + b) & MASK64;
            H[2] = (H[2] + c) & MASK64;
            H[3] = (H[3] + d) & MASK64;
            H[4] = (H[4] + e) & MASK64;
            H[5] = (H[5] + f) & MASK64;
            H[6] = (H[6] + g) & MASK64;
            H[7] = (H[7] + h) & MASK64;
        }

        return H.map(v => v.toString(16).padStart(16, '0')).join('');
    }

    async function hashString(algo, text) {
        // 1. Try Node.js crypto module
        try {
            const req = typeof require === 'function' ? require : null;
            if (req) {
                const nodeCrypto = req('crypto');
                if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
                    const normAlgo = algo.toLowerCase().replace('-', '');
                    return nodeCrypto.createHash(normAlgo).update(text, 'utf8').digest('hex');
                }
            }
        } catch (_) {}

        // 2. Try Web Crypto API (if available and secure)
        const subtleCrypto = (typeof crypto !== 'undefined' && crypto.subtle)
            ? crypto.subtle
            : (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
                ? globalThis.crypto.subtle
                : null;

        if (subtleCrypto) {
            try {
                const data = new TextEncoder().encode(text);
                const buffer = await subtleCrypto.digest(algo, data);
                return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (_) {
                // In case of subtleCrypto throwing, fallback to pure JS below
            }
        }

        // 3. Guaranteed Pure JS fallbacks
        if (algo === 'SHA-1') return pureJsSha1(text);
        if (algo === 'SHA-256') return pureJsSha256(text);
        if (algo === 'SHA-512') return pureJsSha512(text);

        throw new Error(`Unsupported algorithm: ${algo}`);
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

            case 'base64_encode':
                return `Base64 Encoded: ${utf8ToBase64(inputStr)}`;

            case 'base64_decode':
                return `Base64 Decoded: ${base64ToUtf8(inputStr)}`;

            default:
                return `ERROR: Unknown action '${args.action}'. Supported: uuid, hash, base64_encode, base64_decode`;
        }
    } catch (e) {
        return `ERROR: ${e.message}`;
    }
}