/* ZZ temporal: crea la planilla de la app en tu Drive (se borra después de usarla). */
function zzCrearPlanilla() {
  const ss = SpreadsheetApp.create('BD_Reporte_Flash_Desviaciones');
  const h = ss.getSheets()[0]; h.setName('BASE DE DATOS FIJOS');
  h.getRange(1, 1, 1, 4).setValues([['EQUIPO', 'PÉRDIDA POR HORA (KTon/h)', 'GERENCIA / SUPERINTENDENCIA', 'ÁREA / PROCESO']])
    .setBackground('#106470').setFontColor('#ffffff').setFontWeight('bold').setWrap(true);
  h.setFrozenRows(1); h.setColumnWidth(1, 160); h.setColumnWidth(2, 170); h.setColumnWidth(3, 260); h.setColumnWidth(4, 220);
  asegurarBaseDeDatos_(ss, true);
  Logger.log('PLANILLA ' + ss.getId() + ' ' + ss.getUrl());
}

/**
 * REPORTE FLASH - DESVIACIONES OPERACIONALES DCH - GEL   (versión 2.0)
 *
 * Qué cambia respecto a la versión anterior:
 *  - Base de datos nueva y ordenada (hojas REPORTES, CONFIG y LOG) que se crea sola.
 *  - Cada reporte tiene un folio único: un reporte reenviado nunca se duplica.
 *  - El equipo sí se guarda. La pérdida se recalcula en el servidor con el factor oficial.
 *  - Hasta 8 fotos, guardadas como archivos en Drive (no como texto dentro de una celda).
 *  - El PDF lo arma la app en el teléfono con el formato de la PPT; aquí solo se archiva.
 *  - Bloqueo (LockService) para que dos operadores no se pisen al guardar al mismo tiempo.
 *
 * INSTALACIÓN: pegar este archivo y el Index.html, ejecutar una vez la función
 * "configurarBaseDeDatos" (autorizar los permisos) y publicar una nueva versión.
 */

const SPREADSHEET_ID = '1qRJ0k4iYmAVoO-Q1IvOTkwemK8KT8liCPlITaQ3vFvk';

const HOJA_EQUIPOS  = 'BASE DE DATOS FIJOS';   // se mantiene tal cual (A: equipo, B: factor, C: gerencia, D: área)
const HOJA_REPORTES = 'REPORTES';
const HOJA_CONFIG   = 'CONFIG';
const HOJA_LOG      = 'LOG';
const MAX_FOTOS     = 8;

const COLUMNAS_REPORTES = [
  'ID REPORTE', 'FECHA REGISTRO', 'SEMANA', 'AÑO', 'TÍTULO GENERAL', 'EQUIPO',
  'GERENCIA / SUPERINTENDENCIA', 'ÁREA / PROCESO', 'COMPONENTE', 'FECHA / HORA EVENTO',
  'TIEMPO DE DETENCIÓN (h)', 'PÉRDIDA ESTIMADA (KTon)', 'DESCRIPCIÓN DE LA PÉRDIDA',
  'NIVEL DE IMPACTO', 'KPI AFECTADO', 'ACCIÓN INMEDIATA', 'N° FOTOS', 'FOTOS (enlaces)',
  'PDF (enlace)', 'REPORTADO POR', 'ORIGEN'
];

const CONFIG_INICIAL = [
  ['TITULO_REPORTE', 'REPORTE DE DESVIACIONES OPERACIONALES DCH - GEL', 'Título que aparece en la app y en el PDF'],
  ['NIVELES_IMPACTO', 'Bajo;Medio;Alto', 'Opciones separadas por punto y coma'],
  ['KPIS', 'Mineral Apilado', 'Opciones separadas por punto y coma. La primera es la opción por defecto'],
  ['GUARDAR_EN_DRIVE', 'SI', 'SI = archiva fotos y PDF en Drive. NO = solo guarda los datos'],
  ['CARPETA_DRIVE_ID', '', 'Se completa solo la primera vez. Puede pegar aquí el ID de otra carpeta']
];

