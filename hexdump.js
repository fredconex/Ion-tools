const TOOL_META = {
    name: "hexdump",
    description: "Print a hex+ASCII dump of a file. Works on binary files (mp3, png, etc). Output size is capped by the tool's maxBytes/maxOutputBytes settings.",
    parameters: {
        type: "object",
        properties: {
            filepath: { type: "string" },
            offset:   { type: "integer", description: "Byte offset to start at (default 0)" },
            length:   { type: "integer", description: "Requested bytes to dump. Clamped to the tool's maxBytes setting." }
        },
        required: ["filepath"]
    },
    modes: ["plan", "ask", "code"],
    permission: "always",
    settings: [
        {
            key: "maxBytes",
            label: "Max Bytes Per Call",
            type: "number",
            default: 512,
            min: 16,
            max: 65536,
            description: "Hard ceiling on how many bytes a single hexdump call may render. Per-call 'length' is clamped to this."
        },
        {
            key: "defaultBytes",
            label: "Default Bytes",
            type: "number",
            default: 256,
            min: 16,
            max: 65536,
            description: "Bytes dumped when the caller omits 'length'. Also clamped to Max Bytes Per Call."
        },
        {
            key: "bytesPerLine",
            label: "Bytes Per Line",
            type: "select",
            options: ["8", "16", "32"],
            default: "16",
            description: "How many bytes to show per row. Fewer bytes = more rows for the same byte count."
        },
        {
            key: "maxOutputBytes",
            label: "Max Output Chars",
            type: "number",
            default: 2048,
            min: 256,
            max: 16768,
            description: "Final safety cap on the rendered text length (chars). Truncates with a notice if exceeded."
        }
    ]
};

async function handler(args, api) {
    const updateStatus = (msg) => {
        if (typeof api?.setHeaderMsg === 'function') {
            api.setHeaderMsg(msg);
        }
    };

    const filename = args.filepath ? (args.filepath.split(/[/\\]/).pop() || args.filepath) : 'file';

    // Read settings as numbers/strings; getSetting returns whatever the user configured.
    const maxBytes        = Number(await api?.getSetting?.("maxBytes"))        || 512;
    const defaultBytes    = Number(await api?.getSetting?.("defaultBytes"))    || 256;
    const bytesPerLine    = Math.max(1, Number(await api?.getSetting?.("bytesPerLine")) || 16);
    const maxOutputBytes  = Number(await api?.getSetting?.("maxOutputBytes"))  || 2048;

    updateStatus(`Reading ${filename}...`);

    const bytes = await api.readFileBytes(args.filepath);
    if (typeof bytes === "string") {
        updateStatus(`Failed reading ${filename}`);
        return bytes; // "ERROR: ..."
    }

    const offset = Math.max(0, args.offset || 0);

    // Per-call request is clamped to the configured ceiling.
    const requested = Number.isFinite(args.length) && args.length > 0
        ? args.length
        : defaultBytes;
    const length = Math.min(requested, maxBytes);

    const slice = bytes.subarray(offset, offset + length);

    updateStatus(`Formatting ${slice.length}B from ${filename} @ offset 0x${offset.toString(16)}...`);

    // Header line so the model knows what it's looking at.
    const header =
        `hexdump of ${args.filepath} (${bytes.length} bytes total)\n` +
        `offset=${offset}  showing=${slice.length} bytes  ` +
        `(requested=${requested}, capped at maxBytes=${maxBytes}, ${bytesPerLine}/line)\n\n`;

    const lines = [];
    const pad = bytesPerLine * 3; // "xx " per byte, minus trailing space
    for (let i = 0; i < slice.length; i += bytesPerLine) {
        const row = slice.subarray(i, i + bytesPerLine);
        const hex = [...row]
            .map(b => b.toString(16).padStart(2, "0"))
            .join(" ")
            .padEnd(pad - 1, " ");
        const ascii = [...row]
            .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".")
            .join("");
        const addr = (offset + i).toString(16).padStart(8, "0");
        lines.push(`${addr}  ${hex}  |${ascii}|`);
    }

    // Track whether we actually truncated at the maxBytes ceiling,
    // so the model knows there is more and can call again with a larger offset.
    const truncatedAtCeiling = (offset + slice.length) < bytes.length &&
                               slice.length === length &&
                               length >= maxBytes;

    let body = lines.join("\n");
    let truncatedAtOutput = false;

    if (body.length > maxOutputBytes) {
        body = body.slice(0, maxOutputBytes);
        // Trim to the last full line so we don't leave a half-rendered row.
        const lastNl = body.lastIndexOf("\n");
        if (lastNl > 0) body = body.slice(0, lastNl);
        truncatedAtOutput = true;
    }

    let footer = "";
    if (truncatedAtOutput) {
        footer = `\n\n[truncated: output exceeded maxOutputBytes=${maxOutputBytes}. ` +
                 `Re-run with a smaller 'length' or a later 'offset'.]`;
    } else if (truncatedAtCeiling) {
        footer = `\n\n[more data: call again with offset=${offset + slice.length} to continue.]`;
    }

    // Final status reporting byte window and total file size
    const hexOffset = `0x${offset.toString(16)}`;
    updateStatus(`${filename}: dumped ${slice.length}B @ ${hexOffset} (${bytes.length}B total)`);

    return header + body + footer;
}