"""Функциональный тест Degg_Crop (Python) — геометрия и тензоры.

Нода работает с настоящим torch, поэтому тесту нужен интерпретатор с torch.
Системный `python` (без torch) сам перезапускает этот файл под python'ом
ComfyUI — так `python tests/_test_degg_crop.py` даёт полноценный e2e
и без ручной подстановки путей. Если torch нет нигде — тест честно падает,
а не зеленеет вслепую.

Запуск:  cd Degg_Crop && python tests/_test_degg_crop.py
"""
import os
import subprocess
import sys
from pathlib import Path

# _process/check.py читает вывод с encoding="utf-8" и ищет в нём "ТЕСТ ПРОЙДЕН".
# Кодировка по умолчанию на Windows — cp1251, поэтому фиксируем utf-8 явно.
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
    cand = os.environ.get("COMFY_PY") or \
        r"D:\ComfyUI_windows_portable\python_embeded\python.exe"
    me = Path(__file__).resolve()
    if cand and os.path.exists(cand) and \
            os.path.abspath(cand) != os.path.abspath(sys.executable):
        try:
            probe = subprocess.run([cand, "-c", "import torch"],
                                   capture_output=True, timeout=180)
        except Exception:
            probe = None
        if probe is not None and probe.returncode == 0:
            r = subprocess.run([cand, str(me)], capture_output=True)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.stdout.flush()
            sys.exit(r.returncode)
    _p("ТЕСТ НЕ ЗАПУЩЕН: нигде нет интерпретатора с torch "
       "(нужен python ComfyUI)")
    _p("FAIL: 1")
    sys.exit(1)


def _p(text):
    """Печать, устойчивая к кодировке консоли Windows."""
    try:
        enc = sys.stdout.encoding or "utf-8"
        sys.stdout.write(str(text).encode(enc, "replace").decode(enc, "replace") + "\n")
    except Exception:
        try:
            sys.stdout.write(str(text).encode("ascii", "replace").decode("ascii", "replace") + "\n")
        except Exception:
            pass


_reexec_with_torch()

import torch  # noqa: E402

# tests/ лежит на уровень ниже папки проекта (AGENTS.md §1.1) → два parent
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


# ── источник: код пикселя = row*10 + col, все каналы одинаковы ──────────────
IH, IW = 4, 6


def make_src(batch=1, channels=3, dtype=torch.float32):
    rows = torch.arange(IH, dtype=torch.float32).view(IH, 1).expand(IH, IW)
    cols = torch.arange(IW, dtype=torch.float32).view(1, IW).expand(IH, IW)
    pix = (rows * 10 + cols).view(1, IH, IW, 1).expand(1, IH, IW, channels).contiguous()
    pix = pix.to(dtype).repeat(batch, 1, 1, 1)
    if channels == 4:
        # реальный RGBA: источник непрозрачный, альфа не кодируется пикселем
        pix[..., 3] = 1.0
    return pix


def code(h, w):
    return h * 10 + w


def px(out, b, h, w, c=0):
    return float(out[b, h, w, c])


# ── INPUT_TYPES ─────────────────────────────────────────────────────────────
it = node.DeggCrop.INPUT_TYPES()
req = it["required"]
check("INPUT_TYPES: image первым (IMAGE)",
      list(req)[0] == "image" and req["image"][0] == "IMAGE", str(list(req)))
check("INPUT_TYPES: operation — Crop/Expand",
      list(req["operation"][0]) == ["Crop", "Expand"]
      and req["operation"][1]["default"] == "Crop", str(req["operation"]))
check("INPUT_TYPES: fill_color список и default=black",
      req["fill_color"][0] == node.FILL_COLORS
      and req["fill_color"][1]["default"] == "black", str(req["fill_color"]))
check("INPUT_TYPES: width/height min:1 (0 запрещён)",
      req["width"][1]["min"] == 1 and req["height"][1]["min"] == 1,
      f'{req["width"][1]["min"]} {req["height"][1]["min"]}')
check("INPUT_TYPES: x/y допускают отрицательные",
      req["x"][1]["min"] < 0 and req["y"][1]["min"] < 0,
      f'{req["x"][1]["min"]}')
