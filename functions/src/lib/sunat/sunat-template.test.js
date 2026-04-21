// Feature: sunat-integration, Property 1: Idempotencia del template
// Feature: sunat-integration, Property 3: Preservación de montos en el XML
import { describe, it, expect, beforeAll } from "vitest";
import fc from "fast-check";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Handlebars } from "./sunat-handlebars-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../sunat-templates/invoice.hbs"
);

let template;

beforeAll(() => {
  const source = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  template = Handlebars.compile(source);
});

/** Base payload used across tests — matches the spec example */
function buildPayload(overrides = {}) {
  return {
    documentNo: "F001-00000003",
    issueDate: "2026-04-15",
    issueTime: "10:30:00",
    docTypeCode: "01",
    billTypeRefCode: "0101",
    operationTypeCode: "0101",
    currency: "PEN",
    totalPrice: 3850.0,
    totalTax: 693.0,
    totalAmount: 4543.0,
    note: "SON CUATRO MIL QUINIENTOS CUARENTA Y TRES CON 00/100 SOLES",
    dueDate: "",
    payTerm: "transfer",
    company: {
      ruc: "20123456789",
      businessName: "EMPRESA SAC",
      ubigeo: "150101",
      city: "LIMA",
      country: "LIMA",
      district: "LIMA",
      address: "AV. EJEMPLO 123",
    },
    client: {
      identityDocNo: "20987654321",
      identityDocCode: "6",
      businessName: "CLIENTE SAC",
      address: "AV. CLIENTE 456",
    },
    taxSubtotals: [
      {
        taxableAmount: 3850.0,
        taxAmount: 693.0,
        percent: 18,
        exemptionCode: "10",
        schemeId: "1000",
        schemeName: "IGV",
        typeCode: "VAT",
      },
    ],
    items: [
      {
        lineNo: 1,
        description: "FLETE-TRANSPORTE REGULAR",
        itemCode: "SRV-001",
        quantity: 10,
        unitCode: "NIU",
        unitPrice: 385.0,
        unitPriceWithTax: 454.3,
        price: 3850.0,
        taxAffectationCode: "10",
        taxSchemeCode: "1000",
        taxSchemeName: "IGV",
        taxTypeCode: "VAT",
        taxPer: 18,
        tax: 693.0,
        amount: 4543.0,
      },
    ],
    credits: [],
    ...overrides,
  };
}

/**
 * Validates: Requirements 3.4, 3.5
 *
 * Property 1: Idempotencia del template
 * Para cualquier payload válido, renderizar el template dos veces con los mismos
 * datos SHALL producir exactamente el mismo XML.
 */
describe("Property 1: Idempotencia del template", () => {
  it("renderizar dos veces con el mismo payload produce el mismo XML", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 999999 }),
        (amount) => {
          const payload = buildPayload({
            totalPrice: amount,
            totalTax: Math.round(amount * 0.18 * 100) / 100,
            totalAmount: Math.round(amount * 1.18 * 100) / 100,
            taxSubtotals: [
              {
                taxableAmount: amount,
                taxAmount: Math.round(amount * 0.18 * 100) / 100,
                percent: 18,
                exemptionCode: "10",
                schemeId: "1000",
                schemeName: "IGV",
                typeCode: "VAT",
              },
            ],
            items: [
              {
                lineNo: 1,
                description: "SERVICIO",
                itemCode: "SRV-001",
                quantity: 1,
                unitCode: "NIU",
                unitPrice: amount,
                unitPriceWithTax: Math.round(amount * 1.18 * 100) / 100,
                price: amount,
                taxAffectationCode: "10",
                taxSchemeCode: "1000",
                taxSchemeName: "IGV",
                taxTypeCode: "VAT",
                taxPer: 18,
                tax: Math.round(amount * 0.18 * 100) / 100,
                amount: Math.round(amount * 1.18 * 100) / 100,
              },
            ],
          });

          const render1 = template(payload);
          const render2 = template(payload);

          expect(render1).toBe(render2);
        }
      )
    );
  });
});

/**
 * Validates: Requirements 3.5
 *
 * Property 3: Preservación de montos en el XML
 * Para cualquier totalPrice, totalTax, totalAmount con hasta 2 decimales,
 * el XML generado SHALL contener exactamente esos valores formateados con 2 decimales.
 */
describe("Property 3: Preservación de montos en el XML", () => {
  it("el XML contiene totalPrice, totalTax y totalAmount con exactamente 2 decimales", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 999999, noNaN: true }),
        fc.float({ min: 0, max: 999999, noNaN: true }),
        fc.float({ min: 0, max: 999999, noNaN: true }),
        (totalPrice, totalTax, totalAmount) => {
          const payload = buildPayload({
            totalPrice,
            totalTax,
            totalAmount,
            taxSubtotals: [
              {
                taxableAmount: totalPrice,
                taxAmount: totalTax,
                percent: 18,
                exemptionCode: "10",
                schemeId: "1000",
                schemeName: "IGV",
                typeCode: "VAT",
              },
            ],
            items: [
              {
                lineNo: 1,
                description: "SERVICIO",
                itemCode: "",
                quantity: 1,
                unitCode: "NIU",
                unitPrice: totalPrice,
                unitPriceWithTax: totalAmount,
                price: totalPrice,
                taxAffectationCode: "10",
                taxSchemeCode: "1000",
                taxSchemeName: "IGV",
                taxTypeCode: "VAT",
                taxPer: 18,
                tax: totalTax,
                amount: totalAmount,
              },
            ],
          });

          const xml = template(payload);

          const expectedPrice = totalPrice.toFixed(2);
          const expectedTax = totalTax.toFixed(2);
          const expectedAmount = totalAmount.toFixed(2);

          expect(xml).toContain(expectedPrice);
          expect(xml).toContain(expectedTax);
          expect(xml).toContain(expectedAmount);
        }
      )
    );
  });
});
