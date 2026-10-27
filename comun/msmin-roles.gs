/* ======================================================================
 *  MSMIN_ROLES · Roles de acceso (igual en todas las apps MSMIN)
 *
 *  Roles (se asignan en el menú MSMIN › Ajustes › Equipo):
 *    admin    hace de todo (incluye borrar y abrir las bases de datos)
 *    usuario  ingresa y edita datos, descarga documentos; no borra ni abre las bases de datos
 *    visor    solo mira la app: sin botones de agregar, editar, borrar, descargar ni bases de datos
 *
 *  Cómo entra cada persona: el menú MSMIN abre la app con un pase de un solo uso (?k=…, vence en 2 min).
 *  La app lo canjea en Supabase (función portal_canjear) y crea una sesión de 6 h (?s=…).
 *  El dueño del proyecto entra siempre como admin. Sin pase ni sesión no se entra.
 *
 *  Cada app define:
 *    MSMIN_PERMISOS = { nombreFuncion: 'visor' | 'usuario' | 'admin' }   (funciones que llama la página)
 *    MSMIN_OCULTAR  = { visor: 'selectores css', usuario: 'selectores css', cssVisor: 'css extra', cssUsuario: 'css extra' }
 *    (lo de usuario también se oculta al visor)
 *    (opcional) msminNivelPost_(e) -> nivel que exige un envío de formulario (apps con doPost)
 *  Las funciones de MSMIN_PERMISOS se llaman con su nombre + "_" (así la página no puede saltarse el control).
 *  Las funciones originales doGet / doPost pasan a llamarse appGet_ / appPost_.
 * ====================================================================== */
const MSMIN_SB = 'https://cklbhuqjhsxvtcdwerxr.supabase.co';
const MSMIN_SB_PUB = 'sb_publishable_osYXaqxzeK_zdu2XaqutBg_XkshjB8X';   // clave pública (la misma de la app de celular)
const MSMIN_MENU = 'https://gr1775san.github.io/APP-MSMIN/';
const MSMIN_NIVEL = { visor: 1, usuario: 2, admin: 3 };
const MSMIN_ROL_TXT = { visor: 'Visor', usuario: 'Usuario', admin: 'Administrador' };
let _MSMIN = null;   // sesión de la llamada en curso {email, nombre, rol, token}

function doGet(e) {
  const s = msminSesion_(e);
  if (!s) return msminSinAcceso_();
  _MSMIN = s;
  return msminEnvolver_(appGet_(e), s);
}

function doPost(e) {
  const p = (e && e.parameter) || {};
  const s = msminLeer_(p._msmin) || msminDueno_();
  if (!s) return msminSinAcceso_('Tu sesión venció. Vuelve a abrir la app desde el menú MSMIN.');
  const nivel = typeof msminNivelPost_ === 'function' ? msminNivelPost_(e) : 'usuario';
  if (MSMIN_NIVEL[s.rol] < MSMIN_NIVEL[nivel || 'usuario']) {
    _MSMIN = s;
    return msminEnvolver_(appGet_(e), s, 'Tu rol (' + MSMIN_ROL_TXT[s.rol] + ') no permite esta acción.');
  }
  _MSMIN = s;
  return msminEnvolver_(appPost_(e), s);
}

/** Todas las llamadas de la página pasan por aquí: revisa la sesión y el rol, y llama a la función real (nombre_). */
function msminLlamar(token, fn, args) {
  const nombre = String(fn || '').replace(/_+$/, '');
  const nivel = MSMIN_PERMISOS[nombre];
  if (!nivel) throw new Error('Acción no permitida: ' + nombre);
  const s = msminLeer_(token) || msminDueno_();
  if (!s) throw new Error('Tu sesión venció. Vuelve a abrir la app desde el menú MSMIN.');
  if (MSMIN_NIVEL[s.rol] < MSMIN_NIVEL[nivel]) throw new Error('Tu rol (' + MSMIN_ROL_TXT[s.rol] + ') no permite esta acción.');
  const f = globalThis[nombre + '_'] || (nombre === 'msminInformePdf' ? globalThis.msminInformePdf : null);
  if (typeof f !== 'function') throw new Error('No existe la acción ' + nombre);
  _MSMIN = s;
  return f.apply(null, args || []);
}

/** Correo de quien usa la app (para "actualizado por") */
function msminCorreo_() { return (_MSMIN && _MSMIN.email) || ''; }
function msminRol_() { return (_MSMIN && _MSMIN.rol) || ''; }