_opt = it["optional"]
check("INPUT_TYPES: optional image_in",
      _opt["image_in"][0] == "IMAGE", str(it.get("optional")))
check("INPUT_TYPES: crop_* FLOAT 0..100 (OREX)",
      all(_opt[k][0] == "FLOAT" and _opt[k][1]["min"] == 0.0
          and _opt[k][1]["max"] == 100.0
          for k in ("crop_left", "crop_right", "crop_top", "crop_bottom")),
      str([k for k in _opt if k.startswith("crop_")]))
check("INPUT_TYPES: multiplicity INT 16 (OREX)",
      _opt["multiplicity"][0] == "INT" and _opt["multiplicity"][1]["default"] == 16,
      str(_opt["multiplicity"]))
check("INPUT_TYPES: resolution_mp FLOAT 0 (MP, OREX 'resolution (MP)')",
      _opt["resolution_mp"][0] == "FLOAT" and _opt["resolution_mp"][1]["default"] == 0.0,
      str(_opt["resolution_mp"]))
check("INPUT_TYPES: upscale_method — 5 методов OREX",
      list(_opt["upscale_method"][0]) == node.UPSCALE_METHODS
      and _opt["upscale_method"][1]["default"] == "bicubic",
      str(_opt["upscale_method"]))
check("INPUT_TYPES: aspect_ratio STRING + ratio_lock BOOLEAN",
      _opt["aspect_ratio"][0] == "STRING" and _opt["ratio_lock"][0] == "BOOLEAN",
      f'{_opt["aspect_ratio"][0]} {_opt["ratio_lock"][0]}')
check("INPUT_TYPES: optional mask (MASK)",
      _opt["mask"][0] == "MASK", str(_opt.get("mask")))
check("класс: FUNCTION=process, CATEGORY=My_custom_nodes/Image, OUTPUT_NODE",
      node.DeggCrop.FUNCTION == "process"
      and node.DeggCrop.CATEGORY == "My_custom_nodes/Image"
      and node.DeggCrop.OUTPUT_NODE is True)
check("класс: 4 выхода IMAGE/MASK/INT/INT (как OREX)",
      node.DeggCrop.RETURN_TYPES == ("IMAGE", "MASK", "INT", "INT")
      and node.DeggCrop.RETURN_NAMES == ("image", "mask", "width", "height"),
      str(node.DeggCrop.RETURN_TYPES))
check("маппинги: DeggCrop / Degg Crop",
      node.NODE_CLASS_MAPPINGS == {"DeggCrop": node.DeggCrop}
      and node.NODE_DISPLAY_NAME_MAPPINGS["DeggCrop"] == "Degg Crop")

# ── fill_values ─────────────────────────────────────────────────────────────
check("fill: black = 0,0,0", node.fill_values("black", 3) == (0.0, 0.0, 0.0))
check("fill: white = 1,1,1", node.fill_values("white", 3) == (1.0, 1.0, 1.0))
check("fill: red = 1,0,0", node.fill_values("red", 3) == (1.0, 0.0, 0.0))
check("fill: gray = 0.5×3", node.fill_values("gray", 3) == (0.5, 0.5, 0.5))
check("fill: неизвестный цвет → чёрный (дефолт)",
      node.fill_values("фиолетовый", 3) == (0.0, 0.0, 0.0))
check("fill: transparent на 3 канала → нули (RGB альфы не даёт)",
      node.fill_values("transparent", 3) == (0.0, 0.0, 0.0))
check("fill: transparent на 4 канала → нули (alpha=0, прозрачно)",
      node.fill_values("transparent", 4) == (0.0, 0.0, 0.0, 0.0))
check("fill: white на 4 канала → альфа 1 (непрозрачно)",
      node.fill_values("white", 4) == (1.0, 1.0, 1.0, 1.0))
check("fill: 1 канал → 1 значение", node.fill_values("white", 1) == (1.0,))
check("fill: 0 каналов → ()", node.fill_values("white", 0) == ())

# ── offset_for ──────────────────────────────────────────────────────────────
check("offset: Crop → (-x,-y)", node.offset_for("Crop", 3, 5) == (-3, -5))
check("offset: Expand → (+x,+y)", node.offset_for("Expand", 3, 5) == (3, 5))
check("offset: Crop с отрицательным x → положительный сдвиг",
      node.offset_for("Crop", -3, 0) == (3, 0))
