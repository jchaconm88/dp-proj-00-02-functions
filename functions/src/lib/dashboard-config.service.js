const { DASHBOARD_WIDGETS } = require("./dashboard-widgets.config");
const { METRIC_REGISTRY } = require("./plan-metrics.config");

const METRIC_DEFINITIONS_COLLECTION = "metric-definitions";
const DASHBOARD_CARD_DEFINITIONS_COLLECTION = "dashboard-card-definitions";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toStringOrEmpty(value) {
  return String(value ?? "").trim();
}

function normalizeMetricType(value) {
  const v = toStringOrEmpty(value);
  if (v === "entityCount" || v === "sum" || v === "custom") return v;
  return "custom";
}

function normalizeMeasureType(value, metricType) {
  const v = toStringOrEmpty(value);
  if (v === "counterMonthly" || v === "gaugeCurrent") return v;
  if (metricType === "entityCount") return "gaugeCurrent";
  return "counterMonthly";
}

function normalizeEnforcement(value) {
  const v = toStringOrEmpty(value);
  if (v === "hard" || v === "soft" || v === "none") return v;
  return "none";
}

function normalizeValueFormat(value) {
  const v = toStringOrEmpty(value);
  return v === "bytes" ? "bytes" : "number";
}

function isActive(value) {
  return value !== false;
}

function toCountFieldName(collectionName) {
  const raw = toStringOrEmpty(collectionName);
  if (!raw) return "unknownCount";
  const normalized = raw.replace(/[^a-zA-Z0-9]+([a-zA-Z0-9])/g, (_, c) => String(c).toUpperCase());
  const clean = normalized.replace(/[^a-zA-Z0-9]/g, "");
  return clean ? `${clean}Count` : "unknownCount";
}

function metricFromLegacyWidget(widget) {
  if (!widget || typeof widget !== "object") return null;
  const kind = toStringOrEmpty(widget.kind);
  if (kind === "collection") {
    const collectionName = toStringOrEmpty(widget.collectionName);
    if (!collectionName) return null;
    const metricKey = toCountFieldName(collectionName);
    return {
      id: metricKey,
      metricKey,
      label: widget.title || metricKey,
      description: `Conteo total de documentos en ${collectionName}.`,
      type: "entityCount",
      measureType: "gaugeCurrent",
      enforcement: "none",
      source: {
        collectionName,
      },
      valueFormat: normalizeValueFormat(widget.valueFormat),
      active: true,
    };
  }
  if (kind === "usage") {
    const metricKey = toStringOrEmpty(widget.metricKey);
    if (!metricKey) return null;
    const conf = METRIC_REGISTRY[metricKey] || {};
    return {
      id: metricKey,
      metricKey,
      label: widget.title || metricKey,
      description: `Métrica de uso ${metricKey}.`,
      type: "custom",
      measureType: conf.measureType || "counterMonthly",
      enforcement: normalizeEnforcement(conf.enforcement),
      planLimitKey: toStringOrEmpty(widget.limitKey || conf.limitKey),
      source: {
        collectionName: null,
      },
      valueFormat: normalizeValueFormat(widget.valueFormat),
      active: true,
    };
  }
  return null;
}

function cardFromLegacyWidget(widget, index) {
  if (!widget || typeof widget !== "object") return null;
  const kind = toStringOrEmpty(widget.kind);
  let metricKey = "";
  if (kind === "collection") metricKey = toCountFieldName(widget.collectionName);
  if (kind === "usage") metricKey = toStringOrEmpty(widget.metricKey);
  if (!metricKey) return null;
  return {
    id: toStringOrEmpty(widget.id) || `card-${index + 1}`,
    cardKey: toStringOrEmpty(widget.id) || `card-${index + 1}`,
    metricKey,
    title: toStringOrEmpty(widget.title) || metricKey,
    subtitle: toStringOrEmpty(widget.subtitle) || "",
    icon: toStringOrEmpty(widget.icon) || "chart-line",
    accentClass: toStringOrEmpty(widget.accentClass) || "text-slate-600",
    href: toStringOrEmpty(widget.href) || null,
    order: toNumber(index),
    visible: true,
    valueFormat: normalizeValueFormat(widget.valueFormat),
    active: true,
  };
}

