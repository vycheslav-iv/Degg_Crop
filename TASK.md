# ТЗ для другой модели — Degg_Crop: завершить перенос OREX, довести проверки до зелёного

> Покажи этот файл + `SPECIFICATION.md` + `SESSION_MEMORY.md` новой модели.
> Обязательны к прочтению: `F:\AI_projects\Custom_node_ComfyUI\AGENTS.md` (§1–§2, §4–§5).

---

## 1. Цель

Закончить ноду **Degg_Crop** (обрезка Crop + расширение холста Expand):
перенести интерактивную механику из референса OREX в JS, починить красный аудит,
обновить locales и смоук, получить полностью зелёный `check.py`, синхронизировать
с рабочей копией ComfyUI и проверить вживую.

## 2. Пути

| Что | Путь |
|---|---|
| Исходник (править ТОЛЬКО здесь) | `F:\AI_projects\Custom_node_ComfyUI\Degg_Crop\` |
| Рабочая копия ComfyUI | `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Crop\` |
| Референс OREX (JS 953 строки) | `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-orex\js\OreX_Crop.js` |
| Проверка | `python _process/check.py Degg_Crop` (запуск из корня `F:\AI_projects\Custom_node_ComfyUI`) |
| Синхронизация | `python sync.py Degg_Crop` (сама чистит `__pycache__`) |

Правила: только Git Bash; тесты лежат в `Degg_Crop/tests/` и запускаются из папки
проекта; `check.json` **не менять**; после каждого шага — синхронизация в рабочую копию.

## 3. Текущее состояние (факты, проверены чтением файлов)

| Файл | Строк | Состояние |
|---|---|---|
| `degg_crop.py` | 352 | ✅ ГОТОВ. 18 входов, выходы `("IMAGE","MASK","INT","INT")`, `OUTPUT_NODE=True`, ленивые numpy/PIL. Python-тест зелёный — **не ломать** |
| `web/js/degg_crop.js` | 355 | ❌ СТАРЫЙ. Только превью + invalidate, фич OREX нет. **Нужно переписать (~900 строк)** |
| `tests/_smoke_degg_crop.mjs` | 276 | ⚠️ Зелёный, но покрывает только старый JS. **Нужно расширить** |
| `tests/_audit_degg_crop.mjs` | 193 | ❌ RED: `ok: 68 / FAIL: 5` |
| `locales/ru+en/nodeDefs.json` | 17 | ❌ Устарели: 8 входов, выход только `"0"` |
| Рабочая копия (D:\) | — | ❌ УСТАРЕВШАЯ ВЕЗДЕ: python 139 строк с `RETURN_TYPES = ("IMAGE",)` — `sync.py` не запускался |

5 FAIL аудита и их фиксы:

1. `python: RETURN_TYPES = ('IMAGE',)` → regex под 4 выхода: `/RETURN_TYPES\s*=\s*\("IMAGE",\s*"MASK",\s*"INT",\s*"INT"\)/`
2. `python: RETURN_NAMES = ('image',)` → `/RETURN_NAMES\s*=\s*\("image",\s*"mask",\s*"width",\s*"height"\)/`
3. `python: numpy не импортируется` → текущий бен `!/^\s*(import numpy)/m` глотает ленивый импорт с отступом (`degg_crop.py:169`); фикс — привязка к колонке 0: `/^(import numpy|from numpy)/m`
4. `python: PIL не импортируется` → аналогично: `/^(from PIL|import PIL)/m`
5. `python: входы INPUT_TYPES — ровно 8 нужных` → ровно 18: `image, operation, x, y, width, height, fill_color, image_in, crop_left, crop_right, crop_top, crop_bottom, multiplicity, resolution_mp, upscale_method, aspect_ratio, ratio_lock, mask`

Плюс: заменить слабую siblings-проверку (строки 40–41) на `OUTPUT_NODE = True`;
locales — 18 входов + выходы `"0".."3"`;
добавить JS-проверки `Ratio Presets` / `Load Image` / `window.DeggCropPreview`.

## 4. Задачи по шагам

### Шаг 1. Переписать `web/js/degg_crop.js`
Полный дизайн — в `SPECIFICATION.md` (§4–§10). Кратко: сохранить api-bootstrap,
`getImageUrl`, `ensureImage`, `layoutCrop`/`layoutExpand`, `strokeRect`, `fitNode`,
каркас `registerExtension`; добавить math (`pyRound` банковский, `roundMult`,
`mpTargets`, `percentRectFromMargins`, `pythonTarget`), состояние (`getSel`,
`isPercent`), layout (`computeLayout`), синки (`syncCropDisplays` **только Crop+pct**,
`syncAspectDisplay`, `applyAspectRatio`, `postRectSync`), мышь (raw-записи на move,
весь синк на mouseup; Expand-pct move = поля фиксированы, x/y следуют за Δ),
виджеты (`Ratio Presets` после `aspect_ratio` + кнопки Full Image/Center/Maximize/
Load Image, `serialize:false` в обоих местах, идемпотентно), расширенный draw
(бейдж размера из `pythonTarget`, БЕЗ `measureText`).

### Шаг 2. Расширить смоук → `SMOKE OK`
Добавить: `addWidget`-заглушку, в fakeCtx `stroke`/`moveTo`/`lineTo`, полный набор
виджетов (включая `aspect_ratio`, `ratio_lock`, `crop_*`, `multiplicity`,
`resolution_mp`). Новые ассерты (§11 спецификации), контрольные значения:
drag `[125,166]`→move→`x=52`; presets `"16:9"` (из окна 512×512@0,0) →
`width=640 height=360 x=0 y=76`; `fullImage` → 640/480; `pythonTarget(mp=2)` →
`[1632,1232]`; `roundMult(1000,16)=992`. Старые ~40 ассертов должны остаться зелёными
(первый `fillRect` на `y=68`, `drawImage`, `strokeRect`, дедуп виджетов).

### Шаг 3. Починить аудит + locales → `аудит чист`
Фиксы из §3 выше. Locales: 18 входов + выходы `0–3` (ru: изображение/маска/ширина/
высота; en: image/mask/width/height).

### Шаг 4. Зелёная проверка
`python _process/check.py Degg_Crop` из корня бандла → все проверки `[ok]`,
ожидаемые строки `check.json` присутствуют в выводе: `FAIL: 0` + `ТЕСТ ПРОЙДЕН`,
`SMOKE OK`, `аудит чист`.

### Шаг 5. Деплой и живая проверка
`python -m py_compile` для python → `python sync.py Degg_Crop` → перезапуск ComfyUI →
проверка в браузере (превью, drag рамки, пресеты, кнопки, бейдж размера, reopen workflow) →
**сервер выключить по окончании**.

## 5. Что нельзя ломать

- Python-контракт (§3 спецификации): проценты приоритетны; Expand-холст = width×height;
  ресайз только при `crop_% > 0` или `MP > 0`; `round()` в python — банковский.
- JS-запреты аудита: `setInterval`, `MutationObserver`, `.computeSize =`,
  `this.size =`/`node.size =` (только `setSize`), `widgets_up` — даже в комментариях
  в кодовых строках.
- `syncCropDisplays` никогда не пишет width/height вне Crop+pct; Expand не трогает
  width/height от rect; программное `w.value = …` не стреляет событиями — на это
  опирается drag.
- После работы: предложить «Сохранить память сессии?» (скил `session-memory`).