check("offset: неизвестный режим = Crop", node.offset_for("Мусор", 1, 2) == (-1, -2))

# ── paste_region: 9 положений ──────────────────────────────────────────────
# холст 5×5, источник 4×6
P = node.paste_region
r = P(5, 5, 0, 0, 6, 4)
check("paste: источник больше холста → обрезка справа/снизу",
      r == (0, 4, 0, 5, 0, 0), str(r))
r = P(5, 5, 2, 1, 6, 4)
check("paste: сдвиг внутрь (+2,+1) → обрезка источника",
      r == (0, 4, 0, 3, 1, 2), str(r))
r = P(5, 5, -3, -2, 6, 4)
check("paste: отрицательный сдвиг → обрезка источника слева/сверху",
      r == (2, 4, 3, 6, 0, 0), str(r))
r = P(5, 5, -3, 1, 6, 4)
check("paste: сдвиг по X влево, по Y вправо",
      r == (0, 4, 3, 6, 1, 0), str(r))
r = P(5, 5, 2, -2, 6, 4)
check("paste: сдвиг по X вправо, по Y вверх",
      r == (2, 4, 0, 3, 0, 2), str(r))
r = P(5, 5, 100, 100, 6, 4)
check("paste: далеко за холстом → None", r is None, str(r))
r = P(5, 5, -100, -100, 6, 4)
check("paste: далеко до холста → None (нет пересечения)", r is None, str(r))
r = P(5, 5, 5, 0, 6, 4)
check("paste: вплотную до правого края → None", r is None, str(r))
r = P(5, 5, -1, -1, 6, 4)
check("paste: сдвиг ровно на -1 → обрезка на 1 пиксель",
      r == (1, 4, 1, 6, 0, 0), str(r))
check("paste: возвращает 6 чисел", len(P(5, 5, 0, 0, 6, 4)) == 6)

# ── e2e: Crop ───────────────────────────────────────────────────────────────
N = node.DeggCrop()

# A: окно целиком внутри → ровно окно, значения на месте
src = make_src()
out, *_ = N.process(src, "Crop", 2, 1, 3, 2, "black")
check("Crop внутри: форма = [1,2,3,3]",
      tuple(out.shape) == (1, 2, 3, 3), str(tuple(out.shape)))
check("Crop внутри: пиксель (0,0) = код источника (1,2)",
      abs(px(out, 0, 0, 0) - code(1, 2)) < 1e-5, str(px(out, 0, 0, 0)))
check("Crop внутри: пиксель (1,2) = код источника (2,4)",
      abs(px(out, 0, 1, 2) - code(2, 4)) < 1e-5, str(px(out, 0, 1, 2)))
check("Crop внутри: нет заливки (окно внутри)",
      float(out.min()) > 0.0, str(float(out.min())))

# B: окно вылезает влево/вверх → заливка в левом верхнем углу
out, *_ = N.process(src, "Crop", -2, -1, 4, 4, "white")
check("Crop частично вне: форма = [1,4,4,3]",
      tuple(out.shape) == (1, 4, 4, 3), str(tuple(out.shape)))
check("Crop частично вне: (0,0) — заливка white",
      abs(px(out, 0, 0, 0) - 1.0) < 1e-6, str(px(out, 0, 0, 0)))
check("Crop частично вне: источник начинается в (1,2)",
      abs(px(out, 0, 1, 2) - code(0, 0)) < 1e-5, str(px(out, 0, 1, 2)))
check("Crop частично вне: (0,0) чистый белый по всем каналам",
      all(abs(px(out, 0, 0, c) - 1.0) < 1e-6 for c in range(3)),
      str([px(out, 0, 0, c) for c in range(3)]))

# C: окно целиком за пределами → сплошная заливка
out, *_ = N.process(src, "Crop", 100, 100, 3, 3, "red")
check("Crop полностью вне: форма = [1,3,3,3]",
      tuple(out.shape) == (1, 3, 3, 3), str(tuple(out.shape)))
