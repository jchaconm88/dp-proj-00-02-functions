"use strict";

const { admin } = require("../firebase");

/**
 * Sube un buffer a Storage y devuelve URL firmada de lectura.
 *
 * @param {string} companyId
 * @param {string} fileName
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<string>}
 */
async function uploadInvoiceFileToStorage(companyId, fileName, buffer, contentType) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`invoices/${companyId}/${fileName}`);
  await file.save(buffer, { contentType });
  const [url] = await file.getSignedUrl({ action: "read", expires: "03-01-2500" });
  return url;
}

module.exports = { uploadInvoiceFileToStorage };
