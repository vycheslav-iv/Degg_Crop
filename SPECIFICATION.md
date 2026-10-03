# SPECIFICATION.md — Degg_Crop (новая схема, 2026-10-03)

> Полная спецификация ноды: контракт Python, архитектура JS, все формулы,
> правила синхронизации, тесты, ловушки. Читать вместе с `TASK.md`
> (что делать) и `SESSION_MEMORY.md` (состояние).
>
> **Статус (2026-10-03): ИСПРАВЛЕНО И ПРОВЕРЕНО В БРАУЗЕРЕ.**
> Баг «рамка не появляется» найден и устранён; аутпеинт (рамка за пределы
> изображения) реализован и проверен в реальном браузере.
> Все проверки зелёные: `check.py` (провалов 0), Python-тест, смоук, аудит,
> живой замер (`tests/_probe_live_dom.py` — 32 ok, FAIL 0).
>
> **Три реальные причины бага** (проверено по исходникам фронтенда, скил
> `comfyui-frontend-sources`):
> 1. Фронтенд вызывает **`widget.draw(ctx, node, width, y, …)`** и
>    **`widget.mouse(e, pos, node)`** — на САМОМ виджете. Всё, что лежало в
>    `options.draw` / `options.mouse` / `options.computeSize`, **не вызывалось никогда**.
>    (`LGraphNode.drawWidgets`, `LGraphCanvas.processWidgetClick`.)
> 2. `window.comfyAPI.api` — это **пространство имён модуля**, сам клиент лежит в
>    `window.comfyAPI.api.api` → URL картинки строился неверно и превью было пустым.
> 3. Рамка была **зажата внутри изображения** (кламп в drag) — аутпеинт был невозможен.
> 4. Хука `onInputsChanged` **во фронтенде не существует** — на него нельзя опираться.
>
> Источник теперь читается лениво в `draw()` (самолечение, без таймеров).

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
| `web/js/degg_crop.js` | Nodes 2.0 preview (top-level draw/mouse/computeSize, без клампа для аутпеинта, ленивая загрузка источника), 9-зона hit-test, Ratio Presets, Full/Center/Max |
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

## 4. JS-архитектура (`web/js/degg_crop.js`)

### 4.1. Bootstrap: `pickApp()` / `pickApi()`

```js
function pickApp() {
  if (window.comfyAPI?.app?.app) return window.comfyAPI.app.app;  // экземпляр
  if (window.app) return window.app;
  return null;
}
function pickApi() {
  if (window.comfyAPI?.api?.api) return window.comfyAPI.api.api;  // клиент!
  if (window.comfyAPI?.api?.apiURL) return window.comfyAPI.api;   // fallback
  if (window.api) return window.api;
  return null;
}
```

⛔ `window.comfyAPI.api` — namespace модуля; клиент и URL-билдер — через
**`comfyAPI.api.api`**. Debug-логов в коде больше НЕТ (удалены при переписке).

### 4.2. Регистрация расширения

```js
if (app && app.registerExtension) {
  app.registerExtension({
    name: EXT_NAME,
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (nodeData.name === "DeggCrop") {
        // patch onNodeCreated, onConnectionsChange, onWidgetChanged
        // computeSize, computeLayoutSize
      }
    }
  });
}
```

### 4.3. Ключевые обработчики (пропатчены в прототипе)

| Хук | Что делает |
|---|---|
| `onNodeCreated` | Создаёт виджет `preview` (type=custom, serialize=false, top-level computeSize/computeLayoutSize/draw/mouse), вставляет первым. Добавляет `ratio_preset` combo + кнопки `fit_full/fit_center/fit_max`. |
| `onWidgetChanged` | Обрабатывает x/y/width/height → `syncPropsFromWidgets`, пересчёт Expand-режима. ratio_lock/aspect_ratio → sync. file → сброс кэша источника. |
| `onConnectionsChange` | Помечает источник изменённым (`_srcDirty`) → перерисовка; дальнейшая загрузка лениво в `draw()`. |

⛔ **Хука `onInputsChanged` во фронтенде НЕ существует** (проверено grep по
всем `.map` sourcesContent пакета) — на него нельзя опираться.
Источник читается **лениво в `draw()`** (`ensureImage`, мемоизация по URL),
без таймеров и наблюдателей. Скил: `comfyui-frontend-namespaces`.

### 4.4. Виджет preview (имя `degg_crop_preview`)

⛔ **Контракт фронтенда:** `draw` / `mouse` / `computeSize` — на ВЕРХНЕМ уровне
объекта виджета. `options.draw` / `options.mouse` фронтенд НЕ читает.

