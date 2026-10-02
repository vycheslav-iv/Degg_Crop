// JS-смоук Degg_Crop: исполняет web/js/degg_crop.js в vm-контексте
// с заглушками window/LiteGraph/Image и проверяет ЖИВОЕ поведение:
//   • расширение зарегистрировано, beforeRegisterNodeDef фильтрует по имени;
//   • onNodeCreated добавляет виджет-превью (фиксированная высота) и JS-виджеты
//     (Ratio Presets + кнопки), идемпотентно;
//   • раскладка fit-to-target считается верно в обоих режимах;
//   • draw() рисует без исключений, в координатах ноды и без measureText;
//   • математика совпадает с python (банковское округление, MP-цель);
//   • синки виджетов (пресеты, aspect, crop-поля) и мышь (drag рамки).
//
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
  get src() { return this._src; }
}

// Реальная структура фронтенда: window.comfyAPI.app — это НЕ экземпляр App,
// а модуль scripts/app.js, у которого есть свойство .app (сам App) + .registerExtension.
// Отсюда в нодах: const { app } = window.comfyAPI?.app;  → app = App-экземпляр.
const appInstance = {
  registerExtension: (e) => { capturedExt = e; },
  graph: null,
  node_outputs: null,
};
const sandbox = {
  console,
  Image: FakeImage,
  window: {
    comfyAPI: {
      app: { app: appInstance, registerExtension: appInstance.registerExtension },
      api: { apiURL: (p) => `http://127.0.0.1:8188${p}` },
    },
  },
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: "degg_crop.js" });

const P = sandbox.window.DeggCropPreview;
check("расширение захвачено", !!capturedExt);
check("window.DeggCropPreview экспортирован", !!P);

// ── beforeRegisterNodeDef: чужую ноду не трогаем ──────────────────────────
const protoHolder = {};
function NodeType() {}
NodeType.prototype = protoHolder;
await capturedExt.beforeRegisterNodeDef(NodeType, { name: "NotDeggCrop" });
check("чужая нода не получила перехват onNodeCreated",
  typeof protoHolder.onNodeCreated !== "function");

await capturedExt.beforeRegisterNodeDef(NodeType, { name: "DeggCrop" });
check("DeggCrop: onNodeCreated перехвачен", typeof protoHolder.onNodeCreated === "function");
check("DeggCrop: onWidgetChanged перехвачен", typeof protoHolder.onWidgetChanged === "function");
check("DeggCrop: onExecuted перехвачен", typeof protoHolder.onExecuted === "function");
check("DeggCrop: onConfigure перехвачен", typeof protoHolder.onConfigure === "function");
check("DeggCrop: onConnectionsChange перехвачен", typeof protoHolder.onConnectionsChange === "function");

// ── сборка ноды ────────────────────────────────────────────────────────────
function w(name, value, options) { return { name, value, options: options || {} }; }

function makeNode(op) {
  const node = Object.create(NodeType.prototype);
  node.comfyClass = "DeggCrop";
  node.type = "DeggCrop";
  node.size = [320, 500];
  node.inputs = [];
  node.widgets = [
    w("operation", op || "Crop"), w("x", 0), w("y", 0),
    w("width", 512), w("height", 512), w("fill_color", "black"),
    w("crop_left", 0), w("crop_right", 0), w("crop_top", 0), w("crop_bottom", 0),
    w("multiplicity", 16), w("resolution_mp", 0), w("upscale_method", "bicubic"),
    w("aspect_ratio", "Custom"), w("ratio_lock", false),
  ];
  node.dirty = 0;
  node.setDirtyCanvas = function () { this.dirty += 1; };
  node.addWidget = function (type, name, value, cb, options) {
    const wid = { type, name, value, callback: cb, options: options || {} };
    this.widgets.push(wid);
    return wid;
  };
  node.addCustomWidget = function (wid) { this.widgets.push(wid); };
  return node;
}

