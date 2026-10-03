// Degg_Crop — интерактивная обрезка (Crop) и расширение холста (Expand/outpaint).
//
// Контракт фронтенда (проверено по исходникам ComfyUI, скил comfyui-frontend-sources):
//   • LGraphNode.drawWidgets() вызывает `widget.draw(ctx, node, width, y, H, lowQuality)`;
//   • LGraphCanvas.processWidgetClick()/onMouseMove() вызывают `widget.mouse(e, [x,y], node)`;
//   • computeSize() вызывается как `widget.computeSize(width)[1]`.
//   Фронтенд НЕ читает options.draw / options.mouse / options.computeSize — всё
//   должно лежать на самом виджете (верхний уровень объекта).
//
// Геометрия — ОДНО окно (x, y, width, height) в пикселях источника:
//   • окно внутри изображения → Crop (обрезка);
//   • окно выходит за границы   → Expand (аутпеинт, заливка fill_color).
// Окно двигается и мышью за пределы изображения, и точными пиксельными полями.

const EXT_NAME = "DeggCrop";
const PREVIEW_H = 160;
const PREVIEW_PAD = 8;
const GOLDEN_RATIO = 1.61803398875;
const HIT_SLOP = 8;

const RATIO_PRESETS = [
  "Custom",
  "Free (Source)",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
];

const FILL_PREVIEW = {
  transparent: "rgba(0,0,0,0)",
  black: "rgba(0,0,0,0.6)",
  white: "rgba(255,255,255,0.6)",
  gray: "rgba(128,128,128,0.6)",
};

// ── bootstrap (Nodes 2.0: только window.comfyAPI) ──────────────────────────
function pickApp() {
  try {
    if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
      return window.comfyAPI.app.app;
    }
    if (window.app) return window.app;
  } catch (e) {
    /* ignore */
  }
  return null;
}

function pickApi() {
  try {
    // window.comfyAPI.api — это ПРОСТРАНСТВО ИМЁН модуля ({api, ComfyApi, ...}),
    // сам клиент лежит в window.comfyAPI.api.api.
    if (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api) {
      return window.comfyAPI.api.api;
    }
    if (window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.apiURL) {
      return window.comfyAPI.api;
    }
    if (window.api) return window.api;
  } catch (e) {
    /* ignore */
  }
  return null;
}

const app = pickApp();
const api = pickApi();

// ── math (совпадает с python один-в-один) ─────────────────────────────────

/** Банковское округление python round() — половина к чётному. */
function pyRound(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function roundMult(v, mult) {
  const m = Math.max(1, Math.floor(mult || 1));
  return Math.max(m, pyRound(v / m) * m);
}

function parseRatio(r) {
  if (!r || r === "Custom" || r === "Free (Source)") return 1;
  const parts = String(r).split(/[:/]/);
  if (parts.length === 2) {
    const a = parseFloat(parts[0]);
    const b = parseFloat(parts[1]);
    if (a > 0 && b > 0) return a / b;
  }
  const v = parseFloat(r);
  return isNaN(v) ? 1 : v;
}

function num(v, fallback) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? fallback : n;
}

// ── виджеты ───────────────────────────────────────────────────────────────

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name) || null;
}

function setWidget(node, name, value) {
  const w = getWidget(node, name);
  if (w && w.value !== value) w.value = value;
}

/** Прямоугольник окна из пиксельных полей x/y/width/height. */
function syncPropsFromWidgets(node) {
  const xw = getWidget(node, "x");
  const yw = getWidget(node, "y");
  const ww = getWidget(node, "width");
  const hw = getWidget(node, "height");
  const x = Math.round(num(xw && xw.value, 0));
  const y = Math.round(num(yw && yw.value, 0));
  const w = Math.max(1, Math.round(num(ww && ww.value, 512)));
  const h = Math.max(1, Math.round(num(hw && hw.value, 512)));
  node._rect = { x, y, w, h };
  return node._rect;
}

/** Пиксельные поля из прямоугольника окна. */
function syncWidgetsFromProps(node) {
  const r = node._rect;
  if (!r) return;
  setWidget(node, "x", Math.round(r.x));
  setWidget(node, "y", Math.round(r.y));
  setWidget(node, "width", Math.max(1, Math.round(r.w)));
  setWidget(node, "height", Math.max(1, Math.round(r.h)));
}

