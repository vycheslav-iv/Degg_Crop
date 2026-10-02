const { app } = window.comfyAPI?.app;
// window.comfyAPI.api — namespace (UnauthorizedError/ComfyApi/…), сам инстанс
// лежит в .api (проверено по api-X7ElNdW-.js: `window.comfyAPI.api.api=$`).
// Брать namespace → api.apiURL не функция → ВСЕ ветки URL молча возвращают
// null и превью показывает «No image» даже при подключённом LoadImage.
const apiNS = window.comfyAPI?.api;
const api = (apiNS && typeof apiNS.apiURL === "function")
  ? apiNS
  : (apiNS && apiNS.api && typeof apiNS.api.apiURL === "function") ? apiNS.api : null;

function viewUrl(query) {
  if (api && typeof api.apiURL === "function") return api.apiURL(`/view?${query}`);
  return `/view?${query}`;   // тот же origin — абсолютный путь работает и без api
}

const NODE_CLASS = "DeggCrop";
const MARGIN = 8;
const PREVIEW_H = 200;
const HANDLE_PX = 15;      // порог захвата края в пикселях НОДЫ (делится на scale)
const MIN_SEL = 16;        // минимальная сторона выделения в пикселях источника
const CROP_FIELDS = ["crop_left", "crop_right", "crop_top", "crop_bottom"];

// «Free (Source)» = полный кадр (Full Image), «Custom» — свободный режим.
const PRESETS = ["Custom", "Free (Source)", "1:1", "4:3", "3:4", "16:9",
  "9:16", "9:20", "2:3", "3:2", "21:9"];

const FILL_CSS = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  gray: "#808080",
};

function getWidget(node, name) {
  return node?.widgets?.find((w) => w && w.name === name);
}

function wval(node, name, def) {
  const w = getWidget(node, name);
  return w && w.value !== undefined && w.value !== null ? w.value : def;
}

/** Прямая запись значения виджета. Программное `w.value=` НЕ стреляет
 *  событиями — на этом держатся drag и синки (см. SPECIFICATION §8.1). */
function setW(node, name, value) {
  const w = getWidget(node, name);
  if (w && w.value !== value) w.value = value;
  return w;
}

function num(node, name, def) {
  const v = Number(wval(node, name, def));
  return Number.isFinite(v) ? v : def;
}

function intVal(node, name, def) {
  return Math.trunc(num(node, name, def));
}

/** Найти URL картинки: своя output → upstream LoadImage → node.imgs. */
function getImageUrl(node, depth = 0) {
  if (!node || depth > 5) return null;
  try {
    const comfyClass = String(node.comfyClass || node.type || "").toLowerCase();
    if (comfyClass.includes("load") && typeof api !== "undefined") {
      const w = ["image", "image_path", "file_path"]
        .map((n) => getWidget(node, n)).find(Boolean);
      if (w && w.value) {
        let filename = "", subfolder = "";
        const val = w.value;
        if (typeof val === "string") {
          filename = val.trim().replace(/^"|"$/g, "");
          if (filename.includes("/") || filename.includes("\\")) {
            const parts = filename.split(/[/\\]/);
            filename = parts.pop();
            subfolder = parts.join("/");
          }
        } else if (typeof val === "object") {
          filename = val.filename || "";
          subfolder = val.subfolder || "";
        }
        if (filename) {
          return viewUrl(
            `filename=${encodeURIComponent(filename)}&type=input` +
            `&subfolder=${encodeURIComponent(subfolder)}`);
        }
      }
    }

    const input = (node.inputs || []).find(
      (i) => i && (i.name === "image_in" || i.name === "image") && i.link);
    if (input && typeof app !== "undefined" && app.graph?.links) {
      // graph.links — Map (проверено по фронтенду: `links:new Map`,
      // статический доступ links[id] всегда undefined → превью не находило
      // источник и показывало «No image» даже при подключённом LoadImage)
      const links = app.graph.links;
      const link = (typeof links.get === "function")
        ? links.get(input.link)
        : links[input.link];
      const origin = link ? app.graph.getNodeById(link.origin_id) : null;
      if (origin) {
        const url = getImageUrl(origin, depth + 1);
        if (url) return url;
      }
    }

    const out = typeof api !== "undefined" && app?.node_outputs
      ? app.node_outputs[node.id] : null;
    if (out) {
      for (const key of Object.keys(out)) {
        const slot = out[key];
        if (slot && slot.images && slot.images.length) {
          const img = slot.images[0];
          return viewUrl(
            `filename=${encodeURIComponent(img.filename)}` +
            `&type=${encodeURIComponent(img.type || "output")}` +
            `&subfolder=${encodeURIComponent(img.subfolder || "")}`);
        }
      }
    }

    if (node.imgs && node.imgs.length && node.imgs[0]?.src) return node.imgs[0].src;
  } catch (_) { /* картинки ещё нет — рисуем заглушку */ }
  return null;
}

function ensureImage(node, url) {
  if (!url) { node._deggUrl = null; node._deggImg = null; return null; }
  if (node._deggUrl === url && node._deggImg) return node._deggImg;
  const img = new Image();
  node._deggUrl = url;
  node._deggImg = img;
  img.onload = () => { try { node.setDirtyCanvas(true); } catch (_) {} };
  img.onerror = () => { try { node.setDirtyCanvas(true); } catch (_) {} };
  img.src = url;
  return img;
}

function checkerPattern(ctx) {
  try {
    if (ctx.__deggChecker) return ctx.__deggChecker;
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = 16; c.height = 16;
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#9a9a9a";
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = "#5a5a5a";
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    ctx.__deggChecker = ctx.createPattern(c, "repeat");
    return ctx.__deggChecker;
  } catch (_) { return null; }
}

function fillStyle(ctx, fill) {
  if (fill === "transparent") {
    return checkerPattern(ctx) || "rgba(128,128,128,0.45)";
  }
  return FILL_CSS[fill] || "#000000";
}

// ── Математика (точный паритет с python, SPECIFICATION §5) ─────────────────