/* ------------------------------------------------------------------ */
/*  WEB APP                                                           */
/* ------------------------------------------------------------------ */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Reporte Flash - Desviaciones')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Datos que la app necesita al abrir: equipos y listas desplegables. */
function getInitialData() {
  try {
    const ss = abrirPlanilla_();
    asegurarBaseDeDatos_(ss);
    const cfg = leerConfig_(ss);
    return {
      success: true,
      equipos: leerEquipos_(ss),
      niveles: lista_(cfg.NIVELES_IMPACTO, ['Bajo', 'Medio', 'Alto']),
      kpis: lista_(cfg.KPIS, ['Mineral Apilado']),
      titulo: cfg.TITULO_REPORTE || CONFIG_INICIAL[0][1],
      maxFotos: MAX_FOTOS
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/**
 * Guarda un reporte. Es seguro llamarla dos veces con el mismo reporte:
 * si el ID ya existe responde "success" sin volver a escribir.
 */
function guardarReporte(datos) {
  let ss = null;
  let id = '';
  try {
    if (!datos || !datos.id) return { success: false, error: 'Reporte sin identificador.' };
    id = String(datos.id).trim().substring(0, 40);

    ss = abrirPlanilla_();
    asegurarBaseDeDatos_(ss);
    const hoja = hojaPorNombre_(ss, HOJA_REPORTES);

    // --- Validación y normalización -------------------------------------
    const equipo = String(datos.equipo || '').trim();
    const catalogo = leerEquipos_(ss);
    let eq = null;
    for (let i = 0; i < catalogo.length; i++) {
      if (catalogo[i].nombre === equipo) { eq = catalogo[i]; break; }
    }
    if (!eq) return { success: false, error: 'El equipo "' + equipo + '" no existe en ' + HOJA_EQUIPOS + '.' };

    const horas = parseFloat(String(datos.tiempoDetencion).replace(',', '.'));
    if (!(horas > 0)) return { success: false, error: 'El tiempo de detención debe ser mayor que 0.' };

    const fechaEvento = fechaLocal_(datos.fechaHora);
    if (!fechaEvento) return { success: false, error: 'Fecha / hora no válida.' };

    const obligatorios = ['tituloGeneral', 'componente', 'descripcionPerdida', 'nivelImpacto', 'accionInmediata'];
    for (let i = 0; i < obligatorios.length; i++) {
      if (!String(datos[obligatorios[i]] || '').trim()) {
        return { success: false, error: 'Falta completar: ' + obligatorios[i] };
      }
    }

    const perdida = Math.round(eq.porcentajePerdidaHora * horas * 100) / 100;   // cálculo oficial
    const semana = String(datos.semana || '').trim() || semanaIso_(fechaEvento).etiqueta;

    // --- Duplicados: revisión rápida antes de subir archivos -----------
    if (existeId_(hoja, id)) return { success: true, id: id, duplicado: true };

    // --- Archivos en Drive (si falla, el reporte se guarda igual) ------
    const cfg = leerConfig_(ss);
    const fotos = (datos.fotos || []).filter(function (f) {
      return f && String(f).indexOf('data:image') === 0;
    }).slice(0, MAX_FOTOS);

    let enlacesFotos = [];
    let enlacePdf = '';
    let aviso = '';
    if (String(cfg.GUARDAR_EN_DRIVE || 'SI').toUpperCase() !== 'NO' && (fotos.length || datos.pdfBase64)) {
      try {
        const carpeta = carpetaDelMes_(ss, cfg, fechaEvento);
        fotos.forEach(function (f, i) {
          const blob = Utilities.newBlob(Utilities.base64Decode(f.split(',')[1]), 'image/jpeg', id + '_foto' + (i + 1) + '.jpg');
          enlacesFotos.push(carpeta.createFile(blob).getUrl());
        });
        if (datos.pdfBase64) {
          const pdf = Utilities.newBlob(Utilities.base64Decode(datos.pdfBase64), 'application/pdf', nombreArchivo_(id, equipo, semana));
          enlacePdf = carpeta.createFile(pdf).getUrl();
        }
      } catch (eDrive) {
        aviso = 'Datos guardados, pero no se pudieron archivar fotos/PDF en Drive: ' + eDrive;
        registrarLog_(ss, 'AVISO', id, aviso);
      }
    }

    // --- Escritura con bloqueo ------------------------------------------
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (existeId_(hoja, id)) return { success: true, id: id, duplicado: true };
      hoja.appendRow([
        id,
        new Date(),
        texto_(semana),
        fechaEvento.getFullYear(),
        texto_(datos.tituloGeneral),
        texto_(equipo),
        texto_(eq.gerencia),
        texto_(eq.area),
        texto_(datos.componente),
        fechaEvento,
        horas,
        perdida,
        texto_(datos.descripcionPerdida),
        texto_(datos.nivelImpacto),
        texto_(datos.kpiAfectado || lista_(cfg.KPIS, ['Mineral Apilado'])[0]),
        texto_(datos.accionInmediata),
        fotos.length,
        enlacesFotos.join('\n'),
        enlacePdf,
        texto_(datos.reportadoPor),
        datos.origen === 'offline' ? 'Sincronizado (sin conexión)' : 'En línea'
      ]);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    return { success: true, id: id, pdfUrl: enlacePdf, aviso: aviso };
  } catch (err) {
    try { if (ss) registrarLog_(ss, 'ERROR', id, String(err)); } catch (e2) {}
    return { success: false, error: String(err) };
  }
}

/* ------------------------------------------------------------------ */
/*  BASE DE DATOS                                                     */
/* ------------------------------------------------------------------ */

/** Ejecutar UNA VEZ desde el editor: crea las hojas y pide los permisos. */
function configurarBaseDeDatos() {
  const ss = abrirPlanilla_();
  asegurarBaseDeDatos_(ss, true);
  const cfg = leerConfig_(ss);
  if (String(cfg.GUARDAR_EN_DRIVE || 'SI').toUpperCase() !== 'NO') carpetaRaiz_(ss, cfg);
  registrarLog_(ss, 'INFO', '', 'Base de datos configurada.');
  return 'Base de datos lista.';
}

function asegurarBaseDeDatos_(ss, forzar) {
  if (!forzar && hojaPorNombre_(ss, HOJA_REPORTES) && hojaPorNombre_(ss, HOJA_CONFIG) && hojaPorNombre_(ss, HOJA_LOG)) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // REPORTES
    let rep = hojaPorNombre_(ss, HOJA_REPORTES);
    if (!rep) {
      rep = ss.insertSheet(HOJA_REPORTES);
      rep.getRange(1, 1, 1, COLUMNAS_REPORTES.length).setValues([COLUMNAS_REPORTES]);
      estiloEncabezado_(rep, COLUMNAS_REPORTES.length);
      rep.getRange('A:A').setNumberFormat('@');
      rep.getRange('C:C').setNumberFormat('@');
      rep.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm');
      rep.getRange('J:J').setNumberFormat('dd/mm/yyyy hh:mm');
      rep.getRange('K:L').setNumberFormat('0.00');
      [[1, 170], [2, 125], [5, 260], [7, 190], [9, 170], [10, 125], [13, 380], [16, 380], [18, 260], [19, 260], [20, 150]]
        .forEach(function (c) { rep.setColumnWidth(c[0], c[1]); });
      rep.getRange('M:M').setWrap(true);
      rep.getRange('P:P').setWrap(true);
    }

    // CONFIG
    let cfg = hojaPorNombre_(ss, HOJA_CONFIG);
    if (!cfg) {
      cfg = ss.insertSheet(HOJA_CONFIG);
      cfg.getRange(1, 1, 1, 3).setValues([['CLAVE', 'VALOR', 'DESCRIPCIÓN']]);
      cfg.getRange(2, 1, CONFIG_INICIAL.length, 3).setValues(CONFIG_INICIAL);
      estiloEncabezado_(cfg, 3);
      cfg.setColumnWidth(1, 180); cfg.setColumnWidth(2, 380); cfg.setColumnWidth(3, 460);
    }

    // LOG
    let log = hojaPorNombre_(ss, HOJA_LOG);
    if (!log) {
      log = ss.insertSheet(HOJA_LOG);
      log.getRange(1, 1, 1, 4).setValues([['FECHA', 'TIPO', 'ID REPORTE', 'DETALLE']]);
      estiloEncabezado_(log, 4);
      log.getRange('A:A').setNumberFormat('dd/mm/yyyy hh:mm:ss');
      log.setColumnWidth(1, 140); log.setColumnWidth(3, 170); log.setColumnWidth(4, 700);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

function estiloEncabezado_(hoja, nCols) {
  hoja.getRange(1, 1, 1, nCols)
    .setBackground('#106470').setFontColor('#ffffff').setFontWeight('bold')
    .setVerticalAlignment('middle').setWrap(true);
  hoja.setFrozenRows(1);
}

/** Lee el catálogo de equipos completo (ya no está limitado a 27 filas). */
function leerEquipos_(ss) {
  const hoja = hojaPorNombre_(ss, HOJA_EQUIPOS);
  if (!hoja) throw new Error("No se encontró la pestaña '" + HOJA_EQUIPOS + "'.");
  const ultima = hoja.getLastRow();
  if (ultima < 2) return [];
  const datos = hoja.getRange(2, 1, ultima - 1, 4).getValues();
  const equipos = [];
  const vistos = {};
  datos.forEach(function (fila) {
    const nombre = String(fila[0] || '').trim();
    if (!nombre || nombre.toUpperCase() === 'EQUIPO' || vistos[nombre]) return;
    vistos[nombre] = true;
    const factor = typeof fila[1] === 'number' ? fila[1] : parseFloat(String(fila[1]).replace(',', '.'));
    equipos.push({
      nombre: nombre,
      porcentajePerdidaHora: isFinite(factor) ? factor : 0,
      gerencia: String(fila[2] || '').trim(),
      area: String(fila[3] || '').trim()
    });
  });
  return equipos;
}

function leerConfig_(ss) {
  const hoja = hojaPorNombre_(ss, HOJA_CONFIG);
  const cfg = {};
  if (!hoja || hoja.getLastRow() < 2) return cfg;
  hoja.getRange(2, 1, hoja.getLastRow() - 1, 2).getValues().forEach(function (f) {
    const clave = String(f[0] || '').trim().toUpperCase();
    if (clave) cfg[clave] = String(f[1] === null ? '' : f[1]).trim();
  });
  return cfg;
}

function guardarConfig_(ss, clave, valor) {
  const hoja = hojaPorNombre_(ss, HOJA_CONFIG);
  if (!hoja) return;
  const n = Math.max(hoja.getLastRow() - 1, 0);
  const claves = n ? hoja.getRange(2, 1, n, 1).getValues() : [];
  for (let i = 0; i < claves.length; i++) {
    if (String(claves[i][0]).trim().toUpperCase() === clave) { hoja.getRange(i + 2, 2).setValue(valor); return; }
  }
  hoja.appendRow([clave, valor, '']);
}

function registrarLog_(ss, tipo, id, detalle) {
  const hoja = hojaPorNombre_(ss, HOJA_LOG);
  if (hoja) hoja.appendRow([new Date(), tipo, id || '', String(detalle).substring(0, 2000)]);
}

function existeId_(hoja, id) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return false;
  return hoja.getRange(2, 1, ultima - 1, 1).createTextFinder(id).matchEntireCell(true).findNext() !== null;
}

/* ------------------------------------------------------------------ */
/*  DRIVE                                                             */
/* ------------------------------------------------------------------ */

function carpetaRaiz_(ss, cfg) {
  if (cfg.CARPETA_DRIVE_ID) {
    try { return DriveApp.getFolderById(cfg.CARPETA_DRIVE_ID); } catch (e) { /* se crea una nueva */ }
  }
  const carpeta = DriveApp.createFolder('Reportes Flash - Fotos y PDF');
  guardarConfig_(ss, 'CARPETA_DRIVE_ID', carpeta.getId());
  return carpeta;
}

function carpetaDelMes_(ss, cfg, fecha) {
  const raiz = carpetaRaiz_(ss, cfg);
  const nombre = Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'yyyy-MM');
  const it = raiz.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : raiz.createFolder(nombre);
}

/* ------------------------------------------------------------------ */
/*  UTILIDADES                                                        */
/* ------------------------------------------------------------------ */

function abrirPlanilla_() {
  let ss = null;
  try { ss = SpreadsheetApp.openById(SPREADSHEET_ID); } catch (e) { ss = SpreadsheetApp.getActiveSpreadsheet(); }
  if (!ss) throw new Error('No se pudo acceder a la planilla.');
  return ss;
}

/** Busca la hoja ignorando mayúsculas y espacios sobrantes (las hojas actuales tienen espacios al final). */
function hojaPorNombre_(ss, nombre) {
  const buscado = nombre.replace(/\s+/g, ' ').trim().toUpperCase();
  const hojas = ss.getSheets();
  for (let i = 0; i < hojas.length; i++) {
    if (hojas[i].getName().replace(/\s+/g, ' ').trim().toUpperCase() === buscado) return hojas[i];
  }
  return null;
}

function lista_(valor, porDefecto) {
  const l = String(valor || '').split(';').map(function (s) { return s.trim(); }).filter(String);
  return l.length ? l : porDefecto;
}

/** Evita que un texto que empieza con = + - @ se interprete como fórmula. */
function texto_(v) {
  const s = String(v === null || v === undefined ? '' : v).trim().substring(0, 5000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Convierte "2026-08-15T00:16" (hora local del operador) en fecha. */
function fechaLocal_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return isNaN(d.getTime()) ? null : d;
}

function semanaIso_(fecha) {
  const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate()));
  const dia = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dia);
  const inicio = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const n = Math.ceil(((d - inicio) / 86400000 + 1) / 7);
  return { numero: n, etiqueta: 'W' + (n < 10 ? '0' : '') + n };
}

function nombreArchivo_(id, equipo, semana) {
  return ('Reporte_Flash_' + equipo + '_' + semana + '_' + id).replace(/[^\w\-]+/g, '_') + '.pdf';
}
