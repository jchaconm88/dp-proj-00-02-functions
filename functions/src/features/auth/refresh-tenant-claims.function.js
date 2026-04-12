const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../../lib/firebase");

function normalizeCode(value) {
  return String(value || "").trim().toLowerCase();
}

function collectRolePermissionCodes(roleData) {
  const d = roleData && typeof roleData === "object" ? roleData : {};
  const out = new Set();

  const legacy = Array.isArray(d.permission) ? d.permission : [];
  for (const item of legacy) {
    const code = normalizeCode(item);
    if (code) out.add(code);
  }

  const mapped = d.permissions && typeof d.permissions === "object" ? d.permissions : {};
  for (const [moduleRaw, actionsRaw] of Object.entries(mapped)) {
    const moduleName = normalizeCode(moduleRaw);
    const actions = Array.isArray(actionsRaw) ? actionsRaw : [];
    if (!moduleName || actions.length === 0) continue;
    for (const actionRaw of actions) {
      const action = normalizeCode(actionRaw);
      if (!action) continue;
      if (moduleName === "*" && action === "*") {
        out.add("*");
        continue;
      }
      if (action === "*") {
        out.add(`*:${moduleName}`);
        continue;
      }
      out.add(`${moduleName}:${action}`);
    }
  }

  return Array.from(out);
}

function collectMembershipPermissionCodes(membershipData, rolesById, rolesByName) {
  const d = membershipData && typeof membershipData === "object" ? membershipData : {};
  const roleIds = Array.isArray(d.roleIds) ? d.roleIds : [];
  const roleNames = Array.isArray(d.roleNames) ? d.roleNames : [];
  const out = new Set();

  for (const raw of roleIds) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const role = rolesById.get(key) || rolesByName.get(key);
    if (!role) continue;
    for (const code of collectRolePermissionCodes(role)) out.add(code);
  }

  for (const raw of roleNames) {
    const key = normalizeCode(raw);
    if (!key) continue;
    const role = rolesByName.get(key);
    if (!role) continue;
    for (const code of collectRolePermissionCodes(role)) out.add(code);
  }

  return Array.from(out);
}

function hasPermission(codes, moduleName, action) {
  const moduleCode = normalizeCode(moduleName);
  const actionCode = normalizeCode(action);
  const set = new Set((Array.isArray(codes) ? codes : []).map((x) => normalizeCode(x)).filter(Boolean));
  return (
    set.has("*")
    || set.has(moduleCode)
    || set.has(`${moduleCode}:${actionCode}`)
    || set.has(`*:${moduleCode}`)
  );
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
