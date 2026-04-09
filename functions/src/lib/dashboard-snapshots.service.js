const { FieldValue } = require("firebase-admin/firestore");
const { periodFromDate } = require("./usage-months.service");
const {
  loadDashboardConfig,
  listEntityCountCollections,
} = require("./dashboard-config.service");

const SNAPSHOT_COLLECTION = "dashboard-snapshots";
const TENANT_STATS_COLLECTION = "tenant-stats";
const TRACKED_COLLECTIONS = ["trips", "report-runs", "settlements", "clients"];

function snapshotId(accountId, period) {
  return `${String(accountId ?? "").trim()}_${String(period ?? "").trim()}`;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toBytesLabel(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = Math.max(0, value);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const decimals = i === 0 ? 0 : 1;
  return `${n.toFixed(decimals)} ${units[i]}`;
}

function formatValue(value, valueFormat) {
  if (valueFormat === "bytes") return toBytesLabel(value);
  return new Intl.NumberFormat("es-PE").format(value);
}

function progressLabel(used, cap, valueFormat) {
  if (!Number.isFinite(cap) || cap <= 0) return "Sin límite";
  return `${formatValue(used, valueFormat)} / ${formatValue(cap, valueFormat)}`;
}

function normalizeCounts(raw = {}, metrics = []) {
  const out = {};
  for (const metric of metrics) {
    const key = String(metric.metricKey ?? "").trim();
    if (!key) continue;
    out[key] = Math.max(0, toNumber(raw[key]));
  }
  return out;
}

async function loadEntityCountMetrics(db) {
  const conf = await loadDashboardConfig(db);
  return conf.metrics.filter((m) => m.type === "entityCount" && m.active);
}

async function adjustTenantCount(db, { collectionName, accountId, companyId, delta }) {
  const aid = String(accountId ?? "").trim();
  const col = String(collectionName ?? "").trim();
  if (!aid || !col) return null;
  const deltaNum = Number(delta) || 0;
  if (deltaNum === 0) return null;
  const metrics = await loadEntityCountMetrics(db);
  const affected = metrics.filter((m) => String(m.source?.collectionName ?? "").trim() === col);
  if (affected.length === 0) return null;
  const ref = db.collection(TENANT_STATS_COLLECTION).doc(aid);
  const countIncrements = {};
  for (const metric of affected) {
    countIncrements[metric.metricKey] = FieldValue.increment(deltaNum);
  }
  await ref.set(
    {
      accountId: aid,
      companyId: String(companyId ?? "").trim() || null,
      counts: countIncrements,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { accountId: aid, metricKeys: affected.map((m) => m.metricKey), delta: deltaNum };
}

async function recomputeTenantCounts(db, { accountId, companyId }) {
  const aid = String(accountId ?? "").trim();
  if (!aid) return null;
  const metrics = await loadEntityCountMetrics(db);
  const out = {};
  for (const metric of metrics) {
    const col = String(metric.source?.collectionName ?? "").trim();
    if (!col) continue;
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection(col).where("accountId", "==", aid).get();
    out[metric.metricKey] = snap.size;
  }
  await db.collection(TENANT_STATS_COLLECTION).doc(aid).set(
    {
      accountId: aid,
      companyId: String(companyId ?? "").trim() || null,
      counts: out,
      updatedAt: FieldValue.serverTimestamp(),
      reconciledAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return out;
}

async function loadPlanLimits(db, accountId) {
  const subSnap = await db.collection("subscriptions").doc(accountId).get();
  if (!subSnap.exists) return {};
  const sub = subSnap.data() || {};
  const planId = String(sub.planId ?? "").trim();
  if (!planId) return {};
  const planSnap = await db.collection("plans").doc(planId).get();
  if (!planSnap.exists) return {};
  const plan = planSnap.data() || {};
  return plan && typeof plan.limits === "object" ? plan.limits : {};
}

function usageCardFromWidget(widget, usageRaw, planLimits) {
  const used = toNumber(usageRaw[widget.metricKey || ""]);
  const capRaw = widget.planLimitKey ? planLimits[widget.planLimitKey] : null;
  const cap = Number.isFinite(Number(capRaw)) ? Number(capRaw) : null;
  const pct = cap && cap > 0 ? Math.max(0, Math.min(100, Math.round((used / cap) * 100))) : null;
  return {
    id: widget.cardKey || widget.id,
    title: widget.title,
    subtitle: widget.subtitle,
    icon: widget.icon,
    accentClass: widget.accentClass,
    value: formatValue(used, widget.valueFormat || "number"),
    progressPct: pct,
    progressLabel: progressLabel(used, cap, widget.valueFormat || "number"),
    href: widget.href,
  };
}

function collectionCardFromWidget(widget, counts, metric) {
  const value = Math.max(0, toNumber(counts[metric.metricKey]));
  return {
    id: widget.cardKey || widget.id,
    title: widget.title,
    subtitle: widget.subtitle,
    icon: widget.icon,
    accentClass: widget.accentClass,
    value: formatValue(value, widget.valueFormat || "number"),
    progressPct: null,
    progressLabel: "Total tenant",
    href: widget.href,
  };
}

function mapReportActivity(doc) {
  return {
    id: doc.id,
    title: String(doc.reportDefinitionId ?? doc.id),
    meta: String(doc.outputFormat ?? "xlsx").toUpperCase(),
    status: String(doc.status ?? "pending"),
    href: String(doc.reportDefinitionId ?? "").trim()
      ? `/reports/${String(doc.reportDefinitionId).trim()}/runs`
      : "/reports",
  };
}

function mapTripActivity(doc) {
  return {
    id: doc.id,
    title: String(doc.code ?? doc.id),
    meta: String(doc.route ?? "").trim() || "Sin ruta",
    status: String(doc.status ?? "open"),
    href: `/transport/trips/edit/${doc.id}`,
  };
}

async function loadActivity(db, accountId, companyId) {
  const reportQuery = companyId
    ? db.collection("report-runs").where("accountId", "==", accountId).where("companyId", "==", companyId)
    : db.collection("report-runs").where("accountId", "==", accountId);
  const tripQuery = companyId
    ? db.collection("trips").where("accountId", "==", accountId).where("companyId", "==", companyId)
    : db.collection("trips").where("accountId", "==", accountId);
  const [reportSnap, tripSnap] = await Promise.all([reportQuery.limit(5).get(), tripQuery.limit(5).get()]);
  return {
    activityReports: reportSnap.docs.map((d) => mapReportActivity({ id: d.id, ...(d.data() || {}) })),
    activityTrips: tripSnap.docs.map((d) => mapTripActivity({ id: d.id, ...(d.data() || {}) })),
  };
}

async function composeDashboardSnapshot(db, { accountId, companyId, period }) {
  const aid = String(accountId ?? "").trim();
  if (!aid) return null;
  const p = String(period ?? "").trim() || periodFromDate(new Date());
  const usageId = snapshotId(aid, p);
  const [usageSnap, statsSnap, limits, activity, dashboardConfig] = await Promise.all([
    db.collection("usage-months").doc(usageId).get(),
    db.collection(TENANT_STATS_COLLECTION).doc(aid).get(),
    loadPlanLimits(db, aid),
    loadActivity(db, aid, String(companyId ?? "").trim()),
    loadDashboardConfig(db),
  ]);
  const usageRaw = usageSnap.exists ? usageSnap.data() || {} : {};
  const metricsByKey = new Map(dashboardConfig.metrics.map((m) => [m.metricKey, m]));
  const counts = normalizeCounts(statsSnap.exists ? (statsSnap.data() || {}).counts : {}, dashboardConfig.metrics);
  const cards = dashboardConfig.cards
    .map((card) => {
      const metric = metricsByKey.get(card.metricKey);
      if (!metric) return null;
      const enriched = {
        ...card,
        metricKey: metric.metricKey,
        planLimitKey: metric.planLimitKey,
        valueFormat: card.valueFormat || metric.valueFormat || "number",
      };
      if (metric.type === "entityCount") return collectionCardFromWidget(enriched, counts, metric);
      return usageCardFromWidget(enriched, usageRaw, limits);
    })
    .filter(Boolean);
  const doc = {
    accountId: aid,
    companyId: String(companyId ?? "").trim() || null,
    period: p,
    counts,
    usage: usageRaw,
    cards,
    activityReports: activity.activityReports,
    activityTrips: activity.activityTrips,
    configSource: dashboardConfig.source,
    updatedAt: FieldValue.serverTimestamp(),
  };
  await db.collection(SNAPSHOT_COLLECTION).doc(snapshotId(aid, p)).set(doc, { merge: true });
  return doc;
}

module.exports = {
  TRACKED_COLLECTIONS,
  SNAPSHOT_COLLECTION,
  TENANT_STATS_COLLECTION,
  snapshotId,
  adjustTenantCount,
  recomputeTenantCounts,
  composeDashboardSnapshot,
  listEntityCountCollections,
};
