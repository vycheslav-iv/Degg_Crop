"""Живой замер Degg_Crop в реальном браузере — без догалок и без запуска рендера.

Зачем: Python-тест и JS-смоук проверяют логику на заглушках. Живой замер отвечает
на вопросы, которые заглушкам не проверить:
  1. фронтенд вообще вызывает draw() нашего виджета (читаем widget.last_y —
     его пишет только сам рендерер, мы его не трогаем);
  2. computeSize резервирует ровно PREVIEW_H под предпросмотр;
  3. отрисовка идёт в координатах НОДЫ (сдвиг по y), а не от нуля канваса;
  4. fit-to-target считается в браузере так же, как в смоуке.

Запуск (ComfyUI должен быть запущен):
    cd Degg_Crop
    python tests/_probe_live_dom.py
    python tests/_probe_live_dom.py --keep      # не закрывать Chrome
    python tests/_probe_live_dom.py --url http://127.0.0.1:8188/

Зависимости — только те, что уже есть в ComfyUI (websockets). Ничего вне
проекта не меняется: профиль Chrome временный, нода удаляется из графа в конце.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

PROBE_IMAGE = "/view?filename=022.png&type=input"

CREATE_AND_MEASURE_JS = r"""
(async () => {
  const out = {};
  const g = window.app && window.app.graph;
  if (!g) { out.error = "no graph"; return out; }
  const type = window.LiteGraph.createNode("DeggCrop");
  if (!type) { out.error = "no node type"; return out; }
  g.add(type);
  type.pos = [40, 40];
  window.__dcProbeNode = type;
  out.nodeId = type.id;
  out.nodeSizeAfterCreate = type.size ? [type.size[0], type.size[1]] : null;

  const w = (type.widgets || []).find((x) => x && x.name === "degg_crop_preview");
  out.widgetFound = !!w;
  if (!w) { out.widgets = (type.widgets || []).map((x) => x && x.name); return out; }

  out.computeSize = w.computeSize ? w.computeSize(300) : null;
  out.nodeComputeSize = type.computeSize ? type.computeSize([...type.size]) : null;
  out.widgetNames = (type.widgets || []).map((x) => x && x.name);
  out.serialize = w.serialize;

  // Рендерер должен сам дернуть draw() — это видно по last_y (мы его не пишем).
  out.canvasRef = !!(window.app && window.app.canvas);
  out.nodeFlags = JSON.stringify(type.flags || null);
  out.inGraph = !!(window.app.graph._nodes || []).includes(type);
  out.renderingSize = type.renderingSize ? [...type.renderingSize] : null;
  out.dwCalls = 0;
  const origDW = type.drawWidgets;
  if (typeof origDW === "function") {
    type.drawWidgets = function () { out.dwCalls++; return origDW.apply(this, arguments); };
  } else { out.dwCalls = "no drawWidgets"; }
  out.widgetDrawCalls = 0;
  out.drawArgs = null;
  const origWDraw = w.draw;
  w.draw = function (ctx, node, width, y) {
    out.widgetDrawCalls++;
    if (!out.drawArgs) out.drawArgs = [width, y];
    return origWDraw.apply(this, arguments);
  };
  // нода может быть вне вьюпорта (рисуются только видимые) — центрируем взгляд
  try { window.app.canvas.centerOnNode(type); out.centered = true; }
  catch (e) { out.centered = String(e); }
  out.widgetY = (w.y === undefined) ? null : w.y;
  out.widgetType = w.type;
  try { window.app.canvas.setDirty(true, true); } catch (e) { out.dirtyErr = String(e); }
  try { window.app.graph.setDirtyCanvas && window.app.graph.setDirtyCanvas(true, true); }
  catch (e) { out.dirtyErr2 = String(e); }
  try { type.setDirtyCanvas && type.setDirtyCanvas(true, true); } catch (e) {}
  // в headless кадры непредсказуемы — дёргаем отрисовку принудительно:
  // путь drawWidgets() тот же, что и при обычном кадре
  try { window.app.canvas.draw(true, true); out.drawForced = true; }
  catch (e) { out.drawForced = String(e); }
  await new Promise((r) => setTimeout(r, 800));
  out.lastY_t1 = (w.last_y === undefined) ? null : w.last_y;
  out.rendererCalledDraw = out.widgetDrawCalls > 0;
  try { window.app.canvas.setDirty(true, true); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
  out.lastY_t2 = (w.last_y === undefined) ? null : w.last_y;
  out.lastYAfterRealRender = out.lastY_t1 ?? out.lastY_t2;

  // Своя отрисовка в offscreen-канвас, чтобы измерить пиксели.
  const Y = 60, H = 200, W = 300;
  const c = document.createElement("canvas");
  c.width = W; c.height = Y + H + 10;
  const ctx = c.getContext("2d", { willReadFrequently: true });

  const P = window.DeggCropPreview;
  out.previewExported = !!P;
  if (P) {
    out.layout = {
      crop: P.layoutCrop({ x: 0, y: 0, w: 300, h: H }, 640, 480, 100, 50, 300, 200),
      expand: P.layoutExpand({ x: 0, y: 0, w: 300, h: H }, 640, 480, 10, 20, 800, 600),
      fillBlack: P.fillStyle(ctx, "black"),
    };
  }

  // Реальный путь чтения источника: LoadImage → DeggCrop через graph.links.
  // У фронтенда это Map (`links:new Map`), статический доступ links[id] молча
  // возвращал undefined — превью показывало «No image» при подключённом входе.
  try {
    type.imgs = [];
    const links = g.links;
    out.linksCtor = (links && links.constructor && links.constructor.name) || String(links);
    out.hasLinkFn = typeof g.link;
    out.hasGetNode = typeof g.getNodeById;
    let load = null, wired = false, err = "";
    try { load = window.LiteGraph.createNode("LoadImage"); } catch (e) { err = "create: " + e; }
    if (load) {
      try { g.add(load); load.pos = [-700, 40]; } catch (e) { err = "add: " + e; }
      try {
        const lw = (load.widgets || []).find((x) => x && x.name === "image");
        if (lw) lw.value = "022.png";
      } catch (e) { err = "widget: " + e; }
      // официальный путь litegraph: выход LoadImage → вход DeggCrop
      if (typeof load.connect === "function") {
        try {
          const made = load.connect(0, type, 0);
          wired = !!made;
          if (wired) out.connectVia = "node.connect";
        } catch (e) { err = "connect: " + (e && e.stack ? e.stack : e); }
      }
      if (!wired && typeof g.link === "function") {
        try { wired = !!g.link(load, 0, type, 0); if (wired) out.connectVia = "graph.link"; }
        catch (e) { err = "g.link: " + e; }
      }
      if (!wired) {
        try {
          const inp = (type.inputs || []).find((i) => i && i.name === "image");
          if (inp && links && typeof links.set === "function") {
            const lid = 90011;
            links.set(lid, { id: lid, origin_id: load.id, origin_slot: 0,
                             target_id: type.id, target_slot: 0 });
            inp.link = lid;
            wired = true;
          } else if (inp && links) {
            links[lid] = { id: lid, origin_id: load.id, origin_slot: 0,
                           target_id: type.id, target_slot: 0 };
            inp.link = lid;
            wired = true;
          }
        } catch (e) { err = "manual: " + (e && e.stack ? e.stack : e); }
      }
      out.upstreamWired = wired;
      out.upstreamErr = err || null;
      try {
        const P2 = window.DeggCropPreview;
        out.loadUrl = (P2 && P2.getImageUrl) ? P2.getImageUrl(load) : "no P";
        out.inputLinks = (type.inputs || []).map((i) => i.name + ":" + i.link);
        out.loadWidgets = (load.widgets || []).map((x) => x && (x.name + "=" + x.value));
        out.apiPresent = !!(window.comfyAPI && window.comfyAPI.api
                            && typeof window.comfyAPI.api.apiURL === "function");
        out.originIds = window.app && window.app.graph && window.app.graph.links
          && typeof window.app.graph.links.get === "function"
          ? [...window.app.graph.links.keys()].slice(0, 5) : "n/a";
        out.upstreamUrl = (P2 && P2.getImageUrl) ? P2.getImageUrl(type) : null;
      } catch (e) { out.upstreamUrl = "getImageUrl: " + (e && e.stack ? e.stack : e); }
      try { g.remove(load); } catch (e) { out.upstreamErr = (out.upstreamErr || "") + " remove:" + e; }
    } else {
      out.upstreamUrl = "no LoadImage type";
      out.upstreamErr = err;
    }
  } catch (e) { out.upstreamUrl = "ERR " + (e && e.stack ? e.stack : e); }

  type.imgs = [{ src: PROBE_URL }];
  let drawErr = null;
  // сигнатура фронтенда: draw(ctx, node, width, y) — y в координатах ноды
  try { w.draw(ctx, type, W, Y); } catch (e) { drawErr = String(e); }
  await new Promise((r) => setTimeout(r, 700));   // ждём onload картинки
  try { w.draw(ctx, type, W, Y); } catch (e) { drawErr = String(e); }
  out.drawError = drawErr;

  const px = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };
  out.pxAbove = px(150, Y - 3);   // должно быть пусто: рисуем от Y, не от 0
  out.pxInside = px(150, Y + 12);  // внутри бокса: y + MARGIN(8) + 4
  out.pxLeftInside = px(2, Y + 4);

  const data = ctx.getImageData(0, Y, W, H).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
  out.paintedRatio = Math.round(painted / (W * H) * 1000) / 1000;

  // сколько уникальных цветов — картинка реально нарисована, а не только фон
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4 * 37) seen.add(data[i] + "," + data[i+1] + "," + data[i+2]);
  out.distinctColors = seen.size;

  return out;
})()
"""

"""Интерактив в реальном фронтенде: мышью по рамке, пресеты, кнопки, бейдж.