check("Crop полностью вне: всё red (1,0,0)",
      abs(px(out, 0, 0, 0) - 1.0) < 1e-6
      and abs(px(out, 0, 2, 2, 1)) < 1e-6
      and abs(px(out, 0, 2, 2, 2)) < 1e-6,
      str([px(out, 0, 0, c) for c in range(3)]))

# ── e2e: Expand ─────────────────────────────────────────────────────────────
out, *_ = N.process(src, "Expand", -3, -2, 5, 5, "black")
check("Expand отрицательный: форма = [1,5,5,3]",
      tuple(out.shape) == (1, 5, 5, 3), str(tuple(out.shape)))
check("Expand отрицательный: источник в (0,0) = код (2,3)",
      abs(px(out, 0, 0, 0) - code(2, 3)) < 1e-5, str(px(out, 0, 0, 0)))
check("Expand отрицательный: правее источника — заливка",
      abs(px(out, 0, 0, 4)) < 1e-6, str(px(out, 0, 0, 4)))
check("Expand отрицательный: под источником — заливка",
      abs(px(out, 0, 4, 0)) < 1e-6, str(px(out, 0, 4, 0)))
check("Expand отрицательный: (1,1) = код (3,4)",
      abs(px(out, 0, 1, 1) - code(3, 4)) < 1e-5, str(px(out, 0, 1, 1)))

out, *_ = N.process(src, "Expand", 2, 1, 5, 5, "blue")
check("Expand положительный: форма = [1,5,5,3]",
      tuple(out.shape) == (1, 5, 5, 3), str(tuple(out.shape)))
check("Expand положительный: источник в (1,2) = код (0,0)",
      abs(px(out, 0, 1, 2) - code(0, 0)) < 1e-5, str(px(out, 0, 1, 2)))
check("Expand положительный: (0,0) — заливка blue (0,0,1)",
      abs(px(out, 0, 0, 0)) < 1e-6 and abs(px(out, 0, 0, 0, 2) - 1.0) < 1e-6,
      str([px(out, 0, 0, c) for c in range(3)]))
check("Expand положительный: источник обрезан по правому краю холста",
      abs(px(out, 0, 4, 4) - code(3, 2)) < 1e-5, str(px(out, 0, 4, 4)))

# ── каналы / батч / dtype ───────────────────────────────────────────────────
src4 = make_src(channels=4)
out, *_ = N.process(src4, "Expand", 0, 0, 8, 6, "white")
check("RGBA: остаётся 4 канала", out.shape[3] == 4, str(tuple(out.shape)))
check("RGBA: источник (альфа 1) не тронут",
      abs(px(out, 0, 0, 0, 3) - 1.0) < 1e-6, str(px(out, 0, 0, 0, 3)))
check("RGBA: паддинг white → альфа 1",
      abs(px(out, 0, 5, 7, 3) - 1.0) < 1e-6, str(px(out, 0, 5, 7, 3)))

out, *_ = N.process(src4, "Expand", 0, 0, 8, 6, "transparent")
check("RGBA + transparent: паддинг полностью прозрачен (0,0,0,0)",
      all(abs(px(out, 0, 5, 7, c)) < 1e-6 for c in range(4)),
      str([px(out, 0, 5, 7, c) for c in range(4)]))
check("RGBA + transparent: источник сохранён (альфа 1)",
      abs(px(out, 0, 0, 0, 3) - 1.0) < 1e-6, str(px(out, 0, 0, 0, 3)))

out, *_ = N.process(src, "Expand", 0, 0, 8, 6, "transparent")
check("RGB + transparent: остаётся 3 канала (не ломаем VAE)",
      out.shape[3] == 3, str(tuple(out.shape)))
check("RGB + transparent: паддинг чёрный (альфы нет)",
      all(abs(px(out, 0, 5, 7, c)) < 1e-6 for c in range(3)),
      str([px(out, 0, 5, 7, c) for c in range(3)]))

srcf16 = make_src(dtype=torch.float16)
out, *_ = N.process(srcf16, "Expand", 1, 1, 8, 6, "black")
check("dtype float16 сохраняется", out.dtype == torch.float16, str(out.dtype))

