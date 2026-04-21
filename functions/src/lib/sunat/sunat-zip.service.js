const JSZip = require("jszip");

/**
 * Crea un ZIP en memoria con un único archivo XML.
 * @param {string} zipName    - Nombre del archivo ZIP (no usado en el contenido, solo referencia)
 * @param {string} xmlName    - Nombre del archivo XML dentro del ZIP
 * @param {string} xmlContent - Contenido XML firmado
 * @returns {Promise<Buffer>} ZIP en memoria como Buffer
 */
async function createZip(zipName, xmlName, xmlContent) {
  const zip = new JSZip();
  zip.file(xmlName, xmlContent);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buffer;
}

module.exports = { createZip };
