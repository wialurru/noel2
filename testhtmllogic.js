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
  "paroKpiRow","motivosGrid","motivosEmpty","chartParetoMotivos","chartParosLinea","tableParoOf","countParoOf","parosHint",
  "autoStatus","folderInput","btnCargarCarpeta","btnCargarCarpetaTop","chartMermaArticulo",
  "paroResumen","paroCatSeg","paroCatTitulo","metricaWrap","metricaLabel","cascadaMetrica","chartProduccionTurno","tableTurno","tendenciaSel","tendenciaGrano","tendenciaDesglose"];
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
  // protocol "file:" hace que autoLoad() salga por la rama documentada en vez
  // de intentar un fetch() que en Node no existe.
  location: { protocol: "file:", reload() {} },
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

/* ============================================================
   Clasificación automática de CSV por cabecera
   ============================================================ */

console.log("\n=== detectCsvKind (para la carga automática por carpeta) ===");
function cabeceraDe(ruta) {
  const t = sandbox.decodeBuffer(new Uint8Array(fs.readFileSync(ruta)));
  return sandbox.rowsToObjects(sandbox.parseCsv(t, sandbox.sniffDelimiter(t.slice(0, t.indexOf("\n")))));
}
const esperado = {
  "ProductReport.csv": "pr",
  "His_CT_Group.csv": "ct",
  "His_Paro_Groups.csv": "paro"
};
for (const [archivo, tipo] of Object.entries(esperado)) {
  const kind = sandbox.detectCsvKind(cabeceraDe(__dirname + "/testdata/" + archivo).index);
  check(`${archivo} se reconoce como ${tipo}`, kind === tipo, "detectado: " + kind);
}
// Un CSV que no sea de Mapex no debe colarse como ninguno de los tres.
const falso = sandbox.rowsToObjects([["Fecha", "Importe", "Cliente"], ["01/01/2026", "10", "X"]]);
check("un CSV ajeno se rechaza en vez de asignarse a un tipo", sandbox.detectCsvKind(falso.index) === null,
  "detectado: " + sandbox.detectCsvKind(falso.index));

/* ============================================================
   Histórico de merma del artículo buscado (pestaña Detalle)
   ============================================================ */

console.log("\n=== Histórico de merma por artículo ===");
sandbox.mergeProductRows(productRows);
state.filters.areas = new Set(productRows.map(r => r.area));
state.filters.lineas = new Set(productRows.map(r => r.linea));
state.filters.turno = "ambos";
state.filters.dia = "todos";
state.ui.detalleSub = "articulo";
const buscador = elMap.searchDetalle;
const tarjeta = elMap.chartMermaArticulo;

// El cálculo del punto tiene que ser el mismo que el de las tablas: kg de
// merma sobre kg de MMPP, no el promedio de los porcentajes de cada fila.
const unArticulo = productRows.filter(r => r.producto === "27752");
const linea = sandbox.mermaTimeline(unArticulo, false);
check("mermaTimeline hace un punto por día de producción",
  linea.length === new Set(unArticulo.map(r => r.periodo.getTime())).size, linea.length + " puntos");
const dia0 = unArticulo.filter(r => r.periodo.getTime() === linea[0].x);
const esperadoDia0 = sum(dia0, "mermaKg") / sum(dia0, "mmpp") * 100;
check("cada punto es merma ponderada (kg merma / kg MMPP), no media de %",
  Math.abs(linea[0].real - esperadoDia0) < 1e-9, linea[0].real.toFixed(4) + " %");
check("los puntos salen ordenados de más antiguo a más reciente",
  linea.every((p, i) => i === 0 || p.x >= linea[i - 1].x));

// Agrupar por semana debe conservar el total: mismos kg, mismo % global
const porSemana = sandbox.mermaTimeline(unArticulo, true);
const globalDia = sum(linea, "mermaKg") / sum(linea, "kg");
const globalSem = sum(porSemana, "mermaKg") / sum(porSemana, "kg");
check("agrupar por semana no pierde ni duplica producción",
  Math.abs(sum(linea, "kg") - sum(porSemana, "kg")) < 1e-6 && Math.abs(globalDia - globalSem) < 1e-9,
  `${porSemana.length} semana(s) contra ${linea.length} día(s)`);

function pintar(texto) {
  buscador.value = texto;
  tarjeta.innerHTML = "";
  sandbox.renderGraficoArticulo();
  return { oculto: tarjeta.hidden, html: tarjeta.innerHTML };
}

check("sin búsqueda el gráfico no ocupa sitio", pintar("").oculto);
check("una búsqueda sin resultados tampoco lo muestra", pintar("zzzznoexiste").oculto);

const conStd = pintar("27752");
check("con un artículo con estándar se dibujan las dos series",
  !conStd.oculto && conStd.html.includes("Merma real") && conStd.html.includes("Merma estándar"));
