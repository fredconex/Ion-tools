// py_exec_file - tool definition
const TOOL_META = {
    name: "py_run",
    description: "Execute Python code directly (via 'code') or run an existing script from the workspace (via 'filepath') in an in-browser Pyodide (WebAssembly) sandbox.\n\nENVIRONMENT & PYODIDE CONSTRAINTS (NOT full native Python):\n- Client-Side Wasm Sandbox: Runs in Pyodide on WebAssembly inside the browser, NOT on a native operating system or server.\n- Single-Threaded / CPU Only: No multiprocessing, threading, or OS signals. GPU/CUDA acceleration is not available.\n- No Subprocesses / Shell: Commands like `subprocess`, `os.system`, or shell pipelines will fail.\n- Supported Packages: Out-of-the-box support for Pyodide-compiled packages including numpy, scipy, pandas, matplotlib, scikit-learn, sympy (auto-loaded on import). Pure-Python packages can be installed via micropip if network access is enabled.\n- Unsupported Packages: Native C-extensions not ported to Pyodide (e.g., PyTorch, TensorFlow, OpenCV) are NOT supported.\n- Network: Python has no network access by default.\n- File & Figure Sync: Files written to the virtual filesystem and matplotlib plots are automatically captured and synced.\n- Figures: Matplotlib figures are shown to the user, but you cannot see them. The output log lists which images were displayed; print key values (numbers, summaries) if you need to reason about a plot.",
    parameters: {
        type: "object",
        properties: {
            code: {
                type: "string",
                description: "Inline Python code to execute directly in the Pyodide WebAssembly environment. Provide either 'code' or 'filepath'."
            },
            filepath: {
                type: "string",
                description: "Path to a Python file in the workspace / explorer (e.g. 'train.py'). If 'code' is also provided, this specifies the virtual filename (defaults to 'snippet.py')."
            },
            args: {
                type: "array",
                items: { type: "string" },
                description: "Optional command-line arguments to pass as sys.argv[1:]"
            },
            timeout: {
                type: "number",
                description: "Seconds before execution is stopped (default 120, max 270)."
            }
        }
    },
    modes: ["ask", "code"],
    permission: "ask",
    toolBox: 1,
    "expanded": true,
    // The default tool ceiling is 30 s, which is too short for loading Pyodide or training a model.
    // The interactive flag raises the ceiling to 5 minutes.
    interactive: true,
    settings: [
        {
            key: "pyodideVersion",
            label: "Pyodide version",
            type: "text",
            default: "314.0.7"
        },
        {
            key: "indexUrl",
            label: "Pyodide base URL (optional; leave empty to use the jsDelivr CDN)",
            type: "text",
            default: ""
        },
        {
            key: "allowNetwork",
            label: "Allow Python code to use the network (fetch / micropip)",
            type: "boolean",
            default: false
        }
    ]
};

// --- Limits ------------------------------------------------------------------
const PY_MAX_OUTPUT_CHARS = 8000;
const PY_MAX_TIMEOUT_S = 270;               // Ion's interactive ceiling is 300 s; leave room for load + sync
const PY_INIT_TIMEOUT_MS = 150000;
const PY_TOTAL_BUDGET_MS = 285000;           // Ion stops interactive tools at 300 s
const PY_MAX_TEXT_FILE = 16 * 1024 * 1024;
const PY_MAX_BIN_FILE = 32 * 1024 * 1024;
const PY_MAX_TOTAL = 128 * 1024 * 1024;
const PY_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const PY_BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|npy|npz|pkl|pickle|parquet|feather|h5|hdf5|joblib|bin|onnx|wav|mp3|mp4|woff2?|ttf|otf)$/i;

// --- UI helpers --------------------------------------------------------------
function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clip(text, limit = PY_MAX_OUTPUT_CHARS) {
    if (text.length <= limit) return text;
    const head = Math.floor(limit / 5);
    const tail = limit - head;
    return `${text.slice(0, head)}\n...[${text.length - limit} chars omitted]...\n${text.slice(-tail)}`;
}

function bytesToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

