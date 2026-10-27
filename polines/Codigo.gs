/**
 * Inspección de polines · Estructural MSMIN
 * Ingeniería de mantenimiento · Contrato 4600030865 · División Chuquicamata
 *
 * App web (Apps Script) para registrar la inspección semanal de polines de las correas transportadoras.
 *   - Base de datos principal: Supabase, proyecto apps-mantenimiento, tablas pol_* (desde la SEM 39-2026).
 *   - Espejo en Drive: planilla BD_Polines (cada cambio se copia a sus hojas hallazgos / inspecciones / mantenciones).
 *   - Informes PDF de cada inspección (módulo común MSMIN).
 *
 * Configuración (Configuración del proyecto > Propiedades del script):
 *   SUPABASE_URL          https://cklbhuqjhsxvtcdwerxr.supabase.co
 *   SUPABASE_SERVICE_KEY  clave secreta de Supabase. Nunca va en el código.
 *   ESPEJO_DRIVE = NO     (opcional) deja de copiar los cambios a la planilla BD_Polines
 *
 * Publicar: Implementar > Nueva implementación > Aplicación web · Ejecutar como: Yo · Acceso: Solo yo.
 * Probar la conexión: ejecutar probarSupabase() desde el editor.
 */

const POL_POS = { MONO: ['cent1'], DOBLE: ['izq', 'der'], TRIPLE: ['izq', 'cent1', 'der'], CUADRUPLE: ['izq', 'cent1', 'cent2', 'der'] };
const POL_CRITICOS = ['Desbocado', 'Trabado'];
const HZ_CAMPOS = ['id', 'inspeccion_id', 'semana', 'anio', 'fecha', 'equipo', 'tipo_polin', 'tipo', 'mesa', 'estacion', 'modo_falla', 'comentario',
  'prioridad', 'temperatura', 'izq', 'cent1', 'cent2', 'der', 'criticidad', 'estado', 'n_aviso', 'n_ot', 'nota'];
const MT_CAMPOS = ['id', 'fecha', 'semana', 'anio', 'equipo', 'tipo_polin', 'tipo', 'mesa', 'estacion', 'tipo_cambio', 'izq', 'cent1', 'cent2', 'der',
  'empresa', 'hallazgo_id', 'nota'];
// Columnas de la planilla espejo BD_Polines (mismo orden que sus hojas)
const ESP_HZ = ['id', 'inspeccion_id', 'semana', 'anio', 'fecha', 'equipo', 'tipo_polin', 'tipo', 'mesa', 'estacion', 'modo_falla', 'comentario', 'prioridad',
  'temperatura', 'izq', 'cent1', 'cent2', 'der', 'polines_falla', 'criticidad', 'estado', 'n_aviso', 'n_ot', 'nota'];
const ESP_MT = ['id', 'fecha', 'semana', 'anio', 'equipo', 'tipo_polin', 'tipo', 'mesa', 'estacion', 'tipo_cambio', 'izq', 'cent1', 'cent2', 'der',
  'polines_cambiados', 'empresa', 'hallazgo_id', 'nota'];
const ESP_IN = ['id', 'semana', 'anio', 'fecha', 'descripcion', 'origen'];

/* =====================================================================
 *  PÁGINA
 * ===================================================================== */
function doGet() {
  let boot;
  try { boot = datosIniciales_(); } catch (e) { boot = { error: e.message }; }
  const html = INDEX_HTML.replace('/*__BOOT__*/null', () => JSON.stringify(boot).replace(/</g, '\\u003c'));
  return HtmlService.createHtmlOutput(html)
    .setTitle('Inspección de polines · MSMIN')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function usuario_() {
  try { return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || ''; } catch (e) { return ''; }
}

function datosIniciales_() {
  const r = sbVarios_([
    'pol_listas?select=lista,valor,orden&order=lista.asc,orden.asc',
    'pol_config?select=clave,valor',
    'pol_inspecciones?select=*&order=anio.desc,fecha.desc,id.desc',
    'pol_mantenciones?select=*&order=fecha.desc,id.desc&limit=500'
  ]);
  const listas = {};
  r[0].forEach(x => (listas[x.lista] = listas[x.lista] || []).push(x.valor));
  const config = {};
  r[1].forEach(x => config[x.clave] = x.valor);
  const insp = r[2];
  const actual = insp.length ? insp[0].id : '';
  return {
    listas: listas, config: config, inspecciones: insp, actual: actual,
    hallazgos: actual ? hallazgosDe_(actual) : [],
    mantenciones: r[3], usuario: usuario_()
  };
}

function hallazgosDe_(inspId) {
  return sbTodo_('pol_hallazgos', 'select=*&inspeccion_id=eq.' + encodeURIComponent(inspId) + '&order=id.asc');
}

/* =====================================================================
 *  API para la página (google.script.run)
 * ===================================================================== */

/** Hallazgos de una inspección */
function polHallazgos(inspId) {
  if (!inspId) throw new Error('Falta la inspección');
  return { inspeccion: inspId, hallazgos: hallazgosDe_(inspId) };
}

/** Recarga todo (después de cambios hechos en otro equipo) */
function polRecargar(inspId) {
  const d = datosIniciales_();
  if (inspId && inspId !== d.actual && d.inspecciones.some(x => x.id === inspId)) { d.actual = inspId; d.hallazgos = hallazgosDe_(inspId); }
  return d;
}

/** Crea o actualiza un hallazgo (estación con falla). Devuelve la fila guardada. */
function polGuardarHallazgo(h) {
  h = h || {};
  const quien = usuario_();
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    let previo = null;
    if (h.id) previo = (sbLeer_('pol_hallazgos', 'select=*&' + sbEq_('id', h.id)) || [])[0] || null;
    const inspId = h.inspeccion_id || (previo && previo.inspeccion_id);
    if (!inspId) throw new Error('Falta la inspección');
    const insp = (sbLeer_('pol_inspecciones', 'select=*&' + sbEq_('id', inspId)) || [])[0];
    if (!insp) throw new Error('No existe la inspección ' + inspId);
    const f = normHallazgo_(h, insp);
    if (!f.equipo) throw new Error('Falta el equipo');
    if (!f.modo_falla) throw new Error('Falta el modo de falla');
    if (!previo) f.id = siguienteId_('pol_hallazgos', 'PL-' + insp.id.replace(/^POL-/, '') + '-', 4);
    else f.id = previo.id;
    f.actualizado_por = quien;
    const fila = sbGuardar_('pol_hallazgos', [f])[0];
    seguimiento_(quien, 'pol_hallazgos', fila.id, previo ? 'editar' : 'crear', previo, fila, HZ_CAMPOS);
    let out = fila;
    // Condición inmediata (nueva o recién cambiada a Inmediato): genera el Reporte Flash de la condición
    if (fila.prioridad === 'Inmediato' && !fila.flash_id && (!previo || previo.prioridad !== 'Inmediato') && flashPermitido_(fila)) out = conFlash_(fila, quien);
    espejo_('hallazgos', ESP_HZ, [out]);
    return out;
  } finally { lock.releaseLock(); }
}

/** Genera (o vuelve a entregar) el Reporte Flash de un hallazgo. Botón «Generar reporte flash» de la app. */
function polGenerarFlash(id) {
  if (!id) throw new Error('Falta el id');
  const h = sbLeer_('pol_hallazgos', 'select=*&' + sbEq_('id', id))[0];
  if (!h) throw new Error('No existe ' + id);
  if (h.flash_id && h.flash_pdf) return h;
  if (!flashPermitido_(h)) throw new Error('El Reporte Flash se genera solo en inspecciones desde la ' + flashDesde_().txt);
  const out = conFlash_(h, usuario_());
  if (out._flash_error) throw new Error(out._flash_error);
  return out;
}

/** Semana desde la que se generan Reportes Flash (pol_config.flash_desde, ej. 'SEM 42-2026'). Las semanas anteriores no generan. */
let _FLD = null;
function flashDesde_() {
  if (_FLD) return _FLD;
  let v = 'SEM 42-2026';
  try { const c = sbLeer_('pol_config', 'select=valor&clave=eq.flash_desde')[0]; if (c && c.valor) v = c.valor; } catch (e) { }
  const m = String(v).match(/(\d{1,2})\D+(20\d\d)/);
  return (_FLD = { n: m ? Number(m[2]) * 100 + Number(m[1]) : 202642, txt: v });
}
function flashPermitido_(h) {
  const w = Number((String(h.semana || '').match(/(\d{1,2})/) || [])[1]) || 0;
  return (Number(h.anio) || 0) * 100 + w >= flashDesde_().n;
}

/** Crea el Reporte Flash, guarda su id y PDF en el hallazgo y devuelve la fila actualizada. Nunca detiene el guardado. */
function conFlash_(fila, quien) {
  try {
    const r = flashDesdeHallazgo_(fila, quien);
    const act = (sb_('patch', 'pol_hallazgos?' + sbEq_('id', fila.id), { flash_id: r.id, flash_pdf: r.pdf || null }, 'return=representation') || [])[0] || fila;
    seguimiento_(quien, 'pol_hallazgos', fila.id, 'reporte flash ' + r.id, null, null, []);
    act._flash_nuevo = !r.duplicado;
    if (r.aviso) act._flash_aviso = r.aviso;
    return act;
  } catch (e) {
    console.warn('reporte flash ' + fila.id + ': ' + e.message);
    const out = Object.assign({}, fila); out._flash_error = 'No se pudo generar el Reporte Flash: ' + e.message;
    return out;
  }
}

/** Borra un hallazgo */
function polBorrarHallazgo(id) {
  if (!id) throw new Error('Falta el id');
  const quien = usuario_();
  const m = sbLeer_('pol_mantenciones', 'select=id&' + sbEq_('hallazgo_id', id));
  if (m.length) throw new Error('El hallazgo tiene mantenciones registradas (' + m.map(x => x.id).join(', ') + '). Bórralas primero.');
  const r = sbBorrar_('pol_hallazgos', sbEq_('id', id));
  if (r.length) seguimiento_(quien, 'pol_hallazgos', id, 'borrar', r[0], null, HZ_CAMPOS);
  espejoBorrar_('hallazgos', [id]);
  return { id: id, borrado: r.length > 0 };
}

/** Cambia estado / aviso / OT de varios hallazgos a la vez */
function polCambiarVarios(ids, cambios) {
  ids = (ids || []).filter(Boolean);
  if (!ids.length) throw new Error('No hay hallazgos seleccionados');
  const c = {};
  ['estado', 'n_aviso', 'n_ot', 'prioridad'].forEach(k => { if (cambios && cambios[k] !== undefined && cambios[k] !== '') c[k] = String(cambios[k]).trim(); });
  if (!Object.keys(c).length) throw new Error('No hay cambios que guardar');
  const quien = usuario_();
  c.actualizado_por = quien;
  const filtro = 'id=in.(' + ids.map(i => '"' + String(i).replace(/"/g, '') + '"').join(',') + ')';
  const previos = sbLeer_('pol_hallazgos', 'select=*&' + filtro);
  const filas = sb_('patch', 'pol_hallazgos?' + filtro, c, 'return=representation') || [];
  const ant = {}; previos.forEach(p => ant[p.id] = p);
  filas.forEach(f => seguimiento_(quien, 'pol_hallazgos', f.id, 'editar', ant[f.id], f, Object.keys(c)));
  // Las que pasan a Inmediato generan su Reporte Flash (máximo 25 por vez, para no exceder el tiempo de Apps Script)
  let n = 0;
  const out = filas.map(f => {
    const a = ant[f.id];
    if (f.prioridad === 'Inmediato' && !f.flash_id && a && a.prioridad !== 'Inmediato' && n < 25 && flashPermitido_(f)) { n++; return conFlash_(f, quien); }
    return f;
  });
  espejo_('hallazgos', ESP_HZ, out);
  return out;
}

/**
 * Crea la inspección de una semana. o = { anio, semana (número), fecha, descripcion, copiar (true = copia los
 * hallazgos no cerrados de la inspección anterior para revisarlos en terreno) }
 */
function polNuevaInspeccion(o) {
  o = o || {};
  const quien = usuario_();
  const fecha = sbFecha_(o.fecha) || Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd');
  const s = isoSemana_(fecha);
  const anio = Number(o.anio) || s.anio, sem = Number(o.semana) || s.semana;
  if (sem < 1 || sem > 53) throw new Error('Semana inválida');
  const id = 'POL-' + anio + '-W' + ('0' + sem).slice(-2);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (sbLeer_('pol_inspecciones', 'select=id&' + sbEq_('id', id)).length) throw new Error('Ya existe la inspección de la SEM ' + sem + '-' + anio);
    const insp = sbGuardar_('pol_inspecciones', [{
      id: id, semana: 'SEM ' + sem, anio: anio, fecha: fecha,
      descripcion: sbTxt_(o.descripcion) || ('Inspección de polines SEM ' + sem + '-' + anio), origen: 'App Inspección de polines · ' + quien
    }])[0];
    seguimiento_(quien, 'pol_inspecciones', id, 'crear', null, insp, ESP_IN);
    espejo_('inspecciones', ESP_IN, [insp]);
    let copiados = [];
    if (o.copiar) {
      const ant = sbLeer_('pol_inspecciones', 'select=id&id=neq.' + encodeURIComponent(id) + '&order=anio.desc,fecha.desc,id.desc&limit=1')[0];
      if (ant) {
        const abiertos = hallazgosDe_(ant.id).filter(h => String(h.estado || '').toUpperCase() !== 'CERRADO');
        const pref = 'PL-' + id.replace(/^POL-/, '') + '-';
        copiados = abiertos.map((h, i) => {
          const f = normHallazgo_(h, insp);
          f.id = pref + ('000' + (i + 1)).slice(-4);
          f.nota = sbTxt_(['Viene de ' + h.id, h.nota].filter(Boolean).join(' · '));
          f.actualizado_por = quien;
          return f;
        });
        copiados = sbGuardar_('pol_hallazgos', copiados);
        espejo_('hallazgos', ESP_HZ, copiados);
      }
    }
    sbGuardar_('pol_config', [{ clave: 'semana_actual', valor: 'SEM ' + sem }]);
    return { inspeccion: insp, hallazgos: copiados };
  } finally { lock.releaseLock(); }
}

/** Edita fecha / descripción de una inspección */
function polGuardarInspeccion(o) {
  if (!o || !o.id) throw new Error('Falta la inspección');
  const quien = usuario_();
  const previo = sbLeer_('pol_inspecciones', 'select=*&' + sbEq_('id', o.id))[0];
  if (!previo) throw new Error('No existe la inspección ' + o.id);
  const c = {};
  if (o.fecha) c.fecha = sbFecha_(o.fecha);
  if (o.descripcion !== undefined) c.descripcion = sbTxt_(o.descripcion);
  const fila = (sb_('patch', 'pol_inspecciones?' + sbEq_('id', o.id), c, 'return=representation') || [])[0];
  seguimiento_(quien, 'pol_inspecciones', o.id, 'editar', previo, fila, ESP_IN);
  espejo_('inspecciones', ESP_IN, [fila]);
  return fila;
}

/** Registra una mantención (cambio de polín o de estación). Si viene hallazgo_id, ese hallazgo queda CERRADO. */
function polGuardarMantencion(m) {
  m = m || {};
  const quien = usuario_();
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    let previo = null;
    if (m.id) previo = sbLeer_('pol_mantenciones', 'select=*&' + sbEq_('id', m.id))[0] || null;
    const fecha = sbFecha_(m.fecha) || Utilities.formatDate(new Date(), 'America/Santiago', 'yyyy-MM-dd');
    const s = isoSemana_(fecha);
    const f = {};
    MT_CAMPOS.forEach(k => { if (m[k] !== undefined) f[k] = m[k]; });
    f.fecha = fecha; f.anio = s.anio; f.semana = 'SEM ' + s.semana;
    ['equipo', 'tipo_polin', 'tipo', 'mesa', 'tipo_cambio', 'empresa', 'hallazgo_id', 'nota'].forEach(k => f[k] = sbTxt_(f[k] == null ? '' : String(f[k]).trim()));
    f.estacion = sbNum_(f.estacion);
    posiciones_(f, m);
    if (!f.equipo) throw new Error('Falta el equipo');
    if (!f.tipo_cambio) throw new Error('Falta el tipo de cambio');
    f.id = previo ? previo.id : siguienteId_('pol_mantenciones', 'MT-' + s.anio + '-W' + ('0' + s.semana).slice(-2) + '-', 3);
    f.actualizado_por = quien;
    const fila = sbGuardar_('pol_mantenciones', [f])[0];
    seguimiento_(quien, 'pol_mantenciones', fila.id, previo ? 'editar' : 'crear', previo, fila, MT_CAMPOS);
    espejo_('mantenciones', ESP_MT, [fila]);
    let hz = null;
    if (fila.hallazgo_id && m.cerrar !== false) {
      const c = { estado: 'CERRADO', actualizado_por: quien };
      const ant = sbLeer_('pol_hallazgos', 'select=*&' + sbEq_('id', fila.hallazgo_id))[0];
      if (ant && String(ant.estado).toUpperCase() !== 'CERRADO') {
        hz = (sb_('patch', 'pol_hallazgos?' + sbEq_('id', fila.hallazgo_id), c, 'return=representation') || [])[0] || null;
        if (hz) { seguimiento_(quien, 'pol_hallazgos', hz.id, 'cerrar con ' + fila.id, ant, hz, ['estado']); espejo_('hallazgos', ESP_HZ, [hz]); }
      }
    }
    return { mantencion: fila, hallazgo: hz };
  } finally { lock.releaseLock(); }
}

