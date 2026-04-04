const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const { db } = require("../../lib/firebase");
const { periodFromDate, recordMetric } = require("../../lib/usage-months.service");
const {
  composeDashboardSnapshot,
  recomputeTenantCounts,
} = require("../../lib/dashboard-snapshots.service");

async function sumReportRunBytesForAccount(accountId) {
  let total = 0;
  let last = null;
  while (true) {
    let q = db
      .collection("report-runs")
      .where("accountId", "==", accountId)
      .orderBy("__name__")
      .limit(500);
    if (last) q = q.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      if (String(d.status ?? "") !== "completed") continue;
      const b = Number(d?.result?.byteLength ?? 0);
      if (Number.isFinite(b) && b > 0) total += b;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return total;
}

const reconcileUsageMetrics = onSchedule(
  {
    schedule: "every day 03:15",
    timeZone: "Etc/UTC",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    let processed = 0;
    let last = null;
    const period = periodFromDate(new Date());
    while (true) {
      let q = db.collection("accounts").orderBy("__name__").limit(200);
      if (last) q = q.startAfter(last);
      // eslint-disable-next-line no-await-in-loop
      const accSnap = await q.get();
      if (accSnap.empty) break;
      for (const a of accSnap.docs) {
        const accountId = String(a.id ?? "").trim();
        if (!accountId) continue;
        const companyId = String(a.data()?.companyId ?? "").trim();
        // eslint-disable-next-line no-await-in-loop
        const bytes = await sumReportRunBytesForAccount(accountId);
        // eslint-disable-next-line no-await-in-loop
        await recordMetric(db, "storageBytesCurrent", {
          accountId,
          value: bytes,
        });
        // eslint-disable-next-line no-await-in-loop
        const reconciledCounts = await recomputeTenantCounts(db, {
          accountId,
          companyId,
        });
        // eslint-disable-next-line no-await-in-loop
        await composeDashboardSnapshot(db, {
          accountId,
          companyId,
          period,
        });
        processed += 1;
        logger.info("reconcileUsageMetrics: cuenta reconciliada", {
          accountId,
          storageBytesCurrent: bytes,
          counts: reconciledCounts,
        });
      }
      last = accSnap.docs[accSnap.docs.length - 1];
      if (accSnap.size < 200) break;
    }
    logger.info("reconcileUsageMetrics: listo", {
      processed,
      period,
    });
  }
);

module.exports = { reconcileUsageMetrics };