const node = makeNode("Crop");
node.imgs = [{ src: "http://127.0.0.1:8188/view?filename=a.png&type=output&subfolder=" }];

node.onNodeCreated();
const prev = node.widgets.find((x) => x && x.name === "degg_crop_preview");
check("onNodeCreated добавил виджет degg_crop_preview", !!prev);
check("виджет объявлен как custom_canvas", prev && prev.type === "custom_canvas");
check("виджет не сериализуется (serialize=false)",
  prev && prev.serialize === false && prev.options && prev.options.options === undefined
  && prev.options.serialize === false);
check("повторный onNodeCreated не дублирует виджет", (() => {
  const before = node.widgets.length;
  node.onNodeCreated();
  return node.widgets.length === before;
})());

// ── JS-виджеты: пресеты и кнопки ──────────────────────────────────────────
const byName = (n, name) => (n.widgets || []).find((x) => x && x.name === name);
check("добавлен виджет Ratio Presets", !!byName(node, "Ratio Presets"));
check("добавлены кнопки Full Image / Center / Maximize / Load Image",
  ["Full Image", "Center", "Maximize", "Load Image"].every((n) => !!byName(node, n)));
const arIdx = node.widgets.findIndex((x) => x && x.name === "aspect_ratio");
const prIdx = node.widgets.findIndex((x) => x && x.name === "Ratio Presets");
check("Ratio Presets стоит сразу после aspect_ratio", prIdx === arIdx + 1,
  `${prIdx} != ${arIdx + 1}`);
check("пресеты и кнопки не сериализуются",
  ["Ratio Presets", "Full Image", "Center", "Maximize", "Load Image"]
    .every((n) => { const x = byName(node, n); return x && x.serialize === false
      && x.options && x.options.serialize === false; }));
check("в пресетах есть «Free (Source)» и «Custom»",
  (() => { const x = byName(node, "Ratio Presets");
    return x.options.values.includes("Free (Source)") && x.options.values.includes("Custom"); })());

// ── математика ────────────────────────────────────────────────────────────
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
check("parseRatio('16:9') ≈ 1.7778", near(P.parseRatio("16:9"), 16 / 9, 1e-4),
  String(P.parseRatio("16:9")));
check("parseRatio('/') → ':' работает (4/3)", near(P.parseRatio("4/3"), 4 / 3, 1e-9));
check("parseRatio('Custom') === 1", P.parseRatio("Custom") === 1);
check("ratioFrom('Custom', 1.5) === 1.5", P.ratioFrom("Custom", 1.5) === 1.5);
check("pyRound банковское: 22.5 → 22", P.pyRound(22.5) === 22, String(P.pyRound(22.5)));
check("pyRound банковское: 23.5 → 24", P.pyRound(23.5) === 24, String(P.pyRound(23.5)));
check("pyRound: -0.5 → 0 (как python round)", P.pyRound(-0.5) === 0, String(P.pyRound(-0.5)));
check("roundMult(1000, 16) === 992", P.roundMult(1000, 16) === 992, String(P.roundMult(1000, 16)));
check("roundMult(512, 16) === 512", P.roundMult(512, 16) === 512, String(P.roundMult(512, 16)));

const pr = P.percentRectFromMargins(640, 480, 10, 10, 10, 10);
check("percentRectFromMargins(640,480,10,10,10,10) = {64,48,512,384}",
  pr.x === 64 && pr.y === 48 && pr.w === 512 && pr.h === 384, JSON.stringify(pr));
const prC = P.percentRectFromMargins(640, 480, 90, 90, 90, 90);
check("percentRectFromMargins не вырождается в ноль (>0 пикселей)",
  prC.w >= 1 && prC.h >= 1, JSON.stringify(prC));

// ── computeSize: фиксированная высота, ширина из аргумента ─────────────────
const cs = prev.computeSize(300);
check("computeSize(300) → [300, 200]", Array.isArray(cs) && cs[0] === 300 && cs[1] === 200,
  JSON.stringify(cs));
