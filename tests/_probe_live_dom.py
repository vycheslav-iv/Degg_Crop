"""Живой замер Degg_Crop в реальном браузере (headless Chrome + CDP).

Отвечает на то, что заглушкам недоступно:
  1. фронтенд реально вызывает draw() нашего виджета (по widget.last_y —
     его пишет только рендерер);
  2. контракт: draw/mouse/computeSize лежат на ВЕРХНЕМ уровне виджета
     (в options.* фронтенд их не читает);
  3. источник находится через graph.links (Map-Proxy) и URL идёт через apiURL;
  4. рамка рисуется, drag работает, и окно УХОДИТ ЗА ГРАНИЦЫ изображения
     (аутпеинт) — без клампа;
  5. computeSize резервирует PREVIEW_H.

Запуск (ComfyUI должен быть запущен):
    cd Degg_Crop
    python tests/_probe_live_dom.py
    python tests/_probe_live_dom.py --keep      # не закрывать Chrome
    python tests/_probe_live_dom.py --url http://127.0.0.1:8188/

Зависимости — только то, что уже есть в ComfyUI (websockets). Профиль Chrome
временный, нода удаляется из графа в конце.
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

PROBE_JS = r"""
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

  const w = (type.widgets || []).find((x) => x && x.name === "degg_crop_preview");
  out.widgetFound = !!w;
  out.widgetNames = (type.widgets || []).map((x) => x && x.name);
  if (!w) return out;

  // 1. КОНТРАКТ: draw/mouse/computeSize — на верхнем уровне виджета.
  out.contract = {
    draw: typeof w.draw === "function",
    mouse: typeof w.mouse === "function",
    computeSize: typeof w.computeSize === "function",
    drawInOptions: !!(w.options && typeof w.options.draw === "function"),
    mouseInOptions: !!(w.options && typeof w.options.mouse === "function"),
    canvasOnly: !!(w.options && w.options.canvasOnly),
    serialize: w.serialize,
  };
  out.computeSize = w.computeSize ? w.computeSize(300) : null;

  // 2. api namespace: URL строится из comfyAPI.api.api.apiURL.
  out.api = {
    ns: !!(window.comfyAPI && window.comfyAPI.api),
    client: !!(window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api),
    apiURL: !!(window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api
               && typeof window.comfyAPI.api.api.apiURL === "function"),
  };

  // 3. Источник: LoadImage → DeggCrop через graph.links (Map).
  const P = window.DeggCropPreview;
  out.previewExported = !!P;
  try {
    const load = window.LiteGraph.createNode("LoadImage");
    if (load) {
      g.add(load);
      load.pos = [-700, 40];
      const lw = (load.widgets || []).find((x) => x && x.name === "image");
      if (lw) lw.value = "022.png";
      let wired = false;
      if (typeof load.connect === "function") wired = !!load.connect(0, type, 0);
      out.linksCtor = (g.links && g.links.constructor && g.links.constructor.name) || String(g.links);
      out.wired = wired;
      out.upstreamUrl = P && P.resolveImageUrl ? P.resolveImageUrl(type) : null;
      out.loadUrl = P && P.resolveImageUrl ? P.resolveImageUrl(load) : null;
      // эталон: что apiURL даёт для того же пути (в этом билде — относительный /api/...)
      try {
        out.apiURLProbe = window.comfyAPI.api.api.apiURL("/view?filename=022.png&type=input");
      } catch (e) { out.apiURLProbe = String(e); }
      try { g.remove(load); } catch (e) {}
    } else {
      out.upstreamUrl = "no LoadImage type";
    }
  } catch (e) { out.upstreamUrl = "ERR " + (e && e.stack ? e.stack : e); }

  // 4. Реальный рендерер вызывает draw() — видно по last_y (мы его не пишем).
  try { window.app.canvas.centerOnNode(type); } catch (e) {}
  try { window.app.canvas.setDirty(true, true); } catch (e) {}
  try { type.setDirtyCanvas && type.setDirtyCanvas(true, true); } catch (e) {}
  try { window.app.canvas.draw(true, true); } catch (e) {}
  await new Promise((r) => setTimeout(r, 900));
  out.rendererCalledDraw = typeof w.last_y === "number";
  out.lastY = w.last_y;

  // 5. draw() в offscreen-канвас: рамка рисуется и координаты корректны.
  type.imgs = [{ src: PROBE_URL }];
  const W = 320, Y = 60, H = 200;
  const c = document.createElement("canvas");
  c.width = W; c.height = Y + H + 20;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  let drawErr = null;
  try { w.draw(ctx, type, W, Y); } catch (e) { drawErr = String(e); }
  await new Promise((r) => setTimeout(r, 600));
  try { w.draw(ctx, type, W, Y); } catch (e) { drawErr = String(e); }
  out.drawError = drawErr;
  out.previewY = type._previewY;
  out.imgLoaded = !!(type._img && type._img.complete && type._img.naturalWidth > 0);
  out.imgSize = [type._imgW, type._imgH];
  out.layout = type._layout ? {
    scale: type._layout.scale,
    win: type._layout.win,
    img: type._layout.img,
  } : null;

  const px = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  };
  out.pxAbove = px(160, Y - 3);
  out.pxInside = px(160, Y + 12);
  const data = ctx.getImageData(0, Y, W, H).data;
  let painted = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
  out.paintedRatio = Math.round((painted / (W * H)) * 1000) / 1000;

  // 6. DRAG: тянем рамку за пределы изображения (аутпеинт).
  const find = (n) => (type.widgets || []).find((x) => x && x.name === n);
  const setW = (n, v) => { const x = find(n); if (x) x.value = v; };
  const getW = (n) => { const x = find(n); return x ? x.value : null; };
  setW("x", 100); setW("y", 100); setW("width", 200); setW("height", 200);
  setW("megapixels", 0); setW("multiplicity", 8);
  setW("ratio_lock", false); setW("aspect_ratio", "Custom");
  type._rect = { x: 100, y: 100, w: 200, h: 200 };
  type._drag = null;
  w.draw(ctx, type, W, Y);
  const L = type._layout;
  const cx = L.win.x + L.win.w / 2;
  const cy = L.win.y + L.win.h / 2 + Y;
  out.hitCenter = P.getHitArea(type, [cx, cy], Y);
  const started = w.mouse({ type: "pointerdown", buttons: 1 }, [cx, cy], type);
  out.dragStarted = started === true && !!type._drag;
  // тянем влево-вверх далеко → окно обязано уйти в отрицательные x/y
  w.mouse({ type: "pointermove", buttons: 1 }, [cx - 400, cy - 400], type);
  out.afterDrag = { x: getW("x"), y: getW("y"), w: getW("width"), h: getW("height") };
  w.mouse({ type: "pointerup", buttons: 0 }, [cx - 400, cy - 400], type);
  out.dragCleared = type._drag === null;

  // 7. Поля: точное пиксельное задание аутпеинта (x<0, width больше источника).
  setW("x", -64); setW("y", -32); setW("width", 768); setW("height", 544);
  type._rect = null;
  w.draw(ctx, type, W, Y);
  out.manualExpand = {
    rect: type._rect,
    winInside: type._layout.win.x >= 0 && type._layout.win.y >= 0,
    winRight: type._layout.win.x + type._layout.win.w <= W + 0.5,
  };
  const tgt = P.pythonTarget(type);
  out.pythonTarget = tgt;
  setW("x", 0); setW("y", 0); setW("width", 512); setW("height", 512);

  try { g.remove(type); } catch (e) {}
  window.__dcProbeNode = null;
  try { window.app.canvas.setDirty(true, true); } catch (e) {}
  return out;
})()
"""


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def _reexec_with_websockets() -> None:
    """Проектный python без websockets — перезапускаемся под python_embeded."""
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
        probe = subprocess.run([cand, "-c", "import websockets"], capture_output=True)
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
            d = res["exceptionDetails"].get("exception", {}).get("description", "eval error")
            raise RuntimeError(d)
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

            res = await cdp.eval(PROBE_JS.replace("PROBE_URL", json.dumps(PROBE_IMAGE)),
                                 await_promise=True)
            print("→ замер: " + json.dumps(res, ensure_ascii=False)[:500])

            if not res:
                check("замер вернулся", False, "пусто")
            elif res.get("error"):
                check("нет ошибки на стороне страницы", False, str(res["error"]))
            else:
                check("нода DeggCrop создана в реальном графе", res.get("nodeId") is not None)
                check("виджет degg_crop_preview есть", bool(res.get("widgetFound")),
                      json.dumps(res.get("widgetNames") or [], ensure_ascii=False))

                c = res.get("contract") or {}
                check("контракт: draw на верхнем уровне виджета", c.get("draw") is True)
                check("контракт: mouse на верхнем уровне виджета", c.get("mouse") is True)
                check("контракт: computeSize на верхнем уровне виджета", c.get("computeSize") is True)
                check("контракт: draw НЕ в options (фронтенд его не читает)",
                      c.get("drawInOptions") is False, json.dumps(c))
                check("контракт: mouse НЕ в options", c.get("mouseInOptions") is False)
                check("контракт: canvasOnly=true", c.get("canvasOnly") is True)
                check("контракт: serialize=false", c.get("serialize") is False)

                cs = res.get("computeSize") or []
                check("computeSize резервирует PREVIEW_H=160",
                      len(cs) == 2 and cs[1] == 160, json.dumps(cs))

                api = res.get("api") or {}
                check("api: namespace comfyAPI.api есть", api.get("ns") is True)
                check("api: клиент comfyAPI.api.api есть", api.get("client") is True)
                check("api: apiURL доступен", api.get("apiURL") is True)

                check("реальный рендерер вызвал draw()", res.get("rendererCalledDraw") is True,
                      "last_y=%s" % res.get("lastY"))
                check("draw() без исключений", res.get("drawError") is None,
                      json.dumps(res.get("drawError")))
                check("draw() запомнил _previewY = 60", res.get("previewY") == 60,
                      str(res.get("previewY")))
                check("draw() запомнил layout", bool(res.get("layout")))
                check("рисуем от y (выше пусто)", (res.get("pxAbove") or {}).get("a", 255) == 0,
                      json.dumps(res.get("pxAbove")))
                check("внутри y залито", (res.get("pxInside") or {}).get("a", 0) > 0,
                      json.dumps(res.get("pxInside")))
                # регион предпросмотра с отступами PREVIEW_PAD: 0.8 — это полная
                # заливка (отступы по краям не считаются).
                check("заливка заняла регион предпросмотра",
                      (res.get("paintedRatio") or 0) >= 0.8, str(res.get("paintedRatio")))
                check("источник реально загружен (картинка нарисована)",
                      res.get("imgLoaded") is True, json.dumps(res.get("imgSize")))

                up = res.get("upstreamUrl") or ""
                check("источник найден через graph.links",
                      isinstance(up, str) and "filename=022.png" in up, str(up))
                # URL обязан быть результатом apiURL (в этом билде — /api/view?…),
                # а не сырым относительным путём, который мог бы не открыться.
                probe = res.get("apiURLProbe") or ""
                check("URL идёт через apiURL (совпадает с эталоном)",
                      isinstance(up, str) and bool(probe)
                      and up.split("?")[0] == probe.split("?")[0],
                      "up=%s probe=%s" % (up, probe))

                check("getHitArea: центр окна → move", res.get("hitCenter") == "move",
                      str(res.get("hitCenter")))
                check("mousedown по рамке стартует drag", res.get("dragStarted") is True)
                ad = res.get("afterDrag") or {}
                check("drag УВОДИТ окно за пределы изображения (x < 0)", (ad.get("x") or 0) < 0,
                      json.dumps(ad))
                check("drag УВОДИТ окно за пределы изображения (y < 0)", (ad.get("y") or 0) < 0,
                      json.dumps(ad))
                check("drag move не меняет размеры",
                      ad.get("w") == 200 and ad.get("h") == 200, json.dumps(ad))
                check("mouseup завершает drag", res.get("dragCleared") is True)

                me = res.get("manualExpand") or {}
                check("пиксельные поля: аутпеинт x=-64 y=-32 w=768 h=544",
                      (me.get("rect") or {}).get("x") == -64
                      and (me.get("rect") or {}).get("w") == 768,
                      json.dumps(me.get("rect")))
                check("рамка аутпеинта видна внутри виджета",
                      me.get("winInside") is True and me.get("winRight") is True, json.dumps(me))
                check("pythonTarget считается (mp=0 → окно)", bool(res.get("pythonTarget")),
                      json.dumps(res.get("pythonTarget")))

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
