let app;
if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
  app = window.comfyAPI.app.app;
} else if (window.app) {
  app = window.app;
}

const EXT_NAME = "DeggCrop";

const PREVIEW_H = 160;
const PREVIEW_PAD = 8;
const GOLDEN_RATIO = 1.61803398875;

function getHitArea(node, x, y) {
  if (!node._dragRect) return "none";
  const r = node._dragRect;
  const hs = 8;
  const left = x <= r.x + hs;
  const right = x >= r.x + r.w - hs;
  const top = y <= r.y + hs;
  const bottom = y >= r.y + r.h - hs;
  if (left && top) return "nw";
  if (right && top) return "ne";
  if (left && bottom) return "sw";
  if (right && bottom) return "se";
  if (left) return "w";
  if (right) return "e";
  if (top) return "n";
  if (bottom) return "s";
  return "move";
}

const CURSORS = {
  nw: "nwse-resize", ne: "nesw-resize",
  sw: "nesw-resize", se: "nwse-resize",
  n: "ns-resize", s: "ns-resize",
  w: "ew-resize", e: "ew-resize",
  move: "move", none: "crosshair"
};

function syncPropsFromWidgets(node) {
  const w = node.widgets;
  const get = (name) => {
    const wi = w.find(v => v.name === name);
    return wi ? wi.value : 0;
  };
  const x = get("x") || 0;
  const y = get("y") || 0;
  const width = Math.max(1, get("width") || 1);
  const height = Math.max(1, get("height") || 1);
  const ratioLock = get("ratio_lock") || false;
  const aspect = get("aspect_ratio") || "Custom";
  node._dragRect = { x, y, w: width, h: height };
  node._ratioLock = ratioLock;
  node._aspect = aspect;
}

function syncWidgetsFromProps(node) {
  if (!node._dragRect) return;
  const r = node._dragRect;
  const w = node.widgets;
  const set = (name, val) => {
    const wi = w.find(v => v.name === name);
    if (wi) wi.value = val;
  };
  set("x", Math.round(r.x));
  set("y", Math.round(r.y));
  set("width", Math.max(1, Math.round(r.w)));
  set("height", Math.max(1, Math.round(r.h)));
}

function drawPreview(node, ctx, canvasWidth, canvasHeight) {
  if (!node._dragRect) return;
  const r = node._dragRect;
  const scaleX = (canvasWidth - 2 * PREVIEW_PAD) / Math.max(1, node._imgW || 1);
  const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH || 1);
  const scale = Math.min(scaleX, scaleY);
  const drawW = Math.max(1, (node._imgW || 1) * scale);
  const drawH = Math.max(1, (node._imgH || 1) * scale);
  const ox = PREVIEW_PAD + (canvasWidth - 2 * PREVIEW_PAD - drawW) / 2;
  const oy = PREVIEW_PAD + (PREVIEW_H - 2 * PREVIEW_PAD - drawH) / 2;

  const rx = ox + r.x * scale;
  const ry = oy + r.y * scale;
  const rw = Math.max(1, r.w * scale);
  const rh = Math.max(1, r.h * scale);

  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.strokeRect(rx, ry, rw, rh);

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(rx, ry, rw, rh);

  ctx.fillStyle = "#fff";
  ctx.font = "10px monospace";
  const txt = Math.round(r.w) + "x" + Math.round(r.h);
  const tw = ctx.measureText(txt).width + 6;
  const tx = rx + Math.max(0, rw - tw - 4);
  const ty = ry - 4 > 10 ? ry - 4 : ry + rh + 14;
  ctx.fillRect(tx - 2, ty - 10, tw, 14);
  ctx.fillStyle = "#000";
  ctx.fillText(txt, tx + 1, ty);
  ctx.restore();
}

