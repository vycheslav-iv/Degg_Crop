# Память сессии — Degg_Crop (2026-10-02)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` (корень бандла) и этим файлом.

---

## 1. Что делали в этой сессии (кратко)
- Прошлые сессии: переписан Python (352 строки, 4 выхода, 18 входов) — тест зелёный; спроектирован полный перенос OREX в JS, но **код JS не написан**.
- Эта сессия: пользователь остановил разработку (серверы глючили) и заказал документы для передачи другой модели. Созданы `TASK.md` (ТЗ) и `SPECIFICATION.md` (полная спецификация). Код не менялся.
- Рабочая копия ComfyUI **устарела**: sync.py ни разу не запускался после переписки python (в ней python 139 строк / 1 выход).

## 2. Итоговое состояние кода
- `degg_crop.py:221` — `INPUT_TYPES`: 18 входов (image, operation, x, y, width, height, fill_color, image_in, crop_left/right/top/bottom, multiplicity, resolution_mp, upscale_method, aspect_ratio, ratio_lock, mask)
- `degg_crop.py:261-265` — `RETURN_TYPES=("IMAGE","MASK","INT","INT")`, `RETURN_NAMES=("image","mask","width","height")`, `FUNCTION="process"`, `OUTPUT_NODE=True`
- `degg_crop.py:167-179` — `_resize_lanczos`: ленивые `import numpy`/`from PIL` с отступом (иначе аудит падает)
- `degg_crop.py:92-145` — `percent_rect` (OREX-семантика, приоритет над окном), `target_size` (резайз только при crop_% или MP; python `round()` — банковский)
- `web/js/degg_crop.js` (355) — **СТАРЫЙ**: только превью + invalidate; фич OREX нет (пресеты, кнопки, мышь, синки)
- `tests/_audit_degg_crop.mjs` — **RED: 68 ok / 5 FAIL**: RETURN_TYPES, RETURN_NAMES, numpy-бан, PIL-бан, «ровно 8 входов»
- `tests/_smoke_degg_crop.mjs` (276) — зелёный, но покрывает только старый JS
- `locales/{ru,en}/nodeDefs.json` — устарели: 8 входов, только выход `"0"`

## 3. Проблемы, которые встречались (и как решали)
- Аудит-бены `!/^\s*(import numpy)/m` глотали ленивые импорты с отступом → фикс: привязка к колонке 0 `/^(import numpy|from numpy)/m` (и PIL аналогично).
- Рабочая папка ≠ исходник → всегда: правки в `F:\...\Degg_Crop\`, затем `python sync.py Degg_Crop`.

## 4. Что важно не сломать при продолжении работы
- Audit запрещает: `setInterval`, `MutationObserver`, `.computeSize =`, `this.size =`/`node.size =` (только `setSize`), `widgets_up`. Писать `serialize: false` в ОБА места (options и сам виджет).
- Python-контракт не трогать: percent приоритетно; Expand-холст = width×height; ресайз только при crop_% или MP; выход размеров = int-обрезка.
- JS: первый `fillRect` в drawPreview — фон `#161616` на `y=68` (смоук это проверяет); `strokeRect` обязателен (смоук); БЕЗ `measureText` (в смоук-заглушке ctx его нет) — размер бейджа = `text.length`.
- Синхронизация: `syncCropDisplays` пишет width/height ТОЛЬКО в Crop+pct; Expand никогда не трогает width/height от rect.
- `check.json` не менять (expect: `["FAIL: 0","ТЕСТ ПРОЙДЕН"]`, `["SMOKE OK"]`, `["аудит чист"]`).
- Тесты запускать из папки проекта; пути в тестах — от `__file__`/`import.meta.url`.

## 5. Следующие шаги — ПЕРЕДАНО ДРУГОЙ МОДЕЛИ (см. TASK.md + SPECIFICATION.md)
- Порядок работ, фиксы 5 FAIL аудита, контрольные значения смоука, приёмка — всё в `TASK.md`.
- Полный дизайн (формулы, синки, мышь, ловушки) — в `SPECIFICATION.md`.
- Новой модели показать: `TASK.md` + `SPECIFICATION.md` + этот файл + `AGENTS.md` корня.

## 6. Связанные файлы
- Исходник: `F:\AI_projects\Custom_node_ComfyUI\Degg_Crop\`
- Рабочая копия: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\Degg_Crop\`
- Референс: `D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-orex\js\OreX_Crop.js`
- Проверка: `F:\AI_projects\Custom_node_ComfyUI\_process\check.py`, синхронизация: `sync.py`
- Питон-тесты: `Degg_Crop/tests/_test_degg_crop.py` (зелёный)