// --- Python side (runs inside Pyodide) --------------------------------------
const PY_HARNESS = String.raw`
import sys, os, json, shutil, time, traceback, warnings, io, base64
# Matplotlib 3.10 emits this from its own Agg text rendering (float x/y); harmless until 3.12.
warnings.filterwarnings("ignore", message=r"The [xy] parameter as float", category=DeprecationWarning)
os.environ["MPLBACKEND"] = "Agg"
sys.dont_write_bytecode = True
WS = "/workspace"
os.makedirs(WS, exist_ok=True)
_FIG_N = [0]
_SHOWN_FIGS = []

def _ion_reset():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        try:
            plt.close("all")   # never leak open figures into the next run
        except Exception:
            pass
    _SHOWN_FIGS.clear()
    os.chdir("/")
    shutil.rmtree(WS, ignore_errors=True)
    os.makedirs(WS, exist_ok=True)
    os.chdir(WS)
    if WS not in sys.path:
        sys.path.insert(0, WS)
    # Forget modules imported from the workspace so edited files are re-read on the next run.
    for name, mod in list(sys.modules.items()):
        try:
            f = getattr(mod, "__file__", None)
            if isinstance(f, str) and f.startswith(WS + "/"):
                del sys.modules[name]
        except Exception:
            pass
    import importlib
    importlib.invalidate_caches()
    mpl = sys.modules.get("matplotlib")
    if mpl is not None:
        try:
            mpl.rcdefaults()
        except Exception:
            pass

def _ion_capture_figs():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        if not fig.get_axes():
            continue
        # If user explicitly called fig.savefig, it will be synced from disk; do not duplicate
        if getattr(fig, "_ion_saved", False):
            continue
        _FIG_N[0] += 1
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=110)
        _SHOWN_FIGS.append({
            "path": "Figure %d" % _FIG_N[0],
            "mime": "image/png",
            "base64": base64.b64encode(buf.getvalue()).decode("ascii")
        })
    plt.close("all")

def _ion_get_shown_figs():
    return json.dumps(_SHOWN_FIGS)

def _ion_patch_mpl():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    def _show(*a, **k):
        # .show() captures in-memory only; does NOT save to the filesystem
        _ion_capture_figs()
    plt.show = _show
    from matplotlib.figure import Figure
    if not getattr(Figure.savefig, "_ion_wrapped", False):
        _orig_savefig = Figure.savefig
        def _savefig(self, *a, **k):
            # Matplotlib 3.10 warns about float x/y in its Agg text rendering; harmless until 3.12.
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=r"The [xy] parameter as float", category=DeprecationWarning)
                r = _orig_savefig(self, *a, **k)
            try:
                self._ion_saved = True
            except Exception:
                pass
            return r
        _savefig._ion_wrapped = True
        Figure.savefig = _savefig

def _ion_list():
    out = []
    for root, dirs, files in os.walk(WS):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            if f.endswith(".pyc"):
                continue
            out.append(os.path.relpath(os.path.join(root, f), WS).replace(os.sep, "/"))
    return json.dumps(out)

async def _ion_run(code, path, argv_json):
    from pyodide.code import eval_code_async
    sys.argv = json.loads(argv_json)
    ns = {"__name__": "__main__", "__file__": path, "__builtins__": __builtins__}
    out = {"status": "ok", "text": "", "result": None}
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message=r"The [xy] parameter as float", category=DeprecationWarning)
            res = await eval_code_async(code, ns, filename=path)
        if res is not None:
            out["result"] = repr(res)
    except SystemExit as e:
        out["status"] = "exit"
        out["text"] = repr(e.code)
    except BaseException as e:
        out["status"] = "error"
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != path:
            tb = tb.tb_next
        if tb is None:
            tb = e.__traceback__
        out["text"] = "".join(traceback.format_exception(type(e), e, tb))
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    return json.dumps(out)
`;