/** Итоговые размеры выхода — как target_size() в python. */
function pythonTarget(node) {
  const r = node._rect || syncPropsFromWidgets(node);
  const mpW = getWidget(node, "megapixels");
  const multW = getWidget(node, "multiplicity");
  const mp = num(mpW && mpW.value, 0);
  const mult = Math.max(1, Math.floor(num(multW && multW.value, 8)));
  let tw, th;
  if (mp > 0 && r.w > 0 && r.h > 0) {
    const area = mp * 1024 * 1024;
    const ratio = r.w / r.h;
    tw = Math.sqrt(area * ratio);
    th = Math.sqrt(area / ratio);
  } else {
    tw = r.w;
    th = r.h;
  }
  return [roundMult(tw, mult), roundMult(th, mult)];
}

// ── раскладка предпросмотра ───────────────────────────────────────────────
// Показываем ОБЪЕДИНЕНИЕ изображения и окна, чтобы рамка, выдвинутая за
// пределы картинки (аутпеинт), всегда оставалась видимой.

function computeLayout(node, width) {
  const W = Math.max(60, num(width, 300));
  const p = PREVIEW_PAD;
  const iw = Math.max(1, node._imgW || 512);
  const ih = Math.max(1, node._imgH || 512);
  const r = node._rect || { x: 0, y: 0, w: iw, h: ih };

  const wx0 = Math.min(0, r.x);
  const wy0 = Math.min(0, r.y);
  const wx1 = Math.max(iw, r.x + r.w);
  const wy1 = Math.max(ih, r.y + r.h);
  const ww = Math.max(1, wx1 - wx0);
  const wh = Math.max(1, wy1 - wy0);

  const innerW = Math.max(10, W - 2 * p);
  const innerH = Math.max(10, PREVIEW_H - 2 * p);
  const scale = Math.min(innerW / ww, innerH / wh);

  const ox = p + (innerW - ww * scale) / 2 - wx0 * scale;
  const oy = p + (innerH - wh * scale) / 2 - wy0 * scale;

  const img = { x: ox, y: oy, w: iw * scale, h: ih * scale };
  const win = {
    x: ox + r.x * scale,
    y: oy + r.y * scale,
    w: Math.max(1, r.w * scale),
    h: Math.max(1, r.h * scale),
  };
  return { W, p, scale, ox, oy, img, win, rect: r };
}

/** Высота предпросмотра (фиксированная константа — без feedback loop). */
function computePreviewHeight(_node) {
  return PREVIEW_H;
}

function computeLayoutSize(node, minWidth, minHeight, maxWidth, maxHeight) {
  const lo = num(minWidth, 160);
  const hi = num(maxWidth, 100000);
  const w = Math.max(lo, Math.min(hi, num(node && node.size && node.size[0], 300)));
  return [w, PREVIEW_H];
}

// ── отрисовка ─────────────────────────────────────────────────────────────

function drawGridThirds(ctx, L) {
  const img = L.img;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i <= 2; i++) {
    const vx = img.x + (img.w * i) / 3;
    ctx.beginPath();
    ctx.moveTo(vx, img.y);
    ctx.lineTo(vx, img.y + img.h);
    ctx.stroke();
  }
  for (let i = 1; i <= 2; i++) {
    const vy = img.y + (img.h * i) / 3;
    ctx.beginPath();
    ctx.moveTo(img.x, vy);
    ctx.lineTo(img.x + img.w, vy);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,215,0,0.5)";
  const gx = img.x + img.w / GOLDEN_RATIO;
  const gy = img.y + img.h / GOLDEN_RATIO;
  ctx.beginPath();
  ctx.moveTo(gx, img.y);
  ctx.lineTo(gx, img.y + img.h);
  ctx.moveTo(img.x, gy);
  ctx.lineTo(img.x + img.w, gy);
  ctx.stroke();
  ctx.restore();
}

