const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { computeTripCostFromAssignment } = require("../../lib/trip-cost.service");
const { resolveDraftCodeWithGenerator } = require("../../lib/sequence-code.service");
const {
  PROCESS,
  buildSyncBlock,
  isAssignmentCostSyncDoc,
  isAssignmentChargeSyncDoc,
  canonicalAssignmentCostDocRef,
  canonicalAssignmentChargeDocRef,
} = require("../../lib/sync-document-ids.lib");

const TRIP_COST_SEQUENCE_ENTITY = "trip-cost";
const TRIP_CHARGE_SEQUENCE_ENTITY = "trip-charge";
const SYSTEM_AUDIT = "system:trip-assignment-sync";

async function resolveTripCostCode(assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const ref = canonicalAssignmentCostDocRef(db, aid);
  const snap = await ref.get();
  if (snap.exists) {
    const c = String((snap.data() || {}).code ?? "").trim();
    if (c) return c;
  }
  try {
    return String(await resolveDraftCodeWithGenerator(db, "", TRIP_COST_SEQUENCE_ENTITY)).trim();
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: no se pudo generar código trip-cost", {
      assignmentId,
      message: err instanceof Error ? err.message : String(err),
    });
    return assignmentId;
  }
}

async function resolveTripChargeCode(assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const ref = canonicalAssignmentChargeDocRef(db, aid);
  const snap = await ref.get();
  if (snap.exists) {
    const c = String((snap.data() || {}).code ?? "").trim();
    if (c) return c;
  }
  try {
    return String(await resolveDraftCodeWithGenerator(db, "", TRIP_CHARGE_SEQUENCE_ENTITY)).trim();
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: no se pudo generar código trip-charge", {
      assignmentId,
      message: err instanceof Error ? err.message : String(err),
    });
    return assignmentId;
  }
}

async function readChargeTypeKind(chargeTypeId) {
  const id = String(chargeTypeId ?? "").trim();
  if (!id) return "";
  const snap = await db.collection("charge-types").doc(id).get();
  if (!snap.exists) return "";
  const data = snap.data() || {};
  const kind = String(data.type ?? "").trim().toLowerCase();
  if (kind === "cost" || kind === "charge") return kind;
  return "";
}

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {string} assignmentId
 * @returns {Promise<
 *   | { mode: "update"; chargeRef: FirebaseFirestore.DocumentReference; existing: FirebaseFirestore.DocumentData }
 *   | { mode: "create"; chargeRef: FirebaseFirestore.DocumentReference }
 *   | { mode: "blocked"; reason: string }
 * >}
 */
async function readAssignmentCostSyncPlan(tx, assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const canonicalRef = canonicalAssignmentCostDocRef(db, aid);

  const canSnap = await tx.get(canonicalRef);
  if (canSnap.exists && isAssignmentCostSyncDoc(canSnap.data(), aid)) {
    return { mode: "update", chargeRef: canonicalRef, existing: canSnap.data() || {} };
  }

  if (canSnap.exists) {
    return { mode: "blocked", reason: "canonical_trip_cost_id_occupied" };
  }

  return { mode: "create", chargeRef: canonicalRef };
}

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {string} assignmentId
 * @returns {Promise<
 *   | { mode: "update"; chargeRef: FirebaseFirestore.DocumentReference; existing: FirebaseFirestore.DocumentData }
 *   | { mode: "create"; chargeRef: FirebaseFirestore.DocumentReference }
 *   | { mode: "blocked"; reason: string }
 * >}
 */
async function readAssignmentChargeSyncPlan(tx, assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const canonicalRef = canonicalAssignmentChargeDocRef(db, aid);

  const canSnap = await tx.get(canonicalRef);
  if (canSnap.exists && isAssignmentChargeSyncDoc(canSnap.data(), aid)) {
    return { mode: "update", chargeRef: canonicalRef, existing: canSnap.data() || {} };
  }
  if (canSnap.exists) {
    return { mode: "blocked", reason: "canonical_trip_charge_id_occupied" };
  }
  return { mode: "create", chargeRef: canonicalRef };
}

async function deleteSyncedTripCost(assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const canonicalRef = canonicalAssignmentCostDocRef(db, aid);

  try {
    await db.runTransaction(async (tx) => {
      const canSnap = await tx.get(canonicalRef);

      if (canSnap.exists && isAssignmentCostSyncDoc(canSnap.data(), aid)) {
        tx.delete(canonicalRef);
      }
    });
    logger.info("onTripAssignmentsWrite: trip-cost eliminado (asignación borrada)", { assignmentId: aid });
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: error al eliminar trip-cost", { assignmentId: aid, err: String(err) });
  }
}

