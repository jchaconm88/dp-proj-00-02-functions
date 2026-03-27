/**
 * IDs deterministas para documentos creados/actualizados por sync en Cloud Functions.
 *
 * Estándar único: `sync__{tipo}__{idOrigen}`
 * Ej.: `sync__trip_freight__abc123`, `sync__assignment_cost__xyz789`
 */

const SEP = "__";
const PREFIX = "sync";

const PROCESS = {
  TRIP_FREIGHT: "trip-freight-sync",
  TRIP_ASSIGNMENT_COST: "trip-assignment-cost-sync",
  TRIP_ASSIGNMENT_CHARGE: "trip-assignment-charge-sync",
};

const LEGACY_SYNC_SOURCE_FREIGHT = "trip-freight-sync";

/**
 * @param {string} tipo p. ej. `trip_freight`, `assignment_cost`
 * @param {string} sourceId id del documento origen (tripId, assignmentId, …)
 * @returns {string}
 */
function canonicalSyncDocId(tipo, sourceId) {
  const t = String(tipo ?? "").trim();
  const sid = String(sourceId ?? "").trim();
  return `${PREFIX}${SEP}${t}${SEP}${sid}`;
}

/**
 * @param {string} tripId
 */
function canonicalTripFreightChargeDocId(tripId) {
  return canonicalSyncDocId("trip_freight", tripId);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tripId
 */
function canonicalTripFreightChargeDocRef(db, tripId) {
  return db.collection("trip-charges").doc(canonicalTripFreightChargeDocId(tripId));
}

/**
 * @param {string} assignmentId
 */
function canonicalAssignmentCostDocId(assignmentId) {
  return canonicalSyncDocId("assignment_cost", assignmentId);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} assignmentId
 */
function canonicalAssignmentCostDocRef(db, assignmentId) {
  return db.collection("trip-costs").doc(canonicalAssignmentCostDocId(assignmentId));
}

/**
 * @param {string} assignmentId
 */
function canonicalAssignmentChargeDocId(assignmentId) {
  return canonicalSyncDocId("assignment_charge", assignmentId);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} assignmentId
 */
function canonicalAssignmentChargeDocRef(db, assignmentId) {
  return db.collection("trip-charges").doc(canonicalAssignmentChargeDocId(assignmentId));
}

/**
 * @param {string} process
 * @param {string} source
 * @param {string} sourceId
 */
function buildSyncBlock(process, source, sourceId) {
  return {
    source: String(source).trim(),
    sourceId: String(sourceId ?? "").trim(),
    process: String(process).trim(),
  };
}

/**
 * @param {FirebaseFirestore.DocumentData | undefined} data
 * @param {string} tripId
 */
function isFreightSyncChargeDoc(data, tripId) {
  if (!data || typeof data !== "object") return false;
  const tid = String(tripId ?? "").trim();
  if (String(data.tripId ?? "").trim() !== tid) return false;
  const sync = data.sync && typeof data.sync === "object" ? data.sync : null;
  if (sync) {
    return (
      String(sync.process ?? "").trim() === PROCESS.TRIP_FREIGHT &&
      String(sync.source ?? "").trim() === "trip" &&
      String(sync.sourceId ?? "").trim() === tid
    );
  }
  return String(data.syncSource ?? "").trim() === LEGACY_SYNC_SOURCE_FREIGHT;
}

/**
 * @param {FirebaseFirestore.DocumentData | undefined} data
 * @param {string} assignmentId
 */
function isAssignmentCostSyncDoc(data, assignmentId) {
  if (!data || typeof data !== "object") return false;
  const aid = String(assignmentId ?? "").trim();
  const sync = data.sync && typeof data.sync === "object" ? data.sync : null;
  if (sync) {
    return (
      String(sync.process ?? "").trim() === PROCESS.TRIP_ASSIGNMENT_COST &&
      String(sync.source ?? "").trim() === "assignment" &&
      String(sync.sourceId ?? "").trim() === aid
    );
  }
  const createBy = String(data.createBy ?? "");
  const updateBy = String(data.updateBy ?? "");
  if (
    createBy.includes("trip-assignment-sync") ||
    updateBy.includes("trip-assignment-sync")
  ) {
    return String(data.entity ?? "") === "assignment" && String(data.entityId ?? "").trim() === aid;
  }
  return false;
}

/**
 * @param {FirebaseFirestore.DocumentData | undefined} data
 * @param {string} assignmentId
 */
function isAssignmentChargeSyncDoc(data, assignmentId) {
  if (!data || typeof data !== "object") return false;
  const aid = String(assignmentId ?? "").trim();
  const sync = data.sync && typeof data.sync === "object" ? data.sync : null;
  if (sync) {
    return (
      String(sync.process ?? "").trim() === PROCESS.TRIP_ASSIGNMENT_CHARGE &&
      String(sync.source ?? "").trim() === "assignment" &&
      String(sync.sourceId ?? "").trim() === aid
    );
  }
  const createBy = String(data.createBy ?? "");
  const updateBy = String(data.updateBy ?? "");
  if (
    createBy.includes("trip-assignment-sync") ||
    updateBy.includes("trip-assignment-sync")
  ) {
    return String(data.type ?? "") === "additional_support" && String(data.entityId ?? "").trim() === aid;
  }
  return false;
}

module.exports = {
  SEP,
  PREFIX,
  PROCESS,
  canonicalSyncDocId,
  canonicalTripFreightChargeDocId,
  canonicalTripFreightChargeDocRef,
  canonicalAssignmentCostDocId,
  canonicalAssignmentCostDocRef,
  canonicalAssignmentChargeDocId,
  canonicalAssignmentChargeDocRef,
  LEGACY_SYNC_SOURCE_FREIGHT,
  buildSyncBlock,
  isFreightSyncChargeDoc,
  isAssignmentCostSyncDoc,
  isAssignmentChargeSyncDoc,
};