function drawPreview(ctx, node, width, y) {
  const L = computeLayout(node, width);
  const W = L.W;
  node._previewY = y;
  node._layout = L;

  ctx.save();
  ctx.translate(0, y);

  // фон
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(0, 0, W, PREVIEW_H);

  // изображение
  if (node._img && node._img.complete && node._img.naturalWidth > 0) {
    try {
      ctx.drawImage(node._img, L.img.x, L.img.y, L.img.w, L.img.h);
    } catch (e) {
      /* ignore */
    }
    drawGridThirds(ctx, L);
  } else {
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(L.img.x, L.img.y, L.img.w, L.img.h);
    ctx.fillStyle = "#888";
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No image", L.img.x + L.img.w / 2, L.img.y + L.img.h / 2);
  }

  const r = L.rect;
  const out = { x: L.win.x, y: L.win.y, w: L.win.w, h: L.win.h };

  // затемнение внутри изображения, но вне окна (dim_percent)
  const dimW = getWidget(node, "dim_percent");
  const dim = Math.max(0, Math.min(100, num(dimW && dimW.value, 40)));
  if (dim > 0) {
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0," + (dim / 100).toFixed(3) + ")";
    ctx.beginPath();
    ctx.rect(L.img.x, L.img.y, L.img.w, L.img.h);
    ctx.rect(out.x, out.y, out.w, out.h);
    ctx.fill("evenodd");
    ctx.restore();
  }

  // область аутпеинта (за окном, но вне изображения) — цветом заливки
  const fillW = getWidget(node, "fill_color");
  const fillName = (fillW && fillW.value) || "black";
  const outside = [];
  if (out.x < L.img.x) outside.push([out.x, out.y, L.img.x - out.x, out.h]);
  if (out.x + out.w > L.img.x + L.img.w) {
    const sx = L.img.x + L.img.w;
    outside.push([sx, out.y, out.x + out.w - sx, out.h]);
  }
  if (out.y < L.img.y) outside.push([out.x, out.y, out.w, L.img.y - out.y]);
  if (out.y + out.h > L.img.y + L.img.h) {
    const sy = L.img.y + L.img.h;
    outside.push([out.x, sy, out.w, out.y + out.h - sy]);
  }
  ctx.save();
  ctx.fillStyle = FILL_PREVIEW[fillName] || FILL_PREVIEW.black;
  for (const q of outside) ctx.fillRect(q[0], q[1], q[2], q[3]);
  ctx.restore();

  // рамка окна
  const imgRight = L.img.w / L.scale + 0.5;
  const imgBottom = L.img.h / L.scale + 0.5;
  const expanding =
    r.x < 0 || r.y < 0 || r.x + r.w > imgRight || r.y + r.h > imgBottom;
  const accent = expanding ? "#4fc3f7" : "#7cff5a";
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.strokeRect(out.x, out.y, out.w, out.h);

  // уголки (ручки resize)
  ctx.fillStyle = accent;
  const hs = 4;
  const corners = [
    [out.x, out.y],
    [out.x + out.w, out.y],
    [out.x, out.y + out.h],
    [out.x + out.w, out.y + out.h],
  ];
  for (const c of corners) ctx.fillRect(c[0] - hs, c[1] - hs, hs * 2, hs * 2);

  // бейдж целевого размера (как в python: MP + кратность)
  const tgt = pythonTarget(node);
  const label = tgt[0] + " x " + tgt[1];
  ctx.font = "11px monospace";
  ctx.textAlign = "left";
  const tw = label.length * 6.6 + 8;
  let by = out.y - 16;
  if (by < 2) by = out.y + out.h + 4;
  if (by + 14 > PREVIEW_H) by = Math.max(2, PREVIEW_H - 16);
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(out.x, by, tw, 14);
  ctx.fillStyle = accent;
  ctx.fillText(label, out.x + 4, by + 11);
  ctx.restore();

  ctx.restore();
}

// ── hit-testing и drag (9 зон) ────────────────────────────────────────────

