const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { computeTripCostFromAssignment } = require("../../lib/trip-cost.service");

function mapComputeError(e) {
  switch (e.code) {
    case "MISSING_ENTITY_ID":
      return new HttpsError("failed-precondition", "La asignación no tiene entityId.");
    case "NO_PER_TRIP_COST":
      return new HttpsError("not-found", "El recurso no tiene costo per_trip activo.");
    case "EMPLOYEE_NOT_FOUND":
      return new HttpsError("not-found", "Empleado no encontrado.");
    case "INVALID_SALARY":
    case "INVALID_AMOUNT":
      return new HttpsError("data-loss", "Datos de monto o salario inválidos.");
    case "INVALID_ENTITY_TYPE":
      return new HttpsError("failed-precondition", "La asignación debe ser de tipo employee o resource.");
    default:
      return e;
  }
}

const getResourcePerTripCost = onCall(
  {
    cors: true,
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para consultar costos.");
    }

    const tripAssignmentId = String(request.data?.tripAssignmentId ?? "").trim();
    if (!tripAssignmentId) {
      throw new HttpsError("invalid-argument", "tripAssignmentId es obligatorio.");
    }

    const assignmentSnap = await db.collection("trip-assignments").doc(tripAssignmentId).get();
    if (!assignmentSnap.exists) {
      throw new HttpsError("not-found", "Asignación no encontrada.");
    }

    const assignment = assignmentSnap.data() || {};

    try {
      const computed = await computeTripCostFromAssignment(assignment, db, { allowPartial: false });
      const entityType = String(assignment.entityType ?? "");
      const entityId = String(assignment.entityId ?? "").trim();
      const sourceId =
        computed.costType === "resource_payment" && computed.resourceCostId
          ? computed.resourceCostId
          : entityId;
      return {
        entityType,
        entityId,
        sourceId,
        amount: computed.amount,
        currency: computed.currency,
      };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      const mapped = mapComputeError(e);
      if (mapped instanceof HttpsError) throw mapped;
      throw new HttpsError("internal", e instanceof Error ? e.message : "Error al calcular costo.");
    }
  }
);

module.exports = {
  getResourcePerTripCost,
};
