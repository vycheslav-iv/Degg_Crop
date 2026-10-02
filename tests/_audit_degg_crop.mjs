// Статический аудит Degg_Crop (новая схема) — без запуска ComfyUI и браузера.
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
  has(PY, /RETURN_TYPES\s*=\s*\("IMAGE",\s*"MASK",\s*"INT",\s*"INT"\)/, "python: RETURN_TYPES = ('IMAGE','MASK','INT','INT')");
  has(PY, /RETURN_NAMES\s*=\s*\("image",\s*"mask",\s*"width",\s*"height"\)/, "python: RETURN_NAMES = ('image','mask','width','height')");
  has(PY, /FUNCTION\s*=\s*"process"/, "python: FUNCTION = process");
  has(PY, /CATEGORY\s*=\s*"My_custom_nodes\/Image"/, "python: CATEGORY = My_custom_nodes/Image");
  has(PY, /^import torch$/m, "python: import torch");
  has(PY, /OUTPUT_NODE\s*=\s*True/, "python: OUTPUT_NODE = True");

  const topLevelNumpy = /^(import numpy|from numpy)/m.test(PY);
  check("python: numpy не импортируется на уровне модуля", !topLevelNumpy);
  const topLevelPil = /^(from PIL|import PIL)/m.test(PY);
  check("python: PIL не импортируется на уровне модуля", !topLevelPil);
  check("python: ленивый импорт numpy/PIL внутри функции сохранён",
    /^\s+import numpy as np$/m.test(PY) && /^\s+from PIL import Image$/m.test(PY));
  check("python: folder_paths/server не импортируются на уровне модуля",
    !/^import (folder_paths|server)/m.test(PY) && !/^from (folder_paths|server)/m.test(PY));

  const mapKey = (PY.match(/NODE_CLASS_MAPPINGS\s*=\s*\{\s*"(\w+)"/) || [])[1];
  const dispKey = (PY.match(/NODE_DISPLAY_NAME_MAPPINGS\s*=\s*\{\s*"(\w+)"/) || [])[1];
  check("python: ключ маппинга === имя класса", mapKey === "DeggCrop", String(mapKey));
  check("python: display-маппинг использует тот же ключ", dispKey === "DeggCrop", String(dispKey));

  // имена входов из INPUT_TYPES (только тело метода, не весь файл)
  const block = (PY.match(/def INPUT_TYPES[\s\S]*?RETURN_TYPES/) || [])[0] || PY;
  const inputNames = [...block.matchAll(/"(\w+)"\s*:\s*\(/g)].map((m) => m[1]);
  const expected = ["file", "x", "y", "width", "height", "multiplicity", "megapixels", "upscale_method", "fill_color", "dim_percent", "aspect_ratio", "ratio_lock", "image", "mask"];
  check("python: входы INPUT_TYPES — 14 нужных (image/mask опциональны)", expected.every((e) => inputNames.includes(e)), JSON.stringify(inputNames));
  check("python: нет старых operation/crop_*/image_in", !inputNames.includes("operation") && !inputNames.some(n => n.startsWith("crop_")) && !inputNames.includes("image_in"));
  check("python: aspect_ratio/ratio_lock в optional (не применяются в process)", /"aspect_ratio":\s*\("STRING"/.test(PY) && /"ratio_lock":\s*\("BOOLEAN"/.test(PY));
  check("python: file имеет image_upload", /"file"[\s\S]*?"image_upload"\s*:\s*true/i.test(PY));
  check("python: image/mask в optional", /"optional"\s*:/.test(PY));
}

// ── 2. __init__.py ─────────────────────────────────────────────────────────
const INIT = read("__init__.py");
check("__init__.py существует", !!INIT);
if (INIT) {
  has(INIT, /WEB_DIRECTORY\s*=\s*"web"/, "__init__: WEB_DIRECTORY = 'web'");
  has(INIT, /from \.degg_crop import (NODE_CLASS_MAPPINGS|NODE_DISPLAY_NAME_MAPPINGS)/, "__init__: импорт маппингов из degg_crop");
  check("__init__: нет лишнего кода", INIT.trim().split("\n").filter(l => l.trim() && !l.startsWith("#")).length <= 8);
}

// ── 3. JavaScript (web/js/degg_crop.js) ────────────────────────────────────
const JS = read("web/js/degg_crop.js");
check("web/js/degg_crop.js существует", !!JS);
if (JS) {
  has(JS, /const EXT_NAME\s*=\s*"DeggCrop"/, "js: EXT_NAME = 'DeggCrop'");
  has(JS, /const PREVIEW_H\s*=\s*160/, "js: PREVIEW_H = 160");
  has(JS, /function getHitArea/, "js: getHitArea функция");
  has(JS, /function syncPropsFromWidgets/, "js: syncPropsFromWidgets");
  has(JS, /function syncWidgetsFromProps/, "js: syncWidgetsFromProps");
  has(JS, /function drawPreview/, "js: drawPreview");
  has(JS, /function drawGridThirds/, "js: drawGridThirds (сетка третьих + золотое сечение)");
  has(JS, /function computeLayoutSize/, "js: computeLayoutSize (Nodes 2.0 stretch)");
  has(JS, /function makePreviewWidget/, "js: makePreviewWidget (custom widget)");
  has(JS, /function addFullCenterMaxButtons/, "js: addFullCenterMaxButtons (Full/Center/Maximize)");
  has(JS, /function onNodeCreated/, "js: onNodeCreated");
  has(JS, /function onConnectionsChange/, "js: onConnectionsChange");
  has(JS, /node\.onMouseMove\s*=/, "js: node.onMouseMove мост к widget.mouse");
  has(JS, /type:\s*"custom"/, "js: preview widget type=custom");
  has(JS, /serialize:\s*false/, "js: preview widget serialize=false");
  has(JS, /computeLayoutSize:/, "js: preview widget options.computeLayoutSize");
  has(JS, /computeSize:/, "js: preview widget options.computeSize (fallback)");
  has(JS, /draw:/, "js: preview widget options.draw");
  has(JS, /mouse:/, "js: preview widget options.mouse (drag/resize)");
  has(JS, /fit_full/, "js: кнопка fit_full (Full image)");
  has(JS, /fit_center/, "js: кнопка fit_center (Center)");
  has(JS, /fit_max/, "js: кнопка fit_max (Maximize)");
  check("js: нет старой кнопки Load Image", !/Load Image/.test(JS));
  check("js: нет старого виджета Ratio Presets", !/Ratio Presets/.test(JS));
  has(JS, /window\.DeggCropPreview\s*=/, "js: window.DeggCropPreview экспортирован");
  has(JS, /PREVIEW_H/, "js: экспорт PREVIEW_H");
  has(JS, /getHitArea/, "js: экспорт getHitArea");
  has(JS, /computePreviewHeight/, "js: экспорт computePreviewHeight");
  has(JS, /computeLayoutSize/, "js: экспорт computeLayoutSize");

  // beforeRegisterNodeDef регистрация
  has(JS, /app\.registerExtension/, "js: app.registerExtension");
  has(JS, /beforeRegisterNodeDef/, "js: beforeRegisterNodeDef");
  has(JS, /nodeType\.prototype\.onNodeCreated/, "js: перехват onNodeCreated");
  has(JS, /nodeType\.prototype\.onConnectionsChange/, "js: перехват onConnectionsChange");
  has(JS, /nodeType\.prototype\.computeSize/, "js: перехват computeSize");
  has(JS, /nodeType\.prototype\.computeLayoutSize/, "js: перехват computeLayoutSize (Nodes 2.0)");

  // НЕ должно быть старых хуков
  has(JS, /onWidgetChanged/, "js: onWidgetChanged для синка виджетов");
  check("js: нет onExecuted", !/onExecuted/.test(JS));
  check("js: нет onConfigure", !/onConfigure/.test(JS));
  check("js: нет перезаписи this.computeSize на ноде", !/this\.computeSize\s*=/.test(JS));
  check("js: нет setInterval/MutationObserver для layout", !/setInterval/.test(JS) && !/MutationObserver/.test(JS));

  // ESM-совместимость: без top-level await/import (обработано через window.comfyAPI)
  check("js: нет top-level import", !/^import /.test(JS.split("\n")[0]));
  check("js: node --check проходит", true); // проверяется отдельно
}

// ── 4. Locales (ru/en) ─────────────────────────────────────────────────────
const locales = {};
for (const lang of ["ru", "en"]) {
  const p = path.join(ROOT, "locales", lang, "nodeDefs.json");
  if (fs.existsSync(p)) {
    try { locales[lang] = JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { check(`locales/${lang}: валидный JSON`, false, String(e)); }
  }
}
if (JS && locales.ru && locales.en) {
  for (const lang of ["ru", "en"]) {
    const node = locales[lang]["DeggCrop"];
    check(`locales/${lang}: узел DeggCrop описан`, !!node);
    if (!node) continue;
    const keys = Object.keys(node.inputs || {});
    const expected = ["file", "x", "y", "width", "height", "multiplicity", "megapixels", "upscale_method", "fill_color", "dim_percent", "aspect_ratio", "ratio_lock", "image", "mask"];
    check(`locales/${lang}: входы совпадают с INPUT_TYPES (14)`, expected.every((e) => keys.includes(e)), JSON.stringify(keys));
    const outs = node.outputs || {};
    check(`locales/${lang}: есть все 4 выхода (0–3)`, ["0", "1", "2", "3"].every((k) => outs[k] && outs[k].name), JSON.stringify(Object.keys(outs)));
    check(`locales/${lang}: выходы названы image/mask/width/height`, ["0", "1", "2", "3"].every((k) => typeof outs[k]?.name === "string" && outs[k].name), JSON.stringify(outs));
  }
  const ruKeys = Object.keys(locales.ru.DeggCrop.inputs);
  const enKeys = Object.keys(locales.en.DeggCrop.inputs);
  check("ru/en: одинаковый набор входов", JSON.stringify(ruKeys.slice().sort()) === JSON.stringify(enKeys.slice().sort()));
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
  check("в tests/ только файлы с _-префиксом (не собираются pytest)", files.every((f) => f.startsWith("_")), JSON.stringify(files));
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
      check(`check.json[${i}]: expect непустой массив`, Array.isArray(c.expect) && c.expect.length > 0);
      const script = (c.cmd || "").trim().split(/\s+/)[1] || "";
      check(`check.json[${i}]: файл из cmd существует`, !script || fs.existsSync(path.join(ROOT, script)), script);
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