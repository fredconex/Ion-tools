const TOOL_META = {
    name: "audio_meta",
    description: "Extract clean tags and length from MP3, WAV, OGG, FLAC, and WMA files. Set detailed: true for extra audio properties (bitrate, frequency, channels).",
    parameters: {
        type: "object",
        properties: {
            filepath: { type: "string", description: "Path to the audio file." },
            detailed: { 
                type: "boolean", 
                description: "Leave false (default). ONLY set to true if the user explicitly asks for technical specs like bitrate, frequency, or channels." 
            }
        },
        required: ["filepath"]
    },
    modes: ["plan", "ask", "code"],
    permission: "always"
};

const ID3V1_GENRES = [
    "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop","Jazz","Metal",
    "New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock","Techno","Industrial",
    "Alternative","Ska","Death Metal","Pranks","Soundtrack","Euro-Techno","Ambient","Trip-Hop",
    "Vocal","Jazz+Funk","Fusion","Trance","Classical","Instrumental","Acid","House","Game",
    "Sound Clip","Gospel","Noise","AlternRock","Bass","Soul","Punk","Space","Meditative",
    "Instrumental Pop","Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial",
    "Electronic","Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta",
    "Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave",
    "Psychadelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk","Acid Jazz",
    "Polka","Retro","Musical","Rock & Roll","Hard Rock"
];

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const utf16le = new TextDecoder("utf-16le");

function readAscii(bytes, offset, length) {
    let str = "";
    for (let i = 0; i < length && offset + i < bytes.length; i++) {
        str += String.fromCharCode(bytes[offset + i]);
    }
    return str;
}

function clean(val) {
    if (typeof val !== "string") return val;
    return val.replace(/\0+$/g, "").trim();
}