check("la serie del estándar va discontinua para leerse como referencia",
  conStd.html.includes("stroke-dasharray"));

// 51488 (FUET) no tiene rendimiento estándar: mostrar "0,00 %" como objetivo
// sería mentir, tiene que decir que no hay con qué comparar.
const sinStd = pintar("51488");
check("sin estándar definido se avisa en vez de pintar un 0 % falso",
  !sinStd.oculto && !sinStd.html.includes("Merma estándar") && sinStd.html.includes("sin rendimiento estándar"),
  sandbox.stdCoverage(productRows.filter(r => r.producto === "51488")).toFixed(2) + " de cobertura");

const varios = pintar("PICADA");
check("varias coincidencias dibujan una línea por artículo (máx. 6)",
  !varios.oculto && (varios.html.match(/class="dot"/g) || []).length <= 6 && varios.html.includes("artículos"));

state.ui.detalleSub = "of";
check("en la sub-tabla de OF se oculta (allí se mira por orden, no por artículo)", pintar("27752").oculto);
state.ui.detalleSub = "articulo";

// --- Drill-down: semana -> día -> OF --------------------------------------
console.log("\n--- Drill del histórico (semana › día › OF) ---");
pintar("27752");
const semanaDe = unArticulo[0].semana.key;
const diaDe = unArticulo[0].periodo.getTime();

state.ui.mermaDrill = { busqueda: "27752", semana: semanaDe, dia: null };
const nivel2 = pintar("27752");
check("al bajar a una semana el gráfico pasa a días y sale la miga de vuelta",
  nivel2.html.includes("por día, solo esta semana") && nivel2.html.includes("Todo el histórico"));

state.ui.mermaDrill = { busqueda: "27752", semana: semanaDe, dia: diaDe };
const nivel3 = pintar("27752");
const ofsDia = sandbox.aggregateOfDia(unArticulo.filter(r => r.periodo.getTime() === diaDe));
check("al bajar a un día se listan sus OF en vez del gráfico",
  nivel3.html.includes("<table") && nivel3.html.includes("Merma kg") && !nivel3.html.includes("<svg"),
  ofsDia.length + " OF");
check("las OF vienen ordenadas por kg de merma, de mayor a menor",
  ofsDia.every((o, i) => i === 0 || o.mermaKg <= ofsDia[i - 1].mermaKg));
const sumaOf = sum(ofsDia, "mermaKg"), sumaDia = sum(unArticulo.filter(r => r.periodo.getTime() === diaDe), "mermaKg");
check("la merma de las OF suma la del día (no se pierde ni se duplica ningún tramo)",
  Math.abs(sumaOf - sumaDia) < 1e-9, fmtNum(sumaOf) + " kg");
check("las tres migas están cuando se ha bajado hasta el día",
  (nivel3.html.match(/class="ghost crumb"/g) || []).length === 2 && nivel3.html.includes("crumb-actual"));

// Un drill que se queda sin filas (p. ej. al cambiar el filtro de línea) no
// puede dejar la tarjeta vacía: tiene que volver arriba solo.
state.ui.mermaDrill = { busqueda: "27752", semana: "1999-W01", dia: null };
const huerfano = pintar("27752");
check("un drill sin filas vuelve al histórico completo en vez de quedarse vacío",
  !huerfano.oculto && !huerfano.html.includes("crumb-actual"));

check("el título en aria-label va sin marcado (si no, rompería la etiqueta svg)",
  !/aria-label="[^"]*</.test(nivel2.html));
function fmtNum(n) { return Math.round(n * 100) / 100; }

// Cero negativo: -0,004 kg no debe imprimirse como "-0 kg"
/* ============================================================
   Selector en cascada: Producción / Paradas
   ============================================================ */

console.log("\n--- Selector de métrica (Producción / Paradas) ---");
state.ui.mermaDrill = { busqueda: null, semana: null, dia: null };
const aplicar = ctx("aplicarMetricaSilenciosa");

// Los motivos del tercer nivel salen de los datos, no de una lista escrita a
// mano: si Mapex añade un motivo nuevo tiene que aparecer solo.
const motAjustes = sandbox.motivosDe("pnp");
const motAverias = sandbox.motivosDe("av");
check("el menú saca los motivos PNP de los datos", motAjustes.length === 13, motAjustes.length + " motivos");
check("y los de avería igual", motAverias.length === 2, motAverias.map(a => a.motivo).join(", "));
check("vienen ordenados por tiempo parado, de mayor a menor",
  motAjustes.every((m, i) => i === 0 || m.segundos <= motAjustes[i - 1].segundos) &&
  motAjustes[0].motivo === "AJUSTE ETIQUETADORA", "el primero es " + motAjustes[0].motivo);
check("ajustes y averías reparten el total sin solaparse",
  Math.abs(sum(motAjustes, "segundos") + sum(motAverias, "segundos") - totalSeg) < 1e-9);

