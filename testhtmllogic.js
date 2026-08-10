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
const ids = ["dz1","file1","status1","dz2","file2","status2","dz3","file3","status3","btnReset","btnTheme","searchDetalle",
  "tooltip","filters","kpiRow","chartTopProduccion","chartTopMerma","chartDisponibilidad","chartTendencia",
  "tableLinea","tableArticulo","parosGrid","parosEmpty","chartParosPareto","chartDisponibilidadTurnos","diag",
  "topbar","tabbar","views","welcome","uploadSection","datosSlot","alertList","tabBadgeAlertas","alertasSub",
  "ajustesBody","periodoControls","periodoLabel","alcanceLabel","histSliderActive","histLevelTurno","app",
  "paroKpiRow","motivosGrid","motivosEmpty","chartParetoMotivos","chartParosLinea","tableParoOf","countParoOf","parosHint"];
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
  location: { reload() {} },
  // Sin esto loadSettings/loadPersonal escupen un ReferenceError en cada arranque
  // y ensucian la salida del test con ruido que no es un fallo real.
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }
};
vm.createContext(sandbox);
vm.runInContext(scriptSrc, sandbox, { filename: "index.html#script" });

// Las declaraciones `const`/`let` del script viven en el ámbito léxico del
// contexto, no como propiedades del sandbox (a diferencia de las `function`),
// así que para llegar a `state` y compañía hay que evaluar en el mismo contexto.
const ctx = expr => vm.runInContext(expr, sandbox);

// --- Ahora probamos las funciones expuestas globalmente en el sandbox ---
const PRODUCT_REPORT = __dirname + "/testdata/ProductReport.csv";

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

/* ============================================================
   His_Paro_Groups — motivos de parada y Pareto
   ============================================================ */

let fallos = 0;
function check(nombre, ok, detalle) {
  console.log((ok ? "  OK   " : "  FALLA") + "  " + nombre + (detalle !== undefined ? "  -> " + detalle : ""));
  if (!ok) fallos++;
}

console.log("\n\n=== His_Paro_Groups ===");
const PARO_CSV = __dirname + "/testdata/His_Paro_Groups.csv";
const paroText = sandbox.decodeBuffer(new Uint8Array(fs.readFileSync(PARO_CSV)));
const paroDelim = sandbox.sniffDelimiter(paroText.slice(0, paroText.indexOf("\n")));
const paroParsed = sandbox.rowsToObjects(sandbox.parseCsv(paroText, paroDelim));
console.log("Delimitador:", JSON.stringify(paroDelim), "| cabeceras:", paroParsed.header.length, "| filas:", paroParsed.dataRows.length);

const { rows: paroRows, skipped: paroSkipped } = sandbox.mapParoRows(paroParsed.header, paroParsed.index, paroParsed.dataRows);
check("mapParoRows mapea las 2.059 filas sin descartar ninguna", paroRows.length === 2059 && paroSkipped === 0,
  paroRows.length + " filas, " + paroSkipped + " descartadas");

// Todos los campos clave deben venir informados: si Mapex cambiara un nombre de
// columna, esto lo caza antes de que el Pareto salga vacío en el navegador.
const sinMotivo = paroRows.filter(r => !r.motivo).length;
const sinOf = paroRows.filter(r => !r.of).length;
const sinTurno = paroRows.filter(r => !r.turno).length;
const sinSeg = paroRows.filter(r => !(r.segundos > 0)).length;
const sinFin = paroRows.filter(r => !r.inicio || !r.fin).length;
check("todas las filas traen motivo, OF, turno, duración y horas", sinMotivo + sinOf + sinTurno + sinSeg + sinFin === 0,
  `sin motivo ${sinMotivo}, sin OF ${sinOf}, sin turno ${sinTurno}, sin duración ${sinSeg}, sin horas ${sinFin}`);

// TIEMPO TOTAL tiene que ser exactamente (A - De): si no, los minutos del
// Pareto no son minutos reales.
const descuadres = paroRows.filter(r => Math.abs((r.fin - r.inicio) / 1000 - r.segundos) > 1).length;
check("TIEMPO TOTAL coincide con (A - De)", descuadres === 0, descuadres + " descuadres");
const descuadreOee = paroRows.filter(r => Math.abs(r.segundos - (r.segDisponibilidad + r.segProgramado + r.segNoAfectaOee)) > 0.5).length;
check("TIEMPO TOTAL = DISPONIBILIDAD + PROGRAMADO + NO AFECTA OEE", descuadreOee === 0, descuadreOee + " descuadres");