function getHitArea(node, pos, y0) {
  const L = node._layout;
  if (!L) return null;
  const top = num(y0, num(node._previewY, 0));
  const mx = pos[0];
  const my = pos[1] - top;
  if (mx < 0 || my < 0 || mx > L.W || my > PREVIEW_H) return null;

  const o = L.win;
  const slop = HIT_SLOP;
  const nearL = Math.abs(mx - o.x) <= slop;
  const nearR = Math.abs(mx - (o.x + o.w)) <= slop;
  const nearT = Math.abs(my - o.y) <= slop;
  const nearB = Math.abs(my - (o.y + o.h)) <= slop;
  const inX = mx > o.x + slop && mx < o.x + o.w - slop;
  const inY = my > o.y + slop && my < o.y + o.h - slop;

  if (nearL && nearT) return "nw";
  if (nearR && nearT) return "ne";
  if (nearL && nearB) return "sw";
  if (nearR && nearB) return "se";
  if (nearT && (inX || (nearL && nearR))) return "n";
  if (nearB && (inX || (nearL && nearR))) return "s";
  if (nearL && (inY || (nearT && nearB))) return "w";
  if (nearR && (inY || (nearT && nearB))) return "e";
  if (mx > o.x && mx < o.x + o.w && my > o.y && my < o.y + o.h) return "move";
  return null;
}

const CURSORS = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  move: "move",
};

function applyDrag(node, mx, my) {
  const d = node._drag;
  if (!d) return;
  const L = node._layout;
  const scale = (L && L.scale) || 1;
  const dx = (mx - d.mx) / scale;
  const dy = (my - d.my) / scale;
  const r0 = d.rect0;
  let x = r0.x;
  let y = r0.y;
  let w = r0.w;
  let h = r0.h;
  const mode = d.mode;

  if (mode === "move") {
    // Без клампа: окно свободно уезжает за границы изображения (аутпеинт).
    x = r0.x + dx;
    y = r0.y + dy;
  } else {
    if (mode.indexOf("e") >= 0) w = r0.w + dx;
    if (mode.indexOf("s") >= 0) h = r0.h + dy;
    if (mode.indexOf("w") >= 0) {
      x = r0.x + dx;
      w = r0.w - dx;
    }
    if (mode.indexOf("n") >= 0) {
      y = r0.y + dy;
      h = r0.h - dy;
    }
    if (w < 1) {
      w = 1;
      if (mode.indexOf("w") >= 0) x = r0.x + r0.w - 1;
    }
    if (h < 1) {
      h = 1;
      if (mode.indexOf("n") >= 0) y = r0.y + r0.h - 1;
    }
    // ratio lock при изменении размера
    const lockW = getWidget(node, "ratio_lock");
    const arW = getWidget(node, "aspect_ratio");
    if (lockW && lockW.value && arW && arW.value && arW.value !== "Custom") {
      const ar = parseRatio(arW.value);
      if (ar > 0) {
        if (mode.indexOf("e") >= 0 || mode.indexOf("w") >= 0) {
          h = Math.max(1, w / ar);
          if (mode.indexOf("n") >= 0) y = r0.y + r0.h - h;
        } else {
          w = Math.max(1, h * ar);
          if (mode.indexOf("w") >= 0) x = r0.x + r0.w - w;
        }
      }
    }
  }

  node._rect = { x, y, w, h };
  syncWidgetsFromProps(node);
}

function onPreviewMouse(e, pos, node) {
  if (!node._rect) syncPropsFromWidgets(node);
  const type = e && e.type;
  const y0 = num(node._previewY, 0);

  if (type === "pointerdown" || type === "mousedown") {
    const area = getHitArea(node, pos, y0);
    if (!area) return false;
    node._drag = {
      mode: area,
      mx: pos[0],
      my: pos[1] - y0,
      rect0: { x: node._rect.x, y: node._rect.y, w: node._rect.w, h: node._rect.h },
    };
    return true;
  }

  if (type === "pointermove" || type === "mousemove") {
    if (!node._drag) return false;
    applyDrag(node, pos[0], pos[1] - y0);
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
    return true;
  }

  if (type === "pointerup" || type === "mouseup") {
    if (!node._drag) return false;
    applyDrag(node, pos[0], pos[1] - y0);
    node._drag = null;
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
    return true;
  }

  return false;
}

// ── изображение ───────────────────────────────────────────────────────────

function viewUrl(filename, type) {
  const name = String(filename || "").trim().replace(/^"|"$/g, "");
  if (!name) return null;
  let file = name;
  let sub = "";
  if (file.indexOf("/") >= 0 || file.indexOf("\\") >= 0) {
    const parts = file.split(/[/\\]/);
    file = parts.pop();
    sub = parts.join("/");
  }
  const q =
    "/view?filename=" +
    encodeURIComponent(file) +
    "&type=" +
    encodeURIComponent(type) +
    "&subfolder=" +
    encodeURIComponent(sub);
  if (api && typeof api.apiURL === "function") return api.apiURL(q);
  return q;
}

