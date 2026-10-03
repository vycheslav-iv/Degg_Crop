# Память сессии — Degg_Crop (2026-10-03)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)
**Найден и устранён критический баг «рамка кропа не появляется в UI»** и
**реализован аутпеинт** (рамку можно тянуть за пределы изображения + точные
пиксельные поля, как в «Pad Image for Outpainting»). Всё проверено в реальном
браузере (headless Chrome + CDP): `ok: 32 FAIL: 0`.

### Три реальные причины бага (доказаны по исходникам фронтенда)
1. **Фронтенд не читает `options.draw` / `options.mouse` / `options.computeSize`.**
   Он вызывает `widget.draw(ctx, node, width, y, H, lowQuality)` и
   `widget.mouse(e, pos, node)` — **на самом виджете**. Старый код прятал всё в
   `options` → ничего не рисовалось и не кликалось.
   (`LGraphNode.drawWidgets` ~4185, `LGraphCanvas.processWidgetClick` ~3100.)
2. **`window.comfyAPI.api` — это namespace модуля** (`{api, ComfyApi, …}`), клиент
   лежит в **`window.comfyAPI.api.api`**. Старый код брал `comfyAPI.api.apiURL`
   (undefined) → URL картинки не строился → «No image».
3. **Рамка была зажата внутри изображения** (кламп в drag) → аутпеинт невозможен.
4. Дополнительно: хука **`onInputsChanged` во фронтенде НЕ существует** — на него
   нельзя опираться (именно поэтому он «не срабатывал»).

## 2. Итоговое состояние кода
- `web/js/degg_crop.js` — **переписан**:
  - виджет `degg_crop_preview`: `draw`/`mouse`/`computeSize` **на верхнем уровне**,
    `serialize:false`, `options.canvasOnly:true`;
  - `computeSize(width) → [width, 160]` (фиксированная высота, без feedback loop);
  - `draw(ctx, node, width, y)`: `ctx.translate(0, y)`, запоминает `node._previewY`
    и `node._layout`; лениво грузит источник (`ensureImage`, самолечение без таймеров);
  - `computeLayout` вписывает **объединение изображения и окна** → рамка,
    выдвинутая за картинку, всегда видна;
  - `applyDrag` — **БЕЗ клампа** для `move` (аутпеинт), ratio lock только при resize;
  - цвет рамки: зелёный (Crop) → голубой (Expand); бейдж целевого размера;
  - `resolveImageUrl` — через `graph.links` (Map-Proxy, `.get`), LoadImage / file / imgs;
  - `pythonTarget`, `pyRound` (банковское), `roundMult` — 1:1 с python.
- `tests/_smoke_degg_crop.mjs` — переписан (контракт виджета, аутпеинт-drag, пресеты, URL).
- `tests/_audit_degg_crop.mjs` — проверяет top-level draw/mouse/computeSize,
  отсутствие `onInputsChanged`, отсутствие клампа.
- `tests/_probe_live_dom.py` — **переписан**: живой CDP-замер (32 проверки, FAIL 0).
- `degg_crop.py` — **не менялся** (контракт тот же; Python-тест зелёный).
- `locales/ru+en/nodeDefs.json` — не менялись (14 входов, 4 выхода).

## 3. Что важно не сломать
- **`options.*` не работает для draw/mouse/computeSize** — только верхний уровень.
- `api` — **только** `window.comfyAPI.api.api` (namespace → клиент).
- `onInputsChanged` не существует — не использовать.
- `check.json` **не менять** — строки `expect` обязаны появляться в выводе.
- `sync.py` не копирует `tests/` — тесты только в исходнике.
- Python `round()` (банковское) — JS `pyRound` обязан совпадать один в один.
- `serialize:false` и в виджете, и в `options` (двойная страховка).
- `node.onMouseMove` — единственный способ hover/продолжения drag.
- `megapixels` применяется только при реальном источнике.

## 4. Проверки (все зелёные)
```bash
python _process/check.py Degg_Crop        # ЗЕЛЁНОЕ: провалов 0
cd Degg_Crop
python tests/_test_degg_crop.py           # ТЕСТ ПРОЙДЕН
node tests/_smoke_degg_crop.mjs           # SMOKE OK
node tests/_audit_degg_crop.mjs           # аудит чист
"D:/ComfyUI_windows_portable/python_embeded/python.exe" tests/_probe_live_dom.py
                                          # живой замер чист (32 ok, FAIL 0)
```

## 5. Как пользоваться (для человека)
- **Crop:** рамка внутри картинки → зелёная.
- **Outpaint:** тяни рамку за край картинки (голубая) ИЛИ задай точно полями:
  `x=-64, y=-32, width=768, height=544` (отрицательные x/y + увеличенные w/h).
  Заливка вне изображения — цвет `fill_color`.
- Кнопки: `Full image` / `Center` / `Maximize`; комбо `ratio_preset`.
- `megapixels > 0` → целевой размер по площади; `multiplicity` — кратность.

## 6. Связанные файлы
- `degg_crop.py` — Python (зелёный, не менялся)
- `web/js/degg_crop.js` — JS (переписан, зелёный)
- `tests/_test_degg_crop.py`, `_smoke_degg_crop.mjs`, `_audit_degg_crop.mjs`,
  `_probe_live_dom.py`
- `check.json` — не менять
- `SPECIFICATION.md` — полная документация (обновлена)
- `TASK.md` — ТЗ
- `AGENTS.md` (корень проекта) — правила
