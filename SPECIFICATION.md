# SPECIFICATION.md — Degg_Crop

> Полная спецификация ноды: контракт Python, архитектура JS, все формулы,
> правила синхронизации, тесты, ловушки. Читать вместе с `TASK.md`
> (что делать) и `SESSION_MEMORY.md` (состояние).
>
> **Статус (2026-10-02): РЕАЛИЗОВАНО И ПРОВЕРЕНО.** §2–§11 описывают
> реализацию как она есть; §12 — фактические результаты прогонов,
> §13 — ловушки, §14 — приёмка.

---

## 1. Назначение

**Degg_Crop** — нода обрезки (Crop) и расширения холста (Expand) для `IMAGE`
в ComfyUI. Интерактивная механика (рамка мышкой, пресеты пропорций, кнопки)
портируется из референса **OreX_Crop**
(`D:\ComfyUI_windows_portable\ComfyUI\custom_nodes\comfyui-orex\js\OreX_Crop.js`,
953 строки; python-референс `OreX_Crop.py`, 177 строк).

- Маппинг: ключ `DeggCrop`, отображаемое имя `Degg Crop`,
  `CATEGORY = "My_custom_nodes/Image"`, `WEB_DIRECTORY = "web"`.
- `OUTPUT_NODE = True` (персистентность через `extra_pnginfo`).

## 2. Файлы проекта

| Файл | Строк | Роль |
|---|---|---|
| `degg_crop.py` | 352 | Нода: INPUT_TYPES (18), pipeline, выходы. ГОТОВ |
| `__init__.py` | 5 | Маппинги + `WEB_DIRECTORY = "web"` |
| `web/js/degg_crop.js` | 1304 | Фронтенд: превью, раскладка, математика, синки, мышь, пресеты, кнопки, бейдж. ГОТОВ |
| `tests/_test_degg_crop.py` | — | Python-тест (зелёный). Не трогать |
| `tests/_smoke_degg_crop.mjs` | 531 | JS-смоук в vm-заглушках. ГОТОВ: `ok: 100 / FAIL: 0` |
| `tests/_audit_degg_crop.mjs` | 220 | Статический аудит. ГОТОВ: `ok: 83 / FAIL: 0` |
| `tests/_probe_live_dom.py` | 734 | Живой замер в headless-Chrome (CDP). ГОТОВ: `ok: 43 / FAIL: 0` |
| `locales/ru+en/nodeDefs.json` | 27 | Переводы: 18 входов, выходы `0–3` |
| `check.json` | 22 | 3 проверки + expect-строки. НЕ МЕНЯТЬ |

Живой замер (`_probe_live_dom.py`) в `check.json` НЕ входит (нужен запущенный
ComfyUI и Chrome) — запускается отдельно, сервер после него выключается.

## 3. Python-контракт (готов, не менять без нужды)

### 3.1. Входы (18)

Required: `image` (IMAGE), `operation` (["Crop","Expand"], default "Crop"),
`x`, `y` (INT, −4096…8192), `width`, `height` (INT 1…8192, default 512),
`fill_color` (FILL_COLORS, default "black").

Optional: `image_in` (IMAGE — приоритет над `image`, если подключён),
`crop_left/right/top/bottom` (FLOAT % 0…100),
`multiplicity` (INT, default 16), `resolution_mp` (FLOAT MP, 0 = выкл),
`upscale_method` (default "bicubic"), `aspect_ratio` (STRING, default "Custom" —
python его НЕ применяет, только JS), `ratio_lock` (BOOLEAN), `mask` (MASK).

`FILL_COLORS = ["transparent","black","white","red","green","blue","gray"]`.

### 3.2. Pipeline `process` (`degg_crop.py:281`)

1. **Выделение** (`selection_rect`, стр. 111): любая `crop_* > 0` → `percent_rect`
   (как OREX); иначе окно `(x, y, width, height)` — может выходить за источник.
2. **Композитинг** (`_compose`, стр. 182): Crop — содержимое в (0,0) холста размера
   выделения, вне источника — заливка; Expand — холст `width×height`, содержимое
   в точке `(x, y)`; Expand+pct — кладётся только вырезанный кусок.
   Сдвиг: `offset_for` (стр. 80): Expand → `(x, y)`, Crop → `(-x, -y)`.
