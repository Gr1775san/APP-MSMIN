/* Parche de velocidad para las apps Apps Script de MSMIN (Ruedas, Tambores, Puente).
   Uso: acelerar(textoCodigoGs) -> { texto, cambios[] }  (lanza error si algo no calza) */
function acelerar(src) {
  if (src.indexOf('MSMIN_RAPIDO') >= 0) return { texto: src, cambios: ['ya estaba aplicado'] };
  var cambios = [];
  function rep(a, b, nombre) {
    var n = src.split(a).length - 1;
    if (n !== 1) throw new Error('No calza "' + nombre + '" (' + n + ' coincidencias)');
    src = src.replace(a, function () { return b; }); cambios.push(nombre);
  }
  // 1) Lecturas de Supabase: memoria por petición + modo registro para leerlas todas en paralelo
  rep("function sbLeer_(tabla, consulta) { return sb_('get', tabla + '?' + (consulta || 'select=*')) || []; }",
    "function sbLeer_(tabla, consulta) {\n" +
    "  const ruta = tabla + '?' + (consulta || 'select=*');\n" +
    "  if (_SB_REG) { _SB_REG.push(ruta); return []; }\n" +
    "  if (_SB_MEMO && Object.prototype.hasOwnProperty.call(_SB_MEMO, ruta)) return _SB_MEMO[ruta];\n" +
    "  return sb_('get', ruta) || [];\n" +
    "}", 'lecturas en paralelo');

  // 2) Dirección de la planilla sin abrirla
  var urlNueva = "sheetUrl = 'https://docs.google.com/spreadsheets/d/' + CFG.SPREADSHEET_ID + '/edit';";
  if (src.indexOf("try { sheetUrl = ss_().getUrl(); } catch (e) { if (!sb) throw e; }") >= 0)
    rep("try { sheetUrl = ss_().getUrl(); } catch (e) { if (!sb) throw e; }", "if (CFG.SPREADSHEET_ID) " + urlNueva + " else { try { sheetUrl = ss_().getUrl(); } catch (e) { if (!sb) throw e; } }", 'url de planilla');
  else if (src.indexOf("try { sheetUrl = ss_().getUrl(); } catch (e) { }") >= 0)
    rep("try { sheetUrl = ss_().getUrl(); } catch (e) { }", "if (CFG.SPREADSHEET_ID) " + urlNueva + " else { try { sheetUrl = ss_().getUrl(); } catch (e) { } }", 'url de planilla');

  // 3) Logo guardado en memoria (6 h)
  rep("function logoDataUrl_() {", "function logoDataUrl_() {\n  const enMemoria = cacheLeer_('msmin_logo');\n  if (enMemoria) return enMemoria;\n  const v = logoDataUrlDrive_();\n  if (v) cacheGuardar_('msmin_logo', v, 21600);\n  return v;\n}\n\nfunction logoDataUrlDrive_() {", 'logo en memoria');

  // 4a) Todo guardado pasa por doPost: ahí se renueva la memoria
  rep("function doPost(e) {", "function doPost(e) {\n  _ESCRIBIO = true;", 'renovar al guardar');
  // 4) Datos de la página: memoria de 10 min, renovada en cada guardado
  var m = src.match(/(\n\s*)(try \{ )?boot = datos_\(\);/);
  if (!m) throw new Error('No calza "boot = datos_()"');
  rep(m[0], m[0].replace('boot = datos_();', 'boot = datosRapido_(res);'), 'datos en memoria');

  src += "\n\n/* ======================================================================\n" +
    " *  MSMIN_RAPIDO · velocidad de carga\n" +
    " *  - Los datos de la página quedan 10 min en memoria (CacheService) y se renuevan\n" +
    " *    cada vez que alguien guarda desde la app. Cambios hechos a mano en la base\n" +
    " *    se ven en máximo 10 min (o al ejecutar limpiarMemoria()).\n" +
    " *  - Cuando hay que leer la base, todas las consultas van en paralelo.\n" +
    " * ====================================================================== */\n" +
    "let _SB_REG = null, _SB_MEMO = null, _ESCRIBIO = false;\n" +
    "const MEMORIA_SEG = 600;\n\n" +
    "function datosRapido_(res) {\n" +
    "  if (!_ESCRIBIO) {\n" +
    "    const g = cacheLeer_('msmin_datos');\n" +
    "    if (g) { try { const d = JSON.parse(g); d.usuario = usuario_(); d.hoy = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'); return d; } catch (e) { } }\n" +
    "  }\n" +
    "  const d = datosParalelo_();\n" +
    "  try { cacheGuardar_('msmin_datos', JSON.stringify(d), MEMORIA_SEG); } catch (e) { }\n" +
    "  return d;\n" +
    "}\n\n" +
    "/** Igual que datos_(), pero lee todas las tablas de Supabase en una sola tanda paralela. */\n" +
    "function datosParalelo_() {\n" +
    "  if (!sbActivo_()) return datos_();\n" +
    "  let rutas = [];\n" +
    "  try { _SB_REG = rutas; datos_(); } catch (e) { } finally { _SB_REG = null; }\n" +
    "  rutas = rutas.filter((r, i) => rutas.indexOf(r) === i);\n" +
    "  if (!rutas.length) return datos_();\n" +
    "  try {\n" +
    "    const p = sbProps_();\n" +
    "    const key = String(p.SUPABASE_SERVICE_KEY).trim();\n" +
    "    const headers = { apikey: key };\n" +
    "    if (/^eyJ/.test(key)) headers.Authorization = 'Bearer ' + key;\n" +
    "    const base = String(p.SUPABASE_URL).trim().replace(/\\/+$/, '') + '/rest/v1/';\n" +
    "    const resp = UrlFetchApp.fetchAll(rutas.map(r => ({ url: base + r, method: 'get', headers: headers, muteHttpExceptions: true })));\n" +
    "    _SB_MEMO = {};\n" +
    "    resp.forEach((r, i) => { if (r.getResponseCode() < 300) { const t = r.getContentText(); _SB_MEMO[rutas[i]] = t ? JSON.parse(t) : []; } });\n" +
    "    return datos_();\n" +
    "  } finally { _SB_MEMO = null; }\n" +
    "}\n\n" +
    "/** Ejecutar desde el editor si se cambió la base a mano y se quiere ver al instante. */\n" +
    "function limpiarMemoria() { CacheService.getScriptCache().removeAll(['msmin_datos', 'msmin_datos#n', 'msmin_logo', 'msmin_logo#n']); }\n\n" +
    "function cacheGuardar_(clave, texto, seg) {\n" +
    "  const c = CacheService.getScriptCache(), T = 90000, n = Math.ceil(texto.length / T), o = {};\n" +
    "  if (n > 9) return;\n" +
    "  for (let i = 0; i < n; i++) o[clave + '#' + i] = texto.substr(i * T, T);\n" +
    "  o[clave + '#n'] = String(n);\n" +
    "  c.putAll(o, seg);\n" +
    "}\n\n" +
    "function cacheLeer_(clave) {\n" +
    "  try {\n" +
    "    const c = CacheService.getScriptCache(), n = Number(c.get(clave + '#n'));\n" +
    "    if (!n) return null;\n" +
    "    const ks = []; for (let i = 0; i < n; i++) ks.push(clave + '#' + i);\n" +
    "    const v = c.getAll(ks); let s = '';\n" +
    "    for (let i = 0; i < n; i++) { if (v[ks[i]] == null) return null; s += v[ks[i]]; }\n" +
    "    return s;\n" +
    "  } catch (e) { return null; }\n" +
    "}\n";
  cambios.push('funciones nuevas');
  return { texto: src, cambios: cambios };
}
if (typeof module !== 'undefined') module.exports = acelerar;
