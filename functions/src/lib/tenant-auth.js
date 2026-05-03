const { HttpsError } = require("firebase-functions/v2/https");

/** Id de documento en `company-users`: `${companyId}_${uid}`. */
function companyUserDocId(companyId, uid) {
  return `${companyId}_${uid}`;
}

async function assertCompanyUser(db, companyId, uid) {
  const cid = String(companyId ?? "").trim();
  if (!cid) throw new HttpsError("invalid-argument", "companyId es obligatorio.");
  const docId = companyUserDocId(cid, uid);
  const snap = await db.collection("company-users").doc(docId).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "No perteneces a la empresa.");
  const d = snap.data() || {};
  if (String(d.status ?? "active") === "inactive") {
    throw new HttpsError("permission-denied", "Usuario de empresa inactivo.");
  }
  return { companyId: cid, companyUserDocId: docId, companyUser: d };
}

module.exports = { assertCompanyUser, companyUserDocId };
