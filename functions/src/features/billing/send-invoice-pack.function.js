"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { createJob } = require("../../lib/sunat/sunat-job.service");
const { assertActiveSunatConfigForCompany } = require("../../lib/sunat/sunat-config-assert");

/**
 * Callable Firebase Function v2 — enqueues a batch of invoices for async SUNAT sendPack processing.
 * Creates a single sunat-jobs document for the pack and returns immediately.
 *
 * @param {{ ids: string[] }} data
 * @returns {Promise<{ jobId: string }>}
 */
exports.sendInvoicesPack = onCall(async ({ data }) => {
  const { ids } = data;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Se requiere al menos un ID de factura.");
  }

  // Read the first invoice to get companyId
  const invoiceSnap = await db.collection("invoices").doc(ids[0]).get();

  if (!invoiceSnap.exists) {
    throw new Error(`Factura no encontrada: ${ids[0]}`);
  }

  const { companyId } = invoiceSnap.data();

  await assertActiveSunatConfigForCompany(db, companyId);

  // Create a single pack job
  const jobId = await createJob(db, {
    jobType: "sendPack",
    invoiceIds: ids,
    companyId,
    status: "queued",
  });

  return { jobId };
});
