const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { resolveDraftCodeWithGenerator } = require("../../lib/sequence-code.service");
const { computeFreightPricingFromContract } = require("../../lib/trip-charge-freight-pricing.lib");
const {
  PROCESS,
  buildSyncBlock,
  isFreightSyncChargeDoc,
  canonicalTripFreightChargeDocRef,
} = require("../../lib/sync-document-ids.lib");

const TRIP_CHARGE_SEQUENCE_ENTITY = "trip-charge";
const TRIP_CHARGES_COLLECTION = "trip-charges";
const TRIP_COSTS_COLLECTION = "trip-costs";
const TRIP_ASSIGNMENTS_COLLECTION = "trip-assignments";
const TRIPS_COLLECTION = "trips";
const TRIP_STOPS_SUBCOLLECTION = "tripStops";

/** Límite seguro bajo el máximo de 500 operaciones por batch de Firestore. */
const DELETE_BATCH_MAX = 450;

const SYSTEM_AUDIT = "system:trip-sync";

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {FirebaseFirestore.DocumentReference[]} refs
 */
async function commitDeleteRefsInBatches(firestore, refs) {
  for (let i = 0; i < refs.length; i += DELETE_BATCH_MAX) {
    const batch = firestore.batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_MAX)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
}

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {string} collectionName
 * @param {string} tripId
 * @returns {Promise<number>}
 */
async function deleteByTripId(firestore, collectionName, tripId) {
  const tid = String(tripId ?? "").trim();
  if (!tid) return 0;
  const snap = await firestore.collection(collectionName).where("tripId", "==", tid).get();
  if (snap.empty) return 0;
  const n = snap.size;
  const refs = snap.docs.map((d) => d.ref);
  await commitDeleteRefsInBatches(firestore, refs);
  return n;
}

/**
 * @param {FirebaseFirestore.Firestore} firestore
 * @param {string} tripId
 * @returns {Promise<number>}
 */
async function deleteTripStopsForTrip(firestore, tripId) {
  const tid = String(tripId ?? "").trim();
  if (!tid) return 0;
  const col = firestore.collection(TRIPS_COLLECTION).doc(tid).collection(TRIP_STOPS_SUBCOLLECTION);
  const snap = await col.get();
  if (snap.empty) return 0;
  const n = snap.size;
  await commitDeleteRefsInBatches(
    firestore,
    snap.docs.map((d) => d.ref)
  );
  return n;
}

/**
 * Borra cargos, costos, asignaciones y paradas ligadas al viaje (además del flete canónico).
 * Secuencial por dependencias con otros triggers (`trip-assignments`).
 */
async function cascadeDeleteTripRelatedData(firestore, tripId) {
  const tid = String(tripId ?? "").trim();
  if (!tid) return;

  await deleteSyncedTripCharge(tid, "trip_deleted");

  let nCosts = 0;
  let nCharges = 0;
  let nAssign = 0;
  let nStops = 0;

  try {
    nCosts = await deleteByTripId(firestore, TRIP_COSTS_COLLECTION, tid);
  } catch (err) {
    logger.error("onTripsWrite: cascada — error al borrar trip-costs", { tripId: tid, err: String(err) });
  }
  try {
    nCharges = await deleteByTripId(firestore, TRIP_CHARGES_COLLECTION, tid);
  } catch (err) {
    logger.error("onTripsWrite: cascada — error al borrar trip-charges", { tripId: tid, err: String(err) });
  }
  try {
    nAssign = await deleteByTripId(firestore, TRIP_ASSIGNMENTS_COLLECTION, tid);
  } catch (err) {
    logger.error("onTripsWrite: cascada — error al borrar trip-assignments", {
      tripId: tid,
      err: String(err),
    });
  }
  try {
    nStops = await deleteTripStopsForTrip(firestore, tid);
  } catch (err) {
    logger.error("onTripsWrite: cascada — error al borrar tripStops", { tripId: tid, err: String(err) });
  }

  logger.info("onTripsWrite: cascada tras borrado de viaje", {
    tripId: tid,
    tripCosts: nCosts,
    tripCharges: nCharges,
    tripAssignments: nAssign,
    tripStops: nStops,
  });
}

async function resolveFreightChargeCode(tripId) {
  const tid = String(tripId ?? "").trim();
  const ref = canonicalTripFreightChargeDocRef(db, tid);
  const snap = await ref.get();
  if (snap.exists) {
    const c = String((snap.data() || {}).code ?? "").trim();
    if (c) return c;
  }
  try {
    return String(await resolveDraftCodeWithGenerator(db, "", TRIP_CHARGE_SEQUENCE_ENTITY)).trim();
  } catch (err) {
    logger.warn("onTripsWrite: no se pudo generar código trip-charge", {
      tripId,
      message: err instanceof Error ? err.message : String(err),
    });
    return `${tripId}-freight`;
  }
}

/**
 * @param {FirebaseFirestore.Transaction} tx
 * @param {string} tripId
 * @returns {Promise<
 *   | { mode: "update"; chargeRef: FirebaseFirestore.DocumentReference }
 *   | { mode: "create"; chargeRef: FirebaseFirestore.DocumentReference }
 *   | { mode: "blocked"; reason: string }
 * >}
 */
