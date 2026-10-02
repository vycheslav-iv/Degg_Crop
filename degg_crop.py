"""Degg_Crop — обрезка (Crop) и расширение холста (Expand) для IMAGE.

Пайплайн (один для обоих режимов, семантика OREX + прежнее поведение):

1. ВЫДЕЛЕНИЕ (selection):
     любая crop_*% > 0 → прямоугольник по процентным полям (как OREX);
     иначе            → окно (x, y, width, height) — прежнее поведение,
                        окно может выходить за границы источника.
2. КОМПОЗИТИНГ:
     Crop:   содержимое кладётся в (0,0) холста размера выделения,
             всё, что вне источника, — fill_color;
     Expand: холст width×height, содержимое кладётся в точку (x, y).
3. РЕСАЙЗ — только если crop_% > 0 или resolution > 0:
     цель = MP-площадь (если задана) иначе width×height, пропорции берутся
     от холста; размеры округляются до кратности multiplicity; метод —
     upscale_method. При crop_% = 0 и MP = 0 ресайза НЕТ — прежние
     выходные размеры сохраняются байт в байт.
4. MASK: то же выделение и тот же ресайз; без входа — единицы (OREX).
"""

import torch

FILL_COLORS = ["transparent", "black", "white", "red", "green", "blue", "gray"]

UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

# Пропорции "Custom" в UI — python их не применяет (как и OREX): aspect_ratio
# и ratio_lock живут только в JS и управляют формой выделения.
DEFAULT_ASPECT = "Custom"

