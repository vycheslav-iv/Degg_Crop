// JS-смоук Degg_Crop: исполняет web/js/degg_crop.js в vm-контексте
// с заглушками window/LiteGraph/Image и проверяет контракт фронтенда:
//   • расширение зарегистрировано, beforeRegisterNodeDef фильтрует по имени;
//   • onNodeCreated добавляет виджет degg_crop_preview (custom, serialize:false);
//   • draw/mouse/computeSize лежат на ВЕРХНЕМ уровне виджета (фронтенд читает
//     именно их — options.* он игнорирует);
//   • api берётся из comfyAPI.api.api (namespace → apiURL);
//   • математика target_size совпадает с python (banker's rounding, кратность);
//   • drag/resize рамки мышью (9 зон) И выход за пределы изображения (аутпеинт);
//   • кнопки Full image / Center / Maximize, пресеты пропорций.
// Запуск:  cd Degg_Crop && node tests/_smoke_degg_crop.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILE = path.join(ROOT, "web", "js", "degg_crop.js");

const errors = [];
const oks = [];
const check = (label, cond, extra = "") => {
  (cond ? oks : errors).push(label);
  if (!cond) console.log(`  ASSERT FAIL  ${label}${extra ? "  [" + extra + "]" : ""}`);
  else console.log(`  ok  ${label}`);
};

let capturedExt = null;

class FakeImage {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._src = "";
  }
  set src(v) {
    this._src = v;
    this.complete = true;
    this.naturalWidth = 640;
    this.naturalHeight = 480;
    if (typeof this.onload === "function") this.onload();
  }
  get src() {
    return this._src;
  }
}

const appInstance = {
  registerExtension: (e) => {
    capturedExt = e;
  },
  graph: null,
  node_outputs: null,
};
const sandbox = {
  console,
  Image: FakeImage,
  comfyAPI: {
    app: { app: appInstance, registerExtension: appInstance.registerExtension },
    api: { api: { apiURL: (p) => `http://127.0.0.1:8188${p}` } },
  },
  app: appInstance,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: "degg_crop.js" });

const P = sandbox.window.DeggCropPreview;
check("расширение захвачено", !!capturedExt);
check("window.DeggCropPreview экспортирован", !!P);
if (P) {
  check("PREVIEW_H === 160", P.PREVIEW_H === 160);
  check("getHitArea функция", typeof P.getHitArea === "function");
  check("computeLayout функция", typeof P.computeLayout === "function");
  check("pythonTarget функция", typeof P.pythonTarget === "function");
  check("pyRound функция", typeof P.pyRound === "function");
  check("roundMult функция", typeof P.roundMult === "function");
}

// ── beforeRegisterNodeDef: чужую ноду не трогаем ──────────────────────────
const protoHolder = {};
function NodeType() {}
NodeType.prototype = protoHolder;
await capturedExt.beforeRegisterNodeDef(NodeType, { name: "NotDeggCrop" });
check("чужая нода не получила перехват onNodeCreated", typeof protoHolder.onNodeCreated !== "function");

await capturedExt.beforeRegisterNodeDef(NodeType, { name: "DeggCrop" });
check("DeggCrop: onNodeCreated перехвачен", typeof protoHolder.onNodeCreated === "function");
check("DeggCrop: onConnectionsChange перехвачен", typeof protoHolder.onConnectionsChange === "function");
check("DeggCrop: onWidgetChanged перехвачен", typeof protoHolder.onWidgetChanged === "function");
check("DeggCrop: computeSize перехвачен", typeof protoHolder.computeSize === "function");
check("DeggCrop: computeLayoutSize перехвачен", typeof protoHolder.computeLayoutSize === "function");

// ── сборка ноды ────────────────────────────────────────────────────────────
function w(name, value, options) {
  return { name, value, options: options || {} };
}

function makeNode() {
  const node = Object.create(NodeType.prototype);
  node.comfyClass = "DeggCrop";
  node.type = "DeggCrop";
  node.id = 7;
  node.size = [320, 500];
  node.inputs = [];
  node.widgets = [
    w("file", ""),
    w("x", 0),
    w("y", 0),
    w("width", 512),
    w("height", 512),
    w("fill_color", "black"),
    w("multiplicity", 8),
    w("megapixels", 1.0),
    w("upscale_method", "bicubic"),
    w("aspect_ratio", "Custom"),
    w("ratio_lock", false),
    w("dim_percent", 40),
  ];
  node.dirty = 0;
  node.setDirtyCanvas = function () {
    this.dirty += 1;
  };
  node.addCustomWidget = function (wid) {
    this.widgets.push(wid);
  };
  return node;
}