3. **Ресайз** — только если `need_resize = percent_mode or resolution_mp > 0`
   (`target_size`, стр. 125): `MP > 0` → площадь с пропорциями холста,
   иначе `width/height`; округление до `multiplicity`; метод `upscale_method`
   (lanczos — через PIL, см. 3.4). Без `crop_%` и MP размеры не меняются.
4. **Маска**: то же выделение и ресайз; без входа — единицы.

Выход: `(image, mask, width_int, height_int)`.

### 3.3. `percent_rect` (`degg_crop.py:92`) — эталон для JS

```python
left = int(crop_left/100*img_w)          # int() = обрезка к нулю
right_px = int(crop_right/100*img_w)
top = int(crop_top/100*img_h)
bottom_px = int(crop_bottom/100*img_h)
left = max(0, min(img_w-1, left))
right = max(left+1, img_w - right_px)
top = max(0, min(img_h-1, top))
bottom = max(top+1, img_h - bottom_px)
return (left, top, min(right, img_w), min(bottom, img_h))
```

### 3.4. Ленивые импорты (`degg_crop.py:167–179`)

`import numpy as np` / `from PIL import Image` — **внутри** `_resize_lanczos`,
с отступом. Аудит-баны обязаны быть привязаны к колонке 0
(`/^(import numpy|from numpy)/m`), иначе дают ложный FAIL.

### 3.5. Банковское округление

Python `round()` — банковское (к чётному): `round(22.5)=22`, `round(23.5)=24`.
JS-обёртка обязана повторять его один в один (см. `pyRound` в §5).

## 4. JS-архитектура (что писать в `degg_crop.js`)

### 4.1. Сохранить из текущего файла без изменений логики

Строки 1–14: api-bootstrap (`const { app } = window.comfyAPI?.app`, namespace
с фолбэком на `.api` — проверено по бандлу фронтенда, иначе все URL = null).
`getImageUrl` (поиск: свой output → upstream LoadImage по `image_in`/`image`
через `graph.links` как **Map** → `node.imgs`), `ensureImage`, `checkerPattern`,
`fillStyle`, `layoutCrop`, `layoutExpand` (точные формулы — их проверяет смоук),
`strokeRect`, `fitNode` (только `setSize`, читать из `computeSize()`),
`invalidate`, каркас `addPreviewWidget` + `registerExtension`
(`onNodeCreated/onWidgetChanged/onExecuted/onConfigure/onConnectionsChange`,
`loadedGraphNode`).

### 4.2. Состояние ноды (поля)

`_deggImg`/`_deggUrl` (кэш картинки), `_deggLayout` (раскладка последнего draw —
нужна hit-testing), `previewArea` (`{x,y,width,height,scale}` — Crop: бокс
источника, Expand: бокс холста), `_deggDrag` (активный drag), `_isSyncing`
(реентерабельность синков).

### 4.3. Порядок виджетов

Python создаёт: `operation, x, y, width, height, fill_color, crop_left,
crop_right, crop_top, crop_bottom, multiplicity, resolution_mp, upscale_method,
aspect_ratio, ratio_lock` (+ сокеты `image`, `image_in`, `mask`).
`setupJsWidgets` вызывается в `onNodeCreated` **до** `addPreviewWidget`
(превью — всегда последний): вставка `Ratio Presets` сразу после `aspect_ratio`
(`splice(arIdx+1, 0, pw)`), затем кнопки `Full Image`, `Center`, `Maximize`,
`Load Image`. Всё с `serialize: false` **в обоих местах** (опции и сам виджет),
всё идемпотентно (проверка `has(name)` — смоук вызывает `onNodeCreated` дважды).

`PRESETS = ["Custom","Free (Source)","1:1","4:3","3:4","16:9","9:16","9:20","2:3","3:2","21:9"]`
(default `"Custom"`; `"Free (Source)"` = полный кадр).

## 5. Математика JS (точные формулы)

