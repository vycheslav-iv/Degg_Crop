# SPECIFICATION.md — Degg_Crop (новая схема, 2026-10-03)

> Полная спецификация ноды: контракт Python, архитектура JS, все формулы,
> правила синхронизации, тесты, ловушки. Читать вместе с `TASK.md`
> (что делать) и `SESSION_MEMORY.md` (состояние).
>
> **Статус (2026-10-03): РЕАЛИЗОВАНО, НО РАМКА НЕ ПОЯВЛЯЕТСЯ В UI.**
> Все проверки проходят (ЗЕЛЁНОЕ: провалов 0), синхронизировано в ComfyUI.
> **Критический баг:** JS загружается, но `onInputsChanged` не срабатывает / `_imgW`/`_imgH` не инициализируются.
> Debug-логи добавлены в JS для диагностики.

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
  - `megapixels > 0` → цель = MP-площадь (MP·1024²) с пропорциями окна;
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

| Файл | Роль |
|---|---|
| `degg_crop.py` | Python нода: INPUT_TYPES (14 входов), pipeline, 4 выхода |
| `__init__.py` | Маппинги + `WEB_DIRECTORY = "web"` |
| `web/js/degg_crop.js` | **С debug-логами** — Nodes 2.0 preview, 9-зона hit-test, drag/resize, Ratio Presets, Full/Center/Max кнопки, `onInputsChanged`/`onWidgetChanged` |
| `tests/_test_degg_crop.py` | Python E2E (реальный torch, автоперезапуск) |
| `tests/_smoke_degg_crop.mjs` | JS-смоук в vm (ESM-совместимый) |
| `tests/_audit_degg_crop.mjs` | Статический аудит (новая схема, Nodes 2.0) |
| `locales/ru+en/nodeDefs.json` | Переводы: 14 входов, 4 выхода |
| `check.json` | 3 проверки + expect-строки. **НЕ МЕНЯТЬ** |

## 3. Python-контракт (`degg_crop.py`)

### 3.1. INPUT_TYPES (14)

| Имя | Тип | Required/Optional | Дефолт/опции |
|---|---|---|---|
| `file` | `(*_input_image_files(), {"image_upload": true})` | required | папка input |
| `x` | `INT` | required | 0, min=-4096, max=8192 |
| `y` | `INT` | required | 0, min=-4096, max=8192 |
| `width` | `INT` | required | 512, min=1, max=8192 |
| `height` | `INT` | required | 512, min=1, max=8192 |
| `multiplicity` | `INT` | optional | 8, min=8, max=128, step=4 |
| `megapixels` | `FLOAT` | optional | **1.0**, min=0, max=16, step=0.1 |
| `upscale_method` | `UPSCALE_METHODS` | optional | "bicubic" |
| `fill_color` | `FILL_COLORS` | optional | "black" |
| `dim_percent` | `FLOAT` | optional | 40.0, min=0, max=100 |
| `aspect_ratio` | `STRING` | optional | "Custom" (только UI) |
| `ratio_lock` | `BOOLEAN` | optional | false |
| `image` | `IMAGE` | optional | приоритет над файлом |
| `mask` | `MASK` | optional | — |

`FILL_COLORS = ["transparent", "black", "white", "gray"]` (red удалён)
`UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]`

### 3.2. Pipeline `process`

1. **Источник**: `image` (провод, приоритет) → `file` (строка, загрузка через `folder_paths`) → тензор в `file` (позиционно) → плейсхолдер 64×64 (если ничего нет). `megapixels` применяется **только** если есть реальный источник.
2. **Композитинг** (`_compose`): холст `out_w × out_h` = `width × height`. Источник вставляется со сдвигом `(-x, -y)`. Пересечение — исходник, остальное — `fill_color`.
3. **Ресайз** (`target_size` + `_interpolate`): `megapixels` только при реальном источнике, иначе `width/height`. Банковское округление (`round()` к чётному). `lanczos` через PIL (ленивый импорт).
4. **Маска** (`_fit_mask` + `_compose` + ресайз): тот же сдвим/холст, fill = 0.0. Без маски/альфы → единицы.

Возврат: `(IMAGE, MASK, INT width, INT height)`.

### 3.3. Ленивые импорты

`numpy` / `PIL` — **внутри** `_resize_lanczos` (с отступом). Аудит банит только колонку 0.

## 4. JS-архитектура (`web/js/degg_crop.js`) — **С debug-логами**

### 4.1. ESM-совместимый загрузчик `app`

```js
console.log("[DeggCrop] === SCRIPT START ===");
console.log("[DeggCrop] window.comfyAPI:", !!window.comfyAPI);
console.log("[DeggCrop] window.app:", !!window.app);

let app;
if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
  app = window.comfyAPI.app.app;
} else if (window.app) {
  app = window.app;
} else { console.log("[DeggCrop] NO APP FOUND!"); }
console.log("[DeggCrop] app:", !!app, "registerExtension:", !!(app && app.registerExtension));
```

### 4.2. Регистрация расширения

```js
if (app && app.registerExtension) {
  app.registerExtension({
    name: EXT_NAME,
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (nodeData.name === "DeggCrop") {
        // patch onNodeCreated, onConnectionsChange, onInputsChanged, onWidgetChanged
        // computeSize, computeLayoutSize
      }
    }
  });
}
```

### 4.3. Ключевые обработчики (пропатчены в прототипе)