function drawGridThirds(node, ctx, canvasWidth, canvasHeight) {
  const scaleX = (canvasWidth - 2 * PREVIEW_PAD) / Math.max(1, node._imgW || 1);
  const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH || 1);
  const scale = Math.min(scaleX, scaleY);
  const drawW = Math.max(1, (node._imgW || 1) * scale);
  const drawH = Math.max(1, (node._imgH || 1) * scale);
  const ox = PREVIEW_PAD + (canvasWidth - 2 * PREVIEW_PAD - drawW) / 2;
  const oy = PREVIEW_PAD + (PREVIEW_H - 2 * PREVIEW_PAD - drawH) / 2;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  for (let i = 1; i <= 2; i++) {
    const vx = ox + drawW * i / 3;
    ctx.beginPath();
    ctx.moveTo(vx, oy);
    ctx.lineTo(vx, oy + drawH);
    ctx.stroke();
  }
  for (let i = 1; i <= 2; i++) {
    const vy = oy + drawH * i / 3;
    ctx.beginPath();
    ctx.moveTo(ox, vy);
    ctx.lineTo(ox + drawW, vy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const gx = ox + drawW / GOLDEN_RATIO;
  const gy = oy + drawH / GOLDEN_RATIO;
  ctx.strokeStyle = "rgba(255,215,0,0.6)";
  ctx.beginPath();
  ctx.moveTo(gx, oy);
  ctx.lineTo(gx, oy + drawH);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ox, gy);
  ctx.lineTo(ox + drawW, gy);
  ctx.stroke();
  ctx.restore();
}

function computePreviewHeight(node) {
  return PREVIEW_H;
}

function computeLayoutSize(node, minWidth, minHeight, maxWidth, maxHeight) {
  const w = Math.max(minWidth, Math.min(maxWidth, node.size[0] || 300));
  const h = Math.max(minHeight, Math.min(maxHeight, PREVIEW_H + 40));
  return [w, h];
}

function makePreviewWidget(node) {
  return {
    name: "preview",
    type: "custom",
    serialize: false,
    options: {
      computeSize: () => [node.size[0] || 300, PREVIEW_H],
      computeLayoutSize: () => computeLayoutSize(node, 200, PREVIEW_H + 40, 800, PREVIEW_H + 200),
      draw: (ctx, node, widget) => {
        if (node._imgW && node._imgH) {
          drawGridThirds(node, ctx, widget.size[0], widget.size[1]);
          drawPreview(node, ctx, widget.size[0], widget.size[1]);
        } else {
          ctx.fillStyle = "#222";
          ctx.fillRect(0, 0, widget.size[0], widget.size[1]);
          ctx.fillStyle = "#888";
          ctx.font = "12px monospace";
          ctx.textAlign = "center";
          ctx.fillText("No image", widget.size[0] / 2, widget.size[1] / 2);
        }
      },
      mouse: (e, pos, node, widget) => {
        if (!node._dragRect) return false;
        const r = node._dragRect;
        const scaleX = (widget.size[0] - 2 * PREVIEW_PAD) / Math.max(1, node._imgW || 1);
        const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH || 1);
        const scale = Math.min(scaleX, scaleY);
        const drawW = Math.max(1, (node._imgW || 1) * scale);
        const drawH = Math.max(1, (node._imgH || 1) * scale);
        const ox = PREVIEW_PAD + (widget.size[0] - 2 * PREVIEW_PAD - drawW) / 2;
        const oy = PREVIEW_PAD + (PREVIEW_H - 2 * PREVIEW_PAD - drawH) / 2;
        const rx = ox + r.x * scale;
        const ry = oy + r.y * scale;
        const rw = Math.max(1, r.w * scale);
        const rh = Math.max(1, r.h * scale);
        const mx = pos[0];
        const my = pos[1];

        if (e.type === "mousedown") {
          const area = getHitArea(node, mx - rx, my - ry);
          if (area !== "none") {
            node._dragMode = area;
            node._dragStart = { x: mx, y: my };
            node._dragRectStart = { x: r.x, y: r.y, w: r.w, h: r.h };
            node._lastMouse = { x: mx, y: my };
            return true;
          }
        } else if (e.type === "mousemove" && node._dragMode) {
          const dx = (mx - node._dragStart.x) / scale;
          const dy = (my - node._dragStart.y) / scale;
          const rs = node._dragRectStart;
          let nx = rs.x, ny = rs.y, nw = rs.w, nh = rs.h;
          const mode = node._dragMode;
          if (mode.includes("e")) nw = Math.max(1, rs.w + dx);
          if (mode.includes("w")) { nx = rs.x + dx; nw = Math.max(1, rs.w - dx); }
          if (mode.includes("s")) nh = Math.max(1, rs.h + dy);
          if (mode.includes("n")) { ny = rs.y + dy; nh = Math.max(1, rs.h - dy); }
          if (mode === "move") { nx = rs.x + dx; ny = rs.y + dy; }

          if (node._ratioLock && node._aspect !== "Custom") {
            const ar = parseFloat(node._aspect) || (nw / nh);
            if (mode.includes("e") || mode.includes("w")) {
              nh = Math.max(1, nw / ar);
            } else {
              nw = Math.max(1, nh * ar);
            }
          }
          node._dragRect = { x: nx, y: ny, w: nw, h: nh };
          syncWidgetsFromProps(node);
          return true;
        } else if (e.type === "mouseup") {
          if (node._dragMode) {
            node._dragMode = null;
            node._dragStart = null;
            node._dragRectStart = null;
            return true;
          }
        }
        return false;
      }
    }
  };
}

