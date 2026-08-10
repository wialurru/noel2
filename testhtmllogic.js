// Carga el <script> real de index.html en un sandbox Node con un DOM mínimo
// simulado, y ejecuta las funciones de negocio contra los CSV reales para
// verificar que el código que se va a servir en el navegador es correcto.
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("index.html", "utf8");
const scriptSrc = html.match(/<script>([\s\S]*)<\/script>/)[1];

function stubEl() {
  const el = {
    _html: "", _value: "", hidden: false, className: "", style: {}, dataset: {}, disabled: false, title: "",
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => stubEl(),
    closest: () => stubEl(), appendChild() {}, focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute() { return null; }
  };
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(v) { el._html = v; } });
  Object.defineProperty(el, "value", { get() { return el._value; }, set(v) { el._value = v; } });
  Object.defineProperty(el, "textContent", { get() { return el._text; }, set(v) { el._text = v; } });
  return el;
}

// Cualquier id devuelve un stub (getElementById nunca da null), así que esta
// lista solo existe para que los mismos nodos se reutilicen entre llamadas.
const ids = ["dz1","file1","status1","dz2","file2","status2","btnReset","btnTheme","searchDetalle",
  "tooltip","filters","kpiRow","chartTopProduccion","chartTopMerma","chartDisponibilidad","chartTendencia",
  "tableLinea","tableArticulo","parosGrid","parosEmpty","chartParosPareto","chartDisponibilidadTurnos","diag",
  "topbar","tabbar","views","welcome","uploadSection","datosSlot","alertList","tabBadgeAlertas","alertasSub",
  "ajustesBody","periodoControls","periodoLabel","alcanceLabel","histSliderActive","histLevelTurno","app"];
const elMap = {};
ids.forEach(id => elMap[id] = stubEl());

const documentStub = {
  getElementById: id => elMap[id] || (elMap[id] = stubEl()),
  documentElement: { getAttribute: () => null, setAttribute() {} },
  querySelectorAll: () => [],
  querySelector: () => stubEl(),
  addEventListener() {}
};

const sandbox = {
  console, document: documentStub, window: { matchMedia: () => ({ matches: false }) },
  TextDecoder, Uint8Array, Date, Math, Map, Set, JSON, parseFloat, Number, isNaN, Object,
  getComputedStyle: () => ({ getPropertyValue: () => "#000000" }),
  location: { reload() {} }
};
vm.createContext(sandbox);
vm.runInContext(scriptSrc, sandbox, { filename: "index.html#script" });

// --- Ahora probamos las funciones expuestas globalmente en el sandbox ---
const UPLOADS = "C:\\Users\\jupit\\.claude\\uploads\\4d134a0c-992f-42de-a9af-9c62487e173a\\";
const PRODUCT_REPORT = UPLOADS + "3893fe19-ProductReport.csv";

const buf = new Uint8Array(fs.readFileSync(PRODUCT_REPORT));
const text = sandbox.decodeBuffer(buf);
const delim = sandbox.sniffDelimiter(text.slice(0, text.indexOf("\n")));
console.log("Delimitador detectado:", JSON.stringify(delim));
const rows = sandbox.parseCsv(text, delim);
const { header, index, dataRows } = sandbox.rowsToObjects(rows);
console.log("Cabeceras:", header.length, "filas de datos:", dataRows.length);

const { rows: productRows, skipped } = sandbox.mapProductRows(header, index, dataRows);
console.log("Filas mapeadas:", productRows.length, "descartadas:", skipped);

const desde = new Date(Date.UTC(2026, 6, 27));
const hasta = new Date(Date.UTC(2026, 7, 2, 23, 59, 59));
const semana31 = productRows.filter(r => r.linea.startsWith("N2_FIL_") && r.periodo >= desde && r.periodo <= hasta);
console.log("Filas N2_FIL semana 31:", semana31.length);

const porLinea = sandbox.aggregateByLinea(semana31);
console.log("\n--- aggregateByLinea (código real de index.html) ---");
console.log("Objetivo PDF -> L14: 36.837 un/32.433 kg | L15: 66.856 un/34.593 kg (merma 2,11%/std 2,43%) | L16: 55.449 un/30.349 kg (merma 2,76%/std 2,36%)");
for (const l of porLinea) {
  console.log(l.linea, {
    uds: Math.round(l.uds), kg: Math.round(l.kg),
    mermaReal: l.mermaRealPct !== null ? +l.mermaRealPct.toFixed(2) : null,
    mermaStd: l.mermaStdPct !== null ? +l.mermaStdPct.toFixed(2) : null,
    desviacion: l.desviacionPct !== null ? +l.desviacionPct.toFixed(2) : null,
    disponibilidad: l.disponibilidad !== null ? +l.disponibilidad.toFixed(2) : null
  });
}

const porArticulo = sandbox.aggregateByArticulo(semana31);
console.log("\nArtículos únicos (línea+producto) en semana 31 N2_FIL:", porArticulo.length);
console.log("Total kg por artículos == total por línea?", Math.round(sum(porArticulo,'kg')) === Math.round(sum(porLinea,'kg')));
function sum(arr, k) { return arr.reduce((s,x)=>s+(x[k]||0),0); }

// isoWeekInfo check
const wk = sandbox.isoWeekInfo(new Date(Date.UTC(2026,6,31)));
console.log("\nisoWeekInfo(2026-07-31) ->", wk.year, "W"+wk.week, "monday=", wk.monday.toISOString().slice(0,10), "sunday=", wk.sunday.toISOString().slice(0,10));