const node = makeNode();
node.onNodeCreated();
const prev = node.widgets.find((x) => x && x.name === "degg_crop_preview");
check("onNodeCreated добавил виджет degg_crop_preview", !!prev);
check("виджет type=custom", prev && prev.type === "custom");
check("виджет serialize=false", prev && prev.serialize === false);
check("виджет options.serialize=false (двойная страховка)", prev && prev.options && prev.options.serialize === false);
check("виджет options.canvasOnly=true", prev && prev.options && prev.options.canvasOnly === true);

// КЛЮЧЕВОЙ контракт: draw/mouse/computeSize — на верхнем уровне
check("computeSize на верхнем уровне виджета", prev && typeof prev.computeSize === "function");
check("draw на верхнем уровне виджета", prev && typeof prev.draw === "function");
check("mouse на верхнем уровне виджета", prev && typeof prev.mouse === "function");
check("draw НЕ спрятан в options", prev && !(prev.options && typeof prev.options.draw === "function"));
check("mouse НЕ спрятан в options", prev && !(prev.options && typeof prev.options.mouse === "function"));

check(
  "повторный onNodeCreated не дублирует виджет",
  (() => {
    const before = node.widgets.length;
    node.onNodeCreated();
    return node.widgets.length === before;
  })()
);

// ── кнопки / пресеты ─────────────────────────────────────────────────────
const byName = (n, name) => (n.widgets || []).find((x) => x && x.name === name);
check("добавлена кнопка fit_full", !!byName(node, "fit_full"));
check("добавлена кнопка fit_center", !!byName(node, "fit_center"));
check("добавлена кнопка fit_max", !!byName(node, "fit_max"));
check("добавлено комбо ratio_preset", !!byName(node, "ratio_preset"));
check("пресеты — 10 значений", byName(node, "ratio_preset").options.values.length === 10);
check(
  "JS-виджеты не сериализуются",
  ["fit_full", "fit_center", "fit_max", "ratio_preset", "degg_crop_preview"].every(
    (n) => byName(node, n).serialize === false
  )
);

// ── математика (совпадение с python) ─────────────────────────────────────
check("pyRound: банковское округление 2.5 -> 2", P.pyRound(2.5) === 2);
check("pyRound: 3.5 -> 4", P.pyRound(3.5) === 4);
check("pyRound: 2.4 -> 2", P.pyRound(2.4) === 2);
check("roundMult(1000, 16) === 992", P.roundMult(1000, 16) === 992);
check("roundMult(512, 8) === 512", P.roundMult(512, 8) === 512);
check("roundMult минимум = кратность", P.roundMult(2, 8) === 8);

// target_size как в python: mp=0 → размеры окна с кратностью
node._rect = { x: 0, y: 0, w: 510, h: 510 };
byName(node, "megapixels").value = 0;
byName(node, "multiplicity").value = 8;
let tgt = P.pythonTarget(node);
check("pythonTarget: mp=0, 510 -> [512,512]", tgt[0] === 512 && tgt[1] === 512, JSON.stringify(tgt));

// mp=2 при источнике 640x480 и окне 640x480 → площадь 2 MP с пропорцией 4:3
node._rect = { x: 0, y: 0, w: 640, h: 480 };
byName(node, "megapixels").value = 2;
byName(node, "multiplicity").value = 16;
tgt = P.pythonTarget(node);
const area = 2 * 1024 * 1024;
const ratio = 640 / 480;
check(
  "pythonTarget: mp=2, 4:3 совпадает с формулой python",
  tgt[0] === P.roundMult(Math.sqrt(area * ratio), 16) &&
    tgt[1] === P.roundMult(Math.sqrt(area / ratio), 16),
  JSON.stringify(tgt)
);

// ── раскладка: рамка за пределами изображения остаётся видимой ────────────
node._imgW = 640;
node._imgH = 480;
node._rect = { x: -100, y: -50, w: 900, h: 700 };
const L = P.computeLayout(node, 300);
check("computeLayout: рамка внутри виджета (x >= 0)", L.win.x >= 0, JSON.stringify(L.win));
check("computeLayout: рамка внутри виджета (y >= 0)", L.win.y >= 0, JSON.stringify(L.win));
check("computeLayout: рамка не выходит справа", L.win.x + L.win.w <= L.W + 0.5, JSON.stringify(L.win));
check("computeLayout: изображение вписано", L.img.w > 0 && L.img.h > 0);

