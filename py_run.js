// py_exec_file - tool definition
const TOOL_META = {
    name: "py_run",
    description: "Execute Python code directly (via 'code') or run an existing script from the workspace (via 'filepath') in an in-browser Pyodide (WebAssembly) sandbox.\n\nENVIRONMENT & PYODIDE CONSTRAINTS (NOT full native Python):\n- Client-Side Wasm Sandbox: Runs in Pyodide on WebAssembly inside the browser, NOT on a native operating system or server.\n- Single-Threaded / CPU Only: No multiprocessing, threading, or OS signals. GPU/CUDA acceleration is not available.\n- No Subprocesses / Shell: Commands like `subprocess`, `os.system`, or shell pipelines will fail.\n- Supported Packages: Out-of-the-box support for Pyodide-compiled packages including numpy, scipy, pandas, matplotlib, scikit-learn, sympy (auto-loaded on import). Pure-Python packages can be installed via micropip if network access is enabled.\n- Unsupported Packages: Native C-extensions not ported to Pyodide (e.g., native TensorFlow, OpenCV) are NOT supported.\n- Network: Python has no network access by default.\n- File & Figure Sync: Files written to the virtual filesystem and matplotlib plots are automatically captured and synced.\n- Figures: Matplotlib figures are shown to the user, but you cannot see them. The output log lists which images were displayed; print key values (numbers, summaries) if you need to reason about a plot.",
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
        }
    },
    modes: ["ask", "code"],
    permission: "ask",
    toolBox: 1,
    "expanded": true,
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
            default: true
        },
        {
            key: "saveFigures",
            label: "Save matplotlib figures to a figures/ folder (synced to the explorer)",
            type: "boolean",
            default: false
        },
        {
            key: "torchShim",
            label: "Enable the embedded CPU-only PyTorch-compatible shim (import torch)",
            type: "boolean",
            default: true
        }
    ]
};

// --- Limits ------------------------------------------------------------------
const PY_MAX_OUTPUT_CHARS = 8000;
const PY_INIT_TIMEOUT_MS = 150000;
const PY_MAX_TEXT_FILE = 16 * 1024 * 1024;
const PY_MAX_BIN_FILE = 32 * 1024 * 1024;
const PY_MAX_TOTAL = 128 * 1024 * 1024;
const PY_IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const PY_BINARY_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|npy|npz|pkl|pickle|parquet|feather|h5|hdf5|joblib|bin|onnx|wav|mp3|mp4|woff2?|ttf|otf)$/i;

// --- Live streaming limits ----------------------------------------------------
const PY_LIVE_TAIL_CHARS = 6000;   // live card shows only the last N chars of output
const PY_LIVE_INTERVAL_MS = 250;   // min time between live frames

// --- Terminal viewport ---------------------------------------------------------
const PY_TERM_LINES = 30;          // terminal shows at most N lines; scrolls beyond that
// 1.5em line-height * N lines + 16px (8px padding top + bottom)
const PY_TERM_BOX = `font-size:11px; line-height:1.5; max-height:calc(${PY_TERM_LINES} * 1.5em + 16px); overflow:auto;`;

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