/** OREX дословно: "/"→":", "a:b"→a/b, число→число, пустое→1. */
function parseRatio(r) {
  if (!r) return 1;
  if (typeof r === "number") return r;
  const s = String(r).replace(/\//g, ":"), p = s.split(":");
  if (p.length === 2) {
    const n1 = parseFloat(p[0]), n2 = parseFloat(p[1]);
    return n2 !== 0 ? (n1 / n2 || 1) : 1;
  }
  return parseFloat(s) || 1;
}

function ratioFrom(ar, selRatio) {
  if (!ar || ar === "Custom" || ar === "Free (Source)") return selRatio || 1;
  return parseRatio(ar);
}

/** Банковское округление — повторяет python `round()` один в один. */
function pyRound(v) {
  if (!Number.isFinite(v)) return 0;
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

/** roundMult(1000, 16) === 992 — как python `max(mult, round(v/mult)*mult)`. */
function roundMult(v, m) {
  const mult = Math.max(1, Math.trunc(m || 16));
  return Math.max(mult, pyRound(v / mult) * mult);
}

/** MP-цель: площадь mp·10⁶ с сохранением пропорций, округление до кратности. */
function mpTargets(ratio, mult, mp) {
  const area = mp * 1000000.0;
  const r = ratio > 0 ? ratio : 1;
  const tw = Math.sqrt(area * r);
  const th = Math.sqrt(area / r);
  return [roundMult(tw, mult), roundMult(th, mult)];
}

/** Точный python-эквивалент percent_rect (SPECIFICATION §3.3). */
function percentRectFromMargins(srcW, srcH, l, r, t, b) {
  const W = Math.trunc(srcW) || 1, H = Math.trunc(srcH) || 1;
  const left0 = Math.trunc((Number(l) || 0) / 100 * W);
  const rightPx = Math.trunc((Number(r) || 0) / 100 * W);
  const top0 = Math.trunc((Number(t) || 0) / 100 * H);
  const bottomPx = Math.trunc((Number(b) || 0) / 100 * H);

  let left = Math.max(0, Math.min(W - 1, left0));
  let right = Math.max(left + 1, W - rightPx);
  let top = Math.max(0, Math.min(H - 1, top0));
  let bottom = Math.max(top + 1, H - bottomPx);
  right = Math.min(right, W);
  bottom = Math.min(bottom, H);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function opOf(node) {
  return String(wval(node, "operation", "Crop"));
}

function isPercent(node) {
  return CROP_FIELDS.some((n) => num(node, n, 0) > 0);
}

function srcSize(node) {
  const img = node?._deggImg;
  if (!img || !img.naturalWidth || !img.naturalHeight) return null;
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/** Выделение в координатах источника (SPECIFICATION §6). Нужен готовый `_deggImg`. */
function getSel(node) {
  const src = srcSize(node);
  if (!src) return null;
  const pct = isPercent(node);
  if (pct) {
    return percentRectFromMargins(src.w, src.h,
      num(node, "crop_left", 0), num(node, "crop_right", 0),
      num(node, "crop_top", 0), num(node, "crop_bottom", 0));
  }
  if (opOf(node) === "Expand") {
    // x/y — позиция вставки, не кроп: выделение = весь источник
    return { x: 0, y: 0, w: src.w, h: src.h };
  }
  // Crop без процентов — окно; БЕЗ клампа, может выходить за источник
  return {
    x: Math.trunc(num(node, "x", 0)),
    y: Math.trunc(num(node, "y", 0)),
    w: Math.max(1, Math.trunc(num(node, "width", 512))),
    h: Math.max(1, Math.trunc(num(node, "height", 512))),
  };
}

/** Точный результат python (рисуется в бейдже). SPECIFICATION §5. */
function pythonTarget(node) {
  const mult = Math.max(1, intVal(node, "multiplicity", 16));
  const mp = num(node, "resolution_mp", 0);
  const w = num(node, "width", 512), h = num(node, "height", 512);
  const pct = isPercent(node);
  const need = pct || mp > 0;
  if (!need) return [Math.max(1, Math.trunc(w)), Math.max(1, Math.trunc(h))];

  let canvasW, canvasH;
  if (opOf(node) === "Expand") {
    canvasW = Math.max(1, Math.trunc(w));
    canvasH = Math.max(1, Math.trunc(h));
  } else {
    const rect = getSel(node);
    if (!rect) return [Math.max(1, Math.trunc(w)), Math.max(1, Math.trunc(h))];
    canvasW = Math.max(1, rect.w);
    canvasH = Math.max(1, rect.h);
  }
  if (mp > 0) return mpTargets(canvasW / canvasH, mult, mp);
  return [roundMult(w, mult), roundMult(h, mult)];
}

// ── Раскладка ──────────────────────────────────────────────────────────────

/**
 * Раскладка режима Crop: вписываем ИСТОЧНИК в рамку предпросмотра,
 * окно (winX,winY,winW,winH) — в координатах источника.
 */
function layoutCrop(box, srcW, srcH, winX, winY, winW, winH) {
  const scale = Math.min(box.w / srcW, box.h / srcH) || 0;
  const imgW = srcW * scale, imgH = srcH * scale;
  const imgX = box.x + (box.w - imgW) / 2;
  const imgY = box.y + (box.h - imgH) / 2;
  return {
    scale,
    img: { x: imgX, y: imgY, w: imgW, h: imgH },
    win: {
      x: imgX + winX * scale,
      y: imgY + winY * scale,
      w: winW * scale,
      h: winH * scale,
    },
  };
}

/**
 * Раскладка режима Expand: вписываем ЦЕЛЕВОЙ ХОЛСТ в рамку предпросмотра
 * (fit-to-target), источник кладём в точку (offX,offY) холста.
 */
function layoutExpand(box, srcW, srcH, offX, offY, outW, outH) {
  const scale = Math.min(box.w / outW, box.h / outH) || 0;
  const bw = outW * scale, bh = outH * scale;
  const bx = box.x + (box.w - bw) / 2;
  const by = box.y + (box.h - bh) / 2;
  return {
    scale,
    out: { x: bx, y: by, w: bw, h: bh },
    img: { x: bx + offX * scale, y: by + offY * scale, w: srcW * scale, h: srcH * scale },
  };
}

/** previewArea — нормализованный бокс {x,y,width,height,scale} для hit-testing.
 *  Именно width/height: с w/h границы давали NaN и проверка выхода за
 *  предпросмотр молча не срабатывала (найдено живым замером). */
function areaOf(rect, scale) {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale };
}

/**
 * Полная раскладка ноды → `node._deggLayout` (нужна для hit-testing).
 * Crop:   content = win;      origin = позиция источника в предпросмотре.
 * Expand: content = область вставки; origin подобран так, чтобы content/scale
 *         давал координаты выделения в пикселях источника.
 */
function computeLayout(box, node) {
  const src = srcSize(node);
  if (!src) return null;
  const sel = getSel(node);
  if (!sel) return null;
  const pct = isPercent(node);
  const op = opOf(node);

  if (op === "Expand") {
    const px = Math.trunc(num(node, "x", 0));
    const py = Math.trunc(num(node, "y", 0));
    const outW = Math.max(1, Math.trunc(num(node, "width", 512)));
    const outH = Math.max(1, Math.trunc(num(node, "height", 512)));
    const off = pct ? [px - sel.x, py - sel.y] : [px, py];
    const L = layoutExpand(box, src.w, src.h, off[0], off[1], outW, outH);
    const selW = pct ? sel.w : src.w;
    const selH = pct ? sel.h : src.h;
    const content = {
      x: L.out.x + px * L.scale,
      y: L.out.y + py * L.scale,
      w: selW * L.scale,
      h: selH * L.scale,
    };
    return {
      mode: "expand", percent: pct, scale: L.scale,
      srcW: src.w, srcH: src.h, box,
      out: L.out, img: L.img, win: null, content, sel,
      origin: { x: content.x - sel.x * L.scale, y: content.y - sel.y * L.scale },
      previewArea: areaOf(L.out, L.scale),
    };
  }

  const L = layoutCrop(box, src.w, src.h, sel.x, sel.y, sel.w, sel.h);
  return {
    mode: "crop", percent: pct, scale: L.scale,
    srcW: src.w, srcH: src.h, box,
    out: null, img: L.img, win: L.win, content: L.win, sel,
    origin: { x: L.img.x, y: L.img.y },
    previewArea: areaOf(L.img, L.scale),
  };
}

// ── Рисование ──────────────────────────────────────────────────────────────

function strokeRect(ctx, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
  ctx.restore();
}

function drawCross(ctx, r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.save();
  ctx.strokeStyle = "rgba(170,255,0,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
  ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
  ctx.stroke();
  ctx.restore();
}

/** Бейдж размера выхода. Ширина подложки из text.length — `measureText`
 *  ЗАПРЕЩЁН (в смоук-заглушке ctx его нет). */
function drawBadge(ctx, node, r) {
  const tgt = pythonTarget(node);
  const text = `${tgt[0]} × ${tgt[1]} px`;
  const cx = r.x + r.w / 2;
  const by = r.y + 2;
  const len = text.length;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.65)";
  ctx.fillRect(cx - len * 4 - 4, by, len * 8 + 8, 16);
  ctx.font = "bold 14px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "black";
  ctx.shadowBlur = 4;
  ctx.fillStyle = "#aaff00";
  ctx.fillText(text, cx, by + 12);
  ctx.restore();
}

/** Процентные метки вокруг выделения (OREX): x/srcW, (src−x−w)/srcW, … */
function drawPercentMarks(ctx, L, r) {
  const srcW = L.srcW || 1, srcH = L.srcH || 1;
  const sel = L.sel || { x: 0, y: 0, w: srcW, h: srcH };
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const pct = (v) => `${Math.round(v)}%`;
  ctx.save();
  ctx.font = "bold 12px Arial";
  ctx.fillStyle = "#00aaff";
  ctx.shadowColor = "black";
  ctx.shadowBlur = 3;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.fillText(pct(sel.x / srcW * 100), r.x - 5, cy);
  ctx.textAlign = "left";
  ctx.fillText(pct((srcW - sel.x - sel.w) / srcW * 100), r.x + r.w + 5, cy);
  ctx.textAlign = "center";
  ctx.fillText(pct(sel.y / srcH * 100), cx, r.y - 10);
  ctx.fillText(pct((srcH - sel.y - sel.h) / srcH * 100), cx, r.y + r.h + 15);
  ctx.restore();
}

/**
 * Рисует предпросмотр.
 *
 * Фронтенд зовёт `widget.draw(ctx, node, width, y, NODE_WIDGET_HEIGHT, showText)`
 * в КООРДИНАТАХ НОДЫ (проверено по drawWidgets: `s.draw(e,this,l,i,a,t)`,
 * где `i = s.y`). Поэтому `y` обязателен, а 5-й аргумент (постоянные 20px)
 * игнорируется — высоту задаёт computeSize().
 */
function drawPreview(ctx, node, width, y) {
  if (!ctx || typeof ctx.fillRect !== "function") return;
  if (node) node._deggLayout = null;

  const w = (typeof width === "number" && width > 1) ? width
    : Math.max(60, (node && node.size ? node.size[0] : 200) - MARGIN * 2);
  const y0 = (typeof y === "number" && y > 0) ? y : 0;
  const box = {
    x: MARGIN, y: y0 + MARGIN,
    w: Math.max(20, w - MARGIN * 2),
    h: Math.max(20, PREVIEW_H - MARGIN * 2),
  };

  ctx.save();
  ctx.fillStyle = "#161616";
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();

  const img = ensureImage(node, getImageUrl(node));
  const ready = !!(img && img.complete && img.naturalWidth > 0);
  if (!ready) {
    ctx.fillStyle = "#666666";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "12px sans-serif";
    ctx.fillText("No image — подключите IMAGE", box.x + box.w / 2, box.y + box.h / 2);
    ctx.restore();
    return;
  }

  const L = computeLayout(box, node);
  if (!L) { ctx.restore(); return; }
  node._deggLayout = L;
  node.previewArea = L.previewArea;
  const fill = String(wval(node, "fill_color", "black"));

  if (L.mode === "expand") {
    ctx.fillStyle = fillStyle(ctx, fill);
    ctx.fillRect(L.out.x, L.out.y, L.out.w, L.out.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(L.out.x, L.out.y, L.out.w, L.out.h);
    ctx.clip();
    // Источник со сдвигом off и клипом по out — повторяет python-paste (§3.2)
    ctx.drawImage(img, L.img.x, L.img.y, L.img.w, L.img.h);
    strokeRect(ctx, L.content, "rgba(230,230,255,0.95)");
    drawCross(ctx, L.content);
    drawBadge(ctx, node, L.content);
    if (L.percent) drawPercentMarks(ctx, L, L.content);
    ctx.restore();
    ctx.restore();
    strokeRect(ctx, L.out, "rgba(230,230,230,0.95)");
    return;
  }

  ctx.fillStyle = fillStyle(ctx, fill);
  ctx.fillRect(L.win.x, L.win.y, L.win.w, L.win.h);
  ctx.drawImage(img, L.img.x, L.img.y, L.img.w, L.img.h);
  // затемнение всего, что вне окна вырезки
  ctx.fillStyle = "rgba(0,0,0,0.40)";
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.rect(L.win.x, L.win.y, L.win.w, L.win.h);
  ctx.fill("evenodd");
  strokeRect(ctx, L.img, "rgba(180,180,180,0.90)");
  strokeRect(ctx, L.win, "rgba(230,230,230,0.95)");
  ctx.restore();
  strokeRect(ctx, L.win, "rgba(230,230,230,0.95)");
  drawCross(ctx, L.win);
  drawBadge(ctx, node, L.win);
  if (L.percent) drawPercentMarks(ctx, L, L.win);
}

/** Просто пометить канвас грязным (картинку не перезагружаем). */
function invalidate(node) {
  try { node.setDirtyCanvas(true, true); } catch (_) {}
}

/** Сбросить кэш картинки + перерисовать (смена провода / onExecuted). */
function refreshImage(node) {
  node._deggUrl = null;
  invalidate(node);
}

function fitNode(node) {
  // нода считает размер ДО onNodeCreated — пересчитываем сами, иначе
  // предпросмотр (200px) обрезается: узел остаётся ~198px вместо ~402px.
  // Читаем строго из computeSize() (фиксированные константы, не scrollHeight)
  // — поэтому обратного роста, как в «бесконечной ноде», не бывает.
  try {
    if (!node || typeof node.computeSize !== "function" || !node.size) return;
    const cs = node.computeSize([node.size[0], node.size[1]]);
    if (!Array.isArray(cs)) return;
    // ширина остаётся как у пользователя, высота — по computeSize (см. OREX)
    if (Math.abs(cs[1] - node.size[1]) > 0.5) {
      node.setSize([node.size[0], cs[1]]);
      node.setDirtyCanvas?.(true, true);
    }
  } catch (_) {}
}

// ── Синхронизация виджетов (SPECIFICATION §8) ──────────────────────────────

const setIf = (w, v) => { if (w && w.value !== v) w.value = v; };

/** 4 поля процентов из rect в координатах источника (округление OREX). */
function writeMargins(node, srcW, srcH, rect) {
  if (!srcW || !srcH || !rect) return;
  const put = (name, v) => {
    const w = getWidget(node, name);
    if (w) w.value = Math.round(v * 100) / 100;
  };
  put("crop_left", rect.x / srcW * 100);
  put("crop_right", (srcW - (rect.x + rect.w)) / srcW * 100);
  put("crop_top", rect.y / srcH * 100);
  put("crop_bottom", (srcH - (rect.y + rect.h)) / srcH * 100);
}

function syncPresets(node) {
  const ar = getWidget(node, "aspect_ratio");
  const presets = getWidget(node, "Ratio Presets");
  if (!ar || !presets) return;
  const values = (presets.options && Array.isArray(presets.options.values))
    ? presets.options.values : PRESETS;
  setIf(presets, values.includes(ar.value) ? ar.value : "Custom");
}

/** Блок aspect из OREX `syncWidgetsFromProperties` (дословно) + пропуск
 *  «Free (Source)» при матчинге. */
function syncAspectDisplay(node, rect) {
  if (!rect) rect = getSel(node);
  if (!rect) return;
  const arW = getWidget(node, "aspect_ratio");
  if (!arW) return;
  const lockW = getWidget(node, "ratio_lock");
  const presetW = getWidget(node, "Ratio Presets");
  const curW = rect.w, curH = rect.h;
  const currentRatio = curH ? curW / curH : 1;

  let matchedPreset = null;
  if (presetW) {
    const values = (presetW.options && Array.isArray(presetW.options.values))
      ? presetW.options.values : PRESETS;
    for (const preset of values) {
      if (preset === "Custom" || preset === "Free (Source)") continue;
      if (Math.abs(currentRatio - parseRatio(preset)) < 0.01) {
        matchedPreset = preset;
        break;
      }
    }
  }

  if (!lockW || !lockW.value) {
    if (matchedPreset) {
      setIf(arW, matchedPreset);
      setIf(presetW, matchedPreset);
    } else {
      const matchesCurrentAR = Math.abs(currentRatio - parseRatio(arW.value)) < 0.01;
      if (!matchesCurrentAR) setIf(arW, `${Math.round(curW)}:${Math.round(curH)}`);
      setIf(presetW, "Custom");
    }
  } else if (presetW) {
    const values = (presetW.options && Array.isArray(presetW.options.values))
      ? presetW.options.values : PRESETS;
    setIf(presetW, values.includes(arW.value) ? arW.value : "Custom");
  }
}

/** width/height пишутся ТОЛЬКО в Crop+pct; иначе — no-op (SPECIFICATION §8.1). */
function syncCropDisplays(node, rect) {
  if (!(opOf(node) === "Crop" && isPercent(node))) return;
  if (!rect) rect = getSel(node);
  if (!rect) return;
  const mult = Math.max(1, intVal(node, "multiplicity", 16));
  const mp = num(node, "resolution_mp", 0);
  let t;
  if (mp > 0) {
    t = mpTargets(rect.h ? rect.w / rect.h : 1, mult, mp);
  } else {
    t = [roundMult(rect.w, mult), roundMult(rect.h, mult)];
  }
  setW(node, "width", t[0]);
  setW(node, "height", t[1]);
}

function postRectSync(node, withAspect = true) {
  const rect = getSel(node);
  if (!rect) { invalidate(node); return; }
  const expandWindow = opOf(node) === "Expand" && !isPercent(node);
  if (withAspect && !expandWindow) syncAspectDisplay(node, rect);
  syncCropDisplays(node, rect);
  syncPresets(node);
  invalidate(node);
}

/** Применить пропорции: "Full" — весь источник, иначе contain-fit в источнике.
 *  SPECIFICATION §8.3. */
function applyAspectRatio(node, val) {
  if (!node || node._isSyncing) return;
  const src = srcSize(node);
  if (!src) return;
  const op = opOf(node);
  const pct = isPercent(node);
  const arW = getWidget(node, "aspect_ratio");
  const rect0 = getSel(node) || { x: 0, y: 0, w: src.w, h: src.h };

  node._isSyncing = true;
  try {
    let nw, nh;
    if (val === "Full") {
      if (arW) arW.value = `${src.w}:${src.h}`;
      nw = src.w; nh = src.h;
    } else {
      if (val && arW) arW.value = val;
      const ratio = ratioFrom(arW ? arW.value : "Custom", rect0.h ? rect0.w / rect0.h : 1);
      if (src.w / src.h > ratio) { nh = src.h; nw = nh * ratio; } else { nw = src.w; nh = nw / ratio; }
    }

    const centerMode = (val === "Full") || !(pct || op === "Crop");
    const cx = centerMode ? src.w / 2 : rect0.x + rect0.w / 2;
    const cy = centerMode ? src.h / 2 : rect0.y + rect0.h / 2;
    const nx = Math.max(0, Math.min(src.w - nw, cx - nw / 2));
    const ny = Math.max(0, Math.min(src.h - nh, cy - nh / 2));
    const r = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };

    if (op === "Expand") {
      // позиция вставки не трогается; Full → нулевые поля → остаётся window
      writeMargins(node, src.w, src.h, r);
    } else if (pct) {
      writeMargins(node, src.w, src.h, r);
      setW(node, "x", r.x);
      setW(node, "y", r.y);
    } else {
      setW(node, "x", r.x);
      setW(node, "y", r.y);
      setW(node, "width", r.w);
      setW(node, "height", r.h);
    }
  } finally {
    node._isSyncing = false;
  }

  // Пост-синк по СВЕЖЕМУ состоянию (не затираем ar после Full)
  const fresh = getSel(node);
  if (op === "Crop") {
    if (pct) syncCropDisplays(node, fresh);
    else syncAspectDisplay(node, fresh);
  } else if (pct) {
    syncAspectDisplay(node, fresh);
  } else {
    syncPresets(node);
  }
  invalidate(node);
}

function fullImage(node) {
  applyAspectRatio(node, "Full");
}

/** Center: Crop — сдвиг окна к центру (без клампа); pct — + поля; Expand — x/y. */
function centerSelection(node) {
  if (!node || node._isSyncing) return;
  const src = srcSize(node);
  if (!src) return;
  const rect = getSel(node);
  if (!rect) return;
  const op = opOf(node);
  const pct = isPercent(node);

  node._isSyncing = true;
  try {
    if (op === "Expand" && pct) {
      const contentW = rect.w;
      const w = Math.max(1, Math.trunc(num(node, "width", 512)));
      setW(node, "x", Math.round((w - contentW) / 2));
      // позиция вставки слева-сверху; поля не трогаем
    } else if (op === "Expand") {
      const contentW = src.w;
      const w = Math.max(1, Math.trunc(num(node, "width", 512)));
      const h = Math.max(1, Math.trunc(num(node, "height", 512)));
      setW(node, "x", Math.round((w - contentW) / 2));
      setW(node, "y", Math.round((h - src.h) / 2));
    } else {
      const nx = Math.round((src.w - rect.w) / 2);
      const ny = Math.round((src.h - rect.h) / 2);
      if (pct) {
        writeMargins(node, src.w, src.h, { x: nx, y: ny, w: rect.w, h: rect.h });
      }
      setW(node, "x", nx);
      setW(node, "y", ny);
    }
  } finally {
    node._isSyncing = false;
  }
  postRectSync(node);
}

// ── Мышь (SPECIFICATION §9) ────────────────────────────────────────────────

function setCursor(node, hit) {
  try {
    const canvas = app && app.canvas && app.canvas.canvas;
    if (!canvas || !canvas.style) return;
    const cursors = {
      move: "move", tl: "nwse-resize", br: "nwse-resize",
      tr: "nesw-resize", bl: "nesw-resize",
      t: "ns-resize", b: "ns-resize", l: "ew-resize", r: "ew-resize",
    };
    canvas.style.cursor = hit ? cursors[hit] : "default";
  } catch (_) {}
}

/** Хит-тест: вне previewArea → null; Expand-window — только "move". */
function getHitArea(node, p) {
  const L = node && node._deggLayout;
  const pa = node && node.previewArea;
  if (!L || !pa) return null;
  if (p[0] < pa.x || p[0] > pa.x + pa.width) return null;
  if (p[1] < pa.y || p[1] > pa.y + pa.height) return null;
  if (L.mode === "expand" && !L.percent) return "move";

  const scale = L.scale || 1;
  const ix = (p[0] - L.origin.x) / scale;
  const iy = (p[1] - L.origin.y) / scale;
  const sel = L.sel;
  const x1 = sel.x, y1 = sel.y, x2 = sel.x + sel.w, y2 = sel.y + sel.h;
  const th = HANDLE_PX / scale;
  const nearL = Math.abs(ix - x1) < th, nearR = Math.abs(ix - x2) < th;
  const nearT = Math.abs(iy - y1) < th, nearB = Math.abs(iy - y2) < th;
  const inX = ix > Math.min(x1, x2) && ix < Math.max(x1, x2);
  const inY = iy > Math.min(y1, y2) && iy < Math.max(y1, y2);
  if (nearL && nearT) return "tl";
  if (nearR && nearT) return "tr";
  if (nearL && nearB) return "bl";
  if (nearR && nearB) return "br";
  if (nearT && inX) return "t";
  if (nearB && inX) return "b";
  if (nearL && inY) return "l";
  if (nearR && inY) return "r";
  return (inX && inY) ? "move" : null;
}

/** Ресайз выделения — якоря/клампы дословно из OREX `_handleDrag`. */
function resizeSel(sel0, hit, dx, dy, srcW, srcH, lock, rat, clamp) {
  let x1 = sel0.x, y1 = sel0.y, x2 = sel0.x + sel0.w, y2 = sel0.y + sel0.h;
  const ratio = (lock && rat > 0) ? rat : 1;

  if (hit === "move") {
    const w = x2 - x1, h = y2 - y1;
    const loX = Math.min(0, srcW - w), hiX = Math.max(0, srcW - w);
    const loY = Math.min(0, srcH - h), hiY = Math.max(0, srcH - h);
    x1 = Math.max(loX, Math.min(hiX, x1 + dx));
    y1 = Math.max(loY, Math.min(hiY, y1 + dy));
    x2 = x1 + w; y2 = y1 + h;
  } else {
    if (hit.includes("l")) x1 += dx;
    if (hit.includes("r")) x2 += dx;
    if (hit.includes("t")) y1 += dy;
    if (hit.includes("b")) y2 += dy;

    if (lock) {
      const anchorX = hit.includes("l") ? sel0.x + sel0.w : sel0.x;
      const anchorY = hit.includes("t") ? sel0.y + sel0.h : sel0.y;
      let activeX = hit.includes("l") ? x1 : x2;
      let activeY = hit.includes("t") ? y1 : y2;
      let nw = Math.abs(activeX - anchorX);
      let nh = Math.abs(activeY - anchorY);

      if (hit === "l" || hit === "r") {
        nh = nw / ratio;
      } else if (hit === "t" || hit === "b") {
        nw = nh * ratio;
      } else if (nw / ratio > nh) {
        nh = nw / ratio;
      } else {
        nw = nh * ratio;
      }

      let targetX = anchorX + nw * (hit.includes("l") ? -1 : 1);
      let targetY = anchorY + nh * (hit.includes("t") ? -1 : 1);

      if (targetX < 0) { targetX = 0; nw = Math.abs(targetX - anchorX); nh = nw / ratio; }
      if (targetX > srcW) { targetX = srcW; nw = Math.abs(targetX - anchorX); nh = nw / ratio; }
      targetY = anchorY + nh * (hit.includes("t") ? -1 : 1);
      if (targetY < 0) { targetY = 0; nh = Math.abs(targetY - anchorY); nw = nh * ratio; }
      if (targetY > srcH) { targetY = srcH; nh = Math.abs(targetY - anchorY); nw = nh * ratio; }
      targetX = anchorX + nw * (hit.includes("l") ? -1 : 1);

      if (hit.includes("l")) x1 = targetX; else x2 = targetX;
      if (hit.includes("t")) y1 = targetY; else y2 = targetY;
    }

    if (clamp) {
      if (x1 < 0) x1 = 0;
      if (y1 < 0) y1 = 0;
      if (x2 > srcW) x2 = srcW;
      if (y2 > srcH) y2 = srcH;
    }

    if (x2 - x1 < MIN_SEL) { if (hit.includes("l")) x1 = x2 - MIN_SEL; else x2 = x1 + MIN_SEL; }
    if (y2 - y1 < MIN_SEL) { if (hit.includes("t")) y1 = y2 - MIN_SEL; else y2 = y1 + MIN_SEL; }
  }

  // округление углов: round(x) и round(x+16) отличаются ровно на 16
  const rx1 = Math.round(x1), ry1 = Math.round(y1);
  const rx2 = Math.round(x2), ry2 = Math.round(y2);
  return { x: rx1, y: ry1, w: rx2 - rx1, h: ry2 - ry1 };
}

function previewMouseDown(e, pos, node) {
  if (!node || !srcSize(node)) return false;
  const hit = getHitArea(node, pos);
  if (!hit) return false;
  const rect = getSel(node);
  if (!rect) return false;
  const lock = !!wval(node, "ratio_lock", false);
  node._deggDrag = {
    hit,
    startPos: [pos[0], pos[1]],
    sel0: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    x0: num(node, "x", 0),
    y0: num(node, "y", 0),
    scale: node._deggLayout ? node._deggLayout.scale : 1,
    mode: { op: opOf(node), percent: isPercent(node) },
    lock,
    rat: lock ? ratioFrom(wval(node, "aspect_ratio", "Custom"), rect.h ? rect.w / rect.h : 1) : 1,
  };
  return true;
}

function previewMouseMove(e, pos, node) {
  const drag = node && node._deggDrag;
  if (!drag) {
    const hit = getHitArea(node, pos);
    setCursor(node, hit);
    return !!hit;
  }
  if (e && e.buttons === 0) { previewMouseUp(e, node); return false; }

  const L = node._deggLayout;
  if (!L) return false;
  const scale = drag.scale || L.scale || 1;
  const dx = (pos[0] - drag.startPos[0]) / scale;
  const dy = (pos[1] - drag.startPos[1]) / scale;

  // Expand + move (Option A): поля не трогаем, x/y следуют за курсором
  if (drag.mode.op === "Expand" && drag.hit === "move") {
    setW(node, "x", Math.round(drag.x0 + dx));
    setW(node, "y", Math.round(drag.y0 + dy));
    invalidate(node);
    return true;
  }

  const r = resizeSel(drag.sel0, drag.hit, dx, dy, L.srcW, L.srcH, drag.lock, drag.rat, true);
  if (drag.mode.op === "Crop") {
    if (drag.mode.percent) {
      writeMargins(node, L.srcW, L.srcH, r);
      setW(node, "x", r.x);
      setW(node, "y", r.y);
    } else {
      setW(node, "x", r.x);
      setW(node, "y", r.y);
      setW(node, "width", r.w);
      setW(node, "height", r.h);
    }
  } else {
    // Expand+pct: захваченный край следует за курсором, правый край контента фиксирован
    writeMargins(node, L.srcW, L.srcH, r);
    setW(node, "x", Math.round(drag.x0 + (r.x - drag.sel0.x)));
    setW(node, "y", Math.round(drag.y0 + (r.y - drag.sel0.y)));
  }
  invalidate(node);
  return true;
}

function previewMouseUp(e, node) {
  if (node && node._deggDrag) {
    node._deggDrag = null;
    setCursor(node, null);
    postRectSync(node);
    return true;
  }
  return false;
}

function onPreviewMouse(e, pos, node) {
  if (!e || !node) return false;
  const type = String(e.type || "");
  try {
    if (type === "mousedown" || type === "pointerdown") return previewMouseDown(e, pos, node);
    if (type === "mousemove" || type === "pointermove") return previewMouseMove(e, pos, node);
    if (type === "mouseup" || type === "pointerup") return previewMouseUp(e, node);
  } catch (err) { console.warn("Degg_Crop:", err); }
  return false;
}

// ── Обработка правок виджетов (SPECIFICATION §8.4) ─────────────────────────

function marginsRect(node, overrides) {
  const src = srcSize(node);
  if (!src) return null;
  const get = (name) => (name in overrides ? overrides[name] : num(node, name, 0));
  return percentRectFromMargins(src.w, src.h,
    get("crop_left"), get("crop_right"), get("crop_top"), get("crop_bottom"));
}

function handleWidgetChanged(node, name, val, old) {
  if (!node || node._isSyncing) return;
  // Фронтенд зовёт нас ПОСЛЕ записи нового значения; в тестах/скриптах вызов
  // может прийти раньше — синхронизируем виджет с val, чтобы не читать старое.
  const changedW = getWidget(node, name);
  if (changedW && val !== undefined && changedW.value !== val) changedW.value = val;
  const src = srcSize(node);
  const ready = !!src;
  const op = opOf(node);
  const pct = isPercent(node);

  if (CROP_FIELDS.includes(name)) {
    if (!ready) { invalidate(node); return; }
    const before = marginsRect(node, { [name]: Number(old) || 0 });
    let after = marginsRect(node, { [name]: Number(val) || 0 });
    if (!after) { invalidate(node); return; }
    const lockW = getWidget(node, "ratio_lock");
    if (lockW && lockW.value) {
      const rat = ratioFrom(wval(node, "aspect_ratio", "Custom"),
        after.h ? after.w / after.h : 1);
      if (name === "crop_left" || name === "crop_right") {
        after = { x: after.x, y: after.y, w: after.w,
          h: Math.max(1, pyRound(after.w / rat)) };
      } else {
        after = { x: after.x, y: after.y,
          w: Math.max(1, pyRound(after.h * rat)), h: after.h };
      }
      writeMargins(node, src.w, src.h, after);
    }
    if (op === "Crop") {
      setW(node, "x", after.x);
      setW(node, "y", after.y);
      syncAspectDisplay(node, after);
      syncCropDisplays(node, after);
      syncPresets(node);
    } else {
      // Expand: сдвигаем позицию вставки на Δ(after − before) — без прыжков
      const ddx = before ? after.x - before.x : 0;
      const ddy = before ? after.y - before.y : 0;
      if (ddx || ddy) {
        setW(node, "x", Math.round(num(node, "x", 0) + ddx));
        setW(node, "y", Math.round(num(node, "y", 0) + ddy));
      }
      syncAspectDisplay(node, after);
    }
    invalidate(node);
    return;
  }

  if (name === "width" || name === "height") {
    const mult = Math.max(1, intVal(node, "multiplicity", 16));
    let vw = num(node, "width", 512), vh = num(node, "height", 512);
    const lockW = getWidget(node, "ratio_lock");
    if (lockW && lockW.value) {
      const sel = ready ? getSel(node) : null;
      const rat = ratioFrom(wval(node, "aspect_ratio", "Custom"),
        sel && sel.h ? sel.w / sel.h : 1);
      if (name === "width") vh = vw / rat; else vw = vh * rat;
    }
    const outW = roundMult(vw, mult), outH = roundMult(vh, mult);
    setW(node, "width", outW);
    setW(node, "height", outH);
    setW(node, "aspect_ratio", `${Math.round(outW)}:${Math.round(outH)}`);
    // syncAspectDisplay после присвоения ar НЕ вызывать — затрёт ar (Crop+pct)
    syncPresets(node);
    invalidate(node);
    return;
  }

  if (name === "ratio_lock") {
    if (val) {
      const sel = ready ? getSel(node) : null;
      if (sel) setW(node, "aspect_ratio", `${Math.round(sel.w)}:${Math.round(sel.h)}`);
      setW(node, "Ratio Presets", "Custom");
    }
    invalidate(node);
    return;
  }

  if (name === "aspect_ratio") {
    syncPresets(node);
    applyAspectRatio(node, val);
    return;
  }

  if (name === "x" || name === "y") {
    // Expand: x/y — позиция вставки (достаточно перерисовки); Crop-window — aspect
    if (op === "Crop" && !pct) syncAspectDisplay(node, getSel(node));
    invalidate(node);
    return;
  }

  if (name === "resolution_mp" || name === "multiplicity") {
    if (op === "Crop" && pct) syncCropDisplays(node);
    invalidate(node);
    return;
  }

  // operation / fill_color / upscale_method / прочее — перерисовка
  invalidate(node);
}

// ── Виджеты ────────────────────────────────────────────────────────────────

function addButton(node, label, cb) {
  if (getWidget(node, label)) return null;
  const w = node.addWidget("button", label, null, cb, { serialize: false });
  if (w) {
    w.serialize = false;
    w.options = w.options || {};
    w.options.serialize = false;
  }
  return w;
}

function setupJsWidgets(node) {
  if (!node || typeof node.addWidget !== "function") return;
  if (getWidget(node, "Ratio Presets")) return;   // идемпотентно

  const presets = node.addWidget("combo", "Ratio Presets", "Custom",
    (v) => onPresetPicked(node, v), { values: PRESETS.slice(), serialize: false });
  if (presets) {
    presets.serialize = false;
    presets.options = presets.options || {};
    presets.options.serialize = false;
    presets.options.values = presets.options.values || PRESETS.slice();
    const widgets = node.widgets || [];
    const idx = widgets.indexOf(presets);
    if (idx !== -1) widgets.splice(idx, 1);
    const arIdx = widgets.findIndex((w) => w && w.name === "aspect_ratio");
    widgets.splice(arIdx === -1 ? widgets.length : arIdx + 1, 0, presets);
  }

  addButton(node, "Full Image", () => fullImage(node));
  addButton(node, "Center", () => centerSelection(node));
  addButton(node, "Maximize", () => applyAspectRatio(node));
  addButton(node, "Load Image", () => pickAndLoad(node));
}

function onPresetPicked(node, val) {
  if (val === "Custom") return;
  if (val === "Free (Source)") { fullImage(node); return; }
  const ar = getWidget(node, "aspect_ratio");
  if (ar && ar.value !== val) ar.value = val;
  applyAspectRatio(node, val);
}

function addPreviewWidget(node) {
  if (!node || !node.addCustomWidget) return;
  if ((node.widgets || []).some((w) => w && w.name === "degg_crop_preview")) return;

  const widget = {
    type: "custom_canvas",
    name: "degg_crop_preview",
    // ctx — в координатах ноды: y обязателен, height (=NODE_WIDGET_HEIGHT,
    // всегда 20) игнорируется, высоту резервирует computeSize().
    draw(ctx, widgetNode, width, y) {
      drawPreview(ctx, widgetNode || node, width, y);
    },
    computeSize(width) {
      return [(typeof width === "number" && width > 1) ? width : 200, PREVIEW_H];
    },
    mouse(e, pos, graphNode) {
      return onPreviewMouse(e, pos, graphNode || node);
    },
    serialize: false,
  };
  widget.options = { serialize: false };
  node.addCustomWidget(widget);
}

// ── Загрузка картинки (SPECIFICATION §11) ──────────────────────────────────

function findUpstreamLoader(node, inputName) {
  try {
    const input = (node.inputs || []).find((i) => i && i.name === inputName && i.link);
    if (!input || !app?.graph) return null;
    const links = app.graph.links;
    const link = (links && typeof links.get === "function")
      ? links.get(input.link) : links ? links[input.link] : null;
    const origin = link ? app.graph.getNodeById(link.origin_id) : null;
    if (!origin) return null;
    const cls = String(origin.comfyClass || origin.type || "");
    return /load/i.test(cls) ? origin : null;
  } catch (_) { return null; }
}

function attachToLoader(loader, value) {
  const w = ["image", "image_path", "file_path"]
    .map((n) => getWidget(loader, n)).find(Boolean);
  if (!w) return;
  try {
    if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(value)) {
      w.options.values.push(value);
    }
    w.value = value;
    if (typeof w.callback === "function") w.callback(value, app?.canvas, loader, [0, 0], null);
    loader.onWidgetChanged?.("image", value, null, w);
  } catch (e) { console.warn("Degg_Crop:", e); }
}

function createLoader(node, value) {
  try {
    const LG = window.LiteGraph;
    if (!LG || typeof LG.createNode !== "function") return;
    const loader = LG.createNode("LoadImage");
    if (!loader) return;
    const w = getWidget(loader, "image");
    if (w) {
      if (w.options && Array.isArray(w.options.values) && !w.options.values.includes(value)) {
        w.options.values.push(value);
      }
      w.value = value;
    }
    const pos = node.pos || [0, 0];
    loader.pos = [pos[0] - 240, pos[1]];
    app?.graph?.add?.(loader);
    const idx = (node.inputs || []).findIndex((i) => i && i.name === "image");
    if (idx !== -1 && typeof loader.connect === "function") {
      try { loader.connect(0, node, idx); } catch (_) {}
    }
  } catch (e) { console.warn("Degg_Crop:", e); }
}

async function uploadAndAttach(node, file) {
  if (!api || typeof api.fetchApi !== "function") return;
  const form = new FormData();
  form.append("image", file);
  let res;
  try {
    res = await api.fetchApi("/upload/image", { method: "POST", body: form });
  } catch (e) { console.warn("Degg_Crop: upload failed", e); return; }
  if (!res || !res.ok) { console.warn("Degg_Crop: upload failed", res && res.status); return; }

  let data = {};
  try { data = await res.json(); } catch (_) {}
  const name = data.name || file.name;
  const sub = data.subfolder || "";
  const value = sub ? `${sub}/${name}` : name;

  const target = findUpstreamLoader(node, "image_in") || findUpstreamLoader(node, "image");
  if (target) attachToLoader(target, value);
  else createLoader(node, value);
  refreshImage(node);
}

/** Кнопка Load Image: выбрать файл → /upload/image → подставить в LoadImage. */
function pickAndLoad(node) {
  if (typeof document === "undefined") {
    console.warn("Degg_Crop: document недоступен — загрузка файла невозможна");
    return;
  }
  if (typeof window === "undefined" || !window.LiteGraph) {
    console.error("Degg_Crop: LiteGraph недоступен — загрузка файла невозможна");
    return;
  }
  if (!api || typeof api.fetchApi !== "function") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (file) uploadAndAttach(node, file);
  };
  input.click();
}

