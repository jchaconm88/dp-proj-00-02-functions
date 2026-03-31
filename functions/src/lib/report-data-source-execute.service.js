/**
 * Ejecuta el origen de datos de un reporte y devuelve filas planas (F1).
 */

const {
  fetchTripsInDateRange,
  fetchTripChargesByTripId,
  fetchTripAssignmentsByTripId,
} = require("./report-trips-data.service");
const { buildRowsPerTrip, buildRowsPerAssignment } = require("./report-trips-rows.service");
const { isSupportedSourceId } = require("./report-data-sources.registry");
const { resolveRowGranularity } = require("./report-definition-resolve.service");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 93;

function parseIsoDateUtc(s) {
  const t = String(s ?? "").trim();
  if (!ISO_DATE_RE.test(t)) return null;
  const d = new Date(`${t}T00:00:00.000Z`);
  // invalid date guard
  // eslint-disable-next-line no-restricted-globals
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>} params
 * @returns {"perTrip"|"perAssignment"}
 */
function resolveGranularityWithParams(definition, params) {
  const pTpl = String(params.templateId ?? "").trim();
  if (pTpl === "ra-reporte-apoyo") return "perAssignment";
  if (pTpl === "dd-despacho-domicilio") return "perTrip";
  return resolveRowGranularity(definition);
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>} params parámetros de la corrida (dateFrom, dateTo, …)
 * @returns {Promise<{ rows: Record<string, unknown>[], granularity: "perTrip"|"perAssignment", previewInputTruncated?: boolean }>}
 */
async function executeReportDataSource(db, definition, params) {
  const sourceId = String(definition.source ?? "trips").trim() || "trips";
  if (!isSupportedSourceId(sourceId)) {
    throw new Error(`Origen de datos no soportado: "${sourceId}".`);
  }

  const dateFrom = String(params.dateFrom ?? "").trim();
  const dateTo = String(params.dateTo ?? "").trim();
  if (!dateFrom || !dateTo) {
    throw new Error("params.dateFrom y dateTo son obligatorios (YYYY-MM-DD).");
  }
  const dFrom = parseIsoDateUtc(dateFrom);
  const dTo = parseIsoDateUtc(dateTo);
  if (!dFrom || !dTo) {
    throw new Error("params.dateFrom y dateTo deben tener formato YYYY-MM-DD.");
  }
  if (dFrom.getTime() > dTo.getTime()) {
    throw new Error("params.dateFrom no puede ser mayor que dateTo.");
  }
  const diffDays = Math.floor((dTo.getTime() - dFrom.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  if (diffDays > MAX_RANGE_DAYS) {
    throw new Error(`Rango de fechas demasiado grande: máximo ${MAX_RANGE_DAYS} días.`);
  }

  const granularity = resolveGranularityWithParams(definition, params);

  if (sourceId === "trips") {
    const tripsRaw = await fetchTripsInDateRange(db, dateFrom, dateTo);
    const trips = tripsRaw;
    const tripIds = trips.map((t) => t.id);
    const chargesByTrip = await fetchTripChargesByTripId(db, tripIds);
    const assignmentsByTrip = await fetchTripAssignmentsByTripId(db, tripIds);

    let rows =
      granularity === "perTrip"
        ? buildRowsPerTrip(trips, assignmentsByTrip, chargesByTrip)
        : await buildRowsPerAssignment(db, trips, assignmentsByTrip, chargesByTrip);

    let previewInputTruncated = false;
    const previewCap = Number(params.__previewMaxInputRows);
    if (Number.isFinite(previewCap) && previewCap > 0 && rows.length > previewCap) {
      rows = rows.slice(0, previewCap);
      previewInputTruncated = true;
    }

    return { rows, granularity, previewInputTruncated };
  }

  throw new Error(`Sin ejecutor para origen: ${sourceId}`);
}

module.exports = {
  executeReportDataSource,
  resolveGranularityWithParams,
};