// --- Embedded PyTorch shim (written to /shim/torch/__init__.py) ----------------
const PY_TORCH_SHIM = String.raw`"""Minimal CPU-only PyTorch-compatible shim on top of NumPy (for Pyodide).
Reverse-mode autograd, hooks, nn, nn.functional, optim, samplers, utils.data."""
import sys, math, types
from collections import OrderedDict, namedtuple
import numpy as np

__version__ = "0.0.3+numpy-shim"
import builtins as _b
_pyfloat, _pyint, _pybool = _b.float, _b.int, _b.bool
float32 = np.float32; float64 = np.float64; float16 = np.float16
int64 = np.int64; int32 = np.int32; int16 = np.int16; int8 = np.int8; uint8 = np.uint8
long = np.int64; double = np.float64; half = np.float16
_ALIASES = {"bool": np.bool_, "float": np.float32, "int": np.int32}
_FUNCS = {}
def __getattr__(name):
    if name in _FUNCS: return _FUNCS[name]
    if name in _ALIASES: return _ALIASES[name]
    raise AttributeError("module 'torch' has no attribute %r" % name)
_GRAD = [True]
_RNG = [np.random.default_rng()]
_DEFAULT = [np.float32]


def manual_seed(s):
    _RNG[0] = np.random.default_rng(s)
    return _RNG[0]
seed = manual_seed


def set_default_dtype(d): _DEFAULT[0] = d
def get_default_dtype(): return _DEFAULT[0]


class _GradMode:
    def __init__(self, mode): self.mode = mode
    def __enter__(self): self.prev = _GRAD[0]; _GRAD[0] = self.mode
    def __exit__(self, *a): _GRAD[0] = self.prev
    def __call__(self, fn):
        def w(*a, **k):
            with _GradMode(self.mode): return fn(*a, **k)
        return w

def no_grad(): return _GradMode(False)
def enable_grad(): return _GradMode(True)
def set_grad_enabled(m): return _GradMode(m)
def is_grad_enabled(): return _GRAD[0]
inference_mode = no_grad


def _unb(g, shape):
    if g.shape == shape: return g
    nd = g.ndim - len(shape)
    if nd > 0: g = g.sum(axis=tuple(range(nd)))
    ax = tuple(i for i, s in enumerate(shape) if s == 1 and g.shape[i] != 1)
    if ax: g = g.sum(axis=ax, keepdims=True)
    return g.reshape(shape)


def _val(x):
    if isinstance(x, Tensor): return x.data
    if isinstance(x, (_pyint, _pyfloat, _pybool)): return x
    return np.asarray(x)


def _mk(out, parents, bw):
    out = np.asarray(out)
    if _GRAD[0] and any(isinstance(p, Tensor) and p.requires_grad for p in parents):
        t = Tensor(out); t.requires_grad = True; t._prev = tuple(parents); t._bw = bw
        return t
    return Tensor(out)


def _axes(dim, nd):
    if dim is None: return None
    if isinstance(dim, (_pyint, np.integer)): dim = (dim,)
    return tuple(sorted(d % nd for d in dim))


class Size(tuple):
    def numel(self):
        n = 1
        for s in self: n *= s
        return n


class _HookHandle:
    def __init__(self, hook_list, hook):
        self.hook_list = hook_list
        self.hook = hook
    def remove(self):
        if self.hook in self.hook_list:
            self.hook_list.remove(self.hook)


class Tensor:
    __array_priority__ = 1000

    def __init__(self, data=(), requires_grad=False, dtype=None):
        if isinstance(data, Tensor): data = data.data
        a = np.asarray(data)
        if dtype is not None: a = a.astype(dtype, copy=False)
        elif a.dtype == np.float64 and not isinstance(data, np.ndarray) and _DEFAULT[0] != np.float64:
            a = a.astype(_DEFAULT[0])
        self.data = a
        self.requires_grad = requires_grad
        self.grad = None
        self._prev = (); self._bw = None
        self._hooks = []

    __hash__ = object.__hash__

    # ---- properties
    @property
    def shape(self): return Size(self.data.shape)
    @property
    def dtype(self): return self.data.dtype
    @property
    def ndim(self): return self.data.ndim
    @property
    def T(self): return self.permute(*range(self.ndim - 1, -1, -1))
    @property
    def is_leaf(self): return self._bw is None
    @property
    def device(self): return "cpu"
    def size(self, dim=None): return self.shape if dim is None else self.data.shape[dim]
    def dim(self): return self.data.ndim
    def numel(self): return self.data.size
    def item(self): return self.data.item()
    def tolist(self): return self.data.tolist()
    def numpy(self): return self.data
    def __array__(self, dtype=None, copy=None): return self.data if dtype is None else self.data.astype(dtype)
    def __len__(self): return self.data.shape[0]
    def __iter__(self):
        for i in range(len(self)): yield self[i]
    def __bool__(self): return _pybool(self.data)
    def __float__(self): return _pyfloat(self.data)
    def __int__(self): return _pyint(self.data)
    def __index__(self): return _pyint(self.data)
    def __repr__(self):
        s = np.array2string(self.data, precision=4, separator=", ", prefix="tensor(")
        extra = ", requires_grad=True" if self.requires_grad else ""
        return "tensor(%s%s)" % (s, extra)

    # ---- hooks & autograd control
    def register_hook(self, hook):
        self._hooks.append(hook)
        return _HookHandle(self._hooks, hook)

    def detach(self): return Tensor(self.data)
    def clone(self): return _mk(self.data.copy(), (self,), lambda g: (g,))
    def contiguous(self): return self
    def cpu(self): return self
    def to(self, *a, **k):
        for x in list(a) + list(k.values()):
            if isinstance(x, (type, np.dtype)): return self.astype(x)
        return self
    def astype(self, dt):
        dt = np.dtype(dt)
        if dt == self.data.dtype: return self
        return _mk(self.data.astype(dt), (self,), lambda g: (g,)) if dt.kind == "f" else Tensor(self.data.astype(dt))
    def float(self): return self.astype(np.float32)
    def double(self): return self.astype(np.float64)
    def long(self): return self.astype(np.int64)
    def int(self): return self.astype(np.int32)
    def bool(self): return self.astype(np.bool_)
    def type(self, dt=None): return self if dt is None else self.astype(dt)
    def requires_grad_(self, r=True): self.requires_grad = r; return self
    def retain_grad(self): pass

    # ---- autograd
    def backward(self, gradient=None):
        if gradient is None:
            if self.data.size != 1: raise RuntimeError("grad can be implicitly created only for scalar outputs")
            g = np.ones_like(self.data)
        else: g = np.asarray(_val(gradient), dtype=self.data.dtype)
        topo, seen, st = [], set(), [(self, 0)]
        while st:
            n, i = st.pop()
            if i == 0:
                if id(n) in seen: continue
                seen.add(id(n)); st.append((n, 1))
                for p in n._prev:
                    if isinstance(p, Tensor) and p.requires_grad and id(p) not in seen: st.append((p, 0))
            else: topo.append(n)
        grads = {id(self): g}
        for node in reversed(topo):
            g = grads.pop(id(node), None)
            if g is None: continue
            for h in getattr(node, "_hooks", ()):
                res = h(Tensor(g.copy()))
                if res is not None: g = np.asarray(_val(res), dtype=g.dtype)
            if node._bw is None:
                if node.requires_grad:
                    node.grad = Tensor(g.copy()) if node.grad is None else Tensor(node.grad.data + g)
                continue
            for p, pg in zip(node._prev, node._bw(g)):
                if pg is None or not isinstance(p, Tensor) or not p.requires_grad: continue
                pg = _unb(np.asarray(pg), p.data.shape)
                if pg.dtype != p.data.dtype and p.data.dtype.kind == "f": pg = pg.astype(p.data.dtype)
                grads[id(p)] = grads[id(p)] + pg if id(p) in grads else pg

    # ---- in-place
    def zero_(self): self.data[...] = 0; return self
    def fill_(self, v): self.data[...] = v; return self
    def copy_(self, o): self.data[...] = _val(o); return self
    def add_(self, o, alpha=1): self.data += alpha * _val(o); return self
    def sub_(self, o, alpha=1): self.data -= alpha * _val(o); return self
    def mul_(self, o): self.data *= _val(o); return self
    def div_(self, o): self.data /= _val(o); return self
    def uniform_(self, a=0., b=1.): self.data[...] = _RNG[0].uniform(a, b, self.data.shape); return self
    def normal_(self, mean=0., std=1.): self.data[...] = _RNG[0].normal(mean, std, self.data.shape); return self
    def clamp_(self, min=None, max=None): np.clip(self.data, min, max, out=self.data); return self
    def __iadd__(self, o): self.data += _val(o); return self
    def __isub__(self, o): self.data -= _val(o); return self
    def __imul__(self, o): self.data *= _val(o); return self
    def __itruediv__(self, o): self.data /= _val(o); return self
    def __setitem__(self, k, v): self.data[_key(k)] = _val(v)

    # ---- arithmetic
    def __add__(self, o):
        A, B = self.data, _val(o); return _mk(A + B, (self, o), lambda g: (g, g))
    __radd__ = __add__
    def __sub__(self, o):
        A, B = self.data, _val(o); return _mk(A - B, (self, o), lambda g: (g, -g))
    def __rsub__(self, o):
        A, B = self.data, _val(o); return _mk(B - A, (self,), lambda g: (-g,))
    def __mul__(self, o):
        A, B = self.data, _val(o); return _mk(A * B, (self, o), lambda g: (g * B, g * A))
    __rmul__ = __mul__
    def __truediv__(self, o):
        A, B = self.data, _val(o)
        out = A / B
        if out.dtype == np.float64 and _DEFAULT[0] != np.float64 and not any(getattr(x, "dtype", None) == np.float64 for x in (A, B)):
            out = out.astype(_DEFAULT[0])
        return _mk(out, (self, o), lambda g: (g / B, -g * A / (B * B)))
    def __rtruediv__(self, o):
        A, B = self.data, _val(o)
        return _mk(B / A, (self,), lambda g: (-g * B / (A * A),))
    def __floordiv__(self, o): return Tensor(self.data // _val(o))
    def __mod__(self, o): return Tensor(self.data % _val(o))
    def __neg__(self): return _mk(-self.data, (self,), lambda g: (-g,))
    def __pos__(self): return self
    def __pow__(self, e):
        A, E = self.data, _val(e); out = A ** E
        def bw(g):
            ga = g * E * A ** (E - 1)
            gb = g * out * np.log(np.where(A > 0, A, 1)) if isinstance(e, Tensor) else None
            return ga, gb
        return _mk(out, (self, e), bw)
    def __rpow__(self, b):
        A = self.data; out = b ** A
        return _mk(out, (self,), lambda g: (g * out * math.log(b),))
    def __matmul__(self, o):
        if not isinstance(o, Tensor): o = Tensor(o)
        if self.ndim == 1: return (self.unsqueeze(0) @ o).squeeze(-2)
        if o.ndim == 1: return (self @ o.unsqueeze(1)).squeeze(-1)
        A, B = self.data, o.data
        return _mk(A @ B, (self, o), lambda g: (g @ np.swapaxes(B, -1, -2), np.swapaxes(A, -1, -2) @ g))
    def __rmatmul__(self, o): return Tensor(o) @ self
    def __abs__(self): return self.abs()
    def __invert__(self): return Tensor(~self.data)
    def __and__(self, o): return Tensor(self.data & _val(o))
    def __or__(self, o): return Tensor(self.data | _val(o))
    def __eq__(self, o): return Tensor(self.data == _val(o))
    def __ne__(self, o): return Tensor(self.data != _val(o))
    def __lt__(self, o): return Tensor(self.data < _val(o))
    def __le__(self, o): return Tensor(self.data <= _val(o))
    def __gt__(self, o): return Tensor(self.data > _val(o))
    def __ge__(self, o): return Tensor(self.data >= _val(o))
    add = __add__; sub = __sub__; mul = __mul__; div = __truediv__; matmul = __matmul__; neg = __neg__; mm = __matmul__; bmm = __matmul__
    def pow(self, e): return self ** e
    def eq(self, o): return self == o
    def ne(self, o): return self != o
    def lt(self, o): return self < o
    def gt(self, o): return self > o
    def le(self, o): return self <= o
    def ge(self, o): return self >= o

    # ---- elementwise
    def _un(self, f, df):
        A = self.data; out = f(A)
        return _mk(out, (self,), lambda g: (g * df(A, out),))
    def exp(self): return self._un(np.exp, lambda a, o: o)
    def log(self): return self._un(np.log, lambda a, o: 1 / a)
    def sqrt(self): return self._un(np.sqrt, lambda a, o: 0.5 / o)
    def abs(self): return self._un(np.abs, lambda a, o: np.sign(a))
    def sign(self): return Tensor(np.sign(self.data))
    def sin(self): return self._un(np.sin, lambda a, o: np.cos(a))
    def cos(self): return self._un(np.cos, lambda a, o: -np.sin(a))
    def tanh(self): return self._un(np.tanh, lambda a, o: 1 - o * o)
    def sigmoid(self): return self._un(lambda a: 1 / (1 + np.exp(-a)), lambda a, o: o * (1 - o))
    def relu(self): return self._un(lambda a: np.maximum(a, 0), lambda a, o: (a > 0).astype(a.dtype))
    def square(self): return self * self
    def rsqrt(self): return (self ** -0.5)
    def floor(self): return Tensor(np.floor(self.data))
    def round(self): return Tensor(np.round(self.data))
    def isnan(self): return Tensor(np.isnan(self.data))
    def clamp(self, min=None, max=None):
        A = self.data; out = np.clip(A, min, max)
        return _mk(out, (self,), lambda g: (g * ((A >= (-np.inf if min is None else min)) & (A <= (np.inf if max is None else max))),))
    clip = clamp
    def masked_fill(self, mask, value):
        m = _val(mask).astype(np.bool_)
        return _mk(np.where(m, value, self.data), (self,), lambda g: (np.where(m, 0, g),))

    # ---- reductions & cumulative
    def sum(self, dim=None, keepdim=False):
        A = self.data; ax = _axes(dim, A.ndim); out = A.sum(axis=ax, keepdims=keepdim)
        def bw(g):
            if not keepdim and ax is not None: g = np.expand_dims(g, ax)
            elif not keepdim and ax is None: g = np.reshape(g, (1,) * A.ndim)
            return (np.broadcast_to(g, A.shape),)
        return _mk(out, (self,), bw)
    def mean(self, dim=None, keepdim=False):
        ax = _axes(dim, self.ndim)
        n = self.data.size if ax is None else int(np.prod([self.data.shape[a] for a in ax]))
        return self.sum(dim, keepdim) / n
    def var(self, dim=None, unbiased=True, keepdim=False, correction=None):
        ax = _axes(dim, self.ndim)
        n = self.data.size if ax is None else int(np.prod([self.data.shape[a] for a in ax]))
        c = (1 if unbiased else 0) if correction is None else correction
        d = self - self.mean(dim, keepdim=True)
        return (d * d).sum(dim, keepdim) / max(n - c, 1)
    def std(self, dim=None, unbiased=True, keepdim=False, correction=None):
        return self.var(dim, unbiased, keepdim, correction).sqrt()
    def norm(self, p=2, dim=None, keepdim=False):
        return ((self.abs() ** p).sum(dim, keepdim)) ** (1.0 / p)
    def prod(self, dim=None): return Tensor(self.data.prod(axis=dim))
    def cumsum(self, dim=0):
        d = dim % self.ndim; A = self.data
        out = np.cumsum(A, axis=d)
        return _mk(out, (self,), lambda g: (np.flip(np.cumsum(np.flip(g, axis=d), axis=d), axis=d),))
    def cumprod(self, dim=0):
        d = dim % self.ndim; A = self.data
        return Tensor(np.cumprod(A, axis=d))
    def cummax(self, dim=0):
        d = dim % self.ndim; A = self.data
        vals = np.maximum.accumulate(A, axis=d)
        idxs = np.zeros_like(A, dtype=np.int64)
        for i in range(1, A.shape[d]):
            prev_idx = np.take(idxs, i - 1, axis=d)
            prev_val = np.take(vals, i - 1, axis=d)
            cur_val = np.take(A, i, axis=d)
            cur_idx = np.where(cur_val >= prev_val, i, prev_idx)
            np.put_along_axis(idxs, np.expand_dims(np.full_like(cur_idx, i), d), np.expand_dims(cur_idx, d), axis=d)
        return _CumResult(Tensor(vals), Tensor(idxs))

    def _ext(self, dim, keepdim, fn, argfn):
        A = self.data
        if dim is None:
            out = fn(A); mask = (A == out); cnt = mask.sum()
            return _mk(out, (self,), lambda g: (g * mask / cnt,))
        d = dim % A.ndim
        idx = argfn(A, axis=d); idxk = np.expand_dims(idx, d)
        vals = np.take_along_axis(A, idxk, d)
        def bw(g):
            gk = g if keepdim else np.expand_dims(g, d)
            z = np.zeros_like(A); np.put_along_axis(z, idxk, gk, d); return (z,)
        v = _mk(vals if keepdim else np.squeeze(vals, d), (self,), bw)
        return _MinMax(v, Tensor(idx if not keepdim else idxk))
    def max(self, dim=None, keepdim=False):
        if isinstance(dim, Tensor): return maximum(self, dim)
        return self._ext(dim, keepdim, np.max, np.argmax)
    def min(self, dim=None, keepdim=False):
        if isinstance(dim, Tensor): return minimum(self, dim)
        return self._ext(dim, keepdim, np.min, np.argmin)
    def argmax(self, dim=None, keepdim=False):
        r = np.argmax(self.data, axis=dim); return Tensor(np.expand_dims(r, dim) if keepdim and dim is not None else r)
    def argmin(self, dim=None, keepdim=False):
        r = np.argmin(self.data, axis=dim); return Tensor(np.expand_dims(r, dim) if keepdim and dim is not None else r)
    def all(self): return Tensor(self.data.all())
    def any(self): return Tensor(self.data.any())
    def softmax(self, dim=-1):
        A = self.data; e = np.exp(A - A.max(axis=dim, keepdims=True)); out = e / e.sum(axis=dim, keepdims=True)
        return _mk(out, (self,), lambda g: (out * (g - (g * out).sum(axis=dim, keepdims=True)),))
    def log_softmax(self, dim=-1):
        A = self.data; s = A - A.max(axis=dim, keepdims=True)
        out = s - np.log(np.exp(s).sum(axis=dim, keepdims=True))
        return _mk(out, (self,), lambda g: (g - np.exp(out) * g.sum(axis=dim, keepdims=True),))
    def logsumexp(self, dim, keepdim=False):
        m = self.max(dim, keepdim=True)[0].detach()
        r = ((self - m).exp().sum(dim, keepdim=True)).log() + m
        return r if keepdim else r.squeeze(dim)

    # ---- sort, flip, roll, searchsorted
    def sort(self, dim=-1, descending=False, stable=False):
        d = dim % self.ndim; A = self.data
        k = "stable" if stable else "quicksort"
        idx = np.argsort(A, axis=d, kind=k)
        if descending:
            idx = np.take(idx, np.arange(idx.shape[d] - 1, -1, -1), axis=d)
        vals = np.take_along_axis(A, idx, axis=d)
        def bw(g):
            z = np.zeros_like(A)
            np.put_along_axis(z, idx, g, axis=d)
            return (z,)
        return _SortResult(_mk(vals, (self,), bw), Tensor(idx))

    def flip(self, dims):
        ds = (dims,) if isinstance(dims, (_pyint, np.integer)) else tuple(dims)
        ds = tuple(d % self.ndim for d in ds)
        return _mk(np.flip(self.data, axis=ds), (self,), lambda g: (np.flip(g, axis=ds),))

    def roll(self, shifts, dims=None):
        sh = shifts; ax = dims
        def bw(g):
            r_sh = tuple(-s for s in sh) if isinstance(sh, (tuple, list)) else -sh
            return (np.roll(g, shift=r_sh, axis=ax),)
        return _mk(np.roll(self.data, shift=sh, axis=ax), (self,), bw)

    def searchsorted(self, values, out_int32=False, right=False, side=None, sorter=None):
        return searchsorted(self, values, out_int32=out_int32, right=right, side=side, sorter=sorter)

    # ---- shape
    def reshape(self, *shape):
        if len(shape) == 1 and isinstance(shape[0], (tuple, list)): shape = tuple(shape[0])
        old = self.data.shape
        return _mk(self.data.reshape(shape), (self,), lambda g: (g.reshape(old),))
    view = reshape
    def view_as(self, o): return self.reshape(o.shape)
    def flatten(self, start_dim=0, end_dim=-1):
        nd = self.ndim
        if nd == 0: return self.reshape(1)
        s, e = start_dim % nd, end_dim % nd
        return self.reshape(self.data.shape[:s] + (-1,) + self.data.shape[e + 1:])
    def unsqueeze(self, dim):
        d = dim % (self.ndim + 1)
        return _mk(np.expand_dims(self.data, d), (self,), lambda g: (np.squeeze(g, d),))
    def squeeze(self, dim=None):
        A = self.data; old = A.shape
        if dim is None: ax = tuple(i for i, s in enumerate(old) if s == 1)
        else:
            d = dim % max(A.ndim, 1); ax = (d,) if A.ndim and old[d] == 1 else ()
        return _mk(A.reshape([s for i, s in enumerate(old) if i not in ax]), (self,), lambda g: (g.reshape(old),))
    def permute(self, *dims):
        if len(dims) == 1 and isinstance(dims[0], (tuple, list)): dims = tuple(dims[0])
        dims = tuple(d % self.ndim for d in dims); inv = np.argsort(dims)
        return _mk(self.data.transpose(dims), (self,), lambda g: (g.transpose(inv),))
    def transpose(self, a, b):
        p = list(range(self.ndim)); p[a], p[b] = p[b], p[a]; return self.permute(*p)
    def t(self): return self if self.ndim < 2 else self.transpose(0, 1)
    def expand(self, *shape):
        if len(shape) == 1 and isinstance(shape[0], (tuple, list)): shape = tuple(shape[0])
        A = self.data; shape = tuple(A.shape[i - (len(shape) - A.ndim)] if s == -1 else s for i, s in enumerate(shape))
        return _mk(np.broadcast_to(A, shape), (self,), lambda g: (g,))
    def repeat(self, *reps):
        if len(reps) == 1 and isinstance(reps[0], (tuple, list)): reps = tuple(reps[0])
        A = self.data; reps = (1,) * (A.ndim - len(reps)) + tuple(reps) if len(reps) < A.ndim else tuple(reps)
        A2 = A.reshape((1,) * (len(reps) - A.ndim) + A.shape)
        out = np.tile(A2, reps); ish = A2.shape
        def bw(g):
            sh = []
            for r, s in zip(reps, ish): sh += [r, s]
            return (g.reshape(sh).sum(axis=tuple(range(0, 2 * len(ish), 2))).reshape(A.shape),)
        return _mk(out, (self,), bw)
    def repeat_interleave(self, repeats, dim=None):
        return repeat_interleave(self, repeats, dim)
    def __getitem__(self, key):
        k = _key(key); A = self.data
        def bw(g):
            z = np.zeros_like(A); np.add.at(z, k, g); return (z,)
        return _mk(A[k], (self,), bw)
    def masked_select(self, mask):
        m = _val(mask).astype(np.bool_)
        return Tensor(self.data[m])
    def chunk(self, n, dim=0):
        size = -(-self.shape[dim] // n); return self.split(size, dim)
    def split(self, size, dim=0):
        out = []; sl = [slice(None)] * self.ndim
        for s in range(0, self.shape[dim], size):
            sl[dim] = slice(s, s + size); out.append(self[tuple(sl)])
        return tuple(out)
    def tril(self, diagonal=0): return self * Tensor(np.tril(np.ones(self.shape[-2:], dtype=self.dtype), diagonal))
    def triu(self, diagonal=0): return self * Tensor(np.triu(np.ones(self.shape[-2:], dtype=self.dtype), diagonal))


_MinMax = namedtuple("_MinMax", ["values", "indices"])
_CumResult = namedtuple("_CumResult", ["values", "indices"])
_SortResult = namedtuple("_SortResult", ["values", "indices"])


def _key(k):
    if isinstance(k, Tensor): return k.data
    if isinstance(k, tuple): return tuple(_key(x) for x in k)
    if isinstance(k, list): return np.asarray(k)
    return k


class Parameter(Tensor):
    def __init__(self, data=None, requires_grad=True):
        super().__init__(data if data is not None else np.zeros(0, np.float32), requires_grad)
    def __repr__(self): return "Parameter containing:\n" + Tensor.__repr__(self)


# ---------------------------------------------------------------- factories & utilities
def _shape(a):
    if len(a) == 1 and isinstance(a[0], (tuple, list, Size)): return tuple(a[0])
    return tuple(a)

def _fin(arr, dtype, rg):
    dt = dtype if dtype is not None else None
    t = Tensor(arr if dt is None else arr.astype(dt, copy=False)); t.requires_grad = rg; return t

def tensor(data, dtype=None, requires_grad=False, device=None):
    return Tensor(data.data.copy() if isinstance(data, Tensor) else data, requires_grad, dtype)
as_tensor = tensor
def from_numpy(a): return Tensor(a)
def is_tensor(x): return isinstance(x, Tensor)
def numel(x): return x.numel()
def zeros(*s, dtype=None, requires_grad=False, device=None): return _fin(np.zeros(_shape(s), dtype or _DEFAULT[0]), None, requires_grad)
def ones(*s, dtype=None, requires_grad=False, device=None): return _fin(np.ones(_shape(s), dtype or _DEFAULT[0]), None, requires_grad)
def full(size, fill, dtype=None, requires_grad=False, device=None):
    return _fin(np.full(tuple(size), fill, dtype or (_DEFAULT[0] if isinstance(fill, _pyfloat) else None)), None, requires_grad)
def empty(*s, dtype=None, **k): return zeros(*s, dtype=dtype, **k)
def eye(n, m=None, dtype=None, requires_grad=False, device=None): return _fin(np.eye(n, m, dtype=dtype or _DEFAULT[0]), None, requires_grad)
def zeros_like(x, dtype=None, **k): return zeros(x.shape, dtype=dtype or x.dtype, **k)
def ones_like(x, dtype=None, **k): return ones(x.shape, dtype=dtype or x.dtype, **k)
def full_like(x, v, dtype=None, **k): return full(x.shape, v, dtype=dtype or x.dtype, **k)
def rand(*s, dtype=None, requires_grad=False, device=None, generator=None): return _fin(_RNG[0].random(_shape(s)).astype(dtype or _DEFAULT[0]), None, requires_grad)
def randn(*s, dtype=None, requires_grad=False, device=None, generator=None): return _fin(_RNG[0].standard_normal(_shape(s)).astype(dtype or _DEFAULT[0]), None, requires_grad)
def rand_like(x, **k): return rand(x.shape, **k)
def randn_like(x, **k): return randn(x.shape, **k)
def randint(low, high=None, size=(1,), dtype=None, **k):
    if high is None: low, high = 0, low
    return Tensor(_RNG[0].integers(low, high, size=tuple(size)).astype(dtype or np.int64))
def randperm(n, **k): return Tensor(_RNG[0].permutation(n).astype(np.int64))

def normal(mean=0.0, std=1.0, size=None, *, out=None, generator=None):
    if size is None:
        if isinstance(mean, Tensor): size = mean.shape
        elif isinstance(std, Tensor): size = std.shape
        else: size = ()
    m = _val(mean); s = _val(std)
    return Tensor(_RNG[0].normal(m, s, tuple(size)).astype(_DEFAULT[0]))

def bernoulli(p): return Tensor((_RNG[0].random(p.shape) < p.data).astype(p.dtype))
def arange(start, end=None, step=1, dtype=None, requires_grad=False, device=None):
    if end is None: start, end = 0, start
    a = np.arange(start, end, step)
    if dtype is None and a.dtype.kind == "f": a = a.astype(_DEFAULT[0])
    return _fin(a, dtype, requires_grad)
def linspace(a, b, steps, dtype=None, **k): return Tensor(np.linspace(a, b, steps).astype(dtype or _DEFAULT[0]))
def tril(x, diagonal=0): return x.tril(diagonal)
def triu(x, diagonal=0): return x.triu(diagonal)
def device(name="cpu"): return "cpu"
class _Cuda:
    @staticmethod
    def is_available(): return False
    @staticmethod
    def device_count(): return 0
cuda = _Cuda()

def repeat_interleave(input, repeats, dim=None):
    inp = input if isinstance(input, Tensor) else Tensor(input)
    rep = repeats.data if isinstance(repeats, Tensor) else repeats
    d = dim if dim is not None else None
    out = np.repeat(inp.data, rep, axis=d)
    return _mk(out, (inp,), lambda g: (None,))

def meshgrid(*tensors, indexing="ij"):
    arrs = [_val(t) for t in tensors]
    grids = np.meshgrid(*arrs, indexing=indexing or "ij")
    return tuple(Tensor(g) for g in grids)

def searchsorted(sorted_sequence, values, out_int32=False, right=False, side=None, sorter=None):
    seq = _val(sorted_sequence); v = _val(values)
    s = "right" if right or side == "right" else "left"
    srt = _val(sorter) if sorter is not None else None
    res = np.searchsorted(seq, v, side=s, sorter=srt)
    dt = np.int32 if out_int32 else np.int64
    return Tensor(res.astype(dt))

def masked_select(input, mask):
    inp = input if isinstance(input, Tensor) else Tensor(input)
    return inp.masked_select(mask)

def sort(input, dim=-1, descending=False, stable=False):
    inp = input if isinstance(input, Tensor) else Tensor(input)
    return inp.sort(dim=dim, descending=descending, stable=stable)

def flip(input, dims):
    inp = input if isinstance(input, Tensor) else Tensor(input)
    return inp.flip(dims)

def roll(input, shifts, dims=None):
    inp = input if isinstance(input, Tensor) else Tensor(input)
    return inp.roll(shifts, dims)

def einsum(*args):
    if len(args) == 1 and isinstance(args[0], str): return lambda *ops: einsum(args[0], *ops)
    subscripts = args[0]
    operands = args[1:]
    arrs = [_val(op) for op in operands]
    out = np.einsum(subscripts, *arrs, optimize=True)
    return Tensor(out)

def view_as_complex(input):
    inp = _val(input)
    if inp.shape[-1] != 2: raise ValueError("view_as_complex: last dimension must be 2")
    return Tensor(inp[..., 0] + 1j * inp[..., 1])

def view_as_real(input):
    inp = _val(input)
    return Tensor(np.stack([np.real(inp), np.imag(inp)], axis=-1))

def cat(ts, dim=0):
    ts = [t if isinstance(t, Tensor) else Tensor(t) for t in ts]
    arrs = [t.data for t in ts]; out = np.concatenate(arrs, axis=dim)
    sizes = np.cumsum([a.shape[dim] for a in arrs])[:-1]
    return _mk(out, tuple(ts), lambda g: tuple(np.split(g, sizes, axis=dim)))
concat = cat
def stack(ts, dim=0):
    ts = [t if isinstance(t, Tensor) else Tensor(t) for t in ts]
    out = np.stack([t.data for t in ts], axis=dim)
    return _mk(out, tuple(ts), lambda g: tuple(np.moveaxis(g, dim, 0)))
def where(c, a, b):
    C = _val(c).astype(np.bool_); A, B = _val(a), _val(b)
    return _mk(np.where(C, A, B), (a, b), lambda g: (g * C, g * ~C))
def maximum(a, b):
    A, B = _val(a), _val(b)
    return _mk(np.maximum(A, B), (a, b), lambda g: (g * (A >= B), g * (A < B)))
def minimum(a, b):
    A, B = _val(a), _val(b)
    return _mk(np.minimum(A, B), (a, b), lambda g: (g * (A <= B), g * (A > B)))
def matmul(a, b): return a @ b
mm = bmm = matmul
def _mname(n):
    def f(x, *a, **k): return getattr(x if isinstance(x, Tensor) else Tensor(x), n)(*a, **k)
    f.__name__ = n; return f
for _n in ["exp", "log", "sqrt", "abs", "sign", "sin", "cos", "tanh", "sigmoid", "relu", "sum", "mean", "var", "std", "norm", "prod",
           "argmax", "argmin", "softmax", "log_softmax", "logsumexp", "clamp", "reshape", "flatten", "unsqueeze", "squeeze", "permute",
           "transpose", "pow", "square", "rsqrt", "floor", "round", "isnan", "all", "any", "max", "min", "masked_fill", "chunk", "split",
           "cumsum", "cumprod", "cummax", "sort", "flip", "roll", "searchsorted"]:
    _FUNCS[_n] = _mname(_n)
_FUNCS['clip'] = _FUNCS['clamp']
def allclose(a, b, rtol=1e-5, atol=1e-8): return np.allclose(_val(a), _val(b), rtol=rtol, atol=atol)
def equal(a, b): return np.array_equal(_val(a), _val(b))
def save(obj, f, *a, **k):
    import pickle
    sd = {k_: v.data for k_, v in obj.items()} if isinstance(obj, dict) and all(isinstance(v, Tensor) for v in obj.values()) else obj
    pickle.dump(sd, open(f, "wb") if isinstance(f, str) else f)
def load(f, *a, **k):
    import pickle
    d = pickle.load(open(f, "rb") if isinstance(f, str) else f)
    return OrderedDict((k_, Tensor(v)) for k_, v in d.items()) if isinstance(d, dict) and all(isinstance(v, np.ndarray) for v in d.values()) else d


# ---------------------------------------------------------------- functional
def _conv2d(x, w, b=None, stride=1, padding=0):
    from numpy.lib.stride_tricks import sliding_window_view as swv
    s = stride if isinstance(stride, _pyint) else stride[0]
    p = padding if isinstance(padding, _pyint) else padding[0]
    X, W = x.data, w.data; O, C, kh, kw = W.shape
    Xp = np.pad(X, ((0, 0), (0, 0), (p, p), (p, p))) if p else X
    win = swv(Xp, (kh, kw), axis=(2, 3))[:, :, ::s, ::s]
    out = np.einsum("nchwij,ocij->nohw", win, W, optimize=True)
    Ho, Wo = out.shape[2:]
    def bw(g):
        gw = np.einsum("nchwij,nohw->ocij", win, g, optimize=True)
        gxp = np.zeros_like(Xp)
        for i in range(kh):
            for j in range(kw):
                gxp[:, :, i:i + s * Ho:s, j:j + s * Wo:s] += np.einsum("nohw,oc->nchw", g, W[:, :, i, j], optimize=True)
        return (gxp[:, :, p:gxp.shape[2] - p, p:gxp.shape[3] - p] if p else gxp, gw)
    r = _mk(out, (x, w), bw)
    return r + b.reshape(1, -1, 1, 1) if b is not None else r

def _max_pool2d(x, kernel_size, stride=None):
    from numpy.lib.stride_tricks import sliding_window_view as swv
    k = kernel_size if isinstance(kernel_size, _pyint) else kernel_size[0]
    s = (stride or k) if isinstance(stride or k, _pyint) else (stride or k)[0]
    X = x.data; win = swv(X, (k, k), axis=(2, 3))[:, :, ::s, ::s]
    N, C, Ho, Wo = win.shape[:4]; flat = win.reshape(N, C, Ho, Wo, k * k)
    am = flat.argmax(-1); out = np.take_along_axis(flat, am[..., None], -1)[..., 0]
    def bw(g):
        gx = np.zeros_like(X)
        for i in range(k):
            for j in range(k):
                gx[:, :, i:i + s * Ho:s, j:j + s * Wo:s] += g * (am == i * k + j)
        return (gx,)
    return _mk(out, (x,), bw)

def _avg_pool2d(x, kernel_size, stride=None, padding=0):
    from numpy.lib.stride_tricks import sliding_window_view as swv
    k = kernel_size if isinstance(kernel_size, _pyint) else kernel_size[0]
    s = (stride or k) if isinstance(stride or k, _pyint) else (stride or k)[0]
    p = padding if isinstance(padding, _pyint) else padding[0]
    X = x.data
    Xp = np.pad(X, ((0, 0), (0, 0), (p, p), (p, p))) if p else X
    win = swv(Xp, (k, k), axis=(2, 3))[:, :, ::s, ::s]
    out = win.mean(axis=(-2, -1))
    Ho, Wo = out.shape[2:]
    def bw(g):
        gxp = np.zeros_like(Xp)
        area = float(k * k)
        for i in range(k):
            for j in range(k):
                gxp[:, :, i:i + s * Ho:s, j:j + s * Wo:s] += g / area
        return (gxp[:, :, p:gxp.shape[2] - p, p:gxp.shape[3] - p] if p else gxp,)
    return _mk(out, (x,), bw)

def _reduce(l, reduction):
    return l.mean() if reduction == "mean" else l.sum() if reduction == "sum" else l

def _cross_entropy(logits, target, weight=None, ignore_index=-100, reduction="mean", label_smoothing=0.0):
    lp = logits.log_softmax(-1)
    if target.dtype.kind == "f": return _reduce(-(lp * target).sum(-1), reduction)
    if lp.ndim > 2:
        C = lp.shape[1]; lp = lp.permute(0, *range(2, lp.ndim), 1).reshape(-1, C); target = target.reshape(-1)
    t = target.data; valid = t != ignore_index; ts = np.where(valid, t, 0)
    picked = lp[np.arange(len(ts)), ts]
    nll = -picked * Tensor(valid.astype(lp.dtype))
    if label_smoothing:
        nll = (1 - label_smoothing) * nll + label_smoothing * (-lp.mean(-1)) * Tensor(valid.astype(lp.dtype))
    if reduction == "mean": return nll.sum() / max(int(valid.sum()), 1)
    return nll.sum() if reduction == "sum" else nll

def _nll_loss(lp, target, reduction="mean"):
    t = target.data; return _reduce(-lp[np.arange(len(t)), t], reduction)

def _bce_logits(x, y, reduction="mean", pos_weight=None):
    l = x.clamp(min=0) - x * y + ((-(x.abs())).exp() + 1).log()
    return _reduce(l, reduction)

def _bce(p, y, reduction="mean"):
    p = p.clamp(1e-7, 1 - 1e-7); return _reduce(-(y * p.log() + (1 - y) * (1 - p).log()), reduction)

def _dropout(x, p=0.5, training=True):
    if not training or p == 0: return x
    m = (_RNG[0].random(x.shape) >= p).astype(x.dtype) / (1 - p); return x * Tensor(m)

def _gelu(x): return 0.5 * x * (1 + (0.7978845608028654 * (x + 0.044715 * x * x * x)).tanh())
def _layer_norm(x, normalized_shape, weight=None, bias=None, eps=1e-5):
    n = len(normalized_shape) if isinstance(normalized_shape, (tuple, list)) else 1
    dims = tuple(range(-n, 0)); mu = x.mean(dims, keepdim=True)
    var = ((x - mu) ** 2).mean(dims, keepdim=True)
    y = (x - mu) / (var + eps).sqrt()
    if weight is not None: y = y * weight
    if bias is not None: y = y + bias
    return y
def _one_hot(t, num_classes=-1):
    n = num_classes if num_classes > 0 else int(t.data.max()) + 1; return Tensor(np.eye(n, dtype=np.int64)[t.data])
def _leaky(x, s=0.01): return where(x > 0, x, x * s)
def _linear(x, w, b=None):
    y = x @ w.T; return y + b if b is not None else y
def _mse(a, b, reduction="mean"): d = a - b; return _reduce(d * d, reduction)
def _l1(a, b, reduction="mean"): return _reduce((a - b).abs(), reduction)
def _smooth_l1(a, b, reduction="mean", beta=1.0):
    d = (a - b).abs(); return _reduce(where(d < beta, 0.5 * d * d / beta, d - 0.5 * beta), reduction)
def _huber(a, b, reduction="mean", delta=1.0):
    return _smooth_l1(a, b, reduction=reduction, beta=delta)


# ---------------------------------------------------------------- nn
class Module:
    def __init__(self):
        object.__setattr__(self, "_parameters", OrderedDict())
        object.__setattr__(self, "_modules", OrderedDict())
        object.__setattr__(self, "_buffers", OrderedDict())
        object.__setattr__(self, "training", True)
    def __setattr__(self, k, v):
        if "_parameters" not in self.__dict__:
            raise AttributeError("cannot assign before Module.__init__() call")
        for d in (self._parameters, self._modules, self._buffers): d.pop(k, None)
        if isinstance(v, Parameter): self._parameters[k] = v
        elif isinstance(v, Module): self._modules[k] = v
        object.__setattr__(self, k, v)
    def __getattr__(self, k):
        for d in ("_parameters", "_modules", "_buffers"):
            if d in self.__dict__ and k in self.__dict__[d]: return self.__dict__[d][k]
        raise AttributeError("'%s' object has no attribute '%s'" % (type(self).__name__, k))
    def register_buffer(self, name, t):
        self._buffers[name] = t; object.__setattr__(self, name, t)
    def register_parameter(self, name, p): setattr(self, name, p)
    def add_module(self, name, m): setattr(self, name, m)
    def forward(self, *a, **k): raise NotImplementedError
    def __call__(self, *a, **k): return self.forward(*a, **k)
    def named_modules(self, prefix=""):
        yield prefix, self
        for n, m in self._modules.items():
            if m is not None: yield from m.named_modules(prefix + ("." if prefix else "") + n)
    def modules(self):
        for _, m in self.named_modules(): yield m
    def children(self): return iter(self._modules.values())
    def named_children(self): return iter(self._modules.items())
    def named_parameters(self, prefix="", recurse=True):
        seen = set()
        for mn, m in (self.named_modules(prefix) if recurse else [(prefix, self)]):
            for n, p in m._parameters.items():
                if p is not None and id(p) not in seen:
                    seen.add(id(p)); yield (mn + "." if mn else "") + n, p
    def parameters(self, recurse=True):
        for _, p in self.named_parameters(recurse=recurse): yield p
    def named_buffers(self):
        for mn, m in self.named_modules():
            for n, b in m._buffers.items(): yield (mn + "." if mn else "") + n, b
    def buffers(self):
        for _, b in self.named_buffers(): yield b
    def train(self, mode=True):
        for m in self.modules(): object.__setattr__(m, "training", mode)
        return self
    def eval(self): return self.train(False)
    def zero_grad(self, set_to_none=True):
        for p in self.parameters(): p.grad = None
    def requires_grad_(self, r=True):
        for p in self.parameters(): p.requires_grad = r
        return self
    def apply(self, fn):
        for m in self.children(): m.apply(fn)
        fn(self); return self
    def to(self, *a, **k): return self
    def cpu(self): return self
    def float(self): return self
    def double(self):
        for p in self.parameters(): p.data = p.data.astype(np.float64)
        return self
    def state_dict(self):
        sd = OrderedDict()
        for n, p in self.named_parameters(): sd[n] = p.detach()
        for n, b in self.named_buffers(): sd[n] = b.detach()
        return sd
    def load_state_dict(self, sd, strict=True):
        own = dict(self.named_parameters()); own.update(dict(self.named_buffers()))
        for k, v in sd.items():
            if k in own: own[k].data[...] = _val(v)
            elif strict: raise KeyError("Unexpected key %s" % k)
        if strict:
            miss = [k for k in own if k not in sd]
            if miss: raise KeyError("Missing keys %s" % miss)
    def extra_repr(self): return ""
    def __repr__(self):
        ch = "".join("\n  (%s): %s" % (n, repr(m).replace("\n", "\n  ")) for n, m in self._modules.items())
        return "%s(%s%s)" % (type(self).__name__, self.extra_repr(), ch + "\n" if ch else "")

def _uniform_param(shape, bound): return Parameter(_RNG[0].uniform(-bound, bound, shape).astype(_DEFAULT[0]))

class Identity(Module):
    def forward(self, x): return x
class Linear(Module):
    def __init__(self, in_features, out_features, bias=True):
        super().__init__(); self.in_features, self.out_features = in_features, out_features
        b = 1 / math.sqrt(in_features)
        self.weight = _uniform_param((out_features, in_features), b)
        self.bias = _uniform_param((out_features,), b) if bias else None
    def forward(self, x): return _linear(x, self.weight, self.bias)
    def extra_repr(self): return "in_features=%d, out_features=%d" % (self.in_features, self.out_features)
class Conv1d(Module):
    def __init__(self, in_channels, out_channels, kernel_size, stride=1, padding=0, bias=True):
        super().__init__()
        k = kernel_size if isinstance(kernel_size, _pyint) else kernel_size[0]
        self.stride = stride if isinstance(stride, _pyint) else stride[0]
        self.padding = padding if isinstance(padding, _pyint) else padding[0]
        b = 1 / math.sqrt(in_channels * k)
        self.weight = _uniform_param((out_channels, in_channels, k), b)
        self.bias = _uniform_param((out_channels,), b) if bias else None
    def forward(self, x):
        x2d = x.unsqueeze(-1)
        w2d = self.weight.unsqueeze(-1)
        b = self.bias
        out2d = _conv2d(x2d, w2d, b, stride=(self.stride, 1), padding=(self.padding, 0))
        return out2d.squeeze(-1)
class Conv2d(Module):
    def __init__(self, in_channels, out_channels, kernel_size, stride=1, padding=0, bias=True):
        super().__init__(); k = kernel_size if isinstance(kernel_size, _pyint) else kernel_size[0]
        self.stride, self.padding = stride, padding; b = 1 / math.sqrt(in_channels * k * k)
        self.weight = _uniform_param((out_channels, in_channels, k, k), b)
        self.bias = _uniform_param((out_channels,), b) if bias else None
    def forward(self, x): return _conv2d(x, self.weight, self.bias, self.stride, self.padding)
class MaxPool2d(Module):
    def __init__(self, kernel_size, stride=None): super().__init__(); self.k, self.s = kernel_size, stride
    def forward(self, x): return _max_pool2d(x, self.k, self.s)
class AvgPool2d(Module):
    def __init__(self, kernel_size, stride=None, padding=0): super().__init__(); self.k, self.s, self.p = kernel_size, stride, padding
    def forward(self, x): return _avg_pool2d(x, self.k, self.s, self.p)
class Embedding(Module):
    def __init__(self, num_embeddings, embedding_dim):
        super().__init__(); self.weight = Parameter(_RNG[0].standard_normal((num_embeddings, embedding_dim)).astype(_DEFAULT[0]))
    def forward(self, idx): return self.weight[idx]
class LayerNorm(Module):
    def __init__(self, normalized_shape, eps=1e-5, elementwise_affine=True):
        super().__init__(); ns = (normalized_shape,) if isinstance(normalized_shape, _pyint) else tuple(normalized_shape)
        self.normalized_shape, self.eps = ns, eps
        self.weight = Parameter(np.ones(ns, _DEFAULT[0])) if elementwise_affine else None
        self.bias = Parameter(np.zeros(ns, _DEFAULT[0])) if elementwise_affine else None
    def forward(self, x): return _layer_norm(x, self.normalized_shape, self.weight, self.bias, self.eps)
class BatchNorm1d(Module):
    def __init__(self, num_features, eps=1e-5, momentum=0.1):
        super().__init__(); self.eps, self.momentum = eps, momentum
        self.weight = Parameter(np.ones(num_features, _DEFAULT[0])); self.bias = Parameter(np.zeros(num_features, _DEFAULT[0]))
        self.register_buffer("running_mean", Tensor(np.zeros(num_features, _DEFAULT[0])))
        self.register_buffer("running_var", Tensor(np.ones(num_features, _DEFAULT[0])))
    def forward(self, x):
        if self.training:
            mu = x.mean(0); var = ((x - mu) ** 2).mean(0); n = x.shape[0]
            m = self.momentum
            self.running_mean.data[...] = (1 - m) * self.running_mean.data + m * mu.data
            self.running_var.data[...] = (1 - m) * self.running_var.data + m * var.data * n / max(n - 1, 1)
        else: mu, var = self.running_mean, self.running_var
        return (x - mu) / (var + self.eps).sqrt() * self.weight + self.bias
class BatchNorm2d(Module):
    def __init__(self, num_features, eps=1e-5, momentum=0.1, affine=True, track_running_stats=True):
        super().__init__()
        self.num_features, self.eps, self.momentum = num_features, eps, momentum
        self.affine, self.track_running_stats = affine, track_running_stats
        self.weight = Parameter(np.ones(num_features, _DEFAULT[0])) if affine else None
        self.bias = Parameter(np.zeros(num_features, _DEFAULT[0])) if affine else None
        if track_running_stats:
            self.register_buffer("running_mean", Tensor(np.zeros(num_features, _DEFAULT[0])))
            self.register_buffer("running_var", Tensor(np.ones(num_features, _DEFAULT[0])))
        else:
            self.register_buffer("running_mean", None)
            self.register_buffer("running_var", None)
    def forward(self, x):
        if self.training or not self.track_running_stats:
            mu = x.mean((0, 2, 3), keepdim=True)
            var = ((x - mu) ** 2).mean((0, 2, 3), keepdim=True)
            if self.track_running_stats and self.training:
                n = x.shape[0] * x.shape[2] * x.shape[3]
                m = self.momentum
                mu_flat = mu.data.squeeze()
                var_flat = var.data.squeeze()
                self.running_mean.data[...] = (1 - m) * self.running_mean.data + m * mu_flat
                self.running_var.data[...] = (1 - m) * self.running_var.data + m * var_flat * n / max(n - 1, 1)
        else:
            mu = self.running_mean.reshape(1, -1, 1, 1)
            var = self.running_var.reshape(1, -1, 1, 1)
        y = (x - mu) / (var + self.eps).sqrt()
        if self.affine:
            w = self.weight.reshape(1, -1, 1, 1)
            b = self.bias.reshape(1, -1, 1, 1)
            y = y * w + b
        return y
class GroupNorm(Module):
    def __init__(self, num_groups, num_channels, eps=1e-5, affine=True):
        super().__init__()
        self.num_groups, self.num_channels, self.eps, self.affine = num_groups, num_channels, eps, affine
        if num_channels % num_groups != 0:
            raise ValueError("num_channels must be divisible by num_groups")
        self.weight = Parameter(np.ones(num_channels, _DEFAULT[0])) if affine else None
        self.bias = Parameter(np.zeros(num_channels, _DEFAULT[0])) if affine else None
    def forward(self, x):
        N = x.shape[0]; G = self.num_groups; orig_shape = x.shape
        x_g = x.reshape(N, G, -1)
        mu = x_g.mean(-1, keepdim=True)
        var = ((x_g - mu) ** 2).mean(-1, keepdim=True)
        y = (x_g - mu) / (var + self.eps).sqrt()
        y = y.reshape(orig_shape)
        if self.affine:
            view_shape = (1, self.num_channels) + (1,) * (x.ndim - 2)
            y = y * self.weight.reshape(*view_shape) + self.bias.reshape(*view_shape)
        return y
class Dropout(Module):
    def __init__(self, p=0.5): super().__init__(); self.p = p
    def forward(self, x): return _dropout(x, self.p, self.training)
class Flatten(Module):
    def __init__(self, start_dim=1, end_dim=-1): super().__init__(); self.s, self.e = start_dim, end_dim
    def forward(self, x): return x.flatten(self.s, self.e)
def _act(name, fn):
    class A(Module):
        def forward(self, x): return fn(x)
    A.__name__ = name; return A
ReLU = _act("ReLU", lambda x: x.relu()); Tanh = _act("Tanh", lambda x: x.tanh()); Sigmoid = _act("Sigmoid", lambda x: x.sigmoid())
GELU = _act("GELU", _gelu); SiLU = _act("SiLU", lambda x: x * x.sigmoid())
class LeakyReLU(Module):
    def __init__(self, negative_slope=0.01): super().__init__(); self.s = negative_slope
    def forward(self, x): return _leaky(x, self.s)
class Softmax(Module):
    def __init__(self, dim=-1): super().__init__(); self.dim = dim
    def forward(self, x): return x.softmax(self.dim)
class LogSoftmax(Softmax):
    def forward(self, x): return x.log_softmax(self.dim)
class Sequential(Module):
    def __init__(self, *mods):
        super().__init__()
        for i, m in enumerate(mods): self.add_module(str(i), m)
    def forward(self, x):
        for m in self._modules.values(): x = m(x)
        return x
    def __getitem__(self, i): return list(self._modules.values())[i]
    def __len__(self): return len(self._modules)
    def __iter__(self): return iter(self._modules.values())
class ModuleList(Module):
    def __init__(self, mods=()):
        super().__init__()
        for m in mods: self.append(m)
    def append(self, m): self.add_module(str(len(self._modules)), m); return self
    def __getitem__(self, i): return list(self._modules.values())[i]
    def __len__(self): return len(self._modules)
    def __iter__(self): return iter(self._modules.values())
class _Loss(Module):
    def __init__(self, reduction="mean", **kw): super().__init__(); self.reduction = reduction; self.kw = kw
MSELoss = type("MSELoss", (_Loss,), {"forward": lambda s, a, b: _mse(a, b, s.reduction)})
L1Loss = type("L1Loss", (_Loss,), {"forward": lambda s, a, b: _l1(a, b, s.reduction)})
SmoothL1Loss = type("SmoothL1Loss", (_Loss,), {"forward": lambda s, a, b: _smooth_l1(a, b, s.reduction, beta=s.kw.get("beta", 1.0))})
HuberLoss = type("HuberLoss", (_Loss,), {"forward": lambda s, a, b: _huber(a, b, s.reduction, delta=s.kw.get("delta", 1.0))})
CrossEntropyLoss = type("CrossEntropyLoss", (_Loss,), {"forward": lambda s, x, t: _cross_entropy(x, t, reduction=s.reduction, **s.kw)})
NLLLoss = type("NLLLoss", (_Loss,), {"forward": lambda s, x, t: _nll_loss(x, t, s.reduction)})
BCEWithLogitsLoss = type("BCEWithLogitsLoss", (_Loss,), {"forward": lambda s, x, y: _bce_logits(x, y, s.reduction)})
BCELoss = type("BCELoss", (_Loss,), {"forward": lambda s, x, y: _bce(x, y, s.reduction)})

def _clip_grad_norm_(params, max_norm, norm_type=2.0):
    ps = [p for p in (params if not isinstance(params, Tensor) else [params]) if p.grad is not None]
    if not ps: return Tensor(0.0)
    total = float(sum((np.abs(p.grad.data) ** norm_type).sum() for p in ps) ** (1.0 / norm_type))
    c = max_norm / (total + 1e-6)
    if c < 1:
        for p in ps: p.grad.data *= c
    return Tensor(np.float32(total))
def _clip_grad_value_(params, v):
    for p in params:
        if p.grad is not None: np.clip(p.grad.data, -v, v, out=p.grad.data)

def _init_fn(f):
    def g(t, *a, **k): f(t, *a, **k); return t
    return g
def _fans(t):
    rf = int(np.prod(t.shape[2:])) if t.ndim > 2 else 1
    return t.shape[1] * rf, t.shape[0] * rf


# ---------------------------------------------------------------- optim
class Optimizer:
    def __init__(self, params, defaults):
        params = list(params)
        if params and not isinstance(params[0], dict): params = [{"params": params}]
        self.defaults = defaults; self.param_groups = []; self.state = {}
        for g in params:
            g = dict(g); g["params"] = list(g["params"])
            for k, v in defaults.items(): g.setdefault(k, v)
            self.param_groups.append(g)
    def zero_grad(self, set_to_none=True):
        for g in self.param_groups:
            for p in g["params"]: p.grad = None
    def state_dict(self): return {"state": self.state, "param_groups": self.param_groups}
class SGD(Optimizer):
    def __init__(self, params, lr=1e-3, momentum=0, weight_decay=0, nesterov=False):
        super().__init__(params, dict(lr=lr, momentum=momentum, weight_decay=weight_decay, nesterov=nesterov))
    def step(self):
        for g in self.param_groups:
            for p in g["params"]:
                if p.grad is None: continue
                d = p.grad.data
                if g["weight_decay"]: d = d + g["weight_decay"] * p.data
                if g["momentum"]:
                    st = self.state.setdefault(p, {}); b = st.get("buf")
                    b = d.copy() if b is None else g["momentum"] * b + d; st["buf"] = b
                    d = d + g["momentum"] * b if g["nesterov"] else b
                p.data -= (g["lr"] * d).astype(p.data.dtype)
class Adam(Optimizer):
    _decoupled = False
    def __init__(self, params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=0):
        super().__init__(params, dict(lr=lr, betas=betas, eps=eps, weight_decay=weight_decay))
    def step(self):
        for g in self.param_groups:
            b1, b2 = g["betas"]
            for p in g["params"]:
                if p.grad is None: continue
                d = p.grad.data; st = self.state.setdefault(p, {"t": 0, "m": np.zeros_like(p.data), "v": np.zeros_like(p.data)})
                if g["weight_decay"]:
                    if self._decoupled: p.data *= (1 - g["lr"] * g["weight_decay"])
                    else: d = d + g["weight_decay"] * p.data
                st["t"] += 1; t = st["t"]
                st["m"] = b1 * st["m"] + (1 - b1) * d; st["v"] = b2 * st["v"] + (1 - b2) * d * d
                mh = st["m"] / (1 - b1 ** t); vh = st["v"] / (1 - b2 ** t)
                p.data -= (g["lr"] * mh / (np.sqrt(vh) + g["eps"])).astype(p.data.dtype)
class AdamW(Adam):
    _decoupled = True
    def __init__(self, params, lr=1e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=1e-2):
        super().__init__(params, lr, betas, eps, weight_decay)
class Adamax(Optimizer):
    def __init__(self, params, lr=2e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=0):
        super().__init__(params, dict(lr=lr, betas=betas, eps=eps, weight_decay=weight_decay))
    def step(self):
        for g in self.param_groups:
            b1, b2 = g["betas"]
            for p in g["params"]:
                if p.grad is None: continue
                d = p.grad.data; st = self.state.setdefault(p, {"t": 0, "m": np.zeros_like(p.data), "u": np.zeros_like(p.data)})
                if g["weight_decay"]: d = d + g["weight_decay"] * p.data
                st["t"] += 1; t = st["t"]
                st["m"] = b1 * st["m"] + (1 - b1) * d
                st["u"] = np.maximum(b2 * st["u"], np.abs(d))
                step_size = g["lr"] / (1 - b1 ** t)
                p.data -= (step_size * st["m"] / (st["u"] + g["eps"])).astype(p.data.dtype)
class NAdam(Optimizer):
    def __init__(self, params, lr=2e-3, betas=(0.9, 0.999), eps=1e-8, weight_decay=0, momentum_decay=0.004):
        super().__init__(params, dict(lr=lr, betas=betas, eps=eps, weight_decay=weight_decay, momentum_decay=momentum_decay))
    def step(self):
        for g in self.param_groups:
            b1, b2 = g["betas"]
            for p in g["params"]:
                if p.grad is None: continue
                d = p.grad.data; st = self.state.setdefault(p, {"t": 0, "m": np.zeros_like(p.data), "v": np.zeros_like(p.data)})
                if g["weight_decay"]: d = d + g["weight_decay"] * p.data
                st["t"] += 1; t = st["t"]
                st["m"] = b1 * st["m"] + (1 - b1) * d
                st["v"] = b2 * st["v"] + (1 - b2) * d * d
                m_hat = (b1 * st["m"] / (1 - b1 ** (t + 1))) + ((1 - b1) * d / (1 - b1 ** t))
                v_hat = st["v"] / (1 - b2 ** t)
                p.data -= (g["lr"] * m_hat / (np.sqrt(v_hat) + g["eps"])).astype(p.data.dtype)
class RMSprop(Optimizer):
    def __init__(self, params, lr=1e-2, alpha=0.99, eps=1e-8):
        super().__init__(params, dict(lr=lr, alpha=alpha, eps=eps))
    def step(self):
        for g in self.param_groups:
            for p in g["params"]:
                if p.grad is None: continue
                st = self.state.setdefault(p, {"v": np.zeros_like(p.data)}); d = p.grad.data
                st["v"] = g["alpha"] * st["v"] + (1 - g["alpha"]) * d * d
                p.data -= (g["lr"] * d / (np.sqrt(st["v"]) + g["eps"])).astype(p.data.dtype)
class _Sched:
    def __init__(self, opt): self.opt = opt; self.n = 0; self.base = [g["lr"] for g in opt.param_groups]
    def _f(self, n): return 1.0
    def step(self):
        self.n += 1
        for g, b in zip(self.opt.param_groups, self.base): g["lr"] = b * self._f(self.n)
    def get_last_lr(self): return [g["lr"] for g in self.opt.param_groups]
class StepLR(_Sched):
    def __init__(self, opt, step_size, gamma=0.1): super().__init__(opt); self.ss, self.gm = step_size, gamma
    def _f(self, n): return self.gm ** (n // self.ss)
class CosineAnnealingLR(_Sched):
    def __init__(self, opt, T_max, eta_min=0.0): super().__init__(opt); self.T = T_max
    def _f(self, n): return 0.5 * (1 + math.cos(math.pi * min(n, self.T) / self.T))
class ExponentialLR(_Sched):
    def __init__(self, opt, gamma): super().__init__(opt); self.gm = gamma
    def _f(self, n): return self.gm ** n


# ---------------------------------------------------------------- utils.data & samplers
class Sampler:
    def __init__(self, data_source=None): self.data_source = data_source
    def __iter__(self): raise NotImplementedError
class SequentialSampler(Sampler):
    def __init__(self, data_source): super().__init__(data_source)
    def __iter__(self): return iter(range(len(self.data_source)))
    def __len__(self): return len(self.data_source)
class RandomSampler(Sampler):
    def __init__(self, data_source, replacement=False, num_samples=None):
        super().__init__(data_source); self.rep = replacement; self.num_samples = num_samples
    def __iter__(self):
        n = len(self.data_source); cnt = self.num_samples or n
        if self.rep: return iter(_RNG[0].integers(0, n, size=cnt).tolist())
        return iter(_RNG[0].permutation(n)[:cnt].tolist())
    def __len__(self): return self.num_samples or len(self.data_source)
class BatchSampler(Sampler):
    def __init__(self, sampler, batch_size, drop_last):
        self.sampler = sampler; self.batch_size = batch_size; self.drop_last = drop_last
    def __iter__(self):
        batch = []
        for idx in self.sampler:
            batch.append(idx)
            if len(batch) == self.batch_size:
                yield batch; batch = []
        if batch and not self.drop_last: yield batch
    def __len__(self):
        n = len(self.sampler)
        return n // self.batch_size if self.drop_last else -(-n // self.batch_size)

class Dataset:
    def __getitem__(self, i): raise NotImplementedError
class TensorDataset(Dataset):
    def __init__(self, *ts): self.ts = ts
    def __getitem__(self, i): return tuple(t[i] for t in self.ts)
    def __len__(self): return len(self.ts[0])
def _collate(items):
    f = items[0]
    if isinstance(f, Tensor): return stack(items)
    if isinstance(f, (tuple, list)): return type(f)(_collate([it[i] for it in items]) for i in range(len(f)))
    if isinstance(f, dict): return {k: _collate([it[k] for it in items]) for k in f}
    return Tensor(np.asarray(items))
class DataLoader:
    def __init__(self, dataset, batch_size=1, shuffle=False, drop_last=False, collate_fn=None, **kw):
        self.ds, self.bs, self.shuffle, self.drop, self.cf = dataset, batch_size, shuffle, drop_last, collate_fn or _collate
    def __len__(self):
        n = len(self.ds); return n // self.bs if self.drop else -(-n // self.bs)
    def __iter__(self):
        n = len(self.ds); idx = _RNG[0].permutation(n) if self.shuffle else np.arange(n)
        for s in range(0, n, self.bs):
            b = idx[s:s + self.bs]
            if self.drop and len(b) < self.bs: break
            yield self.cf([self.ds[int(i)] for i in b])
class Subset(Dataset):
    def __init__(self, ds, indices): self.ds, self.ix = ds, list(indices)
    def __getitem__(self, i): return self.ds[self.ix[i]]
    def __len__(self): return len(self.ix)
def random_split(ds, lengths):
    if all(isinstance(l, _pyfloat) for l in lengths):
        n = len(ds); ls = [_pyint(l * n) for l in lengths]; ls[-1] = n - sum(ls[:-1]); lengths = ls
    p = _RNG[0].permutation(len(ds)).tolist(); out, s = [], 0
    for l in lengths: out.append(Subset(ds, p[s:s + l])); s += l
    return out


# ---------------------------------------------------------------- assemble submodules
def _sub(name, **members):
    m = types.ModuleType(name); m.__dict__.update(members); m.__package__ = name.rpartition(".")[0]
    sys.modules[name] = m; return m

_F = _sub("torch.nn.functional", relu=lambda x: x.relu(), gelu=_gelu, tanh=lambda x: x.tanh(), sigmoid=lambda x: x.sigmoid(),
          silu=lambda x: x * x.sigmoid(), leaky_relu=_leaky, softmax=lambda x, dim=-1: x.softmax(dim),
          log_softmax=lambda x, dim=-1: x.log_softmax(dim), dropout=_dropout, linear=_linear, one_hot=_one_hot,
          conv2d=_conv2d, max_pool2d=_max_pool2d, avg_pool2d=_avg_pool2d, layer_norm=_layer_norm, mse_loss=_mse, l1_loss=_l1,
          smooth_l1_loss=_smooth_l1, huber_loss=_huber, cross_entropy=_cross_entropy, nll_loss=_nll_loss,
          binary_cross_entropy_with_logits=_bce_logits, binary_cross_entropy=_bce,
          normalize=lambda x, p=2, dim=1, eps=1e-12: x / x.norm(p, dim, keepdim=True).clamp(min=eps))
_init = _sub("torch.nn.init",
    zeros_=_init_fn(lambda t: t.zero_()), ones_=_init_fn(lambda t: t.fill_(1.0)), constant_=_init_fn(lambda t, v: t.fill_(v)),
    normal_=_init_fn(lambda t, mean=0., std=1.: t.normal_(mean, std)), uniform_=_init_fn(lambda t, a=0., b=1.: t.uniform_(a, b)),
    xavier_uniform_=_init_fn(lambda t, gain=1.: t.uniform_(-gain * math.sqrt(6 / sum(_fans(t))), gain * math.sqrt(6 / sum(_fans(t))))),
    xavier_normal_=_init_fn(lambda t, gain=1.: t.normal_(0, gain * math.sqrt(2 / sum(_fans(t))))),
    kaiming_uniform_=_init_fn(lambda t, a=0, **k: t.uniform_(-math.sqrt(6 / _fans(t)[0]), math.sqrt(6 / _fans(t)[0]))),
    kaiming_normal_=_init_fn(lambda t, a=0, **k: t.normal_(0, math.sqrt(2 / _fans(t)[0]))))
_nnutils = _sub("torch.nn.utils", clip_grad_norm_=_clip_grad_norm_, clip_grad_value_=_clip_grad_value_)
nn = _sub("torch.nn", Module=Module, Parameter=Parameter, Linear=Linear, Conv1d=Conv1d, Conv2d=Conv2d, MaxPool2d=MaxPool2d,
          AvgPool2d=AvgPool2d, Embedding=Embedding, LayerNorm=LayerNorm, BatchNorm1d=BatchNorm1d, BatchNorm2d=BatchNorm2d,
          GroupNorm=GroupNorm, Dropout=Dropout, Flatten=Flatten, Identity=Identity, ReLU=ReLU, Tanh=Tanh, Sigmoid=Sigmoid,
          GELU=GELU, SiLU=SiLU, LeakyReLU=LeakyReLU, Softmax=Softmax, LogSoftmax=LogSoftmax, Sequential=Sequential,
          ModuleList=ModuleList, MSELoss=MSELoss, L1Loss=L1Loss, SmoothL1Loss=SmoothL1Loss, HuberLoss=HuberLoss,
          CrossEntropyLoss=CrossEntropyLoss, NLLLoss=NLLLoss, BCEWithLogitsLoss=BCEWithLogitsLoss, BCELoss=BCELoss,
          functional=_F, init=_init, utils=_nnutils)
_lr = _sub("torch.optim.lr_scheduler", StepLR=StepLR, CosineAnnealingLR=CosineAnnealingLR, ExponentialLR=ExponentialLR)
optim = _sub("torch.optim", Optimizer=Optimizer, SGD=SGD, Adam=Adam, AdamW=AdamW, Adamax=Adamax, NAdam=NAdam, RMSprop=RMSprop, lr_scheduler=_lr)
_data = _sub("torch.utils.data", Dataset=Dataset, TensorDataset=TensorDataset, DataLoader=DataLoader, Subset=Subset,
             random_split=random_split, Sampler=Sampler, SequentialSampler=SequentialSampler, RandomSampler=RandomSampler,
             BatchSampler=BatchSampler)
utils = _sub("torch.utils", data=_data)
autograd = _sub("torch.autograd", Variable=lambda t, requires_grad=False: t.requires_grad_(requires_grad),
                no_grad=no_grad, grad=None)
`;

