"use strict";

const fs = require("fs");
const path = require("path");
const { Handlebars } = require("./sunat-handlebars-helpers");
const { signXml } = require("./sunat-xml-signer.service");
const { createZip } = require("./sunat-zip.service");
const { sendDocument, readCdr } = require("./sunat-soap.service");

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

const DOC_TYPE_CODE_MAP = {
  invoice: "01",
  credit_note: "07",
  debit_note: "08",
};

const BILL_TYPE_REF_MAP = {
  invoice: "0101",
  credit_note: "0701",
  debit_note: "0801",
};

// ---------------------------------------------------------------------------
// processDocument
// ---------------------------------------------------------------------------

/**
 * Genera XML firmado y ZIP (sin enviar a SUNAT).
 *
 * @param {string} docType
 * @param {object} payload
 * @param {object} credentials
 * @returns {Promise<{ ruc: string, user: string, password: string, xmlName: string, zipName: string, signedXml: string, zipBuffer: Buffer }>}
 */
async function generateSignedXmlAndZip(docType, payload, credentials) {
  const templatePath = path.resolve(__dirname, `../sunat-templates/${docType}.hbs`);
  const templateSource = fs.readFileSync(templatePath, "utf8");
  const template = Handlebars.compile(templateSource);

  const xml = template(payload);

  const ruc = payload.company.ruc;
  const docTypeCode = payload.docTypeCode;
  const documentNo = payload.documentNo;
  const xmlName = `${ruc}-${docTypeCode}-${documentNo}.xml`;
  const zipName = xmlName.replace(".xml", ".zip");

  const signedXml = await signXml(xml, credentials.certBase64, credentials.passwordCertificado);
  const zipBuffer = await createZip(zipName, xmlName, signedXml);

  const user = `${ruc}${credentials.usuarioSunat}`;
  const password = credentials.passwordSunat;

  return { ruc, user, password, xmlName, zipName, signedXml, zipBuffer };
}

/**
 * Orquesta la generación, firma, compresión y envío de un comprobante a SUNAT.
 *
 * @param {string} docType      - "invoice" | "credit-note" | "debit-note"
 * @param {object} payload      - Datos del comprobante (mapeados desde Firestore)
 * @param {object} credentials  - { urlServidorSunat, certBase64, passwordCertificado, usuarioSunat, passwordSunat }
 * @returns {Promise<{ zipBuffer: Buffer, zipName: string, cdrBuffer: Buffer, cdrName: string, success: boolean, status: string, response: string }>}
 */
async function processDocument(docType, payload, credentials) {
  const { ruc, user, password, zipName, zipBuffer } = await generateSignedXmlAndZip(
    docType,
    payload,
    credentials
  );

  // Enviar a SUNAT
  const cdrBuffer = await sendDocument(
    credentials.urlServidorSunat,
    zipBuffer,
    zipName,
    user,
    password
  );

  // 7. Leer CDR
  const { success, status, messages } = await readCdr(cdrBuffer);

  // 8. Retornar resultado
  return {
    zipBuffer,
    zipName,
    cdrBuffer,
    cdrName: "R-" + zipName,
    success,
    status,
    response: messages.join("; "),
  };
}

// ---------------------------------------------------------------------------
// mapInvoiceToSunatPayload
// ---------------------------------------------------------------------------

/**
 * Determina el código de tipo de documento de identidad según la longitud del número.
 * @param {string} docNo
 * @returns {"6"|"1"|"-"}
 */
function _identityDocCode(docNo) {
  const s = String(docNo ?? "").replace(/\D/g, "");
  if (s.length === 11) return "6";
  if (s.length === 8) return "1";
  return "-";
}

/**
 * Genera el texto "monto en letras" simple para el campo note.
 * @param {number} totalAmount
 * @param {string} currency
 * @returns {string}
 */
function amountToWords(totalAmount, currency) {
  const currencyName =
    currency === "USD" ? "DOLARES AMERICANOS" : "SOLES";
  return `SON ${Number(totalAmount).toFixed(2)} ${currencyName}`;
}

// ---------------------------------------------------------------------------
// Tax Affectation → Scheme mapping (Catálogo 07 → Catálogo 05)
// ---------------------------------------------------------------------------

const TAX_SCHEME_BY_AFFECTATION = {
  "10": { schemeId: "1000", schemeName: "IGV", typeCode: "VAT" },
  "11": { schemeId: "1000", schemeName: "IGV", typeCode: "VAT" },
  "20": { schemeId: "9997", schemeName: "EXO", typeCode: "VAT" },
  "30": { schemeId: "9998", schemeName: "INA", typeCode: "FRE" },
  "31": { schemeId: "9998", schemeName: "INA", typeCode: "FRE" },
  "40": { schemeId: "9995", schemeName: "EXP", typeCode: "FRE" },
};