Прибор: каждая ветка проверяется на живом объекте, а «слепой детектор»
закрыт контролем (два одинаковых рендера обязаны дать 0 отличий пикселей).
"""
INTERACT_JS = r"""
(async () => {
  const out = {};
  const type = window.__dcProbeNode;
  const P = window.DeggCropPreview;
  if (!type || !P) { out.error = "нет ноды или экспорта"; return out; }
  const find = (n) => (type.widgets || []).find((x) => x && x.name === n);
  const set = (n, v) => { const x = find(n); if (x) x.value = v; };
  const get = (n) => { const x = find(n); return x ? x.value : null; };
  const w = find("degg_crop_preview");
  const W = 300, Y = 60;
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });

  set("operation", "Crop");
  ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => set(n, 0));
  set("ratio_lock", false); set("resolution_mp", 0); set("multiplicity", 16);
  set("x", 0); set("y", 0);

  // дожидаемся реальной загрузки источника через onload картинки
  const t0 = Date.now();
  while ((!type._deggImg || !type._deggImg.complete || !type._deggImg.naturalWidth)
         && Date.now() - t0 < 8000) {
    w.draw(ctx, type, W, Y);
    await new Promise((r) => setTimeout(r, 100));
  }
  const img = type._deggImg || {};
  const srcW = img.naturalWidth || 0, srcH = img.naturalHeight || 0;
  out.src = [srcW, srcH];
  out.imageReady = !!(srcW && srcH);
  if (!out.imageReady) return out;

  // Кадр координат: живого рендерера, а не offscreen-заглушки. Фронтенд рисует
  // виджет от y = widget.last_y и в координатах НОДЫ, и туда же приходят pos
  // в mouse(). Рисовать надо с теми же width/y, иначе previewArea окажется
  // в другой системе координат, чем синтетические точки.
  const nW = (type.size && type.size[0] > 40) ? type.size[0] : W;
  const nY = (typeof w.last_y === "number" && w.last_y > 0) ? w.last_y : Y;
  out.frame = { w: nW, y: nY };
  const frame = document.createElement("canvas");
  frame.width = Math.max(60, Math.ceil(nW));
  frame.height = nY + 220;
  const fctx = frame.getContext("2d", { willReadFrequently: true });

  const winW = Math.min(256, srcW), winH = Math.min(256, srcH);
  set("width", winW); set("height", winH);
  w.draw(fctx, type, nW, nY);
  const L = type._deggLayout;
  out.layoutMode = L && L.mode;
  out.hasPreviewArea = !!type.previewArea;
  out.scale = L && L.scale;

  const pa = type.previewArea;
  const cx = Math.max(pa.x + 2, Math.min(pa.x + pa.width - 2, L.win.x + L.win.w / 2));
  const cy = Math.max(pa.y + 2, Math.min(pa.y + pa.height - 2, L.win.y + L.win.h / 2));
  out.hitCenter = P.getHitArea(type, [cx, cy]);
  out.hitCorner = P.getHitArea(type, [L.win.x, L.win.y]);
  out.hitOutside = P.getHitArea(type, [0, 0]);
  // независимый пересчёт той же геометрии — диагностика кадра координат
  {
    const ix = (cx - L.origin.x) / L.scale, iy = (cy - L.origin.y) / L.scale;
    const th = 15 / L.scale;
    const x1 = L.sel.x, y1 = L.sel.y, x2 = L.sel.x + L.sel.w, y2 = L.sel.y + L.sel.h;
    out.diag = {
      origin: L.origin, sel: L.sel, win: L.win, pa: [pa.x, pa.y, pa.w, pa.h],
      paWH: [pa.width, pa.height], cx, cy, ix, iy, th,
      nearL: Math.abs(ix - x1) < th, nearR: Math.abs(ix - x2) < th,
      nearT: Math.abs(iy - y1) < th, nearB: Math.abs(iy - y2) < th,
      inX: ix > x1 && ix < x2, inY: iy > y1 && iy < y2,
    };
  }

  // drag рамки: центр окна → +20 px по X (координаты ноды)
  const x0 = get("x"), y0 = get("y");
  const wBefore = get("width"), hBefore = get("height");
  const started = w.mouse({ type: "mousedown", buttons: 1, button: 0 }, [cx, cy], type);
  const dragging = !!(type._deggDrag);
  const dx = 20 / L.scale;
  w.mouse({ type: "mousemove", buttons: 1 }, [cx + 20, cy], type);
  const x1 = get("x"), y1 = get("y");
  const wAfter = get("width"), hAfter = get("height");
  w.mouse({ type: "mouseup", buttons: 0 }, [cx + 20, cy], type);
  out.drag = { started, dragging, x0, x1, y0, y1, dx, wBefore, hBefore, wAfter, hAfter,
               cleared: !type._deggDrag };
  out.dragExpect = Math.round(Math.max(0, Math.min(Math.max(0, srcW - winW), x0 + dx)));

  // пресет 16:9 через живой callback комбо
  const preset = find("Ratio Presets");
  preset.callback("16:9");
  const rw = get("width"), rh = get("height");
  out.ratio = { ar: get("aspect_ratio"), w: rw, h: rh, got: rh ? rw / rh : 0,
                preset: preset.value };
  out.outSideSrc = (get("x") + rw <= srcW + 1) && (get("y") + rh <= srcH + 1);

  // кнопка Full Image
  find("Full Image").callback();
  out.full = { x: get("x"), y: get("y"), w: get("width"), h: get("height"), src: [srcW, srcH] };

  // pythonTarget(mp=2) — сверяем с независимым расчётом здесь же
  set("resolution_mp", 2);
  const tgt = P.pythonTarget(type);
  const roundTo = (v, m) => {
    const q = v / m, f = Math.floor(q), d = q - f;
    const r = d > 0.5 ? f + 1 : (d < 0.5 ? f : (f % 2 === 0 ? f : f + 1));
    return Math.max(m, r * m);
  };
  const area = 2 * 1e6, ratio = srcW / srcH;
  out.mp = { got: tgt,
             want: [roundTo(Math.sqrt(area * ratio), 16), roundTo(Math.sqrt(area / ratio), 16)] };

  // бейдж рисуется из pythonTarget: меняем MP → картинка обязана измениться,
  // а два одинаковых рендера — дать 0 отличий (валидация прибора)
  const renderRegion = (v) => {
    set("resolution_mp", v);
    const c = document.createElement("canvas");
    c.width = Math.ceil(nW); c.height = nY + 220;
    const g2 = c.getContext("2d", { willReadFrequently: true });
    w.draw(g2, type, nW, nY);
    return g2.getImageData(0, nY, Math.ceil(nW), 205).data;
  };
  const A = renderRegion(0), B = renderRegion(2), C = renderRegion(0);
  const diff = (p, q) => {
    let n = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (Math.abs(p[i] - q[i]) > 8 || Math.abs(p[i + 1] - q[i + 1]) > 8
          || Math.abs(p[i + 2] - q[i + 2]) > 8 || Math.abs(p[i + 3] - q[i + 3]) > 8) n++;
    }
    return n;
  };
  out.badgeDiff = diff(A, B);
  out.badgeControl = diff(A, C);
  let painted = 0;
  for (let i = 3; i < A.length; i += 4) if (A[i] > 0) painted++;
  out.paintedRatio = painted / (Math.ceil(nW) * 205);
  set("resolution_mp", 0);

  // Expand: drag двигает позицию вставки (x/y), а не размеры холста
  set("operation", "Expand");
  set("x", 0); set("y", 0); set("width", 640); set("height", 480);
  w.draw(fctx, type, nW, nY);
  const Le = type._deggLayout;
  const ex0 = get("x");
  const ecx = Le.out.x + Le.out.w / 2, ecy = Le.out.y + Le.out.h / 2;
  const eHit = P.getHitArea(type, [ecx, ecy]);
  w.mouse({ type: "mousedown", buttons: 1 }, [ecx, ecy], type);
  w.mouse({ type: "mousemove", buttons: 1 }, [ecx + 15, ecy], type);
  const ex1 = get("x");
  w.mouse({ type: "mouseup", buttons: 0 }, [ecx + 15, ecy], type);
  out.expand = { mode: Le.mode, hit: eHit, x0: ex0, x1: ex1,
                 w: get("width"), h: get("height") };

  // Crop + проценты: width/height считаются от выделения и кратны multiplicity
  set("operation", "Crop");
  ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => set(n, 10));
  P.syncCropDisplays(type);
  const sel = P.getSel(type);
  out.pct = { w: get("width"), h: get("height"), sel: sel, mult: get("multiplicity") };
  out.pctOk = out.pct.w % 16 === 0 && out.pct.h % 16 === 0
              && Math.abs(out.pct.w - sel.w) <= 8 && Math.abs(out.pct.h - sel.h) <= 8;

  // reopen: python-состояние обязано уехать в workflow, а JS-виджеты — нет
  try {
    const ser = type.serialize();
    const jsOnly = (type.widgets || []).filter((x) => x && x.serialize === false)
      .map((x) => x.name);
    const nativeNames = (type.widgets || []).filter((x) => !(x && x.serialize === false))
      .map((x) => x.name);
    out.serialize = {
      valuesLen: (ser.widgets_values || []).length,
      nativeCount: nativeNames.length,
      nativeNames, jsOnly,
      hasCrop: nativeNames.includes("crop_left") && nativeNames.includes("aspect_ratio"),
    };
  } catch (e) { out.serialize = { error: String(e) }; }

  // вернуть ноду в нейтральное состояние
  ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => set(n, 0));
  set("operation", "Crop");
  return out;
})()
"""

CLEANUP_JS = r"""
(() => {
  const n = window.__dcProbeNode;
  const g = window.app && window.app.graph;
  if (n && g) { try { g.remove(n); } catch (e) {} }
  window.__dcProbeNode = null;
  if (window.app && window.app.canvas) window.app.canvas.setDirty(true, true);
  return "cleaned";
})()
"""


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _reexec_with_websockets() -> None:
    """Проектный python (F:\\Python) без websockets — перезапускаемся под
    python_embeded у ComfyUI, где лежат и websockets, и torch. Если ни один
    интерпретатор не найден — честно выходим с 1, а не с зелёным."""
    try:
        import websockets  # noqa: F401
        return
    except ImportError:
        pass

    me = Path(__file__).resolve()
    candidates = []
    env = os.environ.get("COMFY_PY")
    if env:
        candidates.append(env)
    candidates.append(r"D:\ComfyUI_windows_portable\python_embeded\python.exe")

    for cand in candidates:
        if not Path(cand).exists():
            continue
        probe = subprocess.run([cand, "-c", "import websockets"],
                               capture_output=True)
        if probe.returncode == 0:
            r = subprocess.run([cand, str(me)] + sys.argv[1:], capture_output=True)
            sys.stdout.write(r.stdout.decode("utf-8", "replace"))
            sys.stderr.write(r.stderr.decode("utf-8", "replace"))
            sys.stdout.flush()
            sys.exit(r.returncode)

    print("ЖИВОЙ ЗАМЕР НЕ ЗАПУЩЕН: ни один интерпретатор не имеет модуля websockets",
          flush=True)
    print("FAIL: 1", flush=True)
    sys.exit(1)


def find_chrome() -> str:
    env = os.environ.get("CHROME_PATH")
    if env and Path(env).exists():
        return env
    for p in CHROME_CANDIDATES:
        if Path(p).exists():
            return p
    raise SystemExit("Chrome не найден (задай CHROME_PATH)")


def wait_devtools(port: int, timeout: float = 30.0) -> dict:
    url = f"http://127.0.0.1:{port}/json/list"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                pages = json.load(r)
            for p in pages:
                if p.get("type") == "page" and p.get("webSocketDebuggerUrl"):
                    return p
        except Exception:
            pass
        time.sleep(0.3)
    raise SystemExit("CDP не отвечает: страница не найдена")


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self._id = 0

    async def call(self, method: str, params: dict | None = None):
        self._id += 1
        mid = self._id
        await self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(await self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expr: str, await_promise: bool = False):
        res = await self.call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": await_promise,
        })
        if "exceptionDetails" in res:
            raise RuntimeError(res["exceptionDetails"].get("exception", {}).get("description", "eval error"))
        return res.get("result", {}).get("value")


async def wait_for(cdp: CDP, expr: str, timeout: float = 120.0, label: str = ""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = await cdp.eval(expr)
            if last:
                return last
        except Exception as e:
            last = repr(e)
        await asyncio.sleep(0.5)
    raise SystemExit(f"не дождались: {label or expr} (последнее: {last!r})")


def near(a, b, tol=1e-6) -> bool:
    return a is not None and abs(a - b) <= tol


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8188/")
    ap.add_argument("--port", type=int, default=9444)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()

    try:
        import websockets  # noqa: WPS433 — зависимость ComfyUI
    except ImportError:
        raise SystemExit("нет модуля websockets — запускай через python_embeded")

    profile = Path(tempfile.mkdtemp(prefix="dc-probe-"))
    chrome = subprocess.Popen([
        find_chrome(),
        "--headless=new",
        f"--remote-debugging-port={args.port}",
        f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check",
        "--window-size=1600,1000",
        "--disable-features=Translate",
        args.url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    errors: list[str] = []
    oks: list[str] = []

    def check(label: str, cond: bool, extra: str = ""):
        (oks if cond else errors).append(label)
        mark = "ok  " if cond else "FAIL"
        print(f"  {mark} {label}" + (f"  [{extra}]" if extra else ""))

    try:
        page = wait_devtools(args.port)
        async with websockets.connect(page["webSocketDebuggerUrl"], max_size=32 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            await cdp.call("Runtime.enable")
            print("→ ждём загрузку фронтенда…")
            await wait_for(cdp, "!!(window.app && window.app.isGraphReady)", 180, "app.isGraphReady")

            expr = CREATE_AND_MEASURE_JS.replace("PROBE_URL", json.dumps(PROBE_IMAGE))
            res = await cdp.eval(expr, await_promise=True)
            print("→ замер: " + json.dumps(res, ensure_ascii=False)[:400])
            print("→ diag: " + json.dumps({k: res.get(k) for k in
                ("rendererCalledDraw", "widgetDrawCalls", "drawArgs", "canvasRef", "centered", "nodeFlags", "inGraph", "renderingSize", "dwCalls", "widgetDrawCalls", "widgetY", "widgetType", "dirtyErr", "drawForced", "lastY_t1", "lastY_t2",
                 "connectVia", "loadUrl", "inputLinks", "loadWidgets", "apiPresent",
                 "originIds", "linksCtor", "hasLinkFn", "upstreamWired",
                 "upstreamErr", "upstreamUrl", "widgets")}, ensure_ascii=False))

            if not res:
                check("замер вернулся", False, "пусто")
            elif res.get("error"):
                check("нет ошибки на стороне страницы", False, str(res["error"]))
            else:
                check("нода DeggCrop создана в реальном графе", res.get("nodeId") is not None)
                check("виджет degg_crop_preview есть", bool(res.get("widgetFound")),
                      json.dumps(res.get("widgets") or []))
                cs = res.get("computeSize") or []
                check("computeSize резервирует PREVIEW_H=200",
                      len(cs) == 2 and cs[1] == 200, json.dumps(cs))
                check("после create нода уже включает предпросмотр (h >= 200)",
                      (res.get("nodeSizeAfterCreate") or [0, 0])[1] >= 200,
                      json.dumps(res.get("nodeSizeAfterCreate")))
                check("виджет не сериализуется", res.get("serialize") is False,
                      json.dumps(res.get("serialize")))

                check("реальный рендерер вызвал draw()",
                      bool(res.get("rendererCalledDraw")),
                      "вызовов=%s args=%s" % (res.get("widgetDrawCalls"),
                                              json.dumps(res.get("drawArgs"))))

                check("draw() в браузере без исключений", res.get("drawError") is None,
                      json.dumps(res.get("drawError")))
                above = res.get("pxAbove") or {}
                inside = res.get("pxInside") or {}
                check("рисуем от y, а не от 0: строка выше y пустая", above.get("a", 255) == 0,
                      json.dumps(above))
                check("строка внутри y залита", inside.get("a", 0) > 0, json.dumps(inside))
                ratio = res.get("paintedRatio") or 0
                check("заливка заняла регион предпросмотра", ratio > 0.8, str(ratio))
                check("внутри есть несколько цветов (не только фон)",
                      (res.get("distinctColors") or 0) > 4, str(res.get("distinctColors")))

                lay = res.get("layout") or {}
                lc = lay.get("crop") or {}
                check("layoutCrop в браузере: scale = min(300/640, 200/480)",
                      near(lc.get("scale"), min(300 / 640, 200 / 480)),
                      json.dumps(lc.get("scale")))
                check("layoutExpand в браузере: scale = min(300/800, 200/600)",
                      near((lay.get("expand") or {}).get("scale"), min(300 / 800, 200 / 600)),
                      json.dumps((lay.get("expand") or {}).get("scale")))
                up = res.get("upstreamUrl") or ""
                check("превью находит LoadImage через graph.links (Map)",
                      isinstance(up, str) and "filename=022.png" in up
                      and "type=input" in up, str(up))
                check("вход физически соединён (link установлен)",
                      bool(res.get("upstreamWired")), str(res.get("upstreamWired")))
                check("fillStyle(black) = #000000 в браузере", lay.get("fillBlack") == "#000000",
                      str(lay.get("fillBlack")))

            it = await cdp.eval(INTERACT_JS, await_promise=True)
            print("→ interact: " + json.dumps(it, ensure_ascii=False)[:500])
            if not it:
                check("интерактивный замер вернулся", False, "пусто")
            elif it.get("error"):
                check("нет ошибки в интерактивном замере", False, str(it["error"]))
            else:
                check("источник реально загружен в превью", it.get("imageReady") is True,
                      json.dumps(it.get("src")))
                check("раскладка Crop считается в браузере", it.get("layoutMode") == "crop",
                      str(it.get("layoutMode")))
                check("previewArea выставлен для hit-testing", it.get("hasPreviewArea") is True)
                check("getHitArea: центр окна → move", it.get("hitCenter") == "move",
                      str(it.get("hitCenter")) + " diag=" + json.dumps(it.get("diag")))
                check("getHitArea: угол окна → tl", it.get("hitCorner") == "tl",
                      str(it.get("hitCorner")))
                check("getHitArea: вне предпросмотра → null", it.get("hitOutside") is None)
                d = it.get("drag") or {}
                check("mousedown по рамке стартует drag", d.get("dragging") is True,
                      json.dumps(d))
                check("drag двигает x ровно как dx/scale (с клампом)",
                      abs((d.get("x1") or 0) - (it.get("dragExpect") or 0)) <= 1,
                      "x1=%s expect=%s" % (d.get("x1"), it.get("dragExpect")))
                check("drag видоизменяет x (не 0-эффект)", d.get("x1") != d.get("x0"),
                      json.dumps([d.get("x0"), d.get("x1")]))
                check("drag не двигает y", d.get("y1") == d.get("y0"),
                      json.dumps([d.get("y0"), d.get("y1")]))
                check("drag-режим move не меняет размер окна",
                      d.get("wAfter") == d.get("wBefore") and d.get("hAfter") == d.get("hBefore"),
                      json.dumps([d.get("wBefore"), d.get("wAfter")]))
                check("mouseup завершает drag", d.get("cleared") is True)
                r = it.get("ratio") or {}
                check("пресет 16:9 в браузере даёт пропорцию 16:9",
                      abs((r.get("got") or 0) - 16 / 9) < 0.02, json.dumps(r))
                check("пресет 16:9 записывается в aspect_ratio", r.get("ar") == "16:9",
                      str(r.get("ar")))
                check("пресет 16:9 не выводит окно за источник",
                      it.get("outSideSrc") is True)
                f = it.get("full") or {}
                fsrc = f.get("src") or [0, 0]
                check("кнопка Full Image: окно = весь источник",
                      f.get("w") == fsrc[0] and f.get("h") == fsrc[1]
                      and f.get("x") == 0 and f.get("y") == 0, json.dumps(f))
                mp = it.get("mp") or {}
                check("pythonTarget(mp=2) сходится с независимым расчётом",
                      mp.get("got") == mp.get("want"), json.dumps(mp, ensure_ascii=False))
                check("бейдж перерисовывается при смене MP (diff > 50)",
                      (it.get("badgeDiff") or 0) > 50, str(it.get("badgeDiff")))
                check("валидация прибора: два одинаковых рендера дают 0 отличий",
                      it.get("badgeControl") == 0, str(it.get("badgeControl")))
                check("контроль: регион реально залит (не пустой холст)",
                      (it.get("paintedRatio") or 0) > 0.7, str(it.get("paintedRatio")))
                check("замер шёл в кадре координат ноды (не 0,0)",
                      (it.get("frame") or {}).get("y", 0) > 0, json.dumps(it.get("frame")))
                ex = it.get("expand") or {}
                check("Expand-window: hit-зона отдаёт move", ex.get("hit") == "move",
                      str(ex.get("hit")))
                check("Expand-window: drag сдвигает позицию вставки x",
                      (ex.get("x1") or 0) > (ex.get("x0") or 0), json.dumps(ex))
                check("Expand-window: width/height холста не тронуты",
                      ex.get("w") == 640 and ex.get("h") == 480, json.dumps(ex))
                check("Crop+10%: width/height кратны multiplicity и равны выделению",
                      it.get("pctOk") is True, json.dumps(it.get("pct")))
                s = it.get("serialize") or {}
                check("reopen: python-виджеты уезжают в workflow",
                      s.get("hasCrop") is True and s.get("nativeCount") == 15
                      and s.get("valuesLen") == s.get("nativeCount"),
                      json.dumps(s, ensure_ascii=False))
                # Фронтенд добавляет свой несериализуемый виджет ($$canvas-image-preview),
                # поэтому требуем: наши 6 несериализуемых на месте, а ни один native
                # (python) виджет не помечен serialize:false.
                js_only = s.get("jsOnly") or []
                native = s.get("nativeNames") or []
                check("reopen: JS-виджеты (пресеты/кнопки/превью) не сериализуются",
                      all(n in js_only for n in [
                          "Ratio Presets", "Full Image", "Center", "Maximize",
                          "Load Image", "degg_crop_preview"])
                      and not any(n in js_only for n in native),
                      json.dumps(js_only, ensure_ascii=False))

            print(f"→ уборка: {await cdp.eval(CLEANUP_JS)}")
    finally:
        if not args.keep:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except Exception:
                chrome.kill()
            shutil.rmtree(profile, ignore_errors=True)

    print("")
    print(f"ok: {len(oks)}   FAIL: {len(errors)}")
    if errors:
        for e in errors:
            print("  - " + e)
        print("ЖИВОЙ ЗАМЕР ПРОВАЛЕН")
        return 1
    print("живой замер чист")
    return 0


if __name__ == "__main__":
    _force_utf8()
    _reexec_with_websockets()
    sys.exit(asyncio.run(main()))