```js
parseRatio(r)          // OREX дословно: "/"→":", "a:b"→a/b, число→число, "Custom"→1
ratioFrom(ar, selRatio)// ar пусто/"Custom" → selRatio||1, иначе parseRatio(ar)
pyRound(v)             // банковское: f=floor(v), d=v-f; d>0.5→f+1; d<0.5→f; d==0.5→(f%2==0?f:f+1)
roundMult(v, m=16)     // Math.max(m, pyRound(v/m)*m)   // контрпример: roundMult(1000,16)=992
mpTargets(ratio,mult,mp)// area=mp*1e6; tw=√(area·ratio); th=√(area/ratio); roundMult обоих
percentRectFromMargins(srcW,srcH,l,r,t,b) // §3.3, int→Math.trunc, clamp, min-размер 1px
```

`pythonTarget(node)` — **точный выход python** (рисуется в бейдже):
`need = isPercent || mp>0`; если `!need` → `[max(1,width), max(1,height)]`;
если `mp>0` → `mpTargets(canvasW/canvasH, mult, mp)`, где canvas = rect (Crop)
или width×height (Expand); иначе → `[roundMult(width), roundMult(height)]`
(python берёт виджеты как tw/th — JS их уже синхронизировал).
Контроль: канвас 640×480 + `mp=2` → `[1632, 1232]`; `mult` из `multiplicity`.

## 6. Режимы и `getSel(node)` (нужен готовый `_deggImg`)

| operation | crop_% | sel (координаты источника) |
|---|---|---|
| Expand | все 0 | `{x:0, y:0, w:srcW, h:srcH}` (x/y виджетов — это позиция вставки, не кроп) |
| Expand | любая > 0 | `percentRectFromMargins(...)` |
| Crop | любая > 0 | `percentRectFromMargins(...)` |
| Crop | все 0 | окно `{x:trunc(x), y:trunc(y), w:max(1,trunc(width)), h:max(1,trunc(height))}` — **без клампа**, может быть вне источника |

`isPercent(node)` = любая `crop_* > 0`. `opOf(node)` = строка `operation`.

## 7. Раскладка `computeLayout(box, node)` → `_deggLayout`

- Crop: `layoutCrop(box, src, rect)` → `{scale, img, win}`; запись
  `{mode:"crop", percent, scale, srcW, srcH, box, img, out:null, win, content:win, sel:rect}`;
  `previewArea` = бокс `img`.
- Expand: `px=trunc(x)`, `py=trunc(y)`; `selW/selH` = pct ? rect : src;
  `off = pct ? (px−rect.x, py−rect.y) : (px, py)`;
  `L0 = layoutExpand(box, src, off, outW, outH)` → `{scale, out, img}`;
  `content = {out + (px,py)·scale, selW·scale, selH·scale}`;
  `previewArea` = бокс `out`. Источник рисуется со сдвигом `off` и **клипом
  по out** — это повторяет python-paste (§3.2 п.2).

## 8. Синхронизация виджетов

### 8.1. Примитивы

`setW(node,name,value)` (прямая запись; программное `w.value=` **не стреляет**
событиями — на этом держится drag). `writeMargins(node,srcW,srcH,rect)` —
4 поля с округлением `Math.round(v*100)/100` (паритет OREX).
`syncPresets` = `presets.value = values.includes(ar.value) ? ar.value : "Custom"`.
`syncAspectDisplay(node,rect)` — блок aspect из OREX `syncWidgetsFromProperties`
дословно (matchedPreset с допуском 0.01 → ar+presets; иначе `W:H` + Custom;
при lock — только presets), плюс пропуск `"Free (Source)"` при матчинге.
**`syncCropDisplays(node,rect)` — пишет width/height ТОЛЬКО в Crop+pct**
(цель = `mp>0 ? mpTargets(rect) : roundMult(rect)`); во всех остальных режимах —
no-op. Зеркальный инвариант: Crop правит x/y из rect; Expand НИКОГДА не правит
x/y из source-rect и не трогает width/height от rect.

### 8.2. `postRectSync(node)`

`rect=getSel`; если `withAspect` и не (Expand+window) → `syncAspectDisplay(rect)`;
`syncCropDisplays(rect)`; `syncPresets`; перерисовка.