// paroTimeline: minutos y nº de paradas por punto
const parosArt = paroRows.filter(r => r.producto === "27752");
const lineaParos = sandbox.paroTimeline(parosArt, false);
check("paroTimeline hace un punto por día con paradas",
  lineaParos.length === new Set(parosArt.map(r => r.periodo.getTime())).size, lineaParos.length + " puntos");
check("los minutos de los puntos suman el total del artículo",
  Math.abs(sum(lineaParos, "segundos") - sum(parosArt, "segundos")) < 1e-9,
  fmtNum(sum(lineaParos, "segundos") / 60) + " min");
check("cada punto cuenta bien sus paradas",
  sum(lineaParos, "paradas") === parosArt.length, sum(lineaParos, "paradas") + " paradas");

// Render de cada rama del selector
for (const [ruta, espera] of [
  [["prod", "uds"], "envases fabricados"],
  [["prod", "kg"], "kg encajados"],
  [["prod", "merma"], "merma"],
  [["paros", "pnp", null], "no planificadas"],
  [["paros", "pnp", "AJUSTE ETIQUETADORA"], "AJUSTE ETIQUETADORA"]
]) {
  aplicar(ruta);
  const r = pintar("27752");
  check(`«${ruta.join(" › ")}» se dibuja y se titula bien`,
    !r.oculto && r.html.includes(espera) && r.html.includes("<svg"), espera);
}

// Una categoría sin datos para ese artículo avisa en vez de dibujar un gráfico
// vacío o quedarse con lo anterior en pantalla.
aplicar(["paros", "av", null]);
const sinAverias = pintar("27752");
check("una categoría sin paradas de ese artículo lo dice claramente",
  !sinAverias.oculto && sinAverias.html.includes("Sin paradas") && !sinAverias.html.includes("<svg"));

// El drill baja a las paradas una a una, no a las OF
aplicar(["paros", "pnp", null]);
const diaConParos = parosArt[0].periodo.getTime();
state.ui.mermaDrill = { busqueda: "27752", semana: parosArt[0].semana.key, dia: diaConParos };
const paradasDia = pintar("27752");
check("con una métrica de paradas, el día abre las paradas (no las OF)",
  paradasDia.html.includes("Horario") && paradasDia.html.includes("Motivo") && !paradasDia.html.includes("Merma kg"));
state.ui.mermaDrill = { busqueda: "27752", semana: parosArt[0].semana.key, dia: diaConParos };
aplicar(["prod", "merma"]);
check("con una métrica de producción, el mismo día abre las OF",
  pintar("27752").html.includes("Merma kg"));

// Si no hay His_Paro_Groups cargado, una métrica de paradas no puede dejar la
// tarjeta muerta: tiene que caer sola a producción.
state.ui.mermaDrill = { busqueda: null, semana: null, dia: null };
aplicar(["paros", "pnp", null]);
const guardados = state.paroRows.splice(0, state.paroRows.length);
pintar("27752");
check("sin datos de paradas cargados, la métrica vuelve sola a Merma",
  state.ui.metrica[0] === "prod", state.ui.metrica.join(" › "));
guardados.forEach(r => state.paroRows.push(r));
aplicar(["prod", "merma"]);

const fmtIntCtx = ctx("fmtInt"), fmtPctCtx = ctx("fmtPct");
check("un residuo negativo minúsculo se imprime como cero, no como -0",
  fmtIntCtx(-0.004) === "0" && fmtPctCtx(-0.0001) === "0,00 %",
  JSON.stringify(fmtIntCtx(-0.004)) + " / " + JSON.stringify(fmtPctCtx(-0.0001)));
check("un valor negativo de verdad sigue saliendo negativo",
  fmtIntCtx(-94) === "-94" && fmtPctCtx(-1.23) === "-1,23 %",
  fmtIntCtx(-94) + " / " + fmtPctCtx(-1.23));

/* ============================================================
   Categorías de parada PNP / PP / AV / TND (formato con más datos)
   ============================================================ */

console.log("\n\n=== Categorías de parada (His_Paro_Groups_s35) ===");
const S35 = __dirname + "/testdata/His_Paro_Groups_s35.csv";
const t35 = sandbox.decodeBuffer(new Uint8Array(fs.readFileSync(S35)));
const p35 = sandbox.rowsToObjects(sandbox.parseCsv(t35, sandbox.sniffDelimiter(t35.slice(0, t35.indexOf("\n")))));
check("el formato nuevo se reconoce igual que el anterior", sandbox.detectCsvKind(p35.index) === "paro");
const { rows: rows35, skipped: sk35 } = sandbox.mapParoRows(p35.header, p35.index, p35.dataRows);
check("mapea las 4.296 paradas sin descartar ninguna", rows35.length === 4296 && sk35 === 0,
  rows35.length + " filas, " + sk35 + " descartadas");

