/**
 * Lógica de sync ítems de liquidación ↔ trip-charges / trip-costs.
 * El trigger Firestore vive en `settlement-item-sync.function.js`.
 */

const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { recalculateSettlementTotalsFromItems } = require("./settlement-items.lib");

const LOG = "onSettlementItemsWrite";

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
  const collection = type === "tripCharge" ? "trip-charges" : "trip-costs";
  return { type, movementId, collection };
}

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleSettlementItemCreatedLinkToMovement(firestore, event) {
  const settlementId = String(event.params.settlementId ?? "").trim();
  const itemId = String(event.params.itemId ?? "").trim();
  const afterSnap = event.data.after;
  if (!afterSnap.exists) return;

  const resolved = resolveMovementTarget(afterSnap.data());
  if (!resolved) {
    if (afterSnap.data()?.movement) {
      logger.debug(`${LOG}: create — sin movement.id o tipo no soportado`, {
        settlementId,
        itemId,
      });
    }
    return;
  }
  const { movementId, collection } = resolved;

  const settlementSnap = await firestore.collection("settlements").doc(settlementId).get();
  if (!settlementSnap.exists) {
    logger.warn(`${LOG}: create — liquidación no existe`, { settlementId, itemId });
    return;
  }

  const s = settlementSnap.data() || {};
  const code = String(s.code ?? "").trim() || settlementId;
  const payload = {
    settlementId,
    settlement: code,
  };

  const ref = firestore.collection(collection).doc(movementId);
  const targetSnap = await ref.get();

  if (!targetSnap.exists) {
    logger.warn(`${LOG}: create — documento de movimiento no encontrado`, {
      collection,
      movementId,
      settlementId,
      itemId,
    });
    return;
  }

  await ref.update(payload);
  logger.info(`${LOG}: create — enlace actualizado`, {
    collection,
    movementId,
    settlementId,
  });
}

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleSettlementItemDeletedUnlinkMovement(firestore, event) {
  const settlementId = String(event.params.settlementId ?? "").trim();
  const itemId = String(event.params.itemId ?? "").trim();
  const beforeSnap = event.data.before;
  if (!beforeSnap.exists) return;

  try {
    const resolved = resolveMovementTarget(beforeSnap.data());
    if (!resolved) return;
    const { movementId, collection } = resolved;
    const ref = firestore.collection(collection).doc(movementId);
    const targetSnap = await ref.get();
    if (!targetSnap.exists) return;
    const cur = targetSnap.data() || {};
    const curSid = String(cur.settlementId ?? "").trim();
    if (curSid !== settlementId) {
      logger.debug(`${LOG}: delete — no se limpia (otra liquidación)`, {
        collection,
        movementId,
        itemSettlementId: settlementId,
        docSettlementId: curSid,
        itemId,
      });
      return;
    }
    await ref.update({
      settlementId: null,
      settlement: FieldValue.delete(),
    });
    logger.info(`${LOG}: delete — enlace limpiado`, {
      collection,
      movementId,
      settlementId,
    });
  } catch (err) {
    logger.error(`${LOG}: delete — error al limpiar movimiento`, {
      settlementId,
      itemId,
      err: String(err),
    });
  }
}

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleSettlementItemDeletedRecalcTotals(firestore, event) {
  const settlementId = String(event.params.settlementId ?? "").trim();
  const itemId = String(event.params.itemId ?? "").trim();

  try {
    const totals = await recalculateSettlementTotalsFromItems(firestore, settlementId);
    if (totals) {
      logger.info(`${LOG}: delete — totales recalculados`, {
        settlementId,
        ...totals,
      });
    }
  } catch (err) {
    logger.error(`${LOG}: delete — error al recalcular totales`, {
      settlementId,
      itemId,
      err: String(err),
    });
  }
}

/**
 * Despacho interno (create / delete / update) para el trigger `onSettlementItemsWrite`.
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function runSettlementItemsWriteDispatch(firestore, event) {
  const beforeSnap = event.data.before;
  const afterSnap = event.data.after;

  if (!beforeSnap.exists && afterSnap.exists) {
    await Promise.all([handleSettlementItemCreatedLinkToMovement(firestore, event)]);
    return;
  }

  if (beforeSnap.exists && !afterSnap.exists) {
    await Promise.all([
      handleSettlementItemDeletedUnlinkMovement(firestore, event),
      handleSettlementItemDeletedRecalcTotals(firestore, event),
    ]);
    return;
  }
}

module.exports = {
  resolveMovementTarget,
  runSettlementItemsWriteDispatch,
};
