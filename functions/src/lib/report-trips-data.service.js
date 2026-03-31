/**
 * Lecturas agregadas para reportes basados en `trips` (viajes, cargos, asignaciones, paradas).
 */

const TRIPS = "trips";
const TRIP_STOPS = "tripStops";
const TRIP_CHARGES = "trip-charges";
const TRIP_ASSIGNMENTS = "trip-assignments";

const PAGE = 400;

/**
 * @param {string} s
 * @returns {string}
 */
function dateKey(s) {
  const t = String(s ?? "");
  if (t.length >= 10) return t.slice(0, 10);
  return t;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} dateFrom YYYY-MM-DD
 * @param {string} dateTo YYYY-MM-DD
 * @returns {Promise<Array<Record<string, unknown> & { id: string }>>}
 */
async function fetchTripsInDateRange(db, dateFrom, dateTo) {
  const from = String(dateFrom).trim();
  const to = String(dateTo).trim();
  if (!from || !to) return [];

  /** @type {Array<Record<string, unknown> & { id: string }>} */
  const out = [];
  let q = db
    .collection(TRIPS)
    .where("scheduledStart", ">=", from)
    .orderBy("scheduledStart", "asc")
    .limit(PAGE);

  /** @type {FirebaseFirestore.QueryDocumentSnapshot | null} */
  let cursor = null;
  // Paginate until past dateTo or empty
  for (;;) {
    const snap = cursor ? await q.startAfter(cursor).get() : await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      const data = d.data();
      const sk = dateKey(data.scheduledStart);
      if (sk > to) {
        return out;
      }
      if (sk >= from) {
        out.push({ id: d.id, ...data });
      }
    }
    if (snap.docs.length < PAGE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return out;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} tripIds
 * @param {(chunk: string[]) => Promise<void>} fn
 */
async function forEachTripIdChunk(tripIds, fn) {
  const uniq = [...new Set(tripIds.filter(Boolean))];
  const size = 30;
  for (let i = 0; i < uniq.length; i += size) {
    const chunk = uniq.slice(i, i + size);
    await fn(chunk);
  }
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} tripIds
 * @returns {Promise<Map<string, Array<Record<string, unknown> & { id: string }>>>}
 */
async function fetchTripChargesByTripId(db, tripIds) {
  /** @type {Map<string, Array<Record<string, unknown> & { id: string }>>} */
  const map = new Map();
  await forEachTripIdChunk(tripIds, async (chunk) => {
    const snap = await db.collection(TRIP_CHARGES).where("tripId", "in", chunk).get();
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      const tid = String(row.tripId ?? "");
      if (!tid) continue;
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid).push(row);
    }
  });
  return map;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} tripIds
 * @returns {Promise<Map<string, Array<Record<string, unknown> & { id: string }>>>}
 */
