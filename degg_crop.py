"""Degg_Crop — загрузка, обрезка (Crop) и расширение холста (Expand) для IMAGE.

Нода построена на стандартной ноде «Загрузить изображение» с расширенным
функционалом (см. TASK.md, 15 пунктов):

1. ИСТОЧНИК: файл из папки input (виджет `file` + стандартная кнопка
   «выберите файл для загрузки», создаётся фронтендом по `image_upload`)
   ЛИБО изображение по проводу (вход `image` — приоритет у провода).
   Раньше было два IMAGE-входа (image + image_in) — оставлен один `image`.
2. ГЕОМЕТРИЯ — одно окно (x, y, width, height) в пикселях источника.
   Окно МОЖЕТ лежать за границами источника: всё, что выходит за источник,
   заливается fill_color — это и есть работающий Expand (рамкой, без
   переключателя operation; пункт 15).
   Композитинг: холст = окно, источник кладётся в (-x, -y).
3. РЕСАЙЗ — включается ВСЕГДА (как в стандартной ноде «Выбор разрешения»
   ResolutionSelector):
     megapixels > 0 → цель = MP-площадь (MP·1024²) с пропорциями окна;
     иначе            → цель = размер окна;
     затем округление до кратности multiplicity — как ResolutionSelector:
     round(t/multiple)*multiple (banker's rounding, min = multiple).
4. MASK: вход mask → он; иначе альфа загруженного файла (как LoadImage);
   иначе единицы. Маска композится тем же окном и ресайзится вместе.
5. aspect_ratio / ratio_lock / dim_percent — поля только для UI (в python
   не применяются; dim_percent управляет затемнением в предпросмотре).
"""


import hashlib
import os

import torch

FILL_COLORS = ["transparent", "black", "white", "gray"]

UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

# Пропорции "Custom" в UI — python их не применяет (как в OREX):
# aspect_ratio и ratio_lock живут только в JS и управляют формой рамки.
DEFAULT_ASPECT = "Custom"

_FILL_RGB = {
    "black": (0.0, 0.0, 0.0),
    "white": (1.0, 1.0, 1.0),
    "gray": (0.5, 0.5, 0.5),
}


def fill_values(fill_color, channels):
    """Значения каналов заливки длиной `channels` (0..1).

    transparent → все нули: прозрачность существует только при 4 каналах.
    ComfyUI LoadImage всегда отдаёт RGB (3 канала) — альфы там нет, поэтому
    transparent на RGB-входе даёт чёрный (в process печатается предупреждение).
    4-й и дальневые каналы при не-transparent заливаются 1.0 (непрозрачность).
    """
    if channels <= 0:
        return ()
    if fill_color == "transparent":
        return tuple(0.0 for _ in range(channels))
    rgb = _FILL_RGB.get(fill_color, _FILL_RGB["black"])
    return tuple(rgb[i] if i < 3 else 1.0 for i in range(channels))


def paste_region(out_w, out_h, off_x, off_y, img_w, img_h):
    """Куда вписать кусок источника `img_w×img_h` в холст `out_w×out_h`
    со сдвигом (off_x, off_y).

    Возвращает (sy0, sy1, sx0, sx1, dy0, dx0) — целочисленные границы
    (y1/x1 не входят) — либо None, если пересечения нет.

    Часть источника, вылезшая за холст, отбрасывается; оставшееся место
    холста занимает заливка. Отрицательный сдвиг просто обрезается.
    """
    off_x, off_y = int(off_x), int(off_y)
    out_w, out_h = int(out_w), int(out_h)
    dx0 = max(off_x, 0)
    dy0 = max(off_y, 0)
    sx0 = max(-off_x, 0)
    sy0 = max(-off_y, 0)
    cw = min(int(img_w) - sx0, out_w - dx0)
    ch = min(int(img_h) - sy0, out_h - dy0)
    if cw <= 0 or ch <= 0:
        return None
    return (sy0, sy0 + ch, sx0, sx0 + cw, dy0, dx0)


def _compose(content, canvas_w, canvas_h, off_x, off_y, fill):
    """Кладёт content [B,H,W,C] на холст canvas_w×canvas_h со сдвигом.

    Вне источника остаётся fill — скаляр или вектор каналов.
    """
    channels = content.shape[3]
    canvas = torch.zeros((content.shape[0], int(canvas_h), int(canvas_w), channels),
                         dtype=content.dtype, device=content.device)
    values = fill_values(fill, channels) if isinstance(fill, str) else tuple(fill)
    for i, v in enumerate(values):
        if v:
            canvas[:, :, :, i] = v
    region = paste_region(canvas_w, canvas_h, off_x, off_y,
                          content.shape[2], content.shape[1])
    if region is not None:
        sy0, sy1, sx0, sx1, dy0, dx0 = region
        canvas[:, dy0:dy0 + (sy1 - sy0), dx0:dx0 + (sx1 - sx0), :] = \
            content[:, sy0:sy1, sx0:sx1, :]
    return canvas