srcb = make_src(batch=3)
out, *_ = N.process(srcb, "Crop", 1, 1, 2, 2, "black")
check("батч 3: форма [3,2,2,3]", tuple(out.shape) == (3, 2, 2, 3), str(tuple(out.shape)))
check("батч 3: все батчи одинаково обработаны",
      abs(px(out, 2, 1, 1) - px(out, 0, 1, 1)) < 1e-6,
      f"{px(out, 2, 1, 1)} vs {px(out, 0, 1, 1)}")

# ── image_in приоритетнее image ─────────────────────────────────────────────
alt = torch.full((1, 2, 2, 3), 7.0)
out, *_ = N.process(src, "Expand", 0, 0, 2, 2, "black", image_in=alt)
check("image_in перекрывает image",
      abs(px(out, 0, 0, 0) - 7.0) < 1e-6, str(px(out, 0, 0, 0)))

# ── ошибки не молчат ────────────────────────────────────────────────────────
try:
    N.process(None, "Crop", 0, 0, 4, 4, "black")
    check("image=None → ValueError", False)
except ValueError:
    check("image=None → ValueError", True)

try:
    N.process(torch.zeros(4, 6, 3), "Crop", 0, 0, 4, 4, "black")
    check("3D-вход → ValueError про [B,H,W,C]", False)
except ValueError as e:
    check("3D-вход → ValueError про [B,H,W,C]", "[B,H,W,C]" in str(e), str(e))

# ── percent_rect / selection_rect / target_size (OREX-паритет) ─────────────
check("percent_rect: crop_left=50% из 6 → (3,0,6,4)",
      node.percent_rect(6, 4, 50, 0, 0, 0) == (3, 0, 6, 4),
      str(node.percent_rect(6, 4, 50, 0, 0, 0)))
check("percent_rect: crop_right=50% → правая половина (0,0,3,4)",
      node.percent_rect(6, 4, 0, 50, 0, 0) == (0, 0, 3, 4),
      str(node.percent_rect(6, 4, 0, 50, 0, 0)))
check("percent_rect: crop_top=50% → нижняя половина (0,2,6,4)",
      node.percent_rect(6, 4, 0, 0, 50, 0) == (0, 2, 6, 4),
      str(node.percent_rect(6, 4, 0, 0, 50, 0)))
check("percent_rect: crop_bottom=50% → верх (0,0,6,2)",
      node.percent_rect(6, 4, 0, 0, 0, 50) == (0, 0, 6, 2),
      str(node.percent_rect(6, 4, 0, 0, 0, 50)))
check("percent_rect: 100% слева зажато до 1px (как OREX)",
      node.percent_rect(6, 4, 100, 0, 0, 0) == (5, 0, 6, 4),
      str(node.percent_rect(6, 4, 100, 0, 0, 0)))
check("percent_rect: обе стороны 100% → не пустой прямоугольник",
      node.percent_rect(6, 4, 100, 100, 100, 100)[2] >
      node.percent_rect(6, 4, 100, 100, 100, 100)[0],
      str(node.percent_rect(6, 4, 100, 100, 100, 100)))
check("percent_rect: все 0 → (0,0,6,4)",
      node.percent_rect(6, 4, 0, 0, 0, 0) == (0, 0, 6, 4),
      str(node.percent_rect(6, 4, 0, 0, 0, 0)))

check("selection_rect: crop_% приоритетнее окна (x,y)",
      node.selection_rect(6, 4, 0, 0, 512, 512, 50, 0, 0, 0) == (3, 0, 6, 4),
      str(node.selection_rect(6, 4, 0, 0, 512, 512, 50, 0, 0, 0)))
check("selection_rect: без crop_% → окно (x,y,w,h)",
      node.selection_rect(6, 4, 2, 1, 3, 2) == (2, 1, 5, 3),
      str(node.selection_rect(6, 4, 2, 1, 3, 2)))
check("selection_rect: нулевой width → min 1px",
      node.selection_rect(6, 4, 0, 0, 0, 0) == (0, 0, 1, 1),
      str(node.selection_rect(6, 4, 0, 0, 0, 0)))
check("selection_rect: окно может вылезать за источник (как раньше)",
      node.selection_rect(6, 4, -2, -1, 4, 4) == (-2, -1, 2, 3),
      str(node.selection_rect(6, 4, -2, -1, 4, 4)))

