// diff - tool definition.
const TOOL_META = {
    "name": "diff",
    "description": "Compare the contents of two files and display differences in standard unified diff format (with line numbers, context lines, additions, and deletions).",
    "parameters": {
        "type": "object",
        "properties": {
            "file_a": {
                "type": "string",
                "description": "Path to the original/base file."
            },
            "file_b": {
                "type": "string",
                "description": "Path to the modified/target file to compare against file_a."
            },
            "context_lines": {
                "type": "integer",
                "description": "Number of surrounding unchanged context lines to show around changes. Defaults to 3."
            }
        },
        "required": [
            "file_a",
            "file_b"
        ]
    },
    "modes": [
        "plan",
        "ask",
        "code"
    ],
    "permission": "always",
    "toolBox": 1
};

async function handler(args, api) {
    if (!args.file_a || !args.file_b) {
        throw new Error("Both 'file_a' and 'file_b' paths are required.");
    }

    // 1. Check existence
    if (typeof api.exists === 'function') {
        if (!(await api.exists(args.file_a))) {
            throw new Error(`File does not exist: '${args.file_a}'`);
        }
        if (!(await api.exists(args.file_b))) {
            throw new Error(`File does not exist: '${args.file_b}'`);
        }
    }

    // 2. Read files
    const txtA = await api.readFile(args.file_a);
    const txtB = await api.readFile(args.file_b);

    if (txtA === null || txtA === undefined) {
        throw new Error(`File does not exist or could not be read: '${args.file_a}'`);
    }
    if (txtB === null || txtB === undefined) {
        throw new Error(`File does not exist or could not be read: '${args.file_b}'`);
    }

    // 3. Check if both files are empty (handles whitespace-only as well if trimmed)
    if (txtA.trim() === "" && txtB.trim() === "") {
        throw new Error("Nothing to compare: both files are empty.");
    }

    // Binary file checks
    if (await api.isBinary(args.file_a)) {
        throw new Error(`'${args.file_a}' is a binary file and cannot be diffed as text.`);
    }
    if (await api.isBinary(args.file_b)) {
        throw new Error(`'${args.file_b}' is a binary file and cannot be diffed as text.`);
    }

    if (txtA === txtB) {
        return `Files are identical: '${args.file_a}' and '${args.file_b}'.`;
    }

    const contextSize = typeof args.context_lines === 'number' && args.context_lines >= 0 
        ? args.context_lines 
        : 3;

    // Split lines
    const linesA = txtA.split('\n');
    const linesB = txtB.split('\n');

    // Optimization: Trim common leading and trailing lines
    let startA = 0;
    let startB = 0;
    while (startA < linesA.length && startB < linesB.length && linesA[startA] === linesB[startB]) {
        startA++;
        startB++;
    }

    let endA = linesA.length - 1;
    let endB = linesB.length - 1;
    while (endA >= startA && endB >= startB && linesA[endA] === linesB[endB]) {
        endA--;
        endB--;
    }

    // Core diff using Myers' LCS algorithm on the middle slice
    function computeEdits(a, b, offsetA, offsetB) {
        const N = a.length;
        const M = b.length;
        const MAX = N + M;
        const v = { 1: 0 };
        const trace = [];

        for (let d = 0; d <= MAX; d++) {
            trace.push(Object.assign({}, v));
            for (let k = -d; k <= d; k += 2) {
                let x;
                if (k === -d || (k !== d && (v[k - 1] < v[k + 1]))) {
                    x = v[k + 1];
                } else {
                    x = v[k - 1] + 1;
                }
                let y = x - k;
                while (x < N && y < M && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[k] = x;
                if (x >= N && y >= M) {
                    return backtrack(trace, a, b, offsetA, offsetB);
                }
            }
        }
        return [];
    }

    function backtrack(trace, a, b, offsetA, offsetB) {
        const edits = [];
        let x = a.length;
        let y = b.length;

        for (let d = trace.length - 1; d > 0; d--) {
            const k = x - y;
            let prevK;
            if (k === -d || (k !== d && (trace[d - 1][k - 1] < trace[d - 1][k + 1]))) {
                prevK = k + 1;
            } else {
                prevK = k - 1;
            }
            const prevX = trace[d - 1][prevK];
            const prevY = prevX - prevK;

            while (x > prevX && y > prevY) {
                edits.unshift({ type: 'keep', lineA: offsetA + x, lineB: offsetB + y, text: a[x - 1] });
                x--;
                y--;
            }

            if (d > 0) {
                if (x === prevX) {
                    edits.unshift({ type: 'add', lineB: offsetB + y, text: b[y - 1] });
                    y--;
                } else if (y === prevY) {
                    edits.unshift({ type: 'delete', lineA: offsetA + x, text: a[x - 1] });
                    x--;
                }
            }
        }

        while (x > 0 && y > 0) {
            edits.unshift({ type: 'keep', lineA: offsetA + x, lineB: offsetB + y, text: a[x - 1] });
            x--;
            y--;
        }
        return edits;
    }

    // Assemble full edits list
    const fullEdits = [];
    
    // 1. Common prefix
    for (let i = 0; i < startA; i++) {
        fullEdits.push({ type: 'keep', lineA: i + 1, lineB: i + 1, text: linesA[i] });
    }

    // 2. Modified middle section
    const middleA = linesA.slice(startA, endA + 1);
    const middleB = linesB.slice(startB, endB + 1);
    const middleEdits = computeEdits(middleA, middleB, startA, startB);
    fullEdits.push(...middleEdits);

    // 3. Common suffix
    for (let i = endA + 1; i < linesA.length; i++) {
        const lineBIdx = endB + 1 + (i - (endA + 1));
        fullEdits.push({ type: 'keep', lineA: i + 1, lineB: lineBIdx + 1, text: linesA[i] });
    }

    // Group into Unified Diff Hunks
    const changeIndices = [];
    let additions = 0;
    let deletions = 0;

    for (let i = 0; i < fullEdits.length; i++) {
        if (fullEdits[i].type === 'add') {
            additions++;
            changeIndices.push(i);
        } else if (fullEdits[i].type === 'delete') {
            deletions++;
            changeIndices.push(i);
        }
    }

    if (changeIndices.length === 0) {
        return `Files are identical: '${args.file_a}' and '${args.file_b}'.`;
    }

    // Cluster change indices within context range
    const hunks = [];
    let currentHunk = [changeIndices[0]];

    for (let i = 1; i < changeIndices.length; i++) {
        const prev = changeIndices[i - 1];
        const curr = changeIndices[i];
        if (curr - prev <= (contextSize * 2)) {
            currentHunk.push(curr);
        } else {
            hunks.push(currentHunk);
            currentHunk = [curr];
        }
    }
    hunks.push(currentHunk);

    // Format output
    const output = [
        `--- a/${args.file_a}`,
        `+++ b/${args.file_b}`,
        `@@ Summary: +${additions} additions, -${deletions} deletions across ${hunks.length} hunk(s) @@`
    ];

    for (const hunk of hunks) {
        const firstChangeIdx = hunk[0];
        const lastChangeIdx = hunk[hunk.length - 1];

        const startIdx = Math.max(0, firstChangeIdx - contextSize);
        const endIdx = Math.min(fullEdits.length - 1, lastChangeIdx + contextSize);

        const hunkSlice = fullEdits.slice(startIdx, endIdx + 1);

        // Calculate line counts for header
        let aCount = 0;
        let bCount = 0;
        let aStart = null;
        let bStart = null;

        for (const item of hunkSlice) {
            if (item.type === 'keep') {
                if (aStart === null) aStart = item.lineA;
                if (bStart === null) bStart = item.lineB;
                aCount++;
                bCount++;
            } else if (item.type === 'delete') {
                if (aStart === null) aStart = item.lineA;
                aCount++;
            } else if (item.type === 'add') {
                if (bStart === null) bStart = item.lineB;
                bCount++;
            }
        }

        output.push(`@@ -${aStart || 1},${aCount} +${bStart || 1},${bCount} @@`);

        for (const item of hunkSlice) {
            if (item.type === 'keep') {
                output.push(`  ${item.text}`);
            } else if (item.type === 'delete') {
                output.push(`- ${item.text}`);
            } else if (item.type === 'add') {
                output.push(`+ ${item.text}`);
            }
        }
    }

    return api.cleanupText(output.join('\n'));
}