function isLoader(node) {
  const t = ((node && (node.type || node.comfyClass)) || "").toLowerCase();
  return t.indexOf("load") >= 0;
}

/** URL источника: провод `image` (приоритет) либо файл из папки input. */
function resolveImageUrl(node, depth) {
  depth = depth || 0;
  if (!node || depth > 5) return null;
  try {
    if (isLoader(node)) {
      const w =
        getWidget(node, "image") ||
        getWidget(node, "image_path") ||
        getWidget(node, "file") ||
        getWidget(node, "file_path");
      if (w && w.value) {
        const val = w.value;
        if (typeof val === "string") return viewUrl(val, "input");
        if (val && typeof val === "object" && val.filename) {
          return viewUrl(val.filename, val.type || "input");
        }
      }
    }
    const input = (node.inputs || []).find(
      (i) => i && (i.name === "image" || i.type === "IMAGE") && i.link != null
    );
    if (input && app && app.graph && app.graph.links) {
      const links = app.graph.links;
      const link =
        typeof links.get === "function" ? links.get(input.link) : links[input.link];
      if (link) {
        const origin = app.graph.getNodeById
          ? app.graph.getNodeById(link.origin_id)
          : (app.graph._nodes || []).find((n) => n.id === link.origin_id);
        if (origin) {
          const up = resolveImageUrl(origin, depth + 1);
          if (up) return up;
          if (origin.imgs && origin.imgs.length && origin.imgs[0] && origin.imgs[0].src) {
            return origin.imgs[0].src;
          }
        }
      }
    }
    if (node.imgs && node.imgs.length && node.imgs[0] && node.imgs[0].src) {
      return node.imgs[0].src;
    }
    const fileW = getWidget(node, "file");
    if (fileW && fileW.value) return viewUrl(fileW.value, "input");
  } catch (e) {
    console.error("[DeggCrop] resolveImageUrl:", e);
  }
  return null;
}

/** Ленивая загрузка источника. Вызывается из draw() — самолечение без таймеров. */
function ensureImage(node) {
  const url = resolveImageUrl(node);
  if (!url) {
    if (node._imgUrl !== null) {
      node._imgUrl = null;
      node._img = null;
    }
    return;
  }
  if (url === node._imgUrl && node._img) return;

  node._imgUrl = url;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    node._img = img;
    node._imgW = img.naturalWidth || node._imgW;
    node._imgH = img.naturalHeight || node._imgH;
    if (!node._rect) syncPropsFromWidgets(node);
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };
  img.onerror = () => {
    node._img = null;
    if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
  };
  img.src = url;
  node._img = img;
}

// ── виджет предпросмотра ──────────────────────────────────────────────────
// ВАЖНО: draw / mouse / computeSize — на ВЕРХНЕМ уровне объекта.
// Фронтенд вызывает `widget.draw(...)`, `widget.mouse(...)`, `widget.computeSize(...)`;
// поля внутри options.* он не читает (проверено по LGraphNode.drawWidgets
// и LGraphCanvas.processWidgetClick).

function makePreviewWidget(node) {
  return {
    type: "custom",
    name: "degg_crop_preview",
    serialize: false,
    options: { serialize: false, canvasOnly: true },
    computeSize(width) {
      const w = num(width, num(node && node.size && node.size[0], 300));
      return [Math.max(60, w), PREVIEW_H];
    },
    draw(ctx, widgetNode, width, y) {
      const n = widgetNode || node;
      ensureImage(n);
      if (!n._drag) syncPropsFromWidgets(n);
      drawPreview(ctx, n, width, y);
    },
    mouse(e, pos, widgetNode) {
      return onPreviewMouse(e, pos, widgetNode || node);
    },
  };
}

// ── кнопки Full / Center / Maximize ───────────────────────────────────────