// --- Python side (runs inside Pyodide) --------------------------------------
const PY_HARNESS = String.raw`
import sys, os, json, shutil, time, traceback, warnings, io, base64
warnings.filterwarnings("ignore", message=r"The [xy] parameter as float", category=DeprecationWarning)
os.environ["MPLBACKEND"] = "Agg"
sys.dont_write_bytecode = True
WS = "/workspace"
SHIM = "/shim"
os.makedirs(WS, exist_ok=True)
if SHIM not in sys.path:
    sys.path.append(SHIM)
_FIG_N = [0]
_SHOWN_FIGS = []
_SAVE_FIGS = [False]
_FIG_DIR = "figures"

def _ion_set_save_figs(flag):
    _SAVE_FIGS[0] = bool(flag)

def _ion_reset():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        try:
            plt.close("all")
        except Exception:
            pass
    _SHOWN_FIGS.clear()
    os.chdir("/")
    shutil.rmtree(WS, ignore_errors=True)
    os.makedirs(WS, exist_ok=True)
    os.chdir(WS)
    if WS not in sys.path:
        sys.path.insert(0, WS)
    if SHIM not in sys.path:
        sys.path.append(SHIM)
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
        if getattr(fig, "_ion_saved", False):
            continue
        _FIG_N[0] += 1
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=110)
        data = buf.getvalue()
        if _SAVE_FIGS[0]:
            try:
                fdir = os.path.join(WS, _FIG_DIR)
                os.makedirs(fdir, exist_ok=True)
                fpath = os.path.join(fdir, "figure_%d.png" % _FIG_N[0])
                with open(fpath, "wb") as fh:
                    fh.write(data)
            except Exception:
                pass
        _SHOWN_FIGS.append({
            "path": "Figure %d" % _FIG_N[0],
            "mime": "image/png",
            "base64": base64.b64encode(data).decode("ascii")
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
        _ion_capture_figs()
    plt.show = _show
    from matplotlib.figure import Figure
    if not getattr(Figure.savefig, "_ion_wrapped", False):
        _orig_savefig = Figure.savefig
        def _savefig(self, *a, **k):
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

class _IonStream(io.TextIOBase):
    # Forwards every write() to JS immediately: no newline and no flush() needed
    # (tqdm-style "\\r" progress bars and print(..., end="") show up live).
    encoding = "utf-8"
    errors = "replace"
    def writable(self): return True
    def isatty(self): return False
    def fileno(self): raise io.UnsupportedOperation("fileno")
    def write(self, s):
        if not isinstance(s, str):
            s = str(s)
        if s:
            try:
                _ion_emit(s)
            except Exception:
                pass
        return len(s)
    def flush(self): pass

if "_ion_emit" in globals():
    sys.stdout = _IonStream()
    sys.stderr = _IonStream()
`;