async function fetchTripAssignmentsByTripId(db, tripIds) {
  /** @type {Map<string, Array<Record<string, unknown> & { id: string }>>} */
  const map = new Map();
  await forEachTripIdChunk(tripIds, async (chunk) => {
    const snap = await db.collection(TRIP_ASSIGNMENTS).where("tripId", "in", chunk).get();
    for (const d of snap.docs) {
      const row = { id: d.id, ...d.data() };
      const tid = String(row.tripId ?? "");
      if (!tid) continue;
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid).push(row);
    }
  });
  return map;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tripId
 * @param {string} stopId
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function fetchTripStop(db, tripId, stopId) {
  if (!tripId || !stopId) return null;
  const ref = db.collection(TRIPS).doc(tripId).collection(TRIP_STOPS).doc(stopId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  return snap.data() ?? null;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} tripId
 * @param {string[]} stopIds
 * @returns {Promise<Map<string, Record<string, unknown>>>}
 */
async function fetchTripStopsByIds(db, tripId, stopIds) {
  const tid = String(tripId ?? "").trim();
  if (!tid) return new Map();
  const uniq = [...new Set((stopIds || []).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const refs = uniq.map((sid) => db.collection(TRIPS).doc(tid).collection(TRIP_STOPS).doc(sid));
  // Firestore Admin: getAll(...refs)
  const snaps = await db.getAll(...refs);
  /** @type {Map<string, Record<string, unknown>>} */
  const out = new Map();
  for (const snap of snaps) {
    if (!snap.exists) continue;
    out.set(snap.id, snap.data() ?? {});
  }
  return out;
}
/**
 * Suma importes de cargos no cancelados.
 * @param {Array<Record<string, unknown>>} charges
 * @returns {number}
 */
function sumTripChargeAmounts(charges) {
  let s = 0;
  for (const c of charges) {
    if (String(c.status ?? "") === "cancelled") continue;
    const n = Number(c.amount);
    if (!Number.isFinite(n)) continue;
    s += n;
  }
  return Math.round(s * 100) / 100;
}

/**
 * Suma importes de cargos no cancelados cuyo `chargeType` coincide (trim, comparación exacta).
 * @param {Array<Record<string, unknown>>} charges
 * @param {string} chargeType
 * @returns {number}
 */
function sumTripChargeAmountsByChargeType(charges, chargeType) {
  const want = String(chargeType ?? "").trim();
  if (!want) return 0;
  let s = 0;
  for (const c of charges) {
    if (String(c.status ?? "") === "cancelled") continue;
    if (String(c.chargeType ?? "").trim() !== want) continue;
    const n = Number(c.amount);
    if (!Number.isFinite(n)) continue;
    s += n;
  }
  return Math.round(s * 100) / 100;
}

/**
 * Importe de cargos vinculados a la misma entidad que la asignación (apoyo / flete por entidad).
 * @param {Array<Record<string, unknown>>} charges
 * @param {Record<string, unknown>} assignment
 * @returns {number}
 */
function sumChargesForAssignment(charges, assignment) {
  const et = String(assignment.entityType ?? "");
  const eid = String(assignment.entityId ?? "");
  if (!eid) return 0;
  let s = 0;
  for (const c of charges) {
    if (String(c.status ?? "") === "cancelled") continue;
    if (String(c.entityType ?? "") !== et) continue;
    if (String(c.entityId ?? "") !== eid) continue;
    const n = Number(c.amount);
    if (!Number.isFinite(n)) continue;
    s += n;
  }
  return Math.round(s * 100) / 100;
}

/**
 * @param {unknown} position
 * @returns {boolean}
 */
function isConductorPosition(position) {
  return String(position ?? "").trim().toLowerCase() === "conductor";
}

/**
 * Nombres desde asignaciones del viaje filtradas por tipo de entidad.
 * Con `conductorPositionOnly`, solo asignaciones cuya `position` sea rol Conductor (normalizado).
 * @param {Array<Record<string, unknown>>} assignments
 * @param {"both"|"employee"|"resource"} mode both = empleado y recurso (CHOFER agregado)
 * @param {{ conductorPositionOnly?: boolean }} [opts]
 * @returns {string}
 */
function formatAssignmentDisplayNames(assignments, mode, opts) {
  const conductorOnly = opts?.conductorPositionOnly === true;
  const names = [];
  for (const a of assignments) {
    if (conductorOnly && !isConductorPosition(a.position)) continue;
    const et = String(a.entityType ?? "").trim().toLowerCase();
    if (mode === "employee" && et !== "employee") continue;
    if (mode === "resource" && et !== "resource") continue;
    if (mode === "both" && et !== "employee" && et !== "resource") continue;
    const dn = String(a.displayName ?? "").trim();
    if (dn) names.push(dn);
  }
  return names.length ? names.join(", ") : "";
}

/**
 * Conductores (asignaciones con rol Conductor por `position`), empleado y/o recurso, separados por coma.
 * @param {Array<Record<string, unknown>>} assignments
 * @returns {string}
 */
function formatDriverNames(assignments) {
  return formatAssignmentDisplayNames(assignments, "both", { conductorPositionOnly: true });
}

/**
 * Fecha dd/mm/yyyy desde scheduledStart.
 * @param {string} scheduledStart
 * @returns {string}
 */
function formatDateEs(scheduledStart) {
  const key = dateKey(scheduledStart);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

module.exports = {
  fetchTripsInDateRange,
  fetchTripChargesByTripId,
  fetchTripAssignmentsByTripId,
  fetchTripStop,
  fetchTripStopsByIds,
  isConductorPosition,
  sumTripChargeAmounts,
  sumTripChargeAmountsByChargeType,
  sumChargesForAssignment,
  formatDriverNames,
  formatAssignmentDisplayNames,
  formatDateEs,
  dateKey,
};
