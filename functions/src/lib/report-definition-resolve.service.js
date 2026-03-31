/**
 * Resuelve granularidad, columnas y pie desde `reportDefinitions` (motor genérico + compatibilidad legacy).
 */

const { getTripsColumnResolveConfig } = require("./report-data-sources.registry");
const { resolveColumnOutputKey } = require("./report-trips-bindings.registry");

/**
 * @param {Record<string, unknown>} definition
 * @returns {"perTrip"|"perAssignment"}
 */
function resolveRowGranularity(definition) {
  const g = String(definition.rowGranularity ?? "").trim();
  if (g === "perAssignment") return "perAssignment";
  if (g === "perTrip") return "perTrip";
  const t = String(definition.templateId ?? "");
  if (t === "ra-reporte-apoyo") return "perAssignment";
  return "perTrip";
}

/**
 * @param {unknown} raw
 * @param {Set<string>} allowed
 * @param {string[]} defaultOrder
 * @returns {string[]}
 */
function normalizeLayoutKeys(raw, allowed, defaultOrder) {
  if (!Array.isArray(raw) || raw.length === 0) return [...defaultOrder];
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const id = String(x ?? "").trim();
    if (!allowed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : [...defaultOrder];
}

/**
 * @param {Record<string, unknown>} definition
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {Array<{ field: string, header: string, width: number }>}
 */
function resolveColumns(definition, granularity) {
  const { defaultOrder, meta, allowed } = getTripsColumnResolveConfig(granularity);

  if (Array.isArray(definition.columns) && definition.columns.length > 0) {
    /** @type {Array<{ field: string, header: string, width: number }>} */
    const out = [];
    for (const c of definition.columns) {
      if (!c || typeof c !== "object") continue;
      const field = resolveColumnOutputKey(c, granularity);
      if (!field || !allowed.has(field)) continue;
      const m = meta[field];
      const header = String(c.header ?? "").trim() || (m ? m.header : field);
      const w = Number(c.width);
      const width = Number.isFinite(w) && w > 0 ? w : m ? m.width : 14;
      out.push({ field, header, width });
    }
    if (out.length > 0) return out;
  }

  const keys = normalizeLayoutKeys(definition.columnLayout, allowed, defaultOrder);
  return keys.map((field) => {
    const m = meta[field];
    return {
      field,
      header: m ? m.header : field,
      width: m ? m.width : 14,
    };
  });
}

/**
 * @param {unknown} rawRows
 * @param {Set<string>} fields
 * @returns {Array<Record<string, unknown>>}
 */
function parseAndValidateFooterRows(rawRows, fields) {
  if (!Array.isArray(rawRows)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const parsed = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const rowId = String(o.rowId ?? "").trim();
    const label = String(o.label ?? "").trim();
    const op = String(o.op ?? "").trim();
    if (!rowId || !label || !op) continue;
    if (op === "sumColumn") {
      const sourceField = String(o.sourceField ?? "").trim();
      if (!fields.has(sourceField)) continue;
      parsed.push({ rowId, label, op: "sumColumn", sourceField });
    } else if (op === "multiplyFooter") {
      const refRowId = String(o.refRowId ?? "").trim();
      const factor = Number(o.factor);
      if (!refRowId || !Number.isFinite(factor)) continue;
      parsed.push({ rowId, label, op: "multiplyFooter", refRowId, factor });
    } else if (op === "sumFooterRefs") {
      const refRowIds = Array.isArray(o.refRowIds)
        ? o.refRowIds.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      if (refRowIds.length === 0) continue;
      parsed.push({ rowId, label, op: "sumFooterRefs", refRowIds });
    }
  }
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const prev = new Set();
  for (const r of parsed) {
    if (r.op === "multiplyFooter") {
      if (!prev.has(r.refRowId)) continue;
    }
    if (r.op === "sumFooterRefs") {
      const ok = r.refRowIds.every((id) => prev.has(id));
      if (!ok) continue;
    }
    out.push(r);
    prev.add(r.rowId);
  }
  return out;
}

const RESOLVED_TITLE_TOKEN = "{{resolvedTitle}}";

/**
 * @param {unknown} rawRows
 * @param {Set<string>} fields
 * @returns {Array<Record<string, unknown>>}
 */
function parseAndValidateTopBlockRows(rawRows, fields) {
  if (!Array.isArray(rawRows)) return [];
  /** @type {Array<Record<string, unknown>>} */
  const parsed = [];
  for (const raw of rawRows) {
    if (!raw || typeof raw !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const rowId = String(o.rowId ?? "").trim();
    const op = String(o.op ?? "").trim();
    if (!rowId || !op) continue;
    if (op === "staticText") {
      const valueText = String(o.valueText ?? "");
      const lab = String(o.label ?? "");
      parsed.push({ rowId, label: lab, op: "staticText", valueText });
      continue;
    }
    const label = String(o.label ?? "").trim();
    if (!label) continue;
    if (op === "sumColumn") {
      const sourceField = String(o.sourceField ?? "").trim();
      if (!fields.has(sourceField)) continue;
      parsed.push({ rowId, label, op: "sumColumn", sourceField });
    } else if (op === "multiplyFooter") {
      const refRowId = String(o.refRowId ?? "").trim();
      const factor = Number(o.factor);
      if (!refRowId || !Number.isFinite(factor)) continue;
      parsed.push({ rowId, label, op: "multiplyFooter", refRowId, factor });
    } else if (op === "sumFooterRefs") {
      const refRowIds = Array.isArray(o.refRowIds)
        ? o.refRowIds.map((x) => String(x ?? "").trim()).filter(Boolean)
        : [];
      if (refRowIds.length === 0) continue;
      parsed.push({ rowId, label, op: "sumFooterRefs", refRowIds });
    }
  }
  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  const prev = new Set();
  for (const r of parsed) {
    if (r.op === "multiplyFooter") {
      if (!prev.has(r.refRowId)) continue;
    }
    if (r.op === "sumFooterRefs") {
      const ok = r.refRowIds.every((id) => prev.has(id));
      if (!ok) continue;
    }
    out.push(r);
    prev.add(r.rowId);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} definition
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {Array<Record<string, unknown>>}
 */
function inferTopBlockRowsFromLegacyHeader(definition, granularity) {
  const h = definition.header && typeof definition.header === "object" ? definition.header : {};
  const cn = String(h.companyName ?? "").trim();
  const rucRaw = String(h.companyRuc ?? "").trim();
  const rt = String(h.reportTitle ?? "").trim();
  const rucLine = rucRaw ? (rucRaw.toUpperCase().startsWith("RUC:") ? rucRaw : `RUC: ${rucRaw}`) : "";
  const rid = () => `leg-${Math.random().toString(36).slice(2, 10)}`;
  if (granularity === "perAssignment") {
    return [{ rowId: rid(), label: "", op: "staticText", valueText: rt || RESOLVED_TITLE_TOKEN }];
  }
  return [
    { rowId: rid(), label: "", op: "staticText", valueText: cn },
    { rowId: rid(), label: "", op: "staticText", valueText: rucLine },
    { rowId: rid(), label: "", op: "staticText", valueText: rt || RESOLVED_TITLE_TOKEN },
  ];
}

/**
 * @param {Record<string, unknown>} definition
 * @param {Array<{ field: string }>} columns
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {Record<string, unknown>}
 */
function resolveTopBlockSpec(definition, columns, granularity) {
  const fields = new Set(columns.map((c) => c.field));
  const raw = definition.topBlock;
  if (raw && typeof raw === "object") {
    const mode = String(raw.mode ?? "").trim();
    if (mode === "none") return { mode: "none" };
    if (mode === "rows" && Array.isArray(raw.rows)) {
      const rows = parseAndValidateTopBlockRows(raw.rows, fields);
      if (rows.length > 0) return { mode: "rows", rows };
      return { mode: "none" };
    }
  }
  const inferred = parseAndValidateTopBlockRows(
    inferTopBlockRowsFromLegacyHeader(definition, granularity),
    fields
  );
  if (inferred.length > 0) return { mode: "rows", rows: inferred };
  return { mode: "none" };
}

/**
 * @param {Record<string, unknown>} foot
 * @returns {Array<Record<string, unknown>>|null}
 */
function legacyFooterToRowSpecs(foot) {
  const mode = String(foot.mode ?? "").trim();
  if (mode === "subtotalIgvTotal") {
    const sumField = String(foot.sumField ?? "total").trim();
    const rate = Number(foot.igvRate);
    const r = Number.isFinite(rate) && rate >= 0 ? rate : 0.18;
    const labels = foot.labels && typeof foot.labels === "object" ? foot.labels : {};
    const lbSub = String(labels.subtotal ?? "SUB TOTAL").trim() || "SUB TOTAL";
    const lbIgv = String(labels.igv ?? "IGV 18%").trim() || "IGV 18%";
    const lbTot = String(labels.total ?? "TOTAL").trim() || "TOTAL";
    const id1 = "legacy-igv-base";
    const id2 = "legacy-igv-tax";
    const id3 = "legacy-igv-sum";
    return [
      { rowId: id1, label: lbSub, op: "sumColumn", sourceField: sumField },
      { rowId: id2, label: lbIgv, op: "multiplyFooter", refRowId: id1, factor: r },
      { rowId: id3, label: lbTot, op: "sumFooterRefs", refRowIds: [id1, id2] },
    ];
  }
  if (mode === "sumColumn") {
    const f = String(foot.field ?? "").trim();
    const sumLabel = String(foot.sumLabel ?? "TOTALES").trim() || "TOTALES";
    return [{ rowId: "legacy-sum", label: sumLabel, op: "sumColumn", sourceField: f }];
  }
  return null;
}

/**
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>} params
 * @param {Array<{ field: string }>} columns
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {Record<string, unknown>}
 */
function resolveFooterSpec(definition, params, columns, granularity) {
  const fields = new Set(columns.map((c) => c.field));
  const foot = definition.footer;

  /** @type {Array<Record<string, unknown>>|null} */
  let rows = null;

  if (foot && typeof foot === "object") {
    const mode = String(foot.mode ?? "").trim();
    if (mode === "none") return { mode: "none" };
    if (mode === "rows" && Array.isArray(foot.rows)) {
      rows = parseAndValidateFooterRows(foot.rows, fields);
    } else if (mode === "subtotalIgvTotal" || mode === "sumColumn") {
      const spec = legacyFooterToRowSpecs(foot);
      if (spec) rows = parseAndValidateFooterRows(spec, fields);
    }
  }

  if (rows && rows.length === 0) rows = null;

  if (!rows) {
    if (granularity === "perTrip") {
      const igvOn =
        typeof params.includeSubtotalsIgft === "boolean"
          ? params.includeSubtotalsIgft
          : definition.includeSubtotalsIgft !== false;
      if (igvOn && fields.has("total")) {
        rows = parseAndValidateFooterRows(
          legacyFooterToRowSpecs({
            mode: "subtotalIgvTotal",
            sumField: "total",
            igvRate: 0.18,
          }),
          fields
        );
      }
    } else if (fields.has("pTotal")) {
      rows = parseAndValidateFooterRows(
        legacyFooterToRowSpecs({ mode: "sumColumn", field: "pTotal", sumLabel: "TOTALES" }),
        fields
      );
    }
  }

  if (!rows || rows.length === 0) return { mode: "none" };

  const hasMultiply = rows.some((r) => r.op === "multiplyFooter");
  if (hasMultiply && params.includeSubtotalsIgft === false) {
    return { mode: "none" };
  }

  return { mode: "rows", rows };
}

/**
 * @param {Record<string, unknown>} definition
 * @param {string} periodLabel
 * @param {number} seq
 * @param {"perTrip"|"perAssignment"} granularity
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
function resolveTitleText(definition, periodLabel, seq, granularity, header, params) {
  const base =
    String(params.reportTitle ?? header.reportTitle ?? "").trim() ||
    (granularity === "perAssignment" ? "REPORTE DE APOYO" : "DESPACHO DOMICILIO");
  const fileBase = resolveFileBaseName(definition, periodLabel, seq, granularity);
  return granularity === "perAssignment" ? `${base} - ${fileBase}` : `${base} ${fileBase}`;
}

/**
 * @param {Record<string, unknown>} definition
 * @param {string} periodLabel
 * @param {number} seq
 * @param {"perTrip"|"perAssignment"} granularity
 * @returns {string} nombre archivo sin extensión
 */
function resolveFileBaseName(definition, periodLabel, seq, granularity) {
  const p = String(periodLabel || "").replace(/\D/g, "").slice(0, 6) || "periodo";
  const tag = String(definition.exportTag ?? "").trim();
  if (tag) {
    return `${tag}-${p}-${seq}`;
  }
  return granularity === "perAssignment" ? `RA-${p}-${seq}` : `DD-${p}-${seq}`;
}

module.exports = {
  resolveRowGranularity,
  resolveColumns,
  resolveFooterSpec,
  resolveTopBlockSpec,
  resolveTitleText,
  resolveFileBaseName,
};
