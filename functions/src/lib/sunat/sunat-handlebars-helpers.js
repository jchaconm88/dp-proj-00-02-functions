const Handlebars = require("handlebars");

// ─── amountToWords helpers ────────────────────────────────────────────────────

const ONES = [
  "", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE",
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISEIS", "DIECISIETE",
  "DIECIOCHO", "DIECINUEVE",
];
const TENS = ["", "", "VEINTE", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const HUNDREDS = [
  "", "CIEN", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
  "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS",
];

function numberToWords(n) {
  if (n === 0) return "CERO";
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0 ? TENS[tens] : TENS[tens] + " Y " + ONES[ones];
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    const hundredWord = hundreds === 1 && rest > 0 ? "CIENTO" : HUNDREDS[hundreds];
    return rest === 0 ? hundredWord : hundredWord + " " + numberToWords(rest);
  }
  if (n < 1000000) {
    const thousands = Math.floor(n / 1000);
    const rest = n % 1000;
    const thousandWord = thousands === 1 ? "MIL" : numberToWords(thousands) + " MIL";
    return rest === 0 ? thousandWord : thousandWord + " " + numberToWords(rest);
  }
  return String(n);
}

// ─── Tax Affectation Matrix ───────────────────────────────────────────────────

const TAX_SCHEME_MAP = {
  "10":      { id: "1000", name: "IGV",    typeCode: "VAT" },
  "11":      { id: "1000", name: "IGV",    typeCode: "VAT" },
  "20":      { id: "9997", name: "EXO",    typeCode: "VAT" },
  "30":      { id: "9998", name: "INA",    typeCode: "FRE" },
  "31":      { id: "9998", name: "INA",    typeCode: "FRE" },
  "40":      { id: "9995", name: "EXP",    typeCode: "FRE" },
  "icbper":  { id: "7152", name: "ICBPER", typeCode: "OTH" },
  "isc":     { id: "2000", name: "ISC",    typeCode: "EXC" },
};

const DOC_TYPE_MAP = {
  invoice: "01",
  credit_note: "07",
  debit_note: "08",
};

const BILL_TYPE_REF_MAP = {
  invoice: "0101",
  credit_note: "0701",
  debit_note: "0801",
};

/**
 * Registers all SUNAT Handlebars helpers on the given Handlebars instance.
 * @param {typeof Handlebars} hbs
 */
function registerHelpers(hbs) {
  /** formatAmount(value) → "3850.00" */
  hbs.registerHelper("formatAmount", (value) => {
    return Number(value).toFixed(2);
  });

  /** formatDate(dateStr) → "YYYY-MM-DD" */
  hbs.registerHelper("formatDate", (dateStr) => {
    const d = new Date(dateStr);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  /** formatTime(dateStr) → "HH:mm:ss" */
  hbs.registerHelper("formatTime", (dateStr) => {
    const d = new Date(dateStr);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    const ss = String(d.getUTCSeconds()).padStart(2, "0");
    return `${hh}:${min}:${ss}`;
  });

  /** docTypeCode(type) → "01" | "07" | "08"; throws if invalid */
  hbs.registerHelper("docTypeCode", (type) => {
    if (!Object.prototype.hasOwnProperty.call(DOC_TYPE_MAP, type)) {
      throw new Error(`docTypeCode: tipo de comprobante inválido: "${type}"`);
    }
    return DOC_TYPE_MAP[type];
  });

  /** billTypeRefCode(type) → "0101" | "0701" | "0801" */
  hbs.registerHelper("billTypeRefCode", (type) => {
    return BILL_TYPE_REF_MAP[type] ?? "0101";
  });

  /** payTermCode(payTerm) → "Contado" | "Credito" */
  hbs.registerHelper("payTermCode", (payTerm) => {
    if (payTerm === "transfer" || payTerm === "cash") return "Contado";
    return "Credito";
  });

  /**
   * identityDocCode(docNo) → "6" (RUC, 11 digits), "1" (DNI, 8 digits), "-" otherwise
   */
  hbs.registerHelper("identityDocCode", (docNo) => {
    const s = String(docNo ?? "").replace(/\D/g, "");
    if (s.length === 11) return "6";
    if (s.length === 8) return "1";
    return "-";
  });

  /** isContado(payTerm) → true if "transfer" or "cash" */
  hbs.registerHelper("isContado", (payTerm) => {
    return payTerm === "transfer" || payTerm === "cash";
  });

  /** isGravado(code) → true if taxAffectationCode is "10" or "11" */
  hbs.registerHelper("isGravado", (code) => {
    return code === "10" || code === "11";
  });

  /** isExonerado(code) → true if taxAffectationCode is "20" */
  hbs.registerHelper("isExonerado", (code) => {
    return code === "20";
  });

  /** isInafecto(code) → true if taxAffectationCode is "30" or "31" */
  hbs.registerHelper("isInafecto", (code) => {
    return code === "30" || code === "31";
  });

  /** isExportacion(code) → true if taxAffectationCode is "40" */
  hbs.registerHelper("isExportacion", (code) => {
    return code === "40";
  });

  /**
   * taxSchemeForAffectation(code) → { id, name, typeCode }
   * Maps Catálogo 07 affectation code to Catálogo 05 tax scheme.
   */
  hbs.registerHelper("taxSchemeForAffectation", (code) => {
    return TAX_SCHEME_MAP[String(code)] ?? TAX_SCHEME_MAP["10"];
  });

  /**
   * amountToWords(amount, currency) → "SON ... CON XX/100 SOLES|DOLARES AMERICANOS"
   * Converts a numeric amount to Spanish words as required by SUNAT (cbc:Note).
   */
  hbs.registerHelper("amountToWords", (amount, currency) => {
    const num = Math.round(Number(amount) * 100) / 100;
    const intPart = Math.floor(num);
    const centsPart = Math.round((num - intPart) * 100);
    const currencyName = String(currency).toUpperCase() === "USD" ? "DOLARES AMERICANOS" : "SOLES";
    const centsStr = String(centsPart).padStart(2, "0");
    return `SON ${numberToWords(intPart)} CON ${centsStr}/100 ${currencyName}`;
  });
}

registerHelpers(Handlebars);

module.exports = { registerHelpers, Handlebars };