// ── draw() без ошибок + координаты ───────────────────────────────────────
const calls = { fillRect: [], drawImage: 0, strokeRect: [] };
const ctx = {
  save: () => {},
  restore: () => {},
  translate: () => {},
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 1,
  font: "",
  textAlign: "",
  strokeRect: (...a) => calls.strokeRect.push(a),
  fillRect: (...a) => calls.fillRect.push(a),
  fillText: () => {},
  measureText: () => ({ width: 30 }),
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  rect: () => {},
  fill: () => {},
  drawImage: () => {
    calls.drawImage += 1;
  },
  setLineDash: () => {},
  arc: () => {},
  closePath: () => {},
};

node._rect = { x: 0, y: 0, w: 512, h: 512 };
byName(node, "x").value = 0;
byName(node, "y").value = 0;
byName(node, "width").value = 512;
byName(node, "height").value = 512;
byName(node, "megapixels").value = 0;
// источник: файл из input → ensureImage загрузит FakeImage
byName(node, "file").value = "022.png";
let drawErr = null;
try {
  prev.draw(ctx, node, 320, 68);
} catch (e) {
  drawErr = e;
  console.log("DRAW ERROR:", e.message, e.stack);
}
check("draw() без исключений", drawErr === null);
check("draw() вызвал drawImage (картинка нарисована)", calls.drawImage > 0, String(calls.drawImage));
check("draw() нарисовал рамку (strokeRect)", calls.strokeRect.length > 0);
check("draw() запомнил _previewY = 68", node._previewY === 68);
check("draw() запомнил _layout", !!node._layout);
check("первый fillRect на y=0 (внутри translate)", calls.fillRect.length > 0 && calls.fillRect[0][1] === 0);

// ── getHitArea (координаты ноды, y виджета учитывается) ──────────────────
node._rect = { x: 0, y: 0, w: 640, h: 480 };
byName(node, "x").value = 0;
byName(node, "y").value = 0;
byName(node, "width").value = 640;
byName(node, "height").value = 480;
node._imgW = 640;
node._imgH = 480;
prev.draw(ctx, node, 320, 68);
const Y = 68;
const L2 = node._layout;
const centerX = L2.win.x + L2.win.w / 2;
const centerY = L2.win.y + L2.win.h / 2 + Y;
check("hitArea: центр окна → move", P.getHitArea(node, [centerX, centerY], Y) === "move");
check("hitArea: левый-верхний угол → nw", P.getHitArea(node, [L2.win.x, L2.win.y + Y], Y) === "nw");
check(
  "hitArea: правый-нижний угол → se",
  P.getHitArea(node, [L2.win.x + L2.win.w, L2.win.y + L2.win.h + Y], Y) === "se"
);
check("hitArea: вне предпросмотра → null", P.getHitArea(node, [-5, -5], Y) === null);

// ── drag: move выводит окно ЗА пределы изображения (аутпеинт) ─────────────
node._rect = { x: 0, y: 0, w: 200, h: 200 };
byName(node, "x").value = 0;
byName(node, "y").value = 0;
byName(node, "width").value = 200;
byName(node, "height").value = 200;
byName(node, "ratio_lock").value = false;
node._drag = null;
prev.draw(ctx, node, 320, 68);
const L3 = node._layout;
const cx = L3.win.x + L3.win.w / 2;
const cy = L3.win.y + L3.win.h / 2 + Y;
const started = prev.mouse({ type: "pointerdown", buttons: 1 }, [cx, cy], node);
check("mousedown по рамке стартует drag", started === true && !!node._drag);
// тянем влево-вверх → окно уходит в отрицательные x/y (аутпеинт)
prev.mouse({ type: "pointermove", buttons: 1 }, [cx - 60, cy - 60], node);
const moved = { x: byName(node, "x").value, y: byName(node, "y").value };
check("drag move уводит x за изображение (x < 0)", moved.x < 0, JSON.stringify(moved));
check("drag move уводит y за изображение (y < 0)", moved.y < 0, JSON.stringify(moved));
check(
  "drag move не меняет размеры",
  byName(node, "width").value === 200 && byName(node, "height").value === 200
);
prev.mouse({ type: "pointerup", buttons: 0 }, [cx - 60, cy - 60], node);
check("mouseup завершает drag", node._drag === null);