function setRect(node, x, y, w, h) {
  node._rect = {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
  };
  syncWidgetsFromProps(node);
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

function fullImage(node) {
  const iw = node._imgW || 512;
  const ih = node._imgH || 512;
  setRect(node, 0, 0, iw, ih);
}

function centerSelection(node) {
  const iw = node._imgW || 512;
  const ih = node._imgH || 512;
  const r = node._rect || syncPropsFromWidgets(node);
  setRect(node, (iw - r.w) / 2, (ih - r.h) / 2, r.w, r.h);
}

function maximizeSelection(node) {
  const iw = node._imgW || 512;
  const ih = node._imgH || 512;
  const r = node._rect || syncPropsFromWidgets(node);
  const arW = getWidget(node, "aspect_ratio");
  const lockW = getWidget(node, "ratio_lock");
  let ar = r.w / r.h;
  if (lockW && lockW.value && arW && arW.value && arW.value !== "Custom") {
    ar = parseRatio(arW.value);
  }
  let w = iw;
  let h = w / ar;
  if (h > ih) {
    h = ih;
    w = h * ar;
  }
  setRect(node, (iw - w) / 2, (ih - h) / 2, w, h);
}

function addFullCenterMaxButtons(node) {
  const add = (name, label, cb) => {
    const existing = getWidget(node, name);
    if (existing) return existing;
    const w = {
      name,
      type: "button",
      value: null,
      options: { label, serialize: false },
      serialize: false,
    };
    w.callback = () => cb(node);
    if (typeof node.addCustomWidget === "function") node.addCustomWidget(w);
    else (node.widgets || []).push(w);
    return w;
  };
  add("fit_full", "Full image", fullImage);
  add("fit_center", "Center", centerSelection);
  add("fit_max", "Maximize", maximizeSelection);
}

// ── Ratio Presets (combo) ─────────────────────────────────────────────────

function applyAspectRatio(node, arValue) {
  const iw = node._imgW || 512;
  const ih = node._imgH || 512;
  const ar = parseRatio(arValue);
  if (!(ar > 0)) return;
  let w = iw;
  let h = w / ar;
  if (h > ih) {
    h = ih;
    w = h * ar;
  }
  setRect(node, (iw - w) / 2, (ih - h) / 2, w, h);
}

function addRatioPresetsWidget(node) {
  const existing = getWidget(node, "ratio_preset");
  if (existing) return existing;
  const w = {
    type: "combo",
    name: "ratio_preset",
    value: "Custom",
    options: { values: RATIO_PRESETS.slice(), serialize: false },
    serialize: false,
  };
  w.callback = (value, canvas, nodeArg) => {
    const n = nodeArg || node;
    const arW = getWidget(n, "aspect_ratio");
    const lockW = getWidget(n, "ratio_lock");
    if (value === "Custom") {
      if (lockW) lockW.value = false;
    } else if (value === "Free (Source)") {
      if (arW && n._imgW && n._imgH) arW.value = n._imgW + ":" + n._imgH;
      if (lockW) lockW.value = true;
    } else {
      if (arW) arW.value = value;
      if (lockW) lockW.value = true;
    }
    if (value !== "Custom") {
      applyAspectRatio(n, value === "Free (Source)" ? n._imgW + ":" + n._imgH : value);
    }
    if (n.setDirtyCanvas) n.setDirtyCanvas(true, true);
  };
  const arIdx = (node.widgets || []).findIndex((x) => x && x.name === "aspect_ratio");
  if (typeof node.addCustomWidget === "function") {
    node.addCustomWidget(w);
    if (arIdx >= 0) {
      const list = node.widgets;
      const idx = list.indexOf(w);
      if (idx >= 0) {
        list.splice(idx, 1);
        list.splice(arIdx + 1, 0, w);
      }
    }
  } else {
    (node.widgets || []).push(w);
  }
  return w;
}

function updateRatioPreset(node) {
  const preset = getWidget(node, "ratio_preset");
  const arW = getWidget(node, "aspect_ratio");
  if (!preset || !arW) return;
  const ar = arW.value;
  if (!ar || ar === "Custom") {
    preset.value = "Custom";
    return;
  }
  if (node._imgW && node._imgH && ar === node._imgW + ":" + node._imgH) {
    preset.value = "Free (Source)";
    return;
  }
  const found = RATIO_PRESETS.find(
    (p) => p !== "Custom" && p !== "Free (Source)" && parseRatio(p) === parseRatio(ar)
  );
  preset.value = found || "Custom";
}

// ── lifecycle ─────────────────────────────────────────────────────────────

function onNodeCreated(node) {
  if (!node || node._deggCropReady) return;
  node._deggCropReady = true;

  node._img = null;
  node._imgUrl = null;
  node._imgW = 0;
  node._imgH = 0;
  node._rect = null;

  const preview = makePreviewWidget(node);
  const existingIdx = (node.widgets || []).findIndex(
    (w) => w && w.name === "degg_crop_preview"
  );
  if (existingIdx >= 0) (node.widgets || []).splice(existingIdx, 1);
  if (typeof node.addCustomWidget === "function") node.addCustomWidget(preview);
  else (node.widgets || []).push(preview);

  // onMouseMove вызывается фронтендом для hover и продолжения drag
  // (виджетный mouse() — только пока идёт захват).
  node.onMouseMove = function (e, pos) {
    if (node._drag) {
      onPreviewMouse(e, pos, node);
      return true;
    }
    const area = getHitArea(node, pos, num(node._previewY, 0));
    try {
      if (e && e.target && e.target.style) {
        e.target.style.cursor = area ? CURSORS[area] || "default" : "default";
      }
    } catch (err) {
      /* ignore */
    }
    return false;
  };

  syncPropsFromWidgets(node);
  addRatioPresetsWidget(node);
  addFullCenterMaxButtons(node);
  updateRatioPreset(node);
  ensureImage(node);
}

function onConnectionsChange(node) {
  if (!node || !node._deggCropReady) return;
  node._imgUrl = null;
  ensureImage(node);
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

function onWidgetChanged(node, name) {
  if (!node || !node._deggCropReady) return;
  if (name === "x" || name === "y" || name === "width" || name === "height") {
    if (!node._drag) syncPropsFromWidgets(node);
  } else if (name === "aspect_ratio" || name === "ratio_lock") {
    updateRatioPreset(node);
  } else if (name === "file") {
    node._imgUrl = null;
    node._img = null;
    ensureImage(node);
  }
  if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
}

// ── регистрация расширения ────────────────────────────────────────────────

if (app && app.registerExtension) {
  app.registerExtension({
    name: EXT_NAME,
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (!nodeData || nodeData.name !== "DeggCrop") return;
      const proto = nodeType.prototype;

      const origCreated = proto.onNodeCreated;
      proto.onNodeCreated = function () {
        const r = origCreated ? origCreated.apply(this, arguments) : undefined;
        onNodeCreated(this);
        return r;
      };

      const origConn = proto.onConnectionsChange;
      proto.onConnectionsChange = function () {
        const r = origConn ? origConn.apply(this, arguments) : undefined;
        onConnectionsChange(this);
        return r;
      };

      const origWidgetChanged = proto.onWidgetChanged;
      proto.onWidgetChanged = function (name, value, oldValue, widget) {
        const r = origWidgetChanged
          ? origWidgetChanged.apply(this, arguments)
          : undefined;
        onWidgetChanged(this, name, value, oldValue, widget);
        return r;
      };

      // computeSize/computeLayoutSize ноды не перезаписываем жёстко: только
      // гарантируем, что предпросмотр получает свою высоту.
      const origComputeSize = proto.computeSize;
      proto.computeSize = function () {
        const size = origComputeSize
          ? origComputeSize.apply(this, arguments)
          : [300, 200];
        const need = PREVIEW_H + 40;
        if (!size || !size.length) return [300, need];
        if (size[1] < need) size[1] = need;
        return size;
      };

      const origLayout = proto.computeLayoutSize;
      proto.computeLayoutSize = function (minW, minH, maxW, maxH) {
        if (origLayout) return origLayout.apply(this, arguments);
        return computeLayoutSize(this, minW, minH, maxW, maxH);
      };
    },
  });
}

if (typeof window !== "undefined") {
  window.DeggCropPreview = {
    EXT_NAME,
    PREVIEW_H,
    PREVIEW_PAD,
    RATIO_PRESETS,
    pyRound,
    roundMult,
    parseRatio,
    getHitArea,
    computePreviewHeight,
    computeLayoutSize,
    computeLayout,
    pythonTarget,
    syncPropsFromWidgets,
    syncWidgetsFromProps,
    makePreviewWidget,
    drawPreview,
    drawGridThirds,
    resolveImageUrl,
  };
}
