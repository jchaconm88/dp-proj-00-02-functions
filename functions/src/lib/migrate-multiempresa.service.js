/**
 * Migración multiempresa (compartido entre callable HTTP y onCall).
 */
const { FieldValue } = require("firebase-admin/firestore");
const { admin, db } = require("./firebase");

/**
 * UID canónico de Firebase Auth para `company-users` y reglas (isMember usa request.auth.uid).
 * El ID del documento `users/{docId}` a veces es distinto al Auth UID (datos legacy).
 */
async function resolveAuthUidForUserDoc(firestoreUserDocId, data) {
  const d = data || {};
  const fromField = String(d.authUid ?? d.firebaseUid ?? "").trim();
  if (fromField) return fromField;

  const email = String(d.email ?? "").trim().toLowerCase();
  if (email) {
    try {
      const rec = await admin.auth().getUserByEmail(email);
      if (rec?.uid) return rec.uid;
    } catch (_) {
      /* usuario no existe en Auth o email distinto */
    }
  }
  return String(firestoreUserDocId ?? "").trim();
}

/** Admin si `role` o `roleIds` (perfiles viejos / app web) incluyen "admin". */
function userIsPlatformAdmin(data) {
  const d = data || {};
  const role = Array.isArray(d.role) ? d.role : [];
  const roleIds = Array.isArray(d.roleIds) ? d.roleIds : [];
  return role.includes("admin") || roleIds.includes("admin");
}

/** Roles para company-users: unión de `role` y `roleIds` del perfil `users`. */
function membershipRoleIdsFromUserDoc(data) {
  const d = data || {};
  const a = Array.isArray(d.roleIds) ? d.roleIds : [];
  const b = Array.isArray(d.role) ? d.role : [];
  return [...new Set([...a, ...b])];
}

/**
 * Comprueba admin en Firestore: solo documentos `users` cuyo campo `email` coincide con lookupEmail.
 */
async function assertPlatformAdmin(lookupEmail) {
  const raw = lookupEmail != null ? String(lookupEmail).trim() : "";
  if (!raw) {
    const err = new Error("Se requiere email para validar permisos.");
    err.code = "invalid-argument";
    throw err;
  }

  let q = await db.collection("users").where("email", "==", raw).limit(10).get();
  if (q.empty && raw !== raw.toLowerCase()) {
    q = await db.collection("users").where("email", "==", raw.toLowerCase()).limit(10).get();
  }

  for (const doc of q.docs) {
    if (userIsPlatformAdmin(doc.data())) return;
  }

  const err = new Error("Solo admin puede ejecutar migraciones.");
  err.code = "permission-denied";
  throw err;
}

async function ensureCompany(companyId, name) {
  const ref = db.collection("companies").doc(companyId);
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set(
    {
      name: name || "Empresa Default",
      status: "active",
      createAt: FieldValue.serverTimestamp(),
      createBy: "migration",
    },
    { merge: false }
  );
}

async function resolveAccountIdForCompany(companyId) {
  const cid = String(companyId ?? "").trim();
  if (!cid) return "";
  const s = await db.collection("companies").doc(cid).get();
  if (!s.exists) return cid;
  const a = String(s.data()?.accountId ?? "").trim();
  return a || cid;
}

async function upsertMembership(companyId, uid, roleIds) {
  const id = `${companyId}_${uid}`;
  const accountId = await resolveAccountIdForCompany(companyId);
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const userEmail = String(userData.email ?? "").trim().toLowerCase();
  const userDisplayName = String(userData.displayName ?? "").trim();
  const user = userDisplayName || userEmail || uid;
  await db
    .collection("company-users")
    .doc(id)
    .set(
      {
        companyId,
        userId: uid,
        user,
        userEmail: userEmail || undefined,
        userDisplayName: userDisplayName || undefined,
        usersDocId: uid,
        accountId,
        status: "active",
        roleIds: Array.isArray(roleIds) ? roleIds : [],
        createAt: FieldValue.serverTimestamp(),
        createBy: "migration",
      },
      { merge: true }
    );
}

async function backfillCollectionCompanyId(collectionName, companyId, limitN) {
  const snap = await db.collection(collectionName).limit(limitN).get();
  let updated = 0;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (d.companyId) continue;
    batch.update(doc.ref, { companyId });
    updated++;
  }
  if (updated > 0) await batch.commit();
  return { scanned: snap.size, updated };
}

const DEFAULT_COLLECTIONS = [
  "roles",
  "modules",
  "sequences",
  "counters",
  "clients",
  "employees",
  "positions",
  "resources",
  "drivers",
  "vehicles",
  "trip-routes",
  "trip-plans",
  "orders",
  "trips",
  "trip-assignments",
  "trip-charges",
  "trip-costs",
  "settlements",
  "transport-contracts",
  "transport-services",
  "document-types",
  "charge-types",
  "report-definitions",
  "report-runs",
];

/**
 * @param {Record<string, unknown>} data - companyId, companyName, seedMemberships, limitPerCollection, collections, email (opcional en cliente; el servidor resuelve lookupEmail)
 * @param {string} lookupEmail - Email con el que se busca en users.email (debe coincidir con el token en la capa HTTP/callable)
 * @returns {Promise<{ ok: boolean; companyId: string; results: Record<string, { scanned: number; updated: number }> }>}
 */
