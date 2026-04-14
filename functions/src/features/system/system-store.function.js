const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db, admin } = require("../../lib/firebase");
const { assertCompanyMember } = require("../../lib/tenant-auth");
const { isGrantedFromAuthToken } = require("../../lib/permissions");

function assertAuthenticated(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
  }
  return request.auth.uid;
}

function assertGranted(request, moduleName, action, message) {
  if (isGrantedFromAuthToken(request.auth, moduleName, action)) return;
  throw new HttpsError("permission-denied", message);
}

function normalizeStatus(value) {
  return String(value ?? "").trim() === "inactive" ? "inactive" : "active";
}

function normalizeText(value) {
  const out = String(value ?? "").trim();
  return out || undefined;
}

async function accountIdForCompany(companyId) {
  const snap = await db.collection("companies").doc(companyId).get();
  return String(snap.data()?.accountId ?? companyId).trim() || companyId;
}

function toRoleRecord(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    companyId: normalizeText(data.companyId),
    name: String(data.name ?? ""),
    description: String(data.description ?? ""),
    permissions: data.permissions && typeof data.permissions === "object" ? data.permissions : {},
    permission: Array.isArray(data.permission) ? data.permission : [],
    createBy: data.createBy,
    createAt: data.createAt,
    updateBy: data.updateBy,
    updateAt: data.updateAt,
  };
}

function toCompanyUserRecord(doc) {
  const data = doc.data() || {};
  const inferredUserId = doc.id.includes("_") ? doc.id.split("_").slice(1).join("_").trim() : "";
  const userId = normalizeText(data.userId) || inferredUserId;
  return {
    id: doc.id,
    companyId: String(data.companyId ?? ""),
    accountId: normalizeText(data.accountId),
    userId,
    user:
      normalizeText(data.user) ||
      normalizeText(data.userDisplayName) ||
      normalizeText(data.userEmail) ||
      userId ||
      undefined,
    usersDocId: normalizeText(data.usersDocId),
    userEmail: normalizeText(data.userEmail),
    userDisplayName: normalizeText(data.userDisplayName),
    roleIds: Array.isArray(data.roleIds) ? data.roleIds.map((x) => String(x).trim()).filter(Boolean) : [],
    roleNames: Array.isArray(data.roleNames) ? data.roleNames.map((x) => String(x).trim()).filter(Boolean) : [],
    status: normalizeStatus(data.status),
  };
}

const systemListUsers = onCall({ cors: true }, async (request) => {
  assertAuthenticated(request);
  assertGranted(request, "user", "view", "No tienes permisos para listar usuarios.");

  const snap = await db.collection("users").limit(200).get();
  const items = snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        email: String(data.email ?? ""),
        displayName: String(data.displayName ?? ""),
      };
    })
    .sort((a, b) => (a.displayName || a.email || a.id).localeCompare(b.displayName || b.email || b.id));

  return { items, last: null };
});

const systemListRolesByCompany = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const companyId = String(request.data?.companyId ?? "").trim();
  if (!companyId) throw new HttpsError("invalid-argument", "companyId es obligatorio.");

  await assertCompanyMember(db, companyId, uid);
  if (!isGrantedFromAuthToken(request.auth, "role", "view")) {
    assertGranted(request, "user", "edit", "No tienes permisos para consultar roles de la empresa.");
  }

  const accountId = await accountIdForCompany(companyId);
  const snap = await db
    .collection("roles")
    .where("companyId", "==", companyId)
    .where("accountId", "==", accountId)
    .get();
  const items = snap.docs.map((doc) => toRoleRecord(doc)).sort((a, b) => a.name.localeCompare(b.name));
  return { items };
});

const systemListCompanyUsers = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const companyId = String(request.data?.companyId ?? "").trim();
  if (!companyId) throw new HttpsError("invalid-argument", "companyId es obligatorio.");

  await assertCompanyMember(db, companyId, uid);
  if (!isGrantedFromAuthToken(request.auth, "user", "view")) {
    assertGranted(request, "user", "edit", "No tienes permisos para consultar miembros de empresa.");
  }

  const snap = await db.collection("company-users").where("companyId", "==", companyId).get();
  const items = snap.docs
    .map((doc) => toCompanyUserRecord(doc))
    .sort((a, b) => (a.user || a.userDisplayName || a.userEmail || a.userId).localeCompare(
      b.user || b.userDisplayName || b.userEmail || b.userId
    ));
  return { items };
});

