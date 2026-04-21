"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const {
  getStatusCdr,
  readCdr,
} = require("../../lib/sunat/sunat-soap.service");
const { assertSunatConfigActive } = require("../../lib/sunat/sunat-config-assert");

/** Maps invoice type to SUNAT document type code (Catálogo 01). */
const DOC_TYPE_CODE = {
  invoice: "01",
  credit_note: "07",
  debit_note: "08",
};

/**
 * Parses a documentNo like "F001-00000003" into { series: "F001", number: 3 }.
 * @param {string} documentNo
 * @returns {{ series: string, number: number }}
 */
function parseDocumentNo(documentNo) {
  const [series, rawNumber] = documentNo.split("-");
  return { series, number: parseInt(rawNumber, 10) };
}

/**
 * Queries the CDR status for a single invoice from SUNAT and updates Firestore.
 * @param {string} invoiceId
 * @returns {Promise<{ invoiceId: string, statusCode: string, statusMessage: string }>}
 */
async function querySingleInvoiceCdr(invoiceId) {
  // 1. Read invoice document
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoiceSnap = await invoiceRef.get();

  if (!invoiceSnap.exists) {
    throw new Error(`Factura no encontrada: ${invoiceId}`);
  }

  const invoiceData = invoiceSnap.data();
  const { documentNo, companyId, type } = invoiceData;

  // 2. Read sunat-config for the company (debe existir y estar activa)
  const configSnap = await db.collection("sunat-config").doc(companyId).get();
  const config = assertSunatConfigActive(configSnap);

  // 3. Parse documentNo → series and number
  const { series, number } = parseDocumentNo(documentNo);

  // 4. Determine document type code
  const docTypeCode = DOC_TYPE_CODE[type] ?? "01";

  // 5. Build SUNAT user: {ruc}{usuarioSunat}
  const ruc = invoiceData.company?.identityDocumentNo ?? invoiceData.companyId;
  const user = `${ruc}${config.usuarioSunat}`;
  const password = config.passwordSunat;

  // Use urlConsultaServidor if present, fall back to urlServidorSunat
  const url = config.urlConsultaServidor ?? config.urlServidorSunat;

  // 6. Call getStatusCdr from sunat-soap.service (billConsultService)
  const { statusCode, statusMessage, content } = await getStatusCdr(url, ruc, docTypeCode, series, number, user, password);

  // 7. Handle "not found" case — statusCode "98" or message contains "no existe"
  const notFound =
    statusCode === "98" ||
    statusMessage.toLowerCase().includes("no existe");

  if (notFound || content === null) {
    const msg = statusMessage || `Comprobante ${documentNo} no encontrado en SUNAT (código ${statusCode})`;
    await invoiceRef.update({ status: "not_found_in_sunat", sunatResponse: msg });
    return {
      invoiceId,
      statusCode: "not_found_in_sunat",
      statusMessage: msg,
    };
  }

  // 8. Parse CDR response
  const result = await readCdr(content);
  const { success, messages } = result;

  // 9. Update InvoiceRecord with result
  const status = success ? "accepted" : "rejected";
  const sunatResponse = messages.join("; ");

  await invoiceRef.update({ status, sunatResponse });

  return {
    invoiceId,
    statusCode: status,
    statusMessage: sunatResponse,
  };
}

/**
 * Callable Firebase Function v2 — queries CDR status for one or more invoices.
 * Processes each invoice individually; errors on one do not fail the whole batch.
 *
 * @param {{ ids: string[] }} data
 * @returns {Promise<Array<{ invoiceId: string, statusCode: string, statusMessage: string }>>}
 */
exports.queryInvoicesCdr = onCall(async ({ data }) => {
  const { ids } = data;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Se requiere al menos un ID de factura.");
  }

  const results = [];

  for (const invoiceId of ids) {
    try {
      const result = await querySingleInvoiceCdr(invoiceId);
      results.push(result);
    } catch (err) {
      console.error(`Error querying CDR for invoice ${invoiceId}:`, err);
      results.push({
        invoiceId,
        statusCode: "error",
        statusMessage: err.message ?? "Error desconocido",
      });
    }
  }

  return results;
});
