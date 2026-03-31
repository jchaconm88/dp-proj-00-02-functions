/**
 * PDF tabular alineado al motor Excel genérico: topBlock, tabla, footer (filas tipo fórmula evaluadas en JS).
 */

const PDFDocument = require("pdfkit");
const { RESOLVED_TITLE_TOKEN, DECIMAL_FIELDS } = require("./report-generic-constants");

/**
 * @param {string} valueText
 * @param {string} resolvedTitle
 * @returns {string}
 */
function resolveStaticCellText(valueText, resolvedTitle) {
  let s = String(valueText ?? "");
  if (s.includes(RESOLVED_TITLE_TOKEN)) {
    s = s.split(RESOLVED_TITLE_TOKEN).join(String(resolvedTitle ?? ""));
  }
  return s;
}

const formulaLocaleFmt = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * multiplyFooter / sumFooterRefs (paridad con numFmt #,##0.00 en Excel).
 * @param {number} n
 * @returns {string}
 */
function formatFormulaResult(n) {
  if (!Number.isFinite(n)) return "";
  return formulaLocaleFmt.format(n);
}

const aggregateDecFmt = new Intl.NumberFormat("es-PE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const aggregateIntFmt = new Intl.NumberFormat("es-PE", {
  maximumFractionDigits: 0,
});

/**
 * @param {string} field
 * @param {number} n
 * @param {Set<string>} decimalFieldSet
 * @returns {string}
 */
function formatAggregateNumber(field, n, decimalFieldSet) {
  if (!Number.isFinite(n)) return "";
  if (decimalFieldSet.has(field)) return aggregateDecFmt.format(n);
  if (Number.isInteger(n)) return aggregateIntFmt.format(n);
  return aggregateDecFmt.format(n);
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function formatCellValue(v) {
  if (v == null) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v).replace(/\r?\n/g, " ").trim();
}

/**
 * Paridad con Excel (`numFmt` #,##0.00 en `decimalFieldSet`).
 * @param {string} field
 * @param {unknown} v
 * @param {Set<string>} decimalFieldSet
 * @returns {string}
 */
function formatCellValueForField(field, v, decimalFieldSet) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  let n;
  if (typeof v === "number" && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === "string") {
    const t = v.replace(/\r?\n/g, " ").trim();
    if (t === "") return "";
    const parsed = Number(t.replace(/,/g, "").replace(/\s/g, ""));
    if (Number.isFinite(parsed)) n = parsed;
    else return t;
  } else {
    return formatCellValue(v);
  }

  if (decimalFieldSet.has(field)) {
    return aggregateDecFmt.format(n);
  }
  if (Number.isInteger(n)) return aggregateIntFmt.format(n);
  return aggregateDecFmt.format(n);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} field
 * @returns {number}
 */
function sumNumericField(rows, field) {
  let s = 0;
  for (const r of rows) {
    const v = r[field];
    if (typeof v === "number" && Number.isFinite(v)) s += v;
    else if (v != null && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) s += n;
    }
  }
  return s;
}

/**
 * @typedef {{ kind: "static"; label: string; text: string; usedTitleToken: boolean; staticIdx: number } |
 *   { kind: "metric"; label: string; valueStr: string; colIdx: number }} BlockLine
 */

/**
 * @param {Record<string, unknown>[]} dataRows
 * @param {Array<Record<string, unknown>>} blockRows
 * @param {Array<{ field: string; header: string }>} columns
 * @param {Set<string>} decimalFieldSet
 * @param {string} resolvedTitle
 * @returns {BlockLine[]}
 */
