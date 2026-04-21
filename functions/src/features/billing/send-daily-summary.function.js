"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { createJob } = require("../../lib/sunat/sunat-job.service");
const { assertActiveSunatConfigForCompany } = require("../../lib/sunat/sunat-config-assert");

/**
 * Callable Firebase Function v2 — enqueues a daily summary for async SUNAT sendSummary processing.
 * Creates a single sunat-jobs document for the summary and returns immediately.
 *
 * @param {{ date: string, invoiceIds: string[] }} data
 * @returns {Promise<{ jobId: string }>}
 */
exports.sendDailySummary = onCall(async ({ data }) => {
  const { date, invoiceIds } = data;

  if (!date) {
    throw new Error("Se requiere la fecha del resumen.");
  }

  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new Error("Se requiere al menos un ID de factura.");
  }

  // Read the first invoice to get companyId
  const invoiceSnap = await db.collection("invoices").doc(invoiceIds[0]).get();

  if (!invoiceSnap.exists) {
    throw new Error(`Factura no encontrada: ${invoiceIds[0]}`);
  }

  const { companyId } = invoiceSnap.data();

  await assertActiveSunatConfigForCompany(db, companyId);

  // Create a single summary job
  const jobId = await createJob(db, {
    jobType: "sendSummary",
    invoiceIds,
    summaryDate: date,
    companyId,
    status: "queued",
  });

  return { jobId };
});