// --- Worker side (stringified into a Web Worker; keep self-contained) -------
function __pyWorkerMain() {
    let py = null;
    const post = (m, t) => self.postMessage(m, t || []);

    function blockNetwork() {
        const saved = {};
        const msg = 'Network access is disabled for Python in this tool (enable "Allow Python code to use the network" in the tool settings).';
        for (const n of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport', 'Worker', 'SharedWorker', 'importScripts']) {
            if (!(n in self)) continue;
            saved[n] = self[n];
            try { self[n] = (n === 'fetch') ? () => Promise.reject(new Error(msg)) : function () { throw new Error(msg); }; } catch (e) { /* ignore */ }
        }
        return { restore() { for (const n in saved) { try { self[n] = saved[n]; } catch (e) { /* ignore */ } } } };
    }

    async function init(m) {
        post({ type: 'status', text: 'Starting Pyodide runtime (WebAssembly)...' });

        if (typeof self.importScripts === 'function') {
            const _origImportScripts = self.importScripts.bind(self);
            self.importScripts = function (...args) {
                if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('data:')) {
                    throw new TypeError("data: URI importScripts disabled for module compatibility");
                }
                return _origImportScripts(...args);
            };
        }

        let loader;
        try {
            const mod = await import(m.indexURL + 'pyodide.mjs');
            loader = mod.loadPyodide;
        } catch (e) {
            try {
                if (typeof self.importScripts === 'function') {
                    self.importScripts(m.indexURL + 'pyodide.js');
                    loader = self.loadPyodide;
                }
            } catch (_) { }
            if (!loader) throw e;
        }

        py = await loader({ indexURL: m.indexURL });
        py.setStdin({ stdin: () => null });
        py.setStdout({ batched: (s) => post({ type: 'out', text: s + '\n' }) });
        py.setStderr({ batched: (s) => post({ type: 'out', text: s + '\n' }) });
        py.runPython(m.harness);
        return { version: py.version };
    }

    async function run(m) {
        const FS = py.FS;
        const dec = new TextDecoder();
        py.globals.get('_ion_reset')();

        const before = new Map();
        for (const f of m.files) {
            const slash = f.path.lastIndexOf('/');
            if (slash > 0) FS.mkdirTree('/workspace/' + f.path.slice(0, slash));
            FS.writeFile('/workspace/' + f.path, f.data);
            before.set(f.path, f.data);
        }

        await new Promise(r => setTimeout(r, 3));

        post({ type: 'status', text: 'Checking imports...' });
        const sources = [m.code];
        for (const f of m.files) {
            if (/\.py$/.test(f.path) && f.data.length < 300000 && f.path !== m.path) sources.push(dec.decode(f.data));
        }
        const cb = {
            messageCallback: (t) => post({ type: 'status', text: String(t) }),
            errorCallback: (t) => post({ type: 'out', text: String(t) + '\n' })
        };
        for (const s of sources) {
            try { await py.loadPackagesFromImports(s, cb); } catch (e) { post({ type: 'out', text: 'Package load problem: ' + (e && e.message || e) + '\n' }); }
        }
        if (py.loadedPackages && py.loadedPackages.matplotlib) py.globals.get('_ion_patch_mpl')();

        post({ type: 'status', text: 'Running ' + m.path + ' in Pyodide...' });
        const net = m.allowNetwork ? null : blockNetwork();
        let res;
        try {
            res = JSON.parse(await py.globals.get('_ion_run')(m.code, m.path, JSON.stringify(m.argv)));
        } finally {
            if (net) net.restore();
        }

        // Render any figures left unclosed in memory for preview (without saving to workspace disk)
        if (py.loadedPackages && py.loadedPackages.matplotlib) {
            try { py.globals.get('_ion_capture_figs')(); } catch (_) {}
        }
        let shown = [];
        if (py.loadedPackages && py.loadedPackages.matplotlib) {
            try { shown = JSON.parse(py.globals.get('_ion_get_shown_figs')() || '[]'); } catch (_) {}
        }

        const MAXF = 32 * 1024 * 1024;
        const skipped = [];
        const changed = [];
        for (const p of JSON.parse(py.globals.get('_ion_list')())) {
            const data = FS.readFile('/workspace/' + p);
            if (data.length > MAXF) { skipped.push(p); continue; }
            const prev = before.get(p);
            if (!prev || prev.length !== data.length || !prev.every((v, i) => v === data[i])) {
                changed.push({ path: p, data });
            }
        }
        py.globals.get('_ion_reset')();
        post({ id: m.id, type: 'result', res, files: changed, shown, skipped }, changed.map(c => c.data.buffer));
    }

    self.onmessage = async (e) => {
        const m = e.data;
        try {
            if (m.type === 'init') post({ id: m.id, type: 'ready', info: await init(m) });
            else if (m.type === 'run') await run(m);
        } catch (err) {
            post({ id: m.id, type: 'error', message: String((err && err.message) || err), fatal: true });
        }
    };
}