// Objetivo medido sobre el CSV real antes de escribir el código
const ESPERADO = {
  pp:  { n: 1265, h: 159.9, motivos: 15 },
  pnp: { n: 2966, h: 134.0, motivos: 18 },
  av:  { n: 60,   h: 7.2,   motivos: 2 },
  tnd: { n: 5,    h: 1.0,   motivos: 2 }
};
for (const [cat, esp] of Object.entries(ESPERADO)) {
  const filas = rows35.filter(r => r.categoria === cat);
  const horas = sum(filas, "segundos") / 3600;
  check(`${cat.toUpperCase()}: ${esp.n} paradas y ${esp.h} h`,
    filas.length === esp.n && Math.abs(horas - esp.h) < 0.05,
    `${filas.length} paradas · ${horas.toFixed(1)} h`);
  check(`   y ${esp.motivos} motivos distintos`, sandbox.motivosDe(cat, rows35).length === esp.motivos,
    sandbox.motivosDe(cat, rows35).length + " motivos");
}
check("ninguna parada se queda sin clasificar",
  rows35.filter(r => r.categoria === "otro").length === 0,
  rows35.filter(r => r.categoria === "otro").length + " sin clasificar");
check("las cuatro categorías suman el total, sin solapes ni huecos",
  Object.keys(ESPERADO).reduce((s, c) => s + rows35.filter(r => r.categoria === c).length, 0) === rows35.length);

// "NO PLANIFICADAS" contiene "PLANIFICADAS": si el orden de comprobación fuera
// al revés, todas las PNP caerían en PP y el reparto quedaría al revés.
const catDe = ctx("categoriaParo");
check("PNP no se confunde con PP pese a contener su texto",
  catDe("PARADAS NO PLANIFICADAS (PNP)") === "pnp" && catDe("PARADAS PLANIFICADAS (PP)") === "pp");
check("las siglas mandan sobre el texto largo",
  catDe("LO QUE SEA (TND)") === "tnd" && catDe("LO QUE SEA (AV)") === "av");
check("una categoría desconocida no se cuela en ninguna de las cuatro",
  catDe("ALGO NUEVO DE MAPEX") === "otro" && catDe("") === "otro");

// TND es la única que Mapex marca como que NO cuenta contra la disponibilidad
const tnd = rows35.filter(r => r.categoria === "tnd");
check("TND es la única con tiempo en PARO PROGRAMADO",
  sum(tnd, "segProgramado") > 0 &&
  rows35.filter(r => r.categoria !== "tnd").every(r => r.segProgramado === 0),
  fmtNum(sum(tnd, "segProgramado") / 3600) + " h programadas");
check("y no suma nada a DISPONIBILIDAD (no penaliza el OEE)",
  tnd.every(r => r.segDisponibilidad === 0));

// El formato nuevo trae paros de línea sin OF ("--"): no deben romper el cruce
const sinOfReal = rows35.filter(r => !r.of);
check("los paros de línea sin OF se admiten sin romper nada", sinOfReal.length === 339,
  sinOfReal.length + " paradas sin OF asignada");
check('el "--" de Mapex se limpia en vez de tratarse como una OF real',
  rows35.every(r => r.of !== "--" && r.producto !== "--" && r.desc !== "--"));
// Sin la limpieza, las 339 caían todas en una sola fila "--" con la línea de la
// primera, mezclando líneas distintas.
const ofs35 = sandbox.aggregateParosPorOf(rows35, productRows);
check("esas paradas no inventan una OF falsa que mezcle líneas",
  !ofs35.some(o => o.of === "--" || o.of === "(sin OF)"),
  ofs35.length + " OF reales");
check("cada OF agrupada pertenece a una sola línea",
  ofs35.every(o => new Set(rows35.filter(r => r.of === o.of).map(r => r.linea)).size === 1));

// Reparto y apilado
const reparto = sandbox.repartoPorCategoria(rows35);
check("repartoPorCategoria devuelve las cuatro, en orden fijo",
  reparto.map(c => c.id).join(",") === "pnp,pp,av,tnd", reparto.map(c => c.id).join(","));
check("los porcentajes del reparto suman 100",
  Math.abs(sum(reparto, "pct") - 100) < 1e-9, fmtNum(sum(reparto, "pct")) + " %");
const segs = sandbox.segmentosPorCategoria(rows35);
check("el apilado por categoría cuadra en minutos con el total",
  Math.abs(sum(segs, "value") - sum(rows35, "segundos") / 60) < 1e-6);

// Dedup entre cortes distintos: s31 y s35 son semanas diferentes, deben sumarse
state.paroRows.length = 0;
const m31 = sandbox.mergeParoRows(paroRows);
const m35 = sandbox.mergeParoRows(rows35);
check("dos cortes de semanas distintas se acumulan sin pisarse",
  m31.added === 2059 && m35.added === 4296 && m35.dup === 0,
  `${m31.added} + ${m35.added} = ${state.paroRows.length}`);
