/**
 * Orquesta la ejecución de un `reportRun`: datos + .xlsx + Storage (motor genérico).
 */

const { executeReportDataSource } = require("./report-data-source-execute.service");
const { buildGenericTableWorkbook } = require("./report-xlsx-generic.service");
const { buildGenericTablePdf } = require("./report-pdf-generic.service");
const { runPivotEngine, applyPivotFilters } = require("./report-pivot-engine.service");
const {
  resolveExportTitle,
  resolveExportFileStem,
  periodLabelFromRange,
  seqFromRunId,
} = require("./report-export-templates.service");
const {
  resolveColumns,
  resolveFooterSpec,
  resolveTopBlockSpec,
} = require("./report-definition-resolve.service");

/**
 * @param {FirebaseFirestore.Firestore} db
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>} params merged run params
 * @param {string} runId
 * @param {number} seqHint
 * @param {string} [outputFormat] `xlsx` | `pdf`
 * @returns {Promise<{ buffer: Buffer, fileName: string, mimeType: string }>}
 */
async function buildReportBuffer(db, definition, params, runId, seqHint, outputFormat = "xlsx") {
  const { rows, granularity } = await executeReportDataSource(db, definition, params);

  const dateFrom = String(params.dateFrom ?? "").trim();
  const dateTo = String(params.dateTo ?? "").trim();
  const periodLabel = periodLabelFromRange(dateFrom, dateTo);
  const seq = Number.isFinite(Number(seqHint)) ? Number(seqHint) : seqFromRunId(runId);

  const definitionId = String(definition.id ?? "").trim();
  const definitionName = String(definition.name ?? "").trim();
  const exportTag = String(definition.exportTag ?? "").trim();
  const ctx = {
    dateFrom,
    dateTo,
    seq,
    granularity,
    definitionId,
    definitionName,
    exportTag,
  };

  const titleTpl = String(definition.exportTitleTemplate ?? "").trim();
  const fileTpl = String(definition.exportFileNameTemplate ?? "").trim();

  if (!titleTpl) {
    throw new Error("Falta exportTitleTemplate en la definición del reporte.");
  }
  if (!fileTpl) {
    throw new Error("Falta exportFileNameTemplate en la definición del reporte.");
  }
  const titleText = resolveExportTitle(titleTpl, ctx);
  const fileBase = resolveExportFileStem(fileTpl, ctx);
  if (!String(titleText ?? "").trim()) {
    throw new Error("exportTitleTemplate resuelve vacío. Configura la plantilla de título en la definición.");
  }
  if (!String(fileBase ?? "").trim()) {
    throw new Error("exportFileNameTemplate resuelve vacío. Configura la plantilla de archivo en la definición.");
  }

  const layoutKind = String(definition.layoutKind ?? "tabular").trim();
  const pivotSpec = definition.pivotSpec;
  const pivotOutKind =
    pivotSpec && typeof pivotSpec === "object"
      ? String(pivotSpec.outputKind ?? "aggregate").trim()
      : "aggregate";

  let columns;
  let tableRows = rows;
  /** @type {string[]} */
  let decimalFieldNames = [];

  if (layoutKind === "pivot" && pivotSpec && typeof pivotSpec === "object") {
    if (pivotOutKind === "detail") {
      const filters = Array.isArray(pivotSpec.filters) ? pivotSpec.filters : [];
      tableRows = applyPivotFilters(rows, filters);
      columns = resolveColumns(definition, granularity);
    } else {
      const pivotResult = runPivotEngine(definition, rows, {});
      columns = pivotResult.columns;
      tableRows = pivotResult.outRows;
      decimalFieldNames = [...pivotResult.decimalFields];
    }
  } else {
    columns = resolveColumns(definition, granularity);
  }

  const footerSpec =
    params.includeFooter === false ? { mode: "none" } : resolveFooterSpec(definition, params, columns, granularity);
  const topBlockSpec =
    params.includeTopBlock === false ? { mode: "none" } : resolveTopBlockSpec(definition, columns, granularity);

  const fmt = String(outputFormat ?? "xlsx").toLowerCase();

  if (fmt === "pdf") {
    const buffer = await buildGenericTablePdf(tableRows, {
      columns,
      resolvedTitle: titleText,
      topBlockSpec,
      footerSpec,
      companyBlockLayout: granularity === "perTrip",
      decimalFieldNames,
    });
    return {
      buffer,
      fileName: `${fileBase}.pdf`,
      mimeType: "application/pdf",
    };
  }

  const buffer = await buildGenericTableWorkbook(tableRows, {
    columns,
    startCol: granularity === "perTrip" ? 2 : 1,
    orientation: granularity === "perTrip" ? "portrait" : "landscape",
    companyBlockLayout: granularity === "perTrip",
    resolvedTitle: titleText,
    topBlockSpec,
    footerSpec,
    decimalFieldNames,
  });

  return {
    buffer,
    fileName: `${fileBase}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

module.exports = {
  buildReportBuffer,
};