check("target_size: need_resize=False → точные width/height, без кратности",
      node.target_size(3, 4, 513, 257, 0.0, 16, False) == (513, 257),
      str(node.target_size(3, 4, 513, 257, 0.0, 16, False)))
check("target_size: кратность 16 округляет до 512/256",
      node.target_size(3, 4, 513, 257, 0.0, 16, True) == (512, 256),
      str(node.target_size(3, 4, 513, 257, 0.0, 16, True)))
check("target_size: кратность 1 → без округления",
      node.target_size(3, 4, 513, 257, 0.0, 1, True) == (513, 257),
      str(node.target_size(3, 4, 513, 257, 0.0, 1, True)))
_t = node.target_size(6, 4, 512, 512, 0.01, 16, True)
check("target_size: MP задаёт площадь ~10000 px, кратно 16",
      _t[0] % 16 == 0 and _t[1] % 16 == 0
      and abs(_t[0] * _t[1] - 10000) < 1600,
      f"{_t} area={_t[0] * _t[1]}")
check("target_size: MP сохраняет пропорции холста 6:4 (±округление до 16)",
      abs((_t[0] / _t[1]) - 1.5) <= 0.15, f"{_t[0] / _t[1]:.3f}")

# ── e2e: percent-режим (выделение в %, как OREX) ────────────────────────────
out, msk, ow, oh, *_ = N.process(src, "Crop", 0, 0, 3, 4, "black",
                                  crop_left=50.0, multiplicity=1)
check("percent Crop: форма [1,4,3,3] (левая половина)",
      tuple(out.shape) == (1, 4, 3, 3), str(tuple(out.shape)))
check("percent Crop: (0,0) = код источника (0,3)",
      abs(px(out, 0, 0, 0) - code(0, 3)) < 1e-5, str(px(out, 0, 0, 0)))
check("percent Crop: (3,3) = код (3,5)",
      abs(px(out, 0, 3, 2) - code(3, 5)) < 1e-5, str(px(out, 0, 3, 2)))
check("percent Crop: width/height отражают выход",
      ow == 3 and oh == 4, f"{ow}x{oh}")
check("percent Crop: маска без входа = единицы",
      tuple(msk.shape) == (1, 4, 3) and float(msk.min()) == 1.0,
      str(tuple(msk.shape)))

out, msk, ow, oh, *_ = N.process(src, "Crop", 0, 0, 6, 8, "black",
                                  crop_left=50.0, resolution_mp=0.0,
                                  multiplicity=1, upscale_method="nearest-exact")
check("percent + цель width×height: ресайз 3×4 → 6×8",
      tuple(out.shape) == (1, 8, 6, 3), str(tuple(out.shape)))
check("percent + nearest-exact: угловый пиксель не смешан",
      abs(px(out, 0, 0, 0) - code(0, 3)) < 1e-5, str(px(out, 0, 0, 0)))

out, msk, ow, oh, *_ = N.process(src, "Expand", 1, 2, 6, 6, "black",
                                  crop_right=50.0, multiplicity=1,
                                  mask=torch.ones(1, 4, 6))
check("percent Expand: форма = [1,6,6,3] (холст width×height)",
      tuple(out.shape) == (1, 6, 6, 3), str(tuple(out.shape)))
check("percent Expand: содержимое в (x,y)=(1,2) → код (0,0)",
      abs(px(out, 0, 2, 1) - code(0, 0)) < 1e-5, str(px(out, 0, 2, 1)))
check("percent Expand: (0,0) — заливка",
      abs(px(out, 0, 0, 0)) < 1e-6, str(px(out, 0, 0, 0)))
check("percent Expand: правее выделения (x=4) — заливка, не источник",
      abs(px(out, 0, 2, 4)) < 1e-6, str(px(out, 0, 2, 4)))
check("percent Expand: маска той же формы, паддинг 0, содержимое 1",
      tuple(msk.shape) == (1, 6, 6) and float(msk[0, 0, 0]) == 0.0
      and float(msk[0, 2, 1]) == 1.0,
      f"{tuple(msk.shape)} {float(msk[0, 0, 0])} {float(msk[0, 2, 1])}")

# MP-режим без crop_%: ресайз включается только из-за MP
out, msk, ow, oh, *_ = N.process(src, "Crop", 0, 0, 6, 4, "black",
                                  resolution_mp=0.000006, multiplicity=1,
                                  upscale_method="area")
