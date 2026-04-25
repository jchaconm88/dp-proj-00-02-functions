"use strict";

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db, admin } = require("../../lib/firebase");
const { generateSignedXmlAndZip, processDocument, mapInvoiceToSunatPayload } = require("../../lib/sunat/sunat-document.service");
const { updateJob } = require("../../lib/sunat/sunat-job.service");
const { assertActiveSunatConfigForCompany } = require("../../lib/sunat/sunat-config-assert");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads an invoice document plus its invoiceItems and invoiceCredits subcollections.
 * @param {string} invoiceId
 * @returns {Promise<{ invoiceData: object, items: object[], credits: object[] }>}
 */
async function _readInvoiceWithSubcollections(invoiceId) {
  const [invoiceSnap, itemsSnap, creditsSnap] = await Promise.all([
    db.collection("invoices").doc(invoiceId).get(),
    db.collection("invoices").doc(invoiceId).collection("invoiceItems").get(),
    db.collection("invoices").doc(invoiceId).collection("invoiceCredits").get(),
  ]);

  if (!invoiceSnap.exists) {
    throw new Error(`Factura no encontrada: ${invoiceId}`);
  }

  return {
    invoiceData: invoiceSnap.data(),
    items: itemsSnap.docs.map((d) => d.data()),
    credits: creditsSnap.docs.map((d) => d.data()),
  };
}

/**
 * Uploads a buffer to Firebase Storage and returns a signed URL.
 * @param {string} companyId
 * @param {string} fileName
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {Promise<string>} Signed URL
 */
async function _uploadToStorage(companyId, fileName, buffer, contentType) {
  const bucket = admin.storage().bucket();
  const file = bucket.file(`invoices/${companyId}/${fileName}`);
  await file.save(buffer, { contentType });
  const [url] = await file.getSignedUrl({ action: "read", expires: "03-01-2500" });
  return url;
}

/**
 * Core processing logic for a sendBill job.
 * @param {string} jobId
 * @param {object} job - Job document data
 */