### 8.3. `applyAspectRatio(node, val)`

Флаг `_isSyncing` (try/finally); без картинки — выход. `"Full"` →
`ar="srcW:srcH"`, rect = весь источник. Иначе `ar=val` (если задан),
`ratio=ratioFrom(ar, selRatio)`, contain-fit
(`srcW/srcH > ratio → nh=srcH, nw=nh·ratio; иначе nw=srcW, nh=nw/ratio`),
центр = (pct||Crop) ? центр sel : центр источника; кламп `0…src−n`; округление
как в OREX. Коммит: Crop-pct → `writeMargins` + mirror x,y; Crop-window →
setW x,y,width,height; Expand → только `writeMargins` (позиция не трогается;
Full на Expand даёт нулевые поля → остаётся window).
Пост-синк по **свежему** состоянию: Crop → pct ? `syncCropDisplays` :
`syncAspectDisplay`; Expand → pct ? `syncAspectDisplay` : только `syncPresets`
(не затирать `ar=srcW:srcH` после Full).

`fullImage` = `applyAspectRatio("Full")`. `Maximize` = `applyAspectRatio()`
(Custom → собственный ratio sel через `ratioFrom`).
`centerSelection`: Crop → `round((src−rect)/2)` без клампа (окно может уйти
в минус, минимум виджета −4096); pct → +`writeMargins`+mirror; Expand →
`x=round((width−contentW)/2)`; затем `postRectSync`.

### 8.4. `handleWidgetChanged(node, name, val, old)` (входной guard `_isSyncing`)

- `crop_*`: `before` = rect со старым значением поля, `after` = rect с новым;
  при lock — перпендикулярная подстройка (`left/right` → `h=after.w/rat`,
  top-фикс; `top/bottom` → `w=after.h*rat`, left-фикс, `rat=ratioFrom(ar,
  after-ratio)`) + `writeMargins`; Crop → setW x,y + оба синка;
  Expand → сдвиг x,y на Δ(after−before) (без прыжков) + `syncAspectDisplay`.
- `width/height`: при lock вывести парную сторону из `ratioFrom(ar, sel-ratio)`;
  `roundMult` **обоих** безусловно; setW w/h + `ar="valW:valH"` +
  `syncPresets`; rect не трогать; `syncAspectDisplay` после присвоения ar
  НЕ вызывать (затрёт ar пропорцией rect в Crop-pct).
- `ratio_lock` ON → `ar = "selW:selH"`, presets Custom.
- `aspect_ratio` → `syncPresets` + `applyAspectRatio(val)`.
- `x/y` → только Crop-window: `syncAspectDisplay(getSel)`; остальное — redraw.
- `operation/fill_color/upscale_method` → redraw.
- `resolution_mp/multiplicity` → `syncCropDisplays`, только если Crop+pct.

## 9. Мышь

Диспетчер — `mouse(e, pos, node)` виджета-превью, `pos` в координатах ноды
(проверено по фронтенду): mousedown/pointerdown → `previewMouseDown`,
mousemove → `previewMouseMove`, mouseup → `previewMouseUp`.

`getHitArea(node, p)`: вне `previewArea` → null; **Expand+window → только
`"move"`**; иначе rect = content (Expand-pct) или win (Crop), координаты =
`(p−origin)/scale`, порог `15/scale`; порядок: углы (tl/tr/bl/br) → рёбра
(t/b при inX, l/r при inY) → `"move"` при inX&&inY. Курсор по карте
move/nwse/nesw/ns/ew через `app.canvas.canvas.style` с guard (в смоуке canvas нет).

`resizeSel(sel0, hit, dx, dy, srcW, srcH, lock, rat, clamp)`:
move-ветка первая — кламп `[min(0,W−w), max(0,W−w)]` (держит и `w>srcW`);
рёбра `l/r/t/b`; lock-якоря дословно из OREX (противоположный край, edge →
`nh=nw/rat` / `nw=nh·rat`, corner → большее; граничные фолбэки при clamp);
кламп границ при clamp; min-16 (`l`→`x1=x2−16` иначе `x2=x1+16`, так же y);
в конце округление углов (round(x) и round(x+16) отличаются ровно на 16).
`rat = lock ? ratioFrom(ar, sel0-ratio) : 1`.

