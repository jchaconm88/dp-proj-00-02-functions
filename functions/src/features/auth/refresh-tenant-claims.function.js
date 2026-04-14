const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../../lib/firebase");
const {
  normalizeCode,
  collectMembershipPermissionCodes,
  hasPermission,
} = require("../../lib/permissions");

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

  const rolesSnap = await db.collection("roles").where("companyId", "==", companyId).limit(200).get();
  const rolesById = new Map();
  const rolesByName = new Map();
  for (const roleDoc of rolesSnap.docs) {
    const data = roleDoc.data() || {};
    rolesById.set(normalizeCode(roleDoc.id), data);
    const roleName = normalizeCode(data.name);
    if (roleName) rolesByName.set(roleName, data);
  }

  const permissionCodes = collectMembershipPermissionCodes(mSnap.data(), rolesById, rolesByName);
  const platformAdmin = hasPermission(permissionCodes, "*", "*");
  const canReadUsers = platformAdmin || hasPermission(permissionCodes, "user", "view");

  const user = await admin.auth().getUser(uid);
  const prev = user.customClaims && typeof user.customClaims === "object" ? { ...user.customClaims } : {};
  prev.accountId = accountId;
  prev.platformAdmin = platformAdmin;
  prev.canReadUsers = canReadUsers;
  prev.permissionCodes = permissionCodes;
  await admin.auth().setCustomUserClaims(uid, prev);

  return { ok: true, accountId, platformAdmin, canReadUsers, permissionCodes };
});

module.exports = { refreshTenantClaims };
