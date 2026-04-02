const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { runMigrateMultiempresa } = require("../../../lib/migrate-multiempresa.service");

const migrateMultiempresa = onCall(
  { cors: true, timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    try {
      const data = request.data && typeof request.data === "object" ? request.data : {};
      const tokenEmail = request.auth.token?.email
        ? String(request.auth.token.email).trim()
        : "";
      const sent =
        typeof data.email === "string" && String(data.email).trim()
          ? String(data.email).trim()
          : "";
      const lookupEmail = sent || tokenEmail;
      if (!lookupEmail) {
        throw new HttpsError(
          "invalid-argument",
          "Se requiere email en los datos o un token que incluya email."
        );
      }
      if (sent && tokenEmail && sent.toLowerCase() !== tokenEmail.toLowerCase()) {
        throw new HttpsError(
          "permission-denied",
          "El email enviado no coincide con la cuenta autenticada."
        );
      }
      return await runMigrateMultiempresa(data, lookupEmail);
    } catch (e) {
      if (e && e.code === "permission-denied") {
        throw new HttpsError("permission-denied", e.message || "Sin permiso.");
      }
      throw new HttpsError("internal", e instanceof Error ? e.message : "Error en migración.");
    }
  }
);

module.exports = { migrateMultiempresa };
