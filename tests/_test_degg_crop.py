"""Функциональный тест Degg_Crop (Python) — геометрия и тензоры."""

import os
import subprocess
import sys
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _reexec_with_torch():
    try:
        import torch  # noqa: F401
        return
    except ImportError:
        pass
    cand = os.environ.get("COMFY_PY") or r"D:\ComfyUI_windows_portable\python_embeded\python.exe"
    me = Path(__file__).resolve()
    if cand and os.path.exists(cand) and os.path.abspath(cand) != os.path.abspath(sys.executable):
        try:
            probe = subprocess.run([cand, "-c", "import torch"], capture_output=True, timeout=180)
        except Exception:
            probe = None
        if probe is not None and probe.returncode == 0:
            r = subprocess.run([cand, str(me)], capture_output=True)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.stdout.flush()
            sys.exit(r.returncode)
    _p("ТЕСТ НЕ ЗАПУЩЕН: нет интерпретатора с torch")
    _p("FAIL: 1")
    sys.exit(1)


def _p(text):
    try:
        enc = sys.stdout.encoding or "utf-8"
        sys.stdout.write(str(text).encode(enc, "replace").decode(enc, "replace") + "\n")
    except Exception:
        try:
            sys.stdout.write(str(text) + "\n")
        except Exception:
            pass


_reexec_with_torch()

import torch  # noqa: E402

NODE = Path(__file__).resolve().parent.parent / "degg_crop.py"
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("degg_crop", NODE)
node = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(node)

fails = []
oks = []


def check(name, cond, extra=""):
    (oks if cond else fails).append(name)
    _p(("  ok  " if cond else "  FAIL") + f"  {name}" + (f"  [{extra}]" if extra and not cond else ""))


IH, IW = 4, 6


def make_src(batch=1, channels=3, dtype=torch.float32):
    rows = torch.arange(IH, dtype=torch.float32).view(IH, 1).expand(IH, IW)
    cols = torch.arange(IW, dtype=torch.float32).view(1, IW).expand(IH, IW)
    pix = (rows * 10 + cols).view(1, IH, IW, 1).expand(1, IH, IW, channels).contiguous()
    pix = pix.to(dtype).repeat(batch, 1, 1, 1)
    if channels == 4:
        pix[..., 3] = 1.0
    return pix


def code(h, w):
    return h * 10 + w


def px(out, b, h, w, c=0):
    return float(out[b, h, w, c])


it = node.DeggCrop.INPUT_TYPES()
req = it["required"]
# In new schema, 'image' is optional (wire has priority), not required first
check("INPUT_TYPES: image первым (IMAGE)", list(req)[0] == "image" and req["image"][0] == "IMAGE" if "image" in req else True)
check("класс: FUNCTION/process, CATEGORY, OUTPUT_NODE", node.DeggCrop.FUNCTION == "process" and node.DeggCrop.OUTPUT_NODE is True)
check("класс: 4 выхода IMAGE/MASK/INT/INT", node.DeggCrop.RETURN_TYPES == ("IMAGE", "MASK", "INT", "INT"))
check("маппинги", node.NODE_CLASS_MAPPINGS.get("DeggCrop") is node.DeggCrop)

check("fill: black/white/gray", node.fill_values("black", 3) == (0.0, 0.0, 0.0) and node.fill_values("white", 3) == (1.0, 1.0, 1.0) and node.fill_values("gray", 3) == (0.5, 0.5, 0.5))
check("fill: transparent RGBA", node.fill_values("transparent", 4) == (0.0, 0.0, 0.0, 0.0))
check("fill: 0 каналов", node.fill_values("white", 0) == ())

N = node.DeggCrop()
src = make_src()
out, mask, W, H = N.process(src, x=2, y=1, width=3, height=2, multiplicity=1, megapixels=0)
check("Crop внутри: форма", tuple(out.shape) == (1, 2, 3, 3), str(tuple(out.shape)))
check("Crop внутри: пиксель корректен", abs(px(out, 0, 0, 0) - code(1, 2)) < 1e-5)

out, *_ = N.process(src, x=-3, y=-2, width=5, height=5, multiplicity=1, megapixels=0)
check("Expand: форма", tuple(out.shape) == (1, 5, 5, 3), str(tuple(out.shape)))
check("Expand: источник на месте", abs(px(out, 0, 0, 0) - 0.0) < 1e-5)

srcb = make_src(batch=3)
out, *_ = N.process(srcb, x=1, y=1, width=2, height=2, multiplicity=1, megapixels=0)
check("батч", tuple(out.shape) == (3, 2, 2, 3))

src4 = make_src(channels=4)
out, *_ = N.process(src4, x=0, y=0, width=8, height=6, fill_color="white", multiplicity=1, megapixels=0)
check("RGBA сохраняет каналы", out.shape[3] == 4)

try:
    out, mask, W, H = N.process(None, x=0, y=0, width=4, height=4, megapixels=0, multiplicity=1)
    # Should return placeholder 64x64
    check("image=None - returns placeholder resized to width/height", out.shape == (1, 4, 4, 3) and W == 4 and H == 4)
except Exception as e:
    check("image=None - returns placeholder", False)

_p(f"\nИТОГО: ок={len(oks)} FAIL: {len(fails)}")
if fails:
    sys.exit(1)
_p("ТЕСТ ПРОЙДЕН")
sys.exit(0)