Drag: в mousedown захватить `{hit, startPos, sel0, x0, y0, scale, mode:{op,percent},
lock, rat}`; **на move — только сырые записи** (`_isSyncing` не держать);
`e.buttons===0` на move → финиш через mouseup; без drag — hover-курсор.
Коммит rect по режимам: Crop-window → setW x,y,width,height;
Crop-pct → `writeMargins` + mirror x,y;
Expand-pct хэндлы → `writeMargins` + `x=round(x0+(r.x−sel0.x))`
(захваченный край следует за курсором, правый край контента фиксирован);
Expand-pct move (**Option A**) → поля НЕ трогать,
`x=round(x0+dx)`, `y=round(y0+dy)` без клампа.
На mouseup — `postRectSync` (§8.2).

Контрольный пример (смоук): бокс `{8,68,284,184}`, scale=184/480,
`win={27.33,68,196.27,196.27}`; mousedown `[125,166]` → `"move"`;
mousemove `[145,166]` (buttons=1) → dx=52.17 → кламп → `x=52` ✓.

## 10. Рисование `drawPreview`

Первый `fillRect` — фон `#161616` на `box.y=68` (при `y=60`: `y0+MARGIN`);
клип по box. Нет картинки → заглушка `fillText`. `_deggLayout=null` без картинки.

- Crop: залить win fill-цветом → `drawImage` всего источника → затемнение вне win
  (`rect(box)+rect(win)`, `fill("evenodd")`) → `strokeRect(img)` + `strokeRect(win)`
  внутри клипа → restore → внешний `strokeRect(win)`.
- Expand: залить out → клип по out → `drawImage` со сдвигом §7 → `strokeRect(content)`
  внутри клипа → бейдж + %-метки (только pct) + крестик → restore → `strokeRect(out)`.
- Крестик: центр content, плечи 10px, `rgba(170,255,0,0.5)`.
- Бейдж: текст `` `${tgt.w} × ${tgt.h} px` `` (`pythonTarget`, §5), bold 14px Arial
  + тень; подложка `fillRect(cx−len*4−4, y, len*8+8, 16)` — **размер из
  `text.length`, `measureText` запрещён** (в смоук-заглушке ctx его нет).
- %-метки (OREX): вокруг content/win — `x/srcW`, `(src−x−w)/srcW`, `y/srcH`,
  `(src−y−h)/srcH`.

## 11. Кнопки и загрузка

Presets-callback: `"Custom"` → ничего; `"Free (Source)"` → `fullImage`;
иначе `ar.value=val` (guarded) + `applyAspectRatio(val)`.
Кнопки: Full Image → `fullImage`, Center → `centerSelection`,
Maximize → `applyAspectRatio()`, Load Image → `pickAndLoad`.

`pickAndLoad`: guards (нет `document` → warn+return; нет `window.LiteGraph` →
error+return; нет `api.fetchApi` → return) → `<input type=file>` →
`uploadAndAttach`: `FormData(image)` → `POST /upload/image` → `{name,subfolder}`.
Существующий upstream LoadImage искать по линку `image_in`, затем `image`
(проверка `/load/i` на comfyClass/type) → дописать значение в его combo
`options.values`, `callback` + `onWidgetChanged("image",…)` в try/catch,
коннект не трогать (**его собственный слот**). Нового LoadImage создать через
`LiteGraph.createNode`, позиция слева от ноды, **коннект в слот `image`**
(required-вход не должен остаться пустым).

## 12. Тесты

### 12.1. Смоук (`_smoke_degg_crop.mjs`, запуск `cd Degg_Crop && node tests/_smoke_degg_crop.mjs`)

vm-контекст: `Image`-заглушка (640×480, `complete` по `src`),
`window.comfyAPI.app = {app, registerExtension}`, `api = {apiURL}`.
Заглушки: `addWidget(type,name,value,cb,options)` (push+return) и
`addCustomWidget` на обе ноды, `setDirtyCanvas` + счётчик `dirty`; fakeCtx —
плюс `stroke`, `moveTo`, `lineTo`, БЕЗ `measureText` и без рабочего
`createPattern` (→ `null`). Виджеты главной ноды — полный python-порядок:
`operation, x, y, width, height, fill_color, crop_left..bottom, multiplicity,
resolution_mp, upscale_method, aspect_ratio, ratio_lock`.
Все старые ассерты сохранены. Проверяется (факт: 100 ok):

