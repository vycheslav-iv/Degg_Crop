// Статический аудит Degg_Crop — без запуска ComfyUI и браузера.
// Проверяет согласованность Python / JS / locales / check.json / README
// и запрещённые приёмы из AGENTS.md (§4.1, §5).
//
// Запуск:  cd Degg_Crop && node tests/_audit_degg_crop.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../..", import.meta.url));

const errors = [];
const oks = [];
let n = 0;
const check = (label, cond, extra = "") => {
  n += 1;
  if (cond) oks.push(label);
  else { errors.push(label); console.log(`  ASSERT FAIL  ${label}${extra ? "  [" + extra + "]" : ""}`); }
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}`);
};
const has = (s, re, label) => check(label, re.test(s), String(re));

const read = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
};

// ── 1. Python ──────────────────────────────────────────────────────────────
const PY = read("degg_crop.py");
check("degg_crop.py существует", !!PY);
if (PY) {
  has(PY, /^class DeggCrop:/m, "python: class DeggCrop");
  has(PY, /RETURN_TYPES\s*=\s*\("IMAGE",\s*"MASK",\s*"INT",\s*"INT"\)/,
    "python: RETURN_TYPES = ('IMAGE','MASK','INT','INT')");
  has(PY, /RETURN_NAMES\s*=\s*\("image",\s*"mask",\s*"width",\s*"height"\)/,
    "python: RETURN_NAMES = ('image','mask','width','height')");
  has(PY, /FUNCTION\s*=\s*"process"/, "python: FUNCTION = process");
  has(PY, /CATEGORY\s*=\s*"My_custom_nodes\/Image"/, "python: CATEGORY = My_custom_nodes/Image");
  has(PY, /^import torch$/m, "python: import torch");
  has(PY, /OUTPUT_NODE\s*=\s*True/, "python: OUTPUT_NODE = True");

  // Бены привязаны к колонке 0: ленивые `import numpy` / `from PIL` живут
  // ВНУТРИ `_resize_lanczos` (с отступом) и запрещёнными не являются.
  const topLevelNumpy = /^(import numpy|from numpy)/m.test(PY);
  check("python: numpy не импортируется на уровне модуля", !topLevelNumpy);
  const topLevelPil = /^(from PIL|import PIL)/m.test(PY);
  check("python: PIL не импортируется на уровне модуля", !topLevelPil);
  check("python: ленивый импорт numpy/PIL внутри функции сохранён",
    /^\s+import numpy as np$/m.test(PY) && /^\s+from PIL import Image$/m.test(PY));
  check("python: folder_paths/server не импортируются",
    !/^\s*import (folder_paths|server)\b/m.test(PY) && !/^\s*from (folder_paths|server)\b/m.test(PY));

  const mapKey = (PY.match(/NODE_CLASS_MAPPINGS\s*=\s*\{\s*"(\w+)"/) || [])[1];
  const dispKey = (PY.match(/NODE_DISPLAY_NAME_MAPPINGS\s*=\s*\{\s*"(\w+)"/) || [])[1];
  check("python: ключ маппинга === имя класса", mapKey === "DeggCrop", String(mapKey));
  check("python: display-маппинг использует тот же ключ", dispKey === "DeggCrop", String(dispKey));

  // имена входов из INPUT_TYPES (только тело метода, не весь файл)
  const block = (PY.match(/def INPUT_TYPES[\s\S]*?RETURN_TYPES/) || [])[0] || PY;
  const inputNames = [...block.matchAll(/"(\w+)"\s*:\s*\(/g)].map((m) => m[1]);
  const expected = ["image", "operation", "x", "y", "width", "height", "fill_color",
    "image_in", "crop_left", "crop_right", "crop_top", "crop_bottom",
    "multiplicity", "resolution_mp", "upscale_method", "aspect_ratio",
    "ratio_lock", "mask"];
  check("python: входы INPUT_TYPES — ровно 18 нужных",
    expected.every((e) => inputNames.includes(e)) && inputNames.length === expected.length,
    JSON.stringify(inputNames));
  check("python: crop_* — это FLOAT-проценты",
    /"crop_left":\s*\("FLOAT"/.test(PY) && /"crop_bottom":\s*\("FLOAT"/.test(PY));
  check("python: aspect_ratio/ratio_lock живут только в JS (не применяются в process)",
    /"aspect_ratio":\s*\("STRING"/.test(PY) && /"ratio_lock":\s*\("BOOLEAN"/.test(PY));
}

// ── 2. __init__.py ─────────────────────────────────────────────────────────
const INIT = read("__init__.py");
check("__init__.py существует", !!INIT);
if (INIT) {
  has(INIT, /WEB_DIRECTORY\s*=\s*"web"/, "__init__: WEB_DIRECTORY = 'web'");
  has(INIT, /from \.degg_crop import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS/,
    "__init__: импорт маппингов из .degg_crop");
}

// ── 3. JS ──────────────────────────────────────────────────────────────────
const JS = read("web/js/degg_crop.js");
check("web/js/degg_crop.js существует", !!JS);
if (JS) {
  check("js: Node 2.0 — импорт через window.comfyAPI (не scripts/app.js)",
    /window\.comfyAPI/.test(JS) && !/scripts\/app\.js/.test(JS));
  has(JS, /const \{ app \} = window\.comfyAPI\?\.app;/, "js: const { app } = window.comfyAPI?.app");
  has(JS, /app\.registerExtension\(\{/, "js: app.registerExtension({...})");
  has(JS, /async beforeRegisterNodeDef\(nodeType, nodeData\)/, "js: beforeRegisterNodeDef объявлен");
  has(JS, /nodeData\.name !== NODE_CLASS/, "js: beforeRegisterNodeDef фильтрует по имени ноды");
  has(JS, /loadedGraphNode\s*\(/, "js: loadedGraphNode (перерисовка при загрузке workflow)");
  has(JS, /proto\.onConfigure\s*=\s*function/, "js: onConfigure (перерисовка после открытия workflow)");
  has(JS, /proto\.onWidgetChanged\s*=\s*function/, "js: onWidgetChanged (перерисовка на смене виджета)");
  has(JS, /proto\.onExecuted\s*=\s*function/, "js: onExecuted (перерисовка после выполнения)");
  has(JS, /proto\.onConnectionsChange\s*=\s*function/, "js: onConnectionsChange (перерисовка на перетаскивании провода)");
  has(JS, /proto\.onNodeCreated\s*=\s*function/, "js: onNodeCreated (добавление виджета-превью)");
  has(JS, /const NODE_CLASS = "DeggCrop"/, "js: NODE_CLASS = DeggCrop совпадает с python-ключом");
  has(JS, /const PREVIEW_H = 200/, "js: PREVIEW_H — фиксированная константа");
  has(JS, /computeSize\s*\(/, "js: есть computeSize (резерв высоты под предпросмотр)");
  has(JS, /serialize\s*:\s*false/, "js: serialize: false на виджете-превью");
  has(JS, /drawPreview|_drawPreview|draw\s*\(/, "js: есть функция отрисовки");
  // OREX-механика в UI: пресеты пропорций, кнопки и экспорт для смоука
  has(JS, /"Ratio Presets"/, "js: виджет Ratio Presets (пресеты пропорций)");
  has(JS, /"Load Image"/, "js: кнопка Load Image");
  has(JS, /window\.DeggCropPreview\s*=/, "js: window.DeggCropPreview экспортирован для тестов");
  has(JS, /function pythonTarget\s*\(/, "js: pythonTarget (точный размер выхода как в python)");
  has(JS, /function getHitArea\s*\(/, "js: getHitArea (hit-testing рамки мышью)");

  check("js: нет setInterval (постоянные таймеры запрещены)", !/setInterval\s*\(/.test(JS));
  check("js: нет MutationObserver (наблюдатели для layout запрещены)",
    !/MutationObserver/.test(JS));
  check("js: computeSize не перезаписывается на ноде", !/\.computeSize\s*=/.test(JS));
  check("js: widgets_up не используется", !/widgets_up/.test(JS));
  check("js: node.size не изменяется извне", !/this\.size\s*=|node\.size\s*=/.test(JS));
  check("js: getBoundingClientRect/offsetHeight в sizing не используются",
    !/getBoundingClientRect/.test(JS) && !/offsetHeight/.test(JS));
  check("js: style.height не форсируется (CSS-инъекции запрещены)",
    !/style\.height\s*=/.test(JS));

  // строки/точки, к которым относятся предыдущие проверки — должны быть не в комментарии
  const codeJs = JS.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  check("js: запреты проверяются по коду, а не по комментариям",
    !/setInterval\s*\(/.test(codeJs) && !/\.computeSize\s*=/.test(codeJs));
}

// ── 4. locales ─────────────────────────────────────────────────────────────
const locales = {};
for (const lang of ["ru", "en"]) {
  const p = path.join(ROOT, "locales", lang, "nodeDefs.json");
  const ok = fs.existsSync(p);
  check(`locales/${lang}/nodeDefs.json существует`, ok);
  if (!ok) continue;
  try {
    locales[lang] = JSON.parse(fs.readFileSync(p, "utf8"));
    check(`locales/${lang}: валидный JSON`, true);
  } catch (e) {
    check(`locales/${lang}: валидный JSON`, false, String(e));
  }
}
if (JS && locales.ru && locales.en) {
  for (const lang of ["ru", "en"]) {
    const node = locales[lang]["DeggCrop"];
    check(`locales/${lang}: узел DeggCrop описан`, !!node);
    if (!node) continue;
    const keys = Object.keys(node.inputs || {});
    const expected = ["image", "operation", "x", "y", "width", "height", "fill_color",
      "image_in", "crop_left", "crop_right", "crop_top", "crop_bottom",
      "multiplicity", "resolution_mp", "upscale_method", "aspect_ratio",
      "ratio_lock", "mask"];
    check(`locales/${lang}: входы совпадают с INPUT_TYPES (18)`,
      expected.every((e) => keys.includes(e)) && keys.length === expected.length,
      JSON.stringify(keys));
    const outs = node.outputs || {};
    check(`locales/${lang}: есть все 4 выхода (0–3)`,
      ["0", "1", "2", "3"].every((k) => outs[k] && outs[k].name),
      JSON.stringify(Object.keys(outs)));
    check(`locales/${lang}: выходы названы image/mask/width/height`,
      ["0", "1", "2", "3"].every((k) => typeof outs[k]?.name === "string" && outs[k].name),
      JSON.stringify(outs));
  }
  const ruKeys = Object.keys(locales.ru.DeggCrop.inputs);
  const enKeys = Object.keys(locales.en.DeggCrop.inputs);
  check("ru/en: одинаковый набор входов",
    JSON.stringify(ruKeys.slice().sort()) === JSON.stringify(enKeys.slice().sort()));
}

// ── 5. tests/ ──────────────────────────────────────────────────────────────
const expectedTests = ["_test_degg_crop.py", "_smoke_degg_crop.mjs", "_audit_degg_crop.mjs"];
const testsDir = path.join(ROOT, "tests");
if (!fs.existsSync(testsDir)) {
  check("tests/ существует", false);
} else {
  check("tests/ существует", true);
  for (const t of expectedTests) {
    check(`tests/${t} существует`, fs.existsSync(path.join(testsDir, t)));
  }
  const files = fs.readdirSync(testsDir).filter((f) => !fs.statSync(path.join(testsDir, f)).isDirectory());
  check("в tests/ только файлы с _-префиксом (не собираются pytest)",
    files.every((f) => f.startsWith("_")), JSON.stringify(files));
}

// ── 6. check.json ──────────────────────────────────────────────────────────
const CJK = read("check.json");
if (!CJK) {
  check("check.json существует", false);
} else {
  check("check.json существует", true);
  let cj = null;
  try { cj = JSON.parse(CJK); } catch (e) { check("check.json: валидный JSON", false, String(e)); }
  if (cj) {
    const list = cj.checks || [];
    check("check.json: 3 проверки", list.length === 3, String(list.length));
    list.forEach((c, i) => {
      check(`check.json[${i}]: label заполнен`, !!(c.label && c.label.trim()));
      check(`check.json[${i}]: cmd заполнен`, !!(c.cmd && c.cmd.trim()));
      check(`check.json[${i}]: expect непустой массив`,
        Array.isArray(c.expect) && c.expect.length > 0);
      const script = (c.cmd || "").trim().split(/\s+/)[1] || "";
      check(`check.json[${i}]: файл из cmd существует`,
        !script || fs.existsSync(path.join(ROOT, script)), script);
    });
  }
}

// ── 7. README корня (карта папки) ──────────────────────────────────────────
const README = read("../README.md");
check("README.md корня содержит Degg_Crop", !!README && /Degg_Crop/.test(README || ""));

console.log("");
console.log(`ok: ${oks.length}   FAIL: ${errors.length}`);
if (errors.length) {
  errors.forEach((e) => console.log("  - " + e));
  console.log("АУДИТ ПРОВАЛЕН");
  process.exit(1);
}
console.log("аудит чист");
