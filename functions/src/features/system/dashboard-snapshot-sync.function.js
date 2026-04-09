const { logger } = require("firebase-functions");
const { onDocumentCreated, onDocumentDeleted, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db } = require("../../lib/firebase");
const { periodFromDate } = require("../../lib/usage-months.service");
const {
  adjustTenantCount,
  composeDashboardSnapshot,
  listEntityCountCollections,
} = require("../../lib/dashboard-snapshots.service");

async function resolveTenantFromDocData(data = {}) {
  const companyId = String(data.companyId ?? "").trim();
  let accountId = String(data.accountId ?? "").trim();
  if (!accountId && companyId) {
    const companySnap = await db.collection("companies").doc(companyId).get();
    accountId = String(companySnap.data()?.accountId ?? companyId).trim() || companyId;
  }
  return { accountId, companyId };
}

async function applyDeltaAndRefreshSnapshot(collectionName, docData, delta) {
  const trackedCollections = await listEntityCountCollections(db);
  if (!trackedCollections.includes(collectionName)) return;
  const { accountId, companyId } = await resolveTenantFromDocData(docData);
  if (!accountId) return;
  await adjustTenantCount(db, {
    collectionName,
    accountId,
    companyId,
    delta,
  });
  await composeDashboardSnapshot(db, {
    accountId,
    companyId,
    period: periodFromDate(new Date()),
  });
}

const onAnyRootDocCreatedForDashboard = onDocumentCreated("{collectionName}/{docId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data() || {};
  const collectionName = String(event.params.collectionName ?? "").trim();
  if (!collectionName) return;
  await applyDeltaAndRefreshSnapshot(collectionName, data, 1);
});

const onAnyRootDocDeletedForDashboard = onDocumentDeleted("{collectionName}/{docId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data() || {};
  const collectionName = String(event.params.collectionName ?? "").trim();
  if (!collectionName) return;
  await applyDeltaAndRefreshSnapshot(collectionName, data, -1);
});

const onUsageMonthsWrittenForDashboard = onDocumentWritten(
  "usage-months/{usageId}",
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    const data = (after && after.exists ? after.data() : null)
      || (before && before.exists ? before.data() : null)
      || {};
    const accountId = String(data.accountId ?? "").trim();
    if (!accountId) return;
    const period = String(data.period ?? "").trim() || periodFromDate(new Date());
    if (period !== periodFromDate(new Date())) return;
    await composeDashboardSnapshot(db, {
      accountId,
      companyId: String(data.companyId ?? "").trim(),
      period,
    });
  }
);

const onSubscriptionsWrittenForDashboard = onDocumentWritten(
  "subscriptions/{subId}",
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    const data = (after && after.exists ? after.data() : null)
      || (before && before.exists ? before.data() : null)
      || {};
    const accountId = String(data.accountId ?? event.params.subId ?? "").trim();
    if (!accountId) return;
    await composeDashboardSnapshot(db, {
      accountId,
      companyId: String(data.companyId ?? "").trim(),
      period: periodFromDate(new Date()),
    });
  }
);

const onPlansWrittenForDashboard = onDocumentWritten("plans/{planId}", async (event) => {
  const after = event.data?.after;
  const before = event.data?.before;
  const changedPlanId = String(event.params.planId ?? "").trim();
  if (!changedPlanId) return;
  if (!after?.exists && !before?.exists) return;

  let last = null;
  let affected = 0;
  while (true) {
    let q = db
      .collection("subscriptions")
      .where("planId", "==", changedPlanId)
      .orderBy("__name__")
      .limit(200);
    if (last) q = q.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const subs = await q.get();
    if (subs.empty) break;
    for (const s of subs.docs) {
      const d = s.data() || {};
      const accountId = String(d.accountId ?? s.id).trim();
      if (!accountId) continue;
      // eslint-disable-next-line no-await-in-loop
      await composeDashboardSnapshot(db, {
        accountId,
        companyId: String(d.companyId ?? "").trim(),
        period: periodFromDate(new Date()),
      });
      affected += 1;
    }
    last = subs.docs[subs.docs.length - 1];
    if (subs.size < 200) break;
  }
  logger.info("onPlansWrittenForDashboard: snapshots actualizados", {
    planId: changedPlanId,
    affected,
  });
});

module.exports = {
  onAnyRootDocCreatedForDashboard,
  onAnyRootDocDeletedForDashboard,
  onUsageMonthsWrittenForDashboard,
  onSubscriptionsWrittenForDashboard,
  onPlansWrittenForDashboard,
};