// --- Main-thread-of-tool-worker side: runtime lifecycle ----------------------
function pyKill() {
    const st = self.__ionPy;
    self.__ionPy = null;
    if (!st) return;
    st.alive = false;
    try { st.worker.terminate(); } catch (e) { /* ignore */ }
    try { URL.revokeObjectURL(st.url); } catch (e) { /* ignore */ }
    for (const l of [...st.listeners]) l({ type: 'fatal', message: 'Pyodide runtime was stopped.' });
}

// The Pyodide worker is cached on `self` and survives tool reloads, so a changed harness would never
// take effect. This signature changes whenever the harness or worker code changes and forces a restart.
const PY_RUNTIME_SIG = (function () {
    const src = PY_HARNESS + __pyWorkerMain.toString();
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
})();

function pyGet(indexURL) {
    let st = self.__ionPy;
    if (st && st.alive && st.indexURL === indexURL && st.sig === PY_RUNTIME_SIG) return st;
    if (st) pyKill();
    if (typeof Worker === 'undefined') throw new Error('This browser cannot start nested Web Workers, which the Python runtime needs.');
    const url = URL.createObjectURL(new Blob(['(' + __pyWorkerMain.toString() + ')()'], { type: 'application/javascript' }));
    
    const worker = new Worker(url);

    st = { worker, url, indexURL, sig: PY_RUNTIME_SIG, alive: true, seq: 0, listeners: new Set(), ready: null };
    worker.onmessage = (e) => { for (const l of [...st.listeners]) l(e.data); };
    worker.onerror = (e) => {
        const msg = (e && e.message) ? e.message : 'Pyodide runtime crashed (nested worker error)';
        st.alive = false;
        for (const l of [...st.listeners]) l({ type: 'fatal', message: msg });
    };
    self.__ionPy = st;
    return st;
}

function pyCall(st, msg, transfer, onEvent, timeoutMs, timeoutMessage) {
    const id = ++st.seq;
    return new Promise((resolve, reject) => {
        let timer = null;
        const done = (fn, v) => { clearTimeout(timer); st.listeners.delete(listener); fn(v); };
        const listener = (d) => {
            if (d.type === 'fatal') return done(reject, new Error(d.message));
            if (d.id === id) {
                if (d.type === 'error') return done(reject, Object.assign(new Error(d.message), { fatalRuntime: !!d.fatal }));
                return done(resolve, d);
            }
            if (onEvent && (d.type === 'status' || d.type === 'out')) onEvent(d);
        };
        st.listeners.add(listener);
        if (timeoutMs) timer = setTimeout(() => done(reject, Object.assign(new Error(timeoutMessage || 'timeout'), { timedOut: true })), timeoutMs);
        st.worker.postMessage({ ...msg, id }, transfer || []);
    });
}

function pyExclusive(fn) {
    const prev = self.__ionPyLock || Promise.resolve();
    const next = prev.catch(() => { }).then(fn);
    self.__ionPyLock = next.catch(() => { });
    return next;
}

