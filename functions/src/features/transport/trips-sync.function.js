const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { resolveDraftCodeWithGenerator } = require("../../lib/sequence-code.service");
const { computeFreightPricingFromContract } = require("../../lib/trip-charge-freight-pricing.lib");

const TRIP_ASSIGNMENT_SEQUENCE_ENTITY = "trip-assignment";
const TRIP_CHARGE_SEQUENCE_ENTITY = "trip-charge";
const ASSIGNMENTS_COLLECTION = "tripAssignments";
const TRIP_CHARGES_COLLECTION = "tripCharges";
const DRIVERS_COLLECTION = "drivers";
const SYNC_SOURCE = "trip-driver-sync";
const SYNC_CHARGE_SOURCE = "trip-freight-sync";

function syncedTripChargeDocId(tripId) {
  return `sync_trip_freight__${tripId}`;
}

function normalizeRelationshipType(value) {
  const t = String(value ?? "").toLowerCase().trim();
  return t === "resource" ? "resource" : "employee";
}

function buildDisplayName(driver) {
  const first = String(driver.firstName ?? "").trim();
  const last = String(driver.lastName ?? "").trim();
  const full = `${first} ${last}`.trim();
  return full || String(driver.code ?? "").trim() || String(driver.documentNo ?? "").trim();
}

async function getSyncedAssignmentsByTrip(tripId) {
  const snap = await db
    .collection(ASSIGNMENTS_COLLECTION)
    .where("tripId", "==", tripId)
    .where("syncSource", "==", SYNC_SOURCE)
    .get();
  return snap.docs;
}

async function deleteSyncedAssignments(tripId, reason) {
  const docs = await getSyncedAssignmentsByTrip(tripId);
  if (!docs.length) return;
  const batch = db.batch();
  docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  logger.info("tripSync: asignaciones automáticas eliminadas", { tripId, count: docs.length, reason });
}

async function deleteSyncedTripCharge(tripId, reason) {
  const ref = db.collection(TRIP_CHARGES_COLLECTION).doc(syncedTripChargeDocId(tripId));
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  if (data.syncSource !== SYNC_CHARGE_SOURCE) {
    logger.warn("tripSync: doc trip charge con id sync no coincide syncSource, no se elimina", { tripId });
    return;
  }
  await ref.delete();
  logger.info("tripSync: cargo flete automático eliminado", { tripId, reason });
}

/**
 * Sincroniza tripAssignments según conductor del viaje.
 */
