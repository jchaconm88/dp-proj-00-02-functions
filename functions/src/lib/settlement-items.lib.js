/**
 * Construye ítems de liquidación a partir de viajes / cargos / costos.
 * Usado por la callable `syncSettlementItems`.
 */

const { FieldValue } = require("firebase-admin/firestore");

/** Primeros 10 caracteres YYYY-MM-DD de scheduledStart (string). */
function tripDateKey(scheduledStart) {
  const s = String(scheduledStart ?? "").trim();
  if (s.length < 10) return "";
  return s.slice(0, 10);
}

function inPeriod(scheduledStart, periodStart, periodEnd) {
  const day = tripDateKey(scheduledStart);
  if (!day) return false;
  const a = String(periodStart ?? "").trim();
  const b = String(periodEnd ?? "").trim();
  return day >= a && day <= b;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ category: string; entityId: string; periodStart: string; periodEnd: string }} params
 * @returns {Promise<{ items: object[]; grossAmount: number }>}
 */
async function buildSettlementItemsPayload(db, params) {
  const { category, entityId, periodStart, periodEnd } = params;
  const entityIdTrim = String(entityId ?? "").trim();
  if (!entityIdTrim) {
    const err = new Error("MISSING_ENTITY_ID");
    err.code = "MISSING_ENTITY_ID";
    throw err;
  }

  const items = [];
  let grossAmount = 0;
  const settlementCurrency = String(params.settlementCurrency ?? "PEN").trim() || "PEN";

  if (category === "customer") {
    const tripsSnap = await db.collection("trips").where("clientId", "==", entityIdTrim).get();
    const tripsInPeriod = [];
    for (const doc of tripsSnap.docs) {
      const t = doc.data() || {};
      if (!inPeriod(t.scheduledStart, periodStart, periodEnd)) continue;
      tripsInPeriod.push({ id: doc.id, code: String(t.code ?? "").trim() || doc.id });
    }

    const tripIds = tripsInPeriod.map((x) => x.id);
    const codeByTrip = new Map(tripsInPeriod.map((x) => [x.id, x.code]));

    const chargesByTrip = await fetchTripChargesByTripIds(db, tripIds);
    for (const tripId of tripIds) {
      const tripCode = codeByTrip.get(tripId) ?? tripId;
      const charges = chargesByTrip.get(tripId) ?? [];
      for (const ch of charges) {
        const amount = num(ch.amount);
        grossAmount += amount;
        items.push({
          movement: { type: "tripCharge", id: ch.id },
          trip: { id: tripId, code: tripCode },
          concept: String(ch.name ?? "").trim() || String(ch.code ?? "").trim() || "Cargo",
          amount,
          settledAmount: 0,
          pendingAmount: 0,
          currency: String(ch.currency ?? settlementCurrency).trim() || settlementCurrency,
        });
      }
    }
    return { items, grossAmount };
  }

  if (category === "resource") {
    const assignSnap = await db
      .collection("tripAssignments")
      .where("entityType", "==", "resource")
      .where("entityId", "==", entityIdTrim)
      .get();

    /** assignmentId -> tripId */
    const assignmentTrip = new Map();
    const tripIdsCandidate = new Set();
    for (const d of assignSnap.docs) {
      const a = d.data() || {};
      const tripId = String(a.tripId ?? "").trim();
      if (!tripId) continue;
      assignmentTrip.set(d.id, tripId);
      tripIdsCandidate.add(tripId);
    }

    const tripsInPeriod = [];
    for (const tripId of tripIdsCandidate) {
      const tripDoc = await db.collection("trips").doc(tripId).get();
      if (!tripDoc.exists) continue;
      const t = tripDoc.data() || {};
      if (!inPeriod(t.scheduledStart, periodStart, periodEnd)) continue;
      tripsInPeriod.push({ id: tripId, code: String(t.code ?? "").trim() || tripId });
    }

    const tripIdSet = new Set(tripsInPeriod.map((x) => x.id));
    const codeByTrip = new Map(tripsInPeriod.map((x) => [x.id, x.code]));

    /** Todos los tripCosts de los viajes en periodo vinculados al recurso (vía asignación). */
    const costsByTrip = await fetchTripCostsByTripIds(db, [...tripIdSet]);
    for (const tripId of tripIdSet) {
      const tripCode = codeByTrip.get(tripId) ?? tripId;
      const costs = costsByTrip.get(tripId) ?? [];
      for (const c of costs) {
        const amount = num(c.amount);
        grossAmount += amount;
        items.push({
          movement: { type: "tripCost", id: c.id },
          trip: { id: tripId, code: tripCode },
          concept: String(c.displayName ?? "").trim() || String(c.code ?? "").trim() || "Costo",
          amount,
          settledAmount: 0,
          pendingAmount: 0,
          currency: String(c.currency ?? settlementCurrency).trim() || settlementCurrency,
        });
      }
    }
    return { items, grossAmount };
  }

  const err = new Error("UNSUPPORTED_CATEGORY");
  err.code = "UNSUPPORTED_CATEGORY";
  throw err;
}

/** @param {string[]} tripIds */
async function fetchTripChargesByTripIds(db, tripIds) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  const chunk = 30;
  for (let i = 0; i < tripIds.length; i += chunk) {
    const part = tripIds.slice(i, i + chunk);
    if (!part.length) continue;
    const snap = await db.collection("tripCharges").where("tripId", "in", part).get();
    for (const doc of snap.docs) {
      const row = { id: doc.id, ...(doc.data() || {}) };
      const tid = String(row.tripId ?? "").trim();
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid).push(row);
    }
  }
  return map;
}

/** @param {string[]} tripIds */
async function fetchTripCostsByTripIds(db, tripIds) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  const chunk = 30;
  for (let i = 0; i < tripIds.length; i += chunk) {
    const part = tripIds.slice(i, i + chunk);
    if (!part.length) continue;
    const snap = await db.collection("tripCosts").where("tripId", "in", part).get();
    for (const doc of snap.docs) {
      const row = { id: doc.id, ...(doc.data() || {}) };
      const tid = String(row.tripId ?? "").trim();
      if (!map.has(tid)) map.set(tid, []);
      map.get(tid).push(row);
    }
  }
  return map;
}

/**
 * Elimina todos los documentos de `settlements/{id}/items` y escribe los nuevos.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} settlementId
 * @param {object[]} itemPayloads datos sin createAt/createBy
 * @param {string|null} createBy
 */
async function replaceSettlementItems(db, settlementId, itemPayloads, createBy) {
  const col = db.collection("settlements").doc(settlementId).collection("items");
  const existing = await col.get();
  const MAX = 450;

  let batch = db.batch();
  let n = 0;
  const flush = async () => {
    if (n > 0) {
      await batch.commit();
      batch = db.batch();
      n = 0;
    }
  };

  for (const d of existing.docs) {
    batch.delete(d.ref);
    n += 1;
    if (n >= MAX) await flush();
  }
  await flush();

  for (const payload of itemPayloads) {
    const ref = col.doc();
    batch.set(ref, {
      ...payload,
      createAt: FieldValue.serverTimestamp(),
      createBy: createBy ?? null,
    });
    n += 1;
    if (n >= MAX) await flush();
  }
  await flush();
}

module.exports = {
  tripDateKey,
  inPeriod,
  buildSettlementItemsPayload,
  replaceSettlementItems,
};