function normalizeMetricDefinition(docId, raw = {}) {
  const metricType = normalizeMetricType(raw.type);
  const metricKey = toStringOrEmpty(raw.metricKey) || toStringOrEmpty(docId);
  const sourceRaw = raw.source && typeof raw.source === "object" ? raw.source : {};
  return {
    id: toStringOrEmpty(docId) || metricKey,
    metricKey,
    label: toStringOrEmpty(raw.label) || metricKey,
    description: toStringOrEmpty(raw.description),
    type: metricType,
    measureType: normalizeMeasureType(raw.measureType, metricType),
    planLimitKey: toStringOrEmpty(raw.planLimitKey),
    enforcement: normalizeEnforcement(raw.enforcement),
    source: {
      collectionName: toStringOrEmpty(sourceRaw.collectionName),
      valueField: toStringOrEmpty(sourceRaw.valueField),
      filters: Array.isArray(sourceRaw.filters) ? sourceRaw.filters : [],
    },
    valueFormat: normalizeValueFormat(raw.valueFormat),
    active: isActive(raw.active),
  };
}

function normalizeCardDefinition(docId, raw = {}) {
  return {
    id: toStringOrEmpty(docId) || toStringOrEmpty(raw.cardKey),
    cardKey: toStringOrEmpty(raw.cardKey) || toStringOrEmpty(docId),
    metricKey: toStringOrEmpty(raw.metricKey),
    title: toStringOrEmpty(raw.title),
    subtitle: toStringOrEmpty(raw.subtitle),
    icon: toStringOrEmpty(raw.icon) || "chart-line",
    accentClass: toStringOrEmpty(raw.accentClass) || "text-slate-600",
    href: toStringOrEmpty(raw.href),
    order: toNumber(raw.order),
    visible: raw.visible !== false,
    valueFormat: normalizeValueFormat(raw.valueFormat),
    active: isActive(raw.active),
  };
}

function legacyDefaults() {
  const metricMap = new Map();
  for (const w of DASHBOARD_WIDGETS) {
    const metric = metricFromLegacyWidget(w);
    if (metric) metricMap.set(metric.metricKey, metric);
  }
  const cards = DASHBOARD_WIDGETS.map((w, i) => cardFromLegacyWidget(w, i)).filter(Boolean);
  return {
    metrics: Array.from(metricMap.values()),
    cards,
  };
}

async function loadDashboardConfig(db) {
  const [metricSnap, cardSnap] = await Promise.all([
    db.collection(METRIC_DEFINITIONS_COLLECTION).where("active", "!=", false).get(),
    db.collection(DASHBOARD_CARD_DEFINITIONS_COLLECTION).where("active", "!=", false).get(),
  ]);

  const metricDefs = metricSnap.docs
    .map((d) => normalizeMetricDefinition(d.id, d.data() || {}))
    .filter((m) => m.metricKey && m.active);

  const cardDefs = cardSnap.docs
    .map((d) => normalizeCardDefinition(d.id, d.data() || {}))
    .filter((c) => c.cardKey && c.metricKey && c.active && c.visible)
    .sort((a, b) => a.order - b.order || a.cardKey.localeCompare(b.cardKey));

  if (metricDefs.length === 0 || cardDefs.length === 0) {
    const legacy = legacyDefaults();
    return {
      metrics: metricDefs.length > 0 ? metricDefs : legacy.metrics,
      cards: cardDefs.length > 0 ? cardDefs : legacy.cards,
      source: "legacy-fallback",
    };
  }

  return {
    metrics: metricDefs,
    cards: cardDefs,
    source: "firestore",
  };
}

async function loadMetricDefinitionByKey(db, metricKey) {
  const key = toStringOrEmpty(metricKey);
  if (!key) return null;

  const direct = await db.collection(METRIC_DEFINITIONS_COLLECTION).doc(key).get();
  if (direct.exists && direct.data()?.active !== false) {
    return normalizeMetricDefinition(direct.id, direct.data() || {});
  }

  const q = await db
    .collection(METRIC_DEFINITIONS_COLLECTION)
    .where("metricKey", "==", key)
    .where("active", "!=", false)
    .limit(1)
    .get();
  if (!q.empty) {
    const doc = q.docs[0];
    return normalizeMetricDefinition(doc.id, doc.data() || {});
  }

  const legacy = legacyDefaults().metrics.find((m) => m.metricKey === key);
  return legacy || null;
}

async function listEntityCountCollections(db) {
  const conf = await loadDashboardConfig(db);
  const collections = new Set();
  for (const metric of conf.metrics) {
    if (metric.type !== "entityCount") continue;
    const collectionName = toStringOrEmpty(metric.source?.collectionName);
    if (collectionName) collections.add(collectionName);
  }
  return Array.from(collections);
}

module.exports = {
  METRIC_DEFINITIONS_COLLECTION,
  DASHBOARD_CARD_DEFINITIONS_COLLECTION,
  toCountFieldName,
  normalizeMetricDefinition,
  normalizeCardDefinition,
  loadDashboardConfig,
  loadMetricDefinitionByKey,
  listEntityCountCollections,
  legacyDefaults,
};
