/**
 * Normaliza filas de datos para reportes con origen `trips` (por viaje o por asignación).
 */

const {
  sumTripChargeAmounts,
  sumTripChargeAmountsByChargeType,
  sumChargesForAssignment,
  formatDriverNames,
  formatAssignmentDisplayNames,
  formatDateEs,
  fetchTripStop,
  fetchTripStopsByIds,
} = require("./report-trips-data.service");

/**
 * @param {Array<Record<string, unknown> & { id: string }>} trips
 * @param {Map<string, Array<Record<string, unknown>>>} assignmentsByTrip
 * @param {Map<string, Array<Record<string, unknown>>>} chargesByTrip
 * @returns {Array<Record<string, unknown>>}
 */
function buildRowsPerTrip(trips, assignmentsByTrip, chargesByTrip) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  let no = 1;
  for (const trip of trips) {
    const assigns = assignmentsByTrip.get(trip.id) ?? [];
    const charges = chargesByTrip.get(trip.id) ?? [];
    rows.push({
      no,
      ruta: String(trip.route ?? "").trim(),
      fecha: formatDateEs(String(trip.scheduledStart ?? "")),
      status: String(trip.status ?? "").trim(),
      placa: String(trip.vehicle ?? "").trim(),
      chofer: formatDriverNames(assigns),
      choferEmployee: formatAssignmentDisplayNames(assigns, "employee", { conductorPositionOnly: true }),
      choferResource: formatAssignmentDisplayNames(assigns, "resource", { conductorPositionOnly: true }),
      guias: String(trip.transportGuide ?? "").trim(),
      total: sumTripChargeAmounts(charges),
      totalFlete: sumTripChargeAmountsByChargeType(charges, "Flete"),
      totalApoyoExtra: sumTripChargeAmountsByChargeType(charges, "Apoyo extra"),
      observacion: String(trip.transportService ?? "").trim(),
    });
    no += 1;
  }
  return rows;
}

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Array<Record<string, unknown> & { id: string }>} trips
 * @param {Map<string, Array<Record<string, unknown>>>} assignmentsByTrip
 * @param {Map<string, Array<Record<string, unknown>>>} chargesByTrip
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function buildRowsPerAssignment(db, trips, assignmentsByTrip, chargesByTrip) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];

  for (const trip of trips) {
    const assigns = assignmentsByTrip.get(trip.id) ?? [];
    const charges = chargesByTrip.get(trip.id) ?? [];
    const dia = formatDateEs(String(trip.scheduledStart ?? ""));
    const empresa = String(trip.client ?? "").trim();
    const documento = String(trip.transportGuide ?? "").trim();
    const ruta = String(trip.route ?? "").trim();
    const placa = String(trip.vehicle ?? "").trim();

    const stopIds = assigns
      .map((a) => String((/** @type {Record<string, unknown>} */ (a.scope ?? {})).stopId ?? "").trim())
      .filter(Boolean);
    const stopsById = await fetchTripStopsByIds(db, trip.id, stopIds);

    for (const a of assigns) {
      const scope = /** @type {Record<string, unknown>} */ (a.scope ?? {});
      const stopId = String(scope.stopId ?? "").trim();
      let distrito = "";
      let cliente = "";
      let stopExternalDocument = "";
      let stopObservations = "";
      if (stopId) {
        const stop = stopsById.get(stopId) ?? (await fetchTripStop(db, trip.id, stopId));
        if (stop) {
          distrito = String(stop.districtName ?? "").trim();
          cliente = String(stop.name ?? "").trim();
          stopExternalDocument = String(stop.externalDocument ?? "").trim();
          stopObservations = String(stop.observations ?? "").trim();
        }
      }
      if (!cliente) cliente = empresa;

      const pTotal = sumChargesForAssignment(charges, a);
      const cantidad = 1;
      const pUni = cantidad ? pTotal / cantidad : 0;

      rows.push({
        dia,
        autoriza: String(a.position ?? "").trim(),
        empresa,
        documento,
        cliente,
        distrito,
        stopExternalDocument,
        stopObservations,
        ruta,
        placa,
        nombreApoyo: String(a.displayName ?? "").trim(),
        cantidad,
        producto: String(a.chargeType ?? "").trim(),
        motivo: String(scope.display ?? "").trim(),
        pUni: Math.round(pUni * 100) / 100,
        pTotal,
      });
    }
  }

  return rows;
}

module.exports = {
  buildRowsPerTrip,
  buildRowsPerAssignment,
};
