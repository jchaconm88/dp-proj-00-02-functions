const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { resolveDraftCodeWithGenerator } = require("../../lib/sequence-code.service");
const { assertCompanyMember } = require("../../lib/tenant-auth");

/**
 * Resuelve el código a persistir (misma regla que DpCodeInput + guardado en la web).
 * - `currentCode` con texto (tras trim) → se devuelve tal cual.
 * - vacío → siguiente correlativo según secuencia activa de `entity`.
 */
const generateSequenceCode = onCall(
  {
    cors: true,
    timeoutSeconds: 30,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para generar códigos.");
    }

    const companyId = String(request.data?.companyId ?? "").trim();
    await assertCompanyMember(db, companyId, request.auth.uid);

    const entity = String(request.data?.entity ?? "").trim();
    if (!entity) {
      throw new HttpsError("invalid-argument", "entity es obligatoria.");
    }

    const currentCode = String(request.data?.currentCode ?? "");

    try {
      const code = await resolveDraftCodeWithGenerator(db, currentCode, entity, { companyId });
      if (!code || !String(code).trim()) {
        throw new HttpsError("internal", "No se pudo resolver el código.");
      }
      return { code: String(code).trim() };
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("No existe una secuencia activa")) {
        throw new HttpsError("failed-precondition", msg);
      }
      throw new HttpsError("internal", msg || "Error al resolver código.");
    }
  }
);

module.exports = {
  generateSequenceCode: generateSequenceCode,
};
