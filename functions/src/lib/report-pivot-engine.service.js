/**
 * Agregación y tabla cruzada sobre filas planas materializadas (no PivotTable OOXML).
 */

/** @typedef {{ field: string, header: string, width?: number }} PivotOutColumn */

const MAX_PIVOT_SOURCE_ROWS = 100000;
const MAX_PIVOT_DISTINCT_COL_KEYS = 500;
const MAX_PIVOT_PREVIEW_INPUT = 2500;
const MAX_PIVOT_PREVIEW_OUTPUT = 500;

const NUMERIC_HINT = new Set([
  "total",
  "totalFlete",
  "totalApoyoExtra",
  "pUni",
  "pTotal",
  "cantidad",
  "no",
]);

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Array<{ field: string, op: string, values: string[] }>} filters
 * @returns {Record<string, unknown>[]}
 */
function applyPivotFilters(rows, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return rows;
  return rows.filter((row) =>
    filters.every((f) => {
      const raw = row[f.field];
      const sv = raw == null ? "" : String(raw).trim();
      const op = String(f.op ?? "");
      const vals = Array.isArray(f.values) ? f.values.map((x) => String(x ?? "").trim()) : [];
      if (vals.length === 0) return true;
      if (op === "eq") return sv === vals[0];
      if (op === "ne") return sv !== vals[0];
      if (op === "in") return vals.includes(sv);
      if (op === "nin") return !vals.includes(sv);
      return true;
    })
  );
}

/**
 * @param {Record<string, unknown>[]} groupRows
 * @param {string} field
 * @param {string} agg
 * @returns {unknown}
 */
