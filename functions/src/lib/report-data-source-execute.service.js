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

  const granularity = resolveGranularityWithParams(definition, params);

  // Sources that don't require date range
  if (sourceId === "stock-valuation") {
    return executeStockValuation(db, definition, params, granularity);
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

  if (sourceId === "purchase-orders") {
    return executePurchaseOrdersReport(db, definition, params, dateFrom, dateTo, granularity);
  }

  if (sourceId === "sale-orders") {
    return executeSaleOrdersReport(db, definition, params, dateFrom, dateTo, granularity);
  }

  if (sourceId === "quotations") {
    return executeQuotationsReport(db, definition, params, dateFrom, dateTo, granularity);
  }

  if (sourceId === "inventory-movements") {
    return executeInventoryMovementsReport(db, definition, params, dateFrom, dateTo, granularity);
  }

  throw new Error(`Sin ejecutor para origen: ${sourceId}`);
}

/**
 * Ejecuta reporte de Compras por Periodo.
 */
async function executePurchaseOrdersReport(db, definition, params, dateFrom, dateTo, granularity) {
  const companyId = String(definition.companyId ?? "").trim();
  let query = db.collection("purchase-orders")
    .where("companyId", "==", companyId)
    .where("issueDate", ">=", dateFrom)
    .where("issueDate", "<=", dateTo);

  const status = String(params.status ?? "").trim();
  if (status) {
    query = query.where("status", "==", status);
  }

  const snap = await query.get();
  let rows = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      code: String(d.code ?? ""),
      supplierName: String(d.supplierName ?? ""),
      issueDate: String(d.issueDate ?? ""),
      currency: String(d.currency ?? ""),
      subtotal: Number(d.subtotal ?? 0),
      taxAmount: Number(d.taxAmount ?? 0),
      total: Number(d.total ?? 0),
      status: String(d.status ?? ""),
      locationName: String(d.locationName ?? ""),
    };
  });

  const supplierId = String(params.supplierId ?? "").trim();
  if (supplierId) {
    rows = rows.filter((r) => {
      const snap = snap.docs.find((doc) => doc.id === r.id);
      return snap && String(snap.data()?.supplierId ?? "") === supplierId;
    });
  }

  return { rows, granularity };
}

/**
 * Ejecuta reporte de Ventas por Periodo.
 */
async function executeSaleOrdersReport(db, definition, params, dateFrom, dateTo, granularity) {
  const companyId = String(definition.companyId ?? "").trim();
  let query = db.collection("sale-orders")
    .where("companyId", "==", companyId)
    .where("issueDate", ">=", dateFrom)
    .where("issueDate", "<=", dateTo);

  const status = String(params.status ?? "").trim();
  if (status) {
    query = query.where("status", "==", status);
  }

  const snap = await query.get();
  let rows = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      code: String(d.code ?? ""),
      clientName: String(d.clientName ?? ""),
      issueDate: String(d.issueDate ?? ""),
      currency: String(d.currency ?? ""),
      subtotal: Number(d.subtotal ?? 0),
      taxAmount: Number(d.taxAmount ?? 0),
      total: Number(d.total ?? 0),
      status: String(d.status ?? ""),
      locationName: String(d.locationName ?? ""),
    };
  });

  const clientId = String(params.clientId ?? "").trim();
  if (clientId) {
    rows = rows.filter((r) => {
      const doc = snap.docs.find((doc) => doc.id === r.id);
      return doc && String(doc.data()?.clientId ?? "") === clientId;
    });
  }

  return { rows, granularity };
}

/**
 * Ejecuta reporte de Cotizaciones.
 */
async function executeQuotationsReport(db, definition, params, dateFrom, dateTo, granularity) {
  const companyId = String(definition.companyId ?? "").trim();
  let query = db.collection("quotations")
    .where("companyId", "==", companyId)
    .where("issueDate", ">=", dateFrom)
    .where("issueDate", "<=", dateTo);

  const status = String(params.status ?? "").trim();
  if (status) {
    query = query.where("status", "==", status);
  }

  const snap = await query.get();
  let rows = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      code: String(d.code ?? ""),
      clientName: String(d.clientName ?? ""),
      issueDate: String(d.issueDate ?? ""),
      validUntil: String(d.validUntil ?? ""),
      currency: String(d.currency ?? ""),
      subtotal: Number(d.subtotal ?? 0),
      taxAmount: Number(d.taxAmount ?? 0),
      total: Number(d.total ?? 0),
      status: String(d.status ?? ""),
      locationName: String(d.locationName ?? ""),
    };
  });

  const clientId = String(params.clientId ?? "").trim();
  if (clientId) {
    rows = rows.filter((r) => {
      const doc = snap.docs.find((doc) => doc.id === r.id);
      return doc && String(doc.data()?.clientId ?? "") === clientId;
    });
  }

  return { rows, granularity };
}

