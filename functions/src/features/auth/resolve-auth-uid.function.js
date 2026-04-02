const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../../lib/firebase");

const COMPANY_ADMIN_MARKER = "__company_admin__";

function userIsPlatformAdmin(data) {
  const d = data || {};
  const role = Array.isArray(d.role) ? d.role : [];
  const roleIds = Array.isArray(d.roleIds) ? d.roleIds : [];
  return role.includes("admin") || roleIds.includes("admin");
}

async function assertCanResolveUsersByEmail(uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  if (userSnap.exists && userIsPlatformAdmin(userSnap.data())) return;

  const q = await db.collection("companyUsers").where("uid", "==", uid).limit(50).get();
  for (const doc of q.docs) {
    const d = doc.data() || {};
    if (d.status === "inactive") continue;
    const roleIds = Array.isArray(d.roleIds) ? d.roleIds : [];
    if (roleIds.includes(COMPANY_ADMIN_MARKER)) return;
  }

  throw new HttpsError("permission-denied", "Sin permiso para resolver usuarios por email.");
}

const resolveAuthUidByEmail = onCall({ cors: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  await assertCanResolveUsersByEmail(request.auth.uid);

  const email = String(request.data?.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new HttpsError("invalid-argument", "Se requiere email.");
  }

  try {
    const u = await admin.auth().getUserByEmail(email);
    return { uid: u.uid, email: u.email ?? email };
  } catch {
    throw new HttpsError("not-found", "No hay usuario en Authentication con ese email.");
  }
});

module.exports = { resolveAuthUidByEmail };
