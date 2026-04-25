"use strict";

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const { db } = require("../../lib/firebase");
const { validateInvoiceCanBeIssued } = require("../../lib/invoice/invoice-issue-validate");
const { renderInvoicePrintedPdfBuffer } = require("../../lib/invoice/invoice-print-pdf.service");
const { uploadInvoiceFileToStorage } = require("../../lib/invoice/invoice-storage.util");

exports.onInvoicesIssuedPrintPdf = onDocumentUpdated(
  {
    document: "invoices/{invoiceId}",
    memory: "1GiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const beforeSnap = event.data.before;
    const afterSnap = event.data.after;
    if (!afterSnap?.exists) return;

    const before = beforeSnap.exists ? beforeSnap.data() : null;
    const after = afterSnap.data() || {};
    const invoiceRef = afterSnap.ref;
    const invoiceId = event.params.invoiceId;

    const prevStatus = String(before?.status ?? "");
    const nextStatus = String(after.status ?? "");

    if (nextStatus !== "issued" || prevStatus === "issued") {
      return;
    }

    const [itemsSnap, creditsSnap] = await Promise.all([
      invoiceRef.collection("invoiceItems").get(),
      invoiceRef.collection("invoiceCredits").get(),
    ]);
    const items = itemsSnap.docs.map((d) => d.data());
    const credits = creditsSnap.docs.map((d) => d.data());

    const v = validateInvoiceCanBeIssued({ ...after, id: invoiceId }, items, credits);
    if (!v.ok) {
      logger.warn("onInvoicesIssuedPrintPdf: validación, revertir estado", { invoiceId, message: v.message });
      await invoiceRef.update({
        status: prevStatus || "draft",
        issueBlockReason: v.message,
        issueBlockedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    try {
      const pdfBuffer = await renderInvoicePrintedPdfBuffer({ ...after, id: invoiceId }, items, credits);
      const companyId = String(after.companyId ?? "").trim();
      const docNo = String(after.documentNo ?? "FACTURA").replace(/[^\w.-]+/g, "_");
      const fileName = `REP-${docNo}.pdf`;
      const url = await uploadInvoiceFileToStorage(companyId, fileName, pdfBuffer, "application/pdf");
      await invoiceRef.update({
        pdfUrl: url,
        issueBlockReason: FieldValue.delete(),
        issueBlockedAt: FieldValue.delete(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("onInvoicesIssuedPrintPdf: error al generar PDF", { invoiceId, err: msg });
      await invoiceRef.update({
        status: prevStatus || "draft",
        issueBlockReason: `Error al generar PDF: ${msg}`,
        issueBlockedAt: FieldValue.serverTimestamp(),
      });
    }
  }
);
