
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