| Хук | Что делает | Debug-лог |
|---|---|---|
| `onNodeCreated` | Создаёт виджет `preview` (type=custom, serialize=false, computeLayoutSize/draw/mouse), вставляет первым. Добавляет `ratio_preset` combo + кнопки `fit_full/fit_center/fit_max`. Вызывает `updateImageDimensions()`. | `[DeggCrop] onNodeCreated called, node: <id>` |
| `onInputsChanged` | **Критично** — читает подключённый вход `image`, извлекает `output.shape[1]/[2]` (H/W), инициализирует `_imgW`/`_imgH`, `_dragRect`, синхронизирует виджеты, обновляет ratio preset, `setDirtyCanvas()`. | `[DeggCrop] onInputsChanged called, node: <id>, inputs: [...]` |
| `onWidgetChanged` | Обрабатывает x/y/width/height → `syncPropsFromWidgets`, пересчёт `_isExpandMode`. ratio_lock/aspect_ratio → sync. file → перезагрузка dimensions. | (нет) |
| `onConnectionsChange` | Таймаут 100мс → `updateImageDimensions()` | (нет) |

### 4.4. Виджет preview

- **type=custom**, serialize=false, `computeLayoutSize` (stretch для Nodes 2.0)
- **draw**: сетка третьих + золотое сечение + белая рамка 2px + полупрозрачный fill + бейдж «W×H»
- **mouse**: 9-зона hit-test (nw/ne/sw/se/n/s/e/w/move, порог 8px), drag/resize с ratio lock, clamp к границам изображения в Crop режиме

### 4.5. Ratio Presets

Combo `ratio_preset` (вставлен после `aspect_ratio`):
- Custom, Free (Source), 1:1, 4:3, 3:4, 16:9, 9:16, 2:3, 3:2, 21:9
- Callback → обновляет `aspect_ratio` + `ratio_lock` → `applyAspectRatio()` → пересчитывает width/height из `_imgW`/`_imgH` → `syncWidgetsFromProps`

### 4.6. Загрузка изображения (`updateImageDimensions`)

Источники (в порядке приоритета):
1. Подключённый вход `image` → `tensor:` URL → читает `output.shape` из upstream
2. LoadImage нода → `/view?filename=...&type=output` → Image.onload → натуральные W/H
3. File widget → `/view?filename=...&type=input` → Image.onload

### 4.7. Константы

- `PREVIEW_H = 160`, `PREVIEW_PAD = 8`, `GOLDEN_RATIO = 1.618...`

## 5. Locales (ru/en)

14 входов: `file, x, y, width, height, multiplicity, megapixels, upscale_method, fill_color, dim_percent, aspect_ratio, ratio_lock, image, mask`
4 выхода: `0:image, 1:mask, 2:width, 3:height`

## 6. Тесты (все проходят)

| Тест | Команда | Ожидаемый вывод |
|---|---|---|
| Python | `python tests/_test_degg_crop.py` | `ИТОГО: ок=14 FAIL=0` + `ТЕСТ ПРОЙДЕН` |
| JS Smoke | `node tests/_smoke_degg_crop.mjs` | `SMOKE OK`, `FAIL=0` |
| Audit | `node tests/_audit_degg_crop.mjs` | `аудит чист`, `FAIL=0` |
| check.py | `python _process/check.py Degg_Crop` | `ЗЕЛЁНОЕ: провалов 0` |

## 7. Известные проблемы (КРИТИЧНО)

### 7.1. Рамка не появляется в UI
**Симптомы:** Нода создаётся, но `_imgW`/`_imgH` остаются `undefined`, превью показывает "No image", рамки нет.
**Debug-логи добавлены** — после перезапуска ComfyUI в F12 Console должны появиться:
```
[DeggCrop] === SCRIPT START ===
[DeggCrop] window.comfyAPI: true
[DeggCrop] Got app from comfyAPI.app.app
[DeggCrop] Extension loading, app: true registerExtension: true
[DeggCrop] onNodeCreated called, node: <id>
[DeggCrop] onInputsChanged called, node: <id>, inputs: [...]
```
**Если логов 1-3 нет** — скрипт не загружается (кэш/путь).
**Если 4 нет** — `app.registerExtension` недоступен.
**Если 5 нет** — `beforeRegisterNodeDef` не сработал (имя ноды не "DeggCrop").
**Если 6 нет** — `onInputsChanged` не вызывается ComfyUI для этого типа входа.

### 7.2. OreX Crop работает — разница в механике
OreX использует `onNodeCreated` + ручная подписка на события графа. Degg_Crop полагается на `onInputsChanged` — возможно, ComfyUI не вызывает его для `IMAGE` входа.

**Следующий шаг для новой модели:** сравнить с OreX_Crop.js (как там получают изображение) и либо:
- Добавить `setInterval` поллинг `node.inputs[0]?.link` в `onNodeCreated`
- Использовать `app.graph.on("graphchange", ...)` как в OreX
- Проверить, вызывает ли ComfyUI `onInputsChanged` для `IMAGE` сокетов

## 8. Команды

```bash
# Проверка
python _process/check.py Degg_Crop        # ЗЕЛЁНОЕ
python tests/_test_degg_crop.py           # ТЕСТ ПРОЙДЕН
node tests/_smoke_degg_crop.mjs           # SMOKE OK
node tests/_audit_degg_crop.mjs           # АУДИТ ЧИСТ

# Синхронизация
python sync.py Degg_Crop                  # 6 файлов в ComfyUI
# Перезапуск ComfyUI ОБЯЗАТЕЛЬНЫЙ
```

## 9. Файлы для передачи новой модели

- `degg_crop.py` — Python (рабочий, тесты зелёные)
- `web/js/degg_crop.js` — JS с debug-логами (требует фикса рамки)
- `locales/ru/nodeDefs.json`, `locales/en/nodeDefs.json` — переводы
- `tests/_test_degg_crop.py`, `_smoke_degg_crop.mjs`, `_audit_degg_crop.mjs` — тесты
- `check.json` — не менять
- `SPECIFICATION.md` — этот файл
- `SESSION_MEMORY.md` — состояние сессии