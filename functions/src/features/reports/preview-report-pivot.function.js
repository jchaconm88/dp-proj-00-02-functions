const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require("../../lib/firebase");
const { executeReportDataSource } = require("../../lib/report-data-source-execute.service");
const {
  runPivotEngine,
  applyPivotFilters,
  MAX_PIVOT_PREVIEW_INPUT,
  MAX_PIVOT_PREVIEW_OUTPUT,
} = require("../../lib/report-pivot-engine.service");
const { resolveColumns, resolveRowGranularity } = require("../../lib/report-definition-resolve.service");

const previewReportPivot = onCall(
  {
    cors: true,
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const reportDefinitionId = String(request.data?.reportDefinitionId ?? "").trim();
    if (!reportDefinitionId) {
      throw new HttpsError("invalid-argument", "reportDefinitionId es obligatorio.");
    }

    const rawParams = request.data?.params;
    const params = rawParams && typeof rawParams === "object" ? { ...rawParams } : {};
    const dateFrom = String(params.dateFrom ?? "").trim();
    const dateTo = String(params.dateTo ?? "").trim();
    if (!dateFrom || !dateTo) {
      throw new HttpsError("invalid-argument", "params.dateFrom y dateTo son obligatorios.");
    }

    const defSnap = await db.collection("report-definitions").doc(reportDefinitionId).get();
    if (!defSnap.exists) {
      throw new HttpsError("not-found", "La definición de reporte no existe.");
    }

    const definition = defSnap.data() ?? {};
    if (String(definition.layoutKind ?? "").trim() !== "pivot" || !definition.pivotSpec) {
      throw new HttpsError("failed-precondition", "La definición no está en modo pivot.");
    }

    const execParams = {
      ...params,
      __previewMaxInputRows: MAX_PIVOT_PREVIEW_INPUT,
    };

    const { rows, previewInputTruncated } = await executeReportDataSource(db, definition, execParams);
    const inputRowCount = rows.length;

    const pivotOutKind = String(definition.pivotSpec.outputKind ?? "aggregate").trim();

    if (pivotOutKind === "detail") {
      const gran = resolveRowGranularity(definition);
      const columns = resolveColumns(definition, gran);
      let work = rows;
      let truncatedInput = false;
      if (work.length > MAX_PIVOT_PREVIEW_INPUT) {
        work = work.slice(0, MAX_PIVOT_PREVIEW_INPUT);
        truncatedInput = true;
      }
      const filters = Array.isArray(definition.pivotSpec.filters) ? definition.pivotSpec.filters : [];
      const filtered = applyPivotFilters(work, filters);
      const truncatedOutput = filtered.length > MAX_PIVOT_PREVIEW_OUTPUT;
      const outRows = truncatedOutput ? filtered.slice(0, MAX_PIVOT_PREVIEW_OUTPUT) : filtered;
      return {
        columns: columns.map((c) => ({ field: c.field, header: c.header })),
        rows: outRows,
        truncatedInput: truncatedInput || previewInputTruncated === true,
        truncatedOutput,
        inputRowCount,
        outputRowCount: outRows.length,
      };
    }

    const pivotResult = runPivotEngine(definition, rows, {
      maxInputRows: MAX_PIVOT_PREVIEW_INPUT,
      maxOutputRows: MAX_PIVOT_PREVIEW_OUTPUT,
    });

    return {
      columns: pivotResult.columns.map((c) => ({ field: c.field, header: c.header })),
      rows: pivotResult.outRows,
      truncatedInput: pivotResult.truncatedInput || previewInputTruncated === true,
      truncatedOutput: pivotResult.truncatedOutput,
      inputRowCount,
      outputRowCount: pivotResult.outRows.length,
    };
  }
);

module.exports = {
  previewReportPivot,
};
