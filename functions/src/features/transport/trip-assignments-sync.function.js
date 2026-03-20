const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { computeTripCostFromAssignment } = require("../../lib/trip-cost.service");
const { resolveDraftCodeWithGenerator } = require("../../lib/sequence-code.service");

/** Misma entidad que la web en costos de viaje (`TripCostDialog`: `generateSequenceCode(..., "trip-cost")`). */
const TRIP_COST_SEQUENCE_ENTITY = "trip-cost";

/**
 * Sincroniza tripCosts con tripAssignments:
 * - Alta / edición: documento tripCosts con ID = assignmentId (origen salary_rule desde sync).
 * - Borrado de asignación: elimina el tripCost con el mismo ID (no hay recrear: es delete explícito).
 * - Si ya existe tripCost: **update** (patch), no se borra ni se vuelve a crear el documento.
 * - Si el costo es `source: manual`, solo se actualiza tripId y auditoría; **no** se toca `code` (lo definió el usuario).
 * - Si status !== open, no recalcula monto/moneda (solo metadatos ligeros).
 * - `code` del tripCost: **nunca** el de `tripAssignments`; secuencia propia `trip-cost` o el ya guardado en el tripCost (re-sync).
 * - `displayName`: copia de `tripAssignments.displayName` (trim); en costos `manual` queda vacío (`""`).
 */
const syncTripCostFromTripAssignment = onDocumentWritten(
  {
    document: "tripAssignments/{assignmentId}",
    timeoutSeconds: 120,
  },
  async (event) => {
    const assignmentId = event.params.assignmentId;
    const afterSnap = event.data.after;

    if (!afterSnap.exists) {
      try {
        await db.collection("tripCosts").doc(assignmentId).delete();
        logger.info("syncTripCost: tripCost eliminado (asignación borrada)", { assignmentId });
      } catch (err) {
        logger.warn("syncTripCost: error al eliminar tripCost", { assignmentId, err: String(err) });
      }
      return;
    }

    const data = afterSnap.data() || {};
    const tripId = String(data.tripId ?? "").trim();
    const assignmentDisplayName = String(data.displayName ?? "").trim();

    if (!tripId) {
      logger.warn("syncTripCost: omitido, sin tripId", { assignmentId });
      return;
    }

    const costRef = db.collection("tripCosts").doc(assignmentId);
    const existingSnap = await costRef.get();

    const previousCostCode = existingSnap.exists
      ? String((existingSnap.data() || {}).code ?? "").trim()
      : "";

    /**
     * Código del tripCost (independiente de `tripAssignments.code`):
     * 1) Si ya existe documento con `code` → mantenerlo (re-sincronización sin consumir correlativo).
     * 2) Si no → correlativo con entidad `trip-cost` (misma regla que `generateSequenceCode` con currentCode vacío).
     */
    let tripCostCode;
    if (previousCostCode) {
      tripCostCode = previousCostCode;
    } else {
      try {
        tripCostCode = await resolveDraftCodeWithGenerator(db, "", TRIP_COST_SEQUENCE_ENTITY);
        tripCostCode = String(tripCostCode ?? "").trim();
      } catch (err) {
        logger.warn("syncTripCost: no se pudo generar código trip-cost (secuencia)", {
          assignmentId,
          message: err instanceof Error ? err.message : String(err),
        });
        tripCostCode = assignmentId;
      }
    }
    if (!tripCostCode) {
      tripCostCode = assignmentId;
    }

    let computed;
    try {
      computed = await computeTripCostFromAssignment(data, db, { allowPartial: true });
    } catch (err) {
      logger.warn("syncTripCost: cálculo con valores por defecto", {
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

    const baseMeta = {
      tripId,
      code: tripCostCode,
      displayName: assignmentDisplayName,
      updateAt: FieldValue.serverTimestamp(),
      updateBy: "system:trip-assignment-sync",
    };

    if (existingSnap.exists) {
      const existing = existingSnap.data() || {};
      const source = String(existing.source ?? "salary_rule");

      if (source === "manual") {
        await costRef.update({
          tripId,
          displayName: "",
          updateAt: FieldValue.serverTimestamp(),
          updateBy: "system:trip-assignment-sync",
        });
        logger.info("syncTripCost: costo manual — solo tripId/auditoría (code sin cambiar)", { assignmentId });
        return;
      }

      const status = String(existing.status ?? "open");
      const patch = {
        ...baseMeta,
        entity: "assignment",
        entityId: assignmentId,
        type: computed.costType,
        source: "salary_rule",
      };

      if (status === "open") {
        patch.amount = computed.amount;
        patch.currency = computed.currency;
      }

      await costRef.update(patch);
      logger.info("syncTripCost: tripCost actualizado", { assignmentId });
      return;
    }

    await costRef.set({
      ...baseMeta,
      entity: "assignment",
      entityId: assignmentId,
      type: computed.costType,
      source: "salary_rule",
      amount: computed.amount,
      currency: computed.currency,
      status: "open",
      settlementId: null,
      createAt: FieldValue.serverTimestamp(),
      createBy: "system:trip-assignment-sync",
    });

    logger.info("syncTripCost: tripCost creado", { assignmentId });
  }
);

module.exports = {
  syncTripCostFromTripAssignment,
};
