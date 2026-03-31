/**
 * Resuelve plantillas de exportación (título y nombre base de archivo) con muletillas.
 *
 * Tokens soportados (misma lista para título y archivo):
 * - {year} {month} {day}: desde dateTo (YYYY-MM-DD)
 * - {yearFrom} {monthFrom} {dayFrom}: desde dateFrom (YYYY-MM-DD)
 * - {dateFrom} {dateTo}: ISO YYYY-MM-DD
 * - {period}: YYYYMM o YYYYMM-YYYYMM (según rango)
 * - {periodCompact}: solo dígitos (primeros 6) o "periodo"
 * - {seq}: número secuencial (string)
 * - {granularity}: perTrip | perAssignment
 * - {definitionId}
 * - {definitionName}
 * - {exportTag}
 *
 * Nota: `resolveExportFileStem` sanitiza para nombre de archivo.
 */

function safeDateParts(isoDate) {
  const s = String(isoDate ?? "").trim();
  const y = s.length >= 4 ? s.slice(0, 4) : "";
  const m = s.length >= 7 ? s.slice(5, 7) : "";
  const d = s.length >= 10 ? s.slice(8, 10) : "";
  return { y, m, d };
}

function periodLabelFromRange(dateFrom, dateTo) {
  const a = String(dateFrom).slice(0, 7).replace(/-/g, "");
  const b = String(dateTo).slice(0, 7).replace(/-/g, "");
  return a && b ? (a === b ? a : `${a}-${b}`) : "";
}

function periodCompactFromLabel(periodLabel) {
  return String(periodLabel || "").replace(/\D/g, "").slice(0, 6) || "periodo";
}

function seqFromRunId(runId) {
  let h = 0;
  const s = String(runId);
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return (h % 900) + 100;
}

function sanitizeFilenameStem(stem) {
  let s = String(stem ?? "");
  // Windows + Storage incompatible chars
  s = s.replace(/[\\/:*?"<>|]/g, "-");
  // Collapse whitespace/dashes
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/-+/g, "-");
  // Avoid trailing dots/spaces (Windows)
  s = s.replace(/[.\s]+$/g, "");
  // Keep it reasonable
  if (s.length > 150) s = s.slice(0, 150).replace(/[.\s-]+$/g, "");
  return s;
}

/**
 * @param {string} template
 * @param {{
 *  dateFrom: string;
 *  dateTo: string;
 *  seq: number|string;
 *  granularity: "perTrip"|"perAssignment";
 *  definitionId?: string;
 *  definitionName?: string;
 *  exportTag?: string;
 * }} ctx
 * @returns {string}
 */
function resolveTemplate(template, ctx) {
  const t = String(template ?? "");
  const dateFrom = String(ctx?.dateFrom ?? "").trim();
  const dateTo = String(ctx?.dateTo ?? "").trim();
  const { y: yTo, m: mTo, d: dTo } = safeDateParts(dateTo);
  const { y: yFrom, m: mFrom, d: dFrom } = safeDateParts(dateFrom);
  const period = periodLabelFromRange(dateFrom, dateTo);
  const periodCompact = periodCompactFromLabel(period);

  const map = {
    year: yTo,
    month: mTo,
    day: dTo,
    yearFrom: yFrom,
    monthFrom: mFrom,
    dayFrom: dFrom,
    dateFrom,
    dateTo,
    period,
    periodCompact,
    seq: String(ctx?.seq ?? "").trim(),
    granularity: String(ctx?.granularity ?? "").trim(),
    definitionId: String(ctx?.definitionId ?? "").trim(),
    definitionName: String(ctx?.definitionName ?? "").trim(),
    exportTag: String(ctx?.exportTag ?? "").trim(),
  };

  return t.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(map, k) ? String(map[k] ?? "") : "";
  });
}

/**
 * @param {string} template
 * @param {Parameters<typeof resolveTemplate>[1]} ctx
 */
function resolveExportTitle(template, ctx) {
  return String(resolveTemplate(template, ctx) ?? "").trim();
}

/**
 * @param {string} template
 * @param {Parameters<typeof resolveTemplate>[1]} ctx
 */
function resolveExportFileStem(template, ctx) {
  return sanitizeFilenameStem(resolveTemplate(template, ctx));
}

module.exports = {
  resolveTemplate,
  resolveExportTitle,
  resolveExportFileStem,
  periodLabelFromRange,
  periodCompactFromLabel,
  seqFromRunId,
  sanitizeFilenameStem,
};