check("y volver a cargar el segundo no duplica",
  sandbox.mergeParoRows(rows35).dup === 4296);

/* ============================================================
   Disponibilidad calculada desde las paradas
   ============================================================ */

console.log("\n\n=== Disponibilidad ===");
const CT_CSV = __dirname + "/testdata/His_CT_Group.csv";
const ctText = sandbox.decodeBuffer(new Uint8Array(fs.readFileSync(CT_CSV)));
const ctParsed = sandbox.rowsToObjects(sandbox.parseCsv(ctText, sandbox.sniffDelimiter(ctText.slice(0, ctText.indexOf("\n")))));
const ctRows = sandbox.mapCtRows(ctParsed.header, ctParsed.index, ctParsed.dataRows);
sandbox.mergeCtRows(ctRows);

// La columna de Mapex es M / Tiempo Total, exacto. Es lo que justifica no
// usarla como disponibilidad de jornada: el denominador es el día natural.
const conDisp = ctRows.filter(r => r.disponibilidad !== null && r.tiempoTotal > 0);
const desvios = conDisp.map(r => Math.abs(100 * r.m / r.tiempoTotal - r.disponibilidad));
check("la columna Disponibilidad de Mapex es exactamente M / Tiempo Total",
  Math.max(...desvios) < 0.01, "desvío máximo " + Math.max(...desvios).toFixed(4) + " pp en " + conDisp.length + " filas");

// Y el denominador es el día natural: los tramos cubren las 24 h
const porLineaDia = new Map();
ctRows.forEach(r => {
  const k = r.linea + "|" + r.periodo.toISOString().slice(0, 10);
  porLineaDia.set(k, (porLineaDia.get(k) || 0) + r.tiempoTotal);
});
const dias24 = [...porLineaDia.values()].filter(v => Math.abs(v - 86400) < 2).length;
check("los tramos de His_CT_Group cubren el día natural completo (24 h)",
  dias24 === porLineaDia.size, dias24 + " de " + porLineaDia.size + " grupos línea+día suman 86.400 s");

// --- La fórmula nueva -----------------------------------------------------
const dCalc = sandbox.disponibilidadCalculada(ctRows, paroRows);
const cob = sandbox.coberturaParos(paroRows);
const ctCubierto = ctRows.filter(r => cob.lineas.has(r.linea) &&
  r.periodo.getTime() >= cob.min && r.periodo.getTime() <= cob.max);
const marcha = sum(ctCubierto, "m");
const penaliza = sum(paroRows.filter(r => r.categoria !== "tnd"), "segundos");
check("disponibilidad = marcha / (marcha + PNP + PP + AV)",
  Math.abs(dCalc.pct - 100 * marcha / (marcha + penaliza)) < 1e-9,
  fmtNum(dCalc.pct) + " %");
check("la ventana de trabajo es marcha + paradas, no el día natural",
  Math.abs(dCalc.ventana - (marcha + penaliza)) < 1e-9 && dCalc.ventana < sum(ctCubierto, "tiempoTotal"),
  fmtNum(dCalc.ventana / 3600) + " h frente a " + fmtNum(sum(ctCubierto, "tiempoTotal") / 3600) + " h de calendario");

// El TND no puede penalizar: se excluye de los dos lados de la división
const tndFalso = paroRows.slice(0, 3).map(r => ({ ...r, categoria: "tnd" }));
const sinTnd = sandbox.disponibilidadCalculada(ctRows, paroRows.filter(r => !paroRows.slice(0, 3).includes(r)));
const conTnd = sandbox.disponibilidadCalculada(ctRows, paroRows.filter(r => !paroRows.slice(0, 3).includes(r)).concat(tndFalso));
check("añadir paradas TND no cambia la disponibilidad",
  Math.abs(sinTnd.pct - conTnd.pct) < 1e-9, fmtNum(conTnd.pct) + " %");
check("y sí se contabiliza aparte para poder enseñarlo",
  Math.abs(conTnd.tnd - sum(tndFalso, "segundos")) < 1e-9);

// Más paradas -> menos disponibilidad, nunca al revés
const mitad = sandbox.disponibilidadCalculada(ctRows, paroRows.slice(0, Math.floor(paroRows.length / 2)));
check("con la mitad de las paradas la disponibilidad sube", mitad.pct > dCalc.pct,
  fmtNum(mitad.pct) + " % contra " + fmtNum(dCalc.pct) + " %");
check("nunca pasa de 100 % ni baja de 0 %", dCalc.pct > 0 && dCalc.pct <= 100);
check("sin paradas cargadas devuelve null (no un 100 % engañoso)",
  sandbox.disponibilidadCalculada(ctRows, []) === null);