const cs2 = prev.computeSize(undefined);
check("computeSize(undefined) не падает и даёт высоту 200",
  Array.isArray(cs2) && cs2[1] === 200, JSON.stringify(cs2));
check("высота предпросмотра — константа, не функция от ширины",
  prev.computeSize(50)[1] === prev.computeSize(600)[1]);

// ── раскладка Crop: fit-to-источник ────────────────────────────────────────
const box = { x: 0, y: 0, w: 100, h: 100 };
const lc = P.layoutCrop(box, 640, 480, 100, 50, 200, 150);
check("layoutCrop: scale = min(100/640, 100/480)", near(lc.scale, 100 / 640), String(lc.scale));
check("layoutCrop: источник вписан целиком (100×75)",
  near(lc.img.w, 100) && near(lc.img.h, 75), JSON.stringify(lc.img));
check("layoutCrop: источник отцентрирован по Y (12.5)", near(lc.img.y, 12.5), String(lc.img.y));
check("layoutCrop: окно = imgOrigin + win*scale",
  near(lc.win.x, 100 * lc.scale) && near(lc.win.y, 12.5 + 50 * lc.scale),
  JSON.stringify(lc.win));
check("layoutCrop: размер окна в пикселях предпросмотра",
  near(lc.win.w, 200 * lc.scale) && near(lc.win.h, 150 * lc.scale), JSON.stringify(lc.win));

// ── раскладка Expand: fit-to-целевой холст ────────────────────────────────
const le = P.layoutExpand(box, 640, 480, 10, 20, 800, 600);
check("layoutExpand: scale = min(100/800, 100/600)", near(le.scale, 100 / 800), String(le.scale));
check("layoutExpand: холст 800×600 → 100×75",
  near(le.out.w, 100) && near(le.out.h, 75), JSON.stringify(le.out));
check("layoutExpand: холст отцентрирован (by=12.5)", near(le.out.y, 12.5), String(le.out.y));
check("layoutExpand: источник внутри холста = imgOrigin*scale",
  near(le.img.x, 10 * le.scale) && near(le.img.y, 12.5 + 20 * le.scale), JSON.stringify(le.img));
check("layoutExpand: источник целиком (80×60)",
  near(le.img.w, 640 * le.scale) && near(le.img.h, 480 * le.scale), JSON.stringify(le.img));

const leNeg = P.layoutExpand(box, 640, 480, -100, -50, 800, 600);
check("layoutExpand: отрицательный сдвиг уводит источник левее холста",
  leNeg.img.x < leNeg.out.x, JSON.stringify([leNeg.img.x, leNeg.out.x]));

// ── fillStyle ──────────────────────────────────────────────────────────────
const fakeCtx = () => {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, a]); };
  return {
    calls,
    fillRect: rec("fillRect"),
    strokeRect: rec("strokeRect"),
    drawImage: rec("drawImage"),
    fillText: rec("fillText"),
    beginPath: rec("beginPath"),
    rect: rec("rect"),
    clip: rec("clip"),
    fill: rec("fill"),
    save: rec("save"),
    restore: rec("restore"),
    stroke: rec("stroke"),
    moveTo: rec("moveTo"),
    lineTo: rec("lineTo"),
    createPattern: () => null,
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", textBaseline: "",
    shadowColor: "", shadowBlur: 0,
  };
};
check("fillStyle(black) = #000000", P.fillStyle(fakeCtx(), "black") === "#000000");
check("fillStyle(white) = #ffffff", P.fillStyle(fakeCtx(), "white") === "#ffffff");
check("fillStyle(transpar....) не роняет", typeof P.fillStyle(fakeCtx(), "transparent") === "string");

// ── draw: без исключений, в координатах ноды ───────────────────────────────
let threw = null;
try {
  prev.draw(fakeCtx(), node, 300, 60);
} catch (e) { threw = e; }
check("draw() не бросает исключений", !threw, String(threw));

