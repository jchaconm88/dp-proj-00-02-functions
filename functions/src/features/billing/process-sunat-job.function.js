"use strict";

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { db, admin } = require("../../lib/firebase");
const { processDocument, mapInvoiceToSunatPayload } = require("../../lib/sunat/sunat-document.service");
const { updateJob, scheduleRetry } = require("../../lib/sunat/sunat-job.service");
const { assertSunatConfigActive } = require("../../lib/sunat/sunat-config-assert");

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

  // 3. Read sunat-config (existente y activa)
  const configSnap = await db.collection("sunat-config").doc(companyId).get();
  let config;
  try {
    config = assertSunatConfigActive(configSnap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Configuración SUNAT no disponible.";
    await updateJob(db, jobId, { status: "error", errorMessage: msg });
    await db.collection("invoices").doc(invoiceId).update({ status: "error" });
    return;
  }

  // 4. Map payload and process document
  const payload = mapInvoiceToSunatPayload(invoiceData, items, credits);
  const result = await processDocument("invoice", payload, config);

  const { zipBuffer, zipName, cdrBuffer, cdrName, success, messages } = result;
  // Normalize messages — processDocument returns `response` (string), not `messages`
  const cdrMessages = result.messages ?? (result.response ? [result.response] : []);

  // 5. Upload ZIP and CDR to Firebase Storage
  let zipUrl = null;
  let cdrUrl = null;
  try {
    [zipUrl, cdrUrl] = await Promise.all([
      _uploadToStorage(companyId, zipName, zipBuffer, "application/zip"),
      _uploadToStorage(companyId, cdrName, cdrBuffer, "application/zip"),
    ]);
  } catch (storageErr) {
    console.error("Error al subir archivos a Storage:", storageErr);
    // Non-fatal — continue with status update
  }

  const invoiceStatus = success ? "accepted" : "rejected";
  const jobStatus = success ? "accepted" : "rejected";

  // 6. Update invoice
  await db.collection("invoices").doc(invoiceId).update({
    status: invoiceStatus,
    zipUrl,
    cdrUrl,
    sunatResponse: result.response ?? "",
  });

  // 7. Update job
  await updateJob(db, jobId, {
    status: jobStatus,
    cdrMessages,
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

    // Schedule retry or mark as failed
    await scheduleRetry(db, jobId, job.retryCount ?? 0, job.maxRetries ?? 3);

    // Update invoice to pending_retry
    if (job.invoiceId) {
      try {
        await db.collection("invoices").doc(job.invoiceId).update({
          status: "pending_retry",
        });
      } catch (invoiceErr) {
        console.error("Error actualizando factura a pending_retry:", invoiceErr);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Trigger 2: onDocumentUpdated — handle automatic retries
// ---------------------------------------------------------------------------

/**
 * Firestore trigger: fires when a sunat-jobs document is updated.
 * Re-processes the job when status = "pending_retry" and nextRetryAt <= now.
 */
exports.processSunatJobRetry = onDocumentUpdated("sunat-jobs/{jobId}", async (event) => {
  const jobId = event.params.jobId;
  const after = event.data.after;

  if (!after || !after.exists) return;

  const job = after.data();

  // Only handle pending_retry jobs whose retry time has arrived
  if (job.status !== "pending_retry") return;

  const nextRetryAt = job.nextRetryAt;
  if (!nextRetryAt) return;

  const now = new Date();
  const retryDate = nextRetryAt.toDate ? nextRetryAt.toDate() : new Date(nextRetryAt);

  if (retryDate > now) return;

  if (job.jobType !== "sendBill") return;

  try {
    await _processSendBillJob(jobId, job);
  } catch (err) {
    console.error(`Error en reintento del job ${jobId}:`, err);

    await scheduleRetry(db, jobId, job.retryCount ?? 0, job.maxRetries ?? 3);

    if (job.invoiceId) {
      try {
        await db.collection("invoices").doc(job.invoiceId).update({
          status: "pending_retry",
        });
      } catch (invoiceErr) {
        console.error("Error actualizando factura a pending_retry:", invoiceErr);
      }
    }
  }
});
