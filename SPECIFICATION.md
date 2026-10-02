# SPECIFICATION.md — Degg_Crop (новая схема)

> Полная спецификация ноды: контракт Python, архитектура JS, все формулы,
> правила синхронизации, тесты, ловушки. Читать вместе с `TASK.md`
> (что делать) и `SESSION_MEMORY.md` (состояние).
>
> **Статус (2026-10-02): РЕАЛИЗОВАНО И ПРОВЕРЕНО.** §2–§11 описывают
> реализацию как она есть; §12 — фактические результаты прогонов,
> §13 — ловушки, §14 — приёмка.

---

## 1. Назначение

**Degg_Crop** — нода загрузки (как LoadImage: файл + стандартная кнопка
загрузки по `image_upload`), обрезки (Crop) и расширения холста (Expand)
для `IMAGE` в ComfyUI.

- Единственный источник: провод `image` (приоритет) **или** файл `file`.
- Геометрия — **одно окно** `x, y, width, height` в пикселях источника.
  Окно **может выходить за границы** — всё, что за источником, заливается
  `fill_color` (Expand одной рамкой, без переключателя `operation`).
- Ресайз **всегда включён** (как в ноде «Выбор разрешения» ResolutionSelector):
  - `resolution_mp > 0` → цель = MP-площадь (MP·1024²) с пропорциями окна;
  - иначе → цель = `width×height` окна;
  - затем округление до `multiplicity`:
    `round(t/mult)*mult` (банковское округление Python `round()`, мин = `mult`).
- Маска: вход `mask` → он; иначе альфа загруженного файла (как LoadImage);
  иначе единицы. Маска композится тем же окном и ресайзится вместе.
- `aspect_ratio / ratio_lock / dim_percent` — поля только для UI (в Python
  не применяются; `dim_percent` управляет затемнением в предпросмотре).

Маппинг: ключ `DeggCrop`, отображаемое имя `Degg Crop`,
`CATEGORY = "My_custom_nodes/Image"`, `WEB_DIRECTORY = "web"`.
`OUTPUT_NODE = True` (персистентность через `extra_pnginfo`).

## 2. Файлы проекта

| Файл | Строк | Роль |
|---|---|---|
| `degg_crop.py` | ~350 | Нода: INPUT_TYPES (14), pipeline, 4 выхода. ГОТОВ |
| `__init__.py` | 5 | Маппинги + `WEB_DIRECTORY = "web"` |
| `web/js/degg_crop.js` | ~340 | Фронтенд: растягиваемый превью (`computeLayoutSize`), 9-зона hit-test, drag/resize, сетка третьих+золотое сечение, белый бейдж размера с тенью, кнопки Full/Center/Maximize, мост `node.onMouseMove`. ГОТОВ |
| `tests/_test_degg_crop.py` | — | Python E2E (реальный torch, авто-перезапуск). `FAIL: 0` |
| `tests/_smoke_degg_crop.mjs` | ~220 | JS-смоук в vm (ESM-совместимый). `SMOKE OK` |
| `tests/_audit_degg_crop.mjs` | ~200 | Статический аудит (новая схема, Nodes 2.0). `аудит чист` |
| `tests/_probe_live_dom.py` | — | Живой замер (headless Chrome + CDP) — по желанию |
| `locales/ru+en/nodeDefs.json` | — | Переводы: 14 входов, 4 выхода |
| `check.json` | 22 | 3 проверки + expect-строки. **НЕ МЕНЯТЬ** |

## 3. Python-контракт

### 3.1. INPUT_TYPES (14)