/* ---------- Sesiones ---------- */
function msminDueno_() {
  try {
    const a = Session.getActiveUser().getEmail(), d = Session.getEffectiveUser().getEmail();
    if (a && d && a.toLowerCase() === d.toLowerCase()) return { email: a.toLowerCase(), nombre: '', rol: 'admin', token: '' };
  } catch (e) { }
  return null;
}

function msminSesion_(e) {
  const p = (e && e.parameter) || {};
  if (p.s) { const s = msminLeer_(p.s); if (s) return s; }
  if (p.k) { const s = msminCanjear_(p.k); if (s) return s; }
  const d = msminDueno_();
  return d ? msminCrear_(d) : null;
}

function msminCanjear_(k) {
  try {
    const r = UrlFetchApp.fetch(MSMIN_SB + '/rest/v1/rpc/portal_canjear', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify({ p_ticket: String(k).slice(0, 80) }),
      headers: { apikey: MSMIN_SB_PUB }, muteHttpExceptions: true
    });
    if (r.getResponseCode() >= 300) return null;
    const u = (JSON.parse(r.getContentText() || '[]') || [])[0];
    if (!u || !MSMIN_NIVEL[u.rol]) return null;
    return msminCrear_({ email: u.email, nombre: u.nombre || '', rol: u.rol });
  } catch (e) { return null; }
}

function msminCrear_(u) {
  const t = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const s = { email: u.email, nombre: u.nombre || '', rol: u.rol, token: t };
  CacheService.getScriptCache().put('msmin_s_' + t, JSON.stringify(s), 21600);
  return s;
}

function msminLeer_(t) {
  if (!t || !/^[a-f0-9]{40}$/.test(String(t))) return null;
  const c = CacheService.getScriptCache(), v = c.get('msmin_s_' + t);
  if (!v) return null;
  c.put('msmin_s_' + t, v, 21600);   // renueva 6 h con cada uso
  return JSON.parse(v);
}

