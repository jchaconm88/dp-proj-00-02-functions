const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { computeFreightPricingFromContract } = require("../../lib/trip-charge-freight-pricing.lib");

const getTripChargeFreightPricing = onCall(
  {
    cors: true,
    timeoutSeconds: 60,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
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
