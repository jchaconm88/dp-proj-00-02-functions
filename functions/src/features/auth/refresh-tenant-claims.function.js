const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../../lib/firebase");
const { userIsPlatformAdmin } = require("../../lib/migrate-multiempresa.service");

function membershipHasPlatformAdminSlug(roleIds) {
  const list = Array.isArray(roleIds) ? roleIds : [];
  return list.some((r) => String(r).toLowerCase() === "admin");
}

const refreshTenantClaims = onCall({ cors: true }, async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  const companyId = String(request.data?.companyId ?? "").trim();
  if (!companyId) {
    throw new HttpsError("invalid-argument", "companyId es obligatorio.");
  }
  const uid = request.auth.uid;
  const mid = `${companyId}_${uid}`;
  const mSnap = await db.collection("company-users").doc(mid).get();
  if (!mSnap.exists) {
    throw new HttpsError("permission-denied", "No tienes membresía en esa empresa.");
  }
  if (String(mSnap.data()?.status ?? "active") === "inactive") {
    throw new HttpsError("permission-denied", "Membresía inactiva.");
  }
  const compSnap = await db.collection("companies").doc(companyId).get();
  const accountId = String(compSnap.data()?.accountId ?? companyId).trim() || companyId;

  const userDocSnap = await db.collection("users").doc(uid).get();
  let platformAdmin = userDocSnap.exists ? userIsPlatformAdmin(userDocSnap.data()) : false;
  if (!platformAdmin) {
    platformAdmin = membershipHasPlatformAdminSlug(mSnap.data()?.roleIds);
  }

  const user = await admin.auth().getUser(uid);
  const prev = user.customClaims && typeof user.customClaims === "object" ? { ...user.customClaims } : {};
  prev.accountId = accountId;
  prev.platformAdmin = platformAdmin;
  await admin.auth().setCustomUserClaims(uid, prev);

  return { ok: true, accountId, platformAdmin };
});

module.exports = { refreshTenantClaims };