- `parseRatio("16:9")≈1.7778`, `parseRatio("Custom")==1`
- `percentRectFromMargins(640,480,10,10,10,10) = {x:64,y:48,w:512,h:384}`
- `roundMult(1000,16)===992`
- кнопки + пресеты присутствуют, дедуп при 2-м `onNodeCreated`,
  индекс presets = arIdx+1
- presets-callback `"16:9"` (окно 512×512@0,0) → `ar==="16:9"`,
  `width===640 height===360 x===0 y===76`
- `fullImage()` → 640/480
- `pythonTarget` после fullImage + `mp=2` → `[1632,1232]`
- drag §9 → `x===52`
- Expand-hit: точка у левого края content → null, центр previewArea → `"move"`
- `Load Image` callback без `document` — no-throw
- ветки `onWidgetChanged` (`crop_left=10` при lock ON) — no-throw, dirty++

- `Load Image` callback без `document` — no-throw (в смоуке document нет)
- ветки `onWidgetChanged` (`crop_left=10` при lock ON, `width` → кратность)
- контроль кадра: `previewArea.width/height` — числа (не undefined)
- `getHitArea` на далёкой точке → `null` (границы предпросмотра работают)
- reopen: `serialize:false` у превью, пресетов и всех 4 кнопок

Финал: `ok: 100   FAIL: 0` + `SMOKE OK`.

### 12.2. Аудит

Сохраняет проверки Node 2.0 (`window.comfyAPI`, не `scripts/app.js`),
`registerExtension`, все 6 перехватов, `loadedGraphNode`, `PREVIEW_H=200`,
`computeSize`, `serialize: false` и все запреты (§13).
Бены ленивых импортов привязаны к колонке 0 (`/^(import numpy|from numpy)/m`,
`/^(from PIL|import PIL)/m`) — иначе дают ложный FAIL на ``_resize_lanczos``.
Входов ровно 18, выходов 4, `OUTPUT_NODE = True`. JS-специфика:
`"Ratio Presets"`, `"Load Image"`, `window.DeggCropPreview`, `pythonTarget`,
`getHitArea`.
Финал: `ok: 83   FAIL: 0` + `аудит чист`.

### 12.3. Живой замер (`tests/_probe_live_dom.py`, нужен запущенный ComfyUI)

Headless Chrome + CDP (`websockets`): создаёт `DeggCrop` в реальном графе,
ждёт нативную загрузку источника, затем — 43 проверки:

- рендерер сам зовёт `draw()` (`widgetDrawCalls > 0`), рисование идёт от `y`
  (`pxAbove.a == 0`), регион залит, есть несколько цветов;
- `computeSize` резервирует `PREVIEW_H`, виджет не сериализуется;
- `layoutCrop`/`layoutExpand`/`fillStyle` совпадают с ожиданием в браузере;
- `getImageUrl` находит `LoadImage` через `graph.links`-`Map` (`LinkMap`);
- **мышь**: `getHitArea` центра окна → `move`, угла → `tl`, вне предпросмотра →
  `null`; `mousedown`/`mousemove`/`mouseup` двигают `x` ровно на `dx/scale`
  (с клампом), не трогая `y` и размер окна;
- **пресет 16:9** через живой callback комбо → пропорция 16:9, окно не выходит
  за источник; **кнопка `Full Image`** → окно = весь источник;
- `pythonTarget(mp=2)` сходится с независимым расчётом в самой странице;
- **бейдж**: смена MP меняет пиксели (`diff > 50`), а два одинаковых рендера
  дают `diff == 0` — валидация прибора (иначе «зелёное» слепо);
- Expand-window: hit-зона отдаёт `move`, drag двигает позицию вставки, холст
  не трогается; Crop+10%: `width/height` кратны `multiplicity`;
