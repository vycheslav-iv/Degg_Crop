# Память сессии — Degg_Crop (2026-10-03)

> Покажи этот файл агенту, чтобы продолжить работу.
> Всегда сверяйся с `AGENTS.md` и `SPECIFICATION.md`.

---

## 1. Что делали в этой сессии (кратко)
- **Критический баг «рамка кропа не появляется в UI» найден и устранён**;
  **аутпеинт реализован** (рамка тянется за границы изображения + точные
  пиксельные поля, как «Pad Image for Outpainting»). Всё проверено в живом
  браузере (CDP/headless Chrome): `ok: 32 FAIL: 0`.
- **По находкам созданы 2 скила + дополнен 1** (корень бандла, зеркала
  `.kilo/`, `.opencode/`, таблица §3 в `AGENTS.md`):
  `comfyui-custom-widget-contract` (top-level контракт виджета),
  `comfyui-frontend-namespaces` (NS-ловушки, нет хука onInputsChanged),
  `comfyui-negative-result-audit` (дополнен чек-листом §2).
- Спецификация вычищена от устаревшего (debug-логи, onInputsChanged,
  «шаги для новой модели»), закоммичено и запушено.

### Четыре реальные причины бага (доказано по sourcesContent .map)
1. Фронтенд вызывает `widget.draw(ctx,node,width,y,H,lq)` / `widget.mouse(e,pos,node)`
   **на самом виджете** — `options.draw`/`options.mouse`/`options.computeSize`
   **не читаются вообще** (`LGraphNode.drawWidgets` ~4185).
2. `window.comfyAPI.api` — namespace → клиент в **`comfyAPI.api.api`**
   (`apiURL` тоже через него).
3. Кламп в `applyDrag` зажимал рамку внутри картинки → аутпеинт был невозможен.
4. Хука **`onInputsChanged` во фронтенде НЕ существует** (grep по всем .map).

## 2. Итоговое состояние кода
- `web/js/degg_crop.js` (~900 строк) — переписан:
  - `degg_crop_preview`: top-level `draw`/`mouse`/`computeSize`,
    `serialize:false`, `options.canvasOnly:true`, высота 160 (фикс.);
  - `draw`: `ctx.translate(0,y)` → `node._previewY`/`node._layout`;
    ленивая загрузка `ensureImage` (без таймеров);
  - `computeLayout` вписывает **объединение** картинки+окна (рамка за краем видна);
  - `applyDrag` **без клампа** для move; зелёная/golubaya (Expand) рамка, бейдж размера;
  - `pickApi()` → `comfyAPI.api.api`; `resolveImageUrl` через `graph.links.get` (Map);
  - `pythonTarget`/`pyRound`/`roundMult` — 1:1 с python;
  - Ratio Presets + Full/Center/Max; патчи прототипа, `window.DeggCropPreview`.
- Тесты зелёные: `_test_degg_crop.py`, `_smoke_degg_crop.mjs`,
  `_audit_degg_crop.mjs` (проверяет top-level, отсутствие onInputsChanged/клампа),
  `_probe_live_dom.py` (живой CDP, 32 ok).
- `degg_crop.py` — **не менялся** (14 входов, выходы IMAGE/MASK/INT/INT).
- Git: **закоммичено и запушено** (`a2b700c`, origin/master), предохранитель
  прогнал `check.py` — ЗЕЛЁНОЕ.

## 3. Что важно не сломать
- `draw`/`mouse`/`computeSize` — **только top-level** (options фронтенд не читает).
- `api` — только `window.comfyAPI.api.api`; хук `onInputsChanged` не использовать
  (источник лениво в `draw()`).
- Кламп move **не возвращать** — иначе сломается аутпеинт.
- `check.json` не менять; `sync.py` не копирует `tests/`; Python `round()` ↔ `pyRound`.
- `serialize:false` — и свойством, и в options; hover/продолжение drag — через `node.onMouseMove`.

## 4. Проверки (все зелёные, последняя — 2026-10-03)
```bash
python _process/check.py Degg_Crop        # ЗЕЛЁНОЕ: провалов 0
cd Degg_Crop
python tests/_test_degg_crop.py           # ТЕСТ ПРОЙДЕН
node tests/_smoke_degg_crop.mjs           # SMOKE OK
node tests/_audit_degg_crop.mjs           # аудит чист
"D:/ComfyUI_windows_portable/python_embeded/python.exe" tests/_probe_live_dom.py
                                          # ok: 32 FAIL: 0 (ComfyUI+Chrome)
```

## 5. Следующие шаги (идеи, не сделано)
- Прогнать живую пробу повторно после любых JS-изменений (ComfyUI сейчас выключен).
- Возможные фичи: undo жеста, превью fill_color в рамке, snap к краям.

## 6. Связанные файлы
- `Degg_Crop/web/js/degg_crop.js`, `degg_crop.py`, `tests/*`, `check.json` (не менять)
- `Degg_Crop/SPECIFICATION.md` — обновлена (контракт виджета §4.4, аутпеинт §4.4.1)
- Скилы (корень бандла): `.agents/skills/comfyui-custom-widget-contract`,
  `.agents/skills/comfyui-frontend-namespaces`, `comfyui-negative-result-audit`
