// Feature: sunat-integration, Property 4: Mapeo de catálogos SUNAT
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Handlebars } from "./sunat-handlebars-helpers.js";

/**
 * Validates: Requirements 3.3
 *
 * Property 4: Mapeo de catálogos SUNAT
 * Para cada valor válido de `type`, docTypeCode SHALL retornar el código correcto.
 * Para cualquier string fuera del conjunto válido, SHALL lanzar error.
 */
describe("sunat-handlebars-helpers", () => {
  const VALID_TYPES = ["invoice", "credit_note", "debit_note"];
  const EXPECTED_CODES = { invoice: "01", credit_note: "07", debit_note: "08" };

  describe("docTypeCode — valores válidos", () => {
    for (const type of VALID_TYPES) {
      it(`docTypeCode("${type}") retorna "${EXPECTED_CODES[type]}"`, () => {
        const helper = Handlebars.helpers["docTypeCode"];
        expect(helper(type)).toBe(EXPECTED_CODES[type]);
      });
    }
  });

  it("Property 4a: docTypeCode lanza error para cualquier string fuera del conjunto válido", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !VALID_TYPES.includes(s)),
        (invalidType) => {
          const helper = Handlebars.helpers["docTypeCode"];
          expect(() => helper(invalidType)).toThrow();
        }
      )
    );
  });

  it("Property 4b: formatAmount siempre produce exactamente 2 decimales", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 999999, noNaN: true }),
        (value) => {
          const helper = Handlebars.helpers["formatAmount"];
          const result = helper(value);
          // Must be a string with exactly 2 decimal places
          expect(typeof result).toBe("string");
          expect(result).toMatch(/^\d+\.\d{2}$/);
          // Value must round-trip correctly
          expect(parseFloat(result).toFixed(2)).toBe(result);
        }
      )
    );
  });

  // ─── taxSchemeForAffectation ────────────────────────────────────────────────

  /**
   * Validates: Requirements 9.2–9.5
   */
  describe("taxSchemeForAffectation — Tax Affectation Matrix", () => {
    const MATRIX = [
      { code: "10",     id: "1000", name: "IGV",    typeCode: "VAT" },
      { code: "11",     id: "1000", name: "IGV",    typeCode: "VAT" },
      { code: "20",     id: "9997", name: "EXO",    typeCode: "VAT" },
      { code: "30",     id: "9998", name: "INA",    typeCode: "FRE" },
      { code: "31",     id: "9998", name: "INA",    typeCode: "FRE" },
      { code: "40",     id: "9995", name: "EXP",    typeCode: "FRE" },
      { code: "icbper", id: "7152", name: "ICBPER", typeCode: "OTH" },
      { code: "isc",    id: "2000", name: "ISC",    typeCode: "EXC" },
    ];

    for (const { code, id, name, typeCode } of MATRIX) {
      it(`taxSchemeForAffectation("${code}") → { id: "${id}", name: "${name}", typeCode: "${typeCode}" }`, () => {
        const helper = Handlebars.helpers["taxSchemeForAffectation"];
        const result = helper(code);
        expect(result).toEqual({ id, name, typeCode });
      });
    }

    it("taxSchemeForAffectation con código desconocido retorna default IGV", () => {
      const helper = Handlebars.helpers["taxSchemeForAffectation"];
      expect(helper("99")).toEqual({ id: "1000", name: "IGV", typeCode: "VAT" });
      expect(helper("")).toEqual({ id: "1000", name: "IGV", typeCode: "VAT" });
    });
  });

  // ─── amountToWords ──────────────────────────────────────────────────────────

  /**
   * Validates: Requirements 13.2
   */
  describe("amountToWords — monto en letras", () => {
    it('amountToWords(4543, "PEN") → "SON CUATRO MIL QUINIENTOS CUARENTA Y TRES CON 00/100 SOLES"', () => {
      const helper = Handlebars.helpers["amountToWords"];
      expect(helper(4543, "PEN")).toBe(
        "SON CUATRO MIL QUINIENTOS CUARENTA Y TRES CON 00/100 SOLES"
      );
    });

    it('amountToWords(1000, "USD") → "SON MIL CON 00/100 DOLARES AMERICANOS"', () => {
      const helper = Handlebars.helpers["amountToWords"];
      expect(helper(1000, "USD")).toBe("SON MIL CON 00/100 DOLARES AMERICANOS");
    });

    it('amountToWords(0, "PEN") → "SON CERO CON 00/100 SOLES"', () => {
      const helper = Handlebars.helpers["amountToWords"];
      expect(helper(0, "PEN")).toBe("SON CERO CON 00/100 SOLES");
    });

    it('amountToWords(100.50, "PEN") → "SON CIEN CON 50/100 SOLES"', () => {
      const helper = Handlebars.helpers["amountToWords"];
      expect(helper(100.50, "PEN")).toBe("SON CIEN CON 50/100 SOLES");
    });

    it('amountToWords(1.01, "PEN") → "SON UNO CON 01/100 SOLES"', () => {
      const helper = Handlebars.helpers["amountToWords"];
      expect(helper(1.01, "PEN")).toBe("SON UNO CON 01/100 SOLES");
    });

    it("Property: amountToWords siempre produce formato correcto para montos 0–999999", () => {
      /**
       * Validates: Requirements 13.2
       */
      const helper = Handlebars.helpers["amountToWords"];
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 999999 }),
          fc.integer({ min: 0, max: 99 }),
          fc.constantFrom("PEN", "USD"),
          (intPart, cents, currency) => {
            const amount = intPart + cents / 100;
            const result = helper(amount, currency);
            // Must start with "SON "
            expect(result).toMatch(/^SON /);
            // Must contain " CON XX/100 "
            expect(result).toMatch(/ CON \d{2}\/100 /);
            // Must end with correct currency name
            if (currency === "USD") {
              expect(result).toMatch(/DOLARES AMERICANOS$/);
            } else {
              expect(result).toMatch(/SOLES$/);
            }
            // Cents must be 2 digits
            const centsMatch = result.match(/ CON (\d{2})\/100 /);
            expect(centsMatch).not.toBeNull();
            expect(Number(centsMatch[1])).toBe(cents);
          }
        )
      );
    });
  });
});