check("MP без crop_%: площадь ~6 px (0.000006 MP)",
      abs(out.shape[1] * out.shape[2] - 6) <= 3,
      f"{out.shape[1]}x{out.shape[2]}")
check("MP: width/height = фактический выход",
      ow == out.shape[2] and oh == out.shape[1], f"{ow}x{oh}")

# без crop_% и MP ресайза нет (легаси не тронут)
out, msk, ow, oh, *_ = N.process(src, "Crop", 2, 1, 3, 2, "black")
check("без crop_%/MP: выход ровно окно, пиксели не интерполированы",
      tuple(out.shape) == (1, 2, 3, 3) and abs(px(out, 0, 0, 0) - code(1, 2)) < 1e-5,
      str(tuple(out.shape)))

# ── маска: slicing / resize / ошибки ────────────────────────────────────────
m_src = torch.zeros((1, 4, 6))
m_src[0, 1, 2] = 1.0
out, msk, *_ = N.process(src, "Crop", 1, 1, 2, 2, "black", mask=m_src)
check("маска: обрезается тем же окном [1,2,2]",
      tuple(msk.shape) == (1, 2, 2) and float(msk[0, 0, 1]) == 1.0
      and float(msk[0, 0, 0]) == 0.0,
      f"{tuple(msk.shape)} {float(msk[0, 0, 1])}")

out, msk, *_ = N.process(src, "Crop", 1, 1, 2, 2, "black",
                         mask=torch.ones(6, 4))
check("маска 2D [H,W] принимается",
      tuple(msk.shape) == (1, 2, 2) and float(msk.min()) == 1.0,
      str(tuple(msk.shape)))

out, msk, *_ = N.process(src, "Expand", 0, 0, 8, 6, "black",
                         mask=torch.ones(1, 4, 6))
check("Expand + маска: форма = холсту",
      tuple(msk.shape) == (1, 6, 8), str(tuple(msk.shape)))
check("Expand + маска: паддинг = 0 (fill маски)",
      float(msk[0, 5, 7]) == 0.0 and float(msk[0, 0, 0]) == 1.0,
      f"{float(msk[0, 5, 7])} {float(msk[0, 0, 0])}")

try:
    node._fit_mask(torch.ones(1, 4, 6, 1, 1), 4, 6)
    check("маска 5D → ValueError", False)
except ValueError as e:
    check("маска 5D → ValueError про MASK [B,H,W]", "[B,H,W]" in str(e), str(e))

# маска под ресайзом
out, msk, *_ = N.process(src, "Crop", 0, 0, 12, 8, "black",
                         crop_left=50.0, multiplicity=1,
                         upscale_method="nearest-exact", mask=m_src)
check("маска ресайзится вместе с изображением",
      tuple(msk.shape) == (1, 8, 12), str(tuple(msk.shape)))

# ── 4 выхода ────────────────────────────────────────────────────────────────
res = N.process(src, "Crop", 0, 0, 3, 2, "black")
check("process возвращает 4 значения (image, mask, width, height)",
      len(res) == 4 and isinstance(res[2], int) and isinstance(res[3], int),
      str(len(res)))
check("выходы 3/4 = форма изображения",
      res[2] == res[0].shape[2] and res[3] == res[0].shape[1],
      f"{res[2]}x{res[3]}")

# ── _interpolate ────────────────────────────────────────────────────────────
same = node._interpolate(src, IH, IW, "bicubic")
check("_interpolate: одинаковый размер → тот же тензер (без копии)",
      same is src)
for _m in node.UPSCALE_METHODS:
    _o = node._interpolate(src, 8, 12, _m)
    check(f"_interpolate({_m}): форма [1,8,12,3]",
          tuple(_o.shape) == (1, 8, 12, 3), str(tuple(_o.shape)))

# ── итог ────────────────────────────────────────────────────────────────────
_p("")
_p(f"torch {torch.__version__} ({sys.executable})")
_p(f"ok: {len(oks)}   FAIL: {len(fails)}")
if fails:
    _p("провалы:")
    for f in fails:
        _p("  - " + f)
    sys.exit(1)
_p("ТЕСТ ПРОЙДЕН")
