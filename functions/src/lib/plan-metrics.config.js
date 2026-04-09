/**
 * Registro central de métricas SaaS.
 *
 * - metricKey: clave técnica usada por check/record.
 * - limitKey: clave en plans/{planId}.limits.
 * - measureType:
 *   - counterMonthly: incrementa en usage-months del periodo actual.
 *   - gaugeCurrent: valor absoluto del periodo actual (reconciliación).
 * - enforcement:
 *   - hard: exceder límite bloquea.
 *   - soft: solo observabilidad (no bloquea).
 */
const METRIC_REGISTRY = {
  reportRuns: {
    metricKey: "reportRuns",
    limitKey: "maxReportRunsPerMonth",
    measureType: "counterMonthly",
    enforcement: "hard",
    source: "report-run-created",
  },
  emailsSent: {
    metricKey: "emailsSent",
    limitKey: "maxEmailsPerMonth",
    measureType: "counterMonthly",
    enforcement: "hard",
    source: "report-notify-sent",
  },
  tripsCreated: {
    metricKey: "tripsCreated",
    limitKey: "maxTripsPerMonth",
    measureType: "counterMonthly",
    enforcement: "hard",
    source: "trip-created",
  },
  storageBytesUsed: {
    metricKey: "storageBytesUsed",
    limitKey: "maxStorageBytes",
    measureType: "counterMonthly",
    enforcement: "soft",
    source: "report-file-generated",
  },
  storageBytesCurrent: {
    metricKey: "storageBytesCurrent",
    limitKey: "maxStorageBytes",
    measureType: "gaugeCurrent",
    enforcement: "soft",
    source: "storage-reconcile",
  },
};

function getMetricConfig(metricKey) {
  const key = String(metricKey ?? "").trim();
  return METRIC_REGISTRY[key] || null;
}

async function getMetricConfigDynamic(db, metricKey) {
  const key = String(metricKey ?? "").trim();
  if (!key) return null;
  try {
    const { loadMetricDefinitionByKey } = require("./dashboard-config.service");
    const dynamic = await loadMetricDefinitionByKey(db, key);
    if (!dynamic) return getMetricConfig(key);
    return {
      metricKey: dynamic.metricKey,
      limitKey: String(dynamic.planLimitKey ?? "").trim() || undefined,
      measureType: dynamic.measureType,
      enforcement: dynamic.enforcement,
      source: dynamic.type,
    };
  } catch {
    return getMetricConfig(key);
  }
}

module.exports = {
  METRIC_REGISTRY,
  getMetricConfig,
  getMetricConfigDynamic,
};

