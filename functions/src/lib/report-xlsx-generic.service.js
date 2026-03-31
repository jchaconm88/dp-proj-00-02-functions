/**
 * Motor genérico: tabla Excel a partir de filas planas + definición de columnas y pie.
 */

const ExcelJS = require("exceljs");

const IGV_RATE_DEFAULT = 0.18;

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

/** Campos numéricos con formato decimal en celdas (tabular). */
/**
 * @param {number} oneBased
 * @returns {string}
 */
function excelColumnLetter(oneBased) {
  let n = oneBased;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * @param {ExcelJS.Worksheet} sheet
 * @param {number} row
 * @param {number} col
 * @param {string} value
 * @param {Partial<ExcelJS.Style>} [style]
 */
function setCell(sheet, row, col, value, style) {
  const c = sheet.getCell(row, col);
  c.value = value;
  if (style) c.font = style.font ?? c.font;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {object} opts
 * @param {Array<{ field: string, header: string, width?: number }>} opts.columns
 * @param {number} [opts.startCol] default 1
 * @param {"portrait"|"landscape"} [opts.orientation]
 * @param {boolean} [opts.companyBlockLayout] columna A estrecha + datos desde startCol (DD)
 * @param {string} [opts.resolvedTitle] título ya resuelto (sustituye {{resolvedTitle}} en filas staticText)
 * @param {object} [opts.topBlockSpec] { mode: 'none'|'rows', rows?: … }
 * @param {string[]} [opts.decimalFieldNames] claves adicionales con formato #,##0.00 (pivot)
 * @param {object} [opts.footerSpec]
 * @param {string} [opts.footerSpec.mode] 'none' | 'rows'
 * @param {Array<{ rowId: string, label: string, op: string, sourceField?: string, refRowId?: string, factor?: number, refRowIds?: string[] }>} [opts.footerSpec.rows]
 * @returns {Promise<Buffer>}
 */
async function buildGenericTableWorkbook(rows, opts) {
  const columns = Array.isArray(opts.columns) ? opts.columns : [];
  if (columns.length === 0) {
    throw new Error("columns vacío: define al menos una columna.");
  }

  const startCol = Number(opts.startCol) >= 1 ? Number(opts.startCol) : 1;
  const orientation = opts.orientation === "landscape" ? "landscape" : "portrait";
  const companyBlockLayout = opts.companyBlockLayout === true;
  const resolvedTitle = String(opts.resolvedTitle ?? "").trim() || "Reporte";
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

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Reporte", {
    pageSetup: { orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  if (companyBlockLayout) {
    sheet.getColumn(1).width = 4;
  }

  for (let i = 0; i < columns.length; i += 1) {
    const w = Number(columns[i].width);
    sheet.getColumn(startCol + i).width = Number.isFinite(w) && w > 0 ? w : 14;
  }

  let r = 1;
  /** @type {Array<{ excelRow: number, fr: Record<string, unknown> }>} */
  const pendingTopFormulas = [];

  if (topMode === "rows" && Array.isArray(topBlockSpec.rows) && topBlockSpec.rows.length > 0) {
    let staticIdx = 0;
    for (const fr of topBlockSpec.rows) {
      const op = String(fr.op ?? "");
      const rowId = String(fr.rowId ?? "").trim();
      if (!rowId) continue;
      if (op === "staticText") {
        const lb = String(fr.label ?? "").trim();
        const vt = resolveStaticCellText(String(fr.valueText ?? ""), resolvedTitle);
        const valueCol = startCol;
        const labelCol = startCol > 1 ? startCol - 1 : startCol;
        const usedToken = String(fr.valueText ?? "").includes(RESOLVED_TITLE_TOKEN);
        if (lb) {
          setCell(sheet, r, labelCol, lb, { font: { bold: true } });
          setCell(sheet, r, valueCol, vt, { font: { bold: true, ...(usedToken ? { size: 14 } : {}) } });
        } else {
          const font =
            staticIdx === 0 && companyBlockLayout
              ? { bold: true, ...(usedToken ? { size: 14 } : {}) }
              : { bold: usedToken, ...(usedToken ? { size: 14 } : {}) };
          setCell(sheet, r, valueCol, vt, { font });
        }
        staticIdx += 1;
        r += 1;
        continue;
      }
      const label = String(fr.label ?? "").trim();
      if (!label) continue;
      if (op === "sumColumn") {
        const sourceField = String(fr.sourceField ?? "").trim();
        const idx = columns.findIndex((c) => c.field === sourceField);
        if (idx < 0) continue;
        const valueColOneBased = startCol + idx;
        const labelColOneBased = Math.max(startCol, valueColOneBased - 1);
        sheet.getCell(r, labelColOneBased).value = label;
        sheet.getCell(r, labelColOneBased).font = { bold: true };
        pendingTopFormulas.push({ excelRow: r, fr });
        r += 1;
      } else if (op === "multiplyFooter" || op === "sumFooterRefs") {
        const valueColOneBased = startCol;
        const labelColOneBased = Math.max(startCol, valueColOneBased - 1);
        sheet.getCell(r, labelColOneBased).value = label;
        sheet.getCell(r, labelColOneBased).font = { bold: true };
        pendingTopFormulas.push({ excelRow: r, fr });
        r += 1;
      }
    }
  }

  const headerRow = r;
  for (let i = 0; i < columns.length; i += 1) {
    const c = sheet.getCell(headerRow, startCol + i);
    c.value = columns[i].header;
    c.font = { bold: true };
    c.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE0E0E0" },
    };
  }
  r += 1;

  const firstDataRow = r;
  for (const row of rows) {
    for (let i = 0; i < columns.length; i += 1) {
      const field = columns[i].field;
      const cell = sheet.getCell(r, startCol + i);
      cell.value = row[field];
      if (decimalFieldSet.has(field)) {
        cell.numFmt = "#,##0.00";
      }
    }
    r += 1;
  }
  const lastDataRow = r - 1;

  if (rows.length > 0 && lastDataRow >= firstDataRow && pendingTopFormulas.length > 0) {
    /** @type {Map<string, { excelRow: number, valueColOneBased: number }>} */
    const topRowIdToMeta = new Map();
    for (const job of pendingTopFormulas) {
      const fr = job.fr;
      const op = String(fr.op ?? "");
      const rowId = String(fr.rowId ?? "").trim();
      const curRow = job.excelRow;
      if (op === "sumColumn") {
        const sourceField = String(fr.sourceField ?? "").trim();
        const idx = columns.findIndex((c) => c.field === sourceField);
        if (idx < 0) continue;
        const valueColOneBased = startCol + idx;
        const valueLetter = excelColumnLetter(valueColOneBased);
        sheet.getCell(curRow, valueColOneBased).value = {
          formula: `SUM(${valueLetter}${firstDataRow}:${valueLetter}${lastDataRow})`,
        };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        topRowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
      } else if (op === "multiplyFooter") {
        const refRowId = String(fr.refRowId ?? "").trim();
        const ref = topRowIdToMeta.get(refRowId);
        if (!ref) continue;
        const valueColOneBased = ref.valueColOneBased;
        const valueLetter = excelColumnLetter(valueColOneBased);
        const factor = Number(fr.factor);
        const fStr = Number.isFinite(factor) ? String(factor) : "0";
        sheet.getCell(curRow, valueColOneBased).value = {
          formula: `${valueLetter}${ref.excelRow}*${fStr}`,
        };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        topRowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
      } else if (op === "sumFooterRefs") {
        const refRowIds = Array.isArray(fr.refRowIds) ? fr.refRowIds : [];
        const refs = refRowIds.map((id) => topRowIdToMeta.get(String(id))).filter(Boolean);
        if (refs.length === 0) continue;
        const valueColOneBased = refs[0].valueColOneBased;
        const valueLetter = excelColumnLetter(valueColOneBased);
        const parts = refs.map((meta) => `${valueLetter}${meta.excelRow}`);
        const formula = parts.length === 1 ? parts[0] : `SUM(${parts.join(",")})`;
        sheet.getCell(curRow, valueColOneBased).value = { formula };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        topRowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
      }
    }
  }

  if (rows.length > 0 && lastDataRow >= firstDataRow && footerMode === "rows") {
    const footerRows = Array.isArray(footerSpec.rows) ? footerSpec.rows : [];
    /** @type {Map<string, { excelRow: number, valueColOneBased: number }>} */
    const rowIdToMeta = new Map();
    let curRow = lastDataRow + 1;
    for (const fr of footerRows) {
      const op = String(fr.op ?? "");
      const rowId = String(fr.rowId ?? "").trim();
      const label = String(fr.label ?? "").trim();
      if (!rowId || !label) continue;
      if (op === "sumColumn") {
        const sourceField = String(fr.sourceField ?? "").trim();
        const idx = columns.findIndex((c) => c.field === sourceField);
        if (idx < 0) continue;
        const valueColOneBased = startCol + idx;
        const valueLetter = excelColumnLetter(valueColOneBased);
        const labelColOneBased = Math.max(startCol, valueColOneBased - 1);
        sheet.getCell(curRow, labelColOneBased).value = label;
        sheet.getCell(curRow, labelColOneBased).font = { bold: true };
        sheet.getCell(curRow, valueColOneBased).value = {
          formula: `SUM(${valueLetter}${firstDataRow}:${valueLetter}${lastDataRow})`,
        };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        rowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
        curRow += 1;
      } else if (op === "multiplyFooter") {
        const refRowId = String(fr.refRowId ?? "").trim();
        const ref = rowIdToMeta.get(refRowId);
        if (!ref) continue;
        const valueColOneBased = ref.valueColOneBased;
        const valueLetter = excelColumnLetter(valueColOneBased);
        const labelColOneBased = Math.max(startCol, valueColOneBased - 1);
        const factor = Number(fr.factor);
        const fStr = Number.isFinite(factor) ? String(factor) : "0";
        sheet.getCell(curRow, labelColOneBased).value = label;
        sheet.getCell(curRow, labelColOneBased).font = { bold: true };
        sheet.getCell(curRow, valueColOneBased).value = {
          formula: `${valueLetter}${ref.excelRow}*${fStr}`,
        };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        rowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
        curRow += 1;
      } else if (op === "sumFooterRefs") {
        const refRowIds = Array.isArray(fr.refRowIds) ? fr.refRowIds : [];
        const refs = refRowIds.map((id) => rowIdToMeta.get(String(id))).filter(Boolean);
        if (refs.length === 0) continue;
        const valueColOneBased = refs[0].valueColOneBased;
        const valueLetter = excelColumnLetter(valueColOneBased);
        const labelColOneBased = Math.max(startCol, valueColOneBased - 1);
        const parts = refs.map((meta) => `${valueLetter}${meta.excelRow}`);
        const formula = parts.length === 1 ? parts[0] : `SUM(${parts.join(",")})`;
        sheet.getCell(curRow, labelColOneBased).value = label;
        sheet.getCell(curRow, labelColOneBased).font = { bold: true };
        sheet.getCell(curRow, valueColOneBased).value = { formula };
        sheet.getCell(curRow, valueColOneBased).numFmt = "#,##0.00";
        rowIdToMeta.set(rowId, { excelRow: curRow, valueColOneBased });
        curRow += 1;
      }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = {
  buildGenericTableWorkbook,
  excelColumnLetter,
  IGV_RATE_DEFAULT,
};