async function readFreightChargeSyncPlan(tx, tripId) {
  const tid = String(tripId ?? "").trim();
  const canonicalRef = canonicalTripFreightChargeDocRef(db, tid);

  const canSnap = await tx.get(canonicalRef);
  if (canSnap.exists && isFreightSyncChargeDoc(canSnap.data(), tid)) {
    return { mode: "update", chargeRef: canonicalRef };
  }

  if (canSnap.exists) {
    return { mode: "blocked", reason: "canonical_trip_charge_id_occupied" };
  }

  return { mode: "create", chargeRef: canonicalRef };
}

async function deleteSyncedTripCharge(tripId, reason) {
  const tid = String(tripId ?? "").trim();
  const canonicalRef = canonicalTripFreightChargeDocRef(db, tid);

  try {
    await db.runTransaction(async (tx) => {
      const canSnap = await tx.get(canonicalRef);

      if (canSnap.exists && isFreightSyncChargeDoc(canSnap.data(), tid)) {
        tx.delete(canonicalRef);
      }
    });
    logger.info("onTripsWrite: cargo flete automático eliminado", { tripId: tid, reason });
  } catch (err) {
    logger.warn("onTripsWrite: error al eliminar cargo sincronizado", { tripId: tid, err: String(err) });
  }
}

async function syncFreightTripChargeFromTrip(trip, tripId) {
  const tid = String(tripId ?? "").trim();
  const clientId = String(trip.clientId ?? "").trim();
  const transportServiceId = String(trip.transportServiceId ?? "").trim();

  if (!clientId || !transportServiceId) {
    await deleteSyncedTripCharge(tid, "trip_sin_cliente_o_servicio");
    return;
  }

  const pricing = await computeFreightPricingFromContract(db, { clientId, transportServiceId });

  if (!pricing.ok) {
    logger.warn("onTripsWrite: no se pudo calcular flete automático", {
      tripId: tid,
      reason: pricing.reason,
      clientId,
      transportServiceId,
    });
    await deleteSyncedTripCharge(tid, `pricing_${pricing.reason}`);
    return;
  }

  const code = await resolveFreightChargeCode(tid);
  const name =
    pricing.serviceName ||
    String(trip.transportService ?? "").trim() ||
    "Flete";

  const syncBlock = buildSyncBlock(PROCESS.TRIP_FREIGHT, "trip", tid);

  const nowMeta = {
    updateAt: FieldValue.serverTimestamp(),
    updateBy: SYSTEM_AUDIT,
  };

  const bodyCore = {
    code,
    tripId: tid,
    name,
    type: "freight",
    source: "contract",
    entityType: "transportService",
    entityId: transportServiceId,
    amount: pricing.amount,
    currency: pricing.currency,
    status: "open",
    settlementId: null,
    sync: syncBlock,
    ...nowMeta,
  };

  try {
    await db.runTransaction(async (tx) => {
      const plan = await readFreightChargeSyncPlan(tx, tid);

      if (plan.mode === "blocked") {
        logger.warn("onTripsWrite: no se escribe cargo flete (ID canónico ocupado por otro documento)", {
          tripId: tid,
          reason: plan.reason,
        });
        return;
      }

      if (plan.mode === "update") {
        tx.update(plan.chargeRef, {
          ...bodyCore,
          transportServiceId: FieldValue.delete(),
        });
        return;
      }

      tx.set(plan.chargeRef, {
        ...bodyCore,
        createAt: FieldValue.serverTimestamp(),
        createBy: SYSTEM_AUDIT,
        transportServiceId: FieldValue.delete(),
      });
    });

    logger.info("onTripsWrite: cargo flete sincronizado", { tripId: tid, ruleId: pricing.ruleId });
  } catch (err) {
    logger.error("onTripsWrite: error en transacción de cargo flete", {
      tripId: tid,
      err: String(err),
    });
  }
}

/**
 * Efectos al borrar `trips/{tripId}` (cascada; no paralelizar con otras escrituras que disparen `trip-assignments`).
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleTripDeleted(event) {
  const tripId = String(event.params.tripId ?? "").trim();
  if (!tripId) return;
  await cascadeDeleteTripRelatedData(db, tripId);
}

/**
 * Sincroniza cargo de flete (contrato) cuando el viaje existe.
 * @param {import("firebase-functions/v2/firestore").FirestoreEvent<import("firebase-functions/v2/firestore").Change<FirebaseFirestore.DocumentSnapshot> | undefined>} event
 */
async function handleTripFreightChargeSync(event) {
  const tripId = String(event.params.tripId ?? "").trim();
  const afterSnap = event.data.after;
  if (!afterSnap.exists) return;
  const trip = afterSnap.data() || {};
  await syncFreightTripChargeFromTrip(trip, tripId);
}

/**
 * Despachador único para `trips/{tripId}`: varias tareas en paralelo cuando son independientes.
 * En borrado solo corre la cascada (una tarea en Promise.all por consistencia con el patrón).
 */
const onTripsWrite = onDocumentWritten(
  {
    document: "trips/{tripId}",
    timeoutSeconds: 300,
  },
  async (event) => {
    if (!event.data.after.exists) {
      await Promise.all([handleTripDeleted(event)]);
      return;
    }
    await Promise.all([
      handleTripFreightChargeSync(event),
      // Añade aquí otros syncs independientes del documento de viaje, p. ej.:
      // handleTripSomethingElse(event),
    ]);
  }
);

module.exports = {
  onTripsWrite,
};