_FILL_RGB = {
    "black": (0.0, 0.0, 0.0),
    "white": (1.0, 1.0, 1.0),
    "red": (1.0, 0.0, 0.0),
    "green": (0.0, 1.0, 0.0),
    "blue": (0.0, 0.0, 1.0),
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


def offset_for(operation, x, y):
    """Сдвиг источника внутри холста для выбранного режима.

    Crop: окно (x,y) в координатах источника → источник сдвигается на (-x,-y).
    Expand: источник кладётся в точку (x,y) холста.
    """
    x, y = int(x), int(y)
    if operation == "Expand":
        return (x, y)
    return (-x, -y)


def percent_rect(img_w, img_h, crop_left, crop_right, crop_top, crop_bottom):
    """Прямоугольник выделения по процентным полям — семантика OREX.

    Поля считаются от КРАЁВ изображения; результат зажимается так, чтобы
    выделение всегда содержало хотя бы 1 пиксель (как в OreX_Crop.py).
    """
    img_w, img_h = int(img_w), int(img_h)
    left = int(float(crop_left) / 100.0 * img_w)
    right_px = int(float(crop_right) / 100.0 * img_w)
    top = int(float(crop_top) / 100.0 * img_h)
    bottom_px = int(float(crop_bottom) / 100.0 * img_h)

    left = max(0, min(img_w - 1, left))
    right = max(left + 1, img_w - right_px)
    top = max(0, min(img_h - 1, top))
    bottom = max(top + 1, img_h - bottom_px)
    return (left, top, min(right, img_w), min(bottom, img_h))


def selection_rect(img_w, img_h, x, y, width, height,
                   crop_left=0.0, crop_right=0.0, crop_top=0.0, crop_bottom=0.0):
    """Выделение в координатах источника: (x1, y1, x2, y2).

    Процентные поля (любое > 0) имеют приоритет; иначе — окно (x, y,
    width, height), которое может лежать частично за пределами источника.
    """
    if any(float(v) > 0 for v in (crop_left, crop_right, crop_top, crop_bottom)):
        return percent_rect(img_w, img_h, crop_left, crop_right,
                            crop_top, crop_bottom)
    x, y = int(x), int(y)
    return (x, y, x + max(1, int(width)), y + max(1, int(height)))


def target_size(canvas_w, canvas_h, width, height, resolution, multiplicity,
                need_resize):
    """Итоговые размеры выхода: (target_w, target_h).

    resolution (MP) > 0 задаёт площадь с пропорциями холста; иначе берутся
    width/height. Кратность multiplicity применяется ТОЛЬКО когда ресайз
    включён (crop_% > 0 или MP > 0) — иначе прежние выходы не меняются.
    """
    if need_resize:
        mult = max(1, int(multiplicity))
        mp = float(resolution or 0.0)
        if mp > 0 and canvas_h > 0 and canvas_w > 0:
            area = mp * 1000000.0
            ratio = canvas_w / canvas_h
            tw = (area * ratio) ** 0.5
            th = (area / ratio) ** 0.5
        else:
            tw, th = float(width), float(height)
        return (max(mult, int(round(tw / mult) * mult)),
                max(mult, int(round(th / mult) * mult)))
    return (max(1, int(width)), max(1, int(height)))


def _interpolate(img, out_h, out_w, method):
    """Ресайз тензора [B,H,W,C] методом из UPSCALE_METHODS."""
    if img.shape[1] == out_h and img.shape[2] == out_w:
        return img
    # torch поддерживает всё, кроме lanczos — для него как в OREX берём PIL.
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
    """Lanczos через PIL — как в OreX_Crop.py (импорт внутри функции)."""
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


class DeggCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "operation": (["Crop", "Expand"], {"default": "Crop"}),
                "x": ("INT", {"default": 0, "min": -4096, "max": 8192, "step": 1}),
                "y": ("INT", {"default": 0, "min": -4096, "max": 8192, "step": 1}),
                "width": ("INT", {"default": 512, "min": 1, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 512, "min": 1, "max": 8192, "step": 1}),
                "fill_color": (FILL_COLORS, {"default": "black"}),
            },
            "optional": {
                "image_in": ("IMAGE",),
                # — OREX-паритет —
                "crop_left": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0,
                                        "step": 0.1, "tooltip": "Обрезка слева, %"}),
                "crop_right": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0,
                                         "step": 0.1, "tooltip": "Обрезка справа, %"}),
                "crop_top": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0,
                                       "step": 0.1, "tooltip": "Обрезка сверху, %"}),
                "crop_bottom": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0,
                                          "step": 0.1, "tooltip": "Обрезка снизу, %"}),
                "multiplicity": ("INT", {"default": 16, "min": 1, "max": 64,
                                         "step": 1,
                                         "tooltip": "Округлять размеры до кратных этому"}),
                "resolution_mp": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0,
                                            "step": 0.01,
                                            "tooltip": "Целевое разрешение в мегапикселях "
                                                       "(0 = отключено)"}),
                "upscale_method": (UPSCALE_METHODS, {"default": "bicubic"}),
                "aspect_ratio": ("STRING", {"default": DEFAULT_ASPECT,
                                            "tooltip": "Пропорции, например 16:9 "
                                                       "(правится в UI)"}),
                "ratio_lock": ("BOOLEAN", {"default": False,
                                           "label_on": "🟢 ВКЛ",
                                           "label_off": "🔴 ВЫКЛ"}),
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")
    FUNCTION = "process"
    CATEGORY = "My_custom_nodes/Image"
    OUTPUT_NODE = True

    DESCRIPTION = (
        "Обрезка и расширение холста. "
        "Выделение: процентные поля crop_* (как в OREX, имеют приоритет) "
        "либо окно (x, y, width, height). "
        "Crop: содержимое выделения в (0,0) холста, за границами источника — "
        "fill_color. Expand: новый холст width×height, источник в точке (x, y). "
        "Ресайз включается, когда задан crop_% или resolution: цель — MP "
        "(иначе width×height), округление до multiplicity, метод — "
        "upscale_method. Без crop_% и MP размеры не меняются. "
        "Маска: тот же выделение и ресайз, без входа — единицы. "
        "aspect_ratio/ratio_lock работают в UI (как в OREX). "
        "Если подключены оба входа, работает image_in."
    )

    def process(self, image, operation, x, y, width, height, fill_color,
                image_in=None,
                crop_left=0.0, crop_right=0.0, crop_top=0.0, crop_bottom=0.0,
                multiplicity=16, resolution_mp=0.0, upscale_method="bicubic",
                aspect_ratio=DEFAULT_ASPECT, ratio_lock=False, mask=None):
        src = image_in if image_in is not None else image
        if src is None:
            raise ValueError("Degg_Crop: входное изображение не подключено")
        if not torch.is_tensor(src):
            src = torch.as_tensor(src)
        if src.ndim != 4:
            raise ValueError(
                f"Degg_Crop: ожидался IMAGE [B,H,W,C], получено shape={tuple(src.shape)}")

        batch, img_h, img_w, channels = src.shape
        out_w = max(1, int(width))
        out_h = max(1, int(height))
        percent_mode = any(float(v) > 0 for v in
                           (crop_left, crop_right, crop_top, crop_bottom))
        need_resize = percent_mode or float(resolution_mp or 0.0) > 0

        if fill_color == "transparent" and channels < 4:
            print("[Degg_Crop] fill_color=transparent требует RGBA (4 канала); "
                  "для RGB-входа используется black.", flush=True)

        # 1. выделение
        sx0, sy0, sx1, sy1 = selection_rect(
            img_w, img_h, x, y, out_w, out_h,
            crop_left, crop_right, crop_top, crop_bottom)

        # 2. композитинг
        if operation == "Expand":
            content = (src[:, sy0:sy1, sx0:sx1, :] if percent_mode else src)
            canvas_w, canvas_h = out_w, out_h
            off_x, off_y = offset_for(operation, x, y)
        else:
            content = src
            canvas_w, canvas_h = sx1 - sx0, sy1 - sy0
            off_x, off_y = offset_for(operation, sx0, sy0)

        out = _compose(content, canvas_w, canvas_h, off_x, off_y, fill_color)

        # 3. цель и ресайз
        target_w, target_h = target_size(
            canvas_w, canvas_h, out_w, out_h, resolution_mp,
            multiplicity, need_resize)
        if out.shape[1] != target_h or out.shape[2] != target_w:
            out = _interpolate(out, target_h, target_w, upscale_method)

        # 4. маска
        if mask is not None:
            m = _fit_mask(mask, img_h, img_w)
            if operation == "Expand":
                m_content = (m[:, sy0:sy1, sx0:sx1, :] if percent_mode else m)
                m_off_x, m_off_y = off_x, off_y
            else:
                m_content = m
                m_off_x, m_off_y = off_x, off_y
            m_canvas = _compose(m_content, canvas_w, canvas_h,
                                m_off_x, m_off_y, (0.0,))
            if m_canvas.shape[1] != target_h or m_canvas.shape[2] != target_w:
                m_canvas = _interpolate(m_canvas, target_h, target_w, "bilinear")
            mask_out = m_canvas[:, :, :, 0].contiguous()
        else:
            mask_out = torch.ones((batch, target_h, target_w),
                                  dtype=torch.float32, device=src.device)

        return (out, mask_out, int(out.shape[2]), int(out.shape[1]))


NODE_CLASS_MAPPINGS = {"DeggCrop": DeggCrop}
NODE_DISPLAY_NAME_MAPPINGS = {"DeggCrop": "Degg Crop"}
