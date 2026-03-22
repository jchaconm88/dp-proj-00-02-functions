const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { buildSettlementItemsPayload, replaceSettlementItems } = require("../../lib/settlement-items.lib");

/**
 * Recalcula ítems de una liquidación según categoría (Cliente → tripCharges, Recurso → tripCosts)
 * y actualiza totales (grossAmount = suma de amount; settled y pending en 0).
 *
 * @param {{ settlementId: string }} request.data
 */
const syncSettlementItems = onCall(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const settlementId = String(request.data?.settlementId ?? "").trim();
    if (!settlementId) {
      throw new HttpsError("invalid-argument", "settlementId es obligatorio.");
    }

    const createBy = request.auth.token?.email ?? request.auth.uid ?? null;

    const settlementRef = db.collection("settlements").doc(settlementId);
    const settlementSnap = await settlementRef.get();
    if (!settlementSnap.exists) {
      throw new HttpsError("not-found", "Liquidación no encontrada.");
    }

    const s = settlementSnap.data() || {};
    const category = String(s.category ?? "").trim();
    if (category !== "customer" && category !== "resource") {
      throw new HttpsError(
        "failed-precondition",
        "Solo se sincronizan liquidaciones de categoría Cliente o Recurso."
      );
    }

    const entity = s.entity && typeof s.entity === "object" ? s.entity : {};
    const entityId = String(entity.id ?? "").trim();
    if (!entityId) {
      throw new HttpsError("failed-precondition", "La liquidación no tiene entidad (id).");
    }

    const period = s.period && typeof s.period === "object" ? s.period : {};
    const periodStart = String(period.start ?? "").trim();
    const periodEnd = String(period.end ?? "").trim();
    if (!periodStart || !periodEnd) {
      throw new HttpsError("failed-precondition", "Defina periodo inicio y fin en la liquidación.");
    }

    const totals = s.totals && typeof s.totals === "object" ? s.totals : {};
    const settlementCurrency = String(totals.currency ?? "PEN").trim() || "PEN";

    let built;
    try {
      built = await buildSettlementItemsPayload(db, {
        category,
        entityId,
        periodStart,
        periodEnd,
        settlementCurrency,
      });
    } catch (e) {
      if (e && e.code === "MISSING_ENTITY_ID") {
        throw new HttpsError("failed-precondition", "Falta id de entidad.");
      }
      if (e && e.code === "UNSUPPORTED_CATEGORY") {
        throw new HttpsError("failed-precondition", "Categoría no soportada para sincronización.");
      }
      throw new HttpsError("internal", e instanceof Error ? e.message : "Error al armar ítems.");
    }

    const { items, grossAmount } = built;

    const itemPayloads = items.map(({ movement, trip, concept, amount, settledAmount, pendingAmount, currency }) => ({
      movement,
      trip,
      concept,
      amount,
      settledAmount,
      pendingAmount,
      currency,
    }));

    await replaceSettlementItems(db, settlementId, itemPayloads, createBy);

    await settlementRef.update({
      totals: {
        grossAmount,
        settledAmount: 0,
        pendingAmount: 0,
        currency: settlementCurrency,
      },
      updateAt: FieldValue.serverTimestamp(),
      updateBy: createBy,
      metadata: FieldValue.delete(),
    });

    return {
      ok: true,
      itemCount: itemPayloads.length,
      grossAmount,
      currency: settlementCurrency,
    };
  }
);

module.exports = {
  syncSettlementItems,
};
