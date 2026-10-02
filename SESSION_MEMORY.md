# Память сессии — Degg_Crop (2026-10-02)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)
Полностью переписан Degg_Crop под новую схему: стандартная загрузка ComfyUI (`image_upload: true`), единая геометрия `x,y,width,height` в пикселях (без `operation`/`crop_%`), Expand через `fill_color` при выходе за границы, ресайз всегда включён с MP/multiplicity (банковское округление Python `round()`), 4 выхода (IMAGE, MASK, INT, INT). JS переписан с нуля под Nodes 2.0: растягиваемый превью через `computeLayoutSize`, 9-зона hit-test drag/resize, сетка третьих+золотое сечение, белый бейдж размера, кнопки Full/Center/Maximize, мост `node.onMouseMove`. Тесты (Python, smoke, audit) и локализации обновлены под новую схему. `python _process/check.py Degg_Crop` — **ЗЕЛЁНОЕ: провалов 0**. Синхронизирован в рабочую ComfyUI, закоммичен и запушен.

## 2. Итоговое состояние кода
- `degg_crop.py:220` — `INPUT_TYPES` (14 входов: `file` required с `image_upload`, `x/y/width/height` INT, опциональные `multiplicity(8)/resolution_mp/upscale_method/fill_color/dim_percent/aspect_ratio/ratio_lock/image/mask`)
- `degg_crop.py:340` — `process`: приоритет провода `image`, защита от Tensor в `file`, `_compose` (холст + сдвиг `-x,-y`), `target_size` (MP + банковское округление), `_interpolate` (lanczos через PIL), маска тем же окном
- `degg_crop.py:80` — `_compose` / `paste_region` / `target_size` / `fill_values` / ленивые импорты numpy/PIL в `_resize_lanczos`
- `web/js/degg_crop.js:10` — ESM-совместимый загрузчик `app` (через `window.comfyAPI`)
- `web/js/degg_crop.js:150` — `onNodeCreated`: создаёт виджет `preview` (type=custom, serialize=false, computeLayoutSize/draw/mouse), кнопки `fit_full/fit_center/fit_max`, `node.onMouseMove` мост
- `web/js/degg_crop.js:250` — `makePreviewWidget`: `draw` (сетка третьих+золотое сечение, рамка, бейдж через `text.length`), `mouse` (9-зона hit-test, drag/resize, ratio lock)
- `web/js/degg_crop.js:340` — экспорт `window.DeggCropPreview` для тестов
- `tests/_test_degg_crop.py` — Python E2E (автоперезапуск под ComfyUI python), `multiplicity=1` для точных геометрических проверок
- `tests/_smoke_degg_crop.mjs` — JS-смоук vm: проверяет расширение, виджет preview, математику targetSizeJS, getHitArea 9 зон, draw()
- `tests/_audit_degg_crop.mjs` — статический аудит: 14 входов, Nodes 2.0 hooks, без запрещённых приёмов, locales ru/en 14 входов
- `locales/ru/nodeDefs.json` / `locales/en/nodeDefs.json` — 14 входов, 4 выхода

## 3. Проблемы, которые встречались (и как решали)
- **Tensor в `file` позиционно** → `AttributeError: 'Tensor' object has no attribute 'endswith'` в `folder_paths.get_annotated_filepath`. Решено: в `process`/`VALIDATE_INPUTS`/`IS_CHANGED` проверка `torch.is_tensor(file)` — пропуск файловых проверок, приоритет провода `image`.
- **JS `import` в vm-смоуке** → `SyntaxError: Cannot use import statement outside a module`. Решено: убрать `import`, читать `app` через `window.comfyAPI.app.app` или `window.app`.
- **`window.DeggCropPreview` не экспортировался в vm** → внутри `beforeRegisterNodeDef` не выполняется до вызова. Решено: добавить top-level экспорт после регистрации.
- **Старые тесты ждали `Ratio Presets` / `Load Image` / `computeSize` / `operation`** → переписаны под новую схему (нет старых виджетов, есть `computeLayoutSize`, `fit_*` кнопки).
- **Аудит банил ленивые импорты numpy/PIL** → проверка привязана к колонке 0 (`/^import numpy/m`), импорты внутри функции с отступом — ок.
- **`check.json` ожидает `FAIL: 0` а тест печатал `FAIL=0`** → исправлен формат вывода в тесте.

## 4. Что важно не сломать при продолжении работы
- `check.json` **не менять** — строки `expect` обязаны появляться в выводе.
- `sync.py` не копирует `tests/` — тесты только в исходнике.
- Python `round()` (банковское) — JS `pyRound` обязан совпадать один в один.
- `computeLayoutSize` — основной для Nodes 2.0 stretch; `computeSize` — fallback, не перезаписывать `this.computeSize` на ноде.
- `serialize: false` и в виджете, и в `options` (двойная страховка).
- `node.onMouseMove` — единственный способ получить hover/drag/resize (виджет `mouse` вызывается только на mousedown).
- В live-замере (`_probe_live_dom.py`) мерить в кадре ноды (`widget.last_y`), не в offscreen.

## 5. Следующие шаги (идеи, не сделано)
- Живой замер в headless Chrome: `python tests/_probe_live_dom.py` (нужен запущенный ComfyUI) — подтвердить drag/resize/пресеты/кнопки/бейдж/reopen.
- Ручное тестирование в браузере (Nodes 2.0): загрузка, drag/resize 9 зон, Expand за границы, MP+кратность, маска/альфа.
- Вынос пирсинга в отдельную ноду `KonstCharacterPiercing` (если понадобится).

## 6. Связанные файлы
- `degg_crop.py` — Python нода
- `web/js/degg_crop.js` — JS UI
- `locales/ru/nodeDefs.json`, `locales/en/nodeDefs.json` — переводы
- `tests/_test_degg_crop.py`, `tests/_smoke_degg_crop.mjs`, `tests/_audit_degg_crop.mjs` — тесты
- `check.json` — конфиг проверок (не менять)
- `SPECIFICATION.md` — полная документация (обновлена)
- `TASK.md` — ТЗ
- `AGENTS.md` (корень проекта) — правила