const systemListMyMemberships = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const legacyUsersDocId = normalizeText(request.data?.legacyUsersDocId);

  const byUserIdSnap = await db.collection("company-users").where("userId", "==", uid).get();
  let docs = byUserIdSnap.docs;
  if (docs.length === 0 && legacyUsersDocId && legacyUsersDocId !== uid) {
    docs = (await db.collection("company-users").where("userId", "==", legacyUsersDocId).get()).docs;
  }

  const items = docs
    .map((doc) => toCompanyUserRecord(doc))
    .sort((a, b) => a.companyId.localeCompare(b.companyId));
  return { items };
});

const systemSaveCompanyMembership = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const companyId = String(request.data?.companyId ?? "").trim();
  const userId = String(request.data?.userId ?? "").trim();
  const roleIds = Array.isArray(request.data?.roleIds)
    ? request.data.roleIds.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const roleNames = Array.isArray(request.data?.roleNames)
    ? request.data.roleNames.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const status = normalizeStatus(request.data?.status);

  if (!companyId || !userId) {
    throw new HttpsError("invalid-argument", "companyId y userId son obligatorios.");
  }
  await assertCompanyMember(db, companyId, uid);
  assertGranted(request, "user", "edit", "No tienes permisos para editar miembros de empresa.");

  const membershipId = `${companyId}_${userId}`;
  const accountId = await accountIdForCompany(companyId);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const updateBy = normalizeText(request.auth?.token?.email) || uid;

  await db.collection("company-users").doc(membershipId).set({
    companyId,
    accountId,
    userId,
    user: normalizeText(request.data?.user),
    usersDocId: normalizeText(request.data?.usersDocId),
    userEmail: normalizeText(request.data?.userEmail)?.toLowerCase(),
    userDisplayName: normalizeText(request.data?.userDisplayName),
    roleIds,
    roleNames,
    status,
    updateAt: now,
    updateBy,
    uid: admin.firestore.FieldValue.delete(),
  }, { merge: true });

  return { id: membershipId };
});

const systemUpdateCompanyUser = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const id = String(request.data?.id ?? "").trim();
  const patch = request.data?.data;
  if (!id || !patch || typeof patch !== "object") {
    throw new HttpsError("invalid-argument", "id y data son obligatorios.");
  }

  const current = await db.collection("company-users").doc(id).get();
  if (!current.exists) {
    throw new HttpsError("not-found", "No existe la membresía a actualizar.");
  }
  const companyId = String(current.data()?.companyId ?? "").trim();
  if (!companyId) throw new HttpsError("failed-precondition", "Membresía sin companyId.");

  await assertCompanyMember(db, companyId, uid);
  assertGranted(request, "user", "edit", "No tienes permisos para editar miembros de empresa.");

  const safePatch = { ...patch };
  if ("uid" in safePatch) delete safePatch.uid;
  if ("userEmail" in safePatch && safePatch.userEmail != null) {
    safePatch.userEmail = String(safePatch.userEmail).trim().toLowerCase();
  }
  if ("status" in safePatch) {
    safePatch.status = normalizeStatus(safePatch.status);
  }
  safePatch.updateAt = admin.firestore.FieldValue.serverTimestamp();
  safePatch.updateBy = normalizeText(request.auth?.token?.email) || uid;
  safePatch.uid = admin.firestore.FieldValue.delete();

  await db.collection("company-users").doc(id).update(safePatch);
  return { ok: true };
});

const systemDeleteCompanyUser = onCall({ cors: true }, async (request) => {
  const uid = assertAuthenticated(request);
  const id = String(request.data?.id ?? "").trim();
  if (!id) throw new HttpsError("invalid-argument", "id es obligatorio.");

  const current = await db.collection("company-users").doc(id).get();
  if (!current.exists) return { ok: true };
  const companyId = String(current.data()?.companyId ?? "").trim();
  if (!companyId) throw new HttpsError("failed-precondition", "Membresía sin companyId.");

  await assertCompanyMember(db, companyId, uid);
  assertGranted(request, "user", "edit", "No tienes permisos para eliminar miembros de empresa.");
  await db.collection("company-users").doc(id).delete();
  return { ok: true };
});

module.exports = {
  systemListUsers,
  systemListRolesByCompany,
  systemListCompanyUsers,
  systemListMyMemberships,
  systemSaveCompanyMembership,
  systemUpdateCompanyUser,
  systemDeleteCompanyUser,
};
