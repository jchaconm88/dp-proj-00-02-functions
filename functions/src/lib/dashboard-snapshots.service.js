const { FieldValue } = require("firebase-admin/firestore");
const { DASHBOARD_WIDGETS } = require("./dashboard-widgets.config");
const { periodFromDate } = require("./usage-months.service");

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

function toCountFieldName(collectionName) {
  if (collectionName === "report-runs") return "reportRuns";
  if (collectionName === "settlements") return "settlements";
  if (collectionName === "clients") return "clients";
  return "trips";
}

function normalizeCounts(raw = {}) {
  return {
    trips: Math.max(0, toNumber(raw.trips)),
    reportRuns: Math.max(0, toNumber(raw.reportRuns)),
    settlements: Math.max(0, toNumber(raw.settlements)),
    clients: Math.max(0, toNumber(raw.clients)),
  };
}

async function adjustTenantCount(db, { collectionName, accountId, companyId, delta }) {
  const aid = String(accountId ?? "").trim();
  const col = String(collectionName ?? "").trim();
  if (!aid || !TRACKED_COLLECTIONS.includes(col)) return null;
  const deltaNum = Number(delta) || 0;
  if (deltaNum === 0) return null;
  const field = toCountFieldName(col);
  const ref = db.collection(TENANT_STATS_COLLECTION).doc(aid);
  await ref.set(
    {
      accountId: aid,
      companyId: String(companyId ?? "").trim() || null,
      counts: {
        [field]: FieldValue.increment(deltaNum),
      },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return { accountId: aid, field, delta: deltaNum };
}

async function recomputeTenantCounts(db, { accountId, companyId }) {
  const aid = String(accountId ?? "").trim();
  if (!aid) return null;
  const out = { trips: 0, reportRuns: 0, settlements: 0, clients: 0 };
  for (const col of TRACKED_COLLECTIONS) {
    // eslint-disable-next-line no-await-in-loop
    const snap = await db.collection(col).where("accountId", "==", aid).get();
    if (col === "report-runs") out.reportRuns = snap.size;
    if (col === "settlements") out.settlements = snap.size;
    if (col === "clients") out.clients = snap.size;
    if (col === "trips") out.trips = snap.size;
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
  const capRaw = widget.limitKey ? planLimits[widget.limitKey] : null;
  const cap = Number.isFinite(Number(capRaw)) ? Number(capRaw) : null;
  const pct = cap && cap > 0 ? Math.max(0, Math.min(100, Math.round((used / cap) * 100))) : null;
  return {
    id: widget.id,
    title: widget.title,
    subtitle: widget.subtitle,
    icon: widget.icon,
    accentClass: widget.accentClass,
    value: formatValue(used, widget.valueFormat),
    progressPct: pct,
    progressLabel: progressLabel(used, cap, widget.valueFormat),
    href: widget.href,
  };
}

function collectionCardFromWidget(widget, counts) {
  const field = toCountFieldName(widget.collectionName || "");
  const value = Math.max(0, toNumber(counts[field]));
  return {
    id: widget.id,
    title: widget.title,
    subtitle: widget.subtitle,
    icon: widget.icon,
    accentClass: widget.accentClass,
    value: formatValue(value, widget.valueFormat),
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
  const [usageSnap, statsSnap, limits, activity] = await Promise.all([
    db.collection("usage-months").doc(usageId).get(),
    db.collection(TENANT_STATS_COLLECTION).doc(aid).get(),
    loadPlanLimits(db, aid),
    loadActivity(db, aid, String(companyId ?? "").trim()),
  ]);
  const usageRaw = usageSnap.exists ? usageSnap.data() || {} : {};
  const counts = normalizeCounts(statsSnap.exists ? (statsSnap.data() || {}).counts : {});
  const cards = DASHBOARD_WIDGETS.map((widget) => {
    if (widget.kind === "usage") return usageCardFromWidget(widget, usageRaw, limits);
    return collectionCardFromWidget(widget, counts);
  });
  const doc = {
    accountId: aid,
    companyId: String(companyId ?? "").trim() || null,
    period: p,
    counts,
    usage: usageRaw,
    cards,
    activityReports: activity.activityReports,
    activityTrips: activity.activityTrips,
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
};