/* ---------- Página ---------- */
function msminSinAcceso_(msg) {
  return HtmlService.createHtmlOutput('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B1A2C;color:#E9EFF5;font:15px/1.5 system-ui,sans-serif}' +
    '.c{max-width:420px;padding:28px;margin:16px;background:#12253B;border:1px solid #244260;border-radius:16px;text-align:center}' +
    'h1{font-size:19px;margin:0 0 8px}p{color:#B4C3D2}a{display:inline-block;margin-top:10px;background:#E8A317;color:#2A1B00;font-weight:700;text-decoration:none;padding:12px 18px;border-radius:12px}</style></head>' +
    '<body><div class="c"><h1>Acceso solo desde el menú MSMIN</h1><p>' + (msg || 'Esta aplicación se abre desde el menú Estructural MSMIN con tu cuenta del equipo.') + '</p>' +
    '<a href="' + MSMIN_MENU + '" target="_top">Ir al menú MSMIN</a></div></body></html>')
    .setTitle('MSMIN · Acceso').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Agrega a la página de la app: datos de la sesión, el control de llamadas y el ocultado de botones según el rol */
function msminEnvolver_(out, s, aviso) {
  const oc = (typeof MSMIN_OCULTAR !== 'undefined' && MSMIN_OCULTAR) || {};
  // comunes: el visor no descarga informes; usuario y visor no abren las bases de datos (planillas)
  const baseVisor = '.msmin-inf,#nameBanner', baseUsuario = 'a[href*="docs.google.com/spreadsheets"],#sheetLink';
  const ocultar = s.rol === 'visor' ? [baseVisor, baseUsuario, oc.visor, oc.usuario].filter(Boolean).join(',') : s.rol === 'usuario' ? [baseUsuario, oc.usuario].filter(Boolean).join(',') : '';
  const datos = JSON.stringify({ rol: s.rol, rolTxt: MSMIN_ROL_TXT[s.rol], email: s.email, nombre: s.nombre, token: s.token, aviso: aviso || '' }).replace(/</g, '\\u003c');
  const extra = s.rol === 'visor' ? (oc.cssVisor || '') + (oc.cssUsuario || '') : s.rol === 'usuario' ? (oc.cssUsuario || '') : '';
  const head = '<script>window.MSMIN=' + datos + ';</script>' +
    (ocultar || extra ? '<style id="msmin-rol-css">' + (ocultar ? ocultar + '{display:none!important}' : '') + extra + '</style>' : '') + MSMIN_ROLES_CLIENTE;
  let html = out.getContent();
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html;
  out.setContent(html);
  return out;
}

const MSMIN_ROLES_CLIENTE = '<script>(function () {' +
  'var M = window.MSMIN || {};' +
  /* 1. Todas las llamadas al servidor pasan por msminLlamar con la sesión */
  'function envolver() {' +
  '  if (!window.google || !google.script || !google.script.run || google.script.run.__msmin) return false;' +
  '  var real = google.script.run;' +
  '  function mk(ok, ko, uo) { return new Proxy({}, { get: function (_, n) {' +
  '    if (n === "__msmin") return true;' +
  '    if (n === "withSuccessHandler") return function (h) { return mk(h, ko, uo); };' +
  '    if (n === "withFailureHandler") return function (h) { return mk(ok, h, uo); };' +
  '    if (n === "withUserObject") return function (o) { return mk(ok, ko, o); };' +
  '    if (typeof n !== "string") return undefined;' +
  '    return function () { var r = real; if (ok) r = r.withSuccessHandler(ok); if (ko) r = r.withFailureHandler(ko); if (uo !== undefined) r = r.withUserObject(uo);' +
  '      return r.msminLlamar(M.token || "", n, Array.prototype.slice.call(arguments)); }; } }); }' +
  '  try { google.script.run = mk(); } catch (e) { return false; }' +
  '  return true; }' +
  'if (!envolver()) { var iv = setInterval(function () { if (envolver()) clearInterval(iv); }, 30); setTimeout(function () { clearInterval(iv); }, 10000); }' +
  /* 2. La sesión queda en la dirección (al recargar sigue dentro) y el pase de un uso desaparece */
  'try { if (M.token && google.script.history) google.script.history.replace(null, { s: M.token }); } catch (e) { }' +
  /* 3. Los formularios llevan la sesión */
  'function conToken(f) { if (!f || f.tagName !== "FORM") return; var i = f.querySelector("[name=_msmin]"); if (!i) { i = document.createElement("input"); i.type = "hidden"; i.name = "_msmin"; f.appendChild(i); } i.value = M.token || ""; }' +
  'document.addEventListener("submit", function (ev) { conToken(ev.target); }, true);' +
  'var _sub = HTMLFormElement.prototype.submit; HTMLFormElement.prototype.submit = function () { conToken(this); return _sub.call(this); };' +
  /* 4. Marca del rol y aviso */
  'function marcar() { document.documentElement.setAttribute("data-rol", M.rol || "");' +
  '  if (M.rol && M.rol !== "admin" && !document.getElementById("msmin-rol")) {' +
  '    var b = document.createElement("div"); b.id = "msmin-rol";' +
  '    b.style.cssText = "position:fixed;right:10px;bottom:calc(env(safe-area-inset-bottom) + 84px);z-index:9998;background:#12253B;color:#FFE2A6;border:1px solid rgba(232,163,23,.6);border-radius:999px;padding:6px 12px;font:600 12px/1 IBM Plex Sans,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none";' +
  '    b.textContent = (M.rol === "visor" ? "👁 Visor · solo lectura" : "Usuario") ; document.body.appendChild(b); }' +
  '  if (M.aviso) alertar(M.aviso); }' +
  'function alertar(t) { var d = document.createElement("div"); d.textContent = t; d.style.cssText = "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99999;background:#8A1C24;color:#fff;padding:12px 16px;border-radius:12px;font:500 14px system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.4)"; document.body.appendChild(d); setTimeout(function () { d.remove(); }, 6000); }' +
  /* 5. Visor: cualquier campo queda solo de lectura */
  'function bloquear() { if (M.rol !== "visor") return; document.querySelectorAll("input:not([type=search]),select,textarea").forEach(function (x) { if (x.closest("[data-msmin-libre]")) return; if (x.tagName === "SELECT" && x.closest(".filtros,.semana,[role=search],.mi-bus")) return; x.setAttribute("readonly", ""); if (x.type === "file" || x.type === "checkbox" || x.type === "radio") x.disabled = true; }); }' +
  'function listo() { marcar(); bloquear(); if (M.rol === "visor") new MutationObserver(function () { bloquear(); }).observe(document.body, { childList: true, subtree: true }); }' +
  'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", listo); else listo();' +
  'window.msminPuede = function (nivel) { var n = { visor: 1, usuario: 2, admin: 3 }; return (n[M.rol] || 0) >= (n[nivel] || 9); };' +
  '})();</script>';
