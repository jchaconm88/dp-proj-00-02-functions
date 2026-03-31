const RESOLVED_TITLE_TOKEN = "{{resolvedTitle}}";

/** Misma base en XLSX/PDF (pivot suma campos extra vía decimalFieldNames). */
const DECIMAL_FIELDS = new Set(["total", "totalFlete", "totalApoyoExtra", "pUni", "pTotal"]);

module.exports = {
  RESOLVED_TITLE_TOKEN,
  DECIMAL_FIELDS,
};

