console.log("[DeggCrop] === SCRIPT START ===");
console.log("[DeggCrop] window.comfyAPI:", !!window.comfyAPI);
console.log("[DeggCrop] window.comfyAPI?.app:", !!window.comfyAPI?.app);
console.log("[DeggCrop] window.comfyAPI?.app?.app:", !!window.comfyAPI?.app?.app);
console.log("[DeggCrop] window.app:", !!window.app);

let app;
if (window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app) {
  app = window.comfyAPI.app.app;
  console.log("[DeggCrop] Got app from comfyAPI.app.app");
} else if (window.app) {
  app = window.app;
  console.log("[DeggCrop] Got app from window.app");
} else {
  console.log("[DeggCrop] NO APP FOUND!");
}

console.log("[DeggCrop] app:", !!app, "registerExtension:", !!(app && app.registerExtension));

const EXT_NAME = "DeggCrop";

const PREVIEW_H = 160;
const PREVIEW_PAD = 8;
const GOLDEN_RATIO = 1.61803398875;

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
  "21:9"
];

function parseRatio(r) {
  if (!r || r === "Custom") return 1;
  if (r === "Free (Source)") return 1;
  const parts = String(r).split(/[:/]/);
  if (parts.length === 2) {
    const a = parseFloat(parts[0]);
    const b = parseFloat(parts[1]);
    if (a > 0 && b > 0) return a / b;
  }
  const v = parseFloat(r);
  return isNaN(v) ? 1 : v;
}

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
  if (!node._dragRect || !node._imgW || !node._imgH) return;
  const r = node._dragRect;
  const scaleX = (canvasWidth - 2 * PREVIEW_PAD) / Math.max(1, node._imgW);
  const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH);
  const scale = Math.min(scaleX, scaleY);
  const drawW = Math.max(1, node._imgW * scale);
  const drawH = Math.max(1, node._imgH * scale);
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
  if (!node._imgW || !node._imgH) return;
  const scaleX = (canvasWidth - 2 * PREVIEW_PAD) / Math.max(1, node._imgW);
  const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH);
  const scale = Math.min(scaleX, scaleY);
  const drawW = Math.max(1, node._imgW * scale);
  const drawH = Math.max(1, node._imgH * scale);
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
  const h = Math.max(minHeight, Math.min(maxHeight, PREVIEW_H + 60));
  return [w, h];
}

function makePreviewWidget(node) {
  return {
    name: "preview",
    type: "custom",
    serialize: false,
    options: {
      computeSize: () => [node.size[0] || 300, PREVIEW_H],
      computeLayoutSize: () => computeLayoutSize(node, 200, PREVIEW_H + 60, 800, PREVIEW_H + 200),
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
        if (!node._dragRect || !node._imgW || !node._imgH) return false;
        const r = node._dragRect;
        const scaleX = (widget.size[0] - 2 * PREVIEW_PAD) / Math.max(1, node._imgW);
        const scaleY = (PREVIEW_H - 2 * PREVIEW_PAD) / Math.max(1, node._imgH);
        const scale = Math.min(scaleX, scaleY);
        const drawW = Math.max(1, node._imgW * scale);
        const drawH = Math.max(1, node._imgH * scale);
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
            const ar = parseRatio(node._aspect) || (nw / nh);
            if (mode.includes("e") || mode.includes("w")) {
              nh = Math.max(1, nw / ar);
            } else {
              nw = Math.max(1, nh * ar);
            }
          }
          if (!node._isExpandMode) {
            nx = Math.max(0, Math.min(node._imgW - nw, nx));
            ny = Math.max(0, Math.min(node._imgH - nh, ny));
            nw = Math.min(nw, node._imgW - nx);
            nh = Math.min(nh, node._imgH - ny);
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

function addRatioPresetsWidget(node) {
  const w = node.widgets;
  const existing = w.find(v => v.name === "ratio_preset");
  if (existing) return existing;
  
  const arWidget = w.find(v => v.name === "aspect_ratio");
  const arIdx = w.findIndex(v => v.name === "aspect_ratio");
  
  const presetWidget = {
    name: "ratio_preset",
    type: "combo",
    value: "Custom",
    options: {
      values: RATIO_PRESETS,
      callback: (value, node) => {
        const arWidget = node.widgets.find(w => w.name === "aspect_ratio");
        const lockWidget = node.widgets.find(w => w.name === "ratio_lock");
        if (value === "Custom") {
          if (lockWidget) lockWidget.value = false;
        } else if (value === "Free (Source)") {
          if (arWidget && node._imgW && node._imgH) arWidget.value = node._imgW + ":" + node._imgH;
          if (lockWidget) lockWidget.value = true;
        } else {
          if (arWidget) arWidget.value = value;
          if (lockWidget) lockWidget.value = true;
        }
        applyAspectRatio(node, arWidget ? arWidget.value : "Custom");
      }
    }
  };
  
  if (arIdx >= 0) {
    w.splice(arIdx + 1, 0, presetWidget);
  } else {
    w.push(presetWidget);
  }
  return presetWidget;
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
      node._isExpandMode = false;
      syncWidgetsFromProps(node);
      updateRatioPreset(node);
    }
  });
  addBtn("fit_center", "Center", (node) => {
    if (node._imgW && node._imgH && node._dragRect) {
      const r = node._dragRect;
      const cx = (node._imgW - r.w) / 2;
      const cy = (node._imgH - r.h) / 2;
      node._dragRect = { x: Math.max(0, Math.round(cx)), y: Math.max(0, Math.round(cy)), w: r.w, h: r.h };
      node._isExpandMode = false;
      syncWidgetsFromProps(node);
      updateRatioPreset(node);
    }
  });
  addBtn("fit_max", "Maximize", (node) => {
    if (node._imgW && node._imgH && node._dragRect) {
      const r = node._dragRect;
      const scale = Math.min(node._imgW / r.w, node._imgH / r.h);
      node._dragRect = { x: 0, y: 0, w: Math.round(r.w * scale), h: Math.round(r.h * scale) };
      node._isExpandMode = false;
      syncWidgetsFromProps(node);
      updateRatioPreset(node);
    }
  });
}