| Имя | Тип | Required/Optional | Дефолт/опции |
|---|---|---|---|
| `file` | `(*_input_image_files(), {"image_upload": true})` | required | папка input |
| `x` | `INT` | required | 0, min=-4096, max=8192 |
| `y` | `INT` | required | 0, min=-4096, max=8192 |
| `width` | `INT` | required | 512, min=1, max=8192 |
| `height` | `INT` | required | 512, min=1, max=8192 |
| `multiplicity` | `INT` | optional | 8, min=8, max=128, step=4 |
| `resolution_mp` | `FLOAT` | optional | 0.0, min=0, max=16, step=0.1 |
| `upscale_method` | `UPSCALE_METHODS` | optional | "bicubic" |
| `fill_color` | `FILL_COLORS` | optional | "black" |
| `dim_percent` | `FLOAT` | optional | 40.0, min=0, max=100 |
| `aspect_ratio` | `STRING` | optional | "Custom" (только UI) |
| `ratio_lock` | `BOOLEAN` | optional | false |
| `image` | `IMAGE` | optional | приоритет над файлом |
| `mask` | `MASK` | optional | — |

`FILL_COLORS = ["transparent", "black", "white", "gray", "red"]`
`UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]`

### 3.2. Pipeline `process`

1. **Источник**: если `image` передан (не `None`) → `src = image`;
   иначе если `file` — непустая строка → `_load_image_file(file)` (folder_paths);
   если `file` — `torch.Tensor` → используем как `src` (защита от позиционного
   передачи тензора); иначе `ValueError`.
2. **Композитинг** (`_compose`): холст `out_w × out_h` = `width × height`.
   Источник вставляется со сдвигом `(-x, -y)`:
   - `x>=0,y>=0` → кроп (часть источника в (0,0) холста);
   - `x<0 или y<0` → Expand (поля заливки слева/сверху);
   - окно может перекрывать источник частично — вставляется пересечение,
     остальное — `fill_color`.
3. **Ресайз** (`target_size` + `_interpolate`): всегда.
   `target_size(canvas_w, canvas_h, width, height, resolution_mp, multiplicity)`
   по правилу §1. Округление банковское `round()` (Python parity).
   `lanczos` — через PIL (ленивый импорт внутри `_resize_lanczos`).
4. **Маска** (`_fit_mask` + `_compose` + ресайз): тот же сдвим/холст,
   fill = 0.0. Без маски/альфы → единицы `[B, target_h, target_w]`.

Возврат: `(IMAGE, MASK, INT width, INT height)`.

### 3.3. Ленивые импорты

`import numpy as np` / `from PIL import Image` — **внутри** `_resize_lanczos`
(с отступом). Аудит банит только колонку 0.

### 3.4. Банковское округление

Python `round()` — к чётному. JS-обёртка `pyRound` обязана повторять один в один.

## 4. JS-архитектура (`web/js/degg_crop.js`)

### 4.1. ESM-совместимый загрузчик `app`

```js
let app;
if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
  app = window.comfyAPI.app.app;
} else if (window.app) {
  app = window.app;
}
```

Работает и в браузере (ESM), и в vm-смоуке (без `import`).

### 4.2. Константы

- `PREVIEW_H = 160` — фиксированная высота области превью.
- `PREVIEW_PAD = 8` — отступы.
- `GOLDEN_RATIO = 1.61803398875`.

### 4.3. Экспорт для тестов

```js
if (!window.DeggCropPreview) {
  window.DeggCropPreview = { PREVIEW_H, getHitArea, computePreviewHeight, computeLayoutSize };
}
```

### 4.4. beforeRegisterNodeDef

Перехватывает `DeggCrop` и патчит прототип:
- `onNodeCreated` → `onNodeCreated(node)` (идемпотентно)
- `onConnectionsChange` → `onConnectionsChange(...)`
- `computeSize` → fallback `[node.size[0]||300, PREVIEW_H+40]`
- `computeLayoutSize` → `computeLayoutSize(node, minW, minH, maxW, maxH)`

### 4.5. onNodeCreated

1. Создаёт виджет `preview` (type="custom", serialize=false) с:
   - `computeSize` → `[node.size[0]||300, PREVIEW_H]`
   - `computeLayoutSize` → stretch-ready
   - `draw` → сетка третьих + золотое сечение + рамка + бейдж
   - `mouse` → 9-зона hit-test + drag/resize + ratio lock