async function syncDriverAssignmentFromTrip(trip, tripId) {
  const driverId = String(trip.driverId ?? "").trim();

  if (!driverId) {
    await deleteSyncedAssignments(tripId, "trip_without_driver");
    return;
  }

  const driverSnap = await db.collection(DRIVERS_COLLECTION).doc(driverId).get();
  if (!driverSnap.exists) {
    logger.warn("tripSync: conductor no encontrado, se limpian asignaciones automáticas", { tripId, driverId });
    await deleteSyncedAssignments(tripId, "driver_not_found");
    return;
  }

  const driver = driverSnap.data() || {};
  const entityType = normalizeRelationshipType(driver.relationshipType);
  const entityId =
    entityType === "resource"
      ? String(driver.resourceId ?? "").trim()
      : String(driver.employeeId ?? "").trim();

  if (!entityId) {
    logger.warn("tripSync: conductor sin entityId según vínculo, se limpian asignaciones automáticas", {
      tripId,
      driverId,
      entityType,
    });
    await deleteSyncedAssignments(tripId, "driver_without_entity");
    return;
  }

  const displayName = buildDisplayName(driver);
  const position = "Conductor";
  const nowMeta = {
    updateAt: FieldValue.serverTimestamp(),
    updateBy: "system:trip-sync",
  };

  const syncedDocs = await getSyncedAssignmentsByTrip(tripId);
  const primary = syncedDocs[0] || null;
  const extras = syncedDocs.slice(1);

  if (!primary) {
    let code = "";
    try {
      code = String(await resolveDraftCodeWithGenerator(db, "", TRIP_ASSIGNMENT_SEQUENCE_ENTITY)).trim();
    } catch (err) {
      logger.warn("tripSync: no se pudo generar código secuencial para trip-assignment", {
        tripId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const payload = {
      code: code || `${tripId}-driver`,
      tripId,
      entityType,
      entityId,
      position,
      displayName,
      resourceCostId: "",
      syncSource: SYNC_SOURCE,
      createAt: FieldValue.serverTimestamp(),
      createBy: "system:trip-sync",
      ...nowMeta,
    };

    await db.collection(ASSIGNMENTS_COLLECTION).add(payload);
    logger.info("tripSync: asignación automática creada", { tripId, driverId, entityType, entityId });
    return;
  }

  await primary.ref.update({
    tripId,
    entityType,
    entityId,
    position,
    displayName,
    syncSource: SYNC_SOURCE,
    ...nowMeta,
  });

  if (extras.length) {
    const batch = db.batch();
    extras.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }

  logger.info("tripSync: asignación automática actualizada", {
    tripId,
    driverId,
    entityType,
    entityId,
    removedExtras: extras.length,
  });
}

/**
 * Crea/actualiza un tripCharge automático: flete, contrato, abierto; monto/moneda desde misma lógica que getTripChargeFreightPricing.
 * Usa transportServiceId del viaje.
 */
async function syncFreightTripChargeFromTrip(trip, tripId) {
  const clientId = String(trip.clientId ?? "").trim();
  const transportServiceId = String(trip.transportServiceId ?? "").trim();

  if (!clientId || !transportServiceId) {
    await deleteSyncedTripCharge(tripId, "trip_sin_cliente_o_servicio");
    return;
  }

  const pricing = await computeFreightPricingFromContract(db, { clientId, transportServiceId });

  if (!pricing.ok) {
    logger.warn("tripSync: no se pudo calcular flete automático", {
      tripId,
      reason: pricing.reason,
      clientId,
      transportServiceId,
    });
    await deleteSyncedTripCharge(tripId, `pricing_${pricing.reason}`);
    return;
  }

  const chargeRef = db.collection(TRIP_CHARGES_COLLECTION).doc(syncedTripChargeDocId(tripId));
  const existing = await chargeRef.get();

  let code = "";
  if (existing.exists) {
    code = String((existing.data() || {}).code ?? "").trim();
  }
  if (!code) {
    try {
      code = String(await resolveDraftCodeWithGenerator(db, "", TRIP_CHARGE_SEQUENCE_ENTITY)).trim();
    } catch (err) {
      logger.warn("tripSync: no se pudo generar código trip-charge", {
        tripId,
        message: err instanceof Error ? err.message : String(err),
      });
      code = `${tripId}-freight`;
    }
  }

  const name =
    pricing.serviceName ||
    String(trip.transportService ?? "").trim() ||
    "Flete";

  const nowMeta = {
    updateAt: FieldValue.serverTimestamp(),
    updateBy: "system:trip-sync",
  };

  const body = {
    code,
    tripId,
    name,
    type: "freight",
    source: "contract",
    transportServiceId,
    amount: pricing.amount,
    currency: pricing.currency,
    status: "open",
    settlementId: null,
    syncSource: SYNC_CHARGE_SOURCE,
    ...nowMeta,
  };

  if (existing.exists) {
    await chargeRef.update(body);
    logger.info("tripSync: cargo flete automático actualizado", { tripId, ruleId: pricing.ruleId });
  } else {
    await chargeRef.set({
      ...body,
      createAt: FieldValue.serverTimestamp(),
      createBy: "system:trip-sync",
    });
    logger.info("tripSync: cargo flete automático creado", { tripId, ruleId: pricing.ruleId });
  }
}

const syncTripAssignmentFromTrip = onDocumentWritten(
  {
    document: "trips/{tripId}",
    timeoutSeconds: 120,
  },
  async (event) => {
    const tripId = String(event.params.tripId ?? "").trim();
    const afterSnap = event.data.after;

    if (!afterSnap.exists) {
      await deleteSyncedAssignments(tripId, "trip_deleted");
      await deleteSyncedTripCharge(tripId, "trip_deleted");
      return;
    }

    const trip = afterSnap.data() || {};

    await syncDriverAssignmentFromTrip(trip, tripId);
    await syncFreightTripChargeFromTrip(trip, tripId);
  }
);

module.exports = {
  syncTripAssignmentFromTrip,
};