function updateRatioPreset(node) {
  const presetWidget = node.widgets.find(w => w.name === "ratio_preset");
  const arWidget = node.widgets.find(w => w.name === "aspect_ratio");
  if (!presetWidget || !arWidget || !node._imgW || !node._imgH) return;
  
  const ar = arWidget.value;
  const found = RATIO_PRESETS.find(p => p !== "Custom" && p !== "Free (Source)" && parseRatio(p) === parseRatio(ar));
  if (found) {
    presetWidget.value = found;
  } else if (ar === (node._imgW + ":" + node._imgH)) {
    presetWidget.value = "Free (Source)";
  } else {
    presetWidget.value = "Custom";
  }
}

function applyAspectRatio(node, arValue) {
  if (!node._imgW || !node._imgH) return;
  const ar = parseRatio(arValue);
  if (ar <= 0) return;
  
  let nw, nh;
  if (node._imgW / node._imgH > ar) {
    nh = node._imgH;
    nw = Math.round(nh * ar);
  } else {
    nw = node._imgW;
    nh = Math.round(nw / ar);
  }
  
  const cx = (node._imgW - nw) / 2;
  const cy = (node._imgH - nh) / 2;
  
  node._dragRect = { x: Math.max(0, Math.round(cx)), y: Math.max(0, Math.round(cy)), w: nw, h: nh };
  node._isExpandMode = false;
  syncWidgetsFromProps(node);
  updateRatioPreset(node);
}

function loadImageFromUrl(url, callback) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    callback(img.naturalWidth, img.naturalHeight);
  };
  img.onerror = () => {
    callback(null, null);
  };
  img.src = url;
}

function findImageUrl(node) {
  if (!node.inputs || !app || !app.graph) return null;
  
  for (const input of node.inputs) {
    if (input.name === "image" && input.link !== null) {
      const link = app.graph.links[input.link];
      if (link) {
        const originNode = app.graph.getNodeById(link.origin_id);
        if (originNode) {
          if (originNode.type === "LoadImage" || originNode.comfyClass === "LoadImage") {
            const widget = originNode.widgets.find(w => w.name === "image");
            if (widget && widget.value) {
              const api = window.comfyAPI?.api;
              if (api && api.apiURL) {
                return api.apiURL("/view?filename=" + encodeURIComponent(widget.value) + "&type=output");
              }
            }
          }
          if (originNode.outputs && originNode.outputs[link.origin_slot]) {
            const output = originNode.outputs[link.origin_slot];
            if (output && output.shape) {
              return "tensor:" + link.origin_id + ":" + link.origin_slot;
            }
          }
        }
      }
    }
  }
  const fileWidget = node.widgets.find(w => w.name === "file");
  if (fileWidget && fileWidget.value) {
    const api = window.comfyAPI?.api;
    if (api && api.apiURL) {
      return api.apiURL("/view?filename=" + encodeURIComponent(fileWidget.value) + "&type=input");
    }
  }
  return null;
}