function addFullCenterMaxButtons(node) {
  const w = node.widgets;
  const addBtn = (name, label, cb) => {
    const idx = w.findIndex(v => v.name === name);
    if (idx >= 0) w.splice(idx, 1);
    w.push({
      name, type: "button", options: { label, callback: cb }
    });
  };
  addBtn("fit_full", "Full image", (node) => {
    if (node._imgW && node._imgH) {
      node._dragRect = { x: 0, y: 0, w: node._imgW, h: node._imgH };
      syncWidgetsFromProps(node);
    }
  });
  addBtn("fit_center", "Center", (node) => {
    if (node._imgW && node._imgH && node._dragRect) {
      const r = node._dragRect;
      const cx = (node._imgW - r.w) / 2;
      const cy = (node._imgH - r.h) / 2;
      node._dragRect = { x: Math.max(0, Math.round(cx)), y: Math.max(0, Math.round(cy)), w: r.w, h: r.h };
      syncWidgetsFromProps(node);
    }
  });
  addBtn("fit_max", "Maximize", (node) => {
    if (node._imgW && node._imgH && node._dragRect) {
      const r = node._dragRect;
      const scale = Math.min(node._imgW / r.w, node._imgH / r.h);
      node._dragRect = { x: 0, y: 0, w: Math.round(r.w * scale), h: Math.round(r.h * scale) };
      syncWidgetsFromProps(node);
    }
  });
}

function onNodeCreated(node) {
  if (node._deggCropInitialized) return;
  node._deggCropInitialized = true;

  const preview = makePreviewWidget(node);
  const idx = node.widgets.findIndex(w => w.name === "preview");
  if (idx >= 0) node.widgets.splice(idx, 1);
  node.widgets.unshift(preview);

  node.onMouseMove = (e, pos) => {
    if (node.widgets) {
      const pw = node.widgets.find(w => w.name === "preview");
      if (pw && pw.options && pw.options.mouse) {
        const handled = pw.options.mouse(e, pos, node, pw);
        if (handled) return true;
      }
    }
    return false;
  };

  addFullCenterMaxButtons(node);
  syncPropsFromWidgets(node);
}

function onConnectionsChange(node, _slot, _connected, _link, _io) {
  if (node.widgets) {
    const pw = node.widgets.find(w => w.name === "preview");
    if (pw) {
      const imgW = node.widgets.find(w => w.name === "width")?.value || node._imgW;
      const imgH = node.widgets.find(w => w.name === "height")?.value || node._imgH;
      if (imgW && imgH) {
        node._imgW = imgW;
        node._imgH = imgH;
      }
    }
  }
}

if (app && app.registerExtension) {
  app.registerExtension({
    name: EXT_NAME,
    beforeRegisterNodeDef: (nodeType, nodeData) => {
      if (nodeData.name === "DeggCrop") {
        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (node, _canvas) {
          if (originalOnNodeCreated) originalOnNodeCreated.call(this, node, _canvas);
          onNodeCreated(node || this);
        };
        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (node, slot, connected, link, io) {
          if (originalOnConnectionsChange) originalOnConnectionsChange.call(this, node, slot, connected, link, io);
          onConnectionsChange(node, slot, connected, link, io);
        };
        const originalComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (node) {
          if (originalComputeSize) return originalComputeSize.call(this, node);
          return [node.size[0] || 300, PREVIEW_H + 40];
        };
        const originalComputeLayoutSize = nodeType.prototype.computeLayoutSize;
        nodeType.prototype.computeLayoutSize = function (node, minW, minH, maxW, maxH) {
          if (originalComputeLayoutSize) return originalComputeLayoutSize.call(this, node, minW, minH, maxW, maxH);
          return computeLayoutSize(node, minW, minH, maxW, maxH);
        };
      }
    }
  });
}

// Export for tests
if (!window.DeggCropPreview) {
  window.DeggCropPreview = { PREVIEW_H, getHitArea, computePreviewHeight, computeLayoutSize };
}