// Turnos: 2-MAÑANA -> manana, 3-TARDE/1-NOCHE -> tarde
const turnos = {};
paroRows.forEach(r => { const k = r.turnoRaw + " -> " + r.turno; turnos[k] = (turnos[k] || 0) + 1; });
console.log("  Mapeo de turnos:", JSON.stringify(turnos));
check("1-NOCHE se pliega en 'tarde'", paroRows.filter(r => r.turnoRaw === "1-NOCHE").every(r => r.turno === "tarde"));

// Averías vs ajustes
const averias = paroRows.filter(r => r.esAveria);
check("60 filas marcadas como avería (AVERÍAS (AV))", averias.length === 60, averias.length);
check("toda avería tiene un motivo que empieza por AVERÍA", averias.every(r => r.motivo.startsWith("AVER")));

// Deduplicado: volver a fusionar el mismo archivo no debe añadir ni una fila
const state = ctx("state");
const m1 = sandbox.mergeParoRows(paroRows);
const m2 = sandbox.mergeParoRows(paroRows);
check("mergeParoRows: 1ª carga añade todo, 2ª no duplica nada",
  m1.added === 2059 && m1.dup === 0 && m2.added === 0 && m2.dup === 2059,
  `1ª: +${m1.added}/${m1.dup} dup · 2ª: +${m2.added}/${m2.dup} dup`);
check("state.paroRows queda con 2.059 paradas", state.paroRows.length === 2059, state.paroRows.length);

// --- Pareto ---------------------------------------------------------------
const porMotivo = sandbox.withCumulative(sandbox.aggregateParos(paroRows, r => r.motivo));
console.log("\n--- Pareto de motivos (código real de index.html) ---");
porMotivo.forEach(m => console.log(
  "  " + String(Math.round(m.minutos)).padStart(5) + " min  " +
  String(m.paradas).padStart(4) + " paradas  " +
  m.acumPct.toFixed(1).padStart(5) + "% acum  " +
  (m.vital ? "[vital] " : "        ") + m.key));

check("15 motivos distintos", porMotivo.length === 15, porMotivo.length);
check("el motivo nº1 por TIEMPO es AJUSTE ETIQUETADORA", porMotivo[0].key === "AJUSTE ETIQUETADORA", porMotivo[0].key);
check("...aunque no es el más frecuente (ese es DISPENSADOR BANDEJAS)",
  [...porMotivo].sort((a, b) => b.paradas - a.paradas)[0].key === "AJUSTE DISPENSADOR BANDEJAS",
  "más frecuente: " + [...porMotivo].sort((a, b) => b.paradas - a.paradas)[0].key);
check("el % acumulado termina en 100", Math.abs(porMotivo[porMotivo.length - 1].acumPct - 100) < 0.001,
  porMotivo[porMotivo.length - 1].acumPct.toFixed(4));
const vitales = porMotivo.filter(m => m.vital);
check("6 'pocos vitales' cubren el 80%", vitales.length === 6, vitales.length + " motivos, " + vitales[vitales.length - 1].acumPct.toFixed(1) + "% acum");
check("los vitales son el bloque inicial (sin huecos)", porMotivo.findIndex(m => !m.vital) === vitales.length);

const totalSeg = paroRows.reduce((s, r) => s + r.segundos, 0);
const sumaPareto = porMotivo.reduce((s, m) => s + m.segundos, 0);
check("la suma del Pareto cuadra con el total de paradas", Math.abs(sumaPareto - totalSeg) < 0.001,
  (totalSeg / 3600).toFixed(1) + " h");

// --- Cruce con las OF de ProductReport ------------------------------------
const porOf = sandbox.aggregateParosPorOf(paroRows, productRows);
console.log("\n--- Cruce paradas <-> OF de ProductReport ---");
check("406 OF distintas con paradas", porOf.length === 406, porOf.length);
const sinCruce = porOf.filter(o => o.kg === null);
check("403 de 406 OF cruzan con ProductReport", porOf.length - sinCruce.length === 403,
  (porOf.length - sinCruce.length) + " cruzan, " + sinCruce.length + " no (" + sinCruce.map(o => o.of).join(", ") + ")");