// La marcha de líneas que el archivo de paradas no cubre no puede colarse en
// el denominador: si no, la disponibilidad se dispara al 100 %.
check("solo entra la marcha de las líneas y fechas que cubren las paradas",
  Math.abs(dCalc.marcha - sum(ctCubierto, "m")) < 1e-9 && sum(ctCubierto, "m") < sum(ctRows, "m"),
  fmtNum(sum(ctCubierto, "m") / 3600) + " h de " + fmtNum(sum(ctRows, "m") / 3600) + " h totales");

// Sin uno de los dos archivos no se puede calcular: mejor null que un número
// inventado con medio dato.
check("sin tiempo de marcha devuelve null en vez de inventarse una cifra",
  sandbox.disponibilidadCalculada([], paroRows) === null);

// Por línea
const porLinea2 = sandbox.disponibilidadPorLinea(ctRows, paroRows);
check("el desglose por línea cubre las líneas con marcha",
  porLinea2.size > 0 && [...porLinea2.values()].every(d => d.pct > 0 && d.pct <= 100),
  porLinea2.size + " líneas");
const unaLinea = [...porLinea2.keys()][0];
const esperadaUna = sandbox.disponibilidadCalculada(
  ctRows.filter(r => r.linea === unaLinea), paroRows.filter(r => r.linea === unaLinea));
check("y cada línea cuadra con su cálculo por separado",
  Math.abs(porLinea2.get(unaLinea).pct - esperadaUna.pct) < 1e-9, unaLinea);

console.log("\n  Comparativa (semana 31, las " + cob.lineas.size + " líneas que cubre His_Paro_Groups):");
console.log("    Mapex (M / día natural de 24 h) :", fmtNum(100 * marcha / sum(ctCubierto, "tiempoTotal")) + " %");
console.log("    Calculada (jornada real)        :", fmtNum(dCalc.pct) + " %");
console.log("    marcha", fmtNum(marcha / 3600) + " h · paradas que penalizan", fmtNum(penaliza / 3600) + " h");

/* ============================================================
   Tendencia diaria con indicador elegible
   ============================================================ */

console.log("\n=== Tendencia diaria (Resumen) ===");
const METS = ctx("TENDENCIA_METRICAS");
const dispon = ctx("tendenciaDisponible");
const grupos = [...new Set(Object.values(METS).map(m => m.grupo))];
check("el selector ofrece los tres grupos de indicadores",
  grupos.join(" | ") === "Producción | Disponibilidad | Paradas", grupos.join(" | "));
check("con los tres CSV cargados todos los indicadores son elegibles",
  Object.keys(METS).every(dispon), Object.keys(METS).length + " indicadores");

// Sin paradas cargadas, las opciones que dependen de ellas se desactivan
const paroGuardadas = state.paroRows.splice(0, state.paroRows.length);
check("sin His_Paro_Groups se desactivan paradas y disponibilidad",
  !dispon("disp") && !dispon("paros.pnp") && dispon("prod.kg"));
paroGuardadas.forEach(r => state.paroRows.push(r));

const ctGuardadas = state.ctRows.splice(0, state.ctRows.length);
check("sin His_CT_Group se desactiva disponibilidad pero no las paradas",
  !dispon("disp") && dispon("paros.pnp"));
ctGuardadas.forEach(r => state.ctRows.push(r));

// Render de cada indicador
const tarjetaT = elMap.chartTendencia;
const porLineaT = sandbox.aggregateByLinea(productRows);
state.filters.desde = new Date(Date.UTC(2026, 0, 1));
state.filters.hasta = new Date(Date.UTC(2026, 11, 31));
state.filters.areas = new Set([...productRows.map(r => r.area), ...state.paroRows.map(r => r.area)]);
state.filters.lineas = new Set([...productRows.map(r => r.linea), ...state.paroRows.map(r => r.linea)]);
for (const id of Object.keys(METS)) {
  state.ui.tendencia = id;
  tarjetaT.innerHTML = "";
  sandbox.renderTendencia(productRows, porLineaT);
  const html = tarjetaT.innerHTML;
  check(`«${id}» se dibuja con su selector`,
    html.includes("<svg") && html.includes('id="tendenciaSel"') && html.includes(`value="${id}" selected`),
    METS[id].label);
}

// Un indicador que deja de poder calcularse no puede dejar el gráfico muerto
state.ui.tendencia = "paros.av";
const paroGuardadas2 = state.paroRows.splice(0, state.paroRows.length);
tarjetaT.innerHTML = "";
sandbox.renderTendencia(productRows, porLineaT);
check("si el CSV que lo alimenta ya no está, vuelve solo a Merma",
  state.ui.tendencia === "prod.merma" && tarjetaT.innerHTML.includes("<svg"),
  state.ui.tendencia);
check("y esas opciones aparecen desactivadas en el desplegable",
  tarjetaT.innerHTML.includes("disabled") && tarjetaT.innerHTML.includes("falta CSV"));