function polBorrarMantencion(id) {
  if (!id) throw new Error('Falta el id');
  const r = sbBorrar_('pol_mantenciones', sbEq_('id', id));
  if (r.length) seguimiento_(usuario_(), 'pol_mantenciones', id, 'borrar', r[0], null, MT_CAMPOS);
  espejoBorrar_('mantenciones', [id]);
  return { id: id, borrado: r.length > 0 };
}

/* =====================================================================
 *  Reglas de los datos
 * ===================================================================== */
function normHallazgo_(h, insp) {
  const f = {};
  HZ_CAMPOS.forEach(k => { if (h[k] !== undefined) f[k] = h[k]; });
  f.inspeccion_id = insp.id; f.semana = insp.semana; f.anio = insp.anio;
  f.fecha = sbFecha_(h.fecha) || insp.fecha;
  ['equipo', 'tipo_polin', 'tipo', 'mesa', 'modo_falla', 'comentario', 'prioridad', 'temperatura', 'criticidad', 'estado', 'n_aviso', 'n_ot', 'nota']
    .forEach(k => f[k] = sbTxt_(f[k] == null ? '' : String(f[k]).trim()));
  f.estacion = sbNum_(f.estacion);
  if (f.tipo_polin) f.tipo_polin = f.tipo_polin.toUpperCase();
  if (f.tipo) f.tipo = f.tipo.toUpperCase();
  posiciones_(f, h);
  if (!f.criticidad) f.criticidad = POL_CRITICOS.indexOf(f.modo_falla) >= 0 ? 'Critico' : 'Riesgoso';
  if (!f.estado) f.estado = 'PENDIENTE';
  if (!f.temperatura) f.temperatura = 'Normal';
  if (!f.mesa) f.mesa = 'N/A';
  delete f.polines_falla;
  return f;
}

/** izq / cent1 / cent2 / der: 1 = polín con falla, 0 = sin falla, null = la estación no tiene esa posición */
function posiciones_(f, src) {
  ['izq', 'cent1', 'cent2', 'der'].forEach(p => {
    const v = src[p];
    f[p] = (v === null || v === undefined || v === '') ? null : (Number(v) ? 1 : 0);
  });
}

/** Siguiente id correlativo: prefijo + número con ceros (PL-2026-W43-0001) */
function siguienteId_(tabla, prefijo, digitos) {
  const r = sbLeer_(tabla, 'select=id&id=like.' + encodeURIComponent(prefijo + '*') + '&order=id.desc&limit=1');
  const n = r.length ? (parseInt(String(r[0].id).slice(prefijo.length), 10) || 0) + 1 : 1;
  return prefijo + ('0000000' + n).slice(-digitos);
}

/** Semana ISO de una fecha 'yyyy-mm-dd' */
function isoSemana_(fecha) {
  const d = new Date(fecha + 'T12:00:00Z');
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia + 3);
  const anio = d.getUTCFullYear();
  const ene4 = new Date(Date.UTC(anio, 0, 4));
  const semana = 1 + Math.round(((d - ene4) / 86400000 - 3 + ((ene4.getUTCDay() + 6) % 7)) / 7);
  return { anio: anio, semana: semana };
}

/** Registro de cambios en pol_seguimiento (nunca detiene el guardado) */
function seguimiento_(usuario, tabla, id, accion, antes, despues, campos) {
  try {
    const filas = [];
    const t = v => v === null || v === undefined ? null : String(v);
    if (!antes || !despues) filas.push({ usuario: usuario, tabla: tabla, registro_id: id, accion: accion, campo: null, valor_anterior: null, valor_nuevo: null });
    else campos.forEach(k => {
      if (k === 'id') return;
      if (t(antes[k]) !== t(despues[k])) filas.push({ usuario: usuario, tabla: tabla, registro_id: id, accion: accion, campo: k, valor_anterior: t(antes[k]), valor_nuevo: t(despues[k]) });
    });
    if (filas.length) sbInsertar_('pol_seguimiento', filas);
  } catch (e) { console.warn('seguimiento: ' + e.message); }
}

/* =====================================================================
 *  REPORTE FLASH DE DESVIACIONES (app «Reporte Flash Desviaciones»)
 *  Cada estación con prioridad Inmediato crea una fila en la hoja REPORTES de la planilla del Reporte Flash
 *  y su PDF en la carpeta de Drive de esa app (mismo formato de datos que la app Reporte Flash).
 *  Propiedad opcional: FLASH_SS_ID (otra planilla). FLASH = NO desactiva la generación automática.
 * ===================================================================== */
const FLASH_SS_ID = '1wpbkzmTxQG1wGV0T-4MnpuNICatVMrACJBes-tt08bs';   // BD_Reporte_Flash_Desviaciones
const FLASH_TITULO = 'REPORTE DE DESVIACIONES OPERACIONALES DCH - GEL';

function flashDesdeHallazgo_(h, quien) {
  if (String(sbProps_().FLASH || 'SI').toUpperCase() === 'NO') throw new Error('Generación de Reporte Flash desactivada (propiedad FLASH = NO)');
  const ss = SpreadsheetApp.openById(sbProps_().FLASH_SS_ID || FLASH_SS_ID);
  const hoja = flashHoja_(ss, 'REPORTES');
  if (!hoja) throw new Error('La planilla del Reporte Flash no tiene la hoja REPORTES');
  const id = 'RF-' + h.id;
  const ult = hoja.getLastRow();
  if (ult >= 2) {
    const ya = hoja.getRange(2, 1, ult - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
    if (ya) return { id: id, pdf: String(hoja.getRange(ya.getRow(), 19).getValue() || ''), duplicado: true };
  }
  const cfg = flashConfig_(ss);
  const eq = flashEquipo_(ss, h.equipo);
  const ahora = new Date();
  const s = isoSemana_(Utilities.formatDate(ahora, 'America/Santiago', 'yyyy-MM-dd'));
  const semana = 'W' + ('0' + s.semana).slice(-2);
  const pos = ['izq', 'cent1', 'cent2', 'der'].filter(k => Number(h[k]) === 1).map(k => ({ izq: 'izquierdo', cent1: 'central', cent2: 'central 2', der: 'derecho' })[k]);
  const lado = h.tipo === 'RETORNO' ? 'retorno' : 'carga';
  const lugar = h.equipo + (h.mesa && h.mesa !== 'N/A' ? ' · mesa ' + h.mesa : '') + (h.estacion != null ? ' · estación ' + h.estacion : '');
  const temp = h.temperatura && h.temperatura !== 'Normal' ? h.temperatura : '';
  const d = {
    titulo: ('Polín ' + String(h.modo_falla || '').toLowerCase() + ' en ' + lugar).slice(0, 110),
    componente: ('Polín ' + lado + ' ' + String(h.tipo_polin || '').toLowerCase() + (pos.length ? ' (' + pos.join(', ') + ')' : '')).slice(0, 60),
    descripcion: [
      'Inspección de polines ' + h.semana + '-' + h.anio + ' (' + h.id + '): estación con falla en ' + lugar + ', lado ' + lado + '.',
      'Modo de falla: ' + h.modo_falla + ' · criticidad ' + (h.criticidad === 'Critico' ? 'crítica' : 'riesgosa') + ' · prioridad inmediata.',
      'Polines con falla: ' + (pos.length || 0) + (pos.length ? ' (' + pos.join(', ') + ')' : '') + ' de una estación ' + String(h.tipo_polin || '').toLowerCase() + '.',
      temp ? 'Temperatura medida: ' + temp + '.' : '',
      h.comentario ? 'Observación de terreno: ' + h.comentario : '',
      'Tiempo de detención y pérdida: por completar si la condición genera detención.'
    ].filter(Boolean).join('\n'),
    nivel: h.criticidad === 'Critico' ? 'Alto' : 'Medio',
    kpi: (String(cfg.KPIS || 'Mineral Apilado').split(';')[0] || 'Mineral Apilado').trim(),
    accion: flashAcciones_(h, temp).join('\n')
  };
  // PDF en la carpeta del mes (si falla, la fila se guarda igual)
  let pdf = '', aviso = '';
  try {
    if (String(cfg.GUARDAR_EN_DRIVE || 'SI').toUpperCase() !== 'NO') {
      const html = flashHtml_(id, h, d, eq, ahora, semana, quien);
      const blob = Utilities.newBlob(html, 'text/html', 'flash.html').getAs('application/pdf')
        .setName(('Reporte_Flash_' + h.equipo + '_' + semana + '_' + id).replace(/[^\w\-]+/g, '_') + '.pdf');
      pdf = flashCarpeta_(ss, cfg, ahora).createFile(blob).getUrl();
    }
  } catch (e) { aviso = 'Reporte guardado sin PDF: ' + e.message; }
  const t = v => { const x = String(v == null ? '' : v).trim().slice(0, 5000); return /^[=+\-@]/.test(x) ? "'" + x : x; };
  hoja.appendRow([id, ahora, semana, s.anio, t(d.titulo), t(h.equipo), t(eq.gerencia), t(eq.area), t(d.componente), ahora, '', '',
    t(d.descripcion), d.nivel, t(d.kpi), t(d.accion), 0, '', pdf, t(quien), 'App Inspección de polines (' + h.id + ')']);
  try {
    const log = flashHoja_(ss, 'LOG');
    if (log) log.appendRow([ahora, 'INFO', id, 'Generado automáticamente desde Inspección de polines · ' + h.id + (aviso ? ' · ' + aviso : '')]);
  } catch (e) { }
  return { id: id, pdf: pdf, aviso: aviso };
}

function flashAcciones_(h, temp) {
  const a = [];
  const m = String(h.modo_falla || '');
  if (/Faltante|Quebrada|Doblada/.test(m)) a.push('Reponer la estación de polines en la próxima detención programada.');
  else a.push('Cambiar el/los polín(es) con falla en la próxima detención programada.');
  if (/Desbocado|Trabado/.test(m)) a.push('Señalizar la estación y aumentar la frecuencia de inspección hasta el cambio (riesgo de daño a la correa).');
  if (temp) a.push('Seguimiento termográfico del polín (' + temp + ') hasta su cambio.');
  a.push('Emitir aviso SAP y OT, y registrarlos en la app Inspección de polines.');
  a.push('Informar a operaciones del área.');
  return a;
}

function flashHoja_(ss, nombre) {
  const b = nombre.replace(/\s+/g, ' ').trim().toUpperCase();
  return ss.getSheets().filter(x => x.getName().replace(/\s+/g, ' ').trim().toUpperCase() === b)[0] || null;
}
function flashConfig_(ss) {
  const h = flashHoja_(ss, 'CONFIG'), c = {};
  if (h && h.getLastRow() >= 2) h.getRange(2, 1, h.getLastRow() - 1, 2).getValues().forEach(f => { const k = String(f[0] || '').trim().toUpperCase(); if (k) c[k] = String(f[1] == null ? '' : f[1]).trim(); });
  return c;
}
/** Gerencia y área del equipo desde BASE DE DATOS FIJOS (compara sin guiones ni espacios: 210CV02 = 210-CV-02) */
function flashEquipo_(ss, equipo) {
  const h = flashHoja_(ss, 'BASE DE DATOS FIJOS');
  const k = x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!h || h.getLastRow() < 2) return { gerencia: '', area: '' };
  const f = h.getRange(2, 1, h.getLastRow() - 1, 4).getValues().filter(r => k(r[0]) === k(equipo))[0];
  return f ? { gerencia: String(f[2] || ''), area: String(f[3] || '') } : { gerencia: '', area: '' };
}
function flashCarpeta_(ss, cfg, fecha) {
  let raiz = null;
  if (cfg.CARPETA_DRIVE_ID) { try { raiz = DriveApp.getFolderById(cfg.CARPETA_DRIVE_ID); } catch (e) { } }
  if (!raiz) {
    raiz = DriveApp.createFolder('Reportes Flash - Fotos y PDF');
    const h = flashHoja_(ss, 'CONFIG');
    if (h) {
      const n = Math.max(h.getLastRow() - 1, 0), ks = n ? h.getRange(2, 1, n, 1).getValues() : [];
      const i = ks.findIndex(r => String(r[0]).trim().toUpperCase() === 'CARPETA_DRIVE_ID');
      if (i >= 0) h.getRange(i + 2, 2).setValue(raiz.getId()); else h.appendRow(['CARPETA_DRIVE_ID', raiz.getId(), '']);
    }
  }
  const nom = Utilities.formatDate(fecha, 'America/Santiago', 'yyyy-MM');
  const it = raiz.getFoldersByName(nom);
  return it.hasNext() ? it.next() : raiz.createFolder(nom);
}
function flashLogo_() {
  const c = CacheService.getScriptCache();
  const v = c.get('flash_logo'); if (v) return v;
  try {
    const r = UrlFetchApp.fetch('https://gr1775san.github.io/APP-MSMIN/icons/logo.png', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return '';
    const d = 'data:image/png;base64,' + Utilities.base64Encode(r.getContent());
    if (d.length < 95000) c.put('flash_logo', d, 21600);
    return d;
  } catch (e) { return ''; }
}
/** PDF con los colores del Reporte Flash (franja teal y naranja de la PPT) */
function flashHtml_(id, h, d, eq, fecha, semana, quien) {
  const e = x => String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const br = x => e(x).replace(/\n/g, '<br>');
  const f = Utilities.formatDate(fecha, 'America/Santiago', 'dd-MM-yyyy HH:mm');
  const logo = flashLogo_();
  const fila = (a, b, c2, d2) => '<tr><th>' + a + '</th><td>' + b + '</td><th>' + c2 + '</th><td>' + d2 + '</td></tr>';
  const lis = d.accion.split('\n').map(x => '<li>' + e(x) + '</li>').join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{size:A4;margin:14mm 12mm}body{font-family:Arial,Helvetica,sans-serif;color:#1b262c;font-size:10pt;margin:0}' +
    '.cab{border-bottom:4pt solid #e55302;padding-bottom:6pt;margin-bottom:10pt;width:100%;border-collapse:collapse}.cab td{vertical-align:middle}' +
    'h1{font-size:14pt;color:#106470;margin:0}.sub{color:#5d6b73;font-size:9pt;margin-top:2pt}.id{text-align:right;font-size:9pt;color:#36424a}' +
    '.badge{display:inline-block;background:#e55302;color:#fff;font-weight:bold;padding:2pt 7pt;border-radius:3pt;font-size:9pt}' +
    'table.f{width:100%;border-collapse:collapse;margin-bottom:10pt}.f th{background:#eef2f4;color:#36424a;text-align:left;font-size:8pt;text-transform:uppercase;padding:4pt 5pt;border:.5pt solid #c9d3d8;width:17%}' +
    '.f td{padding:4pt 5pt;border:.5pt solid #c9d3d8;font-size:9.5pt;width:33%}' +
    '.sec{background:#106470;color:#fff;font-weight:bold;font-size:9.5pt;padding:5pt 8pt;margin-top:10pt}.box{border:.5pt solid #c9d3d8;border-top:0;padding:7pt 9pt;font-size:9.5pt;line-height:1.45}' +
    '.alto{color:#c13832;font-weight:bold}.pie{margin-top:14pt;font-size:7.5pt;color:#5d6b73;border-top:.5pt solid #c9d3d8;padding-top:4pt}' +
    '</style></head><body>' +
    '<table class="cab"><tr>' + (logo ? '<td style="width:150pt"><img src="' + logo + '" style="height:40pt"></td>' : '') +
    '<td><h1>' + e(FLASH_TITULO) + '</h1><div class="sub">Reporte flash generado automáticamente desde la Inspección de polines</div></td>' +
    '<td class="id"><span class="badge">CONDICIÓN INMEDIATA</span><br>' + e(id) + '<br>' + e(semana) + ' · ' + e(f) + '</td></tr></table>' +
    '<table class="f">' +
    '<tr><th>Título general</th><td colspan="3"><b>' + e(d.titulo) + '</b></td></tr>' +
    fila('Equipo', '<b>' + e(h.equipo) + '</b>', 'Componente', e(d.componente)) +
    fila('Gerencia / Superint.', e(eq.gerencia || '—'), 'Área / Proceso', e(eq.area || '—')) +
    fila('Fecha / hora evento', e(f), 'Semana', e(semana)) +
    fila('Tiempo de detención', 'Por completar', 'Pérdida estimada', 'Por completar') +
    '</table>' +
    '<div class="sec">I. DETALLE DE LA PÉRDIDA</div><div class="box">' + br(d.descripcion) + '</div>' +
    '<div class="sec">II. NIVEL DE IMPACTO</div><div class="box">Nivel de impacto: <span class="' + (d.nivel === 'Alto' ? 'alto' : '') + '">' + e(d.nivel) + '</span> &nbsp;·&nbsp; KPI de desempeño afectado: ' + e(d.kpi) + '</div>' +
    '<div class="sec">ACCIÓN INMEDIATA</div><div class="box"><ol style="margin:0 0 0 14pt;padding:0">' + lis + '</ol></div>' +
    '<div class="pie">Reportado por ' + e(quien || '—') + ' · Origen: app Inspección de polines (' + e(h.id) + ') · MSMIN · Ingeniería de mantenimiento · Contrato 4600030865 · División Chuquicamata</div>' +
    '</body></html>';
}

/* =====================================================================
 *  ESPEJO EN DRIVE (planilla BD_Polines). Nunca detiene el guardado.
 * ===================================================================== */
let _ESP = null;
function espejoHoja_(nombre) {
  if (String(sbProps_().ESPEJO_DRIVE || 'SI').toUpperCase() === 'NO') return null;
  if (!_ESP) {
    let id = sbProps_().ESPEJO_ID;
    if (!id) { const c = sbLeer_('pol_config', 'select=valor&clave=eq.espejo_drive_id')[0]; id = c && c.valor; }
    if (!id) return null;
    _ESP = SpreadsheetApp.openById(id);
  }
  return _ESP.getSheetByName(nombre);
}

/** Inserta o actualiza filas en la hoja espejo (busca por id en la columna A) */
function espejo_(hoja, cols, filas) {
  try {
    if (!filas || !filas.length) return;
    const sh = espejoHoja_(hoja); if (!sh) return;
    const n = Math.max(sh.getLastRow() - 1, 1);
    const ids = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]));
    let libre = ids.length; while (libre > 0 && !ids[libre - 1]) libre--;   // primera fila vacía (la hoja mantenciones trae fórmulas hasta abajo)
    const v = x => x === null || x === undefined ? '' : x;
    filas.forEach(f => {
      const fila = cols.map(c => v(f[c]));
      const i = ids.indexOf(String(f.id));
      if (i >= 0) sh.getRange(i + 2, 1, 1, cols.length).setValues([fila]);
      else { sh.getRange(libre + 2, 1, 1, cols.length).setValues([fila]); ids[libre] = String(f.id); libre++; }
    });
  } catch (e) { console.warn('espejo ' + hoja + ': ' + e.message); }
}

