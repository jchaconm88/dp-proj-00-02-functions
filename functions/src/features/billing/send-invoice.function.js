"use strict";

const { onCall } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { createJob } = require("../../lib/sunat/sunat-job.service");
const { assertActiveSunatConfigForCompany } = require("../../lib/sunat/sunat-config-assert");

/**
 * Callable Firebase Function v2 — enqueues one or more invoices for async SUNAT processing.
 * Creates a sunat-jobs document per invoice and returns immediately without waiting for SUNAT.
 *
 * @param {{ ids: string[] }} data
 * @returns {Promise<Array<{ invoiceId: string, jobId: string }>>}
 */
exports.sendInvoicesToSunat = onCall(async ({ data }) => {
  const { ids } = data;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("Se requiere al menos un ID de factura.");
  }

  const results = [];
  const companiesChecked = new Set();

  for (const invoiceId of ids) {
    // 1. Read invoice to get companyId
    const invoiceSnap = await db.collection("invoices").doc(invoiceId).get();

    if (!invoiceSnap.exists) {
      throw new Error(`Factura no encontrada: ${invoiceId}`);
    }

    const { companyId } = invoiceSnap.data();

    if (!companiesChecked.has(companyId)) {
      await assertActiveSunatConfigForCompany(db, companyId);
      companiesChecked.add(companyId);
    }

    // 2. Create job in sunat-jobs
    const jobId = await createJob(db, {
      jobType: "sendBill",
      invoiceId,
      companyId,
      status: "queued",
    });

    // 3. Update invoice status to "queued"
    await db.collection("invoices").doc(invoiceId).update({ status: "queued" });

    results.push({ invoiceId, jobId });
  }

  return results;
});