async function gatherWorkspace(api, targetPath, code, notes) {
    const enc = new TextEncoder();
    const files = new Map();
    let total = 0;
    const paths = (typeof api?.listFiles === 'function') ? await api.listFiles() : [];
    const wanted = paths.filter(p => typeof p === 'string' && p !== targetPath &&
        !p.startsWith('.agent') && !p.startsWith('.ion') && !p.startsWith('.git/') && !p.includes('node_modules/'));

    const load = async (fp) => {
        try {
            let data;
            const binary = PY_BINARY_EXT.test(fp) || (typeof api.isBinary === 'function' && await api.isBinary(fp));
            if (binary && typeof api.readFileBytes === 'function') {
                const b = await api.readFileBytes(fp);
                if (!(b instanceof Uint8Array)) return;
                if (b.length > PY_MAX_BIN_FILE) { notes.push(`skipped ${fp} (larger than ${PY_MAX_BIN_FILE >> 20} MB)`); return; }
                data = b;
            } else {
                const t = await api.readFile(fp);
                if (typeof t !== 'string' || t.startsWith('ERROR:')) return;
                if (t.length > PY_MAX_TEXT_FILE) { notes.push(`skipped ${fp} (larger than ${PY_MAX_TEXT_FILE >> 20} MB)`); return; }
                data = enc.encode(t);
            }
            if (total + data.length > PY_MAX_TOTAL) { notes.push(`skipped ${fp} (workspace snapshot limit reached)`); return; }
            total += data.length;
            files.set(fp, data);
        } catch (e) { /* unreadable file: skip */ }
    };
    for (let i = 0; i < wanted.length; i += 6) await Promise.all(wanted.slice(i, i + 6).map(load));
    files.set(targetPath, enc.encode(code));
    return files;
}

async function ensureParentDir(api, filePath) {
    const slash = filePath.lastIndexOf('/');
    if (slash <= 0) return;
    const dir = filePath.slice(0, slash);
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        for (const method of ['mkdir', 'createDirectory', 'createFolder', 'mkdirp', 'mkdirTree']) {
            if (typeof api?.[method] === 'function') {
                try { await api[method](cur); } catch (_) {}
                break;
            }
        }
    }
}