const ctx2 = fakeCtx();
prev.draw(ctx2, node, 300, 60);
const fills = ctx2.calls.filter((c) => c[0] === "fillRect");
check("draw(): залит фон предпросмотра", fills.length >= 1, JSON.stringify(fills.length));
check("draw(): первый fillRect начинается с y = 60 + MARGIN (координаты ноды)",
  fills.length >= 1 && fills[0][1][1] === 68, JSON.stringify(fills[0]?.[1]));
check("draw(): картинка нарисована", ctx2.calls.some((c) => c[0] === "drawImage"));
check("draw(): есть текстура-рамка (strokeRect)", ctx2.calls.some((c) => c[0] === "strokeRect"));
check("draw(): бейдж размера нарисован (текст «px»)", ctx2.calls.some(
  (c) => c[0] === "fillText" && String(c[1][0]).includes("px")));
check("draw(): раскладка сохранена в node._deggLayout",
  !!node._deggLayout && node._deggLayout.scale > 0);
check("draw(): previewArea = бокс источника в режиме Crop",
  !!node.previewArea && node._deggLayout.mode === "crop");

// без картинки — заглушка, без падения
const node2 = makeNode("Expand");
node2.widgets.forEach((x) => { if (x.name === "width") x.value = 64; });
node2.widgets.forEach((x) => { if (x.name === "height") x.value = 64; });
node2.widgets.forEach((x) => { if (x.name === "fill_color") x.value = "white"; });
node2.imgs = [];
node2.onNodeCreated();
const prev2 = node2.widgets.find((x) => x && x.name === "degg_crop_preview");
const ctxEmpty = fakeCtx();
let threw2 = null;
try { prev2.draw(ctxEmpty, node2, 300, 0); } catch (e) { threw2 = e; }
check("draw() без картинки не падает", !threw2, String(threw2));
check("draw() без картинки пишет заглушку",
  ctxEmpty.calls.some((c) => c[0] === "fillText"));
check("draw() без картинки не оставляет раскладку", !node2._deggLayout);

// ── раскладка ноды: режимы Crop/Expand ─────────────────────────────────────
{
  const L = P.computeLayout({ x: 8, y: 68, w: 284, h: 184 }, node);
  check("computeLayout(Crop) даёт source-координаты: origin = img",
    L.mode === "crop" && near(L.scale, 184 / 480, 1e-6), JSON.stringify(L.scale));
  check("computeLayout(Crop): sel = окно виджетов (512×512@0,0)",
    L.sel.x === 0 && L.sel.y === 0 && L.sel.w === 512 && L.sel.h === 512, JSON.stringify(L.sel));
  check("computeLayout(Crop): win = {27.33, 68, 196.27, 196.27}",
    near(L.win.x, 27.3333, 1e-3) && near(L.win.y, 68, 1e-9)
    && near(L.win.w, 196.2667, 1e-3) && near(L.win.h, 196.2667, 1e-3), JSON.stringify(L.win));
}

// ── мышь: drag «move» рамки окна (контрольный пример §9) ──────────────────
{
  node.widgets.forEach((x) => {
    if (["x", "y"].includes(x.name)) x.value = 0;
    if (["width", "height"].includes(x.name)) x.value = 512;
    ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => {
      if (x.name === n) x.value = 0;
    });
  });
  const ctx3 = fakeCtx();
  prev.draw(ctx3, node, 300, 60);   // box = {8,68,284,184}, scale = 184/480

  const hit = P.getHitArea(node, [125, 166]);
  check("getHitArea: центр рамки → 'move'", hit === "move", String(hit));

  prev.mouse({ type: "mousedown", buttons: 1 }, [125, 166], node);
  prev.mouse({ type: "mousemove", buttons: 1 }, [145, 166], node);
  check("drag move: x === 52 (контроль §9)",
    byName(node, "x").value === 52, String(byName(node, "x").value));
  check("drag move: y не сдвинулся", byName(node, "y").value === 0, String(byName(node, "y").value));
  prev.mouse({ type: "mouseup", buttons: 0 }, [145, 166], node);
  check("mouseup завершает drag и чистит состояние", node._deggDrag === null);
}