function evaluateBlockRowsTop(dataRows, blockRows, columns, decimalFieldSet, resolvedTitle) {
  const hasData = dataRows.length > 0;
  /** @type {Map<string, { value: number; colIdx: number }>} */
  const idToMeta = new Map();
  /** @type {BlockLine[]} */
  const out = [];
  let staticIdx = 0;

  for (const fr of blockRows) {
    const op = String(fr.op ?? "");
    const rowId = String(fr.rowId ?? "").trim();
    if (!rowId) continue;

    if (op === "staticText") {
      const lb = String(fr.label ?? "").trim();
      const vtRaw = String(fr.valueText ?? "");
      const usedTitleToken = vtRaw.includes(RESOLVED_TITLE_TOKEN);
      out.push({
        kind: "static",
        label: lb,
        text: resolveStaticCellText(vtRaw, resolvedTitle),
        usedTitleToken,
        staticIdx,
      });
      staticIdx += 1;
      continue;
    }

    const label = String(fr.label ?? "").trim();
    if (!label) continue;

    if (op === "sumColumn") {
      const sourceField = String(fr.sourceField ?? "").trim();
      const idx = columns.findIndex((c) => c.field === sourceField);
      if (idx < 0) continue;
      const field = String(columns[idx].field ?? sourceField);
      let valueStr = "";
      let valueNum = NaN;
      if (hasData) {
        valueNum = sumNumericField(dataRows, sourceField);
        valueStr = formatAggregateNumber(field, valueNum, decimalFieldSet);
        idToMeta.set(rowId, { value: valueNum, colIdx: idx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx: idx });
      continue;
    }

    if (op === "multiplyFooter") {
      const refRowId = String(fr.refRowId ?? "").trim();
      const ref = idToMeta.get(refRowId);
      const factor = Number(fr.factor);
      const f = Number.isFinite(factor) ? factor : 0;
      let valueStr = "";
      let colIdx = 0;
      if (hasData && ref && Number.isFinite(ref.value)) {
        const n = ref.value * f;
        valueStr = formatFormulaResult(n);
        colIdx = ref.colIdx;
        idToMeta.set(rowId, { value: n, colIdx });
      } else if (hasData && ref) {
        colIdx = ref.colIdx;
        idToMeta.set(rowId, { value: NaN, colIdx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx });
      continue;
    }

    if (op === "sumFooterRefs") {
      const refRowIds = Array.isArray(fr.refRowIds) ? fr.refRowIds : [];
      const refs = refRowIds.map((id) => idToMeta.get(String(id))).filter(Boolean);
      let valueStr = "";
      let colIdx = 0;
      if (hasData && refs.length > 0) {
        colIdx = refs[0].colIdx;
        let s = 0;
        for (const m of refs) {
          if (Number.isFinite(m.value)) s += m.value;
        }
        valueStr = formatFormulaResult(s);
        idToMeta.set(rowId, { value: s, colIdx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx });
      continue;
    }
  }

  return out;
}

/**
 * @param {Record<string, unknown>[]} dataRows
 * @param {Array<Record<string, unknown>>} blockRows
 * @param {Array<{ field: string; header: string }>} columns
 * @param {Set<string>} decimalFieldSet
 * @returns {BlockLine[]}
 */
function evaluateBlockRowsFooter(dataRows, blockRows, columns, decimalFieldSet) {
  const hasData = dataRows.length > 0;
  /** @type {Map<string, { value: number; colIdx: number }>} */
  const idToMeta = new Map();
  /** @type {BlockLine[]} */
  const out = [];

  for (const fr of blockRows) {
    const op = String(fr.op ?? "");
    const rowId = String(fr.rowId ?? "").trim();
    const label = String(fr.label ?? "").trim();
    if (!rowId || !label) continue;

    if (op === "sumColumn") {
      const sourceField = String(fr.sourceField ?? "").trim();
      const idx = columns.findIndex((c) => c.field === sourceField);
      if (idx < 0) continue;
      const field = String(columns[idx].field ?? sourceField);
      let valueStr = "";
      let valueNum = NaN;
      if (hasData) {
        valueNum = sumNumericField(dataRows, sourceField);
        valueStr = formatAggregateNumber(field, valueNum, decimalFieldSet);
        idToMeta.set(rowId, { value: valueNum, colIdx: idx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx: idx });
      continue;
    }

    if (op === "multiplyFooter") {
      const refRowId = String(fr.refRowId ?? "").trim();
      const ref = idToMeta.get(refRowId);
      const factor = Number(fr.factor);
      const f = Number.isFinite(factor) ? factor : 0;
      let valueStr = "";
      let colIdx = 0;
      if (hasData && ref && Number.isFinite(ref.value)) {
        const n = ref.value * f;
        valueStr = formatFormulaResult(n);
        colIdx = ref.colIdx;
        idToMeta.set(rowId, { value: n, colIdx });
      } else if (hasData && ref) {
        colIdx = ref.colIdx;
        idToMeta.set(rowId, { value: NaN, colIdx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx });
      continue;
    }

    if (op === "sumFooterRefs") {
      const refRowIds = Array.isArray(fr.refRowIds) ? fr.refRowIds : [];
      const refs = refRowIds.map((id) => idToMeta.get(String(id))).filter(Boolean);
      let valueStr = "";
      let colIdx = 0;
      if (hasData && refs.length > 0) {
        colIdx = refs[0].colIdx;
        let s = 0;
        for (const m of refs) {
          if (Number.isFinite(m.value)) s += m.value;
        }
        valueStr = formatFormulaResult(s);
        idToMeta.set(rowId, { value: s, colIdx });
      }
      out.push({ kind: "metric", label, valueStr, colIdx });
    }
  }

  return out;
}

/**
 * @param {object} doc
 * @param {object} geom
 * @param {number} geom.marginL
 * @param {number} geom.labelAreaW
 * @param {number} geom.tableStartX
 * @param {number} geom.tableW
 * @param {number} geom.colW
 * @param {number} geom.nCols
 * @param {boolean} companyBlockLayout
 * @param {BlockLine} line
 * @param {number} y
 * @returns {number} nueva Y
 */
function drawBlockLine(doc, geom, companyBlockLayout, line, y) {
  const rowH = Math.max(12, line.kind === "static" && line.usedTitleToken ? 16 : 12);
  const { marginL, labelAreaW, tableStartX, tableW, colW, nCols } = geom;

  if (line.kind === "static") {
    const boldTitle = line.usedTitleToken;
    const gap = 4;
    if (line.label) {
      doc.fontSize(8).font("Helvetica-Bold");
      doc.text(line.label, marginL, y, { width: labelAreaW - 2, lineBreak: false });
      doc.font(boldTitle ? "Helvetica-Bold" : "Helvetica");
      doc.fontSize(boldTitle ? 14 : 8);
      const valueX = marginL + labelAreaW + gap;
      doc.text(line.text, valueX, y, { width: Math.max(tableW - labelAreaW - gap, 40), lineBreak: false });
      doc.font("Helvetica");
    } else {
      const isFirstCompanyTitle = companyBlockLayout && line.staticIdx === 0;
      doc.fontSize(boldTitle ? 14 : 8).font(isFirstCompanyTitle || boldTitle ? "Helvetica-Bold" : "Helvetica");
      doc.text(line.text, marginL, y, { width: tableW - 2, lineBreak: false });
      doc.font("Helvetica");
    }
    return y + rowH + 2;
  }

  /**
   * Misma lógica que Excel: etiqueta en la columna inmediatamente anterior a la del monto
   * (`labelColOneBased = Math.max(startCol, valueColOneBased - 1)`).
   */
  doc.fontSize(8).font("Helvetica-Bold");
  const valueX = tableStartX + line.colIdx * colW;
  if (line.colIdx <= 0) {
    const x0 = tableStartX;
    doc.text(line.label, x0, y, { width: Math.max(colW * 0.5 - 2, 36), lineBreak: false });
    doc.font("Helvetica");
    doc.text(line.valueStr, x0 + colW * 0.48, y, {
      width: colW * 0.52 - 4,
      align: "right",
      lineBreak: false,
    });
  } else {
    const labelColIdx = line.colIdx - 1;
    const labelX = tableStartX + labelColIdx * colW;
    doc.text(line.label, labelX, y, { width: colW - 2, lineBreak: false });
    doc.font("Helvetica");
    doc.text(line.valueStr, valueX, y, {
      width: colW - 4,
      align: "right",
      lineBreak: false,
    });
  }
  doc.font("Helvetica");
  return y + rowH + 2;
}

/**
 * @param {Record<string, unknown>[]} tableRows
 * @param {{
 *   columns: Array<{ field: string; header: string }>;
 *   resolvedTitle?: string;
 *   topBlockSpec?: { mode?: string; rows?: Array<Record<string, unknown>> };
 *   footerSpec?: { mode?: string; rows?: Array<Record<string, unknown>> };
 *   companyBlockLayout?: boolean;
 *   decimalFieldNames?: string[];
 * }} opts
 * @returns {Promise<Buffer>}
 */
async function buildGenericTablePdf(tableRows, opts) {
  const columns = Array.isArray(opts.columns) ? opts.columns : [];
  if (columns.length === 0) {
    throw new Error("columns vacío: define al menos una columna.");
  }

  const resolvedTitle = String(opts.resolvedTitle ?? "").trim() || "Reporte";
  const companyBlockLayout = opts.companyBlockLayout === true;
  const topBlockSpec = opts.topBlockSpec && typeof opts.topBlockSpec === "object" ? opts.topBlockSpec : { mode: "none" };
  const topMode = String(topBlockSpec.mode ?? "none");
  const footerSpec = opts.footerSpec && typeof opts.footerSpec === "object" ? opts.footerSpec : { mode: "none" };
  const footerMode = String(footerSpec.mode ?? "none");

  const decimalFieldSet = new Set(DECIMAL_FIELDS);
  const extraDec = opts.decimalFieldNames;
  if (Array.isArray(extraDec)) {
    for (const x of extraDec) {
      const k = String(x ?? "").trim();
      if (k) decimalFieldSet.add(k);
    }
  }

  const topRowsRaw = topMode === "rows" && Array.isArray(topBlockSpec.rows) ? topBlockSpec.rows : [];
  const topLines = evaluateBlockRowsTop(tableRows, topRowsRaw, columns, decimalFieldSet, resolvedTitle);

  const hasData = tableRows.length > 0;
  const footerRowsRaw = hasData && footerMode === "rows" && Array.isArray(footerSpec.rows) ? footerSpec.rows : [];
  const footerLines = evaluateBlockRowsFooter(tableRows, footerRowsRaw, columns, decimalFieldSet);

  const doc = new PDFDocument({
    margin: 36,
    size: "A4",
    layout: "landscape",
    autoFirstPage: true,
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const marginL = doc.page.margins.left;
  const marginR = doc.page.margins.right;
  const usableW = doc.page.width - marginL - marginR;
  /** PDF: tabla a ancho completo (sin “columna A” vacía como en Excel DD). Etiquetas de bloque usan solo esta franja. */
  const labelAreaW = Math.min(usableW * 0.22, 120);
  const tableStartX = marginL;
  const tableW = usableW;
  const nCols = columns.length;
  const colW = tableW / Math.max(nCols, 1);
  const bottom = doc.page.height - doc.page.margins.bottom;
  const baseRowH = 12;
  const headerH = 16;

  const pdf = doc;

  const geom = { marginL, labelAreaW, tableStartX, tableW, colW, nCols };

  let y = doc.page.margins.top + 4;

  /**
   * @param {number} need
   */
  function ensureSpace(need) {
    if (y + need <= bottom) return;
    pdf.addPage();
    y = pdf.page.margins.top + 8;
  }

  for (const line of topLines) {
    ensureSpace(20);
    y = drawBlockLine(pdf, geom, companyBlockLayout, line, y);
  }

  if (topLines.length > 0) {
    ensureSpace(8);
    y += 4;
  }

  /**
   * @param {number} atY
   */
  function drawHeaderRow(atY) {
    let x = tableStartX;
    pdf.fontSize(7).font("Helvetica-Bold");
    for (let i = 0; i < columns.length; i += 1) {
      const h = String(columns[i]?.header ?? columns[i]?.field ?? "").slice(0, 60);
      pdf.text(h, x, atY, { width: colW - 2, lineBreak: false });
      x += colW;
    }
    pdf.font("Helvetica");
    return atY + headerH;
  }

  ensureSpace(headerH + baseRowH);
  y = drawHeaderRow(y);
  pdf.fontSize(6).font("Helvetica");

  for (let ri = 0; ri < tableRows.length; ri += 1) {
    const row = tableRows[ri] ?? {};
    ensureSpace(baseRowH * 2);
    let x = tableStartX;
    let rowMaxH = baseRowH;
    for (let ci = 0; ci < columns.length; ci += 1) {
      const field = String(columns[ci]?.field ?? "");
      const raw = formatCellValueForField(field, row[field], decimalFieldSet);
      const slice = raw.length > 400 ? `${raw.slice(0, 397)}…` : raw;
      const h = pdf.heightOfString(slice, { width: colW - 4 });
      if (h > rowMaxH) rowMaxH = Math.min(h + 2, baseRowH * 4);
    }
    for (let ci = 0; ci < columns.length; ci += 1) {
      const field = String(columns[ci]?.field ?? "");
      const raw = formatCellValueForField(field, row[field], decimalFieldSet);
      const slice = raw.length > 400 ? `${raw.slice(0, 397)}…` : raw;
      const alignRight = decimalFieldSet.has(field);
      pdf.text(slice, x, y, {
        width: colW - 4,
        height: rowMaxH,
        ellipsis: true,
        lineGap: 0,
        align: alignRight ? "right" : "left",
      });
      x += colW;
    }
    y += rowMaxH + 2;
  }

  if (footerLines.length > 0) {
    y += 2;
    pdf.fontSize(8);
    for (const line of footerLines) {
      ensureSpace(20);
      y = drawBlockLine(pdf, geom, companyBlockLayout, line, y);
    }
  }

  pdf.end();
  return finished;
}

module.exports = {
  buildGenericTablePdf,
};