async function handler(args, api) {
    let lastHeader = 0;
    const updateStatus = (msg, force) => {
        const now = Date.now();
        if (!force && now - lastHeader < 400) return;
        lastHeader = now;
        if (typeof api?.setHeaderMsg === 'function') api.setHeaderMsg(msg);
    };

    const inlineCode = typeof args.code === 'string' ? args.code : null;
    let targetPath = typeof args.filepath === 'string' && args.filepath.trim() ? args.filepath.trim() : '';

    if (inlineCode === null && !targetPath) {
        return { output: "ERROR: Either 'code' or 'filepath' parameter must be provided." };
    }

    if (!targetPath) {
        targetPath = 'snippet.py';
    }

    let code = inlineCode;
    if (code === null) {
        updateStatus(`Reading ${targetPath}...`, true);
        try {
            if (typeof api?.readFile === 'function') code = await api.readFile(targetPath);
            if (code === undefined && typeof api?.readFileBytes === 'function') {
                code = new TextDecoder('utf-8').decode(await api.readFileBytes(targetPath));
            }
        } catch (e) {
            return { output: `ERROR: Failed reading ${targetPath}: ${e.message}` };
        }
        if (!code || code.startsWith("ERROR:")) {
            return { output: `ERROR: Could not read script '${targetPath}'.` };
        }
    } else {
        updateStatus(`Executing inline code in Pyodide...`, true);
    }

    const version = String(await api?.getSetting?.('pyodideVersion') || '314.0.7').trim();
    const custom = String(await api?.getSetting?.('indexUrl') || '').trim();

    if (!custom && !/^\d+(\.\d+){1,2}([-.][A-Za-z0-9.]+)?$/.test(version)) {
        return { output: `ERROR: Invalid Pyodide version '${version}'.` };
    }
    if (custom && !/^https?:\/\//i.test(custom)) {
        return { output: "ERROR: 'Pyodide base URL' must start with http:// or https://." };
    }
    const indexURL = (custom || `https://cdn.jsdelivr.net/pyodide/v${version}/full/`).replace(/\/*$/, '/');
    const allowNetwork = !!(await api?.getSetting?.('allowNetwork'));
    const timeoutS = Math.max(1, Math.min(PY_MAX_TIMEOUT_S, Number(args.timeout) || 120));
    const argv = [targetPath, ...(Array.isArray(args.args) ? args.args.map(String) : [])];

    updateStatus('Collecting workspace files...', true);
    const notes = [];
    const files = await gatherWorkspace(api, targetPath, code, notes);
    const fileList = [...files.entries()].map(([path, data]) => ({ path, data }));

    let out = '';
    let outcome;
    const startedAt = Date.now();
    let runLimitS = timeoutS;
    try {
        outcome = await pyExclusive(async () => {
            const st = pyGet(indexURL);
            const onEvent = (d) => {
                if (d.type === 'status') updateStatus(d.text);
                else if (d.type === 'out') {
                    out += d.text;
                    const line = d.text.trim().split('\n').pop();
                    if (line) updateStatus('> ' + line.slice(0, 90));
                }
            };
            if (!st.ready) {
                updateStatus('Loading Pyodide runtime (first run can take 10-30 s)...', true);
                st.ready = pyCall(st, { type: 'init', indexURL, harness: PY_HARNESS }, [], onEvent, PY_INIT_TIMEOUT_MS,
                    'Timed out while loading the Pyodide runtime. Check your connection or the Pyodide URL setting.');
                st.ready.catch(() => { });
            }
            try { await st.ready; } catch (e) { pyKill(); throw e; }
            const transfer = fileList.map(f => f.data.buffer);
            runLimitS = Math.max(5, Math.min(timeoutS, Math.floor((startedAt + PY_TOTAL_BUDGET_MS - Date.now()) / 1000) - 8));
            try {
                return await pyCall(st, { type: 'run', code, path: targetPath, argv, files: fileList, allowNetwork },
                    transfer, onEvent, runLimitS * 1000, 'exec-timeout');
            } catch (e) {
                pyKill();
                throw e;
            }
        });
    } catch (e) {
        if (e.timedOut && e.message === 'exec-timeout') {
            out += `\n[Execution exceeded ${runLimitS}s and was stopped. The Pyodide runtime was restarted.]`;
            return finish(out, [], [], {}, notes, targetPath, api, startedAt, 'timeout', updateStatus, args, code);
        }
        return { output: `ERROR: ${e.message}` };
    }

    const r = outcome.res || {};
    if (r.status === 'error') {
        out += (out && !out.endsWith('\n') ? '\n' : '') + (r.text || '');
        if (/ModuleNotFoundError|No module named/.test(r.text || '')) {
            out += "\n[Hint: You are running Pyodide (Wasm). Only pre-built Pyodide packages load automatically. Pure-Python wheels can be installed with `import micropip; await micropip.install('name')` if network access is enabled. Packages requiring C-extensions, CUDA/GPU, or multiprocessing (like PyTorch, TensorFlow) cannot run in Pyodide.]";
        }
        if (/Network access is disabled/.test(r.text || '')) out += '\n[Network access is disabled for Python by default.]';
    } else if (r.status === 'exit' && r.text && r.text !== '0' && r.text !== 'None') {
        out += `\n[Script exited with code ${r.text}]`;
    } else if (r.result) {
        out += (out && !out.endsWith('\n') ? '\n' : '') + r.result;
    }
    for (const s of outcome.skipped || []) notes.push(`not synced back: ${s} (larger than 32 MB)`);
    return finish(out, outcome.files || [], outcome.shown || [], r, notes, targetPath, api, startedAt, r.status || 'ok', updateStatus, args, code);
}

async function finish(out, changedFiles, shownImages, r, notes, targetPath, api, startedAt, status, updateStatus, args, code) {
    updateStatus('Syncing files...', true);
    const images = [];
    const seenImages = new Set();
    const imgKey = (u8) => { let h = 2166136261; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); } return u8.length + ':' + (h >>> 0); };
    const synced = [];
    const dec = new TextDecoder('utf-8', { fatal: true });

    // 1. Figures explicitly saved to disk by the user (via plt.savefig)
    for (const f of changedFiles) {
        if (f.path === targetPath || !PY_IMAGE_EXT.test(f.path) || images.length >= 6 || f.data.length >= 6 * 1024 * 1024) continue;
        const key = imgKey(f.data);
        if (seenImages.has(key)) continue;
        seenImages.add(key);
        const ext = f.path.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        images.push({ path: f.path, mime, base64: bytesToB64(f.data) });
    }

    // 2. In-memory figures displayed via plt.show() (never saved to files)
    for (const s of (shownImages || [])) {
        if (images.length >= 6) continue;
        images.push({ path: s.path || 'plot', mime: s.mime || 'image/png', base64: s.base64 });
    }

    // Tell the LLM (and the terminal log) which images were displayed to the user
    if (images.length) {
        out += (out && !out.endsWith('\n') ? '\n' : '') +
            `[${images.length} image${images.length > 1 ? 's' : ''} displayed to the user: ${images.map(i => i.path).join(', ')}]`;
    }

    // Only files that were explicitly saved to the filesystem get synced to the workspace
    for (const f of changedFiles) {
        if (f.path === targetPath) continue;
        try {
            await ensureParentDir(api, f.path);
            let content = f.data;
            if (!PY_BINARY_EXT.test(f.path)) {
                try { content = dec.decode(f.data); } catch (e) { content = f.data; }
            }
            if (typeof api?.writeFile === 'function') {
                let res;
                let writeErr = null;
                try {
                    res = await api.writeFile(f.path, content);
                } catch (e) {
                    writeErr = e;
                }

                const hasErr = writeErr || (typeof res === 'string' && res.startsWith('ERROR:'));
                if (hasErr && f.path.includes('/')) {
                    // Fallback to workspace root if directory nesting is unsupported
                    const base = f.path.split('/').pop();
                    try {
                        const fbRes = await api.writeFile(base, content);
                        if (typeof fbRes !== 'string' || !fbRes.startsWith('ERROR:')) {
                            synced.push(`${base} (saved to root)`);
                            continue;
                        }
                    } catch (_) {}
                }

                if (writeErr) {
                    notes.push(`sync error on ${f.path}: ${writeErr.message || writeErr}`);
                } else if (typeof res === 'string' && res.startsWith('ERROR:')) {
                    notes.push(`could not write ${f.path}: ${res.replace(/^ERROR:\s*/, '')}`);
                } else {
                    synced.push(f.path);
                }
            }
        } catch (err) {
            notes.push(`sync error on ${f.path}: ${err.message || err}`);
        }
    }

    updateStatus('Done', true);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    let text = clip(out.trim() || '(no output)');
    if (synced.length) text += `\n[files synced to explorer: ${synced.join(', ')}]`;
    if (notes.length) text += `\n[${notes.join('; ')}]`;

    const badge = status === 'timeout' ? ['TIMED OUT', '#e5c07b', 'rgba(229,192,123,0.18)']
        : status === 'error' ? ['ERROR', '#e06c75', 'rgba(224,108,117,0.18)']
        : ['EXECUTED', '#98c379', 'rgba(152,195,121,0.18)'];

    const displayLabel = args?.code && !args?.filepath ? 'inline snippet' : targetPath;

    // Code view: display is capped; a hidden textarea keeps the full source for the copy button.
    const MAX_CODE_LINES = 500;
    const codeStr = String(code || '');
    const codeLines = codeStr.split('\n');
    const codeShown = codeLines.length > MAX_CODE_LINES
        ? codeLines.slice(0, MAX_CODE_LINES).join('\n') +
          `\n\n# ... [showing ${MAX_CODE_LINES} of ${codeLines.length} lines; use Copy for the full source] ...`
        : codeStr;

    // Copies whichever pane is visible (output text or full source)
    const copyJs = `(function(b){
        var c=b.closest('[data-py-card]');
        var k=c.querySelector('[data-py-pane=code]');
        var p=k.style.display==='none'?c.querySelector('[data-py-pane=out]'):k;
        var t=p.querySelector('[data-py-copy]');
        var s=t?(t.value!==undefined?t.value:t.textContent):'';
        var i=b.querySelector('.icon');
        var ok=function(){if(!i)return;var o=i.textContent;i.textContent='check';i.style.color='var(--green,#98c379)';setTimeout(function(){i.textContent=o;i.style.color=''},1500)};
        function fb(){
            var a=document.createElement('textarea');
            a.value=s;a.style.position='fixed';a.style.opacity='0';
            document.body.appendChild(a);a.select();
            try{document.execCommand('copy');ok()}catch(e){}
            document.body.removeChild(a);
        }
        if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(s).then(ok,fb)}else{fb()}
    })(this)`.replace(/\s*\n\s*/g, '');

    // Switches between the output pane and the code pane
    const toggleJs = `(function(b){
        var c=b.closest('[data-py-card]');
        var o=c.querySelector('[data-py-pane=out]');
        var k=c.querySelector('[data-py-pane=code]');
        var cb=c.querySelector('[data-py-copy-btn]');
        var i=b.querySelector('.icon');
        var showCode=k.style.display==='none';
        k.style.display=showCode?'block':'none';
        o.style.display=showCode?'none':'flex';
        i.textContent=showCode?'terminal':'code';
        b.title=showCode?'View output':'View code';
        b.setAttribute('aria-label',b.title);
        if(cb){cb.title=showCode?'Copy code':'Copy output';cb.setAttribute('aria-label',cb.title)}
    })(this)`.replace(/\s*\n\s*/g, '');

    let displayHtml = `<div data-py-card style="width:100%; border:1px solid var(--border,#2e2e2e); border-radius:8px; overflow:hidden; background:var(--bg-panel,#181818); margin:2px 0; font-family:var(--font-mono, monospace);">
        <!-- Top Bar -->
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(0,0,0,0.25); border-bottom:1px solid var(--border,#2e2e2e);">
            <div style="display:flex; align-items:center; gap:7px; font-size:11.5px; color:var(--fg,#dcdfe7);">
                <span class="icon" style="font-size:14px; color:var(--primary,#56b6c2);">play_arrow</span>
                <span style="font-weight:600;">${esc(displayLabel)}</span>
                <span style="font-size:10px; background:${badge[2]}; color:${badge[1]}; padding:1px 6px; border-radius:3px; font-weight:700;">${badge[0]}</span>
                <span style="font-size:10px; color:var(--dim,#737791);">Pyodide &middot; ${secs}s</span>
            </div>
            <div style="display:flex; align-items:center; gap:3px;">
                <!-- 1. Code / Output toggle -->
                <button type="button" class="icon-btn" title="View code" aria-label="View code" onclick="${esc(toggleJs)}">
                    <span class="icon" style="font-size:15px; color:var(--primary,#56b6c2); pointer-events:none;">code</span>
                </button>
                <!-- 2. Copy (output or code, whichever is visible) -->
                <button type="button" class="icon-btn" data-py-copy-btn title="Copy output" aria-label="Copy output" onclick="${esc(copyJs)}">
                    <span class="icon" style="font-size:14px; pointer-events:none;">content_copy</span>
                </button>
            </div>
        </div>
        <div style="padding:8px;">
        <div data-py-pane="out" style="display:flex; flex-direction:column; gap:6px;">`;

    const shown = clip(out.trim());
    if (shown) {
        displayHtml += `<div data-py-copy style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px; white-space:pre-wrap; color:var(--dim,#737791); font-size:11px;">${esc(shown)}</div>`;
    }
    for (const img of images) {
        displayHtml += `<div style="border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:12px; display:flex; justify-content:center; background:#ffffff; margin-top:4px;">
            <img src="data:${img.mime};base64,${img.base64}" style="max-width:100%; border-radius:4px;" />
        </div>`;
    }
    displayHtml += `</div>
        <div data-py-pane="code" style="display:none;">
            <textarea data-py-copy hidden>${esc(codeStr)}</textarea>
            <div style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px; white-space:pre; overflow:auto; max-height:420px; color:var(--fg,#dcdfe7); font-size:11px; line-height:1.5;">${esc(codeShown)}</div>
        </div>
        </div>
    </div>`;
    return { output: text, displayHtml };
}