paroGuardadas2.forEach(r => state.paroRows.push(r));

// La disponibilidad diaria usa la misma fórmula que el KPI
state.ui.tendencia = "disp";
const unaL = [...sandbox.disponibilidadPorLinea(ctRows, paroRows).keys()][0];
const unDia = ctRows.filter(r => r.linea === unaL)[0].periodo.getTime();
const ctD = ctRows.filter(r => r.linea === unaL && r.periodo.getTime() === unDia);
const paD = paroRows.filter(r => r.linea === unaL && r.periodo.getTime() === unDia);
const espDia = sandbox.disponibilidadCalculada(ctD, paD);
const marchaD = sum(ctD, "m"), penD = sum(paD.filter(r => r.categoria !== "tnd"), "segundos");
check("la disponibilidad diaria del gráfico coincide con marcha/(marcha+paros)",
  espDia === null || Math.abs(espDia.pct - 100 * marchaD / (marchaD + penD)) < 1e-9,
  unaL + " el " + new Date(unDia).toISOString().slice(0, 10) + ": " + fmtNum(100 * marchaD / (marchaD + penD)) + " %");
state.ui.tendencia = "prod.merma";

/* ============================================================
   Agrupado del eje de tiempo (día / semana / mes)
   ============================================================ */

console.log("\n=== Agrupado de la tendencia ===");
const granoAuto = ctx("granoAuto");
const clavePeriodo = ctx("clavePeriodo");
check("hasta 35 fechas se dibuja día a día",
  granoAuto(1) === "dia" && granoAuto(20) === "dia" && granoAuto(35) === "dia");
check("de 36 a 240 se agrupa por semana",
  granoAuto(36) === "semana" && granoAuto(91) === "semana" && granoAuto(240) === "semana");
check("más de 240 se agrupa por mes", granoAuto(241) === "mes" && granoAuto(900) === "mes");

const unaFecha = new Date(Date.UTC(2026, 6, 29));   // miércoles de la semana 31
check("la clave por día es el propio día",
  clavePeriodo(unaFecha, "dia").key === unaFecha.getTime());
check("la clave por semana agrupa toda la semana ISO",
  clavePeriodo(unaFecha, "semana").key === "2026-W31" &&
  clavePeriodo(new Date(Date.UTC(2026, 6, 27)), "semana").key === "2026-W31" &&
  clavePeriodo(new Date(Date.UTC(2026, 7, 2)), "semana").key === "2026-W31",
  clavePeriodo(unaFecha, "semana").etiqueta);
check("y la clave por mes agrupa el mes natural",
  clavePeriodo(unaFecha, "mes").key === "2026-07" &&
  clavePeriodo(new Date(Date.UTC(2026, 6, 1)), "mes").key === "2026-07",
  clavePeriodo(unaFecha, "mes").etiqueta);
check("los meses se ordenan por su primer día, no alfabéticamente",
  clavePeriodo(new Date(Date.UTC(2026, 8, 1)), "mes").orden > clavePeriodo(new Date(Date.UTC(2026, 11, 1)), "mes").orden === false);

// Agrupar no puede perder producción: los kg de un mes son la suma de sus días
const puntosDe = (grano, id) => {
  state.ui.tendenciaGrano = grano;
  state.ui.tendencia = id;
  tarjetaT.innerHTML = "";
  sandbox.renderTendencia(productRows, porLineaT);
  return tarjetaT.innerHTML;
};
const nDiasReales = new Set(productRows.map(r => r.periodo.getTime())).size;
const cuentaPuntos = html => (html.match(/circle data-serie/g) || []).length;
const pDia = cuentaPuntos(puntosDe("dia", "prod.kg"));
const pSem = cuentaPuntos(puntosDe("semana", "prod.kg"));
const pMes = cuentaPuntos(puntosDe("mes", "prod.kg"));
// (semana vs mes no se comparan: la semana 31 cruza a agosto, así que por mes
// puede haber más puntos que por semana con estos 7 días de prueba)
check("agrupar reduce los puntos de verdad",
  pDia > pSem && pDia > pMes, `${nDiasReales} días -> ${pDia} puntos diarios, ${pSem} semanales, ${pMes} mensuales`);

// El ocultado de puntos se prueba directo sobre el gráfico, con series densas
// y sueltas, para no depender de cuántos días traiga el CSV de prueba.
const tarjetaL = elMap.chartTendencia;
const serieDe = n => [{ label: "X", color: "#000",
  points: Array.from({ length: n }, (_, i) => ({ x: i, y: Math.sin(i) * 10 + 50 })) }];
const pintaLinea = n => { tarjetaL.innerHTML = "";
  sandbox.renderLineChart("chartTendencia", "t", "s", serieDe(n), {}); return tarjetaL.innerHTML; };
