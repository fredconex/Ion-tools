const TOOL_META = {
    name: "mp3_meta",
    description: "Extract ID3v2 (all frame types), ID3v1 and APE tag info from an MP3 file.",
    parameters: {
        type: "object",
        properties: { filepath: { type: "string" } },
        required: ["filepath"]
    },
    modes: ["plan", "ask", "code"],
    permission: "always"
};

const ID3V1_GENRES = [/* 148 standard genres */ "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock","Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack","Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel","Noise","AlternRock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop","Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial","Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta","Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave","Psychadelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz","Polka","Retro","Musical","Rock & Roll","Hard Rock"];

async function handler(args, api) {
    const bytes = await api.readFileBytes(args.filepath);
    if (typeof bytes === "string") return bytes;

    const out = { fileSize: bytes.length, id3v2: null, id3v1: null, ape: null };

    // ---------- ID3v2 ----------
    if (bytes.length >= 10 && String.fromCharCode(bytes[0], bytes[1], bytes[2]) === "ID3") {
        const major = bytes[3];
        const flags = bytes[5];
        const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
                        ((bytes[8] & 0x7f) << 7)  |  (bytes[9] & 0x7f);

        const tag = { version: `2.${major}.${bytes[4]}`, tagSize, flags, frames: [] };
        let pos = 10;
        const tagEnd = Math.min(bytes.length, 10 + tagSize);

        if (flags & 0x40 && pos + 4 <= tagEnd) {
            let extSize = major >= 4
                ? ((bytes[pos] & 0x7f) << 21) | ((bytes[pos+1] & 0x7f) << 14) | ((bytes[pos+2] & 0x7f) << 7) | (bytes[pos+3] & 0x7f)
                : (bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3];
            pos += 4 + extSize;
        }

        const idLen = major === 2 ? 3 : 4;
        const sizeLen = major === 2 ? 3 : 4;
        const flagLen = major === 2 ? 0 : 2;

        while (pos + idLen + sizeLen + flagLen <= tagEnd) {
            if (bytes[pos] === 0) break;
            let id = "";
            for (let i = 0; i < idLen; i++) id += String.fromCharCode(bytes[pos + i]);
            if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

            const sizeStart = pos + idLen;
            let frameSize;
            if (major >= 4) {
                frameSize = ((bytes[sizeStart] & 0x7f) << 21) | ((bytes[sizeStart+1] & 0x7f) << 14) |
                            ((bytes[sizeStart+2] & 0x7f) << 7) | (bytes[sizeStart+3] & 0x7f);
            } else if (major === 3) {
                frameSize = (bytes[sizeStart] << 24) | (bytes[sizeStart+1] << 16) |
                            (bytes[sizeStart+2] << 8) | bytes[sizeStart+3];
            } else {
                frameSize = (bytes[sizeStart] << 16) | (bytes[sizeStart+1] << 8) | bytes[sizeStart+2];
            }
            const bodyStart = pos + idLen + sizeLen + flagLen;
            if (frameSize <= 0 || bodyStart + frameSize > tagEnd) break;
            const body = bytes.subarray(bodyStart, bodyStart + frameSize);

            // Text frames: T*
            if (id[0] === "T") {
                const enc = body[0];
                const data = body.subarray(1);
                let text;
                if (enc === 0) text = new TextDecoder("latin1").decode(data);
                else if (enc === 1) text = new TextDecoder("utf-16").decode(data);
                else if (enc === 2) text = new TextDecoder("utf-16be").decode(data);
                else text = new TextDecoder("utf-8").decode(data);
                tag.frames.push({ id, type: "text", value: text.replace(/\0+$/g, "") });
            }
            // GEOB: general encapsulated object
            else if (id === "GEOB") {
                const enc = body[0];
                let p = 1;
                // mime type (null terminated)
                let mimeEnd = p; while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd++;
                const mime = new TextDecoder("latin1").decode(body.subarray(p, mimeEnd));
                p = mimeEnd + 1;
                // filename
                let fnEnd = p; while (fnEnd < body.length && body[fnEnd] !== 0) fnEnd++;
                const filename = new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(body.subarray(p, fnEnd));
                p = fnEnd + 1;
                // description
                let deEnd = p; while (deEnd < body.length && body[deEnd] !== 0) deEnd++;
                const description = new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(body.subarray(p, deEnd));
                p = deEnd + 1;
                tag.frames.push({
                    id, type: "geob",
                    mime, filename, description,
                    dataLength: body.length - p,
                    dataPreviewHex: [...body.subarray(p, Math.min(p + 16, body.length))]
                        .map(b => b.toString(16).padStart(2, "0")).join(" ")
                });
            }
            // APIC: attached picture
            else if (id === "APIC") {
                const enc = body[0];
                let p = 1;
                let mimeEnd = p; while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd++;
                const mime = new TextDecoder("latin1").decode(body.subarray(p, mimeEnd));
                p = mimeEnd + 1;
                const picType = body[p++];
                let deEnd = p; while (deEnd < body.length && body[deEnd] !== 0) deEnd++;
                const description = new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(body.subarray(p, deEnd));
                p = deEnd + 1;
                tag.frames.push({ id, type: "apic", mime, pictureType: picType, description, dataLength: body.length - p });
            }
            // COMM: comments
            else if (id === "COMM") {
                const enc = body[0];
                const lang = new TextDecoder("latin1").decode(body.subarray(1, 4));
                let p = 4;
                let deEnd = p; while (deEnd < body.length && body[deEnd] !== 0) deEnd++;
                const description = new TextDecoder(enc === 0 ? "latin1" : "utf-8").decode(body.subarray(p, deEnd));
                p = deEnd + 1;
                const comment = new TextDecoder(enc === 0 ? "latin1" : enc === 1 ? "utf-16" : "utf-8").decode(body.subarray(p)).replace(/\0+$/g, "");
                tag.frames.push({ id, type: "comment", language: lang, description, value: comment });
            }
            else {
                // Unknown / other frame: report its id + size + a short hex preview.
                tag.frames.push({
                    id, type: "raw", size: frameSize,
                    previewHex: [...body.subarray(0, Math.min(32, body.length))]
                        .map(b => b.toString(16).padStart(2, "0")).join(" ")
                });
            }

            pos = bodyStart + frameSize;
        }
        out.id3v2 = tag;
    }

    // ---------- ID3v1 (last 128 bytes) ----------
    if (bytes.length >= 128) {
        const t = bytes.subarray(bytes.length - 128);
        if (String.fromCharCode(t[0], t[1], t[2]) === "TAG") {
            const read = (s, e) => new TextDecoder("latin1").decode(t.subarray(s, e)).replace(/\0+$/g, "").trim();
            const genreIdx = t[127];
            out.id3v1 = {
                title: read(3, 33), artist: read(33, 63), album: read(63, 93),
                year: read(93, 97), comment: read(97, 127 - 1),
                genreIndex: genreIdx,
                genre: ID3V1_GENRES[genreIdx] || (genreIdx === 255 ? "(none)" : `Unknown (${genreIdx})`)
            };
        }
    }

    // ---------- APE tag (before ID3v1) ----------
    if (bytes.length >= 32) {
        const scanEnd = bytes.length - (out.id3v1 ? 128 : 0);
        const scanStart = Math.max(0, scanEnd - 64 * 1024);
        for (let i = scanEnd - 32; i >= scanStart; i--) {
            if (bytes[i] === 0x41 && bytes[i+1] === 0x50 && bytes[i+2] === 0x45 && bytes[i+3] === 0x54 &&
                bytes[i+4] === 0x41 && bytes[i+5] === 0x47 && bytes[i+6] === 0x45 && bytes[i+7] === 0x58) {
                const ver = (bytes[i+8] | (bytes[i+9] << 8));
                const size = bytes[i+12] | (bytes[i+13] << 8) | (bytes[i+14] << 16) | (bytes[i+15] << 24);
                out.ape = { offset: i, version: ver, size, note: "APE tag found - not decoded (rare on MP3)" };
                break;
            }
        }
    }

    return JSON.stringify(out, null, 2);
}