// ── Expand: hit-зона ограничена previewArea, window → только move ─────────
{
  const node3 = makeNode("Expand");
  node3.imgs = [{ src: "http://127.0.0.1:8188/view?filename=b.png&type=output&subfolder=" }];
  node3.widgets.forEach((x) => {
    if (x.name === "x") x.value = -100;
    if (x.name === "y") x.value = 0;
    if (x.name === "width") x.value = 640;
    if (x.name === "height") x.value = 480;
  });
  node3.onNodeCreated();
  const prev3 = node3.widgets.find((x) => x && x.name === "degg_crop_preview");
  prev3.draw(fakeCtx(), node3, 300, 60);
  const L3 = node3._deggLayout;
  check("Expand: раскладка режима expand + previewArea = холст",
    L3 && L3.mode === "expand" && node3.previewArea
    && node3.previewArea.x === L3.out.x && node3.previewArea.width === L3.out.w
    && node3.previewArea.height === L3.out.h);
  check("previewArea нормализован в width/height (иначе границы = NaN)",
    typeof node3.previewArea.width === "number" && typeof node3.previewArea.height === "number"
    && node3.previewArea.width > 0 && node3.previewArea.height > 0,
    JSON.stringify(node3.previewArea));
  check("getHitArea: точка далеко за пределами предпросмотра → null",
    P.getHitArea(node3, [-5000, -5000]) === null);
  check("Expand-window: hit вне previewArea (левый край контента) → null",
    P.getHitArea(node3, [L3.content.x, L3.content.y + L3.content.h / 2]) === null,
    JSON.stringify([L3.content.x, L3.out.x]));
  check("Expand-window: центр previewArea → 'move'",
    P.getHitArea(node3, [L3.out.x + L3.out.w / 2, L3.out.y + L3.out.h / 2]) === "move");

  // drag в Expand сдвигает позицию вставки (x/y), а не размеры
  const x0 = byName(node3, "x").value;
  prev3.mouse({ type: "mousedown", buttons: 1 },
    [L3.out.x + L3.out.w / 2, L3.out.y + L3.out.h / 2], node3);
  prev3.mouse({ type: "mousemove", buttons: 1 },
    [L3.out.x + L3.out.w / 2 + 20, L3.out.y + L3.out.h / 2], node3);
  check("Expand-window drag сдвигает x (позиция вставки)",
    byName(node3, "x").value > x0, `${x0} → ${byName(node3, "x").value}`);
  check("Expand drag не трогает width/height",
    byName(node3, "width").value === 640 && byName(node3, "height").value === 480);
  prev3.mouse({ type: "mouseup", buttons: 0 },
    [L3.out.x + 20, L3.out.y], node3);
}

