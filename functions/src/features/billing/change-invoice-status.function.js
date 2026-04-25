"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { isGrantedFromAuthToken } = require("../../lib/permissions/grants");
const { validateInvoiceCanBeIssued } = require("../../lib/invoice/invoice-issue-validate");
const { assertCompanyMember } = require("../../lib/tenant-auth");

/**
 * Cambia el estado de una factura con permiso granular `invoice:change_status_<nextStatus>`.
 *
 * @param {{ companyId: string, invoiceId: string, nextStatus: string }} data
 */
exports.changeInvoiceStatus = onCall(async ({ data, auth }) => {
  if (!auth?.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
  }

  const companyId = String(data?.companyId ?? "").trim();
  const invoiceId = String(data?.invoiceId ?? "").trim();
  const nextStatus = String(data?.nextStatus ?? "").trim();
  if (!companyId || !invoiceId || !nextStatus) {
    throw new HttpsError("invalid-argument", "companyId, invoiceId y nextStatus son obligatorios.");
  }

  if (!/^[a-z0-9_]+$/.test(nextStatus)) {
    throw new HttpsError("invalid-argument", "Estado invalido.");
  }

  await assertCompanyMember(db, companyId, auth.uid);

  const action = `change_status_${nextStatus}`;
  if (!isGrantedFromAuthToken(auth, "invoice", action)) {
    throw new HttpsError("permission-denied", `No tiene permiso: invoice:${action}`);
  }

  const snap = await db.collection("invoices").doc(invoiceId).get();
  if (!snap.exists) {
    throw new HttpsError("not-found", "Factura no encontrada.");
  }

  const inv = snap.data() || {};
  if (String(inv.companyId ?? "").trim() !== companyId) {
    throw new HttpsError("permission-denied", "La factura no pertenece a la empresa activa.");
  }

  const companySnap = await db.collection("companies").doc(companyId).get();
  const accountId = String(companySnap.data()?.accountId ?? companyId).trim() || companyId;
  const invAccountId = String(inv.accountId ?? "").trim();
  if (invAccountId && invAccountId !== accountId) {
    throw new HttpsError("permission-denied", "La factura no pertenece a la cuenta activa.");
  }

  if (nextStatus === "issued") {
    const [itemsSnap, creditsSnap] = await Promise.all([
      snap.ref.collection("invoiceItems").get(),
      snap.ref.collection("invoiceCredits").get(),
    ]);
    const items = itemsSnap.docs.map((d) => d.data());
    const credits = creditsSnap.docs.map((d) => d.data());
    const validation = validateInvoiceCanBeIssued({ ...inv, id: invoiceId }, items, credits);
    if (!validation.ok) {
      throw new HttpsError("failed-precondition", validation.message);
    }
  }

  await snap.ref.update({
    status: nextStatus,
    statusChangedAt: FieldValue.serverTimestamp(),
    statusChangedBy: auth.uid,
  });

  return { ok: true };
});