function formatDuration(sec) {
    if (!sec || isNaN(sec) || sec <= 0) return undefined;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// --- ID3v2 & ID3v1 ---
function parseID3v2(bytes, offset = 0) {
    if (offset + 10 > bytes.length || readAscii(bytes, offset, 3) !== "ID3") return null;
    const major = bytes[offset + 3];
    const flags = bytes[offset + 5];
    const tagSize = ((bytes[offset + 6] & 0x7f) << 21) | ((bytes[offset + 7] & 0x7f) << 14) |
                    ((bytes[offset + 8] & 0x7f) << 7)  |  (bytes[offset + 9] & 0x7f);

    let pos = offset + 10;
    const tagEnd = Math.min(bytes.length, offset + 10 + tagSize);

    if (flags & 0x40 && pos + 4 <= tagEnd) {
        const extSize = major >= 4
            ? ((bytes[pos] & 0x7f) << 21) | ((bytes[pos+1] & 0x7f) << 14) | ((bytes[pos+2] & 0x7f) << 7) | (bytes[pos+3] & 0x7f)
            : (bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3];
        pos += 4 + extSize;
    }

    const idLen = major === 2 ? 3 : 4;
    const sizeLen = major === 2 ? 3 : 4;
    const flagLen = major === 2 ? 0 : 2;
    const tags = { _tagSize: 10 + tagSize };

    while (pos + idLen + sizeLen + flagLen <= tagEnd) {
        if (bytes[pos] === 0) break;
        const id = readAscii(bytes, pos, idLen);
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

        const sizePos = pos + idLen;
        let frameSize = major >= 4
            ? ((bytes[sizePos] & 0x7f) << 21) | ((bytes[sizePos+1] & 0x7f) << 14) | ((bytes[sizePos+2] & 0x7f) << 7) | (bytes[sizePos+3] & 0x7f)
            : major === 3 ? (bytes[sizePos] << 24) | (bytes[sizePos+1] << 16) | (bytes[sizePos+2] << 8) | bytes[sizePos+3]
            : (bytes[sizePos] << 16) | (bytes[sizePos+1] << 8) | bytes[sizePos+2];

        const bodyStart = pos + idLen + sizeLen + flagLen;
        if (frameSize <= 0 || bodyStart + frameSize > tagEnd) break;
        const body = bytes.subarray(bodyStart, bodyStart + frameSize);

        if (id.startsWith("T") && id !== "TXXX") {
            const enc = body[0];
            const data = body.subarray(1);
            let text = enc === 0 ? latin1.decode(data) : enc === 1 ? new TextDecoder("utf-16").decode(data) : enc === 2 ? new TextDecoder("utf-16be").decode(data) : utf8.decode(data);
            text = clean(text);
            if (id === "TIT2" || id === "TT2") tags.title = text;
            else if (id === "TPE1" || id === "TP1") tags.artist = text;
            else if (id === "TALB" || id === "TAL") tags.album = text;
            else if (id === "TYER" || id === "TDRC" || id === "TYE") tags.year = text.slice(0, 4);
            else if (id === "TLEN" || id === "TLE") tags._durationMs = parseInt(text, 10);
            else if (id === "TCON" || id === "TCO") {
                const m = text.match(/^\((\d+)\)/) || text.match(/^(\d+)$/);
                tags.genre = (m && ID3V1_GENRES[m[1]]) ? ID3V1_GENRES[m[1]] : text;
            } else if (id === "TRCK" || id === "TRK") tags.track = text.split("/")[0];
        }
        pos = bodyStart + frameSize;
    }
    return tags;
}

function parseID3v1(bytes) {
    if (bytes.length < 128) return null;
    const t = bytes.subarray(bytes.length - 128);
    if (readAscii(t, 0, 3) !== "TAG") return null;
    const read = (s, e) => clean(latin1.decode(t.subarray(s, e)));
    const genreIdx = t[127];
    return {
        title: read(3, 33), artist: read(33, 63), album: read(63, 93),
        year: read(93, 97), comment: read(97, 126),
        track: (t[125] === 0 && t[126] !== 0) ? String(t[126]) : undefined,
        genre: ID3V1_GENRES[genreIdx] || (genreIdx !== 255 ? `Unknown (${genreIdx})` : undefined)
    };
}

// --- MP3 Audio Frame Scanning ---
function scanMp3Stream(bytes, audioStart, fallbackDurationSec) {
    const bitratesMpeg1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const sampleRatesMpeg1 = [44100, 48000, 32000];

    for (let i = audioStart; i < Math.min(bytes.length - 4, audioStart + 65536); i++) {
        if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
            const version = (bytes[i + 1] >> 3) & 0x03;
            const layer = (bytes[i + 1] >> 1) & 0x03;
            if (version === 3 && layer === 1) { // MPEG-1 Layer 3
                const brIdx = (bytes[i + 2] >> 4) & 0x0f;
                const srIdx = (bytes[i + 2] >> 2) & 0x03;
                const channelMode = (bytes[i + 3] >> 6) & 0x03;
                const sampleRate = sampleRatesMpeg1[srIdx];
                const bitrateKbps = bitratesMpeg1L3[brIdx];
                if (!sampleRate || !bitrateKbps) continue;

                // Check for Xing/Info header
                const sideInfo = channelMode === 3 ? 17 : 32;
                const xingOffset = i + 4 + sideInfo;
                if (xingOffset + 12 < bytes.length) {
                    const id = readAscii(bytes, xingOffset, 4);
                    if (id === "Xing" || id === "Info") {
                        const flags = (bytes[xingOffset + 4] << 24) | (bytes[xingOffset + 5] << 16) | (bytes[xingOffset + 6] << 8) | bytes[xingOffset + 7];
                        if (flags & 1) {
                            const frames = (bytes[xingOffset + 8] << 24) | (bytes[xingOffset + 9] << 16) | (bytes[xingOffset + 10] << 8) | bytes[xingOffset + 11];
                            const sec = (frames * 1152) / sampleRate;
                            return {
                                lengthSec: sec,
                                extra: {
                                    frequency: `${sampleRate} Hz`,
                                    bitrate: `~${Math.round((bytes.length * 8) / (sec * 1000))} kbps (VBR)`,
                                    channels: channelMode === 3 ? "1 (Mono)" : "2 (Stereo)"
                                }
                            };
                        }
                    }
                }

                // Constant Bitrate
                const audioBytes = bytes.length - audioStart;
                const sec = fallbackDurationSec || ((audioBytes * 8) / (bitrateKbps * 1000));
                return {
                    lengthSec: sec,
                    extra: {
                        frequency: `${sampleRate} Hz`,
                        bitrate: `${bitrateKbps} kbps`,
                        channels: channelMode === 3 ? "1 (Mono)" : "2 (Stereo)"
                    }
                };
            }
        }
    }
    return { lengthSec: fallbackDurationSec, extra: {} };
}

