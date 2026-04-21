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
  const snap = await db.collection("sunat-config").doc(companyId).get();
  return assertSunatConfigActive(snap);
}

module.exports = {
  assertSunatConfigActive,
  assertActiveSunatConfigForCompany,
};