function aggregateGroup(groupRows, field, agg) {
  if (agg === "count") return groupRows.length;
  const nums = [];
  for (const r of groupRows) {
    const n = toNumber(r[field]);
    if (n != null) nums.push(n);
  }
  if (nums.length === 0) return null;
  if (agg === "sum" || agg === "avg") {
    const s = nums.reduce((a, b) => a + b, 0);
    return agg === "avg" ? s / nums.length : s;
  }
  if (agg === "min") return Math.min(...nums);
  if (agg === "max") return Math.max(...nums);
  return null;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {object} pivotSpec
 * @returns {{ columns: PivotOutColumn[], outRows: Record<string, unknown>[] }}
 */
function buildPivotTable(rows, pivotSpec) {
  const rowDims = Array.isArray(pivotSpec.rows) ? pivotSpec.rows : [];
  const colDims = Array.isArray(pivotSpec.columns) ? pivotSpec.columns : [];
  const values = Array.isArray(pivotSpec.values) ? pivotSpec.values : [];
  if (values.length === 0) {
    throw new Error("pivotSpec.values vacío.");
  }

  const filters = Array.isArray(pivotSpec.filters) ? pivotSpec.filters : [];
  const filtered = applyPivotFilters(rows, filters);

  const rowKeyParts = (r) =>
    rowDims.map((d) => {
      const v = r[d.field];
      return v == null ? "" : String(v);
    });
  const colKeyParts = (r) =>
    colDims.map((d) => {
      const v = r[d.field];
      return v == null ? "" : String(v);
    });

  const rowKeyStr = (parts) => parts.join("\x1e");
  const colKeyStr = (parts) => parts.join("\x1e");

  /** @type {Map<string, Map<string, Record<string, unknown>[]>>} */
  const bucket = new Map();

  for (const r of filtered) {
    const rk = rowKeyStr(rowKeyParts(r));
    const ck = colDims.length === 0 ? "" : colKeyStr(colKeyParts(r));
    if (!bucket.has(rk)) bucket.set(rk, new Map());
    const m = bucket.get(rk);
    if (!m.has(ck)) m.set(ck, []);
    m.get(ck).push(r);
  }

  /** @type {string[]} */
  let colKeys = [];
  if (colDims.length > 0) {
    const seen = new Set();
    for (const r of filtered) {
      seen.add(colKeyStr(colKeyParts(r)));
    }
    colKeys = [...seen].sort((a, b) => a.localeCompare(b));
    if (colKeys.length > MAX_PIVOT_DISTINCT_COL_KEYS) {
      throw new Error(
        `Demasiados valores distintos en columnas pivot (${colKeys.length}). Máximo ${MAX_PIVOT_DISTINCT_COL_KEYS}.`
      );
    }
  }

  /** @type {PivotOutColumn[]} */
  const columns = [];
  for (const d of rowDims) {
    columns.push({
      field: `__r_${d.field}`,
      header: String(d.label ?? d.field).trim() || d.field,
      width: 18,
    });
  }

  if (colDims.length === 0) {
    for (let vi = 0; vi < values.length; vi += 1) {
      const vs = values[vi];
      const headerBase = String(vs.label ?? vs.field).trim() || vs.field;
      const useCanonical = values.length === 1 && String(vs.agg) === "sum";
      const field = useCanonical ? vs.field : `__v_${vi}_${vs.field}_${vs.agg}`;
      columns.push({
        field,
        header: `${headerBase} (${vs.agg})`,
        width: 14,
      });
    }
  } else {
    for (let ci = 0; ci < colKeys.length; ci += 1) {
      const ck = colKeys[ci];
      const label = ck.split("\x1e").join(" · ");
      for (let vi = 0; vi < values.length; vi += 1) {
        const vs = values[vi];
        const field = `__pc_${ci}__v_${vi}_${vs.field}_${vs.agg}`;
        columns.push({
          field,
          header: `${label} — ${String(vs.label ?? vs.field)} (${vs.agg})`,
          width: 14,
        });
      }
    }
  }

  /** @type {Record<string, unknown>[]} */
  const outRows = [];
  const sortedRowKeys = [...bucket.keys()].sort((a, b) => a.localeCompare(b));

  for (const rk of sortedRowKeys) {
    const rowParts = rk === "" ? [] : rk.split("\x1e");
    /** @type {Record<string, unknown>} */
    const out = {};
    for (let i = 0; i < rowDims.length; i += 1) {
      out[`__r_${rowDims[i].field}`] = rowParts[i] ?? "";
    }
    const colMap = bucket.get(rk);
    if (colDims.length === 0) {
      const cellRows = [];
      for (const list of colMap.values()) {
        cellRows.push(...list);
      }
      for (let vi = 0; vi < values.length; vi += 1) {
        const vs = values[vi];
        const useCanonical = values.length === 1 && String(vs.agg) === "sum";
        const field = useCanonical ? vs.field : `__v_${vi}_${vs.field}_${vs.agg}`;
        out[field] = aggregateGroup(cellRows, vs.field, String(vs.agg));
      }
    } else {
      for (let ci = 0; ci < colKeys.length; ci += 1) {
        const ck = colKeys[ci];
        const cellRows = colMap.get(ck) ?? [];
        for (let vi = 0; vi < values.length; vi += 1) {
          const vs = values[vi];
          const field = `__pc_${ci}__v_${vi}_${vs.field}_${vs.agg}`;
          out[field] = aggregateGroup(cellRows, vs.field, String(vs.agg));
        }
      }
    }
    outRows.push(out);
  }

  return { columns, outRows };
}

/**
 * @param {PivotOutColumn[]} columns
 * @returns {Set<string>}
 */
function decimalFieldsFromPivotColumns(columns) {
  const s = new Set();
  for (const c of columns) {
    if (
      c.field.includes("_sum") ||
      c.field.includes("_avg") ||
      c.field.includes("_min") ||
      c.field.includes("_max") ||
      c.field.startsWith("__v_") ||
      c.field.startsWith("__pc_")
    ) {
      s.add(c.field);
    }
    if (NUMERIC_HINT.has(c.field)) {
      s.add(c.field);
    }
  }
  return s;
}

/**
 * @param {Record<string, unknown>} definition
 * @param {Record<string, unknown>[]} rows
 * @param {{ maxInputRows?: number, maxOutputRows?: number }} [limits]
 * @returns {{ columns: PivotOutColumn[], outRows: Record<string, unknown>[], decimalFields: Set<string>, truncatedInput: boolean, inputRowCount: number }}
 */
function runPivotEngine(definition, rows, limits = {}) {
  const pivotSpec = definition.pivotSpec;
  if (!pivotSpec || typeof pivotSpec !== "object") {
    throw new Error("Definición pivot sin pivotSpec.");
  }
  const outKind = String(pivotSpec.outputKind ?? "aggregate").trim();
  if (outKind === "detail") {
    throw new Error("runPivotEngine no aplica cuando pivotSpec.outputKind es detail.");
  }
  const maxIn = Number(limits.maxInputRows);
  const maxOut = Number(limits.maxOutputRows);
  const inputRowCount = rows.length;
  let work = rows;
  let truncatedInput = false;
  if (Number.isFinite(maxIn) && maxIn > 0 && work.length > maxIn) {
    work = work.slice(0, maxIn);
    truncatedInput = true;
  } else if (work.length > MAX_PIVOT_SOURCE_ROWS) {
    throw new Error(
      `Demasiadas filas para pivot (${work.length}). Máximo ${MAX_PIVOT_SOURCE_ROWS}. Acota fechas o filtros.`
    );
  }
  const { columns, outRows } = buildPivotTable(work, pivotSpec);
  let out = outRows;
  let truncatedOutput = false;
  if (Number.isFinite(maxOut) && maxOut > 0 && out.length > maxOut) {
    out = out.slice(0, maxOut);
    truncatedOutput = true;
  }
  return {
    columns,
    outRows: out,
    decimalFields: decimalFieldsFromPivotColumns(columns),
    truncatedInput,
    truncatedOutput,
    inputRowCount,
  };
}

module.exports = {
  MAX_PIVOT_SOURCE_ROWS,
  MAX_PIVOT_DISTINCT_COL_KEYS,
  MAX_PIVOT_PREVIEW_INPUT,
  MAX_PIVOT_PREVIEW_OUTPUT,
  applyPivotFilters,
  buildPivotTable,
  runPivotEngine,
  NUMERIC_HINT,
};