- reopen: 15 python-виджетов в `widgets_values`, 6 наших JS-виджетов — нет.

Кадр координат: зонд рисует с `(node.size[0], widget.last_y)` — ровно так, как
рисует рендерер. Рисовать в offscreen с другим `y` НЕЛЬЗЯ: `previewArea`
уедет в чужую систему координат и синтетические точки будут мимо (ловушка §13.10).

Финал: `ok: 43   FAIL: 0` + `живой замер чист`.

## 13. Ловушки (нарушишь — красный аудит или сломанная нода)

1. Запрещённые приёмы проверяются и в **комментариях кодовых строк**
   (фильтр режет только строки, начинающиеся с `//`): `setInterval`,
   `MutationObserver`, `.computeSize =`, `this.size =`, `widgets_up`,
   `getBoundingClientRect`/`offsetHeight`, `style.height =` — не писать нигде.
2. `node.size` нельзя присваивать — только `setSize` (аудит ловит `node.size =`).
3. fakeCtx смоука: нет `measureText`, `createPattern` → null — draw обязан работать
   на этом подмножестве + `stroke/moveTo/lineTo`.
4. Программное `w.value=` не стреляет событиями — drag и синки на этом построены;
   входной guard `_isSyncing` в `handleWidgetChanged`/`applyAspectRatio` обязателен.
5. `syncCropDisplays` вне Crop+pct затирает пользовательские width/height —
   держать scope из §8.1.
6. `pyRound` обязан совпадать с python `round()` (банковское), иначе ресайз
   в бейдже и на выходе разъедутся на ±mult.
7. `sync.py` не копирует `tests/` и legacy-тесты корня — тесты только в исходнике.
8. `check.json` не менять; строки `expect` обязаны появиться в выводе.
9. Живые проверки (`_probe_*`, браузер) в `check.py` не входят — отдельно;
   сервер после них **выключить**.
10. `previewArea` — только `{x, y, width, height, scale}`. Положить туда
    `layoutCrop`-бокс как есть (`{w,h}`) — и `getHitArea` начнёт сравнивать с
    `undefined`: границы дадут `NaN`, сравнения молча станут `false`, и клик
    вне предпросмотра перестанет отсекаться (дыра не видна ни глазу, ни
    смоуку — только живому замеру). Нормализация — `areaOf()`.
11. Живой замер обязан мерить в кадре ноды. `widget.last_y` пишет сам
    рендерер; если зонд рисует с другим `y`, `previewArea` (в координатах
    ноды) и синтетические точки (в координатах offscreen) разъедутся, и
    «мышь не работает» будет ложным выводом о ноде, а не о приборе.
12. Любой «зелёный» живой замер нужен с контролем прибора: два одинаковых
    рендера обязаны дать 0 отличий пикселей, иначе детектор слеп (сравнение
    меняющихся картинок ничего не доказывает).

## 14. Приёмка

```text
=== Degg_Crop ===
  [ok] логика ноды (Python, реальный torch)
  [ok] JS-смоук (заглушки window/LiteGraph)
  [ok] статический аудит
  [ok] check.json ссылается на существующие файлы

ЗЕЛЁНОЕ: провалов 0
```

Затем `python sync.py Degg_Crop` (6 файлов) и живой замер
`python tests/_probe_live_dom.py` при запущенном ComfyUI → `живой замер чист`
(43 ok), сервер выключить. Ручная проверка глазами в браузере — по
желанию: всё, что она проверяет (превью, drag/ресайз рамки в обоих режимах,
пресеты 16:9 и Full, кнопки, бейдж размера, reopen workflow без потери
виджетов), уже покрыто живым замером на реальном фронтенде.

### 14.1. Найдено живым замером (и исправлено)

1. `previewArea` в формате `{w,h}` при чтении `width/height` → границы `NaN`,
   клик вне предпросмотра не отсекался (ловушка §13.10).
2. Сам зонд мерил в чужом кадре координат: рендерер рисует виджет от
   `widget.last_y = 566`, а зонд рисовал от `y = 60` (ловушка §13.11).
   Дефект прибора, не ноды — исправлен переходом на кадр ноды + контроль
   сходимости (§13.12).