async function runMigrateMultiempresa(data = {}, lookupEmail) {
  await assertPlatformAdmin(lookupEmail);

  const companyId = String(data.companyId ?? "default").trim() || "default";
  const companyName = String(data.companyName ?? "Empresa Default").trim();
  const seedMemberships = data.seedMemberships === true;
  const limitPerCollection = Math.max(1, Math.min(500, Number(data.limitPerCollection) || 200));

  await ensureCompany(companyId, companyName);

  if (seedMemberships) {
    const usersSnap = await db.collection("users").limit(500).get();
    for (const u of usersSnap.docs) {
      const d = u.data() || {};
      const authUid = await resolveAuthUidForUserDoc(u.id, d);
      if (!authUid) continue;

      const roleIds = membershipRoleIdsFromUserDoc(d);
      const wrongId = `${companyId}_${u.id}`;
      if (u.id !== authUid) {
        try {
          await db.collection("company-users").doc(wrongId).delete();
        } catch (_) {
          /* no existía o ya borrado */
        }
      }
      await upsertMembership(companyId, authUid, roleIds);

      if (authUid !== u.id || !d.authUid) {
        try {
          await u.ref.set({ authUid }, { merge: true });
        } catch (_) {
          /* permisos / reglas */
        }
      }
    }
  }

  const collections = Array.isArray(data.collections)
    ? data.collections.map((x) => String(x)).filter(Boolean)
    : DEFAULT_COLLECTIONS;

  const results = {};
  for (const col of collections) {
    results[col] = await backfillCollectionCompanyId(col, companyId, limitPerCollection);
  }

  return { ok: true, companyId, results };
}

/**
 * Añade `accountId` en docs de una colección a partir de `companies/{companyId}.accountId`.
 */
async function backfillAccountIdForCollection(collectionName, limitN) {
  const snap = await db.collection(collectionName).limit(limitN).get();
  let updated = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (d.accountId) continue;
    const cid = String(d.companyId ?? "").trim();
    if (!cid) continue;
    // eslint-disable-next-line no-await-in-loop
    const aid = await resolveAccountIdForCompany(cid);
    if (!aid) continue;
    batch.update(doc.ref, { accountId: aid });
    updated++;
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { scanned: snap.size, updated };
}

async function runBackfillAccountIdAll(limitPerCollection) {
  const results = {};
  for (const col of DEFAULT_COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    results[col] = await backfillAccountIdForCollection(col, limitPerCollection);
  }
  results["company-users"] = await backfillAccountIdForCollection("company-users", limitPerCollection);
  return results;
}

/**
 * Fusiona `users.role` / `users.roleIds` en `company-users` para una empresa (idempotente; unión con roleIds existentes).
 * Repetir con el mismo límite hasta que `merged` sea 0 si hay más de `limitUsers` perfiles.
 *
 * @param {string} companyId
 * @param {number} limitUsers
 * @returns {Promise<{ companyId: string; scanned: number; merged: number; skippedNoRoles: number }>}
 */
async function runMergeUserRolesToCompanyUsers(companyId, limitUsers = 500) {
  const cid = String(companyId ?? "").trim();
  if (!cid) {
    const err = new Error("companyId es obligatorio");
    err.code = "invalid-argument";
    throw err;
  }
  const cap = Math.max(1, Math.min(500, limitUsers));
  const usersSnap = await db.collection("users").limit(cap).get();
  let merged = 0;
  let skippedNoRoles = 0;
  for (const u of usersSnap.docs) {
    const d = u.data() || {};
    const fromUser = membershipRoleIdsFromUserDoc(d);
    if (fromUser.length === 0) {
      skippedNoRoles++;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const authUid = await resolveAuthUidForUserDoc(u.id, d);
    if (!authUid) continue;
    const mid = `${cid}_${authUid}`;
    // eslint-disable-next-line no-await-in-loop
    const mSnap = await db.collection("company-users").doc(mid).get();
    const existing =
      mSnap.exists && Array.isArray(mSnap.data()?.roleIds) ? mSnap.data().roleIds : [];
    const mergedIds = [...new Set([...existing, ...fromUser])];
    const same =
      mergedIds.length === existing.length && mergedIds.every((id) => existing.includes(id));
    if (same) continue;
    // eslint-disable-next-line no-await-in-loop
    await upsertMembership(cid, authUid, mergedIds);
    merged++;
  }
  return {
    companyId: cid,
    scanned: usersSnap.size,
    merged,
    skippedNoRoles,
  };
}

/**
 * Elimina `role` y `roleIds` en documentos `users` (solo tras migrar a company-users y refrescar claims).
 * @param {number} limitN
 */
async function stripLegacyUserRoleFields(limitN = 200) {
  const cap = Math.max(1, Math.min(500, limitN));
  const snap = await db.collection("users").limit(cap).get();
  let stripped = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (!d.role && !d.roleIds) continue;
    batch.update(doc.ref, {
      role: FieldValue.delete(),
      roleIds: FieldValue.delete(),
    });
    stripped++;
    ops++;
    if (ops >= 450) {
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { scanned: snap.size, stripped };
}

module.exports = {
  runMigrateMultiempresa,
  assertPlatformAdmin,
  resolveAccountIdForCompany,
  backfillAccountIdForCollection,
  runBackfillAccountIdAll,
  runMergeUserRolesToCompanyUsers,
  stripLegacyUserRoleFields,
  userIsPlatformAdmin,
  membershipRoleIdsFromUserDoc,
  DEFAULT_COLLECTIONS,
};
