
/** Fotos de Drive para el PDF: <img src="drive:ID"> -> imagen reducida (máx. 60 fotos por informe). */
function msminFotos_(html) {
  const ids = [];
  html.replace(/src="drive:([\w-]{10,})"/g, function (m, id) { if (ids.indexOf(id) < 0 && ids.length < 60) ids.push(id); return m; });
  if (!ids.length) return html;
  const mapa = {};
  try {
    const h = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
    const meta = UrlFetchApp.fetchAll(ids.map(id => ({ url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=thumbnailLink&supportsAllDrives=true', headers: h, muteHttpExceptions: true })));
    const conLink = [];
    meta.forEach((r, i) => {
      if (r.getResponseCode() !== 200) return;
      try { const l = JSON.parse(r.getContentText()).thumbnailLink; if (l) conLink.push({ id: ids[i], url: l.replace(/=s\d+$/, '') + '=s900' }); } catch (e) { }
    });
    if (conLink.length) {
      const imgs = UrlFetchApp.fetchAll(conLink.map(x => ({ url: x.url, headers: h, muteHttpExceptions: true })));
      imgs.forEach((r, i) => {
        if (r.getResponseCode() !== 200) return;
        const b = r.getBlob(), t = b.getContentType() || 'image/jpeg';
        if (/^image\//.test(t)) mapa[conLink[i].id] = 'data:' + t + ';base64,' + Utilities.base64Encode(b.getBytes());
      });
    }
  } catch (e) { Logger.log('Miniaturas no disponibles: ' + (e && e.message || e)); }
  // Respaldo: la foto original (si no es muy pesada)
  ids.filter(id => !mapa[id]).forEach(id => {
    try {
      const b = DriveApp.getFileById(id).getBlob();
      if (b.getBytes().length < 900000 && /^image\//.test(b.getContentType())) mapa[id] = 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes());
    } catch (e) { }
  });
  return html.replace(/<img([^>]*?)src="drive:([\w-]{10,})"([^>]*)>/g, function (m, a, id, b) {
    return mapa[id] ? '<img' + a + 'src="' + mapa[id] + '"' + b + '>' : '<div class="nota">[foto no disponible]</div>';
  });
}
