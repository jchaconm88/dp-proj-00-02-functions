const { onDocumentCreated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { recalculateSettlementTotalsFromItems } = require("../../lib/settlement-items.lib");

/**
 * @param {FirebaseFirestore.DocumentData | undefined} data
 * @returns {{ type: string; movementId: string; collection: string } | null}
 */
function resolveMovementTarget(data) {
  if (!data || typeof data !== "object") return null;
  const movement = data.movement && typeof data.movement === "object" ? data.movement : {};
  const type = String(movement.type ?? "").trim();
  const movementId = String(movement.id ?? "").trim();
  if (!movementId) return null;
  if (type !== "tripCharge" && type !== "tripCost") return null;
  const collection = type === "tripCharge" ? "tripCharges" : "tripCosts";
  return { type, movementId, collection };
}

/**
 * Al crear un ítem en `settlements/{settlementId}/items/{itemId}`, si el movimiento
 * es `tripCharge` o `tripCost`, actualiza el documento correspondiente con
 * `settlementId` y `settlement` = código de la liquidación (string).
 */
const syncMovementFromSettlementItem = onDocumentCreated(
  {
    document: "settlements/{settlementId}/items/{itemId}",
    timeoutSeconds: 60,
  },
  async (event) => {
    const settlementId = String(event.params.settlementId ?? "").trim();
    const itemId = String(event.params.itemId ?? "").trim();
    const snap = event.data;
    if (!snap?.exists) return;

    const resolved = resolveMovementTarget(snap.data());
    if (!resolved) {
      if (snap.data()?.movement) {
        logger.debug("syncMovementFromSettlementItem: sin movement.id o tipo no soportado", {
          settlementId,
          itemId,
        });
      }
      return;
    }
    const { movementId, collection } = resolved;

    const settlementSnap = await db.collection("settlements").doc(settlementId).get();
    if (!settlementSnap.exists) {
      logger.warn("syncMovementFromSettlementItem: liquidación no existe", { settlementId, itemId });
      return;
    }

    const s = settlementSnap.data() || {};
    const code = String(s.code ?? "").trim() || settlementId;
    const payload = {
      settlementId,
      settlement: code,
    };

    const ref = db.collection(collection).doc(movementId);
    const targetSnap = await ref.get();

    if (!targetSnap.exists) {
      logger.warn("syncMovementFromSettlementItem: documento de movimiento no encontrado", {
        collection,
        movementId,
        settlementId,
        itemId,
      });
      return;
    }

    await ref.update(payload);
    logger.info("syncMovementFromSettlementItem: enlace actualizado", {
      collection,
      movementId,
      settlementId,
    });
  }
);

/**
 * Al eliminar un ítem, blanquea `settlementId` y `settlement` en el tripCharge/tripCost
 * solo si siguen apuntando a esta liquidación (evita pisar otro enlace).
 */
const clearMovementFromDeletedSettlementItem = onDocumentDeleted(
  {
    document: "settlements/{settlementId}/items/{itemId}",
    timeoutSeconds: 60,
  },
  async (event) => {
    const settlementId = String(event.params.settlementId ?? "").trim();
    const itemId = String(event.params.itemId ?? "").trim();
    const snap = event.data;
    if (!snap || typeof snap.data !== "function") return;

    try {
      const resolved = resolveMovementTarget(snap.data());
      if (resolved) {
        const { movementId, collection } = resolved;
        const ref = db.collection(collection).doc(movementId);
        const targetSnap = await ref.get();
        if (targetSnap.exists) {
          const cur = targetSnap.data() || {};
          const curSid = String(cur.settlementId ?? "").trim();
          if (curSid !== settlementId) {
            logger.debug("clearMovementFromDeletedSettlementItem: no se limpia (otra liquidación)", {
              collection,
              movementId,
              itemSettlementId: settlementId,
              docSettlementId: curSid,
              itemId,
            });
          } else {
            await ref.update({
              settlementId: null,
              settlement: FieldValue.delete(),
            });
            logger.info("clearMovementFromDeletedSettlementItem: enlace limpiado", {
              collection,
              movementId,
              settlementId,
            });
          }
        }
      }
    } catch (err) {
      logger.error("clearMovementFromDeletedSettlementItem: error al limpiar movimiento", {
        settlementId,
        itemId,
        err: String(err),
      });
    }

    try {
      const totals = await recalculateSettlementTotalsFromItems(db, settlementId);
      if (totals) {
        logger.info("clearMovementFromDeletedSettlementItem: totales recalculados", {
          settlementId,
          ...totals,
        });
      }
    } catch (err) {
      logger.error("clearMovementFromDeletedSettlementItem: error al recalcular totales", {
        settlementId,
        itemId,
        err: String(err),
      });
    }
  }
);

module.exports = {
  syncMovementFromSettlementItem,
  clearMovementFromDeletedSettlementItem,
};