// --- Worker side -------------------------------------------------------------
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
        // 'batched' fires once per completed line and posts immediately, even while Python is
        // still busy in a tight loop, so the main thread can stream it live.
        py.setStdout({ batched: (s) => post({ type: 'out', text: s + '\n' }) });
        py.setStderr({ batched: (s) => post({ type: 'out', text: s + '\n' }) });

        post({ type: 'status', text: 'Loading core packages (numpy)...' });
        try { await py.loadPackage('numpy'); } catch (_) {}

        if (m.torchShim) {
            try {
                py.FS.mkdirTree('/shim/torch');
                py.FS.writeFile('/shim/torch/__init__.py', m.torchShim);
            } catch (_) {}
        }

        py.globals.set('_ion_emit', (t) => post({ type: 'write', text: String(t) }));
        py.runPython(m.harness);
        return { version: py.version };
    }

    async function run(m) {
        const FS = py.FS;
        const dec = new TextDecoder();
        py.globals.get('_ion_reset')();
        py.globals.get('_ion_set_save_figs')(!!m.saveFigures);

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

// --- Main lifecycle ----------------------------------------------------------
function pyKill() {
    const st = self.__ionPy;
    self.__ionPy = null;
    if (!st) return;
    st.alive = false;
    try { st.worker.terminate(); } catch (e) { /* ignore */ }
    try { URL.revokeObjectURL(st.url); } catch (e) { /* ignore */ }
    for (const l of [...st.listeners]) l({ type: 'fatal', message: 'Pyodide runtime was stopped.' });
}

function pyRuntimeSig(indexURL, torchShimEnabled) {
    const src = PY_HARNESS + (torchShimEnabled ? PY_TORCH_SHIM : '') + __pyWorkerMain.toString();
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
    return indexURL + '#' + (h >>> 0).toString(36);
}

function pyGet(indexURL, torchShimEnabled) {
    let st = self.__ionPy;
    const sig = pyRuntimeSig(indexURL, torchShimEnabled);
    if (st && st.alive && st.indexURL === indexURL && st.sig === sig) return st;
    if (st) pyKill();
    if (typeof Worker === 'undefined') throw new Error('This browser cannot start nested Web Workers, which the Python runtime needs.');
    const url = URL.createObjectURL(new Blob(['(' + __pyWorkerMain.toString() + ')()'], { type: 'application/javascript' }));

    const worker = new Worker(url);

    st = { worker, url, indexURL, sig, alive: true, seq: 0, listeners: new Set(), ready: null };
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
            if (onEvent && (d.type === 'status' || d.type === 'out' || d.type === 'write')) onEvent(d);
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
        } catch (e) { /* skip unreadable */ }
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

// --- Card rendering (shared by the live frame and the final result) ----------
const PY_COPY_JS = `(function(b){
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

const PY_TOGGLE_JS = `(function(b){
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

// live=true  -> transient "RUNNING" frame: tail of the output, scroll-pinned, no buttons.
// live=false -> final card: clipped output, images, code toggle and copy.
function buildCard({ label, badge, secs, out = '', images = [], codeStr = '', status = '', live = false }) {
    let body;
    if (live) {
        const t = out.trimEnd();
        const tail = t.length > PY_LIVE_TAIL_CHARS ? '...[earlier output hidden while running]\n' + t.slice(-PY_LIVE_TAIL_CHARS) : t;
        body = tail
            ? `<div data-live-scroll style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; color:var(--dim,#737791); ${PY_TERM_BOX}">${esc(tail)}</div>`
            : `<div style="color:var(--dim,#737791); font-size:11px; padding:4px 2px;">${esc(status || 'Starting...')}</div>`;
    } else {
        const shown = clip(out.trim());
        body = shown
            ? `<div data-py-copy style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px; white-space:pre-wrap; word-break:break-word; color:var(--dim,#737791); ${PY_TERM_BOX}">${esc(shown)}</div>`
            : '';
        for (const img of images) {
            body += `<div style="border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:12px; display:flex; justify-content:center; background:#ffffff; margin-top:4px;">
            <img src="data:${img.mime};base64,${img.base64}" style="max-width:100%; border-radius:4px;" />
        </div>`;
        }
    }

    const buttons = live ? '' : `
                <button type="button" class="icon-btn" title="View code" aria-label="View code" onclick="${esc(PY_TOGGLE_JS)}">
                    <span class="icon" style="font-size:15px; color:var(--primary,#56b6c2); pointer-events:none;">code</span>
                </button>
                <button type="button" class="icon-btn" data-py-copy-btn title="Copy output" aria-label="Copy output" onclick="${esc(PY_COPY_JS)}">
                    <span class="icon" style="font-size:14px; pointer-events:none;">content_copy</span>
                </button>`;

    let codePane = '';
    if (!live) {
        const MAX_CODE_LINES = 500;
        const lines = codeStr.split('\n');
        const codeShown = lines.length > MAX_CODE_LINES
            ? lines.slice(0, MAX_CODE_LINES).join('\n') + `\n\n# ... [showing ${MAX_CODE_LINES} of ${lines.length} lines; use Copy for the full source] ...`
            : codeStr;
        codePane = `
        <div data-py-pane="code" style="display:none;">
            <textarea data-py-copy hidden>${esc(codeStr)}</textarea>
            <div style="background:#0e1015; border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px; white-space:pre; color:var(--fg,#dcdfe7); ${PY_TERM_BOX}">${esc(codeShown)}</div>
        </div>`;
    }

    return `<div data-py-card style="width:100%; border:1px solid var(--border,#2e2e2e); border-radius:8px; overflow:hidden; background:var(--bg-panel,#181818); margin:2px 0; font-family:var(--font-mono, monospace);">
        <div style="display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:rgba(0,0,0,0.25); border-bottom:1px solid var(--border,#2e2e2e);">
            <div style="display:flex; align-items:center; gap:7px; font-size:11.5px; color:var(--fg,#dcdfe7);">
                <span class="icon" style="font-size:14px; color:var(--primary,#56b6c2);">${live ? 'hourglass_top' : 'play_arrow'}</span>
                <span style="font-weight:600;">${esc(label)}</span>
                <span style="font-size:10px; background:${badge[2]}; color:${badge[1]}; padding:1px 6px; border-radius:3px; font-weight:700;">${badge[0]}</span>
                <span style="font-size:10px; color:var(--dim,#737791);">Pyodide &middot; ${secs}s</span>
            </div>
            <div style="display:flex; align-items:center; gap:3px;">${buttons}
            </div>
        </div>
        <div style="padding:8px;">
        <div data-py-pane="out" style="display:flex; flex-direction:column; gap:6px;">${body}</div>${codePane}
        </div>
    </div>`;
}

// --- Minimal terminal model: "\\r" rewinds the current line (tqdm), "\\n" commits it ------------
function makeTerm() {
    let done = '', cur = '', cr = false;
    return {
        feed(s) {
            for (const c of String(s)) {
                if (c === '\n') { done += cur + '\n'; cur = ''; cr = false; }
                else if (c === '\r') cr = true;
                else { if (cr) { cur = ''; cr = false; } cur += c; }
            }
            if (done.length > 1000000) done = done.slice(-500000);
        },
        text() { return done + cur; }
    };
}

// --- Live streaming into the running tool box ----------------------------------
// Uses api.showUI(html, { live: true }) (host renders it into the running box, never stores it).
// Throttled, with a guaranteed trailing render and at most one showUI call in flight.
function makeLive(api, getState) {
    const canShow = typeof api?.showUI === 'function';
    let timer = null, heartbeat = null, lastRun = 0, stopped = false, busy = false, dirty = false;

    function push() {
        if (stopped || timer) return;
        timer = setTimeout(render, Math.max(0, PY_LIVE_INTERVAL_MS - (Date.now() - lastRun)));
    }
    function render() {
        timer = null;
        if (stopped) return;
        if (busy) { dirty = true; return; }
        lastRun = Date.now(); dirty = false;
        const s = getState();
        const lastLine = s.out.trimEnd().split('\n').pop();
        if (lastLine && typeof api?.setHeaderMsg === 'function') {
            Promise.resolve(api.setHeaderMsg('> ' + lastLine.slice(0, 90))).catch(() => { });
        }
        if (!canShow) return;
        busy = true;
        const html = buildCard({
            label: s.label, badge: ['RUNNING', '#61afef', 'rgba(97,175,239,0.18)'],
            secs: ((Date.now() - s.startedAt) / 1000).toFixed(1), out: s.out, status: s.status, live: true
        });
        Promise.resolve(api.showUI(html, { live: true })).catch(() => { }).then(() => {
            busy = false;
            if (dirty && !stopped) push();
        });
    }
    heartbeat = setInterval(push, 1000);   // keeps the elapsed time ticking during silent compute
    push();
    return { push, stop() { stopped = true; clearTimeout(timer); clearInterval(heartbeat); timer = heartbeat = null; } };
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
    const saveFigures = !!(await api?.getSetting?.('saveFigures'));
    const torchShimEnabled = (await api?.getSetting?.('torchShim')) !== false;
    const argv = [targetPath, ...(Array.isArray(args.args) ? args.args.map(String) : [])];

    updateStatus('Collecting workspace files...', true);
    const notes = [];
    const files = await gatherWorkspace(api, targetPath, code, notes);
    const fileList = [...files.entries()].map(([path, data]) => ({ path, data }));

    let out = '';
    let status = '';
    const term = makeTerm();
    let outcome;
    const startedAt = Date.now();

    // Live card in the running tool box; stopped before any final result is returned.
    const live = makeLive(api, () => ({
        out, status, startedAt,
        label: args?.code && !args?.filepath ? 'inline snippet' : targetPath
    }));

    try {
        outcome = await pyExclusive(async () => {
            const st = pyGet(indexURL, torchShimEnabled);
            const onEvent = (d) => {
                if (d.type === 'status') { status = d.text; updateStatus(d.text); live.push(); }
                else if (d.type === 'out' || d.type === 'write') { term.feed(d.text); out = term.text(); live.push(); }
            };
            if (!st.ready) {
                updateStatus('Loading Pyodide runtime (first run can take 10-30 s)...', true);
                st.ready = pyCall(st, { type: 'init', indexURL, harness: PY_HARNESS, torchShim: torchShimEnabled ? PY_TORCH_SHIM : null }, [], onEvent, PY_INIT_TIMEOUT_MS,
                    'Timed out while loading the Pyodide runtime. Check your connection or the Pyodide URL setting.');
                st.ready.catch(() => { });
            }
            try { await st.ready; } catch (e) { pyKill(); throw e; }
            const transfer = fileList.map(f => f.data.buffer);
            return await pyCall(st, { type: 'run', code, path: targetPath, argv, files: fileList, allowNetwork, saveFigures },
                transfer, onEvent);
        });
    } catch (e) {
        live.stop();
        // Keep whatever was printed before the crash so training logs are not lost.
        const partial = clip(out.trim());
        return { output: `ERROR: ${e.message}${partial ? '\n\n' + partial : ''}` };
    }
    live.stop();

    const r = outcome.res || {};
    if (r.status === 'error') {
        out += (out && !out.endsWith('\n') ? '\n' : '') + (r.text || '');
        if (/ModuleNotFoundError|No module named/.test(r.text || '')) {
            out += "\n[Hint: You are running Pyodide (Wasm). Only pre-built Pyodide packages load automatically. Pure-Python wheels can be installed with `import micropip; await micropip.install('name')` if network access is enabled. Packages requiring C-extensions, CUDA/GPU, or multiprocessing (like TensorFlow) cannot run in Pyodide. Note: A CPU-only PyTorch-compatible shim is included and available via `import torch`.]";
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

    for (const f of changedFiles) {
        if (f.path === targetPath || !PY_IMAGE_EXT.test(f.path) || images.length >= 6 || f.data.length >= 6 * 1024 * 1024) continue;
        const key = imgKey(f.data);
        if (seenImages.has(key)) continue;
        seenImages.add(key);
        const ext = f.path.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        images.push({ path: f.path, mime, base64: bytesToB64(f.data) });
    }

    for (const s of (shownImages || [])) {
        if (images.length >= 6) continue;
        const b64 = s.base64;
        const u8 = b64 ? Uint8Array.from(atob(b64).split('').map(c => c.charCodeAt(0))) : new Uint8Array(0);
        const key = imgKey(u8);
        if (seenImages.has(key)) continue;
        seenImages.add(key);
        images.push({ path: s.path || 'plot', mime: s.mime || 'image/png', base64: b64 });
    }

    if (images.length) {
        out += (out && !out.endsWith('\n') ? '\n' : '') +
            `[${images.length} image${images.length > 1 ? 's' : ''} displayed to the user: ${images.map(i => i.path).join(', ')}]`;
    }

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

    const displayHtml = buildCard({
        label: displayLabel, badge, secs, out, images, codeStr: String(code || '')
    });
    return { output: text, displayHtml };
}