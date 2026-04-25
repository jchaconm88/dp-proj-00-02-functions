"use strict";

const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { Handlebars } = require("../sunat/sunat-handlebars-helpers");
const { mapInvoiceToSunatPayload } = require("../sunat/sunat-document.service");

const TEMPLATE_PATH = path.join(__dirname, "../invoice-pdf-templates/invoice-print.html.hbs");

function registerPrintPdfHelpers() {
  if (!Handlebars.helpers.formatDatePe) {
    Handlebars.registerHelper("formatDatePe", (ymd) => {
      const s = String(ymd ?? "").trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      if (!m) return s;
      return `${m[3]}/${m[2]}/${m[1]}`;
    });
  }
  if (!Handlebars.helpers.formatMoneyDisplay) {
    Handlebars.registerHelper("formatMoneyDisplay", (amount, currency) => {
      const n = Number(amount) || 0;
      const sym = String(currency ?? "").toUpperCase() === "USD" ? "US$" : "S/";
      return `${sym} ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    });
  }
  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper("eq", (a, b) => a === b);
  }
}

/**
 * @param {object} invoiceData
 * @param {object[]} items
 * @param {object[]} credits
 * @returns {object}
 */
function buildInvoicePrintContext(invoiceData, items, credits) {
  registerPrintPdfHelpers();
  const base = mapInvoiceToSunatPayload(invoiceData, items, credits);
  const issueDate = String(invoiceData.issueDate ?? "").trim();

  const printRows = (items ?? []).map((raw, idx) => {
    const measureName = String(raw.measure?.name ?? raw.measure?.code ?? "UNIDAD").trim() || "UNIDAD";
    const qty = Number(raw.quantity) || 0;
    const icbperUnit = Number(raw.icbperUnitAmount) || 0;
    return {
      lineNo: idx + 1,
      quantity: qty,
      measureName,
      description: String(raw.description ?? "").trim(),
      unitPrice: Number(raw.unitPrice) || 0,
      icbper: Math.round(icbperUnit * qty * 100) / 100,
    };
  });

  const payTerm = String(invoiceData.payTerm ?? "").trim();
  const payTermDisplay = payTerm === "transfer" || payTerm === "cash" ? "Contado" : "Crédito";

  return {
    ...base,
    issueDate,
    comment: String(invoiceData.comment ?? "").trim(),
    printRows,
    documentTitle: "FACTURA ELECTRÓNICA",
    payTermDisplay,
    creditCount: Array.isArray(base.credits) ? base.credits.length : 0,
  };
}

/**
 * @param {string} html
 * @returns {Promise<Buffer>}
 */
async function htmlToPdfBuffer(html) {
  let executablePath = String(process.env.CHROMIUM_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "").trim();
  if (!executablePath) {
    try {
      executablePath = await chromium.executablePath();
    } catch (_) {
      executablePath = "";
    }
  }
  if (!executablePath) {
    throw new Error(
      "No se pudo resolver el ejecutable de Chromium para generar el PDF. " +
        "En producción se usa @sparticuz/chromium; en local defina CHROMIUM_EXECUTABLE_PATH o PUPPETEER_EXECUTABLE_PATH."
    );
  }

  const browser = await puppeteer.launch({
    args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless !== false,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

/**
 * @param {object} invoiceData
 * @param {object[]} items
 * @param {object[]} credits
 * @returns {Promise<Buffer>}
 */
async function renderInvoicePrintedPdfBuffer(invoiceData, items, credits) {
  registerPrintPdfHelpers();
  const context = buildInvoicePrintContext(invoiceData, items, credits);
  const source = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const template = Handlebars.compile(source);
  const html = template(context);
  return htmlToPdfBuffer(html);
}

module.exports = {
  buildInvoicePrintContext,
  renderInvoicePrintedPdfBuffer,
  htmlToPdfBuffer,
};
