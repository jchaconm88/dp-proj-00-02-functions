"use strict";

/**
 * @param {FirebaseFirestore.DocumentSnapshot} configSnap
 * @returns {Record<string, unknown>}
 */
function assertSunatConfigActive(configSnap) {
  if (!configSnap.exists) {
    throw new Error("Configuración SUNAT no encontrada para esta empresa.");
  }
  const d = configSnap.data() || {};
  if (d.active === false) {
    throw new Error(
      "La configuración SUNAT está desactivada. Actívala en Facturación → Configuración SUNAT."
    );
  }
  return d;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} companyId
 * @returns {Promise<Record<string, unknown>>}
 */
async function assertActiveSunatConfigForCompany(db, companyId) {
  const compId = String(companyId ?? "").trim();
  if (!compId) throw new Error("companyId es obligatorio.");

  // Normalizado: la configuración vive en docs con ID arbitrario; se selecciona por companyId + active flag.
  const snap = await db
    .collection("sunat-config")
    .where("companyId", "==", compId)
    .limit(25)
    .get();

  if (snap.empty) {
    throw new Error("Configuración SUNAT no encontrada para esta empresa.");
  }

  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const active = docs.find((d) => d.active !== false);
  if (!active) {
    throw new Error(
      "La configuración SUNAT está desactivada. Actívala en Facturación → Configuración SUNAT."
    );
  }
  return active;
}

module.exports = {
  assertSunatConfigActive,
  assertActiveSunatConfigForCompany,
};
