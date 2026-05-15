/**
 * Registro de orígenes de datos para reportes (F0).
 * Centraliza orden de campos y metadatos para validación de columnas y documentación.
 */

/** Orden por defecto preset DD (sin columnas opcionales derivadas). */
/** @type {string[]} */
const TRIPS_PER_TRIP_DEFAULT_ORDER = ["no", "ruta", "fecha", "placa", "chofer", "guias", "total", "observacion"];

/** @deprecated Usar TRIPS_PER_TRIP_DEFAULT_ORDER; mismo array. */
const TRIPS_PER_TRIP_ORDER = TRIPS_PER_TRIP_DEFAULT_ORDER;

/** @type {string[]} */
const TRIPS_PER_ASSIGNMENT_ORDER = [
  "dia",
  "autoriza",
  "empresa",
  "documento",
  "cliente",
  "distrito",
  "stopExternalDocument",
  "stopObservations",
  "ruta",
  "placa",
  "nombreApoyo",
  "cantidad",
  "producto",
  "motivo",
  "pUni",
  "pTotal",
];

/** @type {Record<string, { header: string, width: number }>} */
const TRIPS_PER_TRIP_META = {
  no: { header: "No.", width: 10 },
  ruta: { header: "RUTA", width: 28 },
  fecha: { header: "FECHA", width: 12 },
  status: { header: "ESTADO", width: 14 },
  placa: { header: "PLACA", width: 14 },
  chofer: { header: "CHOFER", width: 22 },
  choferEmployee: { header: "CHOFER EMPLEADO", width: 22 },
  choferResource: { header: "CHOFER RECURSO", width: 22 },
  guias: { header: "GUIAS T.", width: 18 },
  total: { header: "TOTAL", width: 12 },
  totalFlete: { header: "TOTAL FLETE", width: 12 },
  totalApoyoExtra: { header: "TOTAL APOYO EXTRA", width: 14 },
  observacion: { header: "OBSERVACIÓN", width: 36 },
};

/** @type {Record<string, { header: string, width: number }>} */
const TRIPS_PER_ASSIGNMENT_META = {
  dia: { header: "DIA", width: 8 },
  autoriza: { header: "AUTORIZA", width: 14 },
  empresa: { header: "EMPRESA", width: 22 },
  documento: { header: "DOCUMENTO", width: 18 },
  cliente: { header: "CLIENTE", width: 22 },
  distrito: { header: "DISTRITO", width: 16 },
  stopExternalDocument: { header: "DOC. EXT. PARADA", width: 18 },
  stopObservations: { header: "OBS. PARADA", width: 28 },
  ruta: { header: "RUTA", width: 24 },
  placa: { header: "PLACA", width: 12 },
  nombreApoyo: { header: "NOMBRE DEL APOYO", width: 28 },
  cantidad: { header: "CANTIDAD", width: 10 },
  producto: { header: "PRODUCTO", width: 20 },
  motivo: { header: "MOTIVO", width: 14 },
  pUni: { header: "P.UNI.", width: 10 },
  pTotal: { header: "P.TOTAL", width: 12 },
};

/** Orígenes soportados por el ejecutor (F1). */
const SUPPORTED_SOURCE_IDS = new Set([
  "trips",
  "purchase-orders",
  "sale-orders",
  "quotations",
  "inventory-movements",
  "stock-valuation",
]);

/**
 * @param {string} sourceId
 * @returns {boolean}
 */
function isSupportedSourceId(sourceId) {
  return SUPPORTED_SOURCE_IDS.has(String(sourceId ?? "").trim());
}

/**
 * Configuración para resolver columnas.
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {{
 *   defaultOrder: string[],
 *   meta: Record<string, { header: string, width: number }>,
 *   allowed: Set<string>,
 * }}
 */
function getTripsColumnResolveConfig(granularity) {
  const isRa = granularity === "perAssignment";
  if (isRa) {
    return {
      defaultOrder: TRIPS_PER_ASSIGNMENT_ORDER,
      meta: TRIPS_PER_ASSIGNMENT_META,
      allowed: new Set(TRIPS_PER_ASSIGNMENT_ORDER),
    };
  }
  return {
    defaultOrder: TRIPS_PER_TRIP_DEFAULT_ORDER,
    meta: TRIPS_PER_TRIP_META,
    allowed: new Set(Object.keys(TRIPS_PER_TRIP_META)),
  };
}

module.exports = {
  SUPPORTED_SOURCE_IDS,
  isSupportedSourceId,
  getTripsColumnResolveConfig,
  TRIPS_PER_TRIP_ORDER,
  TRIPS_PER_TRIP_DEFAULT_ORDER,
  TRIPS_PER_ASSIGNMENT_ORDER,
};
