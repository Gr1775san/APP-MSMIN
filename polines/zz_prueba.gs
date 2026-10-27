function zzProbarFlash() {
  const t0 = Date.now();
  const f = polGuardarHallazgo({ inspeccion_id: 'POL-2026-W41', equipo: '130CV03', tipo: 'CARGA', tipo_polin: 'TRIPLE', mesa: 'PRUEBA', estacion: 999, modo_falla: 'Desbocado', izq: 1, cent1: 0, der: 1, prioridad: 'Inmediato', temperatura: '70°C', comentario: 'Prueba de Reporte Flash automático (se borra sola)' });
  Logger.log('HALLAZGO ' + f.id + ' · flash ' + f.flash_id + ' · nuevo ' + f._flash_nuevo + ' · pdf ' + (f.flash_pdf ? 'SI' : 'NO') + ' · error ' + (f._flash_error || '-') + ' · ' + (Date.now() - t0) + ' ms');
  const ss = SpreadsheetApp.openById(FLASH_SS_ID); const h = flashHoja_(ss, 'REPORTES');
  const c = h.getRange(2, 1, Math.max(h.getLastRow() - 1, 1), 1).createTextFinder('RF-' + f.id).matchEntireCell(true).findNext();
  Logger.log('FILA REPORTES ' + (c ? c.getRow() + ' · ' + h.getRange(c.getRow(), 5).getValue() + ' · nivel ' + h.getRange(c.getRow(), 14).getValue() : 'NO ESTA'));
  if (c) h.deleteRow(c.getRow());
  if (f.flash_pdf) { const id = (f.flash_pdf.match(/[-\w]{25,}/) || [])[0]; if (id) { DriveApp.getFileById(id).setTrashed(true); Logger.log('PDF de prueba a la papelera'); } }
  polBorrarHallazgo(f.id);
  Logger.log('LIMPIO · total ' + (Date.now() - t0) + ' ms');
}

