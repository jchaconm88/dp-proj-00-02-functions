/**
 * Copia idempotente de colecciones legacy → nombres kebab-case (ejecutar vía HTTP migración temporal).
 */
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("./firebase");
const {
  runBackfillAccountIdAll,
  runMergeUserRolesToCompanyUsers,
  stripLegacyUserRoleFields,
} = require("./migrate-multiempresa.service");

/**
 * @param {string} from
 * @param {string} to
 * @param {number} limitN
 * @returns {Promise<{ scanned: number, copied: number, skipped: number, from: string, to: string }>}
 */
async function copyRootCollection(from, to, limitN = 400) {
  const snap = await db.collection(from).limit(limitN).get();
  let copied = 0;
  let skipped = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of snap.docs) {
    const destRef = db.collection(to).doc(doc.id);
    // eslint-disable-next-line no-await-in-loop
    const ex = await destRef.get();
    if (ex.exists) {
      skipped += 1;
      continue;
    }
    batch.set(destRef, doc.data() || {});
    copied += 1;
    ops += 1;
    if (ops >= 450) {
      // eslint-disable-next-line no-await-in-loop
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();
  return { scanned: snap.size, copied, skipped, from, to };
}

/**
 * Copia `plans` → `trip-plans` (solo docs raíz; ejecutar antes de usar `plans` para SaaS).
 */
async function copyPlansToTripPlans(limitN = 400) {
  return copyRootCollection("plans", "trip-plans", limitN);
}

/**
 * Copia `routes` + subcolección `stops` → `trip-routes` / `stops`.
 */
async function copyRoutesToTripRoutes(limitRoutes = 100) {
  const snap = await db.collection("routes").limit(limitRoutes).get();
  let routesCopied = 0;
  let routesSkipped = 0;
  let stopsCopied = 0;
  for (const doc of snap.docs) {
    const destRef = db.collection("trip-routes").doc(doc.id);
    // eslint-disable-next-line no-await-in-loop
    const ex = await destRef.get();
    if (ex.exists) {
      routesSkipped += 1;
    } else {
      await destRef.set(doc.data() || {});
      routesCopied += 1;
    }
    const stopsSnap = await doc.ref.collection("stops").get();
    for (const s of stopsSnap.docs) {
      const sDest = destRef.collection("stops").doc(s.id);
      // eslint-disable-next-line no-await-in-loop
      const sEx = await sDest.get();
      if (sEx.exists) continue;
      await sDest.set(s.data() || {});
      stopsCopied += 1;
    }
  }
  return { scanned: snap.size, routesCopied, routesSkipped, stopsCopied };
}

async function copyCompanyUsers(limitN = 400) {
  return copyRootCollection("companyUsers", "company-users", limitN);
}

async function copyReportDefinitions(limitN = 400) {
  return copyRootCollection("reportDefinitions", "report-definitions", limitN);
}

async function copyReportRuns(limitN = 400) {
  return copyRootCollection("reportRuns", "report-runs", limitN);
}

/**
 * Por cada `resources/{id}`, copia subcolección resourceCosts → resource-costs.
 */
async function copyResourceCostsSubcollections(limitResources = 200) {
  const snap = await db.collection("resources").limit(limitResources).get();
  let resourcesScanned = 0;
  let costsCopied = 0;
  for (const doc of snap.docs) {
    resourcesScanned += 1;
    const legacySnap = await doc.ref.collection("resourceCosts").get();
    for (const c of legacySnap.docs) {
      const dest = doc.ref.collection("resource-costs").doc(c.id);
      // eslint-disable-next-line no-await-in-loop
      const ex = await dest.get();
      if (ex.exists) continue;
      await dest.set(c.data() || {});
      costsCopied += 1;
    }
  }
  return { resourcesScanned, costsCopied };
}

/**
 * Por cada company: accountId = companyId si falta; crea `accounts/{accountId}`.
 */
async function bootstrapAccountsFromCompanies(limitN = 300) {
  const snap = await db.collection("companies").limit(limitN).get();
  let companiesUpdated = 0;
  let accountsCreated = 0;
  for (const doc of snap.docs) {
    const companyId = doc.id;
    const d = doc.data() || {};
    let accountId = String(d.accountId ?? "").trim();
    if (!accountId) {
      accountId = companyId;
      await doc.ref.set({ accountId }, { merge: true });
      companiesUpdated += 1;
    }
    const aref = db.collection("accounts").doc(accountId);
    // eslint-disable-next-line no-await-in-loop
    const aex = await aref.get();
    if (!aex.exists) {
      await aref.set(
        {
          name: d.name || companyId,
          status: d.status === "inactive" ? "inactive" : "active",
          createAt: FieldValue.serverTimestamp(),
          createBy: "migration-bootstrap-accounts",
        },
        { merge: false }
      );
      accountsCreated += 1;
    }
  }
  return { scanned: snap.size, companiesUpdated, accountsCreated };
}

/**
 * Doc SaaS por defecto + suscripción activa por account (id doc = accountId).
 */
async function seedDefaultSaasPlanAndSubscriptions(limitAccounts = 200) {
  const planRef = db.collection("plans").doc("default");
  const pSnap = await planRef.get();
  if (!pSnap.exists) {
    await planRef.set(
      {
        name: "Default",
        active: true,
        limits: {
          maxUsers: 1000,
          maxCompanies: 500,
          maxTripsPerMonth: 100000,
        },
        features: { reports: true },
        version: 1,
        createAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  const accSnap = await db.collection("accounts").limit(limitAccounts).get();
  let subscriptionsUpserted = 0;
  for (const a of accSnap.docs) {
    const accountId = a.id;
    const subRef = db.collection("subscriptions").doc(accountId);
    // eslint-disable-next-line no-await-in-loop
    const s = await subRef.get();
    if (s.exists) continue;
    await subRef.set(
      {
        accountId,
        planId: "default",
        status: "active",
        createAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    subscriptionsUpserted += 1;
  }
  return { planSeeded: !pSnap.exists, subscriptionsUpserted, accountsScanned: accSnap.size };
}

/**
 * @param {string} op
 * @param {Record<string, unknown>} data
 */
async function runMigrationOp(op, data = {}) {
  const limit = Math.max(1, Math.min(500, Number(data.limit) || 400));
  switch (op) {
    case "copy-company-users":
      return copyCompanyUsers(limit);
    case "copy-plans-to-trip-plans":
      return copyPlansToTripPlans(limit);
    case "copy-routes-to-trip-routes":
      return copyRoutesToTripRoutes(Math.min(limit, 150));
    case "copy-report-definitions":
      return copyReportDefinitions(limit);
    case "copy-report-runs":
      return copyReportRuns(limit);
    case "copy-resource-costs":
      return copyResourceCostsSubcollections(Math.min(limit, 200));
    case "bootstrap-accounts":
      return bootstrapAccountsFromCompanies(limit);
    case "seed-saas-defaults":
      return seedDefaultSaasPlanAndSubscriptions(limit);
    case "backfill-account-ids": {
      const per = Math.max(1, Math.min(500, Number(data.limitPerCollection) || 200));
      return runBackfillAccountIdAll(per);
    }
    case "merge-user-roles-to-company-users": {
      const companyId = String(data.companyId ?? "").trim();
      return runMergeUserRolesToCompanyUsers(companyId, limit);
    }
    // Tras merge-user-roles + refreshTenantClaims (claim platformAdmin); si no, perderás admin basado solo en users.
    case "strip-legacy-user-roles":
      return stripLegacyUserRoleFields(limit);
    default:
      throw new Error(`Operación de migración desconocida: ${op}`);
  }
}

module.exports = {
  runMigrationOp,
  copyRootCollection,
  copyPlansToTripPlans,
  copyRoutesToTripRoutes,
  copyCompanyUsers,
  copyReportDefinitions,
  copyReportRuns,
  copyResourceCostsSubcollections,
  bootstrapAccountsFromCompanies,
  seedDefaultSaasPlanAndSubscriptions,
};