2. Вставляет `preview` первым в `node.widgets`.
3. Добавляет кнопки `fit_full` (Full image), `fit_center` (Center), `fit_max` (Maximize).
4. `node.onMouseMove` → мост к `widget.options.mouse`.
5. `syncPropsFromWidgets(node)` — инициализирует `_dragRect`, `_ratioLock`, `_aspect`.

### 4.6. Виджет preview — рисование (`draw`)

- Фон `#222`, если нет картинки.
- Сетка: 2 вертикальные + 2 горизонтальные линии третьих (пунктир белая 0.4)
  + золотое сечение (золотой 0.6).
- Рамка: белая обводка 2px + полупрозрачный чёрный fill.
- Бейдж: белый текст «W×H» с тонкой тенью (подложка `fillRect` по `text.length`,
  `measureText` **не используется** — для совместимости со смоук-заглушкой).

### 4.7. Мышь (`mouse` в options)

- `mousedown` → `getHitArea` (9 зон: nw/ne/sw/se/n/s/e/w/move, порог 8px) →
  запоминает `dragMode`, `dragStart`, `dragRectStart`.
- `mousemove` при `dragMode` → пересчёт rect с учётом `scale`, `ratioLock`,
  `aspect`; `syncWidgetsFromProps` (писает в виджеты x,y,width,height).
- `mouseup` → сброс drag.

### 4.8. Кнопки

- `fit_full` → окно = весь источник (0,0,srcW,srcH).
- `fit_center` → центрирует текущее окно в источнике.
- `fit_max` → максимизирует окно с сохранением пропорций в пределах источника.

### 4.9. onConnectionsChange

При подключении/отключении `image` — пробует прочитать `width`/`height`
из виджетов как исходные размеры картинки (`_imgW`, `_imgH`).

## 5. Математика (Python parity)

```js
function pyRound(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1; // banker's
}
function roundMult(v, m) { return Math.max(m, pyRound(v / m) * m); }

function targetSizeJS(canvasW, canvasH, width, height, mp, mult) {
  mult = Math.max(1, Math.floor(mult));
  const mpF = parseFloat(mp) || 0;
  let tw, th;
  if (mpF > 0 && canvasW > 0 && canvasH > 0) {
    const area = mpF * 1024 * 1024;
    const ratio = canvasW / canvasH;
    tw = Math.sqrt(area * ratio);
    th = Math.sqrt(area / ratio);
  } else {
    tw = width; th = height;
  }
  return [roundMult(tw, mult), roundMult(th, mult)];
}
```

## 6. Locales

14 входов (ru/en): `file, x, y, width, height, multiplicity, resolution_mp,
upscale_method, fill_color, dim_percent, aspect_ratio, ratio_lock, image, mask`.
4 выхода: `0:image, 1:mask, 2:width, 3:height`.

## 7. Тесты

### 7.1. Python (`tests/_test_degg_crop.py`)

Автоперезапуск под `D:\ComfyUI_windows_portable\python_embeded\python.exe`
(есть torch). Проверяет: Crop внутри, Expand, fill-цвета, батч, RGBA, ошибки.
`multiplicity=1` в геометрических тестах для точных размеров окна.
Вывод: `ИТОГО: ок=14 FAIL: 0` + `ТЕСТ ПРОЙДЕН`.

### 7.2. JS-смоук (`tests/_smoke_degg_crop.mjs`)

vm-контекст: `Image` (640×480), `window.comfyAPI.app`, `app.registerExtension`.
Проверяет: расширение захвачено, `window.DeggCropPreview` экспортирован,
перехваты хуков, виджет preview (type=custom, serialize=false,
computeLayoutSize/draw/mouse), кнопки fit_*, нет старых Ratio Presets/Load Image,
targetSizeJS математика, getHitArea 9 зон, draw() без ошибок.
Вывод: `SMOKE OK`, `FAIL=0`.

