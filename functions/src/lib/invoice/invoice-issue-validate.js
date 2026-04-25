"use strict";

/**
 * Validaciones de negocio para permitir que una factura pase a estado `issued`.
 *
 * @param {object} invoice - Documento `invoices/{id}`
 * @param {object[]} items  - Docs de `invoiceItems`
 * @param {object[]} credits - Docs de `invoiceCredits`
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function validateInvoiceCanBeIssued(invoice, items, credits) {
  const itemList = Array.isArray(items) ? items : [];
  if (itemList.length === 0) {
    return { ok: false, message: "La factura debe tener al menos un ítem para poder emitirla." };
  }

  const payTerm = String(invoice?.payTerm ?? "").trim();
  if (payTerm === "credit") {
    const creditList = Array.isArray(credits) ? credits : [];
    if (creditList.length === 0) {
      return { ok: false, message: "Condición de pago Crédito: debe registrar al menos una cuota." };
    }

    const totalAmount = Number(invoice?.totalAmount) || 0;
    let sumCredits = 0;
    const seenCorr = new Set();

    for (const c of creditList) {
      const correlative = Number(c.correlative) || 0;
      const dueDate = String(c.dueDate ?? "").trim();
      const val = Number(c.creditVal) || 0;
      if (correlative <= 0) {
        return { ok: false, message: "Cada cuota debe tener correlativo mayor a 0." };
      }
      if (seenCorr.has(correlative)) {
        return { ok: false, message: `Correlativo de cuota duplicado: ${correlative}.` };
      }
      seenCorr.add(correlative);
      if (!dueDate) {
        return { ok: false, message: "Cada cuota debe tener fecha de vencimiento." };
      }
      if (val <= 0) {
        return { ok: false, message: "Cada cuota debe tener monto mayor a 0." };
      }
      sumCredits += val;
    }

    if (sumCredits > totalAmount + 0.01) {
      return {
        ok: false,
        message: `La suma de cuotas (${sumCredits.toFixed(2)}) no puede superar el total de la factura (${totalAmount.toFixed(2)}).`,
      };
    }
  }

  return { ok: true };
}

module.exports = { validateInvoiceCanBeIssued };
