const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const { db } = require("../../lib/firebase");
const { assertCompanyMember } = require("../../lib/tenant-auth");
const { periodFromDate, usageDocId } = require("../../lib/usage-months.service");
const {
  composeDashboardSnapshot,
  recomputeTenantCounts,
  snapshotId,
} = require("../../lib/dashboard-snapshots.service");

function periodFromTimestampLike(v) {
  if (v && typeof v === "object" && typeof v.toDate === "function") {
    try {
      return periodFromDate(v.toDate());
    } catch {
      return "";
    }
  }
  const d = new Date(String(v ?? "").trim());
  if (Number.isNaN(d.getTime())) return "";
  return periodFromDate(d);
}

function estimateEmailsSentFromRun(data) {
  if (String(data?.notifyStatus ?? "") !== "sent") return 0;
  const summary = String(data?.notifyRecipientsSummary ?? "").trim();
  const byLabel = summary.match(/^(\d+)\s+destinatarios$/i);
  if (byLabel) {
    const n = Number(byLabel[1]);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  if (summary) {
    const cnt = summary
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.includes("@")).length;
    if (cnt > 0) return cnt;
  }
  return 1;
}

async function aggregateReportRunsForPeriod(accountId, period) {
  const out = {
    reportRuns: 0,
    emailsSent: 0,
    storageBytesUsed: 0,
  };
  let last = null;
  while (true) {
    let q = db.collection("report-runs").where("accountId", "==", accountId).orderBy("__name__").limit(500);
    if (last) q = q.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (periodFromTimestampLike(data.createdAt) !== period) continue;
      out.reportRuns += 1;
      out.emailsSent += estimateEmailsSentFromRun(data);
      const bytes = Number(data?.result?.byteLength ?? 0);
      if (Number.isFinite(bytes) && bytes > 0) out.storageBytesUsed += bytes;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return out;
}

async function aggregateTripsCreatedForPeriod(accountId, period) {
  let total = 0;
  let last = null;
  while (true) {
    let q = db.collection("trips").where("accountId", "==", accountId).orderBy("__name__").limit(500);
    if (last) q = q.startAfter(last);
    // eslint-disable-next-line no-await-in-loop
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (periodFromTimestampLike(data.createdAt) === period) total += 1;
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return total;
}

function usageHasMetricPayload(data) {
  if (!data || typeof data !== "object") return false;
  const ignoredKeys = new Set(["accountId", "period", "createdAt", "updatedAt", "backfilledAt", "companyId"]);
  return Object.entries(data).some(([key, value]) => !ignoredKeys.has(key) && Number.isFinite(Number(value)));
}

async function ensureUsageMonthBackfilled(accountId, period) {
  const usageId = usageDocId(accountId, period);
  const ref = db.collection("usage-months").doc(usageId);
  const current = await ref.get();
  if (current.exists && usageHasMetricPayload(current.data() || {})) return;

  const [runs, tripsCreated] = await Promise.all([
    aggregateReportRunsForPeriod(accountId, period),
    aggregateTripsCreatedForPeriod(accountId, period),
  ]);
  await ref.set(
    {
      accountId,
      period,
      reportRuns: runs.reportRuns,
      emailsSent: runs.emailsSent,
      storageBytesUsed: runs.storageBytesUsed,
      tripsCreated,
      backfilledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

const prepareDashboardSnapshot = onCall(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión para preparar el dashboard.");
    }
    const companyId = String(request.data?.companyId ?? "").trim();
    await assertCompanyMember(db, companyId, request.auth.uid);
    const companySnap = await db.collection("companies").doc(companyId).get();
    const accountId = String(companySnap.data()?.accountId ?? companyId).trim() || companyId;
    const periodRaw = String(request.data?.period ?? "").trim();
    const period = periodRaw || periodFromDate(new Date());
    await ensureUsageMonthBackfilled(accountId, period);
    await recomputeTenantCounts(db, { accountId, companyId });
    await composeDashboardSnapshot(db, {
      accountId,
      companyId,
      period,
    });
    return {
      ok: true,
      accountId,
      period,
      snapshotId: snapshotId(accountId, period),
    };
  }
);

module.exports = {
  prepareDashboardSnapshot,
};