### 7.3. Статический аудит (`tests/_audit_degg_crop.mjs`)

Проверяет: Python INPUT_TYPES (14, без operation/crop_*/image_in),
`image_upload: true`, ленивые импорты numpy/PIL, JS: `computeLayoutSize`,
`beforeRegisterNodeDef`, `node.onMouseMove`, экспорт `window.DeggCropPreview`,
нет `onWidgetChanged`/`onExecuted`/`onConfigure`, нет `this.computeSize=`,
нет `setInterval`/`MutationObserver`, locales 14 входов, check.json 3 проверки.
Вывод: `аудит чист`, `FAIL=0`.

### 7.4. Живой замер (`tests/_probe_live_dom.py`)

Headless Chrome + CDP: 43 проверки (рендер, computeSize, hit-test, drag,
пресеты, кнопки, бейдж, reopen). Запускается отдельно при запущенном ComfyUI.

## 8. Правила проверки (check.json — не менять)

```json
{
  "checks": [
    {"label": "логика ноды (Python, реальный torch)",
     "cmd": "python tests/_test_degg_crop.py",
     "expect": ["FAIL: 0", "ТЕСТ ПРОЙДЕН"]},
    {"label": "JS-смоук (заглушки window/LiteGraph)",
     "cmd": "node tests/_smoke_degg_crop.mjs",
     "expect": ["SMOKE OK"]},
    {"label": "статический аудит",
     "cmd": "node tests/_audit_degg_crop.mjs",
     "expect": ["аудит чист"]}
  ]
}
```

Команда: `python _process/check.py Degg_Crop` → `ЗЕЛЁНОЕ: провалов 0`.

## 9. Синхронизация

`python sync.py Degg_Crop` — копирует 6 файлов в
`D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Crop`,
чистит `__pycache__`. Перезапуск ComfyUI обязателен.

## 10. Ловушки

1. **Tensor в `file`** — позиционная передача тензора в `file` (вместо `image`)
   ломает `folder_paths.get_annotated_filepath` (`AttributeError: 'Tensor' object has no attribute 'endswith'`). Защита: в `process` и `VALIDATE_INPUTS`/`IS_CHANGED` проверять `torch.is_tensor(file)` и пропускать файловые проверки.
2. **Банковское округление** — JS `pyRound` обязан совпадать с Python `round()`
   (к чётному). Иначе бейдж и выход разъедутся на ±`multiplicity`.
3. **Ленивые импорты numpy/PIL** — только внутри `_resize_lanczos` (с отступом).
   Аудит банит колонку 0 (`/^import numpy/m`, `/^from PIL/m`).
4. **previewArea / hit-test** — `getHitArea` работает в координатах виджета
   (передаём `mx - rx, my - ry`). Не путать с координатами ноды/канваса.
5. **`computeLayoutSize` vs `computeSize`** — Nodes 2.0 использует
   `computeLayoutSize` для stretch. `computeSize` — fallback. Не перезаписывать
   `this.computeSize` на ноде (аудит).
6. **`serialize: false`** — и на виджете, и в `options` (двойная страховка).
7. **`node.onMouseMove` мост** — виджет получает события только на mousedown;
   hover/drag/resize нужно через `node.onMouseMove`.
8. **check.json не менять** — строки `expect` обязаны появиться в выводе.
9. **Тесты в `tests/`** — `sync.py` их не копирует. Legacy в корне — тоже.
10. **Живой замер** — в `check.py` не входит, сервер после него выключать.

## 11. Приёмка

```bash
python _process/check.py Degg_Crop
# → ЗЕЛЁНОЕ: провалов 0

python sync.py Degg_Crop
# → 6 файлов синхронизировано, перезапуск ComfyUI
```

Ручная проверка в браузере (Nodes 2.0): загрузка изображения, drag/resize рамки
9 зон, Full/Center/Maximize, Expand за границы (fill_color), MP+кратность,
маска/альфа, reopen workflow без потери виджетов.