function espejoBorrar_(hoja, idsBorrar) {
  try {
    const sh = espejoHoja_(hoja); if (!sh) return;
    const n = Math.max(sh.getLastRow() - 1, 1);
    const ids = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]));
    idsBorrar.map(id => ids.indexOf(String(id))).filter(i => i >= 0).sort((a, b) => b - a).forEach(i => sh.deleteRow(i + 2));
  } catch (e) { console.warn('espejo borrar ' + hoja + ': ' + e.message); }
}

/* =====================================================================
 *  SUPABASE
 * ===================================================================== */
let _SBP = null;
function sbProps_() { return _SBP || (_SBP = PropertiesService.getScriptProperties().getProperties()); }

function sbBase_() {
  const p = sbProps_();
  if (!p.SUPABASE_URL || !p.SUPABASE_SERVICE_KEY) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en Propiedades del script');
  const key = String(p.SUPABASE_SERVICE_KEY).trim();
  const headers = { apikey: key };
  if (/^eyJ/.test(key)) headers.Authorization = 'Bearer ' + key;
  return { url: String(p.SUPABASE_URL).trim().replace(/\/+$/, '') + '/rest/v1/', headers: headers };
}

function sbError_(r) {
  const code = r.getResponseCode(), txt = r.getContentText();
  let m = txt;
  try { const j = JSON.parse(txt); m = [j.message, j.details, j.hint].filter(Boolean).join(' · ') || txt; } catch (e) { }
  return new Error('Supabase ' + code + ': ' + String(m).slice(0, 400));
}

function sb_(metodo, ruta, cuerpo, prefer) {
  const b = sbBase_();
  const headers = Object.assign({}, b.headers);
  if (prefer) headers.Prefer = prefer;
  const opts = { method: metodo, headers: headers, muteHttpExceptions: true };
  if (cuerpo !== undefined) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(cuerpo); }
  let r, intento = 0;
  while (true) {
    r = UrlFetchApp.fetch(b.url + ruta, opts);
    const code = r.getResponseCode();
    if ((code === 429 || code >= 500) && intento < 2) { intento++; Utilities.sleep(800 * intento); continue; }
    break;
  }
  if (r.getResponseCode() >= 300) throw sbError_(r);
  const txt = r.getContentText();
  return txt ? JSON.parse(txt) : null;
}

/** Varias lecturas en paralelo */
function sbVarios_(rutas) {
  const b = sbBase_();
  return UrlFetchApp.fetchAll(rutas.map(r => ({ url: b.url + r, method: 'get', headers: b.headers, muteHttpExceptions: true }))).map(r => {
    if (r.getResponseCode() >= 300) throw sbError_(r);
    return JSON.parse(r.getContentText() || '[]');
  });
}

function sbLeer_(tabla, consulta) { return sb_('get', tabla + '?' + (consulta || 'select=*')) || []; }

/** Lee todas las filas, de a 1000 (límite de Supabase por consulta) */
function sbTodo_(tabla, consulta) {
  const out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const r = sbLeer_(tabla, consulta + '&limit=1000&offset=' + off);
    r.forEach(x => out.push(x));
    if (r.length < 1000) break;
  }
  return out;
}

function sbGuardar_(tabla, filas) {
  if (!filas || !filas.length) return [];
  const out = [];
  for (let i = 0; i < filas.length; i += 500)
    (sb_('post', tabla, filas.slice(i, i + 500), 'resolution=merge-duplicates,return=representation') || []).forEach(x => out.push(x));
  return out;
}

function sbInsertar_(tabla, filas) {
  for (let i = 0; i < filas.length; i += 500) sb_('post', tabla, filas.slice(i, i + 500), 'return=minimal');
}

function sbBorrar_(tabla, filtro) {
  if (!filtro) throw new Error('sbBorrar_ necesita un filtro');
  return sb_('delete', tabla + '?' + filtro, undefined, 'return=representation') || [];
}

function sbEq_(col, v) { return col + '=eq.' + encodeURIComponent(String(v)); }
function sbNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const x = Number(String(v).replace(',', '.'));
  return isNaN(x) ? null : x;
}
function sbFecha_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) return Utilities.formatDate(v, 'America/Santiago', 'yyyy-MM-dd');
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return null;
}
function sbTxt_(v) { return v === '' || v === null || v === undefined ? null : String(v); }

/** Ejecutar desde el editor: revisa la conexión con Supabase y la planilla espejo */
function probarSupabase() {
  ['pol_inspecciones', 'pol_hallazgos', 'pol_mantenciones', 'pol_listas', 'pol_config', 'pol_seguimiento'].forEach(t => {
    try { Logger.log('OK · ' + t + ': ' + sbLeer_(t, 'select=*&limit=1000').length + ' filas (máx. 1000)'); }
    catch (e) { Logger.log('ERROR · ' + t + ' → ' + e.message); }
  });
  try { const sh = espejoHoja_('hallazgos'); Logger.log('Espejo Drive: ' + (sh ? 'OK (' + (sh.getLastRow() - 1) + ' filas en hallazgos)' : 'desactivado')); }
  catch (e) { Logger.log('Espejo Drive: ERROR → ' + e.message); }
}



/* ======================================================================
 *  MSMIN_INFORMES · PDF de las inspecciones
 *  La página arma el informe (HTML) con los datos que ya tiene y aquí se convierte a PDF.
 *  No guarda nada en Drive: el PDF se descarga directo en el celular o el PC.
 * ====================================================================== */
function msminInformePdf(html, nombre) {
  html = String(html || '');
  if (!html) throw new Error('Informe vacío');
  if (html.length > 25000000) throw new Error('El informe es demasiado grande');
  if (typeof msminFotos_ === 'function') html = msminFotos_(html);
  const pdf = Utilities.newBlob(html, 'text/html', 'informe.html').getAs('application/pdf');
  let n = String(nombre || 'Informe').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Informe';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return { nombre: n, b64: Utilities.base64Encode(pdf.getBytes()) };
}


