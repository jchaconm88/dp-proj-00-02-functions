/**
 * Migración multiempresa (compartido entre callable HTTP y onCall).
 */
const { FieldValue } = require("firebase-admin/firestore");
const { admin, db } = require("./firebase");

/**
 * UID canónico de Firebase Auth para `companyUsers` y reglas (isMember usa request.auth.uid).
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

/** Roles para companyUsers: unión de `role` y `roleIds` del perfil. */
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

async function upsertMembership(companyId, uid, roleIds) {
  const id = `${companyId}_${uid}`;
  await db
    .collection("companyUsers")
    .doc(id)
    .set(
      {
        companyId,
        uid,
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
  "routes",
  "plans",
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
  "reportDefinitions",
  "reportRuns",
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
          await db.collection("companyUsers").doc(wrongId).delete();
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

module.exports = {
  runMigrateMultiempresa,
  assertPlatformAdmin,
};
