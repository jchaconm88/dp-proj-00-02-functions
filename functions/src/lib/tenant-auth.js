const { HttpsError } = require("firebase-functions/v2/https");

function membershipId(companyId, uid) {
  return `${companyId}_${uid}`;
}

async function assertCompanyMember(db, companyId, uid) {
  const cid = String(companyId ?? "").trim();
  if (!cid) throw new HttpsError("invalid-argument", "companyId es obligatorio.");
  const mid = membershipId(cid, uid);
  const snap = await db.collection("company-users").doc(mid).get();
  if (!snap.exists) throw new HttpsError("permission-denied", "No perteneces a la empresa.");
  const d = snap.data() || {};
  if (String(d.status ?? "active") === "inactive") {
    throw new HttpsError("permission-denied", "Membresía inactiva en la empresa.");
  }
  return { companyId: cid, membershipId: mid, membership: d };
}

module.exports = { assertCompanyMember };

