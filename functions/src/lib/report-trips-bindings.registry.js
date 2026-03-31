/**
 * Catálogo de bindings: id estable → clave en la fila plana (outputKey) + granularidad.
 * El usuario elige `bindingId`; el Excel sigue leyendo `outputKey` del objeto fila.
 */

/** @type {Array<{ id: string, outputKey: string, granularities: ("perTrip"|"perAssignment")[], group: string, label: string, mapFrom: string }>} */
const TRIP_REPORT_BINDINGS = [
  // —— perTrip (una fila por viaje)
  {
    id: "trip.row.index",
    outputKey: "no",
    granularities: ["perTrip"],
    group: "Viaje",
    label: "Número de orden",
    mapFrom: "Índice secuencial en el resultado del reporte",
  },
  {
    id: "trip.route.display",
    outputKey: "ruta",
    granularities: ["perTrip", "perAssignment"],
    group: "Viaje",
    label: "Ruta (texto)",
    mapFrom: "trip.route",
  },
  {
    id: "trip.scheduledStart.dateEs",
    outputKey: "fecha",
    granularities: ["perTrip"],
    group: "Viaje",
    label: "Fecha programada",
    mapFrom: "trip.scheduledStart (dd/mm/yyyy)",
  },
  {
    id: "trip.status",
    outputKey: "status",
    granularities: ["perTrip"],
    group: "Viaje",
    label: "Estado de viaje",
    mapFrom: "trip.status",
  },
  {
    id: "trip.vehicle.plate",
    outputKey: "placa",
    granularities: ["perTrip", "perAssignment"],
    group: "Viaje",
    label: "Placa vehículo",
    mapFrom: "trip.vehicle",
  },
  {
    id: "assignment.driver.displayNames.both",
    outputKey: "chofer",
    granularities: ["perTrip"],
    group: "Asignaciones",
    label: "Conductor (posición Conductor)",
    mapFrom:
      "trip-assignments: displayName donde position normalizada = «conductor» y entityType es employee o resource",
  },
  {
    id: "assignment.driver.displayNames.employee",
    outputKey: "choferEmployee",
    granularities: ["perTrip"],
    group: "Asignaciones",
    label: "Conductor solo empleado",
    mapFrom:
      "trip-assignments: displayName donde position = Conductor y entityType = employee",
  },
  {
    id: "assignment.driver.displayNames.resource",
    outputKey: "choferResource",
    granularities: ["perTrip"],
    group: "Asignaciones",
    label: "Conductor solo recurso",
    mapFrom:
      "trip-assignments: displayName donde position = Conductor y entityType = resource",
  },
  {
    id: "trip.transportGuide",
    outputKey: "guias",
    granularities: ["perTrip", "perAssignment"],
    group: "Viaje",
    label: "Guía de transporte",
    mapFrom: "trip.transportGuide",
  },
  {
    id: "trip.charges.sumAmount",
    outputKey: "total",
    granularities: ["perTrip"],
    group: "Cargos",
    label: "Total cargos del viaje",
    mapFrom: "Suma trip-charges.amount (no cancelados) del viaje",
  },
  {
    id: "trip.charges.sumByChargeType.flete",
    outputKey: "totalFlete",
    granularities: ["perTrip"],
    group: "Cargos",
    label: "Total cargos por flete",
    mapFrom: "Suma trip-charges.amount donde chargeType = \"Flete\" (no cancelados)",
  },
  {
    id: "trip.charges.sumByChargeType.apoyoExtra",
    outputKey: "totalApoyoExtra",
    granularities: ["perTrip"],
    group: "Cargos",
    label: "Total cargos por apoyo extra",
    mapFrom: "Suma trip-charges.amount donde chargeType = \"Apoyo extra\" (no cancelados)",
  },
  {
    id: "trip.transportService.note",
    outputKey: "observacion",
    granularities: ["perTrip"],
    group: "Viaje",
    label: "Observación / servicio",
    mapFrom: "trip.transportService",
  },
  // —— perAssignment
  {
    id: "trip.scheduledStart.dateEs.assignmentRow",
    outputKey: "dia",
    granularities: ["perAssignment"],
    group: "Viaje",
    label: "Día",
    mapFrom: "trip.scheduledStart (dd/mm/yyyy)",
  },
  {
    id: "assignment.position",
    outputKey: "autoriza",
    granularities: ["perAssignment"],
    group: "Asignación",
    label: "Autoriza / posición",
    mapFrom: "trip-assignment.position",
  },
  {
    id: "trip.client.display",
    outputKey: "empresa",
    granularities: ["perAssignment"],
    group: "Viaje",
    label: "Empresa (cliente viaje)",
    mapFrom: "trip.client",
  },
  {
    id: "trip.transportGuide.asDocument",
    outputKey: "documento",
    granularities: ["perAssignment"],
    group: "Viaje",
    label: "Documento / guía",
    mapFrom: "trip.transportGuide",
  },
  {
    id: "stop.clientName.fallbackTripClient",
    outputKey: "cliente",
    granularities: ["perAssignment"],
    group: "Parada",
    label: "Cliente (parada o empresa)",
    mapFrom: "tripStop.name si hay stop; si no trip.client",
  },
  {
    id: "stop.districtName",
    outputKey: "distrito",
    granularities: ["perAssignment"],
    group: "Parada",
    label: "Distrito",
    mapFrom: "tripStop.districtName",
  },
  {
    id: "tripstop.externalDocument",
    outputKey: "stopExternalDocument",
    granularities: ["perAssignment"],
    group: "Parada",
    label: "Documento externo (parada)",
    mapFrom: "tripStop.externalDocument",
  },
  {
    id: "tripstop.observations",
    outputKey: "stopObservations",
    granularities: ["perAssignment"],
    group: "Parada",
    label: "Observaciones (parada)",
    mapFrom: "tripStop.observations",
  },
  {
    id: "assignment.displayName",
    outputKey: "nombreApoyo",
    granularities: ["perAssignment"],
    group: "Asignación",
    label: "Nombre del apoyo",
    mapFrom: "trip-assignment.displayName",
  },
  {
    id: "assignment.row.quantity",
    outputKey: "cantidad",
    granularities: ["perAssignment"],
    group: "Asignación",
    label: "Cantidad",
    mapFrom: "Constante 1 en fila por asignación",
  },
  {
    id: "assignment.chargeType",
    outputKey: "producto",
    granularities: ["perAssignment"],
    group: "Asignación",
    label: "Producto / tipo cargo",
    mapFrom: "trip-assignment.chargeType",
  },
  {
    id: "assignment.scope.display",
    outputKey: "motivo",
    granularities: ["perAssignment"],
    group: "Asignación",
    label: "Motivo / alcance",
    mapFrom: "assignment.scope.display",
  },
  {
    id: "assignment.charges.unitPriceDerived",
    outputKey: "pUni",
    granularities: ["perAssignment"],
    group: "Cargos",
    label: "Precio unitario",
    mapFrom: "pTotal / cantidad (derivado)",
  },
  {
    id: "assignment.charges.lineTotal",
    outputKey: "pTotal",
    granularities: ["perAssignment"],
    group: "Cargos",
    label: "Total línea",
    mapFrom: "Suma cargos vinculados a la misma entidad que la asignación",
  },
];

/** @type {Map<string, (typeof TRIP_REPORT_BINDINGS)[0]>} */
const byBindingId = new Map(TRIP_REPORT_BINDINGS.map((b) => [b.id, b]));

/**
 * @param {Record<string, unknown>} col definición de columna (field y/o bindingId)
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {string} outputKey vacío si inválido
 */
function resolveColumnOutputKey(col, granularity) {
  if (!col || typeof col !== "object") return "";
  const bid = String(col.bindingId ?? "").trim();
  if (bid) {
    const b = byBindingId.get(bid);
    if (!b || !b.granularities.includes(granularity)) return "";
    return b.outputKey;
  }
  return String(col.field ?? "").trim();
}

/**
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {typeof TRIP_REPORT_BINDINGS}
 */
function listTripBindingsForGranularity(granularity) {
  return TRIP_REPORT_BINDINGS.filter((b) => b.granularities.includes(granularity));
}

module.exports = {
  TRIP_REPORT_BINDINGS,
  resolveColumnOutputKey,
  listTripBindingsForGranularity,
};
