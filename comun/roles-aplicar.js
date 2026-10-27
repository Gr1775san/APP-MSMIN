/* Se ejecuta en el editor de Apps Script: aplica MSMIN_ROLES al archivo .gs abierto (código vigente). */
window.msminAplicarRoles = async function (app, base) {
  const [cfgs, mod] = await Promise.all([fetch(base + 'roles-apps.json').then(r => r.json()), fetch(base + 'msmin-roles.gs').then(r => r.text())]);
  const c = cfgs[app]; if (!c) throw new Error('sin config ' + app);
  const ed = monaco.editor.getEditors()[0], model = ed.getModel();
  if (!/\.js$/.test(model.uri.toString())) throw new Error('El archivo abierto no es .gs');
  let s = model.getValue();
  if (s.indexOf('MSMIN_ROLES') >= 0) throw new Error('ya tiene MSMIN_ROLES');
  if (!/function\s+doGet\s*\(/.test(s)) throw new Error('no tiene doGet');
  const cuenta = {};
  s = s.replace(/\bfunction\s+doGet\s*\(/g, 'function appGet_(').replace(/\bfunction\s+doPost\s*\(/g, 'function appPost_(');
  s = s.replace(/(^|[^\w.$])doGet(\s*\()/g, '$1appGet_$2').replace(/(^|[^\w.$])doPost(\s*\()/g, '$1appPost_$2');
  Object.keys(c.permisos).forEach(f => {
    const re = new RegExp('(^|[^\\w$])' + f + '(?=\\s*\\()', 'g');
    cuenta[f] = (s.match(re) || []).length;
    s = s.replace(re, '$1' + f + '_');
  });
  const cfgTxt = '/* Roles MSMIN de esta app (ver MSMIN_ROLES al final) */\nconst MSMIN_PERMISOS = ' + JSON.stringify(c.permisos, null, 2) + ';\nconst MSMIN_OCULTAR = ' + JSON.stringify(c.ocultar, null, 2) + ';\n' + (c.post ? c.post + '\n' : '');
  const nuevo = s.replace(/\s+$/, '') + '\n\n' + cfgTxt + '\n' + mod;
  ed.executeEdits('msmin', [{ range: model.getFullModelRange(), text: nuevo }]); ed.focus();
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', keyCode: 83, ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 4000));
  return { largo: model.getValue().length, cuenta };
};
