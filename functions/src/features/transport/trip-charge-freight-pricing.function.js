const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { computeFreightPricingFromContract } = require("../../lib/trip-charge-freight-pricing.lib");
const { computeTripCostFromAssignment } = require("../../lib/trip-cost.service");

function mapSupportComputeError(e) {
  switch (e.code) {
    case "MISSING_ENTITY_ID":
      return new HttpsError("failed-precondition", "Falta entityId.");
    case "NO_PER_TRIP_COST":
      return new HttpsError("not-found", "El recurso no tiene costo per_trip activo.");
    case "EMPLOYEE_NOT_FOUND":
      return new HttpsError("not-found", "Empleado no encontrado.");
    case "INVALID_SALARY":
    case "INVALID_AMOUNT":
      return new HttpsError("data-loss", "Datos de monto o salario inválidos.");
    case "INVALID_ENTITY_TYPE":
      return new HttpsError("failed-precondition", "entityType debe ser employee o resource.");
    default:
      return e;
  }
}

async function resolveSupportDisplayName(entityType, entityId) {
  if (entityType === "employee") {
    const snap = await db.collection("employees").doc(entityId).get();
    if (!snap.exists) return "";
    const d = snap.data() || {};
    const name = `${String(d.lastName ?? "").trim()} ${String(d.firstName ?? "").trim()}`.trim();
    return name || String(d.code ?? "").trim() || entityId;
  }
  if (entityType === "resource") {
    const snap = await db.collection("resources").doc(entityId).get();
    if (!snap.exists) return "";
    const d = snap.data() || {};
    const name = `${String(d.lastName ?? "").trim()} ${String(d.firstName ?? "").trim()}`.trim();
    return name || String(d.code ?? "").trim() || entityId;
  }
  return "";
}

const getTripChargeFreightPricing = onCall(
  {
    cors: true,
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const mode = String(request.data?.mode ?? "freight").trim().toLowerCase();

    if (mode === "additional_support") {
      const entityType = String(request.data?.entityType ?? "").trim().toLowerCase();
      const entityId = String(request.data?.entityId ?? "").trim();
      if (entityType !== "employee" && entityType !== "resource") {
        throw new HttpsError("invalid-argument", "entityType debe ser employee o resource.");
      }
      if (!entityId) {
        throw new HttpsError("invalid-argument", "entityId es obligatorio.");
      }
      try {
        const computed = await computeTripCostFromAssignment(
          { entityType, entityId },
          db,
          { allowPartial: false }
        );
        const displayName = await resolveSupportDisplayName(entityType, entityId);
        const basePriceSource =
          entityType === "employee"
            ? "employees.payroll.baseSalary_per_workingDays"
            : "resources.resource-costs.per_trip";
        return {
          amount: computed.amount,
          currency: computed.currency,
          serviceName: displayName,
          contractId: "",
          ruleId: String(computed.resourceCostId ?? "").trim(),
          basePriceSource,
        };
      } catch (e) {
        if (e instanceof HttpsError) throw e;
        const mapped = mapSupportComputeError(e);
        if (mapped instanceof HttpsError) throw mapped;
        throw new HttpsError("internal", e instanceof Error ? e.message : "Error al calcular monto.");
      }
    }

    const clientId = String(request.data?.clientId ?? "").trim();
    const transportServiceId = String(request.data?.transportServiceId ?? "").trim();

    if (!clientId) {
      throw new HttpsError("invalid-argument", "clientId es obligatorio.");
    }
    if (!transportServiceId) {
      throw new HttpsError("invalid-argument", "transportServiceId es obligatorio.");
    }

    const result = await computeFreightPricingFromContract(db, { clientId, transportServiceId });

    if (!result.ok) {
      if (result.reason === "missing_params") {
        throw new HttpsError("invalid-argument", "Parámetros incompletos.");
      }
      if (result.reason === "no_contract") {
        throw new HttpsError("not-found", "No hay contrato asociado a este cliente.");
      }
      if (result.reason === "no_rule") {
        throw new HttpsError(
          "not-found",
          "No hay regla de tarifa activa para este servicio en el contrato del cliente."
        );
      }
      throw new HttpsError("internal", "No se pudo calcular el precio.");
    }

    return {
      amount: result.amount,
      currency: result.currency,
      serviceName: result.serviceName,
      contractId: result.contractId,
      ruleId: result.ruleId,
      basePriceSource: "transport-rate-rules.calculation.basePrice",
    };
  }
);

module.exports = {
  getTripChargeFreightPricing,
};