- **type=custom**, `serialize:false`, `options.canvasOnly:true (не виден в панели свойств)
- **computeSize(width) → [width, PREVIEW_H]** — фиксированная высота (без feedback loop)
- **draw(ctx, node, width, y)**: рисует в координатах ноды (`ctx.translate(0, y)`),
  запоминает `node._previewY = y` и `node._layout` (нужно для hit-test),
  лениво подгружает источник (`ensureImage`)
- **mouse(e, pos, node)**: 9-зона hit-test (nw/ne/sw/se/n/s/e/w/move, порог 8px)
- **onMouseMove ноды** — hover-курсор и продолжение drag

### 4.4.1. Аутпеинт (рамка за пределы изображения)

- **Клампа НЕТ.** `move` тянет окно свободно, в т.ч. в отрицательные x/y.
- `computeLayout` вписывает в превью **объединение** изображения и окна —
  рамка, выдвинутая за картинку, всегда видна.
- Область за окном и вне изображения заливается цветом `fill_color` (превью),
  а в Python она заполняется `fill_color` на холсте width×height.
- Цвет рамки: зелёный (Crop) → голубой (Expand).
- Пиксельные поля `x/y/width/height` задают то же самое точно: отрицательные
  `x/y` + увеличенные `width/height` = поля аутпеинта (как «Pad Image for Outpainting»).

### 4.5. Ratio Presets

Combo `ratio_preset` (вставлен после `aspect_ratio`):
- Custom, Free (Source), 1:1, 4:3, 3:4, 16:9, 9:16, 2:3, 3:2, 21:9
- Callback → обновляет `aspect_ratio` + `ratio_lock` → `applyAspectRatio()` → пересчитывает width/height из `_imgW`/`_imgH` → `syncWidgetsFromProps`

### 4.6. Загрузка изображения (`resolveImageUrl` + `ensureImage`)

Лениво в `draw()`: URL резолвится по проводам (`graph.links.get(id)`, рекурсия),
затем `Image.onload` → `_imgW`/`_imgH` → `setDirtyCanvas()`.

Источники (в порядке приоритета):
1. Подключённый вход `image` → upstream-нода (LoadImage → `/view?...&type=output`,
   другая Degg_Crop → её результат, generic → `imgs`/`tensor:`)
2. File widget → `/view?filename=...&type=input` → Image.onload

URL строится **`window.comfyAPI.api.api.apiURL(path)`** (namespace → клиент);
в этом билде даёт относительный `/api/view?...`.

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
| Живая проба | `python tests/_probe_live_dom.py` (нужен запущенный ComfyUI + headless Chrome) | `ok: 32 FAIL: 0` |
| check.py | `python _process/check.py Degg_Crop` | `ЗЕЛЁНОЕ: провалов 0` |

## 7. Известные проблемы (КРИТИЧНО)

### 7.1. Рамка не появляется в UI — ИСПРАВЛЕНО

> Ниже — историческое описание бага. Он устранён (см. блок статуса выше):
> `draw`/`mouse`/`computeSize` перенесены на верхний уровень виджета, `api`
> берётся из `comfyAPI.api.api`, кламп рамки убран.

**Симптомы (было):** нода создавалась, но `_imgW`/`_imgH` оставались `undefined`, превью показывало "No image", рамки не было.
**Вывод диагностики:** отсутствие вызовов `draw`/`mouse` объяснялось тем, что они лежали в `options` (фронтенд их не читает), а не проблемами кэша/событий.

### 7.2. OreX Crop работает — разница в механике (разобрано)

> OreX_Crop.js складывает `draw`/`mouse`/`computeSize` **на верхнем уровне**
> виджета — именно поэтому он работает. `onInputsChanged` во фронтенде нет;
> OreX читает источник прямо в `draw()` через `getImageUrl(node)`.

**Вывод:** Degg_Crop переписан по той же механике (top-level коллбэки, ленивый источник в `draw()`, `graph.links.get`).

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
- `web/js/degg_crop.js` — JS (переписан, все проверки зелёные)
- `locales/ru/nodeDefs.json`, `locales/en/nodeDefs.json` — переводы
- `tests/_test_degg_crop.py`, `_smoke_degg_crop.mjs`, `_audit_degg_crop.mjs`,
  `_probe_live_dom.py` (живой CDP-замер, нужен запущенный ComfyUI)
- `check.json` — не менять
- `SPECIFICATION.md` — этот файл
- `SESSION_MEMORY.md` — состояние сессии

Скилы (корень бандла, `.agents/skills/`): `comfyui-custom-widget-contract`,
`comfyui-frontend-namespaces`, `comfyui-frontend-sources`,
`comfyui-negative-result-audit`.