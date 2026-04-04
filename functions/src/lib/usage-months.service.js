const { FieldValue } = require("firebase-admin/firestore");
const { getMetricConfig } = require("./plan-metrics.config");

function periodFromDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function usageDocId(accountId, period) {
  return `${String(accountId ?? "").trim()}_${String(period ?? "").trim()}`;
}

async function ensureUsageDoc(tx, db, accountId, period, usageId) {
  const ref = db.collection("usage-months").doc(usageId);
  const snap = await tx.get(ref);
  if (!snap.exists) {
    tx.set(
      ref,
      {
        accountId: String(accountId).trim(),
        period,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
  return ref;
}

async function incrementUsage(db, { accountId, metricKey, delta = 1, period }) {
  const aid = String(accountId ?? "").trim();
  const key = String(metricKey ?? "").trim();
  if (!aid || !key) return null;
  const p = String(period ?? "").trim() || periodFromDate(new Date());
  const usageId = usageDocId(aid, p);
  await db.runTransaction(async (tx) => {
    const ref = await ensureUsageDoc(tx, db, aid, p, usageId);
    tx.set(
      ref,
      {
        [key]: FieldValue.increment(Number(delta) || 0),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  return { usageId, period: p, metricKey: key, delta: Number(delta) || 0 };
}

async function setUsageGauge(db, { accountId, metricKey, value, period }) {
  const aid = String(accountId ?? "").trim();
  const key = String(metricKey ?? "").trim();
  if (!aid || !key) return null;
  const p = String(period ?? "").trim() || periodFromDate(new Date());
  const usageId = usageDocId(aid, p);
  await db.runTransaction(async (tx) => {
    const ref = await ensureUsageDoc(tx, db, aid, p, usageId);
    tx.set(
      ref,
      {
        [key]: Number(value) || 0,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  return { usageId, period: p, metricKey: key, value: Number(value) || 0 };
}

async function recordMetric(db, metricKey, payload = {}) {
  const conf = getMetricConfig(metricKey);
  if (!conf) {
    throw new Error(`Métrica no registrada: ${metricKey}`);
  }
  const aid = String(payload.accountId ?? "").trim();
  if (!aid) return null;
  if (conf.measureType === "gaugeCurrent") {
    return setUsageGauge(db, {
      accountId: aid,
      metricKey: conf.metricKey,
      value: payload.value,
      period: payload.period,
    });
  }
  return incrementUsage(db, {
    accountId: aid,
    metricKey: conf.metricKey,
    delta: payload.delta,
    period: payload.period,
  });
}

module.exports = {
  periodFromDate,
  usageDocId,
  incrementUsage,
  setUsageGauge,
  recordMetric,
};

