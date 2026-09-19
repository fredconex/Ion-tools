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

    // 3. Check if both files are empty
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

    // 4. Line Interning: Map each unique string to a 32-bit integer ID for O(1) comparisons
    const stringMap = new Map();
    function intern(str) {
        let id = stringMap.get(str);
        if (id === undefined) {
            id = stringMap.size;
            stringMap.set(str, id);
        }
        return id;
    }

    const idsA = new Int32Array(linesA.length);
    for (let i = 0; i < linesA.length; i++) idsA[i] = intern(linesA[i]);

    const idsB = new Int32Array(linesB.length);
    for (let i = 0; i < linesB.length; i++) idsB[i] = intern(linesB[i]);

    const fullEdits = [];

    // Binary-search Longest Increasing Subsequence (LIS) for Patience Diff anchors
    function computeLIS(items) {
        const n = items.length;
        if (n === 0) return [];

        const tails = [];
        const prev = new Int32Array(n);
        prev.fill(-1);

        for (let i = 0; i < n; i++) {
            const val = items[i].bIdx;
            let l = 0, r = tails.length - 1;
            let pos = tails.length;
            while (l <= r) {
                const mid = (l + r) >> 1;
                if (items[tails[mid]].bIdx >= val) {
                    pos = mid;
                    r = mid - 1;
                } else {
                    l = mid + 1;
                }
            }

            if (pos > 0) prev[i] = tails[pos - 1];
            if (pos === tails.length) tails.push(i);
            else tails[pos] = i;
        }

        const res = [];
        let curr = tails[tails.length - 1];
        while (curr !== -1) {
            res.push(items[curr]);
            curr = prev[curr];
        }
        res.reverse();
        return res;
    }

    // Fast Myers LCS using TypedArrays for small sub-slices (O(ND) without GC overhead)
    function myersSmall(startA, endA, startB, endB) {
        const lenA = endA - startA + 1;
        const lenB = endB - startB + 1;
        const maxD = lenA + lenB;
        const offset = maxD;

        const v = new Int32Array(2 * maxD + 1);
        v.fill(-1);
        v[offset + 1] = 0;

        const trace = [];

        for (let d = 0; d <= maxD; d++) {
            const snapshot = new Int32Array(2 * d + 1);
            snapshot.set(v.subarray(offset - d, offset + d + 1));
            trace.push(snapshot);

            for (let k = -d; k <= d; k += 2) {
                const kIdx = offset + k;
                let x;
                if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
                    x = v[kIdx + 1];
                } else {
                    x = v[kIdx - 1] + 1;
                }
                let y = x - k;

                while (x < lenA && y < lenB && idsA[startA + x] === idsB[startB + y]) {
                    x++;
                    y++;
                }
                v[kIdx] = x;

                if (x >= lenA && y >= lenB) {
                    // Backtrack with push() + reverse() to avoid O(N^2) unshift
                    const localEdits = [];
                    let cx = lenA;
                    let cy = lenB;

                    for (let cd = d; cd > 0; cd--) {
                        const prevTrace = trace[cd - 1];
                        const prevOff = cd - 1;
                        const ck = cx - cy;
                        let prevK;

                        if (ck === -cd || (ck !== cd && prevTrace[prevOff + ck - 1] < prevTrace[prevOff + ck + 1])) {
                            prevK = ck + 1;
                        } else {
                            prevK = ck - 1;
                        }

                        const prevX = prevTrace[prevOff + prevK];
                        const prevY = prevX - prevK;

                        while (cx > prevX && cy > prevY) {
                            cx--; cy--;
                            localEdits.push({ type: 'keep', lineA: startA + cx + 1, lineB: startB + cy + 1, text: linesA[startA + cx] });
                        }

                        if (cx === prevX) {
                            cy--;
                            localEdits.push({ type: 'add', lineA: startA + cx + 1, lineB: startB + cy + 1, text: linesB[startB + cy] });
                        } else {
                            cx--;
                            localEdits.push({ type: 'delete', lineA: startA + cx + 1, lineB: startB + cy + 1, text: linesA[startA + cx] });
                        }
                    }

                    while (cx > 0 && cy > 0) {
                        cx--; cy--;
                        localEdits.push({ type: 'keep', lineA: startA + cx + 1, lineB: startB + cy + 1, text: linesA[startA + cx] });
                    }

                    localEdits.reverse();
                    return localEdits;
                }
            }
        }
        return [];
    }

    // Core Patience Diff: partitions files along unique matching anchors
    function diffSlice(startA, endA, startB, endB) {
        // 1. Common prefix
        while (startA <= endA && startB <= endB && idsA[startA] === idsB[startB]) {
            fullEdits.push({ type: 'keep', lineA: startA + 1, lineB: startB + 1, text: linesA[startA] });
            startA++;
            startB++;
        }

        // 2. Common suffix
        let suffixCount = 0;
        while (endA >= startA && endB >= startB && idsA[endA] === idsB[endB]) {
            endA--;
            endB--;
            suffixCount++;
        }

        // Base cases
        if (startA > endA) {
            for (let j = startB; j <= endB; j++) {
                fullEdits.push({ type: 'add', lineA: startA + 1, lineB: j + 1, text: linesB[j] });
            }
        } else if (startB > endB) {
            for (let i = startA; i <= endA; i++) {
                fullEdits.push({ type: 'delete', lineA: i + 1, lineB: startB + 1, text: linesA[i] });
            }
        } else {
            // Find unique lines in both slices
            const countA = new Map();
            for (let i = startA; i <= endA; i++) {
                const id = idsA[i];
                countA.set(id, (countA.get(id) || 0) + 1);
            }

            const countB = new Map();
            const posB = new Map();
            for (let j = startB; j <= endB; j++) {
                const id = idsB[j];
                countB.set(id, (countB.get(id) || 0) + 1);
                posB.set(id, j);
            }

            const uniqueMatches = [];
            for (let i = startA; i <= endA; i++) {
                const id = idsA[i];
                if (countA.get(id) === 1 && countB.get(id) === 1) {
                    uniqueMatches.push({ aIdx: i, bIdx: posB.get(id) });
                }
            }

            if (uniqueMatches.length > 0) {
                // Anchored via Longest Increasing Subsequence
                const anchors = computeLIS(uniqueMatches);
                let curA = startA;
                let curB = startB;

                for (let k = 0; k < anchors.length; k++) {
                    const match = anchors[k];
                    diffSlice(curA, match.aIdx - 1, curB, match.bIdx - 1);
                    fullEdits.push({ type: 'keep', lineA: match.aIdx + 1, lineB: match.bIdx + 1, text: linesA[match.aIdx] });
                    curA = match.aIdx + 1;
                    curB = match.bIdx + 1;
                }
                diffSlice(curA, endA, curB, endB);
            } else {
                // Check if slices have ANY common lines
                let hasCommon = false;
                for (const id of countA.keys()) {
                    if (countB.has(id)) {
                        hasCommon = true;
                        break;
                    }
                }

                if (!hasCommon || (endA - startA + 1) * (endB - startB + 1) > 2000000) {
                    // Fast path: disjoint sets or oversized repeated blocks
                    for (let i = startA; i <= endA; i++) {
                        fullEdits.push({ type: 'delete', lineA: i + 1, lineB: startB + 1, text: linesA[i] });
                    }
                    for (let j = startB; j <= endB; j++) {
                        fullEdits.push({ type: 'add', lineA: endA + 1, lineB: j + 1, text: linesB[j] });
                    }
                } else {
                    // Small subproblem without unique lines: fallback to Myers LCS
                    const edits = myersSmall(startA, endA, startB, endB);
                    fullEdits.push(...edits);
                }
            }
        }

        // Add back trimmed suffix
        for (let s = 0; s < suffixCount; s++) {
            const idxA = endA + 1 + s;
            const idxB = endB + 1 + s;
            fullEdits.push({ type: 'keep', lineA: idxA + 1, lineB: idxB + 1, text: linesA[idxA] });
        }
    }

    diffSlice(0, linesA.length - 1, 0, linesB.length - 1);

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

    return typeof api.cleanupText === 'function' ? api.cleanupText(output.join('\n')) : output.join('\n');
}