// ── Регистрация расширения ────────────────────────────────────────────────

app.registerExtension({
  name: "Degg.Crop",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const proto = nodeType.prototype;

    const origCreated = proto.onNodeCreated;
    proto.onNodeCreated = function () {
      const ret = origCreated?.apply(this, arguments);
      this._isSyncing = false;
      this._deggDrag = null;
      this._deggLayout = null;
      setupJsWidgets(this);
      addPreviewWidget(this);
      this.fullImage = () => fullImage(this);
      this.centerSelection = () => centerSelection(this);
      this.applyAspectRatio = (v) => applyAspectRatio(this, v);
      fitNode(this);
      return ret;
    };

    const origWidgetChanged = proto.onWidgetChanged;
    proto.onWidgetChanged = function () {
      const args = Array.prototype.slice.call(arguments);
      const ret = origWidgetChanged?.apply(this, args);
      try { handleWidgetChanged(this, args[0], args[1], args[2]); }
      catch (e) { console.warn("Degg_Crop:", e); }
      return ret;
    };

    const origExecuted = proto.onExecuted;
    proto.onExecuted = function () {
      const ret = origExecuted?.apply(this, arguments);
      refreshImage(this);
      return ret;
    };

    const origConfigure = proto.onConfigure;
    proto.onConfigure = function () {
      const ret = origConfigure?.apply(this, arguments);
      this._isSyncing = false;
      this._deggDrag = null;
      setupJsWidgets(this);   // JS-виджеты не сериализуются — восстанавливаем
      refreshImage(this);
      return ret;
    };

    const origConn = proto.onConnectionsChange;
    proto.onConnectionsChange = function () {
      const ret = origConn?.apply(this, arguments);
      refreshImage(this);
      return ret;
    };
  },

  loadedGraphNode(node) {
    if (!node || node.comfyClass !== NODE_CLASS) return;
    setupJsWidgets(node);
    fitNode(node);
    refreshImage(node);
  },
});

if (typeof window !== "undefined") {
  window.DeggCropPreview = {
    PRESETS, parseRatio, ratioFrom, pyRound, roundMult, mpTargets,
    percentRectFromMargins, getSel, pythonTarget, isPercent, opOf,
    layoutCrop, layoutExpand, computeLayout, fillStyle, getImageUrl, drawPreview,
    getHitArea, resizeSel, writeMargins, syncAspectDisplay, syncCropDisplays,
    syncPresets, postRectSync, applyAspectRatio, fullImage, centerSelection,
    handleWidgetChanged, getWidget, setW, FILL_CSS,
  };
}