async function deleteSyncedTripCharge(assignmentId) {
  const aid = String(assignmentId ?? "").trim();
  const canonicalRef = canonicalAssignmentChargeDocRef(db, aid);

  try {
    await db.runTransaction(async (tx) => {
      const canSnap = await tx.get(canonicalRef);
      if (canSnap.exists && isAssignmentChargeSyncDoc(canSnap.data(), aid)) {
        tx.delete(canonicalRef);
      }
    });
    logger.info("onTripAssignmentsWrite: trip-charge eliminado (asignación borrada)", { assignmentId: aid });
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: error al eliminar trip-charge", { assignmentId: aid, err: String(err) });
  }
}

/**
 * Elimina el costo sincronizado cuando se borra la asignación.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleAssignmentDeletedCost(event) {
  const assignmentId = String(event.params.assignmentId ?? "").trim();
  if (!assignmentId) return;
  await deleteSyncedTripCost(assignmentId);
}

async function handleAssignmentDeletedCharge(event) {
  const assignmentId = String(event.params.assignmentId ?? "").trim();
  if (!assignmentId) return;
  await deleteSyncedTripCharge(assignmentId);
}

/**
 * Crea/actualiza `trip-costs` desde la asignación.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleAssignmentUpsertCost(event) {
  const assignmentId = String(event.params.assignmentId ?? "").trim();
  if (!assignmentId) {
    logger.warn("onTripAssignmentsWrite: omitido, assignmentId vacío");
    return;
  }
  const afterSnap = event.data.after;
  if (!afterSnap.exists) return;

  const data = afterSnap.data() || {};
  const chargeTypeKind = await readChargeTypeKind(data.chargeTypeId);
  if (chargeTypeKind !== "cost") {
    await deleteSyncedTripCost(assignmentId);
    return;
  }
  const tripId = String(data.tripId ?? "").trim();
  const assignmentDisplayName = String(data.displayName ?? "").trim();
  const mappedEntity = String(data.entityType ?? "").trim().toLowerCase() === "resource" ? "resource" : "employee";
  const mappedEntityId = String(data.entityId ?? "").trim();

  logger.info("onTripAssignmentsWrite: dispatch", {
    assignmentId,
    tripId: tripId || "(vacío)",
    entityType: String(data.entityType ?? ""),
  });

  if (!tripId) {
    logger.warn("onTripAssignmentsWrite: omitido, sin tripId en el documento", { assignmentId });
    return;
  }

  const tripCostCode = await resolveTripCostCode(assignmentId);

  let computed;
  try {
    computed = await computeTripCostFromAssignment(data, db, { allowPartial: true });
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: cálculo con valores por defecto", {
      assignmentId,
      code: err.code,
      message: err instanceof Error ? err.message : String(err),
    });
    computed = {
      amount: 0,
      currency: "PEN",
      costType: "employee_payment",
      resourceCostId: "",
    };
  }

  const syncBlock = buildSyncBlock(PROCESS.TRIP_ASSIGNMENT_COST, "assignment", assignmentId);

  const baseMeta = {
    tripId,
    code: tripCostCode,
    displayName: assignmentDisplayName,
    chargeTypeId: String(data.chargeTypeId ?? "").trim(),
    chargeType: String(data.chargeType ?? "").trim(),
    updateAt: FieldValue.serverTimestamp(),
    updateBy: SYSTEM_AUDIT,
  };

  try {
    await db.runTransaction(async (tx) => {
      const plan = await readAssignmentCostSyncPlan(tx, assignmentId);

      if (plan.mode === "blocked") {
        logger.warn("onTripAssignmentsWrite: no se escribe trip-cost (ID canónico ocupado)", {
          assignmentId,
          reason: plan.reason,
        });
        return;
      }

      if (plan.mode === "update") {
        const existing = plan.existing || {};
        const source = String(existing.source ?? "salary_rule");

        if (source === "manual") {
          tx.update(plan.chargeRef, {
            tripId,
            displayName: "",
            updateAt: FieldValue.serverTimestamp(),
            updateBy: SYSTEM_AUDIT,
            sync: syncBlock,
          });
          return;
        }

        const status = String(existing.status ?? "open");
        const patch = {
          ...baseMeta,
          entity: mappedEntity,
          entityId: mappedEntityId,
          source: "salary_rule",
          sync: syncBlock,
        };

        if (status === "open") {
          patch.amount = computed.amount;
          patch.currency = computed.currency;
        }

        tx.update(plan.chargeRef, patch);
        return;
      }

      tx.set(plan.chargeRef, {
        ...baseMeta,
        entity: mappedEntity,
        entityId: mappedEntityId,
        source: "salary_rule",
        amount: computed.amount,
        currency: computed.currency,
        status: "open",
        settlementId: null,
        createAt: FieldValue.serverTimestamp(),
        createBy: SYSTEM_AUDIT,
        sync: syncBlock,
      });
    });

    logger.info("onTripAssignmentsWrite: trip-cost sincronizado", { assignmentId });
  } catch (err) {
    logger.error("onTripAssignmentsWrite: error en transacción", {
      assignmentId,
      err: String(err),
    });
  }
}

/**
 * Crea/actualiza `trip-charges` desde la asignación cuando el charge-type es de tipo charge.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleAssignmentUpsertCharge(event) {
  const assignmentId = String(event.params.assignmentId ?? "").trim();
  if (!assignmentId) {
    logger.warn("onTripAssignmentsWrite: omitido charge, assignmentId vacío");
    return;
  }
  const afterSnap = event.data.after;
  if (!afterSnap.exists) return;

  const data = afterSnap.data() || {};
  const chargeTypeKind = await readChargeTypeKind(data.chargeTypeId);
  if (chargeTypeKind !== "charge") {
    await deleteSyncedTripCharge(assignmentId);
    return;
  }

  const tripId = String(data.tripId ?? "").trim();
  if (!tripId) {
    logger.warn("onTripAssignmentsWrite: omitido charge, sin tripId", { assignmentId });
    return;
  }

  const chargeTypeId = String(data.chargeTypeId ?? "").trim();
  const chargeType = String(data.chargeType ?? "").trim();
  const entityType = String(data.entityType ?? "").trim().toLowerCase() === "resource" ? "resource" : "employee";
  const entityId = String(data.entityId ?? "").trim();
  const displayName = String(data.displayName ?? "").trim();

  let computed;
  try {
    computed = await computeTripCostFromAssignment(data, db, { allowPartial: true });
  } catch (err) {
    logger.warn("onTripAssignmentsWrite: cálculo de charge con valores por defecto", {
      assignmentId,
      message: err instanceof Error ? err.message : String(err),
    });
    computed = { amount: 0, currency: "PEN" };
  }

  const tripChargeCode = await resolveTripChargeCode(assignmentId);
  const syncBlock = buildSyncBlock(PROCESS.TRIP_ASSIGNMENT_CHARGE, "assignment", assignmentId);

  const baseMeta = {
    tripId,
    code: tripChargeCode,
    name: displayName || chargeType || assignmentId,
    chargeTypeId,
    chargeType: chargeType || chargeTypeId,
    entityType,
    entityId,
    source: "salary_rule",
    updateAt: FieldValue.serverTimestamp(),
    updateBy: SYSTEM_AUDIT,
    sync: syncBlock,
  };

  try {
    await db.runTransaction(async (tx) => {
      const plan = await readAssignmentChargeSyncPlan(tx, assignmentId);
      if (plan.mode === "blocked") {
        logger.warn("onTripAssignmentsWrite: no se escribe trip-charge (ID canónico ocupado)", {
          assignmentId,
          reason: plan.reason,
        });
        return;
      }

      if (plan.mode === "update") {
        const existing = plan.existing || {};
        const status = String(existing.status ?? "open");
        const patch = { ...baseMeta };
        if (status === "open") {
          patch.amount = computed.amount;
          patch.currency = computed.currency;
        }
        tx.update(plan.chargeRef, patch);
        return;
      }

      tx.set(plan.chargeRef, {
        ...baseMeta,
        amount: computed.amount,
        currency: computed.currency,
        status: "open",
        settlementId: null,
        createAt: FieldValue.serverTimestamp(),
        createBy: SYSTEM_AUDIT,
      });
    });
    logger.info("onTripAssignmentsWrite: trip-charge sincronizado", { assignmentId });
  } catch (err) {
    logger.error("onTripAssignmentsWrite: error sync trip-charge", {
      assignmentId,
      err: String(err),
    });
  }
}

/**
 * Despachador único para `trip-assignments/{assignmentId}`.
 */
const onTripAssignmentsWrite = onDocumentWritten(
  {
    document: "trip-assignments/{assignmentId}",
    timeoutSeconds: 120,
  },
  async (event) => {
    if (!event.data.after.exists) {
      await Promise.all([handleAssignmentDeletedCost(event), handleAssignmentDeletedCharge(event)]);
      return;
    }
    await Promise.all([
      handleAssignmentUpsertCost(event),
      handleAssignmentUpsertCharge(event),
      // Otros syncs independientes del mismo evento:
      // handleAssignmentFoo(event),
    ]);
  }
);

module.exports = {
  onTripAssignmentsWrite,
};