/**
 * Ejecuta reporte de Movimientos de Inventario.
 */
async function executeInventoryMovementsReport(db, definition, params, dateFrom, dateTo, granularity) {
  const companyId = String(definition.companyId ?? "").trim();
  let query = db.collection("inventory-movements")
    .where("companyId", "==", companyId)
    .where("date", ">=", dateFrom)
    .where("date", "<=", dateTo);

  const type = String(params.type ?? "").trim();
  if (type) {
    query = query.where("type", "==", type);
  }

  const snap = await query.get();
  let rows = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      code: String(d.code ?? ""),
      type: String(d.type ?? ""),
      warehouseName: String(d.warehouseName ?? ""),
      warehouseDestinationName: String(d.warehouseDestinationName ?? ""),
      productName: String(d.productName ?? ""),
      quantity: Number(d.quantity ?? 0),
      unitOfMeasure: String(d.unitOfMeasure ?? ""),
      referenceType: String(d.referenceType ?? ""),
      date: String(d.date ?? ""),
      locationName: String(d.locationName ?? ""),
    };
  });

  const warehouseId = String(params.warehouseId ?? "").trim();
  if (warehouseId) {
    rows = rows.filter((r) => {
      const doc = snap.docs.find((doc) => doc.id === r.id);
      return doc && String(doc.data()?.warehouseId ?? "") === warehouseId;
    });
  }

  const productId = String(params.productId ?? "").trim();
  if (productId) {
    rows = rows.filter((r) => {
      const doc = snap.docs.find((doc) => doc.id === r.id);
      return doc && String(doc.data()?.productId ?? "") === productId;
    });
  }

  return { rows, granularity };
}

/**
 * Ejecuta reporte de Valorización de Stock.
 */
async function executeStockValuation(db, definition, params, granularity) {
  const companyId = String(definition.companyId ?? "").trim();
  let query = db.collection("stock-levels")
    .where("companyId", "==", companyId);

  const snap = await query.get();
  const stockDocs = snap.docs.map((doc) => {
    const d = doc.data() ?? {};
    return {
      id: doc.id,
      productId: String(d.productId ?? ""),
      productName: String(d.productName ?? ""),
      warehouseId: String(d.warehouseId ?? ""),
      warehouseName: String(d.warehouseName ?? ""),
      quantity: Number(d.quantity ?? 0),
      unitOfMeasure: String(d.unitOfMeasure ?? ""),
    };
  });

  // Fetch product purchase prices for valuation
  const productIds = [...new Set(stockDocs.map((s) => s.productId).filter(Boolean))];
  const productPrices = {};
  // Batch fetch products (max 10 per in-query)
  for (let i = 0; i < productIds.length; i += 10) {
    const batch = productIds.slice(i, i + 10);
    const prodSnap = await db.collection("products")
      .where("companyId", "==", companyId)
      .where("__name__", "in", batch)
      .get();
    for (const doc of prodSnap.docs) {
      const d = doc.data() ?? {};
      productPrices[doc.id] = Number(d.purchasePrice ?? 0);
    }
  }

  let rows = stockDocs.map((s) => {
    const purchasePrice = productPrices[s.productId] ?? 0;
    return {
      ...s,
      purchasePrice,
      valuedAmount: s.quantity * purchasePrice,
    };
  });

  const warehouseId = String(params.warehouseId ?? "").trim();
  if (warehouseId) {
    rows = rows.filter((r) => r.warehouseId === warehouseId);
  }

  const productId = String(params.productId ?? "").trim();
  if (productId) {
    rows = rows.filter((r) => r.productId === productId);
  }

  return { rows, granularity };
}

module.exports = {
  executeReportDataSource,
  resolveGranularityWithParams,
};