def target_size(canvas_w, canvas_h, width, height, megapixels, multiplicity):
    """Итоговые размеры выхода: (target_w, target_h) — всегда с кратностью.

    Как в стандартной ноде «Выбор разрешения» (ResolutionSelector):
      resolution (MP) > 0 → площадь MP·1024² с пропорциями холста;
      иначе               → размеры width×height (окно рамки);
      затем  round(t / multiple) * multiple  (округление python round,
      как у ResolutionSelector), минимум — сама кратность.
    """
    mult = max(1, int(multiplicity))
    mp = float(megapixels or 0.0)
    if mp > 0 and canvas_w > 0 and canvas_h > 0:
        area = mp * 1024.0 * 1024.0
        ratio = canvas_w / canvas_h
        tw = (area * ratio) ** 0.5
        th = (area / ratio) ** 0.5
    else:
        tw, th = float(width), float(height)
    return (max(mult, int(round(tw / mult)) * mult),
            max(mult, int(round(th / mult)) * mult))


def _interpolate(img, out_h, out_w, method):
    """Ресайз тензора [B,H,W,C] методом из UPSCALE_METHODS."""
    if img.shape[1] == out_h and img.shape[2] == out_w:
        return img
    if str(method) == "lanczos":
        return _resize_lanczos(img, out_h, out_w)
    mode = {"nearest-exact": "nearest-exact", "nearest": "nearest",
            "bilinear": "bilinear", "bicubic": "bicubic",
            "area": "area"}.get(str(method), "bilinear")
    x = img.permute(0, 3, 1, 2).contiguous()
    kwargs = {}
    if mode in ("bilinear", "bicubic"):
        kwargs["align_corners"] = False
    y = torch.nn.functional.interpolate(x, size=(int(out_h), int(out_w)),
                                        mode=mode, **kwargs)
    return y.permute(0, 2, 3, 1).contiguous()


def _resize_lanczos(img, out_h, out_w):
    """Lanczos через PIL."""
    import numpy as np
    from PIL import Image

    out = []
    cpu = img.detach().to("cpu").float().clamp(0.0, 1.0)
    for i in range(cpu.shape[0]):
        arr = (cpu[i].numpy() * 255.0).astype(np.uint8)
        pil = Image.fromarray(arr)
        pil = pil.resize((int(out_w), int(out_h)), Image.Resampling.LANCZOS)
        out.append(torch.from_numpy(np.asarray(pil).astype(np.float32) / 255.0))
    return torch.stack(out, dim=0).to(img.device).to(img.dtype)


def _fit_mask(mask, img_h, img_w):
    """Маска [B,H,W] → [B,H,W,1], приведённая к размеру источника."""
    m = mask if torch.is_tensor(mask) else torch.as_tensor(mask)
    if m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim != 3:
        raise ValueError(
            f"Degg_Crop: ожидался MASK [B,H,W], получено shape={tuple(m.shape)}")
    m = m.float()
    if m.shape[1] != img_h or m.shape[2] != img_w:
        m = torch.nn.functional.interpolate(
            m.unsqueeze(1), size=(int(img_h), int(img_w)),
            mode="bilinear", align_corners=False).squeeze(1)
    return m.unsqueeze(-1)


def _input_image_files():
    """Список изображений из папки input — как в LoadImage.

    Вне окружения ComfyUI (python-тест) folder_paths недоступен → [""].
    """
    try:
        import folder_paths
        input_dir = folder_paths.get_input_directory()
        files = [f for f in os.listdir(input_dir)
                 if os.path.isfile(os.path.join(input_dir, f))]
        files = folder_paths.filter_files_content_types(files, ["image"])
        return sorted(files) if files else [""]
    except Exception:
        return [""]


def _resolve_file_path(name):
    try:
        import folder_paths
        return folder_paths.get_annotated_filepath(name)
    except Exception:
        return name


def _load_image_file(name):
    try:
        import folder_paths
        path = folder_paths.get_annotated_filepath(name)
    except Exception:
        path = name
    import numpy as np
    from PIL import Image

    img = Image.open(path)
    img = img.convert("RGBA")
    arr = np.asarray(img).astype(np.float32) / 255.0
    tensor = torch.from_numpy(arr).unsqueeze(0)
    if tensor.shape[3] == 4:
        return tensor[:, :, :, :3], tensor[:, :, :, 3:4]
    return tensor, None


class DeggCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file": (_input_image_files(),
                         {"image_upload": True,
                          "tooltip": "Изображение из папки input"}),
                "x": ("INT", {"default": 0, "min": -4096, "max": 8192, "step": 1}),
                "y": ("INT", {"default": 0, "min": -4096, "max": 8192, "step": 1}),
                "width": ("INT", {"default": 512, "min": 1, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 512, "min": 1, "max": 8192, "step": 1}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "Приоритет над файлом"}),
                "mask": ("MASK",),
                "aspect_ratio": ("STRING", {"default": DEFAULT_ASPECT}),
                "ratio_lock": ("BOOLEAN", {"default": False,
                                           "label_on": "ВКЛ",
                                           "label_off": "ВЫКЛ"}),
                "multiplicity": ("INT", {"default": 8, "min": 8, "max": 128, "step": 4}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 16.0,
                                            "step": 0.1,
                                            "tooltip": "Target resolution in megapixels (1 MP = 1024×1024); 0 = use crop size"}),
                "upscale_method": (UPSCALE_METHODS, {"default": "bicubic"}),
                "fill_color": (FILL_COLORS, {"default": "black"}),
                "dim_percent": ("FLOAT", {"default": 40.0, "min": 0.0, "max": 100.0,
                                          "step": 1.0}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "process"
    CATEGORY = "My_custom_nodes/Image"
    OUTPUT_NODE = True

    DESCRIPTION = (
        "Загрузка и обрезка/расширение. Источник: провод image или файл."
    )

    @classmethod
    def VALIDATE_INPUTS(cls, file=""):
        try:
            if file is None:
                return True
            fs = str(file).strip()
            if not fs:
                return True
            import torch as _torch
            if hasattr(_torch, "is_tensor") and _torch.is_tensor(file):
                return True
        except Exception:
            pass
        try:
            import folder_paths
            if not folder_paths.exists_annotated_filepath(file):
                return f"Invalid image file: {file}"
        except Exception:
            pass
        return True

    @classmethod
    def IS_CHANGED(cls, file="", **_kwargs):
        try:
            if file is None:
                return None
            fs = str(file).strip()
            if not fs:
                return None
            import torch as _torch
            if hasattr(_torch, "is_tensor") and _torch.is_tensor(file):
                return None
        except Exception:
            pass
        try:
            with open(_resolve_file_path(file), "rb") as f:
                return hashlib.sha256(f.read()).hexdigest()
        except Exception:
            return float("NaN")

    def process(self, file="", image=None, mask=None,
                x=0, y=0, width=512, height=512,
                aspect_ratio=DEFAULT_ASPECT, ratio_lock=False,
                multiplicity=8, megapixels=1.0, upscale_method="bicubic",
                fill_color="black", dim_percent=40.0, **kwargs):
        src = image
        loaded_mask = mask
        has_source = False
        
        try:
            import torch as _torch
            if _torch.is_tensor(file):
                src = file
                file = ""
                has_source = True
        except Exception:
            pass
        
        if src is None:
            fstr = ""
            try:
                fstr = str(file) if file is not None else ""
            except Exception:
                fstr = ""
            if fstr.strip():
                src, loaded_mask = _load_image_file(file)
                has_source = True
            else:
                # No file specified - create minimal placeholder
                import torch as _torch
                src = _torch.zeros((1, 64, 64, 3), dtype=_torch.float32)
                loaded_mask = None
                has_source = False
        try:
            import torch as _torch
            if not _torch.is_tensor(src):
                src = _torch.as_tensor(src)
        except Exception:
            pass
        try:
            import torch as _torch
            if _torch.is_tensor(src) and src.ndim != 4:
                raise ValueError(
                    f"Degg_Crop: ожидался IMAGE [B,H,W,C], получено shape={tuple(src.shape)}")
        except ValueError:
            raise
        except Exception:
            pass

        batch, img_h, img_w, channels = src.shape
        x, y = int(x), int(y)
        out_w = max(1, int(width))
        out_h = max(1, int(height))

        if fill_color == "transparent" and channels < 4:
            print("[Degg_Crop] fill_color=transparent требует RGBA (4 канала); "
                  "для RGB-входа используется black.", flush=True)

        out = _compose(src, out_w, out_h, -x, -y, fill_color)

        # Only apply megapixels scaling if we have a real source image
        # and megapixels > 0. Otherwise use widget width/height.
        effective_megapixels = megapixels if (has_source and megapixels > 0) else 0.0
        target_w, target_h = target_size(
            out_w, out_h, out_w, out_h, effective_megapixels, multiplicity)
        if out.shape[1] != target_h or out.shape[2] != target_w:
            out = _interpolate(out, target_h, target_w, upscale_method)

        base = loaded_mask
        if base is not None:
            m = _fit_mask(base, img_h, img_w)
            m_canvas = _compose(m, out_w, out_h, -x, -y, (0.0,))
            if m_canvas.shape[1] != target_h or m_canvas.shape[2] != target_w:
                m_canvas = _interpolate(m_canvas, target_h, target_w, "bilinear")
            mask_out = m_canvas[:, :, :, 0].contiguous()
        else:
            mask_out = torch.ones((batch, target_h, target_w),
                                  dtype=torch.float32, device=src.device)

        return (out, mask_out, int(out.shape[2]), int(out.shape[1]))


NODE_CLASS_MAPPINGS = {"DeggCrop": DeggCrop}
NODE_DISPLAY_NAME_MAPPINGS = {"DeggCrop": "Degg Crop"}