/**
 * Agrupa los ítems por taxAffectationCode y calcula los subtotales de impuestos
 * para el TaxTotal de cabecera, aplicando la lógica correcta por tipo de afectación.
 *
 * - "10"/"11" (gravado):   taxableAmount = price, taxAmount = tax
 * - "20" (exonerado):      taxableAmount = price, taxAmount = 0
 * - "30"/"31" (inafecto):  taxableAmount = 0,     taxAmount = 0
 * - "40" (exportación):    taxableAmount = price, taxAmount = 0
 *
 * @param {object[]} items - Ítems ya mapeados con taxAffectationCode, price, tax, taxPer
 * @returns {object[]} taxSubtotals
 */
function _buildTaxSubtotals(items) {
  const groups = {};

  for (const item of items) {
    const code = item.taxAffectationCode;
    const scheme = TAX_SCHEME_BY_AFFECTATION[code] ?? TAX_SCHEME_BY_AFFECTATION["10"];

    if (!groups[code]) {
      groups[code] = {
        exemptionCode: code,
        taxableAmount: 0,
        taxAmount: 0,
        percent: item.taxPer || null,
        schemeId: scheme.schemeId,
        schemeName: scheme.schemeName,
        typeCode: scheme.typeCode,
      };
    }

    const price = item.price || 0;
    const tax = item.tax || 0;

    if (code === "10" || code === "11") {
      // Gravado: base imponible + IGV
      groups[code].taxableAmount += price;
      groups[code].taxAmount += tax;
    } else if (code === "20") {
      // Exonerado: base imponible = price, impuesto = 0
      groups[code].taxableAmount += price;
    } else if (code === "30" || code === "31") {
      // Inafecto: base imponible = 0, impuesto = 0
      // (taxableAmount stays 0)
    } else if (code === "40") {
      // Exportación: base imponible = price, impuesto = 0
      groups[code].taxableAmount += price;
    } else {
      // Fallback: comportamiento genérico
      groups[code].taxableAmount += price;
      groups[code].taxAmount += tax;
    }
  }

  return Object.values(groups);
}

/**
 * Mapea un InvoiceRecord + items + credits al payload esperado por los templates Handlebars.
 *
 * Nota: el WSDL de SUNAT `billService` solo define el contrato SOAP (p. ej. `sendBill` con el
 * archivo ZIP); no fija campos UBL. La obligatoriedad de `cbc:DueDate` y `cac:PaymentTerms`
 * sigue la guía de XML electrónico SUNAT (UBL 2.1), no el WSDL.
 *
 * @param {object}   invoiceData - InvoiceRecord de Firestore
 * @param {object[]} items       - InvoiceItemRecord[]
 * @param {object[]} credits     - InvoiceCredit[]
 * @returns {object} payload para el template
 */