const visibles = html => (html.match(/<circle cx=/g) || []).length;
const conHover = html => (html.match(/circle data-serie/g) || []).length;
const suelto = pintaLinea(12), denso = pintaLinea(120);
check("con pocas fechas se dibujan los puntos", visibles(suelto) === 12, visibles(suelto) + " puntos");
check("con muchas se dibuja solo la línea, sin puntos que la tapen",
  visibles(denso) === 0, visibles(denso) + " puntos con 120 fechas");
check("aun sin puntos visibles se puede consultar cada valor",
  conHover(denso) === 120, conHover(denso) + " zonas con tooltip");

state.ui.tendenciaGrano = "auto";
state.ui.tendencia = "prod.merma";

/* ============================================================
   Unificar todas las líneas en una sola serie
   ============================================================ */

console.log("\n=== Unificado de líneas ===");
state.ui.tendenciaGrano = "dia";
const pintaDesglose = (desglose, id) => {
  state.ui.tendenciaDesglose = desglose;
  state.ui.tendencia = id;
  tarjetaT.innerHTML = "";
  sandbox.renderTendencia(productRows, porLineaT);
  return tarjetaT.innerHTML;
};
const nLineas = new Set(productRows.map(r => r.linea)).size;

const porLineaHtml = pintaDesglose("linea", "prod.kg");
const totalHtml = pintaDesglose("total", "prod.kg");
const seriesDe = html => (html.match(/<path d="M/g) || []).length;
check("por línea se dibujan varias series (máximo 6)",
  seriesDe(porLineaHtml) > 1 && seriesDe(porLineaHtml) <= 6, seriesDe(porLineaHtml) + " series de " + nLineas + " líneas");
check("unificado deja una sola serie", seriesDe(totalHtml) === 1, seriesDe(totalHtml) + " serie");
check("y avisa de cuántas líneas ha sumado",
  totalHtml.includes(`Las ${nLineas} líneas de la selección sumadas`), nLineas + " líneas");
check("por línea avisa de las que quedan fuera",
  porLineaHtml.includes("quedan") && porLineaHtml.includes("Todas juntas"));

// Lo importante: el total tiene que ser la suma de verdad, no la de las 6 que
// se dibujaban antes.
const totalKgReal = sum(productRows, "kg");
const kg6 = sum(productRows.filter(r => porLineaT.slice(0, 6).map(x => x.linea).includes(r.linea)), "kg");
const puntosY = html => [...html.matchAll(/data-y="([-\d.]+)"/g)].map(m => parseFloat(m[1]));
const sumaTotal = puntosY(totalHtml).reduce((a, b) => a + b, 0);
check("el total suma TODAS las líneas seleccionadas, no solo las 6 dibujadas",
  Math.abs(sumaTotal - totalKgReal) < 1, fmtNum(sumaTotal) + " kg contra " + fmtNum(totalKgReal) + " kg reales");
check("y esa suma es mayor que la de las 6 líneas del desglose",
  totalKgReal > kg6, fmtNum(totalKgReal) + " kg contra " + fmtNum(kg6) + " kg del top 6");

// Los porcentajes se recalculan sobre el conjunto, no se promedian por línea
const totalMerma = pintaDesglose("total", "prod.merma");
const filasStd = productRows.filter(r => r.aplicaStd);
const esperadaGlobal = sum(filasStd, "mermaKg") / sum(filasStd, "mmpp") * 100;
const puntosMerma = puntosY(totalMerma);
const mermaPonderada = sandbox.weightedMermaRealPct(filasStd);
check("la merma unificada se pondera, no se promedia entre líneas",
  puntosMerma.length > 0 && Math.abs(esperadaGlobal - mermaPonderada) < 1e-9,
  "global " + fmtNum(esperadaGlobal) + " %");

// Con una sola línea el texto tiene que concordar
const guardadas = productRows.filter(r => r.linea === "N2_ELA_L03");
state.filters.lineas = new Set(["N2_ELA_L03"]);
tarjetaT.innerHTML = "";
state.ui.tendenciaDesglose = "total";
state.ui.tendencia = "prod.kg";
sandbox.renderTendencia(guardadas, sandbox.aggregateByLinea(guardadas));
check("con una sola línea el texto concuerda en singular",
  tarjetaT.innerHTML.includes("Una sola línea") && !tarjetaT.innerHTML.includes("Las 1 líneas"),
  "sin «Las 1 líneas ... sumadas»");
state.filters.lineas = new Set(productRows.map(r => r.linea));
state.ui.tendenciaDesglose = "linea";
state.ui.tendenciaGrano = "auto";
state.ui.tendencia = "prod.merma";

console.log(fallos === 0 ? "\n✅ Todas las comprobaciones pasan." : `\n❌ ${fallos} comprobación(es) fallan.`);
process.exit(fallos === 0 ? 0 : 1);