// ── пресеты: 16:9 из окна 512×512@0,0 → 640×360 @ (0,76) ──────────────────
{
  node.widgets.forEach((x) => {
    if (["x", "y"].includes(x.name)) x.value = 0;
    if (["width", "height"].includes(x.name)) x.value = 512;
    ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => {
      if (x.name === n) x.value = 0;
    });
    if (x.name === "ratio_lock") x.value = false;
    if (x.name === "resolution_mp") x.value = 0;
  });
  byName(node, "Ratio Presets").callback("16:9");
  check("пресет 16:9: aspect_ratio === '16:9'",
    byName(node, "aspect_ratio").value === "16:9", String(byName(node, "aspect_ratio").value));
  check("пресет 16:9: width = 640", byName(node, "width").value === 640,
    String(byName(node, "width").value));
  check("пресет 16:9: height = 360", byName(node, "height").value === 360,
    String(byName(node, "height").value));
  check("пресет 16:9: x = 0, y = 76 (центр окна)",
    byName(node, "x").value === 0 && byName(node, "y").value === 76,
    JSON.stringify([byName(node, "x").value, byName(node, "y").value]));
  check("пресет 16:9: Ratio Presets синхронизирован",
    byName(node, "Ratio Presets").value === "16:9", String(byName(node, "Ratio Presets").value));

  // fullImage → весь источник
  byName(node, "Full Image").callback();
  check("Full Image: width/height = 640/480",
    byName(node, "width").value === 640 && byName(node, "height").value === 480,
    JSON.stringify([byName(node, "width").value, byName(node, "height").value]));
  // Crop-window: пост-синк зовёт syncAspectDisplay → пропорция 640/480 совпадает
  // с пресетом 4:3, поэтому aspect_ratio нормализуется к пресету (как в OREX).
  check("Full Image: aspect_ratio нормализован к пресету 4:3",
    byName(node, "aspect_ratio").value === "4:3", String(byName(node, "aspect_ratio").value));
  check("Full Image: пропорция aspect_ratio ≈ 640/480",
    near(P.parseRatio(byName(node, "aspect_ratio").value), 640 / 480, 1e-4));

  // pythonTarget = точный выход python
  byName(node, "resolution_mp").value = 2;
  const tgt = P.pythonTarget(node);
  check("pythonTarget(mp=2) на холсте 640×480 → [1632, 1232]",
    tgt[0] === 1632 && tgt[1] === 1232, JSON.stringify(tgt));
  byName(node, "resolution_mp").value = 0;
  const tgt0 = P.pythonTarget(node);
  check("pythonTarget без mp и crop_% = размеры виджетов",
    tgt0[0] === 640 && tgt0[1] === 480, JSON.stringify(tgt0));
}

// ── Crop + проценты: width/height считаются только здесь ───────────────────
{
  node.widgets.forEach((x) => {
    if (x.name === "crop_left") x.value = 10;
    if (x.name === "crop_right") x.value = 10;
    if (x.name === "crop_top") x.value = 10;
    if (x.name === "crop_bottom") x.value = 10;
    if (x.name === "multiplicity") x.value = 16;
    if (x.name === "resolution_mp") x.value = 0;
  });
  P.syncCropDisplays(node);
  check("syncCropDisplays(Crop+10%) → 512×384 (кратно 16)",
    byName(node, "width").value === 512 && byName(node, "height").value === 384,
    JSON.stringify([byName(node, "width").value, byName(node, "height").value]));
  const sel = P.getSel(node);
  check("getSel(Crop+pct) = percentRectFromMargins",
    sel.x === 64 && sel.y === 48 && sel.w === 512 && sel.h === 384, JSON.stringify(sel));

  // Expand никогда не правит width/height от rect
  node.widgets.forEach((x) => { if (x.name === "operation") x.value = "Expand"; });
  byName(node, "width").value = 777;
  byName(node, "height").value = 555;
  P.syncCropDisplays(node);
  check("syncCropDisplays(Expand) — no-op (width/height не тронуты)",
    byName(node, "width").value === 777 && byName(node, "height").value === 555);
  node.widgets.forEach((x) => { if (x.name === "operation") x.value = "Crop"; });
  node.widgets.forEach((x) => {
    ["crop_left", "crop_right", "crop_top", "crop_bottom"].forEach((n) => {
      if (x.name === n) x.value = 0;
    });
  });
  byName(node, "width").value = 512;
  byName(node, "height").value = 512;
}