async function _processSendBillJob(jobId, job) {
  const { invoiceId, companyId } = job;

  // 1. Mark job as processing
  await updateJob(db, jobId, { status: "processing" });

  // 2. Read invoice + subcollections
  const { invoiceData, items, credits } = await _readInvoiceWithSubcollections(invoiceId);
  // Denormalizar datos clave del documento en el job para evitar joins desde la web.
  const documentNo = String(invoiceData?.documentNo ?? "").trim();
  const docType = String(invoiceData?.type ?? "").trim();
  // Solo fecha (YYYY-MM-DD) para el job (compatibilidad con `issueDate` legacy sin hora).
  const issueDateRaw = String(invoiceData?.issueDate ?? "").trim();
  const issueDateMatch = issueDateRaw.match(/^\d{4}-\d{2}-\d{2}/);
  const issueDate = issueDateMatch ? issueDateMatch[0] : (issueDateRaw.includes("T") ? issueDateRaw.split("T")[0] : issueDateRaw);
  await updateJob(db, jobId, {
    ...(documentNo ? { documentNo } : {}),
    ...(docType ? { docType } : {}),
    ...(issueDate ? { issueDate } : {}),
  });

  // 3. Read sunat-config (existente y activa)
  let config;
  try {
    config = await assertActiveSunatConfigForCompany(db, companyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Configuración SUNAT no disponible.";
    await updateJob(db, jobId, { status: "error", errorMessage: msg });
    await db.collection("invoices").doc(invoiceId).update({ status: "error" });
    return;
  }

  // 4. Map payload and generar artefactos (XML firmado + ZIP) ANTES de enviar.
  const payload = mapInvoiceToSunatPayload(invoiceData, items, credits);
  const artifacts = await generateSignedXmlAndZip("invoice", payload, config);

  // 5. Subir XML y ZIP siempre (sirve para depurar incluso cuando SUNAT rechaza por parsing/validación).
  let xmlUrl = null;
  let zipUrl = null;
  let cdrUrl = null;
  try {
    const xmlBuffer = Buffer.from(artifacts.signedXml, "utf8");
    [xmlUrl, zipUrl] = await Promise.all([
      _uploadToStorage(companyId, artifacts.xmlName, xmlBuffer, "application/xml"),
      _uploadToStorage(companyId, artifacts.zipName, artifacts.zipBuffer, "application/zip"),
    ]);
    await updateJob(db, jobId, { xmlUrl, zipUrl });
  } catch (storageErr) {
    console.error("Error al subir XML/ZIP a Storage:", storageErr);
  }

  // 6. Enviar a SUNAT (puede fallar por parsing; en ese caso igual quedan XML/ZIP arriba).
  const result = await processDocument("invoice", payload, config);

  const { cdrBuffer, cdrName, success } = result;
  const cdrMessages = result.messages ?? (result.response ? [result.response] : []);

  // 7. Upload CDR to Firebase Storage (ZIP y XML ya fueron subidos arriba)
  try {
    cdrUrl = await _uploadToStorage(companyId, cdrName, cdrBuffer, "application/zip");
  } catch (storageErr) {
    console.error("Error al subir archivos a Storage:", storageErr);
    // Non-fatal — continue with status update
  }

  const invoiceStatus = success ? "accepted" : "rejected";
  const jobStatus = success ? "accepted" : "rejected";

  // 7.5 Si la factura proviene de una liquidación, al aceptar SUNAT
  // marcar la liquidación como "pagada" (liquidada) y dejar pendientes en 0.
  // Nota: este estado se usa como "liquidación finalizada por facturación" (no pago bancario).
  const settlementId = String(invoiceData?.settlementId ?? "").trim();
  if (success && settlementId) {
    try {
      const settlementRef = db.collection("settlements").doc(settlementId);
      const settlementSnap = await settlementRef.get();
      if (settlementSnap.exists) {
        await settlementRef.update({
          paymentStatus: "invoiced",
          updateAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (err) {
      console.error("Error actualizando liquidación tras aceptación SUNAT:", err);
    }
  }

  // 8. Update invoice
  await db.collection("invoices").doc(invoiceId).update({
    status: invoiceStatus,
    zipUrl,
    cdrUrl,
    sunatResponse: result.response ?? "",
  });

  // 9. Update job
  await updateJob(db, jobId, {
    status: jobStatus,
    cdrMessages,
    zipUrl,
    cdrUrl,
    xmlUrl,
    pdfUrl: String(invoiceData?.pdfUrl ?? "").trim() || "",
    sunatResponse: result.response ?? "",
  });
}

// ---------------------------------------------------------------------------
// Trigger 1: onDocumentCreated — process new jobs
// ---------------------------------------------------------------------------

/**
 * Firestore trigger: fires when a new sunat-jobs document is created.
 * Handles jobType = "sendBill".
 */
exports.processSunatJob = onDocumentCreated("sunat-jobs/{jobId}", async (event) => {
  const jobId = event.params.jobId;
  const snap = event.data;

  if (!snap || !snap.exists) return;

  const job = snap.data();

  if (job.jobType !== "sendBill") {
    // Other job types (sendPack, sendSummary) handled by their own functions
    return;
  }

  try {
    await _processSendBillJob(jobId, job);
  } catch (err) {
    console.error(`Error procesando job ${jobId}:`, err);
    const msg = err instanceof Error ? err.message : String(err ?? "Error desconocido");
    await updateJob(db, jobId, { status: "error", errorMessage: msg });
    if (job.invoiceId) {
      try {
        await db.collection("invoices").doc(job.invoiceId).update({ status: "error" });
      } catch (invoiceErr) {
        console.error("Error actualizando factura a error:", invoiceErr);
      }
    }
  }
});
