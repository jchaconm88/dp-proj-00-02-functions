const { HttpsError } = require("firebase-functions/v2/https");
const { getMetricConfig } = require("./plan-metrics.config");

const ACTIVE_SUB_STATUSES = new Set(["active", "trial"]);

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} accountId
 */
async function assertAccountSubscriptionActive(db, accountId) {
  const aid = String(accountId ?? "").trim();
  if (!aid) throw new HttpsError("invalid-argument", "accountId es obligatorio.");

  const snap = await db.collection("subscriptions").doc(aid).get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", "No hay suscripción para esta cuenta.");
  }
  const d = snap.data() || {};
  const status = String(d.status ?? "").trim();
  if (!ACTIVE_SUB_STATUSES.has(status)) {
    throw new HttpsError("failed-precondition", `Suscripción no activa (estado: ${status || "—"}).`);
  }
  if (status === "trial") {
    const end = d.trialEndsAt?.toDate?.() ?? null;
    if (end && end.getTime() < Date.now()) {
      throw new HttpsError("failed-precondition", "Período de prueba vencido.");
    }
  }
  return { subscriptionId: snap.id, data: d };
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} accountId
 * @param {string} featureKey
 */
async function checkFeature(db, accountId, featureKey) {
  const sub = await assertAccountSubscriptionActive(db, accountId);
  const planId = String(sub.data.planId ?? "default").trim() || "default";
  const planSnap = await db.collection("plans").doc(planId).get();
  if (!planSnap.exists) return true;
  const f = planSnap.data()?.features;
  if (!f || typeof f !== "object") return true;
  if (!(featureKey in f)) return true;
  return Boolean(f[featureKey]);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} accountId
 * @param {string} metricKey p.ej. "reportRuns"
 * @param {number} incrementBy
 */
async function checkPlanLimit(db, accountId, metricKey, incrementBy = 0) {
  await assertAccountSubscriptionActive(db, accountId);
  const conf = getMetricConfig(metricKey);
  if (!conf) return { ok: true, cap: null, used: null, metricKey, skipped: "metric-not-registered" };
  if (conf.enforcement !== "hard") {
    return { ok: true, cap: null, used: null, metricKey, skipped: "soft-enforcement" };
  }
  if (conf.measureType !== "counterMonthly") {
    return { ok: true, cap: null, used: null, metricKey, skipped: "non-counter-metric" };
  }
  const subSnap = await db.collection("subscriptions").doc(accountId).get();
  const planId = String(subSnap.data()?.planId ?? "default").trim() || "default";
  const planSnap = await db.collection("plans").doc(planId).get();
  const limits = planSnap.data()?.limits;
  const cap = limits && typeof limits === "object" ? Number(limits[conf.limitKey]) : NaN;
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true, cap: null, used: null, metricKey: conf.metricKey };

  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const usageId = `${accountId}_${period}`;
  const uSnap = await db.collection("usage-months").doc(usageId).get();
  const used = Number(uSnap.data()?.[conf.metricKey] ?? 0);
  if (used + incrementBy > cap) {
    throw new HttpsError(
      "resource-exhausted",
      `Límite de plan excedido (${conf.limitKey}; métrica ${conf.metricKey}).`
    );
  }
  return { ok: true, cap, used, metricKey: conf.metricKey, limitKey: conf.limitKey };
}

/**
 * Si existe doc `subscriptions/{accountId}`, aplica estado de suscripción y feature flag.
 * Si no existe suscripción (datos legacy), no hace nada.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} accountId
 * @param {string} featureKey
 */
async function enforceIfSubscriptionExists(db, accountId, featureKey) {
  const aid = String(accountId ?? "").trim();
  if (!aid) return;
  const sub = await db.collection("subscriptions").doc(aid).get();
  if (!sub.exists) return;
  await assertAccountSubscriptionActive(db, aid);
  const ok = await checkFeature(db, aid, featureKey);
  if (!ok) {
    throw new HttpsError("failed-precondition", "Función no habilitada en el plan.");
  }
}

module.exports = {
  assertAccountSubscriptionActive,
  checkFeature,
  checkPlanLimit,
  enforceIfSubscriptionExists,
};
