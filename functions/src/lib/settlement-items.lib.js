/**
 * Construye ítems de liquidación a partir de viajes / cargos / costos.
 * Usado por la callable `syncSettlementItems`.
 */

const { FieldValue } = require("firebase-admin/firestore");

function formatYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Clave YYYY-MM-DD para comparar con periodo de liquidación.
 * Soporta string ISO, Firestore Timestamp (Admin SDK), y Date.
 */
function tripDateKey(scheduledStart) {
  if (scheduledStart == null || scheduledStart === "") return "";

  if (typeof scheduledStart.toDate === "function") {
    try {
      const d = scheduledStart.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return formatYmd(d);
    } catch (_) {
      /* continuar con otros formatos */
    }
  }

  if (scheduledStart instanceof Date && !Number.isNaN(scheduledStart.getTime())) {
    return formatYmd(scheduledStart);
  }

  const s = String(scheduledStart).trim();
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return formatYmd(parsed);
  }
  return "";
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
 * Viajes liquidables: completados, en curso o ya pre-liquidados (re-sync de ítems).
 */
function isTripEligibleForSettlement(status) {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "completed" || s === "in_progress" || s === "pre_settled";
}

function tripRouteLabel(t) {
  return String(t.route ?? t.routeCode ?? "").trim();
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
      if (!isTripEligibleForSettlement(t.status)) continue;
      if (!inPeriod(t.scheduledStart, periodStart, periodEnd)) continue;
      tripsInPeriod.push({
        id: doc.id,
        code: String(t.code ?? "").trim() || doc.id,
        route: tripRouteLabel(t),
        scheduledStart: tripDateKey(t.scheduledStart),
      });
    }

    const tripIds = tripsInPeriod.map((x) => x.id);
    const metaByTrip = new Map(tripsInPeriod.map((x) => [x.id, x]));

    const chargesByTrip = await fetchTripChargesByTripIds(db, tripIds);
    for (const tripId of tripIds) {
      const meta = metaByTrip.get(tripId);
      const tripCode = meta?.code ?? tripId;
      const tripRoute = meta?.route ?? "";
      const tripScheduled = meta?.scheduledStart ?? "";
      const charges = chargesByTrip.get(tripId) ?? [];
      for (const ch of charges) {
        const amount = num(ch.amount);
        grossAmount += amount;
        const chargeTypeId = String(ch.chargeTypeId ?? "").trim();
        const chargeType = String(ch.chargeType ?? "").trim();
        items.push({
          movement: { type: "tripCharge", id: ch.id },
          trip: {
            id: tripId,
            code: tripCode,
            route: tripRoute,
            scheduledStart: tripScheduled,
          },
          chargeTypeId,
          chargeType,
          concept:
            String(ch.name ?? "").trim() ||
            chargeType ||
            String(ch.code ?? "").trim() ||
            "Cargo",
          amount,
          settledAmount: 0,
          pendingAmount: amount,
          currency: String(ch.currency ?? settlementCurrency).trim() || settlementCurrency,
        });
      }
    }
    return { items, grossAmount };
  }

  if (category === "resource") {
    const assignSnap = await db
      .collection("trip-assignments")
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
      if (!isTripEligibleForSettlement(t.status)) continue;
      if (!inPeriod(t.scheduledStart, periodStart, periodEnd)) continue;
      tripsInPeriod.push({
        id: tripId,
        code: String(t.code ?? "").trim() || tripId,
        route: tripRouteLabel(t),
        scheduledStart: tripDateKey(t.scheduledStart),
      });
    }

    const tripIdSet = new Set(tripsInPeriod.map((x) => x.id));
    const metaByTrip = new Map(tripsInPeriod.map((x) => [x.id, x]));

    /** Todos los trip-costs de los viajes en periodo vinculados al recurso (vía asignación). */
    const costsByTrip = await fetchTripCostsByTripIds(db, [...tripIdSet]);
    for (const tripId of tripIdSet) {
      const meta = metaByTrip.get(tripId);
      const tripCode = meta?.code ?? tripId;
      const tripRoute = meta?.route ?? "";
      const tripScheduled = meta?.scheduledStart ?? "";
      const costs = costsByTrip.get(tripId) ?? [];
      for (const c of costs) {
        const amount = num(c.amount);
        grossAmount += amount;
        const chargeTypeId = String(c.chargeTypeId ?? "").trim();
        const chargeType = String(c.chargeType ?? "").trim();
        items.push({
          movement: { type: "tripCost", id: c.id },
          trip: {
            id: tripId,
            code: tripCode,
            route: tripRoute,
            scheduledStart: tripScheduled,
          },
          chargeTypeId,
          chargeType,
          concept:
            String(c.displayName ?? "").trim() ||
            chargeType ||
            String(c.code ?? "").trim() ||
            "Costo",
          amount,
          settledAmount: 0,
          pendingAmount: amount,
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
    const snap = await db.collection("trip-charges").where("tripId", "in", part).get();
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
    const snap = await db.collection("trip-costs").where("tripId", "in", part).get();
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
/**
 * Pone `status: pre_settled` en los viajes que aún están `completed` o `in_progress`.
 * Debe ejecutarse **antes** de `replaceSettlementItems`: el trigger de viajes al
 * actualizar el doc puede escribir el cargo de flete con `settlementId: null`; los
 * ítems de liquidación (creados después) vuelven a enlazar cargos/costos.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string[]} tripIds
 * @param {string|null} updateBy
 */
async function setTripsToPreSettledForSettlement(db, tripIds, updateBy) {
  const ids = [
    ...new Set(
      (tripIds || [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    ),
  ];
  if (!ids.length) return;

  const chunkSize = 25;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const part = ids.slice(i, i + chunkSize);
    await Promise.all(
      part.map(async (tripId) => {
        const ref = db.collection("trips").doc(tripId);
        const snap = await ref.get();
        if (!snap.exists) return;
        const st = String(snap.data()?.status ?? "")
          .trim()
          .toLowerCase();
        if (st !== "completed" && st !== "in_progress") return;
        await ref.update({
          status: "pre_settled",
          updateAt: FieldValue.serverTimestamp(),
          updateBy: updateBy ?? null,
        });
      })
    );
  }
}

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

/**
 * Suma `amount`, `settledAmount` y `pendingAmount` de todos los docs en
 * `settlements/{settlementId}/items` y actualiza `totals` en el documento padre.
 * Conserva `totals.currency` del documento de liquidación (no mezcla monedas por ítem).
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} settlementId
 * @returns {Promise<{ grossAmount: number; settledAmount: number; pendingAmount: number } | null>}
 */
async function recalculateSettlementTotalsFromItems(db, settlementId) {
  const sid = String(settlementId ?? "").trim();
  if (!sid) return null;

  const settlementRef = db.collection("settlements").doc(sid);
  const settlementSnap = await settlementRef.get();
  if (!settlementSnap.exists) {
    return null;
  }

  const parentData = settlementSnap.data() || {};
  const totalsExisting =
    parentData.totals && typeof parentData.totals === "object" ? parentData.totals : {};
  const currency = String(totalsExisting.currency ?? "PEN").trim() || "PEN";

  const itemsSnap = await settlementRef.collection("items").get();
  let grossAmount = 0;
  let settledAmount = 0;
  let pendingAmount = 0;

  for (const doc of itemsSnap.docs) {
    const d = doc.data() || {};
    grossAmount += num(d.amount);
    settledAmount += num(d.settledAmount);
    pendingAmount += num(d.pendingAmount);
  }

  await settlementRef.update({
    totals: {
      grossAmount,
      settledAmount,
      pendingAmount,
      currency,
    },
    updateAt: FieldValue.serverTimestamp(),
  });

  return { grossAmount, settledAmount, pendingAmount };
}

module.exports = {
  tripDateKey,
  inPeriod,
  isTripEligibleForSettlement,
  /** @deprecated usar isTripEligibleForSettlement */
  isTripCompleted: (status) => String(status ?? "").trim().toLowerCase() === "completed",
  buildSettlementItemsPayload,
  setTripsToPreSettledForSettlement,
  replaceSettlementItems,
  recalculateSettlementTotalsFromItems,
};