// La línea de la parada tiene que ser la misma que la de la OF en ProductReport
const prPorOf = new Map();
productRows.forEach(r => { if (r.of && !prPorOf.has(r.of)) prPorOf.set(r.of, new Set()); if (r.of) prPorOf.get(r.of).add(r.linea); });
const lineaDistinta = porOf.filter(o => prPorOf.has(o.of) && !prPorOf.get(o.of).has(o.linea));
check("la línea de cada parada coincide con la de su OF en ProductReport", lineaDistinta.length === 0,
  lineaDistinta.length + " discrepancias");

check("las paradas por OF suman el total", Math.abs(porOf.reduce((s, o) => s + o.segundos, 0) - totalSeg) < 0.001);
console.log("  Top 5 OF por tiempo parado:");
porOf.slice(0, 5).forEach(o => console.log("   OF " + o.of + "  " + o.linea.padEnd(12) +
  String(Math.round(o.minutos)).padStart(4) + " min  " + String(o.paradas).padStart(3) + " paradas  " +
  (o.kg === null ? "(sin OF en ProductReport)" : Math.round(o.kg) + " kg") + "  · " + o.motivoTop));

// --- Filtros --------------------------------------------------------------
// getFilteredParoRows tiene que respetar fecha, área, línea, turno y tipo de día.
state.filters.desde = new Date(Date.UTC(2026, 6, 27));
state.filters.hasta = new Date(Date.UTC(2026, 7, 2));
state.filters.areas = new Set(paroRows.map(r => r.area));
state.filters.lineas = new Set(paroRows.map(r => r.linea));
state.filters.turno = "ambos";
state.filters.dia = "todos";
check("sin filtros restrictivos entran las 2.059 paradas", sandbox.getFilteredParoRows().length === 2059, sandbox.getFilteredParoRows().length);

state.filters.turno = "manana";
const soloManana = sandbox.getFilteredParoRows();
check("filtro Turno=Mañana da las 1.155 paradas de mañana (exacto, sin prorrateo)",
  soloManana.length === 1155 && soloManana.every(r => r.turno === "manana"), soloManana.length);

state.filters.turno = "tarde";
const soloTarde = sandbox.getFilteredParoRows();
check("filtro Turno=Tarde da 904 (897 tarde + 7 noche)", soloTarde.length === 904, soloTarde.length);
check("mañana + tarde = total (ninguna parada se pierde ni se cuenta dos veces)",
  soloManana.length + soloTarde.length === 2059);

state.filters.turno = "ambos";
state.filters.lineas = new Set(["N2_FIL_L15"]);
const soloL15 = sandbox.getFilteredParoRows();
check("filtro por línea N2_FIL_L15 da sus 302 paradas",
  soloL15.length === 302 && soloL15.every(r => r.linea === "N2_FIL_L15"), soloL15.length);

state.filters.lineas = new Set(paroRows.map(r => r.linea));
state.filters.dia = "finde";
const finde = sandbox.getFilteredParoRows();
check("filtro Día=Finde solo deja sábados y domingos",
  finde.every(r => [0, 6].includes(r.periodo.getUTCDay())), finde.length + " paradas");
state.filters.dia = "todos";

// --- Render completo ------------------------------------------------------
// Ejecuta toda la cadena de pintado contra el DOM simulado: si algún gráfico o
// tabla se cae (id inexistente, campo nulo…), salta aquí y no en producción.
try {
  sandbox.renderMotivos(sandbox.getFilteredParoRows(), productRows);
  const kpiHtml = elMap.paroKpiRow.innerHTML;
  const paretoHtml = elMap.chartParetoMotivos.innerHTML;
  const ofHtml = elMap.tableParoOf.innerHTML;
  check("renderMotivos pinta KPIs, Pareto y tabla de OF sin romperse",
    kpiHtml.includes("Tiempo total parado") && paretoHtml.includes("<svg") && ofHtml.includes("<table"));
  check("el Pareto dibuja la curva de % acumulado y la referencia del 80%",
    paretoHtml.includes("stroke-dasharray") && paretoHtml.includes("% acumulado"));
  check("los KPIs muestran el tiempo parado en h/min", kpiHtml.includes(" h ") , "94,9 h esperadas");
} catch (err) {
  check("renderMotivos no lanza excepción", false, err.message);
  console.error(err);
}

console.log(fallos === 0 ? "\n✅ Todas las comprobaciones pasan." : `\n❌ ${fallos} comprobación(es) fallan.`);
process.exit(fallos === 0 ? 0 : 1);