function mapInvoiceToSunatPayload(invoiceData, items, credits) {
  const docTypeCode = DOC_TYPE_CODE_MAP[invoiceData.type] ?? "01";
  const billTypeRefCode = BILL_TYPE_REF_MAP[invoiceData.type] ?? "0101";

  // Para SUNAT `cbc:IssueDate` debe ser xsd:date (YYYY-MM-DD). Blindamos ISO datetime y otros formatos.
  const issueDateRaw = String(invoiceData.issueDate ?? "").trim();
  const mDate = issueDateRaw.match(/^\d{4}-\d{2}-\d{2}/);
  const issueDate = mDate ? mDate[0] : (issueDateRaw.includes("T") ? issueDateRaw.split("T")[0] : issueDateRaw);

  // `cbc:IssueTime` es opcional en UBL, pero lo mantenemos. Si hay hora en el ISO, úsala; sino 00:00:00.
  const afterT = issueDateRaw.includes("T") ? String(issueDateRaw.split("T")[1] ?? "").trim() : "";
  const hhmmss = afterT ? afterT.split(".")[0] : "";
  const issueTime =
    hhmmss && /^\d{2}:\d{2}(:\d{2})?$/.test(hhmmss)
      ? hhmmss.split(":").length === 2
        ? `${hhmmss}:00`
        : hhmmss
      : "00:00:00";

  // Mapear ítems
  const mappedItems = (items ?? []).map((item, idx) => {
    const taxAffectationCode = item.taxAffectationCode ?? "10";
    const taxSchemeCode = item.taxSchemeCode ?? "1000";
    const taxSchemeName = item.taxSchemeName ?? "IGV";
    const taxTypeCode = item.taxTypeCode ?? "VAT";
    const unitCode = item.unitCode ?? item.measure?.code ?? "NIU";
    const taxPer = item.taxPer ?? 18;
    const unitPrice = item.unitPrice ?? 0;

    // unitPriceWithTax: solo para gravado (10, 11)
    const isGravado = taxAffectationCode === "10" || taxAffectationCode === "11";
    const unitPriceWithTax = isGravado
      ? unitPrice * (1 + taxPer / 100)
      : unitPrice;

    return {
      lineNo: idx + 1,
      description: item.description ?? "",
      itemCode: item.itemCode ?? "",
      quantity: item.quantity ?? 1,
      unitCode,
      unitPrice,
      unitPriceWithTax,
      price: item.price ?? 0,
      taxAffectationCode,
      taxSchemeCode,
      taxSchemeName,
      taxTypeCode,
      taxPer,
      tax: item.tax ?? 0,
      amount: item.amount ?? 0,
      iscAmount: item.iscAmount ?? 0,
      icbperUnitAmount: item.icbperUnitAmount ?? 0,
    };
  });

  const taxSubtotals = _buildTaxSubtotals(mappedItems);

  // Mapear créditos (cuotas). SUNAT requiere al menos 1 cuota si payTerm es Crédito.
  const payTerm = invoiceData.payTerm ?? "cash";
  let mappedCredits = (credits ?? []).map((credit) => ({
    correlative: Number(credit.correlative) || 1,
    dueDate: String(credit.dueDate ?? "").trim(),
    amount: Number(credit.creditVal) || 0,
  }));

  if (payTerm !== "transfer" && payTerm !== "cash" && mappedCredits.length === 0) {
    // Fallback: una cuota por el total (evita error SUNAT 3249 si el front no envió cuotas).
    mappedCredits = [
      {
        correlative: 1,
        dueDate: String(invoiceData.dueDate ?? issueDate ?? "").trim(),
        amount: Number(invoiceData.totalAmount) || 0,
      },
    ];
  }

  mappedCredits = mappedCredits
    .filter((c) => Number(c.amount) > 0)
    .map((c) => {
      const corr = Number(c.correlative) || 1;
      const corr3 = String(corr).padStart(3, "0");
      return {
        ...c,
        correlative: corr,
        paymentMeansId: `Cuota${corr3}`,
      };
    });

  const creditsTotalAmount = mappedCredits.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  return {
    documentNo: invoiceData.documentNo ?? "",
    issueDate,
    issueTime,
    docTypeCode,
    billTypeRefCode,
    currency: invoiceData.currency ?? "PEN",
    totalPrice: invoiceData.totalPrice ?? 0,
    totalTax: invoiceData.totalTax ?? 0,
    totalAmount: invoiceData.totalAmount ?? 0,
    creditsTotalAmount,
    payTerm,
    operationTypeCode: invoiceData.operationTypeCode ?? "0101",
    dueDate: invoiceData.dueDate ?? "",
    note: amountToWords(invoiceData.totalAmount ?? 0, invoiceData.currency ?? "PEN"),
    company: {
      // En InvoiceRecord (web) el RUC vive en `company.identityDocumentNo`.
      // Mantener compatibilidad con posibles payloads legacy (`companyRuc`).
      ruc:
        String(
          invoiceData.company?.identityDocumentNo ??
            invoiceData.company?.ruc ??
            invoiceData.companyRuc ??
            ""
        ).trim(),
      businessName: invoiceData.company?.businessName ?? invoiceData.companyName ?? "",
      // La dirección fiscal normalmente vive en companyLocation (snapshot en la factura).
      ubigeo: invoiceData.companyLocation?.ubigeo ?? invoiceData.company?.ubigeo ?? "",
      city: invoiceData.companyLocation?.city ?? invoiceData.company?.city ?? "",
      country: invoiceData.companyLocation?.country ?? invoiceData.company?.country ?? "",
      district: invoiceData.companyLocation?.district ?? invoiceData.company?.district ?? "",
      address: invoiceData.companyLocation?.address ?? invoiceData.company?.address ?? "",
    },
    client: {
      identityDocNo: invoiceData.client?.identityDocumentNo ?? invoiceData.clientDocNo ?? "",
      identityDocCode: _identityDocCode(
        invoiceData.client?.identityDocumentNo ?? invoiceData.clientDocNo ?? ""
      ),
      businessName: invoiceData.client?.businessName ?? invoiceData.clientName ?? "",
      // En InvoiceRecord (web) el campo se llama homeAddress.
      address: invoiceData.client?.homeAddress ?? invoiceData.client?.address ?? invoiceData.clientAddress ?? "",
    },
    items: mappedItems,
    taxSubtotals,
    credits: mappedCredits,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { processDocument, generateSignedXmlAndZip, mapInvoiceToSunatPayload };