/* Página de la app (generada desde pagina.html + módulos comunes MSMIN). */
const INDEX_HTML = "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<base target=\"_top\">\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<title>Inspección de polines · MSMIN</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap\" rel=\"stylesheet\">\n<style>\n:root{\n  --bg:#0B1A2C; --surface:#12253B; --surface2:#183049; --ink:#E9EFF5; --ink2:#B4C3D2; --ink3:#8399AE;\n  --line:#244260; --slate:#2A6CB0; --slate2:#6FB0E6; --amber:#E8A317;\n  --crit:#F08A80; --crit-bg:rgba(179,38,30,.22); --riesgo:#E3C552; --riesgo-bg:rgba(122,100,0,.30); --ok:#7FD69A; --ok-bg:rgba(76,175,110,.18);\n  --radius:12px; --shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.28); --nav-h:64px;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;padding:0}\nbody{background:var(--bg);color:var(--ink);font:15px/1.45 \"IBM Plex Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}\nh1,h2,h3,.cond{font-family:\"IBM Plex Sans Condensed\",\"IBM Plex Sans\",system-ui,sans-serif;letter-spacing:.01em}\n.mono{font-family:\"IBM Plex Mono\",ui-monospace,monospace;font-size:.9em}\nbutton,input,select,textarea{font:inherit;color:inherit}\n[hidden]{display:none!important}\n\n/* Encabezado */\n.top{background:#07111D;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:20;padding:calc(env(safe-area-inset-top) + 10px) 16px 10px}\n.top-in{max-width:1280px;margin:0 auto;display:flex;align-items:center;gap:10px}\n.mark{width:36px;height:36px;border-radius:9px;background:var(--amber);display:grid;place-items:center;flex:none;color:#2A1B00}\n.mark svg{width:24px;height:24px}\n.ttl{min-width:0;flex:1}\n.ttl h1{margin:0;font-size:17px;font-weight:700;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.ttl small{display:block;color:#B8CAD6;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.btn-ico{width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--surface);display:grid;place-items:center;cursor:pointer;flex:none}\n.btn-ico svg{width:19px;height:19px}\n\n/* Navegación inferior */\n.bnav{position:fixed;left:0;right:0;bottom:0;z-index:25;background:var(--surface);border-top:1px solid var(--line);display:grid;grid-template-columns:repeat(4,1fr);padding-bottom:env(safe-area-inset-bottom)}\n.bnav button{background:none;border:0;padding:8px 4px 9px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:12px;color:var(--ink3);cursor:pointer;min-height:var(--nav-h)}\n.bnav svg{width:22px;height:22px}\n.bnav button[aria-current=\"true\"]{color:var(--ink)}\n.bnav button[aria-current=\"true\"] svg{color:var(--amber)}\n@media (min-width:900px){.bnav{left:50%;right:auto;transform:translateX(-50%);width:560px;bottom:14px;border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding-bottom:0}}\n\nmain{max-width:1280px;margin:0 auto;padding:14px 16px calc(var(--nav-h) + 90px)}\n.view{display:none}.view.on{display:block}\n.sec-h{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:4px 0 12px}\n.sec-h h2{margin:0;font-size:22px}\n.sec-h p{margin:2px 0 0;color:var(--ink2);font-size:13.5px}\n\n/* Barra de semana */\n.semana{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px}\n.semana label{font-size:12.5px;color:var(--ink3);text-transform:uppercase;letter-spacing:.06em}\n.semana select{flex:1;min-width:160px}\n.semana .info{width:100%;font-size:12.5px;color:var(--ink2)}\n\n/* Controles */\ninput,select,textarea{background:var(--surface2);border:1px solid var(--line);border-radius:10px;padding:10px 11px;min-height:44px;width:100%;font-size:16px}\ntextarea{min-height:76px;resize:vertical}\ninput:focus,select:focus,textarea:focus{outline:2px solid var(--amber);border-color:var(--amber)}\n.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);padding:10px 16px;min-height:44px;cursor:pointer;font-weight:600;white-space:nowrap}\n.btn.pri{background:var(--amber);border-color:var(--amber);color:#2A1B00}\n.btn.az{background:var(--slate);border-color:var(--slate);color:#fff}\n.btn.peligro{background:none;border-color:rgba(240,138,128,.6);color:var(--crit)}\n.btn:disabled{opacity:.55;cursor:wait}\n.btn svg{width:18px;height:18px}\n.fld{display:flex;flex-direction:column;gap:5px;min-width:0}\n.fld>label,.lbl{font-size:12.5px;color:var(--ink2);font-weight:500}\n.grid{display:grid;gap:12px;grid-template-columns:repeat(2,minmax(0,1fr))}\n.grid .full{grid-column:1/-1}\n@media (min-width:760px){.grid.g4{grid-template-columns:repeat(4,minmax(0,1fr))}}\n.seg{display:flex;flex-wrap:wrap;gap:6px}\n.seg button{flex:1 1 auto;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--surface2);padding:8px 12px;cursor:pointer;font-weight:500;font-size:14px}\n.seg button[aria-pressed=\"true\"]{background:rgba(232,163,23,.18);border-color:var(--amber);color:#FFE2A6}\n.seg.crit button[data-v=\"Critico\"][aria-pressed=\"true\"]{background:var(--crit-bg);border-color:var(--crit);color:#FFD4CF}\n.num{display:flex;gap:6px}.num input{text-align:center}\n.num input::-webkit-inner-spin-button,.num input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}.num input{-moz-appearance:textfield}\n.num button{width:48px;flex:none;border-radius:10px;border:1px solid var(--line);background:var(--surface2);font-size:20px;cursor:pointer}\n.acciones{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-top:16px}\n.ayuda{font-size:12.5px;color:var(--ink3);margin:4px 0 0}\n\n/* Estación de polines (posiciones) */\n.est{display:flex;align-items:flex-end;justify-content:center;gap:6px;padding:14px 10px 10px;background:var(--surface2);border:1px solid var(--line);border-radius:12px;min-height:110px}\n.est button{border:2px solid #5E7286;background:#2A3E54;color:var(--ink2);border-radius:999px;width:74px;height:40px;cursor:pointer;font-size:12px;font-weight:600;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.1}\n.est button.lat{transform:rotate(0);margin-bottom:26px}\n.est button[aria-pressed=\"true\"]{background:var(--crit-bg);border-color:var(--crit);color:#FFD4CF}\n.est button small{font-size:10px;font-weight:500;opacity:.85}\n.est.retorno{align-items:flex-start}.est.retorno button.lat{margin:0}\n.est-n{text-align:center;font-size:12.5px;color:var(--ink3);margin-top:6px}\n\n/* KPI y tarjetas */\n.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}\n@media (min-width:760px){.kpis{grid-template-columns:repeat(6,1fr)}}\n.kpi{background:var(--surface);border-radius:var(--radius);padding:14px;box-shadow:var(--shadow);border-left:4px solid var(--slate);cursor:pointer;text-align:left;border-top:0;border-right:0;border-bottom:0}\n.kpi.c{border-left-color:var(--crit)} .kpi.w{border-left-color:var(--amber)} .kpi.o{border-left-color:var(--ok)}\n.kpi b{display:block;font:700 30px/1 \"IBM Plex Sans Condensed\",sans-serif;font-variant-numeric:tabular-nums}\n.kpi span{display:block;color:var(--ink2);font-size:12.5px;margin-top:6px}\n.cols{display:grid;gap:12px;grid-template-columns:minmax(0,1fr)}\n@media (min-width:980px){.cols{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}}\n.card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;min-width:0}\n.card h3{margin:0 0 12px;font-size:16px}\n.card+.card{margin-top:12px}\n.bar{display:grid;grid-template-columns:minmax(96px,40%) 1fr 40px;align-items:center;gap:10px;margin:7px 0;font-size:13.5px}\n.bar .l{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink2)}\n.bar .trk{display:flex;height:12px;background:var(--surface2);border-radius:6px;overflow:hidden}\n.bar .f{display:block;height:100%;background:var(--slate2)}\n.bar .f.c{background:var(--crit)}\n.bar .n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}\n.tbl{width:100%;border-collapse:collapse;font-size:13.5px}\n.tbl th{text-align:right;font-weight:600;color:var(--ink3);font-size:12px;padding:6px 6px;border-bottom:1px solid var(--line)}\n.tbl th:first-child,.tbl td:first-child{text-align:left}\n.tbl td{text-align:right;padding:8px 6px;border-bottom:1px solid #1D3753;font-variant-numeric:tabular-nums}\n.tbl tr.clic{cursor:pointer}.tbl tr.clic:hover td{background:var(--surface2)}\n.tbl td.c{color:var(--crit);font-weight:600}\n.tbl tfoot td{font-weight:700;border-bottom:0}\n.scroll{overflow-x:auto}\n.leyenda{display:flex;gap:14px;font-size:12.5px;color:var(--ink2);margin:-4px 0 8px}\n.leyenda i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}\n\n/* Filtros y lista de hallazgos */\n.filtros{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:10px}\n.filtros .q{grid-column:1/-1}\n@media (min-width:900px){.filtros{grid-template-columns:2fr repeat(5,1fr) auto}.filtros .q{grid-column:auto}}\n.cnt{font-size:13px;color:var(--ink2);margin:0 0 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}\n.cnt .sp{flex:1}\n.lista{display:flex;flex-direction:column;gap:8px}\n.hz{display:flex;gap:12px;align-items:center;background:var(--surface);border-radius:12px;padding:11px 12px;border-left:5px solid var(--riesgo);cursor:pointer;text-align:left;width:100%;border-top:0;border-right:0;border-bottom:0}\n.hz.Critico{border-left-color:var(--crit)}\n.hz:hover{background:#15304A}\n.hz .m{flex:1;min-width:0}\n.hz .m b{display:block;font-size:15px}\n.hz .m small{display:block;color:var(--ink2);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.hz .d{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none}\n.hz input[type=checkbox]{width:22px;height:22px;min-height:0;flex:none}\n.pos{display:inline-flex;gap:3px;vertical-align:middle;margin-left:6px}\n.pos i{width:13px;height:9px;border-radius:5px;background:#3B5571;display:inline-block}\n.pos i.f{background:var(--crit)}\n.badge{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:3px 9px;white-space:nowrap;background:var(--surface2);color:var(--ink2);border:1px solid var(--line)}\n.badge.Critico{background:var(--crit-bg);color:#FFD4CF;border-color:rgba(240,138,128,.5)}\n.badge.Riesgoso{background:var(--riesgo-bg);color:#F5E3A0;border-color:rgba(227,197,82,.45)}\n.badge.CERRADO{background:var(--ok-bg);color:#BDEFCB;border-color:rgba(127,214,154,.45)}\n.badge.PROGRAMADO,.badge.EN{background:rgba(111,176,230,.16);color:#CFE6F8;border-color:rgba(111,176,230,.45)}\n.badge.fl{background:rgba(229,83,2,.2);color:#FFC9A8;border-color:rgba(229,83,2,.55)}\n.flash{background:rgba(229,83,2,.14);border:1px solid rgba(229,83,2,.5);border-radius:10px;padding:10px 12px;margin:12px 0 0;font-size:14px}\n.flash a{color:#FFC9A8;font-weight:600}\n.badge.inm{background:rgba(232,163,23,.18);color:#FFE2A6;border-color:rgba(232,163,23,.5)}\n.masivo{position:sticky;top:64px;z-index:5;background:#0F2A44;border:1px solid var(--slate);border-radius:12px;padding:10px;margin-bottom:10px;display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr))}\n.masivo .full{grid-column:1/-1;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}\n@media (min-width:900px){.masivo{grid-template-columns:repeat(4,1fr) auto}.masivo .full{grid-column:auto}}\n.vacio{color:var(--ink3);text-align:center;padding:30px 10px}\n.recientes{margin-top:14px}\n.recientes li{font-size:13.5px;color:var(--ink2);padding:6px 0;border-bottom:1px solid #1D3753;list-style:none}\n.recientes ul{margin:0;padding:0}\n\n/* Modal */\n.fondo{position:fixed;inset:0;background:rgba(2,8,15,.7);z-index:40;display:none}\n.fondo.on{display:block}\n.modal{position:fixed;z-index:41;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(100vw - 16px));max-height:calc(100vh - 24px);display:none;flex-direction:column;background:#0F2033;border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.5)}\n.modal.on{display:flex}\n.modal .hd{display:flex;align-items:center;gap:10px;padding:14px 14px 10px 18px;border-bottom:1px solid var(--line)}\n.modal .hd h3{margin:0;flex:1;font-size:18px}\n.modal .bd{padding:16px 18px 18px;overflow:auto;-webkit-overflow-scrolling:touch}\n.x{width:40px;height:40px;border:0;border-radius:10px;background:none;font-size:20px;cursor:pointer}\n.x:hover{background:var(--surface2)}\n\n.toast{position:fixed;left:50%;bottom:calc(var(--nav-h) + 24px);transform:translateX(-50%) translateY(20px);background:#1E6B2D;color:#fff;padding:12px 18px;border-radius:12px;box-shadow:var(--shadow);opacity:0;pointer-events:none;transition:.25s;z-index:60;max-width:calc(100vw - 32px);font-weight:500}\n.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}\n.toast.err{background:#8A1C24}\n#loader{position:fixed;inset:0;background:var(--bg);display:grid;place-items:center;z-index:70;color:var(--ink2)}\n.spin{width:38px;height:38px;border:4px solid var(--line);border-top-color:var(--amber);border-radius:50%;animation:g 1s linear infinite;margin:0 auto 12px}\n@keyframes g{to{transform:rotate(360deg)}}\n.ocup{position:fixed;top:0;left:0;right:0;height:3px;z-index:80;background:linear-gradient(90deg,transparent,var(--amber),transparent);background-size:50% 100%;animation:o 1s linear infinite;display:none}\n.ocup.on{display:block}\n@keyframes o{from{background-position:-50% 0}to{background-position:150% 0}}\n</style>\n</head>\n<body>\n<div id=\"loader\"><div><div class=\"spin\"></div>Cargando inspección de polines…</div></div>\n<div class=\"ocup\" id=\"ocup\"></div>\n\n<header class=\"top\">\n  <div class=\"top-in\">\n    <div class=\"mark\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><rect x=\"3\" y=\"9\" width=\"18\" height=\"6\" rx=\"3\"/><path d=\"M7 9v6M17 9v6M2 19h20\"/></svg></div>\n    <div class=\"ttl\"><h1>Inspección de polines</h1><small id=\"sub\">Correas transportadoras</small></div>\n    <button class=\"btn-ico\" id=\"btnRecargar\" title=\"Recargar datos\" aria-label=\"Recargar datos\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7\"/></svg></button>\n  </div>\n</header>\n\n<main>\n  <div class=\"semana\">\n    <label for=\"selInsp\">Semana</label>\n    <select id=\"selInsp\" aria-label=\"Inspección\"></select>\n    <button class=\"btn\" id=\"btnNuevaSem\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\"><path d=\"M12 5v14M5 12h14\"/></svg>Nueva semana</button>\n    <div class=\"info\" id=\"inspInfo\"></div>\n  </div>\n\n  <!-- RESUMEN -->\n  <section class=\"view on\" id=\"v-resumen\">\n    <div class=\"sec-h\"><div><h2>Resumen</h2><p id=\"resSub\"></p></div></div>\n    <div class=\"kpis\" id=\"kpis\"></div>\n    <div class=\"cols\">\n      <div>\n        <div class=\"card\"><h3>Estaciones con falla por equipo</h3><div class=\"scroll\"><table class=\"tbl\" id=\"tEquipos\"></table></div></div>\n      </div>\n      <div>\n        <div class=\"card\"><h3>Modos de falla</h3><div class=\"leyenda\"><span><i style=\"background:var(--crit)\"></i>Crítico</span><span><i style=\"background:var(--slate2)\"></i>Riesgoso</span></div><div id=\"bModos\"></div></div>\n        <div class=\"card\"><h3>Alertas de temperatura</h3><div id=\"lTemp\"></div></div>\n        <div class=\"card\"><h3>Avance de la semana</h3><div id=\"bEstado\"></div></div>\n      </div>\n    </div>\n  </section>\n\n  <!-- HALLAZGOS -->\n  <section class=\"view\" id=\"v-hallazgos\">\n    <div class=\"sec-h\"><div><h2>Estaciones con falla</h2><p>Toca una estación para editarla o registrar su aviso, OT y estado.</p></div></div>\n    <div class=\"filtros\">\n      <input class=\"q\" id=\"fQ\" type=\"search\" placeholder=\"Buscar: mesa, comentario, aviso, OT, id…\" autocomplete=\"off\">\n      <select id=\"fEquipo\"><option value=\"\">Todos los equipos</option></select>\n      <select id=\"fCrit\"><option value=\"\">Criticidad</option></select>\n      <select id=\"fPrio\"><option value=\"\">Prioridad</option></select>\n      <select id=\"fEstado\"><option value=\"\">Estado</option></select>\n      <select id=\"fTipo\"><option value=\"\">Carga y retorno</option></select>\n      <button class=\"btn\" id=\"fLimpiar\">Limpiar</button>\n    </div>\n    <div class=\"masivo\" id=\"masivo\" hidden>\n      <select id=\"mEstado\"><option value=\"\">Estado…</option></select>\n      <select id=\"mPrio\"><option value=\"\">Prioridad…</option></select>\n      <input id=\"mAviso\" placeholder=\"N° aviso\" inputmode=\"numeric\">\n      <input id=\"mOt\" placeholder=\"N° OT\" inputmode=\"numeric\">\n      <div class=\"full\"><span id=\"mCnt\">0 seleccionadas</span><span style=\"display:flex;gap:8px\"><button class=\"btn\" id=\"mTodas\">Todas</button><button class=\"btn az\" id=\"mAplicar\">Aplicar</button></span></div>\n    </div>\n    <p class=\"cnt\"><span id=\"hCnt\"></span><span class=\"sp\"></span><button class=\"btn\" id=\"btnSel\">Selección múltiple</button></p>\n    <div class=\"lista\" id=\"lista\"></div>\n    <div style=\"text-align:center;margin-top:12px\"><button class=\"btn\" id=\"btnMas\" hidden>Mostrar más</button></div>\n  </section>\n\n  <!-- REGISTRAR -->\n  <section class=\"view\" id=\"v-registrar\">\n    <div class=\"sec-h\"><div><h2>Registrar estación con falla</h2><p id=\"regSub\"></p></div></div>\n    <div class=\"card\"><div id=\"formReg\"></div>\n      <div class=\"acciones\"><button class=\"btn\" id=\"regLimpiar\">Limpiar</button><button class=\"btn\" id=\"regGuardar\">Guardar</button><button class=\"btn pri\" id=\"regSig\">Guardar y siguiente estación</button></div>\n    </div>\n    <div class=\"card recientes\"><h3>Registradas en esta sesión</h3><ul id=\"regRec\"><li>Aún no registras estaciones.</li></ul></div>\n  </section>\n\n  <!-- MANTENCIÓN -->\n  <section class=\"view\" id=\"v-mantencion\">\n    <div class=\"sec-h\"><div><h2>Mantenciones</h2><p>Cambio de polín o de estación. Si eliges el hallazgo que resuelve, queda CERRADO.</p></div></div>\n    <div class=\"card\"><div id=\"formMt\"></div>\n      <div class=\"acciones\"><button class=\"btn\" id=\"mtLimpiar\">Limpiar</button><button class=\"btn pri\" id=\"mtGuardar\">Guardar mantención</button></div>\n    </div>\n    <div class=\"card\"><h3>Últimas mantenciones</h3><div class=\"scroll\"><table class=\"tbl\" id=\"tMt\"></table></div></div>\n  </section>\n</main>\n\n<nav class=\"bnav\" aria-label=\"Secciones\">\n  <button data-v=\"resumen\" aria-current=\"true\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M4 20V10M10 20V4M16 20v-7M22 20H2\"/></svg>Resumen</button>\n  <button data-v=\"hallazgos\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01\"/></svg>Hallazgos</button>\n  <button data-v=\"registrar\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 8v8M8 12h8\"/></svg>Registrar</button>\n  <button data-v=\"mantencion\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z\"/></svg>Mantención</button>\n</nav>\n\n<div class=\"fondo\" id=\"fondo\"></div>\n<section class=\"modal\" id=\"modal\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"mTit\">\n  <div class=\"hd\"><h3 id=\"mTit\"></h3><button class=\"x\" id=\"mX\" aria-label=\"Cerrar\">✕</button></div>\n  <div class=\"bd\" id=\"mBd\"></div>\n</section>\n<div class=\"toast\" id=\"toast\" role=\"status\"></div>\n\n<script>\nvar BOOT = /*__BOOT__*/null;\nvar S = { listas: {}, config: {}, insps: [], actual: '', hz: [], mt: [], usuario: '', sel: null, limite: 150, recientes: [] };\nvar POS = { MONO: ['cent1'], DOBLE: ['izq', 'der'], TRIPLE: ['izq', 'cent1', 'der'], CUADRUPLE: ['izq', 'cent1', 'cent2', 'der'] };\nvar POS_TXT = { izq: 'Izq.', cent1: 'Centro', cent2: 'Centro 2', der: 'Der.' };\nvar CRITICOS = ['Desbocado', 'Trabado'];\n\nfunction $(id) { return document.getElementById(id); }\nfunction esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\nfunction fmtF(f) { var m = String(f || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(f || ''); }\nfunction hoy() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }\nfunction norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }\nfunction toast(m, err) { var t = $('toast'); t.textContent = m; t.className = 'toast on' + (err ? ' err' : ''); clearTimeout(t._h); t._h = setTimeout(function () { t.className = 'toast'; }, err ? 7000 : 3000); }\nfunction nPol(h) { return ['izq', 'cent1', 'cent2', 'der'].reduce(function (a, k) { return a + (Number(h[k]) || 0); }, 0); }\nfunction abierto(h) { return String(h.estado || '').toUpperCase() !== 'CERRADO'; }\nfunction crit(h) { return h.criticidad === 'Critico'; }\nfunction inm(h) { return h.prioridad === 'Inmediato'; }\nfunction lst(k) { return S.listas[k] || []; }\nfunction semIso(f) {\n  var d = new Date(f + 'T12:00:00Z'), dia = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dia + 3);\n  var a = d.getUTCFullYear(), e = new Date(Date.UTC(a, 0, 4));\n  return { anio: a, semana: 1 + Math.round(((d - e) / 86400000 - 3 + ((e.getUTCDay() + 6) % 7)) / 7) };\n}\nvar nOcup = 0;\nfunction run(fn) {\n  var args = Array.prototype.slice.call(arguments, 1);\n  nOcup++; $('ocup').classList.add('on');\n  return new Promise(function (ok, mal) {\n    var fin = function () { if (--nOcup <= 0) { nOcup = 0; $('ocup').classList.remove('on'); } };\n    if (!window.google || !google.script) { fin(); mal(new Error('Abre la app desde su enlace de Apps Script.')); return; }\n    var r = google.script.run.withSuccessHandler(function (x) { fin(); ok(x); }).withFailureHandler(function (e) { fin(); mal(e); });\n    r[fn].apply(r, args);\n  });\n}\n/** El Reporte Flash solo corre en inspecciones desde pol_config.flash_desde (ej. 'SEM 42-2026') */\nfunction flashOk(h) {\n  var m = String(S.config.flash_desde || 'SEM 42-2026').match(/(\\d{1,2})\\D+(20\\d\\d)/), d = m ? +m[2] * 100 + +m[1] : 202642;\n  var w = +((String(h.semana || '').match(/(\\d{1,2})/) || [])[1]) || 0;\n  return (+h.anio || 0) * 100 + w >= d;\n}\nfunction msgFlash(f) {\n  if (f._flash_error) return ' · ' + f._flash_error;\n  if (f._flash_nuevo) return ' · ⚡ Reporte Flash ' + f.flash_id + ' generado' + (f._flash_aviso ? ' (' + f._flash_aviso + ')' : '');\n  return '';\n}\nfunction errTxt(e) { return (e && e.message) || String(e); }\n\n/* ---------------- Carga ---------------- */\nfunction aplicarDatos(d) {\n  S.listas = d.listas || {}; S.config = d.config || {}; S.insps = d.inspecciones || []; S.actual = d.actual || '';\n  S.hz = d.hallazgos || []; S.mt = d.mantenciones || []; S.usuario = d.usuario || S.usuario;\n}\nfunction inspActual() { return S.insps.filter(function (x) { return x.id === S.actual; })[0] || null; }\nfunction titInsp(i) { return i ? i.semana + ' · ' + i.anio + ' · ' + fmtF(i.fecha) : ''; }\n\nfunction pintarTodo() {\n  var i = inspActual();\n  $('selInsp').innerHTML = S.insps.map(function (x) { return '<option value=\"' + esc(x.id) + '\"' + (x.id === S.actual ? ' selected' : '') + '>' + esc(titInsp(x)) + '</option>'; }).join('') || '<option value=\"\">Sin inspecciones</option>';\n  $('sub').textContent = i ? titInsp(i) + ' · ' + S.hz.length + ' estaciones con falla' : 'Crea la primera semana de inspección';\n  $('inspInfo').textContent = i ? (i.descripcion || '') : '';\n  llenarFiltros();\n  pintarResumen(); pintarLista(); pintarMt();\n  $('regSub').textContent = i ? 'Se agrega a la inspección ' + titInsp(i) + '.' + (flashOk(i) ? ' Las de prioridad Inmediato generan su Reporte Flash.' : '') : 'Primero crea la semana de inspección.';\n}\n\nfunction cambiarInsp(id) {\n  if (!id || id === S.actual) return;\n  run('polHallazgos', id).then(function (r) { S.actual = r.inspeccion; S.hz = r.hallazgos; S.sel = null; pintarTodo(); formRegNuevo(); })\n    .catch(function (e) { toast('No se pudo cargar la semana: ' + errTxt(e), true); $('selInsp').value = S.actual; });\n}\n\n/* ---------------- Resumen ---------------- */\nfunction contar(arr, fk) { var o = {}; arr.forEach(function (x) { var k = fk(x); o[k] = (o[k] || 0) + 1; }); return o; }\nfunction pintarResumen() {\n  var h = S.hz, i = inspActual();\n  $('resSub').textContent = i ? titInsp(i) + (S.config.division ? ' · División ' + S.config.division : '') : '';\n  var pol = h.reduce(function (a, x) { return a + nPol(x); }, 0), eqs = Object.keys(contar(h, function (x) { return x.equipo; })).length;\n  var k = [\n    [h.length, 'Estaciones con falla', '', {}], [pol, 'Polines con falla', '', {}],\n    [h.filter(crit).length, 'Críticas', 'c', { crit: 'Critico' }], [h.filter(inm).length, 'Prioridad inmediata', 'w', { prio: 'Inmediato' }],\n    [h.filter(abierto).length, 'Abiertas', 'w', { estado: '_abiertos' }], [h.length - h.filter(abierto).length, 'Cerradas', 'o', { estado: 'CERRADO' }]];\n  $('kpis').innerHTML = k.map(function (x, j) { return '<button class=\"kpi ' + x[2] + '\" data-j=\"' + j + '\"><b>' + x[0].toLocaleString('es-CL') + '</b><span>' + esc(x[1]) + (j === 0 ? ' · ' + eqs + ' equipos' : '') + '</span></button>'; }).join('');\n  $('kpis').onclick = function (e) { var b = e.target.closest('.kpi'); if (b) irFiltrado(k[+b.dataset.j][3]); };\n\n  var porEq = {};\n  h.forEach(function (x) {\n    var o = porEq[x.equipo] || (porEq[x.equipo] = { e: x.equipo, n: 0, p: 0, c: 0, i: 0, a: 0 });\n    o.n++; o.p += nPol(x); if (crit(x)) o.c++; if (inm(x)) o.i++; if (abierto(x)) o.a++;\n  });\n  var filas = Object.keys(porEq).map(function (q) { return porEq[q]; }).sort(function (a, b) { return b.n - a.n || a.e.localeCompare(b.e); });\n  var tot = filas.reduce(function (a, o) { a.n += o.n; a.p += o.p; a.c += o.c; a.i += o.i; a.a += o.a; return a; }, { n: 0, p: 0, c: 0, i: 0, a: 0 });\n  $('tEquipos').innerHTML = filas.length ? '<thead><tr><th>Equipo</th><th>Estaciones</th><th>Polines</th><th>Críticas</th><th>Inmediatas</th><th>Abiertas</th></tr></thead><tbody>' +\n    filas.map(function (o) { return '<tr class=\"clic\" data-e=\"' + esc(o.e) + '\"><td><b>' + esc(o.e) + '</b></td><td>' + o.n + '</td><td>' + o.p + '</td><td' + (o.c ? ' class=\"c\"' : '') + '>' + o.c + '</td><td>' + o.i + '</td><td>' + o.a + '</td></tr>'; }).join('') +\n    '</tbody><tfoot><tr><td>Total</td><td>' + tot.n + '</td><td>' + tot.p + '</td><td>' + tot.c + '</td><td>' + tot.i + '</td><td>' + tot.a + '</td></tr></tfoot>'\n    : '<tr><td class=\"vacio\">Sin estaciones registradas en esta semana.</td></tr>';\n  $('tEquipos').onclick = function (e) { var r = e.target.closest('tr[data-e]'); if (r) irFiltrado({ equipo: r.dataset.e }); };\n\n  var modos = {};\n  h.forEach(function (x) { var o = modos[x.modo_falla] || (modos[x.modo_falla] = { m: x.modo_falla, n: 0, c: 0 }); o.n++; if (crit(x)) o.c++; });\n  var ml = Object.keys(modos).map(function (q) { return modos[q]; }).sort(function (a, b) { return b.n - a.n; });\n  var max = ml.length ? ml[0].n : 1;\n  $('bModos').innerHTML = ml.map(function (o) {\n    return '<div class=\"bar\"><span class=\"l\">' + esc(o.m) + '</span><span class=\"trk\"><span class=\"f c\" style=\"width:' + (o.c / max * 100) + '%\"></span><span class=\"f\" style=\"width:' + ((o.n - o.c) / max * 100) + '%\"></span></span><span class=\"n\">' + o.n + '</span></div>';\n  }).join('') || '<p class=\"vacio\">Sin datos.</p>';\n\n  var tmp = h.filter(function (x) { return x.temperatura && x.temperatura !== 'Normal'; });\n  $('lTemp').innerHTML = tmp.length ? '<table class=\"tbl\"><tbody>' + tmp.map(function (x) {\n    return '<tr class=\"clic\" data-id=\"' + esc(x.id) + '\"><td><b>' + esc(x.equipo) + '</b> · Mesa ' + esc(x.mesa) + ' · Est. ' + esc(x.estacion) + '<br><small style=\"color:var(--ink3)\">' + esc(x.modo_falla) + '</small></td><td class=\"c\">' + esc(x.temperatura) + '</td></tr>';\n  }).join('') + '</tbody></table>' : '<p class=\"ayuda\">Ningún polín con temperatura fuera de lo normal.</p>';\n  $('lTemp').onclick = function (e) { var r = e.target.closest('tr[data-id]'); if (r) editarHz(r.dataset.id); };\n\n  var est = contar(h, function (x) { return x.estado || 'PENDIENTE'; });\n  var orden = lst('estado').length ? lst('estado') : Object.keys(est);\n  $('bEstado').innerHTML = orden.map(function (s) {\n    var n = est[s] || 0;\n    return '<div class=\"bar\"><span class=\"l\">' + esc(s) + '</span><span class=\"trk\"><span class=\"f\" style=\"width:' + (h.length ? n / h.length * 100 : 0) + '%;background:' + (s === 'CERRADO' ? 'var(--ok)' : s === 'PENDIENTE' ? 'var(--amber)' : 'var(--slate2)') + '\"></span></span><span class=\"n\">' + n + '</span></div>';\n  }).join('');\n}\n\n/* ---------------- Lista de hallazgos ---------------- */\nfunction opciones(sel, vals, primero) { $(sel).innerHTML = '<option value=\"\">' + esc(primero) + '</option>' + vals.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join(''); }\nfunction llenarFiltros() {\n  var keep = {}; ['fEquipo', 'fCrit', 'fPrio', 'fEstado', 'fTipo'].forEach(function (k) { keep[k] = $(k).value; });\n  var eqs = Object.keys(contar(S.hz, function (x) { return x.equipo; })).sort();\n  opciones('fEquipo', eqs, 'Todos los equipos');\n  opciones('fCrit', lst('criticidad'), 'Criticidad');\n  opciones('fPrio', lst('prioridad'), 'Prioridad');\n  $('fEstado').innerHTML = '<option value=\"\">Estado</option><option value=\"_abiertos\">Abiertas (no cerradas)</option>' + lst('estado').map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('');\n  opciones('fTipo', lst('tipo'), 'Carga y retorno');\n  opciones('mEstado', lst('estado'), 'Estado…');\n  opciones('mPrio', lst('prioridad'), 'Prioridad…');\n  Object.keys(keep).forEach(function (k) { $(k).value = keep[k]; });\n}\nfunction irFiltrado(f) {\n  $('fQ').value = ''; $('fEquipo').value = f.equipo || ''; $('fCrit').value = f.crit || ''; $('fPrio').value = f.prio || ''; $('fEstado').value = f.estado || ''; $('fTipo').value = '';\n  S.limite = 150; pintarLista(); ver('hallazgos');\n}\nfunction filtrados() {\n  var q = norm($('fQ').value).trim().split(/\\s+/).filter(Boolean);\n  var e = $('fEquipo').value, c = $('fCrit').value, p = $('fPrio').value, s = $('fEstado').value, t = $('fTipo').value;\n  return S.hz.filter(function (h) {\n    if (e && h.equipo !== e) return false;\n    if (c && h.criticidad !== c) return false;\n    if (p && h.prioridad !== p) return false;\n    if (t && h.tipo !== t) return false;\n    if (s === '_abiertos' ? !abierto(h) : (s && h.estado !== s)) return false;\n    if (q.length) { var txt = h._b || (h._b = norm([h.id, h.equipo, 'mesa ' + h.mesa, 'est ' + h.estacion, h.tipo, h.tipo_polin, h.modo_falla, h.comentario, h.n_aviso, h.n_ot, h.nota, h.estado].join(' '))); if (!q.every(function (w) { return txt.indexOf(w) >= 0; })) return false; }\n    return true;\n  });\n}\nfunction posHtml(h) {\n  var ps = POS[h.tipo_polin] || ['izq', 'cent1', 'cent2', 'der'].filter(function (k) { return h[k] !== null && h[k] !== undefined; });\n  return '<span class=\"pos\" title=\"Posiciones con falla\">' + ps.map(function (k) { return '<i class=\"' + (Number(h[k]) ? 'f' : '') + '\"></i>'; }).join('') + '</span>';\n}\nfunction pintarLista() {\n  var f = filtrados(), sel = S.sel;\n  $('hCnt').textContent = f.length === S.hz.length ? S.hz.length + ' estaciones' : f.length + ' de ' + S.hz.length + ' estaciones';\n  $('lista').innerHTML = f.slice(0, S.limite).map(function (h) {\n    var est = h.estado || 'PENDIENTE';\n    return '<button class=\"hz ' + esc(h.criticidad) + '\" data-id=\"' + esc(h.id) + '\">' + (sel ? '<input type=\"checkbox\" tabindex=\"-1\"' + (sel[h.id] ? ' checked' : '') + '>' : '') +\n      '<span class=\"m\"><b>' + esc(h.equipo) + ' · Mesa ' + esc(h.mesa) + ' · Est. ' + esc(h.estacion) + '</b>' +\n      '<small>' + esc(h.modo_falla) + posHtml(h) + ' · ' + esc(h.tipo || '') + ' ' + esc(h.tipo_polin || '') + (h.n_aviso ? ' · Aviso ' + esc(h.n_aviso) : '') + (h.n_ot ? ' · OT ' + esc(h.n_ot) : '') + (h.comentario ? ' · ' + esc(h.comentario) : '') + '</small></span>' +\n      '<span class=\"d\"><span class=\"badge ' + esc(est.split(' ')[0]) + '\">' + esc(est) + '</span>' + (inm(h) ? '<span class=\"badge inm\">Inmediato</span>' : '') + (crit(h) ? '<span class=\"badge Critico\">Crítico</span>' : '') + (h.flash_id ? '<span class=\"badge fl\">⚡ Flash</span>' : '') + '</span></button>';\n  }).join('') || '<p class=\"vacio\">No hay estaciones con estos filtros.</p>';\n  $('btnMas').hidden = f.length <= S.limite;\n  if (sel) $('mCnt').textContent = Object.keys(sel).length + ' seleccionadas';\n}\n\n/* ---------------- Formulario de estación (registrar / editar) ---------------- */\nfunction segHtml(campo, vals, val, extra) {\n  return '<div class=\"seg ' + (extra || '') + '\" data-campo=\"' + campo + '\">' + vals.map(function (v) { return '<button type=\"button\" data-v=\"' + esc(v) + '\" aria-pressed=\"' + (v === val) + '\">' + esc(v === 'Critico' ? 'Crítico' : v) + '</button>'; }).join('') + '</div>';\n}\nfunction selHtml(id, vals, val, vacio) { return '<select id=\"' + id + '\">' + (vacio ? '<option value=\"\">' + esc(vacio) + '</option>' : '') + vals.map(function (v) { return '<option' + (v === val ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('') + '</select>'; }\nfunction estacionHtml(tipoPolin, tipo, h, px, esMt) {\n  var ps = POS[tipoPolin] || POS.DOBLE, si = esMt ? 'cambiado' : 'con falla', no = esMt ? '—' : 'bien';\n  return '<div class=\"est ' + (tipo === 'RETORNO' ? 'retorno' : '') + '\" id=\"' + px + 'est\">' + ps.map(function (k) {\n    var lat = (k === 'izq' || k === 'der') && ps.length > 2;\n    return '<button type=\"button\" class=\"' + (lat ? 'lat' : '') + '\" data-p=\"' + k + '\" aria-pressed=\"' + (Number(h[k]) === 1) + '\">' + POS_TXT[k] + '<small>' + (Number(h[k]) === 1 ? si : no) + '</small></button>';\n  }).join('') + '</div><p class=\"est-n\">' + (esMt ? 'Toca los polines que se cambiaron.' : 'Toca los polines con falla.') + '</p>';\n}\n\n/** Arma el formulario. px = prefijo de ids ('r' registrar, 'e' editar, 'm' mantención). modo: 'hz' | 'mt' */\nfunction formHtml(px, h, modo) {\n  var esHz = modo === 'hz', eqs = lst('equipo');\n  var tipoPolin = h.tipo_polin || 'DOBLE', tipo = h.tipo || 'CARGA';\n  var temp = h.temperatura || 'Normal', tempOtra = temp !== 'Normal' ? String(temp).replace(/[^\\d.,]/g, '') : '';\n  var g = '<div class=\"grid g4\">';\n  if (!esHz) g += '<div class=\"fld\"><label for=\"' + px + 'fecha\">Fecha</label><input id=\"' + px + 'fecha\" type=\"date\" value=\"' + esc(h.fecha || hoy()) + '\"></div>';\n  g += '<div class=\"fld' + (esHz ? ' full' : '') + '\"><label for=\"' + px + 'equipo\">Equipo</label>' + selHtml(px + 'equipo', eqs, h.equipo, 'Elige el equipo') + '</div>';\n  g += '<div class=\"fld\"><label for=\"' + px + 'mesa\">Mesa</label><input id=\"' + px + 'mesa\" value=\"' + esc(h.mesa && h.mesa !== 'N/A' ? h.mesa : '') + '\" placeholder=\"N/A\" autocomplete=\"off\"></div>';\n  g += '<div class=\"fld\"><label for=\"' + px + 'estacion\">Estación</label><div class=\"num\"><button type=\"button\" data-d=\"-1\" aria-label=\"Estación anterior\">−</button><input id=\"' + px + 'estacion\" type=\"number\" inputmode=\"numeric\" min=\"0\" value=\"' + esc(h.estacion == null ? '' : h.estacion) + '\"><button type=\"button\" data-d=\"1\" aria-label=\"Estación siguiente\">+</button></div></div>';\n  if (!esHz) g += '<div class=\"fld full\"><span class=\"lbl\">Tipo de cambio</span>' + segHtml('tipo_cambio', lst('tipo_cambio'), h.tipo_cambio || lst('tipo_cambio')[0]) + '</div>';\n  g += '<div class=\"fld full\"><span class=\"lbl\">Lado de la correa</span>' + segHtml('tipo', lst('tipo').length ? lst('tipo') : ['CARGA', 'RETORNO'], tipo) + '</div>';\n  g += '<div class=\"fld full\"><span class=\"lbl\">Tipo de polín</span>' + segHtml('tipo_polin', lst('tipo_polin').length ? lst('tipo_polin') : ['MONO', 'DOBLE', 'TRIPLE', 'CUADRUPLE'], tipoPolin) + '</div>';\n  g += '<div class=\"fld full\"><span class=\"lbl\">' + (esHz ? 'Polines con falla' : 'Polines cambiados') + '</span><div id=\"' + px + 'posw\">' + estacionHtml(tipoPolin, tipo, h, px, !esHz) + '</div></div>';\n  if (esHz) {\n    g += '<div class=\"fld full\"><label for=\"' + px + 'modo\">Modo de falla</label>' + selHtml(px + 'modo', lst('modo_falla'), h.modo_falla, 'Elige el modo de falla') + '</div>';\n    g += '<div class=\"fld full\"><span class=\"lbl\">Criticidad <small style=\"color:var(--ink3)\">(desbocado y trabado = crítico)</small></span>' + segHtml('criticidad', lst('criticidad'), h.criticidad || '', 'crit') + '</div>';\n    g += '<div class=\"fld full\"><span class=\"lbl\">Prioridad</span>' + segHtml('prioridad', lst('prioridad'), h.prioridad || 'Planificado') + '</div>';\n    g += '<div class=\"fld\"><label for=\"' + px + 'temp\">Temperatura</label><select id=\"' + px + 'temp\"><option value=\"Normal\"' + (temp === 'Normal' ? ' selected' : '') + '>Normal</option><option value=\"otra\"' + (temp !== 'Normal' ? ' selected' : '') + '>Sobre lo normal</option></select></div>';\n    g += '<div class=\"fld\"' + (temp === 'Normal' ? ' hidden' : '') + ' id=\"' + px + 'tempw\"><label for=\"' + px + 'tempn\">°C medidos</label><input id=\"' + px + 'tempn\" type=\"number\" inputmode=\"decimal\" value=\"' + esc(tempOtra) + '\"></div>';\n    g += '<div class=\"fld full\"><label for=\"' + px + 'com\">Comentario</label><textarea id=\"' + px + 'com\" placeholder=\"Ej: Manto dañado, ruido, rodamiento con juego…\">' + esc(h.comentario || '') + '</textarea></div>';\n    if (h.id) {\n      g += '<div class=\"fld full\"><span class=\"lbl\">Estado</span>' + segHtml('estado', lst('estado'), h.estado || 'PENDIENTE') + '</div>';\n      g += '<div class=\"fld\"><label for=\"' + px + 'aviso\">N° aviso SAP</label><input id=\"' + px + 'aviso\" inputmode=\"numeric\" value=\"' + esc(h.n_aviso || '') + '\"></div>';\n      g += '<div class=\"fld\"><label for=\"' + px + 'ot\">N° OT</label><input id=\"' + px + 'ot\" inputmode=\"numeric\" value=\"' + esc(h.n_ot || '') + '\"></div>';\n      g += '<div class=\"fld full\"><label for=\"' + px + 'nota\">Nota</label><textarea id=\"' + px + 'nota\">' + esc(h.nota || '') + '</textarea></div>';\n    }\n  } else {\n    g += '<div class=\"fld\"><label for=\"' + px + 'empresa\">Empresa</label><input id=\"' + px + 'empresa\" list=\"' + px + 'emps\" value=\"' + esc(h.empresa || lst('empresa')[0] || '') + '\"><datalist id=\"' + px + 'emps\">' + lst('empresa').map(function (v) { return '<option value=\"' + esc(v) + '\">'; }).join('') + '</datalist></div>';\n    g += '<div class=\"fld full\"><label for=\"' + px + 'hz\">Hallazgo que resuelve</label><select id=\"' + px + 'hz\"></select><p class=\"ayuda\" id=\"' + px + 'hzAy\"></p></div>';\n    g += '<div class=\"fld full\"><label for=\"' + px + 'nota\">Nota</label><textarea id=\"' + px + 'nota\">' + esc(h.nota || '') + '</textarea></div>';\n  }\n  return g + '</div>';\n}\n\n/** Conecta los controles del formulario y devuelve la función que lee sus valores */\nfunction formActivar(cont, px, h, modo) {\n  var esHz = modo === 'hz';\n  var st = { tipo: h.tipo || 'CARGA', tipo_polin: h.tipo_polin || 'DOBLE', criticidad: h.criticidad || '', prioridad: h.prioridad || 'Planificado', estado: h.estado || 'PENDIENTE', tipo_cambio: h.tipo_cambio || lst('tipo_cambio')[0] || '' };\n  var pos = { izq: h.izq, cent1: h.cent1, cent2: h.cent2, der: h.der };\n  var critManual = !!h.criticidad && !!h.id;\n  function q(id) { return cont.querySelector('#' + px + id); }\n  function pintarEst() {\n    q('posw').innerHTML = estacionHtml(st.tipo_polin, st.tipo, pos, px, !esHz);\n  }\n  function autoCrit() {\n    if (!esHz || critManual) return;\n    var m = q('modo').value; if (!m) return;\n    st.criticidad = CRITICOS.indexOf(m) >= 0 ? 'Critico' : 'Riesgoso';\n    if (st.criticidad === 'Critico') st.prioridad = 'Inmediato';\n    ['criticidad', 'prioridad'].forEach(function (c) { var s = cont.querySelector('.seg[data-campo=\"' + c + '\"]'); if (s) s.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === st[c]); }); });\n  }\n  cont.onclick = function (e) {\n    var b = e.target.closest('button'); if (!b || !cont.contains(b)) return;\n    var seg = b.closest('.seg');\n    if (seg) {\n      var c = seg.dataset.campo; st[c] = b.dataset.v;\n      seg.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });\n      if (c === 'criticidad') critManual = true;\n      if (c === 'tipo_polin' || c === 'tipo') pintarEst();\n      return;\n    }\n    if (b.dataset.p) {\n      var k = b.dataset.p; pos[k] = Number(pos[k]) === 1 ? 0 : 1;\n      b.setAttribute('aria-pressed', pos[k] === 1);\n      b.querySelector('small').textContent = pos[k] === 1 ? (esHz ? 'con falla' : 'cambiado') : (esHz ? 'bien' : '—');\n      return;\n    }\n    if (b.dataset.d) { var i = q('estacion'); i.value = Math.max(0, (Number(i.value) || 0) + Number(b.dataset.d)); i.dispatchEvent(new Event('change')); }\n  };\n  if (esHz) {\n    q('modo').onchange = autoCrit;\n    q('temp').onchange = function () { q('tempw').hidden = this.value === 'Normal'; if (this.value !== 'Normal') q('tempn').focus(); };\n  }\n  return {\n    st: st, pos: pos, q: q,\n    leer: function () {\n      var ps = POS[st.tipo_polin] || POS.DOBLE, o = {};\n      ['izq', 'cent1', 'cent2', 'der'].forEach(function (k) { o[k] = ps.indexOf(k) >= 0 ? (Number(pos[k]) === 1 ? 1 : 0) : null; });\n      o.equipo = q('equipo').value; o.mesa = q('mesa').value.trim() || 'N/A'; o.estacion = q('estacion').value;\n      o.tipo = st.tipo; o.tipo_polin = st.tipo_polin;\n      if (esHz) {\n        o.modo_falla = q('modo').value; o.criticidad = st.criticidad || (CRITICOS.indexOf(o.modo_falla) >= 0 ? 'Critico' : 'Riesgoso');\n        o.prioridad = st.prioridad; o.comentario = q('com').value.trim();\n        o.temperatura = q('temp').value === 'Normal' ? 'Normal' : (q('tempn').value ? String(q('tempn').value).replace(',', '.') + '°C' : 'Sobre lo normal');\n        if (h.id) { o.id = h.id; o.estado = st.estado; o.n_aviso = q('aviso').value.trim(); o.n_ot = q('ot').value.trim(); o.nota = q('nota').value.trim(); }\n      } else {\n        o.fecha = q('fecha').value; o.tipo_cambio = st.tipo_cambio; o.empresa = q('empresa').value.trim(); o.hallazgo_id = q('hz').value; o.nota = q('nota').value.trim();\n        if (h.id) o.id = h.id;\n      }\n      return o;\n    },\n    validar: function (o) {\n      if (!o.equipo) return 'Elige el equipo.';\n      if (esHz && !o.modo_falla) return 'Elige el modo de falla.';\n      if (o.estacion === '' && !confirmaSinEst) return 'Falta el número de estación.';\n      if (esHz && nPol(o) === 0) return 'Marca al menos un polín con falla' + (o.modo_falla === 'Estacion Faltante' ? ' (en estación faltante, marca todos).' : '.');\n      return '';\n    }\n  };\n}\nvar confirmaSinEst = false;\n\n/* Registrar */\nvar FR = null;\nfunction formRegNuevo(base) {\n  var h = base || {};\n  $('formReg').innerHTML = formHtml('r', h, 'hz');\n  FR = formActivar($('formReg'), 'r', h, 'hz');\n}\nfunction guardarReg(siguiente) {\n  if (!S.actual) { toast('Primero crea la semana de inspección.', true); return; }\n  var o = FR.leer(), v = FR.validar(o);\n  if (v) { toast(v, true); return; }\n  o.inspeccion_id = S.actual;\n  var bs = [$('regGuardar'), $('regSig')]; bs.forEach(function (b) { b.disabled = true; });\n  run('polGuardarHallazgo', o).then(function (f) {\n    bs.forEach(function (b) { b.disabled = false; });\n    S.hz.push(f); S.recientes.unshift(f);\n    $('regRec').innerHTML = S.recientes.slice(0, 8).map(function (x) { return '<li><b>' + esc(x.id) + '</b> · ' + esc(x.equipo) + ' · Mesa ' + esc(x.mesa) + ' · Est. ' + esc(x.estacion) + ' · ' + esc(x.modo_falla) + ' · ' + nPol(x) + ' polín(es)' + (x.flash_pdf ? ' · <a href=\"' + esc(x.flash_pdf) + '\" target=\"_blank\" rel=\"noopener\">Reporte Flash ' + esc(x.flash_id) + '</a>' : (x.flash_id ? ' · Reporte Flash ' + esc(x.flash_id) : '')) + '</li>'; }).join('');\n    toast('Guardado ' + f.id + msgFlash(f), !!f._flash_error);\n    pintarResumen(); llenarFiltros(); pintarLista(); $('sub').textContent = titInsp(inspActual()) + ' · ' + S.hz.length + ' estaciones con falla';\n    if (siguiente) {\n      formRegNuevo({ equipo: f.equipo, mesa: f.mesa, tipo: f.tipo, tipo_polin: f.tipo_polin, prioridad: 'Planificado', estacion: (Number(f.estacion) || 0) + 1 });\n      try { $('rmodo').focus(); } catch (e) { }\n    } else formRegNuevo();\n    window.scrollTo(0, 0);\n  }).catch(function (e) { bs.forEach(function (b) { b.disabled = false; }); toast('No se guardó: ' + errTxt(e), true); });\n}\n\n/* Editar (modal) */\nfunction modal(tit, html) { $('mTit').textContent = tit; $('mBd').innerHTML = html; $('fondo').classList.add('on'); $('modal').classList.add('on'); $('mBd').scrollTop = 0; }\nfunction cerrarModal() { $('fondo').classList.remove('on'); $('modal').classList.remove('on'); $('mBd').innerHTML = ''; }\nfunction editarHz(id) {\n  var h = S.hz.filter(function (x) { return x.id === id; })[0]; if (!h) return;\n  modal(h.id + ' · ' + h.equipo, '<div id=\"formEd\"></div><p class=\"ayuda\">Actualizado por ' + esc(h.actualizado_por || '—') + (h.updated_at ? ' · ' + esc(fmtF(String(h.updated_at).slice(0, 10))) : '') + '</p>' +\n    (h.flash_id ? '<p class=\"flash\">⚡ Reporte Flash <b>' + esc(h.flash_id) + '</b>' + (h.flash_pdf ? ' · <a href=\"' + esc(h.flash_pdf) + '\" target=\"_blank\" rel=\"noopener\">Abrir PDF</a>' : '') + '</p>' : '') +\n    '<div class=\"acciones\"><button class=\"btn peligro\" id=\"edBorrar\">Eliminar</button>' + (h.flash_id || !flashOk(h) ? '' : '<button class=\"btn\" id=\"edFlash\">⚡ Generar reporte flash</button>') + '<button class=\"btn\" id=\"edMant\">Registrar mantención</button><button class=\"btn pri\" id=\"edGuardar\">Guardar cambios</button></div>');\n  $('formEd').innerHTML = formHtml('e', h, 'hz');\n  var F = formActivar($('formEd'), 'e', h, 'hz');\n  $('edGuardar').onclick = function () {\n    var o = F.leer(), v = F.validar(o); if (v) { toast(v, true); return; }\n    this.disabled = true; var b = this;\n    run('polGuardarHallazgo', o).then(function (f) { reemplazarHz(f); cerrarModal(); toast('Guardado ' + f.id + msgFlash(f), !!f._flash_error); })\n      .catch(function (e) { b.disabled = false; toast('No se guardó: ' + errTxt(e), true); });\n  };\n  $('edBorrar').onclick = function () {\n    var b = this;\n    if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = 'Confirmar: eliminar ' + h.id; return; }\n    b.disabled = true;\n    run('polBorrarHallazgo', h.id).then(function () { S.hz = S.hz.filter(function (x) { return x.id !== h.id; }); cerrarModal(); pintarResumen(); pintarLista(); toast('Eliminado ' + h.id); })\n      .catch(function (e) { b.disabled = false; toast(errTxt(e), true); });\n  };\n  $('edMant').onclick = function () { cerrarModal(); mantDesde(h); };\n  if ($('edFlash')) $('edFlash').onclick = function () {\n    var b = this; b.disabled = true; b.textContent = 'Generando…';\n    run('polGenerarFlash', h.id).then(function (f) { reemplazarHz(f); cerrarModal(); toast('Reporte Flash ' + f.flash_id + ' generado'); if (f.flash_pdf) window.open(f.flash_pdf, '_blank'); })\n      .catch(function (e) { b.disabled = false; b.textContent = '⚡ Generar reporte flash'; toast(errTxt(e), true); });\n  };\n}\nfunction reemplazarHz(f) {\n  var i = S.hz.map(function (x) { return x.id; }).indexOf(f.id);\n  if (i >= 0) S.hz[i] = f; else if (f.inspeccion_id === S.actual) S.hz.push(f);\n  pintarResumen(); pintarLista();\n}\n\n/* Selección múltiple */\nfunction alternarSel(on) {\n  S.sel = on ? {} : null; $('masivo').hidden = !on; $('btnSel').textContent = on ? 'Terminar selección' : 'Selección múltiple'; pintarLista();\n}\nfunction aplicarMasivo() {\n  var ids = Object.keys(S.sel || {});\n  if (!ids.length) { toast('Selecciona al menos una estación.', true); return; }\n  var c = { estado: $('mEstado').value, prioridad: $('mPrio').value, n_aviso: $('mAviso').value.trim(), n_ot: $('mOt').value.trim() };\n  if (!c.estado && !c.prioridad && !c.n_aviso && !c.n_ot) { toast('Elige qué cambiar.', true); return; }\n  $('mAplicar').disabled = true;\n  run('polCambiarVarios', ids, c).then(function (filas) {\n    $('mAplicar').disabled = false; filas.forEach(function (f) { var i = S.hz.map(function (x) { return x.id; }).indexOf(f.id); if (i >= 0) S.hz[i] = f; });\n    ['mEstado', 'mPrio', 'mAviso', 'mOt'].forEach(function (k) { $(k).value = ''; });\n    var nf = filas.filter(function (f) { return f._flash_nuevo; }).length;\n    toast(filas.length + ' estaciones actualizadas' + (nf ? ' · ' + nf + ' reportes flash generados' : '')); alternarSel(false); pintarResumen();\n  }).catch(function (e) { $('mAplicar').disabled = false; toast('No se aplicó: ' + errTxt(e), true); });\n}\n\n/* Nueva semana */\nfunction nuevaSemana() {\n  var f = hoy(), s = semIso(f);\n  modal('Nueva semana de inspección',\n    '<div class=\"grid\"><div class=\"fld\"><label for=\"nsFecha\">Fecha de inspección</label><input id=\"nsFecha\" type=\"date\" value=\"' + f + '\"></div>' +\n    '<div class=\"fld\"><label for=\"nsSem\">Semana</label><input id=\"nsSem\" type=\"number\" min=\"1\" max=\"53\" value=\"' + s.semana + '\"></div>' +\n    '<div class=\"fld full\"><label for=\"nsDesc\">Descripción</label><input id=\"nsDesc\" value=\"Inspección de polines SEM ' + s.semana + '-' + s.anio + '\"></div>' +\n    '<label class=\"full\" style=\"display:flex;gap:10px;align-items:flex-start;font-size:14px\"><input type=\"checkbox\" id=\"nsCopiar\" style=\"width:22px;height:22px;min-height:0;flex:none\">' +\n    '<span>Copiar las estaciones no cerradas de la semana anterior para revisarlas en terreno<br><small style=\"color:var(--ink3)\">Úsalo si la inspección de esta semana parte de lo pendiente. Las copias guardan una nota con su id de origen.</small></span></label></div>' +\n    '<div class=\"acciones\"><button class=\"btn\" id=\"nsCancel\">Cancelar</button><button class=\"btn pri\" id=\"nsCrear\">Crear semana</button></div>');\n  $('nsFecha').onchange = function () { var x = semIso(this.value); $('nsSem').value = x.semana; $('nsDesc').value = 'Inspección de polines SEM ' + x.semana + '-' + x.anio; };\n  $('nsCancel').onclick = cerrarModal;\n  $('nsCrear').onclick = function () {\n    var b = this; b.disabled = true;\n    var fe = $('nsFecha').value;\n    run('polNuevaInspeccion', { fecha: fe, anio: semIso(fe).anio, semana: $('nsSem').value, descripcion: $('nsDesc').value, copiar: $('nsCopiar').checked }).then(function (r) {\n      S.insps.unshift(r.inspeccion); S.actual = r.inspeccion.id; S.hz = r.hallazgos || []; cerrarModal(); pintarTodo(); formRegNuevo();\n      toast('Semana creada: ' + r.inspeccion.semana + (S.hz.length ? ' · ' + S.hz.length + ' estaciones copiadas' : ''));\n      ver(S.hz.length ? 'hallazgos' : 'registrar');\n    }).catch(function (e) { b.disabled = false; toast('No se creó: ' + errTxt(e), true); });\n  };\n}\n\n/* Mantención */\nvar FM = null;\nfunction formMtNuevo(base) {\n  var h = base || {};\n  $('formMt').innerHTML = formHtml('m', h, 'mt');\n  FM = formActivar($('formMt'), 'm', h, 'mt');\n  var act = function () { opcionesHzMt(h.hallazgo_id); };\n  ['equipo', 'mesa', 'estacion'].forEach(function (k) { FM.q(k).addEventListener('change', act); FM.q(k).addEventListener('input', act); });\n  FM.q('hz').onchange = function () {\n    var x = S.hz.filter(function (y) { return y.id === FM.q('hz').value; })[0]; if (!x) return;\n    FM.q('equipo').value = x.equipo; FM.q('mesa').value = x.mesa === 'N/A' ? '' : x.mesa; FM.q('estacion').value = x.estacion;\n    FM.st.tipo = x.tipo; FM.st.tipo_polin = x.tipo_polin; ['izq', 'cent1', 'cent2', 'der'].forEach(function (k) { FM.pos[k] = x[k]; });\n    $('formMt').querySelectorAll('.seg').forEach(function (s) { var c = s.dataset.campo; if (c === 'tipo' || c === 'tipo_polin') s.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.v === FM.st[c]); }); });\n    $('formMt').querySelector('.seg[data-campo=\"tipo_polin\"] button[aria-pressed=\"true\"]').click();\n  };\n  act();\n}\nfunction opcionesHzMt(elegido) {\n  var eq = FM.q('equipo').value, me = FM.q('mesa').value.trim() || 'N/A', es = FM.q('estacion').value;\n  var abiertos = S.hz.filter(abierto).filter(function (x) { return !eq || x.equipo === eq; });\n  var exactos = abiertos.filter(function (x) { return String(x.mesa) === me && String(x.estacion) === String(es); });\n  var lista = exactos.length ? exactos.concat(abiertos.filter(function (x) { return exactos.indexOf(x) < 0; })) : abiertos;\n  var sel = elegido || (exactos[0] && exactos[0].id) || '';\n  FM.q('hz').innerHTML = '<option value=\"\">Ninguno (mantención sin hallazgo de esta semana)</option>' + lista.slice(0, 400).map(function (x) {\n    return '<option value=\"' + esc(x.id) + '\"' + (x.id === sel ? ' selected' : '') + '>' + esc(x.id + ' · ' + x.equipo + ' · Mesa ' + x.mesa + ' · Est. ' + x.estacion + ' · ' + x.modo_falla) + '</option>';\n  }).join('');\n  FM.q('hzAy').textContent = !eq ? 'Elige el equipo para ver sus estaciones abiertas.' : exactos.length ? 'Coincide con la estación registrada en la inspección.' : abiertos.length + ' estaciones abiertas en ' + eq + ' esta semana.';\n}\nfunction mantDesde(h) {\n  formMtNuevo({ equipo: h.equipo, mesa: h.mesa, estacion: h.estacion, tipo: h.tipo, tipo_polin: h.tipo_polin, izq: h.izq, cent1: h.cent1, cent2: h.cent2, der: h.der, hallazgo_id: h.id,\n    tipo_cambio: h.modo_falla === 'Estacion Faltante' ? 'Cambio Estación' : 'Cambio Polin' });\n  ver('mantencion');\n}\nfunction guardarMt() {\n  var o = FM.leer(), v = FM.validar(o);\n  if (v) { toast(v, true); return; }\n  if (nPol(o) === 0 && o.tipo_cambio !== 'Cambio Estación') { toast('Marca los polines que se cambiaron.', true); return; }\n  $('mtGuardar').disabled = true;\n  run('polGuardarMantencion', o).then(function (r) {\n    $('mtGuardar').disabled = false; S.mt.unshift(r.mantencion);\n    if (r.hallazgo) reemplazarHz(r.hallazgo);\n    toast('Mantención ' + r.mantencion.id + ' guardada' + (r.hallazgo ? ' · ' + r.hallazgo.id + ' CERRADO' : ''));\n    formMtNuevo(); pintarMt();\n  }).catch(function (e) { $('mtGuardar').disabled = false; toast('No se guardó: ' + errTxt(e), true); });\n}\nfunction pintarMt() {\n  $('tMt').innerHTML = S.mt.length ? '<thead><tr><th>Fecha</th><th>Equipo</th><th>Mesa / est.</th><th>Cambio</th><th>Polines</th><th>Hallazgo</th><th></th></tr></thead><tbody>' + S.mt.slice(0, 200).map(function (m) {\n    return '<tr><td>' + esc(fmtF(m.fecha)) + '</td><td><b>' + esc(m.equipo) + '</b></td><td>' + esc(m.mesa || '') + ' / ' + esc(m.estacion == null ? '' : m.estacion) + '</td><td>' + esc(m.tipo_cambio || '') + '</td><td>' + esc(m.polines_cambiados == null ? '' : m.polines_cambiados) + '</td><td class=\"mono\">' + esc(m.hallazgo_id || '') + '</td>' +\n      '<td><button class=\"btn peligro\" style=\"min-height:34px;padding:4px 10px\" data-b=\"' + esc(m.id) + '\">Borrar</button></td></tr>';\n  }).join('') + '</tbody>' : '<tr><td class=\"vacio\">Aún no hay mantenciones registradas.</td></tr>';\n  $('tMt').onclick = function (e) {\n    var b = e.target.closest('button[data-b]'); if (!b) return;\n    if (b.dataset.ok !== '1') { b.dataset.ok = '1'; b.textContent = '¿Seguro?'; return; }\n    b.disabled = true;\n    run('polBorrarMantencion', b.dataset.b).then(function () { S.mt = S.mt.filter(function (m) { return m.id !== b.dataset.b; }); pintarMt(); toast('Mantención borrada. El hallazgo mantiene su estado.'); })\n      .catch(function (er) { b.disabled = false; toast(errTxt(er), true); });\n  };\n}\n\n/* ---------------- Navegación ---------------- */\nfunction ver(v) {\n  document.querySelectorAll('.view').forEach(function (s) { s.classList.toggle('on', s.id === 'v-' + v); });\n  document.querySelectorAll('.bnav button').forEach(function (b) { b.setAttribute('aria-current', b.dataset.v === v); });\n  window.scrollTo(0, 0);\n}\n\nfunction iniciar() {\n  if (!BOOT || BOOT.error) {\n    $('loader').innerHTML = '<div style=\"padding:24px;max-width:560px\"><b>No se pudieron cargar los datos.</b><p>' + esc(BOOT && BOOT.error || 'Sin respuesta del servidor') + '</p><button class=\"btn pri\" onclick=\"location.reload()\">Reintentar</button></div>';\n    return;\n  }\n  aplicarDatos(BOOT);\n  pintarTodo(); formRegNuevo(); formMtNuevo();\n  document.querySelector('.bnav').onclick = function (e) { var b = e.target.closest('button[data-v]'); if (b) ver(b.dataset.v); };\n  $('selInsp').onchange = function () { cambiarInsp(this.value); };\n  $('btnNuevaSem').onclick = nuevaSemana;\n  $('btnRecargar').onclick = function () { run('polRecargar', S.actual).then(function (d) { aplicarDatos(d); pintarTodo(); toast('Datos actualizados'); }).catch(function (e) { toast(errTxt(e), true); }); };\n  ['fQ', 'fEquipo', 'fCrit', 'fPrio', 'fEstado', 'fTipo'].forEach(function (k) { $(k).addEventListener(k === 'fQ' ? 'input' : 'change', function () { S.limite = 150; pintarLista(); }); });\n  $('fLimpiar').onclick = function () { irFiltrado({}); };\n  $('btnMas').onclick = function () { S.limite += 300; pintarLista(); };\n  $('lista').onclick = function (e) {\n    var b = e.target.closest('.hz'); if (!b) return;\n    if (S.sel) { var id = b.dataset.id; if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1; b.querySelector('input').checked = !!S.sel[id]; $('mCnt').textContent = Object.keys(S.sel).length + ' seleccionadas'; return; }\n    editarHz(b.dataset.id);\n  };\n  $('btnSel').onclick = function () { alternarSel(!S.sel); };\n  $('mTodas').onclick = function () { filtrados().forEach(function (h) { S.sel[h.id] = 1; }); pintarLista(); };\n  $('mAplicar').onclick = aplicarMasivo;\n  $('regGuardar').onclick = function () { guardarReg(false); };\n  $('regSig').onclick = function () { guardarReg(true); };\n  $('regLimpiar').onclick = function () { formRegNuevo(); };\n  $('mtGuardar').onclick = guardarMt;\n  $('mtLimpiar').onclick = function () { formMtNuevo(); };\n  $('mX').onclick = cerrarModal; $('fondo').onclick = cerrarModal;\n  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('modal').classList.contains('on')) cerrarModal(); });\n  $('loader').remove();\n}\niniciar();\n</script>\n\n\n<!-- MSMIN: botón para volver al menú de Aplicaciones (igual en todas las apps) -->\n<style>\n.msmin-volver{display:inline-flex;align-items:center;gap:6px;flex:none;height:38px;padding:0 14px 0 9px;margin-right:4px;border-radius:999px;border:1px solid rgba(232,163,23,.6);background:rgba(232,163,23,.15);color:#F3C35B;font:600 13.5px/1 \"IBM Plex Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent}\n.msmin-volver:hover{background:rgba(232,163,23,.26)}\n.msmin-volver:focus-visible{outline:2px solid #E8A317;outline-offset:2px}\n.msmin-volver svg{width:18px;height:18px;flex:none}\n.msmin-volver.flota{position:fixed;top:calc(env(safe-area-inset-top) + 10px);left:10px;z-index:9999;background:#12253B;box-shadow:0 4px 14px rgba(0,0,0,.35)}\n@media (max-width:560px){.msmin-volver{padding:0 10px 0 7px}.msmin-volver .tx{display:none}}\n</style>\n<script>\n(function () {\n  var MENU = 'https://gr1775san.github.io/APP-MSMIN/';\n  function irMenu() {\n    var a = document.createElement('a'); a.href = MENU; a.target = '_top'; a.rel = 'noopener';\n    document.body.appendChild(a); a.click();\n  }\n  function volver() {\n    // Vuelve a la página anterior (el menú desde donde se abrió la app); si la app se abrió directo, va al menú.\n    var sigue = true;\n    window.addEventListener('pagehide', function () { sigue = false; });\n    try { history.back(); } catch (e) { irMenu(); return; }\n    setTimeout(function () { if (sigue) irMenu(); }, 800);\n  }\n  function poner() {\n    if (document.querySelector('.msmin-volver')) return;\n    var b = document.createElement('button');\n    b.type = 'button'; b.className = 'msmin-volver'; b.title = 'Volver al menú de aplicaciones'; b.setAttribute('aria-label', 'Volver al menú de aplicaciones');\n    b.innerHTML = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 6l-6 6 6 6\"/></svg><span class=\"tx\">Aplicaciones</span>';\n    b.addEventListener('click', volver);\n    var h = document.querySelector('header.top, header.brand');\n    var c = h ? (h.querySelector('.top-in') || h) : null;\n    if (c) c.insertBefore(b, c.firstChild); else { b.classList.add('flota'); document.body.appendChild(b); }\n  }\n  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poner); else poner();\n})();\n</script>\n\n\n<!-- MSMIN: Informes PDF de inspección (igual en todas las apps). La app llama msminInformes({...}) con su adaptador. -->\n<style>\n.msmin-inf{display:inline-flex;align-items:center;gap:6px;flex:none;height:38px;padding:0 13px 0 10px;margin-right:4px;border-radius:999px;border:1px solid rgba(111,176,230,.55);background:rgba(111,176,230,.14);color:#BFDDF6;font:600 13.5px/1 \"IBM Plex Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;cursor:pointer;white-space:nowrap;-webkit-tap-highlight-color:transparent}\n.msmin-inf:hover{background:rgba(111,176,230,.26)}\n.msmin-inf:focus-visible{outline:2px solid #6FB0E6;outline-offset:2px}\n.msmin-inf svg{width:18px;height:18px;flex:none}\n.msmin-inf.flota{position:fixed;top:calc(env(safe-area-inset-top) + 10px);right:10px;z-index:9999;background:#12253B;box-shadow:0 4px 14px rgba(0,0,0,.35)}\n@media (max-width:560px){.msmin-inf{padding:0 10px}.msmin-inf .tx{display:none}}\n.mi-fondo{position:fixed;inset:0;z-index:10000;background:rgba(2,8,15,.7);display:none}\n.mi-fondo.on{display:block}\n.mi-panel{position:fixed;z-index:10001;left:50%;top:50%;transform:translate(-50%,-50%);width:min(620px,calc(100vw - 20px));max-height:calc(100vh - 30px);display:none;flex-direction:column;background:#0F2033;color:#E9EFF5;border:1px solid #244260;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.5);font:14.5px/1.45 \"IBM Plex Sans\",system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}\n.mi-panel.on{display:flex}\n.mi-hd{display:flex;align-items:center;gap:10px;padding:14px 14px 10px 18px;border-bottom:1px solid #244260}\n.mi-hd h3{margin:0;flex:1;font:700 17px/1.2 \"IBM Plex Sans Condensed\",\"IBM Plex Sans\",system-ui,sans-serif}\n.mi-x{width:40px;height:40px;border:0;border-radius:10px;background:none;color:#E9EFF5;font-size:20px;cursor:pointer}\n.mi-x:hover{background:#183049}\n.mi-bd{padding:14px 18px 18px;overflow:auto;-webkit-overflow-scrolling:touch}\n.mi-ult{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:14px;border-radius:12px;border:1px solid rgba(232,163,23,.6);background:rgba(232,163,23,.12);color:#E9EFF5;cursor:pointer;font:inherit}\n.mi-ult:hover{background:rgba(232,163,23,.2)}\n.mi-ult svg{width:30px;height:30px;flex:none;color:#E8A317}\n.mi-ult b{display:block;font-size:15.5px}\n.mi-ult small{display:block;color:#B4C3D2;font-size:12.5px;margin-top:2px}\n.mi-bus{position:relative;margin:16px 0 8px}\n.mi-bus input{width:100%;box-sizing:border-box;padding:11px 12px 11px 38px;border:1px solid #244260;border-radius:10px;background:#183049;color:#E9EFF5;font:inherit;font-size:16px}\n.mi-bus input:focus{outline:2px solid #E8A317;border-color:#E8A317}\n.mi-bus svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);width:18px;color:#8399AE}\n.mi-cnt{font-size:12.5px;color:#8399AE;margin:0 0 6px}\n.mi-li{list-style:none;margin:0;padding:0}\n.mi-li li{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #1D3753}\n.mi-li li:last-child{border:0}\n.mi-li .t{flex:1;min-width:0}\n.mi-li .t b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.mi-li .t small{display:block;color:#8399AE;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.mi-btn{flex:none;border:1px solid #2A6CB0;background:#2A6CB0;color:#fff;border-radius:9px;padding:8px 12px;font:600 13px/1 \"IBM Plex Sans\",system-ui,sans-serif;cursor:pointer;min-height:36px;white-space:nowrap;text-decoration:none;display:inline-flex;align-items:center}\n.mi-btn:disabled{opacity:.6;cursor:wait}\n.mi-btn.ok{background:#1E6B2D;border-color:#1E6B2D}\n.mi-est{font-size:13px;color:#B4C3D2;margin-top:10px;min-height:18px}\n.mi-est.err{color:#F08A80}\n.mi-vacio{color:#8399AE;text-align:center;padding:26px 6px}\n</style>\n<div class=\"mi-fondo\" id=\"miFondo\"></div>\n<section class=\"mi-panel\" id=\"miPanel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"miTit\">\n  <div class=\"mi-hd\"><h3 id=\"miTit\">Informes PDF de inspección</h3><button class=\"mi-x\" id=\"miX\" aria-label=\"Cerrar\">✕</button></div>\n  <div class=\"mi-bd\">\n    <button class=\"mi-ult\" id=\"miUlt\" type=\"button\">\n      <svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M12 11v6M9 14l3 3 3-3\"/></svg>\n      <span><b id=\"miUltT\">Descargar la última inspección</b><small id=\"miUltS\"></small></span>\n    </button>\n    <div class=\"mi-est\" id=\"miEst\" role=\"status\"></div>\n    <div class=\"mi-bus\"><svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/></svg>\n      <input id=\"miQ\" type=\"search\" placeholder=\"Buscar por semana, fecha o texto…\" autocomplete=\"off\"></div>\n    <p class=\"mi-cnt\" id=\"miCnt\"></p>\n    <ul class=\"mi-li\" id=\"miLi\"></ul>\n  </div>\n</section>\n<script>\n(function () {\n  var A = null, LISTA = [], LOGO = '', ocupado = false;\n  var $ = function (id) { return document.getElementById(id); };\n  function esc(s) { return String(s == null ? '' : s).replace(/[&<>\"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]; }); }\n  function sinTilde(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }\n  function fechaTxt(f) { var m = String(f || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})/); return m ? m[3] + '-' + m[2] + '-' + m[1] : String(f || ''); }\n  function ahora() { var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }; return p(d.getDate()) + '-' + p(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }\n\n  /* ---------- Piezas para armar el informe (las usa cada app) ---------- */\n  var H = {\n    esc: esc, fecha: fechaTxt, txt: function (s) { return esc(s).replace(/\\r?\\n/g, '<br>'); },\n    /** cols: [[titulo, fn(fila) -> html, ancho?]] */\n    tabla: function (cols, filas, vacio) {\n      if (!filas || !filas.length) return '<p class=\"nada\">' + esc(vacio || 'Sin registros.') + '</p>';\n      return '<table class=\"t\"><thead><tr>' + cols.map(function (c) { return '<th' + (c[2] ? ' style=\"width:' + c[2] + '\"' : '') + '>' + esc(c[0]) + '</th>'; }).join('') + '</tr></thead><tbody>' +\n        filas.map(function (f, i) { return '<tr' + (i % 2 ? ' class=\"b\"' : '') + '>' + cols.map(function (c) { return '<td>' + c[1](f) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';\n    },\n    /** pares: [[etiqueta, valor]] en 2 columnas */\n    ficha: function (pares) {\n      var p = pares.filter(function (x) { return x[1] !== '' && x[1] != null; }), h = '<table class=\"fi\">';\n      for (var i = 0; i < p.length; i += 2) h += '<tr><th>' + esc(p[i][0]) + '</th><td>' + esc(p[i][1]) + '</td>' + (p[i + 1] ? '<th>' + esc(p[i + 1][0]) + '</th><td>' + esc(p[i + 1][1]) + '</td>' : '<th></th><td></td>') + '</tr>';\n      return h + '</table>';\n    },\n    /** kpis: [[valor, etiqueta, 'crit'|'amb'|'ok'|'']] */\n    kpis: function (k) {\n      return '<table class=\"kp\"><tr>' + k.map(function (x) { return '<td><b class=\"' + (x[2] || '') + '\">' + esc(x[0]) + '</b>' + esc(x[1]) + '</td>'; }).join('') + '</tr></table>';\n    },\n    /** Nivel de criticidad/categoría -> clase de color */\n    nivel: function (v) {\n      var t = sinTilde(v);\n      if (/no ejecutad|crit|alarma|urgente/.test(t) || (/\\balt[oa]\\b/.test(t) && !/medi/.test(t))) return 'crit';\n      if (/medi|pendiente|seguimiento/.test(t)) return 'amb';\n      if (/baj|normal|cerrad|ejecutad|ok/.test(t)) return 'ok';\n      return '';\n    },\n    sello: function (v) { return v ? '<span class=\"s ' + H.nivel(v) + '\">' + esc(v) + '</span>' : ''; },\n    /** Fotos de Drive: el servidor las reemplaza por la imagen (solo apps con fotos) */\n    fotos: function (grupos) {\n      var g = grupos.filter(function (x) { return x.ids && x.ids.length; });\n      if (!g.length) return '';\n      var celdas = [];\n      g.forEach(function (x) { x.ids.slice(0, 4).forEach(function (id, i) { celdas.push('<td><img src=\"drive:' + esc(id) + '\" style=\"width:235pt\"><div class=\"pf\">' + esc(x.titulo) + (x.ids.length > 1 ? ' · foto ' + (i + 1) : '') + '</div></td>'); }); });\n      var h = '<table class=\"fo\">';\n      for (var i = 0; i < celdas.length; i += 2) h += '<tr>' + celdas[i] + (celdas[i + 1] || '<td></td>') + '</tr>';\n      return h + '</table>';\n    },\n    /** SVG (texto) -> PNG (data URL) para incluir gráficos y planos en el PDF */\n    svgPng: function (svg, ancho, alto) {\n      return new Promise(function (ok) {\n        try {\n          var img = new Image();\n          img.onload = function () {\n            var c = document.createElement('canvas'); c.width = ancho; c.height = alto;\n            var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, ancho, alto); x.drawImage(img, 0, 0, ancho, alto);\n            try { ok(c.toDataURL('image/png')); } catch (e) { ok(''); }\n          };\n          img.onerror = function () { ok(''); };\n          var s = String(svg);\n          if (!/xmlns=/.test(s)) s = s.replace('<svg', '<svg xmlns=\"http://www.w3.org/2000/svg\"');\n          s = s.replace(/<svg([^>]*?)>/, function (m, a) { return '<svg' + a.replace(/\\s(width|height)=\"[^\"]*\"/g, '') + ' width=\"' + ancho + '\" height=\"' + alto + '\">'; });\n          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);\n        } catch (e) { ok(''); }\n      });\n    }\n  };\n\n  var CSS_PDF =\n    '*{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{size:A4;margin:14mm 12mm}body{font-family:Arial,Helvetica,sans-serif;font-size:9.5pt;color:#17232B;margin:0}' +\n    '.cab{width:100%;border-collapse:collapse;border-bottom:2.5pt solid #E8A317;margin-bottom:8pt}.cab td{vertical-align:middle;padding:0 0 6pt}' +\n    'h1{font-size:15pt;margin:0;color:#1F3A4D}.sub{font-size:9.5pt;color:#4A5A66;margin-top:2pt}.der{text-align:right;font-size:8.5pt;color:#4A5A66}' +\n    'h2{font-size:11pt;color:#1F3A4D;background:#E8EEF2;border-left:4pt solid #E8A317;padding:4pt 7pt;margin:14pt 0 6pt;page-break-after:avoid}' +\n    'h3{font-size:10.5pt;color:#1F3A4D;margin:10pt 0 4pt;border-bottom:1pt solid #C9D3DA;padding-bottom:2pt;page-break-after:avoid}tr,img{page-break-inside:avoid}' +\n    'table.t{width:100%;border-collapse:collapse;table-layout:fixed;margin:2pt 0 8pt}.t th{background:#E8EEF2;color:#1F3A4D;font-size:8pt;text-align:left;padding:3pt 4pt;border:0.5pt solid #C9D3DA}' +\n    '.t td{font-size:8pt;padding:3pt 4pt;border:0.5pt solid #C9D3DA;vertical-align:top}.t tr.b td{background:#F6F8FA}' +\n    'table.fi{width:100%;border-collapse:collapse;margin:0 0 8pt}.fi th{text-align:left;font-size:8pt;color:#6B7A83;font-weight:normal;padding:2.5pt 6pt 2.5pt 0;width:17%;vertical-align:top}.fi td{font-size:9pt;font-weight:bold;padding:2.5pt 10pt 2.5pt 0;width:33%;vertical-align:top}' +\n    'table.kp{width:100%;border-collapse:separate;border-spacing:4pt;margin:2pt 0 6pt}.kp td{border:0.5pt solid #C9D3DA;border-top:2.5pt solid #2B4F66;text-align:center;padding:5pt 3pt;font-size:8pt;color:#4A5A66;background:#FFFFFF}.kp b{display:block;font-size:16pt;color:#1F3A4D;margin-bottom:1pt}' +\n    '.kp b.crit,.crit{color:#B3261E}.kp b.amb{color:#9A6100}.kp b.ok{color:#1E6B2D}' +\n    '.s{font-weight:bold;padding:1pt 3pt;border:0.5pt solid transparent}.s.crit{border-color:#E7A7AD}.s.amb{border-color:#EBCB8B}.s.ok{border-color:#A9D6B1}.s.crit{background:#F8D7DA;color:#8A1C24}.s.amb{background:#FFF1D6;color:#7A5200}.s.ok{background:#DFF2E1;color:#1E6B2D}' +\n    'table.fo{width:100%;border-collapse:collapse}.fo td{width:50%;vertical-align:top;padding:4pt;text-align:center}.pf{font-size:7.5pt;color:#4A5A66;margin-top:2pt}' +\n    '.nada{color:#6B7A83;font-style:italic;margin:2pt 0 8pt}.nota{font-size:8pt;color:#6B7A83}.img{text-align:center;margin:4pt 0 8pt}' +\n    '.pie{margin-top:16pt;font-size:7.5pt;color:#6B7A83;border-top:0.5pt solid #C9D3DA;padding-top:4pt}';\n\n  function documento(r) {\n    var logo = r.logo || A.logo || LOGO;\n    return '<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>' + esc(r.titulo) + '</title><style>' + CSS_PDF + '</style></head><body>' +\n      '<table class=\"cab\"><tr>' + (logo ? '<td style=\"width:118pt\"><img src=\"' + logo + '\" style=\"height:42pt\"></td>' : '') +\n      '<td><h1>' + esc(r.titulo) + '</h1><div class=\"sub\">' + esc(r.sub || '') + '</div></td>' +\n      '<td class=\"der\">' + esc(A.app || '') + '<br>Contrato 4600030865<br>División Chuquicamata</td></tr></table>' +\n      r.cuerpo +\n      '<div class=\"pie\">Informe generado el ' + esc(ahora()) + (A.autor && A.autor() ? ' por ' + esc(A.autor()) : '') + ' desde la app MSMIN · Ingeniería de mantenimiento</div>' +\n      '</body></html>';\n  }\n\n  /* ---------- Descarga ---------- */\n  function estado(t, err) { var e = $('miEst'); e.textContent = t || ''; e.className = 'mi-est' + (err ? ' err' : ''); }\n  function bajar(res, boton) {\n    var bin = atob(res.b64), n = bin.length, u = new Uint8Array(n);\n    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);\n    var url = URL.createObjectURL(new Blob([u], { type: 'application/pdf' }));\n    var a = document.createElement('a'); a.href = url; a.download = res.nombre; a.rel = 'noopener';\n    document.body.appendChild(a); a.click(); a.remove();\n    estado('Listo: ' + res.nombre + ' (' + Math.max(1, Math.round(n / 1024)) + ' KB). Si no se descargó, toca «Guardar PDF».');\n    if (boton) {\n      var g = document.createElement('a'); g.className = 'mi-btn ok'; g.href = url; g.download = res.nombre; g.textContent = '⬇ Guardar PDF';\n      boton.replaceWith(g);\n    }\n  }\n  function generar(clave, boton) {\n    if (ocupado) return;\n    var it = LISTA.filter(function (x) { return x.clave === clave; })[0];\n    if (!it) return;\n    ocupado = true;\n    var txt = boton ? boton.textContent : '';\n    if (boton) { boton.disabled = true; boton.textContent = 'Generando…'; }\n    estado('Generando el PDF de ' + it.titulo + '…');\n    var fin = function () { ocupado = false; if (boton && boton.isConnected) { boton.disabled = false; boton.textContent = txt; } };\n    Promise.resolve().then(function () { return A.informe(clave, H); }).then(function (r) {\n      if (!window.google || !google.script || !google.script.run) throw new Error('Abre la app desde su enlace para generar el PDF.');\n      google.script.run\n        .withSuccessHandler(function (res) { fin(); bajar(res, boton && boton.isConnected ? boton : null); })\n        .withFailureHandler(function (e) { fin(); estado('No se pudo generar el PDF: ' + (e && e.message || e), true); })\n        .msminInformePdf(documento(r), r.archivo || r.titulo);\n    }).catch(function (e) { fin(); estado('No se pudo armar el informe: ' + (e && e.message || e), true); });\n  }\n\n  /* ---------- Panel ---------- */\n  function pintarLista() {\n    var q = sinTilde($('miQ').value).trim(), palabras = q ? q.split(/\\s+/) : [];\n    var f = LISTA.filter(function (x) { var t = x._b || (x._b = sinTilde([x.titulo, x.sub, x.buscar].join(' '))); return palabras.every(function (p) { return t.indexOf(p) >= 0; }); });\n    $('miCnt').textContent = LISTA.length ? (q ? f.length + ' de ' + LISTA.length + ' inspecciones' : LISTA.length + (LISTA.length === 1 ? ' inspección registrada' : ' inspecciones registradas')) : '';\n    $('miLi').innerHTML = f.slice(0, 120).map(function (x, i) {\n      return '<li><div class=\"t\"><b>' + esc(x.titulo) + (x === LISTA[0] ? ' · última' : '') + '</b><small>' + esc(x.sub || '') + '</small></div>' +\n        '<button class=\"mi-btn\" type=\"button\" data-k=\"' + esc(x.clave) + '\">⬇ PDF</button></li>';\n    }).join('') || '<li class=\"mi-vacio\">' + (LISTA.length ? 'No hay inspecciones que coincidan con la búsqueda.' : 'Todavía no hay inspecciones registradas.') + '</li>';\n  }\n  function abrir() {\n    try { LISTA = A.lista(H) || []; } catch (e) { LISTA = []; estado('No se pudo leer la lista: ' + e.message, true); }\n    var u = LISTA[0];\n    $('miUlt').style.display = u ? '' : 'none';\n    if (u) { $('miUltT').textContent = 'Descargar PDF · ' + u.titulo; $('miUltS').textContent = u.sub || ''; }\n    $('miQ').value = ''; if (!ocupado) estado('');\n    pintarLista();\n    $('miFondo').classList.add('on'); $('miPanel').classList.add('on');\n  }\n  function cerrar() { $('miFondo').classList.remove('on'); $('miPanel').classList.remove('on'); }\n\n  function poner() {\n    if (document.querySelector('.msmin-inf')) return;\n    var b = document.createElement('button');\n    b.type = 'button'; b.className = 'msmin-inf'; b.title = 'Descargar informes PDF de inspección'; b.setAttribute('aria-label', 'Informes PDF de inspección');\n    b.innerHTML = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z\"/><path d=\"M14 3v5h5M12 11v6M9 14l3 3 3-3\"/></svg><span class=\"tx\">Informes PDF</span>';\n    b.addEventListener('click', abrir);\n    var donde = A.boton ? document.querySelector(A.boton) : null;\n    if (donde) donde.parentNode.insertBefore(b, donde);\n    else {\n      var v = document.querySelector('.msmin-volver');\n      if (v && v.parentNode) v.parentNode.insertBefore(b, v.nextSibling);\n      else { b.classList.add('flota'); document.body.appendChild(b); }\n    }\n    $('miX').onclick = cerrar; $('miFondo').onclick = cerrar;\n    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('miPanel').classList.contains('on')) cerrar(); });\n    $('miQ').oninput = pintarLista;\n    $('miUlt').onclick = function () { if (LISTA[0]) generar(LISTA[0].clave, null); };\n    $('miLi').onclick = function (e) { var t = e.target.closest('button[data-k]'); if (t) generar(t.getAttribute('data-k'), t); };\n    if (!A.logo) cargarLogo();\n  }\n  function cargarLogo() {\n    try {\n      fetch('https://gr1775san.github.io/APP-MSMIN/icons/logo.png').then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {\n        if (!b) return; var f = new FileReader(); f.onload = function () { LOGO = String(f.result || ''); }; f.readAsDataURL(b);\n      }).catch(function () { });\n    } catch (e) { }\n  }\n\n  /** adaptador: { app, logo?, boton?, autor(), lista(H) -> [{clave,titulo,sub,buscar}] (más reciente primero), informe(clave,H) -> {titulo,sub,archivo,cuerpo} | Promise } */\n  window.msminInformes = function (adaptador) {\n    A = adaptador;\n    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poner); else poner();\n  };\n})();\n</script>\n\n<script>\n/* MSMIN · Informes PDF para Inspección de polines. Una inspección = una semana (tabla pol_inspecciones). */\n(function () {\n  function lista() {\n    return S.insps.map(function (i) {\n      var n = i.id === S.actual ? S.hz.length + ' estaciones con falla · ' + S.hz.filter(crit).length + ' críticas' : (i.descripcion || '');\n      return { clave: i.id, titulo: i.semana + ' · ' + i.anio + ' · ' + fmtF(i.fecha), sub: n, buscar: [i.id, i.descripcion, i.origen].join(' ') };\n    });\n  }\n  function datos(clave) {\n    if (clave === S.actual) return Promise.resolve(S.hz);\n    return run('polHallazgos', clave).then(function (r) { return r.hallazgos; });\n  }\n  function informe(clave, H) {\n    var i = S.insps.filter(function (x) { return x.id === clave; })[0];\n    if (!i) throw new Error('No se encontró la inspección ' + clave);\n    return datos(clave).then(function (hz) {\n      hz = hz.slice().sort(function (a, b) { return a.equipo.localeCompare(b.equipo) || String(a.mesa).localeCompare(String(b.mesa), 'es', { numeric: true }) || (a.estacion || 0) - (b.estacion || 0); });\n      var pol = hz.reduce(function (a, x) { return a + nPol(x); }, 0), nc = hz.filter(crit).length, ni = hz.filter(inm).length;\n      var autores = hz.map(function (x) { return x.actualizado_por; }).filter(function (x, j, a) { return x && a.indexOf(x) === j; }).join(', ');\n      var porEq = {};\n      hz.forEach(function (x) { var o = porEq[x.equipo] || (porEq[x.equipo] = { e: x.equipo, n: 0, p: 0, c: 0, i: 0, a: 0, car: 0, ret: 0 }); o.n++; o.p += nPol(x); if (crit(x)) o.c++; if (inm(x)) o.i++; if (abierto(x)) o.a++; if (x.tipo === 'CARGA') o.car++; else o.ret++; });\n      var eqs = Object.keys(porEq).map(function (k) { return porEq[k]; }).sort(function (a, b) { return b.n - a.n; });\n      var h = H.ficha([['Inspección', i.semana + ' · ' + i.anio], ['Fecha', fmtF(i.fecha)], ['Equipos con hallazgos', String(eqs.length)], ['Registrado por', autores],\n        ['Contrato', S.config.contrato || '4600030865'], ['División', S.config.division || 'Chuquicamata']]);\n      h += H.kpis([[hz.length, 'Estaciones con falla', ''], [pol, 'Polines con falla', ''], [nc, 'Críticas', nc ? 'crit' : 'ok'], [ni, 'Prioridad inmediata', ni ? 'amb' : 'ok'], [hz.filter(abierto).length, 'Abiertas', 'amb'], [hz.length - hz.filter(abierto).length, 'Cerradas', 'ok']]);\n      h += '<h2>Resumen por equipo</h2>' + H.tabla([\n        ['Equipo', function (o) { return '<b>' + H.esc(o.e) + '</b>'; }], ['Estaciones', function (o) { return o.n; }], ['Polines', function (o) { return o.p; }],\n        ['Carga', function (o) { return o.car; }], ['Retorno', function (o) { return o.ret; }], ['Críticas', function (o) { return o.c ? '<b class=\"crit\">' + o.c + '</b>' : '0'; }],\n        ['Inmediatas', function (o) { return o.i; }], ['Abiertas', function (o) { return o.a; }]], eqs, 'Sin estaciones con falla.');\n      var modos = {}; hz.forEach(function (x) { var o = modos[x.modo_falla] || (modos[x.modo_falla] = { m: x.modo_falla, n: 0, p: 0, c: x.criticidad }); o.n++; o.p += nPol(x); });\n      h += '<h2>Modos de falla</h2>' + H.tabla([['Modo de falla', function (o) { return H.esc(o.m); }, '40%'], ['Criticidad', function (o) { return H.sello(o.c); }], ['Estaciones', function (o) { return o.n; }], ['Polines', function (o) { return o.p; }]],\n        Object.keys(modos).map(function (k) { return modos[k]; }).sort(function (a, b) { return b.n - a.n; }));\n      var cols = [['ID', function (x) { return '<b>' + H.esc(x.id.replace(/^PL-\\d{4}-W\\d+-/, '')) + '</b>'; }, '24pt'], ['Equipo', function (x) { return H.esc(x.equipo); }, '38pt'],\n        ['Mesa · est.', function (x) { return H.esc(x.mesa) + ' · ' + H.esc(x.estacion); }, '38pt'],\n        ['Lado / polín', function (x) { return H.esc((x.tipo === 'RETORNO' ? 'Retorno' : 'Carga')) + '<br>' + H.esc(x.tipo_polin); }, '50pt'],\n        ['Posición', function (x) { return ['izq', 'cent1', 'cent2', 'der'].filter(function (k) { return Number(x[k]) === 1; }).map(function (k) { return POS_TXT[k]; }).join(', '); }, '46pt'],\n        ['Modo de falla / comentario', function (x) { return '<b>' + H.esc(x.modo_falla) + '</b>' + (x.temperatura && x.temperatura !== 'Normal' ? ' <b class=\"crit\">' + H.esc(x.temperatura) + '</b>' : '') + (x.comentario ? '<br>' + H.txt(x.comentario) : ''); }],\n        ['Prior.', function (x) { return x.prioridad === 'Inmediato' ? '<b>Inm.</b>' : 'Plan.'; }, '30pt'],\n        ['Estado', function (x) { return H.sello(x.estado); }, '56pt'],\n        ['Aviso / OT', function (x) { return H.esc([x.n_aviso, x.n_ot].filter(Boolean).join(' / ')); }, '42pt']];\n      var ci = hz.filter(function (x) { return crit(x) && inm(x); });\n      h += '<h2>Críticas de intervención inmediata (' + ci.length + ')</h2>' + H.tabla(cols, ci, 'No hay estaciones críticas de prioridad inmediata.');\n      var tmp = hz.filter(function (x) { return x.temperatura && x.temperatura !== 'Normal'; });\n      if (tmp.length) h += '<h2>Alertas de temperatura</h2>' + H.tabla(cols, tmp);\n      h += '<h2>Detalle de estaciones con falla por equipo</h2>';\n      eqs.forEach(function (o) { h += '<h3>' + H.esc(o.e) + ' · ' + o.n + ' estaciones · ' + o.p + ' polines</h3>' + H.tabla(cols, hz.filter(function (x) { return x.equipo === o.e; })); });\n      return { titulo: 'Informe de inspección de polines', sub: i.semana + ' · ' + i.anio + ' · ' + fmtF(i.fecha), archivo: 'Informe_Polines_' + i.semana.replace(/\\s+/g, '') + '_' + i.anio, cuerpo: h };\n    });\n  }\n  msminInformes({ app: 'Inspección de polines', autor: function () { return S.usuario; }, lista: lista, informe: informe });\n})();\n</script>\n</body>\n</html>\n";