// ── resize: правый-нижний угол увеличивает окно ──────────────────────────
node._rect = { x: 100, y: 100, w: 200, h: 200 };
byName(node, "x").value = 100;
byName(node, "y").value = 100;
byName(node, "width").value = 200;
byName(node, "height").value = 200;
prev.draw(ctx, node, 320, 68);
const L4 = node._layout;
const seX = L4.win.x + L4.win.w;
const seY = L4.win.y + L4.win.h + Y;
prev.mouse({ type: "pointerdown", buttons: 1 }, [seX, seY], node);
prev.mouse({ type: "pointermove", buttons: 1 }, [seX + 40, seY + 40], node);
prev.mouse({ type: "pointerup", buttons: 0 }, [seX + 40, seY + 40], node);
check("resize se увеличил width", byName(node, "width").value > 200, String(byName(node, "width").value));
check("resize se увеличил height", byName(node, "height").value > 200, String(byName(node, "height").value));
check("resize se не сдвинул x", byName(node, "x").value === 100, String(byName(node, "x").value));

// ── кнопки ───────────────────────────────────────────────────────────────
node._imgW = 640;
node._imgH = 480;
byName(node, "fit_full").callback();
check(
  "Full image: x=0 y=0 w=640 h=480",
  byName(node, "x").value === 0 &&
    byName(node, "y").value === 0 &&
    byName(node, "width").value === 640 &&
    byName(node, "height").value === 480
);

node._rect = { x: 0, y: 0, w: 200, h: 100 };
byName(node, "x").value = 0;
byName(node, "y").value = 0;
byName(node, "width").value = 200;
byName(node, "height").value = 100;
byName(node, "file").value = "";
node._imgUrl = null;
node._img = null;
byName(node, "fit_center").callback();
check(
  "Center: окно по центру 640x480",
  byName(node, "x").value === 220 && byName(node, "y").value === 190,
  JSON.stringify([byName(node, "x").value, byName(node, "y").value])
);

node._rect = { x: 0, y: 0, w: 200, h: 100 };
byName(node, "x").value = 0;
byName(node, "y").value = 0;
byName(node, "width").value = 200;
byName(node, "height").value = 100;
byName(node, "ratio_lock").value = false;
byName(node, "aspect_ratio").value = "Custom";
byName(node, "fit_max").callback();
check("Maximize: окно расширено по источнику", byName(node, "width").value >= 200);

// ── пресет 16:9 ──────────────────────────────────────────────────────────
byName(node, "ratio_lock").value = false;
byName(node, "aspect_ratio").value = "Custom";
byName(node, "ratio_preset").callback("16:9", null, node);
check("пресет 16:9 записан в aspect_ratio", byName(node, "aspect_ratio").value === "16:9");
check("пресет 16:9 включил ratio_lock", byName(node, "ratio_lock").value === true);
const pr = byName(node, "width").value / byName(node, "height").value;
check("пресет 16:9 дал пропорцию 16:9", Math.abs(pr - 16 / 9) < 0.02, String(pr));
check(
  "пресет 16:9 не выводит окно за источник",
  byName(node, "x").value >= 0 &&
    byName(node, "y").value >= 0 &&
    byName(node, "x").value + byName(node, "width").value <= 640 &&
    byName(node, "y").value + byName(node, "height").value <= 480
);

// ── источник: LoadImage через Map-совместимый graph.links ────────────────
const loader = {
  id: 3,
  type: "LoadImage",
  comfyClass: "LoadImage",
  widgets: [w("image", "022.png")],
  inputs: [],
};
const linkMap = new Map();
linkMap.set(11, { id: 11, origin_id: 3, origin_slot: 0, target_id: 7, target_slot: 0 });
appInstance.graph = {
  links: linkMap,
  getNodeById: (id) => (id === 3 ? loader : null),
  _nodes: [loader],
};
node.inputs = [{ name: "image", type: "IMAGE", link: 11 }];
const url = P.resolveImageUrl(node);
check(
  "resolveImageUrl находит LoadImage через Map.get",
  typeof url === "string" && url.includes("filename=022.png"),
  String(url)
);
check(
  "URL идёт через apiURL (namespace → api.api)",
  typeof url === "string" && url.startsWith("http://127.0.0.1:8188/view?"),
  String(url)
);

console.log("");
if (errors.length) {
  console.error("ИТОГО: FAIL=" + errors.length);
  process.exit(1);
}
console.log("ИТОГО: FAIL=0");
console.log("SMOKE OK");
process.exit(0);