// --- Main Handler ---
async function handler(args, api) {
    const bytes = await api.readFileBytes(args.filepath);
    if (typeof bytes === "string") return bytes;

    let format = "Unknown";
    let tags = {};
    let lengthSec = 0;
    let extra = {};
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 1. MP3
    if (bytes.length >= 3 && readAscii(bytes, 0, 3) === "ID3") {
        format = "MP3";
        const v2 = parseID3v2(bytes) || {};
        tags = v2;
        const v1 = parseID3v1(bytes);
        if (v1) {
            for (const [k, v] of Object.entries(v1)) {
                if (!tags[k] && v) tags[k] = v;
            }
        }
        const fallbackSec = v2._durationMs ? v2._durationMs / 1000 : 0;
        const mp3Stream = scanMp3Stream(bytes, v2._tagSize || 0, fallbackSec);
        lengthSec = mp3Stream.lengthSec;
        extra = mp3Stream.extra;
    }
    // 2. WAV
    else if (bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE") {
        format = "WAV";
        let offset = 12;
        let byteRate = 0;
        let dataSize = 0;

        while (offset + 8 <= bytes.length) {
            const id = readAscii(bytes, offset, 4);
            const size = view.getUint32(offset + 4, true);
            const start = offset + 8;

            if (id === "fmt " && size >= 16) {
                const channels = view.getUint16(start + 2, true);
                const sampleRate = view.getUint32(start + 4, true);
                byteRate = view.getUint32(start + 8, true);
                extra.frequency = `${sampleRate} Hz`;
                extra.channels = channels === 1 ? "1 (Mono)" : `${channels} (Stereo)`;
                extra.bitrate = `${Math.round((byteRate * 8) / 1000)} kbps`;
            } else if (id === "data") {
                dataSize = size;
            } else if (id === "LIST" && readAscii(bytes, start, 4) === "INFO") {
                let sub = start + 4;
                while (sub + 8 <= start + size) {
                    const subId = readAscii(bytes, sub, 4);
                    const subSize = view.getUint32(sub + 4, true);
                    const val = clean(utf8.decode(bytes.subarray(sub + 8, sub + 8 + subSize)));
                    if (subId === "INAM") tags.title = val;
                    else if (subId === "IART") tags.artist = val;
                    else if (subId === "IPRD") tags.album = val;
                    else if (subId === "ICRD") tags.year = val.slice(0, 4);
                    else if (subId === "IGNR") tags.genre = val;
                    else if (subId === "ITRK") tags.track = val;
                    sub += 8 + subSize + (subSize % 2);
                }
            }
            offset += 8 + size + (size % 2);
        }
        if (byteRate > 0 && dataSize > 0) {
            lengthSec = dataSize / byteRate;
        }
    }
    // 3. FLAC
    else if (bytes.length >= 4 && readAscii(bytes, 0, 4) === "fLaC") {
        format = "FLAC";
        let offset = 4;
        while (offset + 4 <= bytes.length) {
            const isLast = (bytes[offset] & 0x80) !== 0;
            const type = bytes[offset] & 0x7f;
            const len = (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
            offset += 4;
            // STREAMINFO
            if (type === 0 && len >= 34) {
                const sampleRate = (bytes[offset + 10] << 12) | (bytes[offset + 11] << 4) | (bytes[offset + 12] >> 4);
                const channels = ((bytes[offset + 12] >> 1) & 0x07) + 1;
                const totalSamples = ((bytes[offset + 13] & 0x0f) * 0x100000000) +
                                     ((bytes[offset + 14] << 24) | (bytes[offset + 15] << 16) | (bytes[offset + 16] << 8) | bytes[offset + 17]);
                lengthSec = totalSamples / sampleRate;
                extra.frequency = `${sampleRate} Hz`;
                extra.channels = channels === 1 ? "1 (Mono)" : `${channels} (Stereo)`;
                extra.bitrate = `~${Math.round((bytes.length * 8) / (lengthSec * 1000))} kbps`;
            }
            // VORBIS_COMMENT
            else if (type === 4) {
                const vLen = view.getUint32(offset, true);
                const count = view.getUint32(offset + 4 + vLen, true);
                let p = offset + 8 + vLen;
                for (let i = 0; i < count && p + 4 <= offset + len; i++) {
                    const cLen = view.getUint32(p, true); p += 4;
                    const entry = utf8.decode(bytes.subarray(p, p + cLen)); p += cLen;
                    const sep = entry.indexOf("=");
                    if (sep !== -1) {
                        const k = entry.slice(0, sep).toUpperCase();
                        const v = clean(entry.slice(sep + 1));
                        if (k === "TITLE") tags.title = v;
                        else if (k === "ARTIST") tags.artist = v;
                        else if (k === "ALBUM") tags.album = v;
                        else if (k === "DATE" || k === "YEAR") tags.year = v.slice(0, 4);
                        else if (k === "GENRE") tags.genre = v;
                        else if (k === "TRACKNUMBER") tags.track = v.split("/")[0];
                    }
                }
            }
            offset += len;
            if (isLast) break;
        }
    }
    // 4. OGG
    else if (bytes.length >= 4 && readAscii(bytes, 0, 4) === "OggS") {
        format = "OGG";
        let sampleRate = 44100;
        for (let i = 0; i < Math.min(bytes.length - 8, 32768); i++) {
            if (bytes[i] === 3 && readAscii(bytes, i + 1, 6) === "vorbis") {
                const vLen = view.getUint32(i + 7, true);
                const count = view.getUint32(i + 11 + vLen, true);
                let p = i + 15 + vLen;
                for (let c = 0; c < count && p + 4 <= bytes.length; c++) {
                    const len = view.getUint32(p, true); p += 4;
                    const entry = utf8.decode(bytes.subarray(p, p + len)); p += len;
                    const sep = entry.indexOf("=");
                    if (sep !== -1) {
                        const k = entry.slice(0, sep).toUpperCase();
                        const v = clean(entry.slice(sep + 1));
                        if (k === "TITLE") tags.title = v;
                        else if (k === "ARTIST") tags.artist = v;
                        else if (k === "ALBUM") tags.album = v;
                        else if (k === "DATE" || k === "YEAR") tags.year = v.slice(0, 4);
                        else if (k === "GENRE") tags.genre = v;
                        else if (k === "TRACKNUMBER") tags.track = v.split("/")[0];
                    }
                }
            }
        }
        // Scan backwards for last OggS page to extract total length
        for (let i = bytes.length - 14; i >= Math.max(0, bytes.length - 65536); i--) {
            if (readAscii(bytes, i, 4) === "OggS") {
                const granule = Number(view.getBigInt64(i + 6, true));
                if (granule > 0) {
                    lengthSec = granule / sampleRate;
                    extra.frequency = `${sampleRate} Hz`;
                    extra.bitrate = `~${Math.round((bytes.length * 8) / (lengthSec * 1000))} kbps`;
                    break;
                }
            }
        }
    }
    // 5. WMA / ASF
    else if (bytes.length >= 30 && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2) {
        format = "WMA";
        let offset = 30;
        while (offset + 24 <= bytes.length) {
            const objSize = Number(view.getBigUint64(offset + 16, true));
            if (objSize <= 0 || offset + objSize > bytes.length) break;

            if (bytes[offset] === 0xa1 && bytes[offset + 1] === 0xdc) {
                const playDuration = Number(view.getBigUint64(offset + 40, true) / 10000000n);
                const preroll = Number(view.getBigUint64(offset + 48, true)) / 1000;
                lengthSec = Math.max(0, playDuration - preroll);
                extra.bitrate = `${Math.round(view.getUint32(offset + 56, true) / 1000)} kbps`;
            } else if (bytes[offset] === 0x33 && bytes[offset + 1] === 0x26 && bytes[offset + 2] === 0xb2) {
                const tLen = view.getUint16(offset + 24, true);
                const aLen = view.getUint16(offset + 26, true);
                let p = offset + 34;
                if (tLen > 0) tags.title = clean(utf16le.decode(bytes.subarray(p, p + tLen)));
                p += tLen;
                if (aLen > 0) tags.artist = clean(utf16le.decode(bytes.subarray(p, p + aLen)));
            }
            offset += objSize;
        }
    }

    // Build Output
    const out = { format };
    for (const key of ["title", "artist", "album", "year", "genre", "track"]) {
        if (tags[key]) out[key] = tags[key];
    }
    if (lengthSec > 0) {
        out.length = formatDuration(lengthSec);
    }
    if (args.detailed && Object.keys(extra).length > 0) {
        out.extra = extra;
    }

    return JSON.stringify(out, null, 2);
}