// ── ветки onWidgetChanged ──────────────────────────────────────────────────
{
  const d0 = node.dirty;
  node.onWidgetChanged("x", 1, 0, "x", {});
  check("onWidgetChanged валит canvas", node.dirty > d0, String(node.dirty - d0));

  byName(node, "ratio_lock").value = true;
  const d1 = node.dirty;
  let threwLock = null;
  try { node.onWidgetChanged("crop_left", 10, 0, "crop_left", {}); } catch (e) { threwLock = e; }
  check("onWidgetChanged(crop_left) при lock ON — no-throw", !threwLock, String(threwLock));
  check("onWidgetChanged(crop_left) при lock ON валит canvas", node.dirty > d1);
  byName(node, "ratio_lock").value = false;

  const d2 = node.dirty;
  node.onWidgetChanged("width", 1000, 512, "width", {});
  check("onWidgetChanged(width): округление до multiplicity (992)",
    byName(node, "width").value === 992, String(byName(node, "width").value));
  check("onWidgetChanged(width) валит canvas", node.dirty > d2);

  const d3 = node.dirty;
  node.onWidgetChanged("operation", "Expand", "Crop", "operation", {});
  check("onWidgetChanged(operation) валит canvas", node.dirty > d3);
  byName(node, "operation").value = "Crop";
  byName(node, "width").value = 512;
  byName(node, "height").value = 512;
}

// ── кнопка Load Image без document: no-throw ──────────────────────────────
{
  check("в смоуке нет document (заглушки минимальны)",
    typeof sandbox.document === "undefined");
  let threwLoad = null;
  try { byName(node, "Load Image").callback(); } catch (e) { threwLoad = e; }
  check("Load Image callback без document — no-throw", !threwLoad, String(threwLoad));
}

// ── перерисовка на событиях ────────────────────────────────────────────────
const d1 = node.dirty;
node.onExecuted({});
check("onExecuted валит canvas", node.dirty > d1, String(node.dirty - d1));

const d2 = node.dirty;
node.onConfigure({});
check("onConfigure валит canvas", node.dirty > d2, String(node.dirty - d2));

const d3 = node.dirty;
node.onConnectionsChange(1, 0, true, {});
check("onConnectionsChange валит canvas", node.dirty > d3, String(node.dirty - d3));

const d4 = node.dirty;
capturedExt.loadedGraphNode(node);
check("loadedGraphNode валит canvas", node.dirty > d4, String(node.dirty - d4));
check("loadedGraphNode чужой ноду не трогает", (() => {
  const before = node.dirty;
  capturedExt.loadedGraphNode({ comfyClass: "Other" });
  return node.dirty === before;
})());

// ── getImageUrl ────────────────────────────────────────────────────────────
check("getImageUrl берёт node.imgs", P.getImageUrl(node) === node.imgs[0].src,
  String(P.getImageUrl(node)));
check("getImageUrl без картинки → null", P.getImageUrl({ id: 1, inputs: [] }) === null);
check("getImageUrl упирается в глубину, не падает", P.getImageUrl(null) === null);

// graph.links — Map у реального фронтенда (bundle: `links:new Map`).
// Статический доступ links[id] всегда undefined → превью не находило
// LoadImage и показывало «No image» даже при подключённом входе.
{
  const loadNode = {
    id: 7, type: "LoadImage",
    widgets: [{ name: "image", value: "shot.png" }],
    inputs: [],
  };
  const prevGraph = appInstance.graph;
  appInstance.graph = {
    links: new Map([[11, { origin_id: 7, origin_slot: 0, target_id: 3, target_slot: 0 }]]),
    getNodeById: (id) => (id === 7 ? loadNode : null),
  };
  const url = P.getImageUrl({ id: 3, comfyClass: "DeggCrop",
    inputs: [{ name: "image", link: 11 }] });
  check("getImageUrl идёт по graph.links (Map) → LoadImage",
    typeof url === "string" && url.includes("filename=shot.png")
      && url.includes("type=input"), String(url));
  appInstance.graph = prevGraph;
}

console.log("");
console.log(`ok: ${oks.length}   FAIL: ${errors.length}`);
if (errors.length) {
  errors.forEach((e) => console.log("  - " + e));
  console.log("SMOKE FAILED");
  process.exit(1);
}
console.log("SMOKE OK");