function updateImageDimensions(node) {
  const url = findImageUrl(node);
  if (!url) return;
  
  if (url.startsWith("tensor:")) {
    const parts = url.split(":");
    const nodeId = parseInt(parts[1]);
    const slot = parseInt(parts[2]);
    if (app && app.graph) {
      const originNode = app.graph.getNodeById(nodeId);
      if (originNode && originNode.outputs && originNode.outputs[slot]) {
        const output = originNode.outputs[slot];
        if (output && output.shape) {
          node._imgH = output.shape[1];
          node._imgW = output.shape[2];
          if (!node._dragRect) {
            node._dragRect = { x: 0, y: 0, w: node._imgW, h: node._imgH };
            syncWidgetsFromProps(node);
          }
          updateRatioPreset(node);
          if (node.setDirtyCanvas) node.setDirtyCanvas();
        }
      }
    }
    return;
  }
  
  loadImageFromUrl(url, (w, h) => {
    if (w && h) {
      node._imgW = w;
      node._imgH = h;
      if (!node._dragRect) {
        node._dragRect = { x: 0, y: 0, w, h };
        syncWidgetsFromProps(node);
      }
      updateRatioPreset(node);
      if (node.setDirtyCanvas) node.setDirtyCanvas();
    }
  });
}

function onNodeCreated(node) {
  console.log("[DeggCrop] onNodeCreated called, node:", node.id);
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

  addRatioPresetsWidget(node);
  addFullCenterMaxButtons(node);
  syncPropsFromWidgets(node);
  
  const x = node.widgets.find(w => w.name === "x")?.value || 0;
  const y = node.widgets.find(w => w.name === "y")?.value || 0;
  node._isExpandMode = x < 0 || y < 0;
  
  setTimeout(() => updateImageDimensions(node), 0);
}

function onConnectionsChange(node, _slot, _connected, _link, _io) {
  setTimeout(() => updateImageDimensions(node), 100);
}

function onWidgetChanged(node, name, value, oldValue) {
  if (!node._deggCropInitialized) return;
  
  if (name === "x" || name === "y" || name === "width" || name === "height") {
    syncPropsFromWidgets(node);
    node._isExpandMode = (node.widgets.find(w => w.name === "x")?.value || 0) < 0 || 
                         (node.widgets.find(w => w.name === "y")?.value || 0) < 0;
  } else if (name === "ratio_lock" || name === "aspect_ratio") {
    syncPropsFromWidgets(node);
  } else if (name === "file") {
    setTimeout(() => updateImageDimensions(node), 100);
  }
  
  if (node.setDirtyCanvas) node.setDirtyCanvas();
}

console.log("[DeggCrop] Extension loading, app:", !!app, "registerExtension:", !!(app && app.registerExtension));
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
        const originalOnInputsChanged = nodeType.prototype.onInputsChanged;
        nodeType.prototype.onInputsChanged = function (node) {
          console.log("[DeggCrop] onInputsChanged called, node:", node.id, "inputs:", node.inputs);
          if (originalOnInputsChanged) originalOnInputsChanged.call(this, node);
          // Check image input for tensor
          if (node.inputs) {
            for (const input of node.inputs) {
              if (input.name === "image" && input.link !== null && app && app.graph) {
                const link = app.graph.links[input.link];
                if (link) {
                  const originNode = app.graph.getNodeById(link.origin_id);
                  if (originNode && originNode.outputs) {
                    const output = originNode.outputs[link.origin_slot];
                    if (output && output.shape) {
                      node._imgH = output.shape[1];
                      node._imgW = output.shape[2];
                      if (!node._dragRect) {
                        node._dragRect = { x: 0, y: 0, w: node._imgW, h: node._imgH };
                        syncWidgetsFromProps(node);
                      }
                      updateRatioPreset(node);
                      if (node.setDirtyCanvas) node.setDirtyCanvas();
                    }
                  }
                }
              }
            }
          }
        };

        const originalOnWidgetChanged = nodeType.prototype.onWidgetChanged;
        nodeType.prototype.onWidgetChanged = function (node, name, value, oldValue) {
          if (originalOnWidgetChanged) originalOnWidgetChanged.call(this, node, name, value, oldValue);
          onWidgetChanged(node, name, value, oldValue);
        };
        
        const originalComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function (node) {
          if (originalComputeSize) return originalComputeSize.call(this, node);
          return [node.size[0] || 300, PREVIEW_H + 60];
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

if (!window.DeggCropPreview) {
  window.DeggCropPreview = { PREVIEW_H, getHitArea, computePreviewHeight, computeLayoutSize, parseRatio, RATIO_PRESETS };
}