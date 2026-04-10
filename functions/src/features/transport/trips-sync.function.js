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

async function resolveFreightChargeCode(tripId, companyId) {
  const tid = String(tripId ?? "").trim();
  const compId = String(companyId ?? "").trim();
  const ref = canonicalTripFreightChargeDocRef(db, tid);
  const snap = await ref.get();
  if (snap.exists) {
    const c = String((snap.data() || {}).code ?? "").trim();
    if (c) return c;
  }
  try {
    return String(
      await resolveDraftCodeWithGenerator(db, "", TRIP_CHARGE_SEQUENCE_ENTITY, { companyId: compId })
    ).trim();
  } catch (err) {
    logger.warn("onTripsWrite: no se pudo generar código trip-charge", {
      tripId,
      companyId: compId,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

async function resolveFreightChargeType(companyId, accountId) {
  const compId = String(companyId ?? "").trim();
  const accId = String(accountId ?? "").trim();
  try {
    let q = db
      .collection("charge-types")
      .where("type", "==", "charge")
      .where("source", "==", "service");
    if (compId) q = q.where("companyId", "==", compId);
    if (accId) q = q.where("accountId", "==", accId);
    const snap = await q.get();
    if (snap.empty) return { id: "", name: "" };

    const list = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() || {}) }))
      .filter((x) => x.active !== false);
    if (!list.length) return { id: "", name: "" };

    const withScore = list.map((x) => {
      const n = String(x.name ?? "").trim().toLowerCase();
      const c = String(x.code ?? "").trim().toLowerCase();
      const cat = String(x.category ?? "").trim().toLowerCase();
      let score = 0;
      if (cat === "base") score += 3;
      if (n.includes("flete") || c.includes("flete") || n.includes("freight") || c.includes("freight")) score += 2;
      return { x, score };
    });
    withScore.sort((a, b) => b.score - a.score);
    const pick = withScore[0].x;
    return {
      id: String(pick.id ?? "").trim(),
      name: String(pick.name ?? "").trim() || String(pick.code ?? "").trim() || String(pick.id ?? "").trim(),
    };
  } catch (err) {
    logger.warn("onTripsWrite: no se pudo resolver charge-type para flete", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { id: "", name: "" };
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
  const companyId = String(trip.companyId ?? "").trim();
  const accountId = String(trip.accountId ?? "").trim();

  // Sin servicio no hay entidad mínima para el cargo flete sincronizado.
  if (!transportServiceId) {
    await deleteSyncedTripCharge(tid, "trip_sin_servicio");
    return;
  }

  let pricing = null;
  if (clientId) {
    pricing = await computeFreightPricingFromContract(db, {
      clientId,
      transportServiceId,
      companyId,
      accountId,
    });
    if (!pricing.ok) {
      logger.warn("onTripsWrite: no se pudo calcular flete automático; se aplicará fallback", {
        tripId: tid,
        reason: pricing.reason,
        clientId,
        transportServiceId,
      });
    }
  } else {
    logger.warn("onTripsWrite: viaje sin cliente; se aplicará flete fallback", {
      tripId: tid,
      transportServiceId,
    });
  }

  const code = await resolveFreightChargeCode(tid, companyId);
  if (!code) {
    logger.error("onTripsWrite: omitido cargo flete, no se pudo resolver correlativo", {
      tripId: tid,
      companyId,
      entity: TRIP_CHARGE_SEQUENCE_ENTITY,
    });
    return;
  }
  const freightChargeType = await resolveFreightChargeType(companyId, accountId);
  const name =
    (pricing && pricing.ok ? pricing.serviceName : "") ||
    String(trip.transportService ?? "").trim() ||
    "Flete";

  const syncBlock = buildSyncBlock(PROCESS.TRIP_FREIGHT, "trip", tid);

  const nowMeta = {
    updateAt: FieldValue.serverTimestamp(),
    updateBy: SYSTEM_AUDIT,
  };

  const bodyCore = {
    companyId,
    accountId,
    code,
    tripId: tid,
    name,
    chargeTypeId: freightChargeType.id,
    chargeType: freightChargeType.name,
    source: pricing && pricing.ok ? "contract" : "manual",
    entityType: "transportService",
    entityId: transportServiceId,
    amount: pricing && pricing.ok ? pricing.amount : 0,
    currency: pricing && pricing.ok ? pricing.currency : "PEN",
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
        tx.update(plan.chargeRef, bodyCore);
        return;
      }

      tx.set(plan.chargeRef, {
        ...bodyCore,
        createAt: FieldValue.serverTimestamp(),
        createBy: SYSTEM_AUDIT,
      });
    });

    logger.info("onTripsWrite: cargo flete sincronizado", {
      tripId: tid,
      pricingMode: pricing && pricing.ok ? "contract" : "fallback",
      ruleId: pricing && pricing.ok ? pricing.ruleId : null,
    });
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
